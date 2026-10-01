import { SalesforceError } from "../errors";
import type { SalesforceConnection } from "../http/connection";
import type { QueryResponse } from "../types/common";

declare const queryCursorRecord: unique symbol;

/** A `nextRecordsUrl` that remembers the record type of the query it belongs to. */
export type QueryCursor<TRecord> = string & { readonly [queryCursorRecord]: TRecord };

/** One page of query results. Pass `nextRecordsUrl` to `queryMore` to fetch the next page. */
export interface QueryResult<TRecord> {
	records: TRecord[];
	totalSize: number;
	done: boolean;
	nextRecordsUrl?: QueryCursor<TRecord>;
}

export interface QueryOptions {
	/** Use `/queryAll`, which also returns deleted and archived records. */
	includeDeleted?: boolean;
	/** Preferred page size (200–2000), sent as `Sforce-Query-Options: batchSize=n`. Not guaranteed. */
	batchSize?: number;
	signal?: AbortSignal;
}

/**
 * Salesforce rejects request URLs above about 16 KB (431/414). Longer queries, such as a large
 * `whereIn`, are sent in the body of a composite request instead; SOQL itself may be 100 000
 * characters.
 */
export const MAX_QUERY_URL_LENGTH = 12_000;

interface CompositeSubresponse {
	body: unknown;
	httpHeaders: Record<string, string>;
	httpStatusCode: number;
}

/** Runs SOQL against `/query`/`/queryAll` (or the Tooling API equivalents) and follows pages. */
export class QueryApi {
	constructor(
		private readonly _connection: SalesforceConnection,
		private readonly _basePath: "" | "/tooling" = "",
	) {}

	/** Returns the first page of results. */
	async page<TRecord>(soql: string, options: QueryOptions = {}): Promise<QueryResult<TRecord>> {
		if (typeof soql !== "string" || soql.trim().length === 0) {
			throw new Error("query() requires a non-blank SOQL string.");
		}
		const path = `${this._basePath}/${options.includeDeleted ? "queryAll" : "query"}`;
		const headers = batchSizeHeader(options.batchSize);
		const encoded = encodeURIComponent(soql);
		const response =
			encoded.length > MAX_QUERY_URL_LENGTH
				? await this.viaComposite<TRecord>(path, encoded, headers, options.signal)
				: await this._connection.request<QueryResponse<TRecord>>({
						path,
						query: { q: soql },
						headers,
						signal: options.signal,
					});
		return toQueryResult(response);
	}

	/** Sends a query that is too long for a URL as a composite subrequest (still one API call). */
	private async viaComposite<TRecord>(
		path: string,
		encodedSoql: string,
		headers: Record<string, string> | undefined,
		signal: AbortSignal | undefined,
	): Promise<QueryResponse<TRecord>> {
		const result = await this._connection.request<{ compositeResponse: CompositeSubresponse[] }>({
			method: "POST",
			path: `${this._basePath}/composite`,
			body: {
				compositeRequest: [
					{
						method: "GET",
						referenceId: "query",
						url: `/services/data/${this._connection.apiVersion}${path}?q=${encodedSoql}`,
						...(headers ? { httpHeaders: headers } : {}),
					},
				],
			},
			// Read-only, so as safe to retry as a GET.
			retry: true,
			signal,
		});
		const [response] = result.compositeResponse;
		if (!response || response.httpStatusCode >= 400) {
			throw new SalesforceError({
				status: response?.httpStatusCode ?? 500,
				method: "GET",
				path,
				body: response?.body,
				headers: response?.httpHeaders,
			});
		}
		return response.body as QueryResponse<TRecord>;
	}

	/** Fetches the page a cursor points to. */
	async more<TRecord>(
		cursor: QueryCursor<TRecord>,
		options: Pick<QueryOptions, "batchSize" | "signal"> = {},
	): Promise<QueryResult<TRecord>> {
		if (typeof cursor !== "string" || !cursor.includes("/query")) {
			throw new Error(`queryMore() expects a nextRecordsUrl, got "${String(cursor)}".`);
		}
		const response = await this._connection.request<QueryResponse<TRecord>>({
			path: cursor,
			headers: batchSizeHeader(options.batchSize),
			signal: options.signal,
		});
		return toQueryResult(response);
	}

	/** Yields every record, fetching further pages on demand. */
	async *iterate<TRecord>(soql: string, options: QueryOptions = {}): AsyncGenerator<TRecord, void, undefined> {
		let result = await this.page<TRecord>(soql, options);
		yield* result.records;
		while (!result.done && result.nextRecordsUrl) {
			result = await this.more(result.nextRecordsUrl, options);
			yield* result.records;
		}
	}

	/** Fetches every page and returns all records. */
	async collect<TRecord>(soql: string, options: QueryOptions = {}): Promise<TRecord[]> {
		const records: TRecord[] = [];
		for await (const record of this.iterate<TRecord>(soql, options)) {
			records.push(record);
		}
		return records;
	}
}

function toQueryResult<TRecord>(response: QueryResponse<TRecord>): QueryResult<TRecord> {
	if (typeof response !== "object" || response === null || !Array.isArray(response.records)) {
		throw new Error("Unexpected query response: missing records array.");
	}
	return {
		records: response.records,
		totalSize: response.totalSize,
		done: response.done,
		nextRecordsUrl: response.nextRecordsUrl as QueryCursor<TRecord> | undefined,
	};
}

function batchSizeHeader(batchSize: number | undefined): Record<string, string> | undefined {
	if (batchSize === undefined) {
		return undefined;
	}
	if (!Number.isSafeInteger(batchSize) || batchSize < 200 || batchSize > 2000) {
		throw new Error("batchSize must be an integer between 200 and 2000.");
	}
	return { "Sforce-Query-Options": `batchSize=${batchSize}` };
}
