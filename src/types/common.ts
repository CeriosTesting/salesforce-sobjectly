import type { SalesforceErrorCode } from "./error-codes";

/** A Salesforce REST API version such as `"v66.0"`. */
export type ApiVersion = `v${number}.${number}`;

/** The `attributes` object Salesforce adds to every record it returns. */
export interface RecordAttributes {
	type: string;
	/** Absent in some contexts, such as aggregate query rows. */
	url?: string;
}

/** Adds the Salesforce `attributes` object to a record type. */
export type WithAttributes<T> = T & { attributes: RecordAttributes };

/** An untyped record, used when no generated registry is supplied. */
export type GenericRecord = Record<string, unknown>;

/** An item of the error array Salesforce returns for a non-2xx REST response. */
export interface RestError {
	message: string;
	errorCode: SalesforceErrorCode;
	fields?: string[];
	[key: string]: unknown;
}

/** An error inside a save/delete/upsert result. Note: `statusCode`, not `errorCode`. */
export interface SaveError {
	statusCode: SalesforceErrorCode;
	message: string;
	fields: string[];
	extendedErrorDetails?: unknown;
}

export interface SaveResult {
	/** Absent when the operation failed. */
	id?: string;
	success: boolean;
	errors: SaveError[];
}

export interface UpsertResult extends SaveResult {
	/** `true` when the record was inserted, `false` when an existing record was updated. */
	created?: boolean;
}

export type DeleteResult = SaveResult;

/** The raw shape of a `/query`, `/queryAll` or `/tooling/query` response page. */
export interface QueryResponse<T> {
	totalSize: number;
	done: boolean;
	nextRecordsUrl?: string;
	records: T[];
}

/** A Salesforce compound address field value. */
export interface SalesforceAddress {
	city: string | null;
	country: string | null;
	countryCode: string | null;
	geocodeAccuracy: string | null;
	latitude: number | null;
	longitude: number | null;
	postalCode: string | null;
	state: string | null;
	stateCode: string | null;
	street: string | null;
}

/** A Salesforce compound geolocation (`location`) field value. */
export interface SalesforceGeolocation {
	latitude: number | null;
	longitude: number | null;
}
