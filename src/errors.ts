import type { HttpMethod } from "./http/transport";
import type { RestError, SaveError } from "./types/common";
import type { SalesforceErrorCode } from "./types/error-codes";

export interface SalesforceErrorDetails {
	status: number;
	method: HttpMethod;
	/**
	 * The request path without the query string (query strings can hold SOQL with personal data).
	 * Note that Salesforce's own error `message` may still quote parts of the query.
	 */
	path: string;
	body: unknown;
	headers: Record<string, string>;
}

/** Thrown for every non-2xx Salesforce REST response. */
export class SalesforceError extends Error {
	override readonly name: string = "SalesforceError";
	readonly status: number;
	readonly method: HttpMethod;
	readonly path: string;
	/** The `errorCode` of the first error, e.g. `"MALFORMED_QUERY"` or `"INVALID_FIELD"`. */
	readonly errorCode: SalesforceErrorCode | undefined;
	/** All errors Salesforce returned, when the body was the standard error array. */
	readonly errors: RestError[];
	/** The parsed response body. */
	readonly body: unknown;
	/** Response headers, without `set-cookie`. */
	readonly headers: Record<string, string>;
	/** The value of the `Sforce-Limit-Info` header, e.g. `"api-usage=18/15000"`. */
	readonly limitInfo: string | undefined;

	constructor(details: SalesforceErrorDetails) {
		const errors = toRestErrors(details.body);
		const first = errors[0];
		const reason = first ? `${first.errorCode}: ${first.message}` : describeBody(details.body);
		super(
			`Salesforce ${details.method} ${details.path} failed with status ${details.status}${reason ? ` - ${reason}` : ""}`,
		);
		this.status = details.status;
		this.method = details.method;
		this.path = details.path;
		this.errors = errors;
		this.errorCode = first?.errorCode;
		this.body = details.body;
		this.headers = details.headers;
		this.limitInfo = details.headers["sforce-limit-info"];
	}
}

/** Thrown when an OAuth token request fails. Never contains secrets or tokens. */
export class SalesforceAuthError extends Error {
	override readonly name: string = "SalesforceAuthError";
	readonly status: number | undefined;
	/** The OAuth `error` code, e.g. `"invalid_client"` or `"invalid_grant"`. */
	readonly error: string | undefined;
	readonly errorDescription: string | undefined;

	constructor(message: string, details: { status?: number; error?: string; errorDescription?: string } = {}) {
		super(message);
		this.status = details.status;
		this.error = details.error;
		this.errorDescription = details.errorDescription;
	}
}

/**
 * Thrown when a call returned HTTP 2xx but one or more items reported `success: false`
 * (record create, sObject collections, invocable actions, ...).
 */
export class SalesforceSaveError<TResult = unknown> extends Error {
	override readonly name: string = "SalesforceSaveError";
	/** Every item result, including the successful ones. */
	readonly results: TResult[];
	/** The errors of all failed items, flattened. */
	readonly errors: SaveError[];

	constructor(message: string, results: TResult[], errors: SaveError[]) {
		const first = errors[0];
		super(first ? `${message} - ${first.statusCode}: ${first.message}` : message);
		this.results = results;
		this.errors = errors;
	}
}

/** Thrown when a Bulk API 2.0 job ends in `Failed` or `Aborted`, or does not finish in time. */
export class SalesforceBulkJobError extends Error {
	override readonly name: string = "SalesforceBulkJobError";
	readonly jobId: string;
	readonly state: string;
	readonly jobInfo: unknown;

	constructor(message: string, jobId: string, state: string, jobInfo: unknown) {
		super(message);
		this.jobId = jobId;
		this.state = state;
		this.jobInfo = jobInfo;
	}
}

function toRestErrors(body: unknown): RestError[] {
	// Most resources answer with an array; some (e.g. parts of the UI API) with a single error object.
	const items = Array.isArray(body) ? (body as unknown[]) : body !== null && typeof body === "object" ? [body] : [];
	return items.filter(
		(item): item is RestError => typeof item === "object" && item !== null && "errorCode" in item && "message" in item,
	);
}

function describeBody(body: unknown): string {
	if (body === undefined || body === null) {
		return "";
	}
	if (typeof body === "string") {
		return body.slice(0, 500);
	}
	if (body instanceof Uint8Array) {
		return `${body.byteLength} bytes`;
	}
	try {
		return JSON.stringify(body).slice(0, 500);
	} catch {
		return "";
	}
}

/**
 * `true` when `error` is a `SalesforceError` (non-2xx response), optionally with `code` as one of
 * its error codes.
 */
export function isSalesforceError(error: unknown, code?: SalesforceErrorCode): error is SalesforceError {
	if (!(error instanceof SalesforceError)) {
		return false;
	}
	return code === undefined || error.errors.some((item) => item.errorCode === code);
}

/**
 * `true` when `error` carries error code `code`: a `SalesforceError` from a failed request, or a
 * `SalesforceSaveError` with a failed item (save results, collections, actions). Handy for
 * `catch` blocks and retry decisions, e.g. `hasErrorCode(error, "UNABLE_TO_LOCK_ROW")`.
 */
export function hasErrorCode(error: unknown, code: SalesforceErrorCode): boolean {
	if (error instanceof SalesforceError) {
		return error.errors.some((item) => item.errorCode === code);
	}
	if (error instanceof SalesforceSaveError) {
		return error.errors.some((item) => item.statusCode === code);
	}
	return false;
}

/**
 * Thrown when a call split into several requests (chunked collections, batched events) fails
 * after earlier chunks already succeeded. `completedResults` holds the results of those chunks,
 * which Salesforce has committed; `cause` is the error of the failing chunk.
 */
export class SalesforcePartialFailureError<TResult = unknown> extends Error {
	override readonly name: string = "SalesforcePartialFailureError";
	readonly completedResults: TResult[];
	override readonly cause: unknown;

	constructor(message: string, completedResults: TResult[], cause: unknown) {
		super(
			`${message} (${completedResults.length} item(s) were already processed): ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.completedResults = completedResults;
		this.cause = cause;
	}
}

/** Runs chunked work; when a later chunk fails, the error keeps the results of the earlier ones. */
export async function runChunks<TChunk, TResult>(
	chunks: readonly TChunk[],
	run: (chunk: TChunk) => Promise<TResult[]>,
	message: string,
): Promise<TResult[]> {
	const results: TResult[] = [];
	for (const chunk of chunks) {
		try {
			results.push(...(await run(chunk)));
		} catch (error) {
			if (results.length === 0) {
				throw error;
			}
			throw new SalesforcePartialFailureError(message, results, error);
		}
	}
	return results;
}
