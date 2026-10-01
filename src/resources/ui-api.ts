import type { MetadataCache } from "../cache";
import { type SalesforceConnection, segment } from "../http/connection";
import type { SObjectFieldName, SObjectName, SObjectRecord } from "../registry";
import type { ObjectInfo, PicklistValues, UiFieldValue, UiLayout, UiRecord } from "../types/platform";

export interface UiRecordOptions<F extends string> {
	/** Fields that must be accessible; an inaccessible field fails the request. */
	fields?: readonly F[];
	/** Fields that are returned when accessible and silently left out otherwise. */
	optionalFields?: readonly F[];
	layoutTypes?: readonly ("Full" | "Compact")[];
	modes?: readonly ("Create" | "Edit" | "View")[];
	signal?: AbortSignal;
}

export interface UiLayoutOptions {
	recordTypeId?: string;
	mode?: "Create" | "Edit" | "View";
	layoutType?: "Full" | "Compact";
	formFactor?: "Large" | "Medium" | "Small";
	signal?: AbortSignal;
}

/** The typed `fields` of a UI API record loaded with field names `F` of sObject `K`. */
export type UiRecordFields<R, K extends SObjectName<R>, F extends string> = {
	[P in F]: UiFieldValue<P extends keyof SObjectRecord<R, K> ? SObjectRecord<R, K>[P] : unknown>;
};

/** User Interface API: object info, picklist values per record type, records and layouts. */
export class UiApi<R extends object> {
	constructor(
		private readonly _connection: SalesforceConnection,
		private readonly _cache?: MetadataCache,
	) {}

	/** `GET /ui-api/object-info/{name}`: fields, record types and defaults as the UI sees them. Cached. */
	objectInfo<K extends SObjectName<R>>(sobject: K, options: { signal?: AbortSignal } = {}): Promise<ObjectInfo> {
		const load = (signal: AbortSignal | undefined): Promise<ObjectInfo> =>
			this._connection.request({ path: `/ui-api/object-info/${segment(sobject)}`, signal });
		return this._cache
			? this._cache.getOrLoad(`ui-object-info:${sobject}`, load, options.signal)
			: load(options.signal);
	}

	/** Picklist values of every picklist field for a record type. */
	picklistValues<K extends SObjectName<R>>(
		sobject: K,
		recordTypeId: string,
		options?: { signal?: AbortSignal },
	): Promise<Record<string, PicklistValues>>;
	/** Picklist values of one field for a record type. */
	picklistValues<K extends SObjectName<R>>(
		sobject: K,
		recordTypeId: string,
		field: SObjectFieldName<R, K>,
		options?: { signal?: AbortSignal },
	): Promise<PicklistValues>;
	async picklistValues(
		sobject: string,
		recordTypeId: string,
		fieldOrOptions?: string | { signal?: AbortSignal },
		maybeOptions: { signal?: AbortSignal } = {},
	): Promise<unknown> {
		const base = `/ui-api/object-info/${segment(sobject)}/picklist-values/${segment(recordTypeId)}`;
		if (typeof fieldOrOptions === "string") {
			return this._connection.request({ path: `${base}/${segment(fieldOrOptions)}`, signal: maybeOptions.signal });
		}
		const result = await this._connection.request<{ picklistFieldValues: Record<string, PicklistValues> }>({
			path: base,
			signal: fieldOrOptions?.signal,
		});
		return result.picklistFieldValues;
	}

	/**
	 * `GET /ui-api/records/{id}` with typed field names. At least one of `fields`,
	 * `optionalFields` or `layoutTypes` is required.
	 *
	 * ```ts
	 * const record = await sf.uiApi.record("Account", id, { fields: ["Name", "Industry"] });
	 * record.fields.Name.displayValue;
	 * ```
	 */
	record<K extends SObjectName<R>, F extends SObjectFieldName<R, K>>(
		sobject: K,
		id: string,
		options: UiRecordOptions<F>,
	): Promise<UiRecord<UiRecordFields<R, K, F>>> {
		const qualify = (fields: readonly string[] | undefined): string[] | undefined =>
			fields && fields.length > 0 ? fields.map((field) => `${sobject}.${field}`) : undefined;
		const fields = qualify(options.fields);
		const optionalFields = qualify(options.optionalFields);
		if (!fields && !optionalFields && !options.layoutTypes?.length) {
			throw new Error("uiApi.record() requires fields, optionalFields or layoutTypes.");
		}
		return this._connection.request({
			path: `/ui-api/records/${segment(id)}`,
			query: { fields, optionalFields, layoutTypes: options.layoutTypes, modes: options.modes },
			signal: options.signal,
		});
	}

	/** `GET /ui-api/layout/{name}`: the page layout sections, rows and fields. */
	layout<K extends SObjectName<R>>(sobject: K, options: UiLayoutOptions = {}): Promise<UiLayout> {
		const { signal, ...query } = options;
		return this._connection.request({ path: `/ui-api/layout/${segment(sobject)}`, query: { ...query }, signal });
	}
}
