import type { MetadataCache } from "../cache";
import { SalesforceSaveError } from "../errors";
import { externalIdText, type SalesforceConnection, segment } from "../http/connection";
import type {
	ExternalIdField,
	RecordTypeName,
	SObjectCreateInput,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
	SObjectUpdateInput,
} from "../registry";
import type { NoSelection, SoqlQueryBuilder, SoqlQueryRecord } from "../soql/query-builder";
import { SoqlQueryBuilder as Builder } from "../soql/query-builder";
import type { DeletedRecordsResult, UpdatedRecordsResult } from "../types/api";
import type { SaveResult, UpsertResult, WithAttributes } from "../types/common";
import type { DescribeSObjectResult, SObjectBasicInfo } from "../types/describe";

import type { QueryApi, QueryOptions, QueryResult } from "./query";
import { QuickActionsApi } from "./quick-actions";
import { UiApi } from "./ui-api";

export interface UpsertOutcome {
	id: string;
	/** `true` when a record was inserted, `false` when an existing one was updated. */
	created: boolean;
}

export interface RequestSignal {
	signal?: AbortSignal;
}

/** A picklist option, typed with the field's value type. */
export interface PicklistOption<TValue> {
	value: TValue;
	label: string;
	isDefault: boolean;
}

/** Typed operations on one sObject: describe, CRUD, upsert, external ids, blobs and queries. */
export class SObjectResource<R extends object, K extends SObjectName<R>> {
	constructor(
		private readonly _connection: SalesforceConnection,
		private readonly _queries: QueryApi,
		readonly name: K,
		private readonly _basePath: "" | "/tooling" = "",
		private readonly _cache?: MetadataCache,
	) {
		if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`Invalid sObject name "${String(name)}".`);
		}
	}

	private get path(): string {
		return `${this._basePath}/sobjects/${this.name}`;
	}

	/** `GET /sobjects/{name}/describe`: fields, relationships, record types, ... Cached per client. */
	describe(options: RequestSignal = {}): Promise<DescribeSObjectResult> {
		const load = (signal: AbortSignal | undefined): Promise<DescribeSObjectResult> =>
			this._connection.request({ path: `${this.path}/describe`, signal });
		return this._cache
			? this._cache.getOrLoad(`describe:${this._basePath}:${this.name}`, load, options.signal)
			: load(options.signal);
	}

	/**
	 * Returns the id of a record type by DeveloperName, e.g. `recordTypeId("Complaint")`. Record type
	 * ids differ between orgs, so resolve them at runtime instead of hard-coding them.
	 */
	async recordTypeId(developerName: RecordTypeName<R, K>, options: RequestSignal = {}): Promise<string> {
		const describe = await this.describe(options);
		const match = describe.recordTypeInfos.find((info) => info.developerName === developerName);
		if (!match) {
			const available = describe.recordTypeInfos.map((info) => info.developerName).join(", ");
			throw new Error(`${this.name} has no record type "${developerName}". Available: ${available || "none"}.`);
		}
		return match.recordTypeId;
	}

	/**
	 * Active picklist values of a field. With `recordType`, only the values available for that
	 * record type are returned (via the UI API).
	 */
	async picklistValues<F extends SObjectFieldName<R, K>>(
		field: F,
		options: RequestSignal & { recordType?: RecordTypeName<R, K> } = {},
	): Promise<PicklistOption<NonNullable<SObjectRecord<R, K>[F]>>[]> {
		type Value = NonNullable<SObjectRecord<R, K>[F]>;
		if (options.recordType !== undefined) {
			const recordTypeId = await this.recordTypeId(options.recordType, options);
			const values = await new UiApi<R>(this._connection).picklistValues(this.name, recordTypeId, field, options);
			return values.values.map((entry) => ({
				value: entry.value as Value,
				label: entry.label,
				isDefault: values.defaultValue?.value === entry.value,
			}));
		}
		const describe = await this.describe(options);
		const describeField = describe.fields.find((item) => item.name === field);
		if (!describeField) {
			throw new Error(`${this.name} has no field "${field}".`);
		}
		return describeField.picklistValues
			.filter((entry) => entry.active)
			.map((entry) => ({
				value: entry.value as Value,
				label: entry.label ?? entry.value,
				isDefault: entry.defaultValue,
			}));
	}

	/** Quick actions of this sObject. */
	get quickActions(): QuickActionsApi {
		return new QuickActionsApi(this._connection, `${this.path}/quickActions`);
	}

	/** `GET /sobjects/{name}`: basic metadata and recently viewed records. */
	basicInfo(options: RequestSignal = {}): Promise<SObjectBasicInfo> {
		return this._connection.request({ path: this.path, signal: options.signal });
	}

	/** Creates a record and returns its id. Throws `SalesforceSaveError` if Salesforce reports `success: false`. */
	async create(record: SObjectCreateInput<R, K>, options: RequestSignal = {}): Promise<string> {
		const result = await this._connection.request<SaveResult>({
			method: "POST",
			path: this.path,
			body: record,
			signal: options.signal,
		});
		if (!result.success || !result.id) {
			throw new SalesforceSaveError(`Creating ${this.name} failed`, [result], result.errors);
		}
		return result.id;
	}

	/** Retrieves a record with all fields. */
	get(id: string, options?: RequestSignal): Promise<WithAttributes<SObjectRecord<R, K>>>;
	/** Retrieves a record with only `fields`; the result type is narrowed accordingly. */
	get<F extends SObjectFieldName<R, K>>(
		id: string,
		fields: readonly F[],
		options?: RequestSignal,
	): Promise<WithAttributes<Pick<SObjectRecord<R, K>, F>>>;
	get(
		id: string,
		fieldsOrOptions?: readonly string[] | RequestSignal,
		maybeOptions: RequestSignal = {},
	): Promise<unknown> {
		const fields = Array.isArray(fieldsOrOptions) ? (fieldsOrOptions as readonly string[]) : undefined;
		const options = Array.isArray(fieldsOrOptions) ? maybeOptions : ((fieldsOrOptions as RequestSignal) ?? {});
		return this._connection.request({
			path: `${this.path}/${segment(requireId(id))}`,
			query: { fields: fields && fields.length > 0 ? fields : undefined },
			signal: options.signal,
		});
	}

	/** Updates fields of a record. */
	async update(id: string, record: SObjectUpdateInput<R, K>, options: RequestSignal = {}): Promise<void> {
		await this._connection.request({
			method: "PATCH",
			path: `${this.path}/${segment(requireId(id))}`,
			body: record,
			signal: options.signal,
		});
	}

	/** Deletes a record. */
	async delete(id: string, options: RequestSignal = {}): Promise<void> {
		await this._connection.request({
			method: "DELETE",
			path: `${this.path}/${segment(requireId(id))}`,
			signal: options.signal,
		});
	}

	/**
	 * Inserts or updates a record by external id (`PATCH /sobjects/{name}/{field}/{value}`).
	 * Salesforce answers 300 (a `SalesforceError`) when the value matches more than one record.
	 */
	async upsert<F extends ExternalIdField<R, K>>(
		externalIdField: F,
		externalIdValue: string | number,
		record: Omit<SObjectCreateInput<R, K>, F>,
		options: RequestSignal & { updateOnly?: boolean } = {},
	): Promise<UpsertOutcome> {
		const response = await this._connection.send<UpsertResult | undefined>({
			method: "PATCH",
			path: `${this.path}/${segment(externalIdField)}/${segment(externalIdText(externalIdValue))}`,
			query: { updateOnly: options.updateOnly ? true : undefined },
			body: record,
			signal: options.signal,
		});
		const result = response.data;
		if (result && (!result.success || !result.id)) {
			throw new SalesforceSaveError(`Upserting ${this.name} failed`, [result], result.errors);
		}
		return { id: result?.id ?? "", created: result?.created ?? response.status === 201 };
	}

	/** Retrieves a record by external id. */
	getByExternalId<F extends SObjectFieldName<R, K> = SObjectFieldName<R, K>>(
		externalIdField: ExternalIdField<R, K>,
		externalIdValue: string | number,
		fields?: readonly F[],
		options: RequestSignal = {},
	): Promise<WithAttributes<Pick<SObjectRecord<R, K>, F>>> {
		return this._connection.request({
			path: `${this.path}/${segment(externalIdField)}/${segment(externalIdText(externalIdValue))}`,
			query: { fields: fields && fields.length > 0 ? fields : undefined },
			signal: options.signal,
		});
	}

	/** Ids of records deleted between `start` and `end` (UTC, at most 15 days back). */
	getDeleted(start: Date, end: Date, options: RequestSignal = {}): Promise<DeletedRecordsResult> {
		return this._connection.request({
			path: `${this.path}/deleted/`,
			query: { start: formatDateTime(start), end: formatDateTime(end) },
			signal: options.signal,
		});
	}

	/** Ids of records updated between `start` and `end` (UTC, at most 30 days back). */
	getUpdated(start: Date, end: Date, options: RequestSignal = {}): Promise<UpdatedRecordsResult> {
		return this._connection.request({
			path: `${this.path}/updated/`,
			query: { start: formatDateTime(start), end: formatDateTime(end) },
			signal: options.signal,
		});
	}

	/** Downloads a blob field, e.g. `sobject("ContentVersion").getBlob(id, "VersionData")`. */
	getBlob(id: string, field: SObjectFieldName<R, K>, options: RequestSignal = {}): Promise<Uint8Array> {
		return this._connection.request({
			path: `${this.path}/${segment(requireId(id))}/${segment(field)}`,
			responseType: "binary",
			signal: options.signal,
		});
	}

	/** Starts a typed query on this sObject. */
	soql(): SoqlQueryBuilder<R, K> {
		return Builder.from<R, K>(this.name);
	}

	/** Runs a query built on this sObject and returns the first page. */
	query<S extends object = NoSelection>(
		build: (query: SoqlQueryBuilder<R, K>) => SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): Promise<QueryResult<SoqlQueryRecord<R, K, S>>> {
		return this._queries.page(build(this.soql()).build(), options);
	}

	/** Runs a query built on this sObject and returns the records of all pages. */
	collect<S extends object = NoSelection>(
		build: (query: SoqlQueryBuilder<R, K>) => SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): Promise<SoqlQueryRecord<R, K, S>[]> {
		return this._queries.collect(build(this.soql()).build(), options);
	}

	/** Runs a query built on this sObject and yields records of all pages lazily. */
	iterate<S extends object = NoSelection>(
		build: (query: SoqlQueryBuilder<R, K>) => SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): AsyncGenerator<SoqlQueryRecord<R, K, S>, void, undefined> {
		return this._queries.iterate(build(this.soql()).build(), options);
	}
}

function requireId(id: string): string {
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error("A record id is required.");
	}
	return id;
}

/** Formats a date as `yyyy-MM-ddTHH:mm:ss+00:00`, the format the deleted/updated resources expect. */
function formatDateTime(date: Date): string {
	return `${date.toISOString().slice(0, 19)}+00:00`;
}
