import { externalIdText, segment } from "../http/connection";
import type {
	ChildRelationshipName,
	ChildSObjectName,
	ExternalIdField,
	ParentRelationshipName,
	ParentSObjectName,
	SObjectCreateInput,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
	SObjectUpdateInput,
} from "../registry";
import type { SoqlQueryBuilder, SoqlQueryRecord } from "../soql/query-builder";
import type { CompositeMethod, DeletedRecordsResult, UpdatedRecordsResult } from "../types/api";
import type { QueryResponse, SaveResult, UpsertResult, WithAttributes } from "../types/common";
import type { DescribeSObjectResult, SObjectBasicInfo } from "../types/describe";

declare const refResultType: unique symbol;
declare const batchResultType: unique symbol;

/**
 * A handle to a composite subrequest. Use `ref("id")` to reference its result in a later
 * subrequest (it becomes `@{referenceId.id}`) and `response.get(handle)` to read the result.
 */
export interface CompositeRef<T> {
	readonly referenceId: string;
	/** Returns the `@{referenceId.path}` expression. Paths can go deeper, e.g. `"records[0].Id"`. */
	ref(path: (keyof T & string) | (string & {})): string;
	readonly [refResultType]?: T;
}

/**
 * A handle to a composite batch subrequest: pass it to `response.get(handle)` to read the result.
 * Batch subrequests are independent, so a handle can't be referenced by another subrequest.
 */
export interface BatchRef<T> {
	/** The position of the subrequest in the batch. */
	readonly index: number;
	readonly [batchResultType]?: T;
}

export interface SubrequestOptions {
	/** A custom reference id. Defaults to `ref1`, `ref2`, ... */
	referenceId?: string;
	/** Extra headers for this subrequest (not Accept, Authorization or Content-Type). */
	httpHeaders?: Record<string, string>;
}

/** What each kind of builder returns and accepts per subrequest. */
export interface SubrequestKinds<T> {
	composite: { handle: CompositeRef<T>; options: [options?: SubrequestOptions] };
	batch: { handle: BatchRef<T>; options: [] };
}

export type SubrequestKind = keyof SubrequestKinds<unknown>;
/** The handle type a builder of kind `Kind` returns for a result of type `T`. */
export type SubrequestHandle<Kind extends SubrequestKind, T> = SubrequestKinds<T>[Kind]["handle"];
/** The trailing options parameter of a builder of kind `Kind`. */
export type SubrequestOptionArgs<Kind extends SubrequestKind> = SubrequestKinds<unknown>[Kind]["options"];

export interface CompositeRawSubrequest {
	method: CompositeMethod;
	/** Relative to `/services/data/{version}` (e.g. `"/sobjects/Account"`) or a full `/services/...` path. */
	path: string;
	body?: unknown;
}

/**
 * The typed subrequests `/composite`, `/composite/graph` and `/composite/batch` have in common.
 * Paths are relative to `/services/data/{version}`.
 */
export abstract class SubrequestBuilder<R extends object, Kind extends SubrequestKind> {
	create<K extends SObjectName<R>>(
		sobject: K,
		record: SObjectCreateInput<R, K>,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, SaveResult> {
		return this.add("POST", `/sobjects/${segment(sobject)}`, record, ...options);
	}

	update<K extends SObjectName<R>>(
		sobject: K,
		id: string,
		record: SObjectUpdateInput<R, K>,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, null> {
		return this.add("PATCH", this.recordPath(sobject, id), record, ...options);
	}

	upsert<K extends SObjectName<R>, F extends ExternalIdField<R, K>>(
		sobject: K,
		externalIdField: F,
		externalIdValue: string | number,
		record: Omit<SObjectCreateInput<R, K>, F>,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, UpsertResult> {
		return this.add("PATCH", this.externalIdPath(sobject, externalIdField, externalIdValue), record, ...options);
	}

	delete<K extends SObjectName<R>>(
		sobject: K,
		id: string,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, null> {
		return this.add("DELETE", this.recordPath(sobject, id), undefined, ...options);
	}

	get<K extends SObjectName<R>, F extends SObjectFieldName<R, K> = SObjectFieldName<R, K>>(
		sobject: K,
		id: string,
		fields?: readonly F[],
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, WithAttributes<Pick<SObjectRecord<R, K>, F>>> {
		return this.add("GET", `${this.recordPath(sobject, id)}${fieldsQuery(fields)}`, undefined, ...options);
	}

	/** Retrieves a record by external id. */
	getByExternalId<K extends SObjectName<R>, F extends SObjectFieldName<R, K> = SObjectFieldName<R, K>>(
		sobject: K,
		externalIdField: ExternalIdField<R, K>,
		externalIdValue: string | number,
		fields?: readonly F[],
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, WithAttributes<Pick<SObjectRecord<R, K>, F>>> {
		return this.add(
			"GET",
			`${this.externalIdPath(sobject, externalIdField, externalIdValue)}${fieldsQuery(fields)}`,
			undefined,
			...options,
		);
	}

	/** The child records of one relationship (`/sobjects/{name}/{id}/{relationship}`), e.g. an Account's `Contacts`. */
	children<
		K extends SObjectName<R>,
		// `const` keeps the literal: K is inferred in the same call, so the constraint alone doesn't.
		const C extends ChildRelationshipName<R, K>,
		F extends SObjectFieldName<R, ChildSObjectName<R, K, C>> = SObjectFieldName<R, ChildSObjectName<R, K, C>>,
	>(
		sobject: K,
		id: string,
		relationship: C,
		fields?: readonly F[],
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, QueryResponse<WithAttributes<Pick<SObjectRecord<R, ChildSObjectName<R, K, C>>, F>>>> {
		return this.add(
			"GET",
			`${this.recordPath(sobject, id)}/${segment(relationship)}${fieldsQuery(fields)}`,
			undefined,
			...options,
		);
	}

	/** The parent record of one relationship (`/sobjects/{name}/{id}/{relationship}`), e.g. a Contact's `Account`. */
	parent<
		K extends SObjectName<R>,
		const P extends ParentRelationshipName<R, K>,
		F extends SObjectFieldName<R, ParentSObjectName<R, K, P>> = SObjectFieldName<R, ParentSObjectName<R, K, P>>,
	>(
		sobject: K,
		id: string,
		relationship: P,
		fields?: readonly F[],
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, WithAttributes<Pick<SObjectRecord<R, ParentSObjectName<R, K, P>>, F>>> {
		return this.add(
			"GET",
			`${this.recordPath(sobject, id)}/${segment(relationship)}${fieldsQuery(fields)}`,
			undefined,
			...options,
		);
	}

	/** Adds a SOQL query subrequest. Its result is one page (`QueryResponse`). */
	query<K extends SObjectName<R>, S extends object>(
		query: SoqlQueryBuilder<R, K, S>,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, QueryResponse<SoqlQueryRecord<R, K, S>>>;
	query<T = Record<string, unknown>>(
		soql: string,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, QueryResponse<T>>;
	query(query: string | { build(): string }, ...options: SubrequestOptionArgs<Kind>): SubrequestHandle<Kind, unknown> {
		return this.addQuery("/query", query, options);
	}

	/** Like `query`, but includes deleted and archived records. */
	queryAll<K extends SObjectName<R>, S extends object>(
		query: SoqlQueryBuilder<R, K, S>,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, QueryResponse<SoqlQueryRecord<R, K, S>>>;
	queryAll<T = Record<string, unknown>>(
		soql: string,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, QueryResponse<T>>;
	queryAll(
		query: string | { build(): string },
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, unknown> {
		return this.addQuery("/queryAll", query, options);
	}

	/** `GET /sobjects/{name}/describe`. */
	describe<K extends SObjectName<R>>(
		sobject: K,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, DescribeSObjectResult> {
		return this.add("GET", `/sobjects/${segment(sobject)}/describe`, undefined, ...options);
	}

	/** `GET /sobjects/{name}`: basic information and recently used records. */
	basicInfo<K extends SObjectName<R>>(
		sobject: K,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, SObjectBasicInfo> {
		return this.add("GET", `/sobjects/${segment(sobject)}`, undefined, ...options);
	}

	/** Ids of records deleted between `start` and `end` (UTC, at most 15 days back). */
	getDeleted<K extends SObjectName<R>>(
		sobject: K,
		start: Date,
		end: Date,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, DeletedRecordsResult> {
		return this.add("GET", `/sobjects/${segment(sobject)}/deleted/${dateRange(start, end)}`, undefined, ...options);
	}

	/** Ids of records updated between `start` and `end` (UTC, at most 30 days back). */
	getUpdated<K extends SObjectName<R>>(
		sobject: K,
		start: Date,
		end: Date,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, UpdatedRecordsResult> {
		return this.add("GET", `/sobjects/${segment(sobject)}/updated/${dateRange(start, end)}`, undefined, ...options);
	}

	/** Adds any other supported subrequest. The path is sent as is, so encode its query string yourself. */
	request<T = unknown>(
		subrequest: CompositeRawSubrequest,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, T> {
		return this.add(subrequest.method, subrequest.path, subrequest.body, ...options);
	}

	/** Collects one subrequest and returns its handle. */
	protected abstract add<T>(
		method: CompositeMethod,
		path: string,
		body: unknown,
		...options: SubrequestOptionArgs<Kind>
	): SubrequestHandle<Kind, T>;

	/**
	 * Encodes `value` with `encode`. Composite builders leave `@{...}` references as they are,
	 * because Salesforce only substitutes references it can read literally.
	 */
	protected abstract encode(value: string, encode: (part: string) => string): string;

	/** Called for every query subrequest (Salesforce limits how many one composite request may hold). */
	protected countQuery(): void {}

	protected recordPath(sobject: string, id: string): string {
		return `/sobjects/${segment(sobject)}/${this.encode(id, segment)}`;
	}

	private externalIdPath(sobject: string, field: string, value: string | number): string {
		return `/sobjects/${segment(sobject)}/${segment(field)}/${this.encode(externalIdText(value), segment)}`;
	}

	private addQuery(
		resource: "/query" | "/queryAll",
		query: string | { build(): string },
		options: SubrequestOptionArgs<Kind>,
	): SubrequestHandle<Kind, unknown> {
		const soql = typeof query === "string" ? query : query.build();
		this.countQuery();
		return this.add("GET", `${resource}?q=${this.encode(soql, encodeURIComponent)}`, undefined, ...options);
	}
}

function fieldsQuery(fields: readonly string[] | undefined): string {
	return fields && fields.length > 0 ? `?fields=${fields.map(segment).join(",")}` : "";
}

function dateRange(start: Date, end: Date): string {
	return `?start=${encodeURIComponent(formatDateTime(start))}&end=${encodeURIComponent(formatDateTime(end))}`;
}

/** Formats a date as `yyyy-MM-ddTHH:mm:ss+00:00`, the format the deleted/updated resources expect. */
export function formatDateTime(date: Date): string {
	return `${date.toISOString().slice(0, 19)}+00:00`;
}
