import { SalesforceError } from "../errors";
import { externalIdText, type SalesforceConnection, segment } from "../http/connection";
import type {
	ChildRelationshipName,
	ChildSObjectName,
	ExternalIdField,
	SObjectCreateInput,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
	SObjectUpdateInput,
} from "../registry";
import type { SoqlQueryBuilder, SoqlQueryRecord } from "../soql/query-builder";
import type {
	CompositeBatchResult,
	CompositeMethod,
	CompositeSubrequest,
	CompositeSubrequestResult,
	TreeSaveResult,
} from "../types/api";
import type { ApiVersion, QueryResponse, SaveResult, UpsertResult, WithAttributes } from "../types/common";

const MAX_SUBREQUESTS = 25;
const MAX_QUERY_SUBREQUESTS = 5;
const MAX_GRAPHS = 75;
const MAX_GRAPH_NODES = 500;
const MAX_TREE_RECORDS = 200;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

declare const refResultType: unique symbol;

/** Matches a composite reference such as `@{NewAccount.id}`. */
const REFERENCE = /@\{[^{}]+\}/g;

/**
 * Encodes `value` with `encode` but leaves `@{...}` references as they are: Salesforce only
 * substitutes references it can read literally, so an encoded one would be sent as text.
 */
function keepReferences(value: string, encode: (part: string) => string): string {
	let result = "";
	let last = 0;
	for (const match of value.matchAll(REFERENCE)) {
		result += encode(value.slice(last, match.index)) + match[0];
		last = match.index + match[0].length;
	}
	return result + encode(value.slice(last));
}

/** A URL path segment that may be (or contain) a composite reference. */
function refSegment(value: string): string {
	return keepReferences(value, segment);
}

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

export interface SubrequestOptions {
	/** A custom reference id. Defaults to `ref1`, `ref2`, ... */
	referenceId?: string;
	/** Extra headers for this subrequest (not Accept, Authorization or Content-Type). */
	httpHeaders?: Record<string, string>;
}

export interface CompositeRawSubrequest {
	method: CompositeMethod;
	/** Relative to `/services/data/{version}` (e.g. `"/sobjects/Account"`) or a full `/services/...` path. */
	path: string;
	body?: unknown;
}

/** Collects subrequests for `/composite` or one graph of `/composite/graph`. */
export class CompositeRequestBuilder<R extends object> {
	private readonly _subrequests: CompositeSubrequest[] = [];
	private _queryCount = 0;

	constructor(
		private readonly _apiVersion: ApiVersion,
		private readonly _referencePrefix: string = "ref",
	) {}

	/** The subrequests collected so far. */
	get subrequests(): readonly CompositeSubrequest[] {
		return this._subrequests;
	}

	/** Number of query subrequests collected so far (Salesforce allows at most 5 per composite request). */
	get queryCount(): number {
		return this._queryCount;
	}

	create<K extends SObjectName<R>>(
		sobject: K,
		record: SObjectCreateInput<R, K>,
		options?: SubrequestOptions,
	): CompositeRef<SaveResult> {
		return this.add("POST", `/sobjects/${segment(sobject)}`, record, options);
	}

	update<K extends SObjectName<R>>(
		sobject: K,
		id: string,
		record: SObjectUpdateInput<R, K>,
		options?: SubrequestOptions,
	): CompositeRef<null> {
		return this.add("PATCH", `/sobjects/${segment(sobject)}/${refSegment(id)}`, record, options);
	}

	upsert<K extends SObjectName<R>, F extends ExternalIdField<R, K>>(
		sobject: K,
		externalIdField: F,
		externalIdValue: string | number,
		record: Omit<SObjectCreateInput<R, K>, F>,
		options?: SubrequestOptions,
	): CompositeRef<UpsertResult> {
		return this.add(
			"PATCH",
			`/sobjects/${segment(sobject)}/${segment(externalIdField)}/${refSegment(externalIdText(externalIdValue))}`,
			record,
			options,
		);
	}

	delete<K extends SObjectName<R>>(sobject: K, id: string, options?: SubrequestOptions): CompositeRef<null> {
		return this.add("DELETE", `/sobjects/${segment(sobject)}/${refSegment(id)}`, undefined, options);
	}

	get<K extends SObjectName<R>, F extends SObjectFieldName<R, K> = SObjectFieldName<R, K>>(
		sobject: K,
		id: string,
		fields?: readonly F[],
		options?: SubrequestOptions,
	): CompositeRef<WithAttributes<Pick<SObjectRecord<R, K>, F>>> {
		const query = fields && fields.length > 0 ? `?fields=${fields.map(segment).join(",")}` : "";
		return this.add("GET", `/sobjects/${segment(sobject)}/${refSegment(id)}${query}`, undefined, options);
	}

	/** Adds a SOQL query subrequest. Its result is one page (`QueryResponse`). */
	query<K extends SObjectName<R>, S extends object>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: SubrequestOptions,
	): CompositeRef<QueryResponse<SoqlQueryRecord<R, K, S>>>;
	query<T = Record<string, unknown>>(soql: string, options?: SubrequestOptions): CompositeRef<QueryResponse<T>>;
	query(query: string | { build(): string }, options?: SubrequestOptions): CompositeRef<unknown> {
		const soql = typeof query === "string" ? query : query.build();
		this._queryCount++;
		return this.add("GET", `/query?q=${keepReferences(soql, encodeURIComponent)}`, undefined, options);
	}

	/** Adds any other supported subrequest (sObject collections, describe, ...). */
	request<T = unknown>(subrequest: CompositeRawSubrequest, options?: SubrequestOptions): CompositeRef<T> {
		const path = subrequest.path.split("?")[0].replace(/^\/?(services\/data\/)?v[\d.]+(?=\/)/, "");
		// Salesforce counts query and sObject Collections subrequests (including Tooling queries) against the limit of 5.
		if (/^\/?(tooling\/)?(query|queryAll)(\/|$)|^\/?composite\/sobjects(\/|$)/.test(path)) {
			this._queryCount++;
		}
		return this.add(subrequest.method, subrequest.path, subrequest.body, options);
	}

	/** `ref1`, `ref2`, ...: skips ids already taken by a custom `referenceId`. */
	private nextReferenceId(): string {
		const taken = new Set(this._subrequests.map((subrequest) => subrequest.referenceId));
		for (let index = this._subrequests.length + 1; ; index++) {
			const candidate = `${this._referencePrefix}${index}`;
			if (!taken.has(candidate)) {
				return candidate;
			}
		}
	}

	private add<T>(
		method: CompositeMethod,
		path: string,
		body: unknown,
		options: SubrequestOptions = {},
	): CompositeRef<T> {
		const referenceId = options.referenceId ?? this.nextReferenceId();
		if (!REFERENCE_ID_PATTERN.test(referenceId)) {
			throw new Error(`Invalid composite referenceId "${referenceId}": use letters, digits and underscores.`);
		}
		if (this._subrequests.some((subrequest) => subrequest.referenceId === referenceId)) {
			throw new Error(`Duplicate composite referenceId "${referenceId}".`);
		}
		const url = path.startsWith("/services/")
			? path
			: `/services/data/${this._apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
		const subrequest: CompositeSubrequest = { method, url, referenceId };
		if (body !== undefined) {
			subrequest.body = body;
		}
		if (options.httpHeaders) {
			subrequest.httpHeaders = options.httpHeaders;
		}
		this._subrequests.push(subrequest);
		return {
			referenceId,
			ref: (refPath: string): string => `@{${referenceId}.${refPath}}`,
		};
	}
}

/** The result of a composite request (or of one graph). */
export class CompositeResponse {
	constructor(readonly responses: CompositeSubrequestResult[]) {}

	/** `true` when any subrequest returned a status of 400 or higher. */
	get hasErrors(): boolean {
		return this.responses.some((response) => response.httpStatusCode >= 400);
	}

	/** The raw subrequest result for `ref`. */
	response<T>(ref: CompositeRef<T>): CompositeSubrequestResult<T> {
		const response = this.responses.find((item) => item.referenceId === ref.referenceId);
		if (!response) {
			throw new Error(`No composite response for referenceId "${ref.referenceId}".`);
		}
		return response as CompositeSubrequestResult<T>;
	}

	/** The body of the subrequest for `ref`. Throws `SalesforceError` when that subrequest failed. */
	get<T>(ref: CompositeRef<T>): T {
		const response = this.response(ref);
		if (response.httpStatusCode >= 400) {
			throw new SalesforceError({
				status: response.httpStatusCode,
				method: "POST",
				path: `/composite (${ref.referenceId})`,
				body: response.body,
				headers: response.httpHeaders,
			});
		}
		return response.body as T;
	}
}

export interface CompositeOptions {
	/** Roll back all subrequests when one fails. */
	allOrNone?: boolean;
	/** Let Salesforce group independent subrequests (default `true` on the server). */
	collateSubrequests?: boolean;
	/** Throw a `SalesforceError` for the first failed subrequest. Defaults to `false`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

export interface CompositeGraphInput<R extends object> {
	graphId: string;
	build: (graph: CompositeRequestBuilder<R>) => void;
}

export interface CompositeGraphResult {
	graphId: string;
	isSuccessful: boolean;
	response: CompositeResponse;
}

export interface CompositeBatchRequest {
	method: CompositeMethod;
	/** Relative to the API version, e.g. `"/sobjects/Account/001..."`. */
	path: string;
	/** The request body (`richInput`). */
	body?: unknown;
}

type TreeChildren<R extends object, K extends SObjectName<R>> =
	string extends ChildRelationshipName<R, K>
		? unknown
		: {
				[C in ChildRelationshipName<R, K>]?: { records: TreeChildRecord<R, ChildSObjectName<R, K, C>>[] };
			};

type TreeNodeMeta<R extends object, K extends SObjectName<R>> = {
	attributes: { type: K; referenceId: string };
} & TreeChildren<R, K>;

/** A root record of an sObject tree. */
export type TreeRecord<R extends object, K extends SObjectName<R>> = SObjectCreateInput<R, K> & TreeNodeMeta<R, K>;
/** A child record of an sObject tree; the lookup to the parent is set by Salesforce. */
export type TreeChildRecord<R extends object, K extends SObjectName<R>> = Partial<SObjectCreateInput<R, K>> &
	TreeNodeMeta<R, K>;

/** `/composite`, `/composite/batch`, `/composite/tree` and `/composite/graph`. */
export class CompositeApi<R extends object> {
	constructor(private readonly _connection: SalesforceConnection) {}

	/**
	 * Runs up to 25 subrequests in one call; later subrequests can reference earlier results.
	 *
	 * ```ts
	 * const result = await sf.composite.execute(c => {
	 * 	const account = c.create("Account", { Name: "Acme" });
	 * 	c.create("Contact", { LastName: "Doe", AccountId: account.ref("id") });
	 * 	return { account };
	 * }, { allOrNone: true });
	 * const accountId = result.get(result.refs.account).id;
	 * ```
	 */
	async execute<TRefs = void>(
		build: (composite: CompositeRequestBuilder<R>) => TRefs,
		options: CompositeOptions = {},
	): Promise<CompositeResponse & { refs: TRefs }> {
		const builder = new CompositeRequestBuilder<R>(this._connection.apiVersion);
		const refs = build(builder);
		assertCompositeLimits(builder);
		const body: Record<string, unknown> = { compositeRequest: builder.subrequests };
		if (options.allOrNone !== undefined) {
			body.allOrNone = options.allOrNone;
		}
		if (options.collateSubrequests !== undefined) {
			body.collateSubrequests = options.collateSubrequests;
		}
		const raw = await this._connection.request<{ compositeResponse: CompositeSubrequestResult[] }>({
			method: "POST",
			path: "/composite",
			body,
			signal: options.signal,
		});
		const response = Object.assign(new CompositeResponse(raw.compositeResponse), { refs });
		if (options.throwOnError) {
			throwFirstError(response);
		}
		return response;
	}

	/** `/composite/batch`: up to 25 independent subrequests (each counts against API limits). */
	async batch(
		requests: CompositeBatchRequest[],
		options: { haltOnError?: boolean; signal?: AbortSignal } = {},
	): Promise<CompositeBatchResult> {
		if (requests.length === 0 || requests.length > MAX_SUBREQUESTS) {
			throw new Error(`A composite batch needs 1 to ${MAX_SUBREQUESTS} subrequests, got ${requests.length}.`);
		}
		const version = this._connection.apiVersion;
		const batchRequests = requests.map((request) => ({
			method: request.method,
			url: `${version}${request.path.startsWith("/") ? request.path : `/${request.path}`}`,
			...(request.body === undefined ? {} : { richInput: request.body }),
		}));
		return this._connection.request({
			method: "POST",
			path: "/composite/batch",
			body: { haltOnError: options.haltOnError ?? false, batchRequests },
			signal: options.signal,
		});
	}

	/**
	 * `/composite/tree/{sobject}`: creates up to 200 records with nested children in one
	 * all-or-nothing call. On failure a `SalesforceError` is thrown whose `body` holds the per-record errors.
	 */
	tree<K extends SObjectName<R>>(
		sobject: K,
		records: TreeRecord<R, K>[],
		options: { signal?: AbortSignal } = {},
	): Promise<TreeSaveResult> {
		const total = countTreeRecords(records);
		if (total === 0 || total > MAX_TREE_RECORDS) {
			throw new Error(`An sObject tree needs 1 to ${MAX_TREE_RECORDS} records in total, got ${total}.`);
		}
		return this._connection.request({
			method: "POST",
			path: `/composite/tree/${segment(sobject)}`,
			body: { records },
			signal: options.signal,
		});
	}

	/** `/composite/graph`: several independent all-or-nothing graphs of subrequests in one call. */
	async graph(
		graphs: CompositeGraphInput<R>[],
		options: { signal?: AbortSignal } = {},
	): Promise<CompositeGraphResult[]> {
		if (graphs.length === 0 || graphs.length > MAX_GRAPHS) {
			throw new Error(`A composite graph request needs 1 to ${MAX_GRAPHS} graphs, got ${graphs.length}.`);
		}
		const payload = graphs.map((graph) => {
			const builder = new CompositeRequestBuilder<R>(this._connection.apiVersion);
			graph.build(builder);
			if (builder.subrequests.length === 0) {
				throw new Error(`Graph "${graph.graphId}" has no subrequests.`);
			}
			return { graphId: graph.graphId, compositeRequest: builder.subrequests };
		});
		const nodes = payload.reduce((sum, graph) => sum + graph.compositeRequest.length, 0);
		if (nodes > MAX_GRAPH_NODES) {
			throw new Error(`A composite graph request allows at most ${MAX_GRAPH_NODES} nodes, got ${nodes}.`);
		}
		const raw = await this._connection.request<{
			graphs: {
				graphId: string;
				isSuccessful: boolean;
				graphResponse: { compositeResponse: CompositeSubrequestResult[] };
			}[];
		}>({ method: "POST", path: "/composite/graph", body: { graphs: payload }, signal: options.signal });
		return raw.graphs.map((graph) => ({
			graphId: graph.graphId,
			isSuccessful: graph.isSuccessful,
			response: new CompositeResponse(graph.graphResponse.compositeResponse),
		}));
	}
}

function assertCompositeLimits<R extends object>(builder: CompositeRequestBuilder<R>): void {
	const count = builder.subrequests.length;
	if (count === 0 || count > MAX_SUBREQUESTS) {
		throw new Error(`A composite request needs 1 to ${MAX_SUBREQUESTS} subrequests, got ${count}.`);
	}
	if (builder.queryCount > MAX_QUERY_SUBREQUESTS) {
		throw new Error(
			`A composite request allows at most ${MAX_QUERY_SUBREQUESTS} query/collection subrequests, got ${builder.queryCount}.`,
		);
	}
}

function throwFirstError(response: CompositeResponse): void {
	const failed = response.responses.find((item) => item.httpStatusCode >= 400 && !isProcessingHalted(item.body));
	if (failed) {
		response.get({ referenceId: failed.referenceId, ref: () => "" });
	}
}

function isProcessingHalted(body: unknown): boolean {
	return (
		Array.isArray(body) && body.some((error) => (error as { errorCode?: string }).errorCode === "PROCESSING_HALTED")
	);
}

function countTreeRecords(records: readonly object[]): number {
	let total = 0;
	for (const record of records) {
		total++;
		for (const [key, value] of Object.entries(record)) {
			if (key !== "attributes" && isRecordsWrapper(value)) {
				total += countTreeRecords(value.records);
			}
		}
	}
	return total;
}

function isRecordsWrapper(value: unknown): value is { records: object[] } {
	return typeof value === "object" && value !== null && Array.isArray((value as { records?: unknown }).records);
}
