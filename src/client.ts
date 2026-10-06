import type { AuthProvider } from "./auth/types";
import { MetadataCache } from "./cache";
import {
	type ApiUsage,
	type RequestHooks,
	type RestRequest,
	type RestResponse,
	type RetryOptions,
	SalesforceConnection,
} from "./http/connection";
import { fetchTransport } from "./http/fetch-transport";
import type { HttpMethod, HttpTransport } from "./http/transport";
import type { GenericRegistry, SObjectName } from "./registry";
import { ActionsApi } from "./resources/actions";
import { ApprovalsApi } from "./resources/approvals";
import { BulkApi } from "./resources/bulk";
import { CollectionsApi } from "./resources/collections";
import { CompositeApi } from "./resources/composite";
import { EventsApi } from "./resources/events";
import { FilesApi } from "./resources/files";
import { QueryApi, type QueryCursor, type QueryOptions, type QueryResult } from "./resources/query";
import { QuickActionsApi } from "./resources/quick-actions";
import { ReportsApi } from "./resources/reports";
import { SearchApi } from "./resources/search";
import { SObjectResource } from "./resources/sobject";
import { ToolingApi } from "./resources/tooling";
import { UiApi } from "./resources/ui-api";
import { type NoSelection, SoqlQueryBuilder, type SoqlQueryRecord } from "./soql/query-builder";
import type { ApiVersionInfo, OrgLimits, QueryPlan, RecordCountResult } from "./types/api";
import type { ApiVersion, GenericRecord } from "./types/common";
import type { DescribeGlobalResult } from "./types/describe";

export interface SalesforceClientOptions {
	/** Where access tokens come from: `accessToken()`, `clientCredentials()`, `jwtBearer()`, ... */
	auth: AuthProvider;
	/**
	 * The REST API version, e.g. `"v66.0"`. Required: there is no default, so a Salesforce release
	 * never changes the version you call. Tip: pass the `API_VERSION` constant exported by your
	 * generated types, so requests use the version the types were generated with.
	 */
	apiVersion: ApiVersion;
	/** The HTTP transport. Defaults to `fetchTransport()`; pass your own to use another HTTP client. */
	transport?: HttpTransport;
	/** Per-request timeout in milliseconds. Defaults to 120 000. Use `0` to disable. */
	timeoutMs?: number;
	/** Opt-in retries on 429/5xx. Only `GET`/`HEAD` are retried unless a request sets `retry: true`. */
	retry?: RetryOptions | boolean;
	/** Extra origins (besides the instance URL) that absolute URLs may point to. */
	allowedOrigins?: string[];
	/** Headers sent with every request, e.g. `{ "Sforce-Call-Options": "client=my-app" }`. */
	headers?: Record<string, string>;
	/** Observability hooks, e.g. for logging request and response bodies. Tokens are redacted. */
	hooks?: RequestHooks;
	/**
	 * Cache metadata (describe, UI API object info, record type ids) in memory for the lifetime of
	 * the client. Defaults to `true`; clear it with `clearCache()`.
	 */
	cache?: boolean;
}

export interface ApexRestRequest extends Omit<RestRequest, "path"> {
	/** The `urlMapping` of the `@RestResource`, e.g. `"/accounts/001..."` (namespace included if any). */
	path: string;
}

/**
 * A type-safe Salesforce REST API client.
 *
 * ```ts
 * import type { SObjectRegistry } from "./generated/sobjects";
 *
 * const sf = new SalesforceClient<SObjectRegistry>({
 * 	auth: clientCredentials({ loginUrl, clientId, clientSecret }),
 * });
 * const id = await sf.sobject("Account").create({ Name: "Acme" });
 * ```
 *
 * Without a registry type argument the client is untyped: any sObject name and field is accepted.
 */
export class SalesforceClient<R extends object = GenericRegistry> {
	/** The low-level executor, for advanced use. */
	readonly connection: SalesforceConnection;
	/** SOSL, parameterized search and search suggestions. */
	readonly search: SearchApi;
	/** Composite, composite batch, sObject tree and composite graph. */
	readonly composite: CompositeApi<R>;
	/** sObject collections: up to 200 records per call. */
	readonly collections: CollectionsApi<R>;
	/** Invocable actions, including Flows and Apex `@InvocableMethod`s. */
	readonly actions: ActionsApi;
	/** The Tooling API. */
	readonly tooling: ToolingApi;
	/** Bulk API 2.0 ingest and query jobs. */
	readonly bulk: BulkApi<R>;
	/** Publish platform events. */
	readonly events: EventsApi<R>;
	/** Approval processes: submit, approve, reject. */
	readonly approvals: ApprovalsApi;
	/** Global quick actions (per-sObject actions are on `sobject(name).quickActions`). */
	readonly quickActions: QuickActionsApi;
	/** User Interface API: object info, picklist values per record type, records, layouts. */
	readonly uiApi: UiApi<R>;
	/** Salesforce Files: upload, download, new versions, sharing. */
	readonly files: FilesApi;
	/** Reports: run synchronously or asynchronously and flatten the rows. */
	readonly reports: ReportsApi;
	private readonly _queries: QueryApi;
	private readonly _cache: MetadataCache;

	constructor(options: SalesforceClientOptions) {
		if (!options?.auth) {
			throw new TypeError("SalesforceClient requires an auth provider.");
		}
		this.connection = new SalesforceConnection({
			auth: options.auth,
			transport: options.transport ?? fetchTransport(),
			apiVersion: options.apiVersion,
			timeoutMs: options.timeoutMs,
			retry: options.retry,
			allowedOrigins: options.allowedOrigins,
			headers: options.headers,
			hooks: options.hooks,
		});
		this._queries = new QueryApi(this.connection);
		this.search = new SearchApi(this.connection);
		this.composite = new CompositeApi<R>(this.connection);
		this.collections = new CollectionsApi<R>(this.connection);
		this.actions = new ActionsApi(this.connection);
		this.tooling = new ToolingApi(this.connection);
		this.bulk = new BulkApi<R>(this.connection);
		this.events = new EventsApi<R>(this.connection);
		this._cache = new MetadataCache(options.cache !== false);
		this.approvals = new ApprovalsApi(this.connection, this._queries);
		this.quickActions = new QuickActionsApi(this.connection, "/quickActions");
		this.uiApi = new UiApi<R>(this.connection, this._cache);
		this.files = new FilesApi(this.connection);
		this.reports = new ReportsApi(this.connection);
	}

	/** Drops cached metadata (describe results, object info, record type ids). */
	clearCache(): void {
		this._cache.clear();
	}

	get apiVersion(): ApiVersion {
		return this.connection.apiVersion;
	}

	/** API usage as reported by the last response (`Sforce-Limit-Info`). */
	get apiUsage(): ApiUsage | undefined {
		return this.connection.apiUsage;
	}

	/** The instance URL of the current access token (authenticates if needed). */
	instanceUrl(options: { signal?: AbortSignal } = {}): Promise<string> {
		return this.connection.instanceUrl(options.signal);
	}

	/**
	 * Calls any REST resource. `path` is relative to `/services/data/{apiVersion}` unless it
	 * starts with `/services/` or is an absolute URL on the instance.
	 *
	 * ```ts
	 * const limits = await sf.request<OrgLimits>({ path: "/limits" });
	 * ```
	 */
	request<T = unknown>(request: RestRequest): Promise<T> {
		return this.connection.request<T>(request);
	}

	/** Like `request`, but also returns the status and response headers. */
	requestWithResponse<T = unknown>(request: RestRequest): Promise<RestResponse<T>> {
		return this.connection.send<T>(request);
	}

	/** Calls an Apex REST endpoint (`/services/apexrest/...`). */
	apexRest<T = unknown>(request: ApexRestRequest): Promise<T> {
		const path = request.path.replace(/^\/+/, "").replace(/^services\/apexrest\//, "");
		return this.connection.request<T>({ ...request, path: `/services/apexrest/${path}` });
	}

	/** Typed operations on one sObject. */
	sobject<K extends SObjectName<R>>(name: K): SObjectResource<R, K> {
		return new SObjectResource<R, K>(this.connection, this._queries, name, "", this._cache);
	}

	/** Starts a typed SOQL query. Run it with `query`, `queryAll`, `iterate` or `collect`. */
	soql<K extends SObjectName<R>>(sobjectName: K): SoqlQueryBuilder<R, K> {
		return SoqlQueryBuilder.from<R, K>(sobjectName);
	}

	/** Runs a query and returns the first page. Follow `nextRecordsUrl` with `queryMore`. */
	query<K extends SObjectName<R>, S extends object = NoSelection>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): Promise<QueryResult<SoqlQueryRecord<R, K, S>>>;
	query<T = GenericRecord>(soql: string, options?: QueryOptions): Promise<QueryResult<T>>;
	query(query: string | { build(): string }, options?: QueryOptions): Promise<QueryResult<unknown>> {
		return this._queries.page(toSoql(query), options);
	}

	/** Fetches the next page of a query. */
	queryMore<T>(cursor: QueryCursor<T>, options?: Pick<QueryOptions, "batchSize" | "signal">): Promise<QueryResult<T>> {
		return this._queries.more(cursor, options);
	}

	/** Yields every record of a query, fetching pages lazily. */
	iterate<K extends SObjectName<R>, S extends object = NoSelection>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): AsyncGenerator<SoqlQueryRecord<R, K, S>, void, undefined>;
	iterate<T = GenericRecord>(soql: string, options?: QueryOptions): AsyncGenerator<T, void, undefined>;
	iterate(query: string | { build(): string }, options?: QueryOptions): AsyncGenerator<unknown, void, undefined> {
		return this._queries.iterate(toSoql(query), options);
	}

	/** Fetches all pages of a query and returns every record. */
	collect<K extends SObjectName<R>, S extends object = NoSelection>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: QueryOptions,
	): Promise<SoqlQueryRecord<R, K, S>[]>;
	collect<T = GenericRecord>(soql: string, options?: QueryOptions): Promise<T[]>;
	collect(query: string | { build(): string }, options?: QueryOptions): Promise<unknown[]> {
		return this._queries.collect(toSoql(query), options);
	}

	/** `GET /services/data`: every API version the org supports. Does not count against limits. */
	versions(options: { signal?: AbortSignal } = {}): Promise<ApiVersionInfo[]> {
		return this.connection.request({ path: "/services/data/", signal: options.signal });
	}

	/** `GET /services/data/{version}`: the resources available in this version. */
	resources(options: { signal?: AbortSignal } = {}): Promise<Record<string, string>> {
		return this.connection.request({ path: "/", signal: options.signal });
	}

	/** `GET /limits`: org limits such as `DailyApiRequests`. */
	limits(options: { signal?: AbortSignal } = {}): Promise<OrgLimits> {
		return this.connection.request({ path: "/limits", signal: options.signal });
	}

	/** `GET /limits/recordCount`: approximate record counts per sObject. */
	recordCount(sobjects: readonly SObjectName<R>[], options: { signal?: AbortSignal } = {}): Promise<RecordCountResult> {
		return this.connection.request({
			path: "/limits/recordCount",
			query: { sObjects: sobjects },
			signal: options.signal,
		});
	}

	/** `GET /sobjects`: every sObject visible to the user. */
	describeGlobal(options: { signal?: AbortSignal } = {}): Promise<DescribeGlobalResult> {
		return this._cache.getOrLoad(
			"describe-global",
			(signal) => this.connection.request({ path: "/sobjects", signal }),
			options.signal,
		);
	}

	/**
	 * Asks Salesforce how it would run a query (`GET /query?explain=`, beta), e.g. to check a
	 * filter is selective. Plans are sorted best first; `relativeCost` above 1 means not selective.
	 */
	async explain(query: string | { build(): string }, options: { signal?: AbortSignal } = {}): Promise<QueryPlan[]> {
		const result = await this.connection.request<{ plans: QueryPlan[] }>({
			path: "/query",
			query: { explain: toSoql(query) },
			signal: options.signal,
		});
		return result.plans;
	}
}

function toSoql(query: string | { build(): string }): string {
	return typeof query === "string" ? query : query.build();
}

export type { HttpMethod };
