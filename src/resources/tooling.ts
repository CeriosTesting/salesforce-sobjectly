import type { RestRequest, SalesforceConnection } from "../http/connection";
import type { GenericRegistry } from "../registry";
import type { ExecuteAnonymousResult, RunTestsRequest } from "../types/api";
import type { GenericRecord } from "../types/common";
import type { DescribeGlobalResult } from "../types/describe";

import { type ApexLogEntry, type CaptureLogsOptions, DebugLogsApi } from "./debug-logs";
import { MAX_QUERY_URL_LENGTH, QueryApi, type QueryCursor, type QueryOptions, type QueryResult } from "./query";
import { SObjectResource } from "./sobject";

/** Thrown by `executeAnonymous` when Apex fails to compile or throws. */
export class ApexExecutionError extends Error {
	override readonly name: string = "ApexExecutionError";
	constructor(
		readonly result: ExecuteAnonymousResult,
		/** The debug logs, when the Apex ran with `captureLog: true`. */
		readonly logs: ApexLogEntry[] = [],
	) {
		super(
			result.compiled
				? `Anonymous Apex threw: ${result.exceptionMessage ?? "unknown error"}`
				: `Anonymous Apex failed to compile at line ${result.line}, column ${result.column}: ${result.compileProblem ?? "unknown problem"}`,
		);
	}
}

/** Loosely typed result of `runTestsSynchronous`. */
export interface RunTestsResult {
	numTestsRun: number;
	numFailures: number;
	totalTime: number;
	successes: Record<string, unknown>[];
	failures: Record<string, unknown>[];
	codeCoverage?: Record<string, unknown>[];
	codeCoverageWarnings?: Record<string, unknown>[];
	[key: string]: unknown;
}

/** The Tooling API (`/tooling/...`): metadata-ish sObjects such as ApexClass, anonymous Apex and tests. */
export interface ExecuteAnonymousOptions {
	/** Throw `ApexExecutionError` when the Apex doesn't compile or throws. Defaults to `true`. */
	throwOnError?: boolean;
	/** Capture the debug log of the execution (see `debugLogs.capture`). */
	captureLog?: boolean;
	/** Options for the log capture, e.g. log levels. */
	logOptions?: Omit<CaptureLogsOptions, "signal">;
	signal?: AbortSignal;
}

export class ToolingApi {
	private readonly _queries: QueryApi;
	/** Apex debug logs: capture the logs of a block of work, list and read logs. */
	readonly debugLogs: DebugLogsApi;

	constructor(private readonly _connection: SalesforceConnection) {
		this._queries = new QueryApi(_connection, "/tooling");
		this.debugLogs = new DebugLogsApi(this);
	}

	/** The connection this API uses. */
	get connection(): SalesforceConnection {
		return this._connection;
	}

	/** Runs a Tooling SOQL query and returns the first page. */
	query<T = GenericRecord>(soql: string, options?: QueryOptions): Promise<QueryResult<T>> {
		return this._queries.page<T>(soql, options);
	}

	queryMore<T>(cursor: QueryCursor<T>, options?: Pick<QueryOptions, "signal">): Promise<QueryResult<T>> {
		return this._queries.more(cursor, options);
	}

	iterate<T = GenericRecord>(soql: string, options?: QueryOptions): AsyncGenerator<T, void, undefined> {
		return this._queries.iterate<T>(soql, options);
	}

	collect<T = GenericRecord>(soql: string, options?: QueryOptions): Promise<T[]> {
		return this._queries.collect<T>(soql, options);
	}

	/** CRUD and describe for a Tooling sObject, e.g. `tooling.sobject("TraceFlag")`. */
	sobject(name: string): SObjectResource<GenericRegistry, string> {
		return new SObjectResource<GenericRegistry, string>(this._connection, this._queries, name, "/tooling");
	}

	describeGlobal(options: { signal?: AbortSignal } = {}): Promise<DescribeGlobalResult> {
		return this._connection.request({ path: "/tooling/sobjects", signal: options.signal });
	}

	/**
	 * Executes anonymous Apex. Throws `ApexExecutionError` when it does not compile or throws,
	 * unless `throwOnError` is `false`. Salesforce only accepts the Apex in the query string, so it is
	 * limited to about 12 000 characters once URL-encoded; put longer logic in an Apex class.
	 * With `captureLog: true` the result includes the debug log (`System.debug` output).
	 */
	executeAnonymous(
		apex: string,
		options: ExecuteAnonymousOptions & { captureLog: true },
	): Promise<ExecuteAnonymousResult & { logs: ApexLogEntry[] }>;
	executeAnonymous(apex: string, options?: ExecuteAnonymousOptions): Promise<ExecuteAnonymousResult>;
	async executeAnonymous(
		apex: string,
		options: ExecuteAnonymousOptions = {},
	): Promise<ExecuteAnonymousResult & { logs?: ApexLogEntry[] }> {
		const encodedLength = encodeURIComponent(apex).length;
		if (encodedLength > MAX_QUERY_URL_LENGTH) {
			throw new Error(
				`Anonymous Apex is too long: ${encodedLength} characters once URL-encoded, the limit is about ${MAX_QUERY_URL_LENGTH}. Salesforce only accepts it in the URL; move the logic into an Apex class.`,
			);
		}
		if (options.captureLog) {
			const { result, logs } = await this.debugLogs.capture(
				() => this.executeAnonymous(apex, { signal: options.signal, throwOnError: false }),
				{ ...options.logOptions, signal: options.signal },
			);
			if (options.throwOnError !== false && (!result.compiled || !result.success)) {
				throw new ApexExecutionError(result, logs);
			}
			return { ...result, logs };
		}
		const result = await this._connection.request<ExecuteAnonymousResult>({
			path: "/tooling/executeAnonymous/",
			query: { anonymousBody: apex },
			signal: options.signal,
		});
		if (options.throwOnError !== false && (!result.compiled || !result.success)) {
			throw new ApexExecutionError(result);
		}
		return result;
	}

	/** Runs Apex tests synchronously (a single class) and returns the results. */
	runTestsSynchronous(request: RunTestsRequest, options: { signal?: AbortSignal } = {}): Promise<RunTestsResult> {
		return this._connection.request({
			method: "POST",
			path: "/tooling/runTestsSynchronous/",
			body: request,
			signal: options.signal,
			timeoutMs: 0,
		});
	}

	/** Enqueues Apex tests and returns the AsyncApexJob id. */
	runTestsAsynchronous(request: RunTestsRequest, options: { signal?: AbortSignal } = {}): Promise<string> {
		return this._connection.request({
			method: "POST",
			path: "/tooling/runTestsAsynchronous/",
			body: request,
			signal: options.signal,
		});
	}

	/** Any other Tooling resource; `path` is relative to `/tooling`. */
	request<T>(request: RestRequest): Promise<T> {
		const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
		return this._connection.request<T>({ ...request, path: `/tooling${path}` });
	}
}
