import { SalesforceError } from "../errors";
import { type RestRequest, type SalesforceConnection, segment } from "../http/connection";
import { buildMultipart, type MultipartPart } from "../http/multipart";
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
import type {
	CompositeBatchResult,
	CompositeBatchSubrequest,
	CompositeBatchSubrequestResult,
	CompositeMethod,
	CompositeSubrequest,
	CompositeSubrequestResult,
	OrgLimits,
	SearchResult,
	TreeSaveResult,
} from "../types/api";
import type {
	ApiVersion,
	DeleteResult,
	GenericRecord,
	SaveResult,
	UpsertResult,
	WithAttributes,
} from "../types/common";

import { collectionBody } from "./collections";
import {
	type BatchRef,
	type CompositeRawSubrequest,
	type CompositeRef,
	SubrequestBuilder,
	type SubrequestOptions,
} from "./subrequests";

export type {
	BatchRef,
	CompositeRawSubrequest,
	CompositeRef,
	SubrequestHandle,
	SubrequestKind,
	SubrequestKinds,
	SubrequestOptionArgs,
	SubrequestOptions,
} from "./subrequests";
export { SubrequestBuilder } from "./subrequests";

const MAX_SUBREQUESTS = 25;
const MAX_QUERY_SUBREQUESTS = 5;
const MAX_GRAPHS = 75;
const MAX_GRAPH_NODES = 500;
const MAX_TREE_RECORDS = 200;
const MAX_COLLECTION_RECORDS = 200;
const MAX_COLLECTION_RETRIEVE_IDS = 2000;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

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

/** Options of a collection subrequest inside `/composite`. */
export interface CompositeCollectionOptions extends SubrequestOptions {
	/** Roll back the whole collection subrequest when one record fails. */
	allOrNone?: boolean;
}

/** Collects subrequests for `/composite` or one graph of `/composite/graph`. */
export class CompositeRequestBuilder<R extends object> extends SubrequestBuilder<R, "composite"> {
	private readonly _subrequests: CompositeSubrequest[] = [];
	private _queryCount = 0;

	constructor(
		private readonly _apiVersion: ApiVersion,
		private readonly _referencePrefix: string = "ref",
	) {
		super();
	}

	/** The subrequests collected so far. */
	get subrequests(): readonly CompositeSubrequest[] {
		return this._subrequests;
	}

	/** Number of query and collection subrequests collected so far (Salesforce allows at most 5 per composite request). */
	get queryCount(): number {
		return this._queryCount;
	}

	/** sObject Collections create: up to 200 records of one sObject. Counts against the limit of 5. */
	createMany<K extends SObjectName<R>>(
		sobject: K,
		records: readonly SObjectCreateInput<R, K>[],
		options: CompositeCollectionOptions = {},
	): CompositeRef<SaveResult[]> {
		assertCollectionSize(records.length, MAX_COLLECTION_RECORDS);
		this._queryCount++;
		return this.add("POST", "/composite/sobjects", collectionBody(sobject, records, options.allOrNone), options);
	}

	/** sObject Collections update: up to 200 records; every record needs its `Id`. */
	updateMany<K extends SObjectName<R>>(
		sobject: K,
		records: readonly (SObjectUpdateInput<R, K> & { Id: string })[],
		options: CompositeCollectionOptions = {},
	): CompositeRef<SaveResult[]> {
		assertCollectionSize(records.length, MAX_COLLECTION_RECORDS);
		this._queryCount++;
		return this.add("PATCH", "/composite/sobjects", collectionBody(sobject, records, options.allOrNone), options);
	}

	/** sObject Collections upsert by external id: up to 200 records of one sObject. */
	upsertMany<K extends SObjectName<R>, F extends ExternalIdField<R, K>>(
		sobject: K,
		externalIdField: F,
		records: readonly SObjectCreateInput<R, K>[],
		options: CompositeCollectionOptions = {},
	): CompositeRef<UpsertResult[]> {
		assertCollectionSize(records.length, MAX_COLLECTION_RECORDS);
		this._queryCount++;
		return this.add(
			"PATCH",
			`/composite/sobjects/${segment(sobject)}/${segment(externalIdField)}`,
			collectionBody(sobject, records, options.allOrNone),
			options,
		);
	}

	/** sObject Collections delete: up to 200 ids, which may be references such as `account.ref("id")`. */
	deleteMany(ids: readonly string[], options: CompositeCollectionOptions = {}): CompositeRef<DeleteResult[]> {
		assertCollectionSize(ids.length, MAX_COLLECTION_RECORDS);
		this._queryCount++;
		const list = ids.map((id) => keepReferences(id, encodeURIComponent)).join(",");
		const allOrNone = options.allOrNone === undefined ? "" : `&allOrNone=${options.allOrNone}`;
		return this.add("DELETE", `/composite/sobjects?ids=${list}${allOrNone}`, undefined, options);
	}

	/** sObject Collections retrieve: up to 2000 records of one sObject. Inaccessible or unknown ids yield `null`. */
	retrieveMany<K extends SObjectName<R>, F extends SObjectFieldName<R, K>>(
		sobject: K,
		ids: readonly string[],
		fields: readonly F[],
		options?: SubrequestOptions,
	): CompositeRef<(WithAttributes<Pick<SObjectRecord<R, K>, F>> | null)[]> {
		assertCollectionSize(ids.length, MAX_COLLECTION_RETRIEVE_IDS);
		if (fields.length === 0) {
			throw new Error("retrieveMany() requires at least one field.");
		}
		this._queryCount++;
		return this.add("POST", `/composite/sobjects/${segment(sobject)}`, { ids, fields }, options);
	}

	/** Adds any other supported subrequest (describe layouts, Tooling queries, ...). */
	override request<T = unknown>(subrequest: CompositeRawSubrequest, options?: SubrequestOptions): CompositeRef<T> {
		const path = subrequest.path.split("?")[0].replace(/^\/?(services\/data\/)?v[\d.]+(?=\/)/, "");
		// Salesforce counts query and sObject Collections subrequests (including Tooling queries) against the limit of 5.
		if (/^\/?(tooling\/)?(query|queryAll)(\/|$)|^\/?composite\/sobjects(\/|$)/.test(path)) {
			this._queryCount++;
		}
		return super.request<T>(subrequest, options);
	}

	protected override countQuery(): void {
		this._queryCount++;
	}

	protected override encode(value: string, encode: (part: string) => string): string {
		return keepReferences(value, encode);
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

	protected add<T>(
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

/** A file sent as a binary part of a multipart composite batch request. */
export interface BatchBinaryPart {
	/**
	 * The name the resource expects for the binary part (`binaryPartNameAlias`): the blob field
	 * for sObjects (e.g. `VersionData`, `Body`), or e.g. `fileData` for Connect file uploads.
	 */
	alias: string;
	fileName: string;
	/** Defaults to `application/octet-stream`. */
	contentType?: string;
	/** The file content. Strings are encoded as UTF-8. */
	data: Uint8Array | string;
}

/** A blob field value for `createWithBlob` and `updateWithBlob`. */
export interface BatchBlob<F extends string = string> extends Omit<BatchBinaryPart, "alias"> {
	/** The blob field, e.g. `VersionData` on ContentVersion or `Body` on Attachment and Document. */
	field: F;
}

export interface CompositeBatchRawSubrequest extends CompositeRawSubrequest {
	/** Sends the batch as multipart with this file as the subrequest's binary part. */
	binary?: BatchBinaryPart;
}

/**
 * Collects the independent subrequests of `/composite/batch`. Unlike `/composite`, results can't
 * be referenced by later subrequests, and SOSL search and `/limits` are supported.
 */
export class CompositeBatchBuilder<R extends object> extends SubrequestBuilder<R, "batch"> {
	private readonly _subrequests: CompositeBatchSubrequest[] = [];
	private readonly _binaryParts: MultipartPart[] = [];

	constructor(private readonly _apiVersion: ApiVersion) {
		super();
	}

	/** The subrequests collected so far. */
	get subrequests(): readonly CompositeBatchSubrequest[] {
		return this._subrequests;
	}

	/** The binary parts collected so far. When there are any, the batch is sent as multipart. */
	get binaryParts(): readonly MultipartPart[] {
		return this._binaryParts;
	}

	/** `GET /limits`. */
	limits(): BatchRef<OrgLimits> {
		return this.add("GET", "/limits", undefined);
	}

	/** Runs a SOSL search. Escape user input in the `FIND {...}` term with `soslEscape`. */
	search<T = GenericRecord>(sosl: string): BatchRef<SearchResult<T>> {
		if (typeof sosl !== "string" || sosl.trim().length === 0) {
			throw new Error("search() requires a non-blank SOSL string.");
		}
		return this.add("GET", `/search?q=${encodeURIComponent(sosl)}`, undefined);
	}

	/** Creates a record with a blob field (e.g. a ContentVersion with `VersionData`), sent as a binary part. */
	createWithBlob<K extends SObjectName<R>>(
		sobject: K,
		record: SObjectCreateInput<R, K>,
		blob: BatchBlob<SObjectFieldName<R, K>>,
	): BatchRef<SaveResult> {
		return this.request<SaveResult>({
			method: "POST",
			path: `/sobjects/${segment(sobject)}`,
			body: record,
			binary: toBinaryPart(blob),
		});
	}

	/** Updates a record and replaces a blob field, sent as a binary part. */
	updateWithBlob<K extends SObjectName<R>>(
		sobject: K,
		id: string,
		record: SObjectUpdateInput<R, K>,
		blob: BatchBlob<SObjectFieldName<R, K>>,
	): BatchRef<null> {
		return this.request<null>({
			method: "PATCH",
			path: this.recordPath(sobject, id),
			body: record,
			binary: toBinaryPart(blob),
		});
	}

	/** Adds any other supported subrequest (Connect, Chatter, ...), optionally with a binary part. */
	override request<T = unknown>(subrequest: CompositeBatchRawSubrequest): BatchRef<T> {
		const ref = this.add<T>(subrequest.method, subrequest.path, subrequest.body);
		if (subrequest.binary) {
			const name = `binaryPart${this._binaryParts.length + 1}`;
			const request = this._subrequests[ref.index];
			request.binaryPartName = name;
			request.binaryPartNameAlias = subrequest.binary.alias;
			this._binaryParts.push({
				name,
				filename: subrequest.binary.fileName,
				contentType: subrequest.binary.contentType ?? "application/octet-stream",
				data: subrequest.binary.data,
			});
		}
		return ref;
	}

	protected override encode(value: string, encode: (part: string) => string): string {
		return encode(value);
	}

	protected add<T>(method: CompositeMethod, path: string, body: unknown): BatchRef<T> {
		const relative = path.replace(/^\/+/, "").replace(/^services\/data\/v\d+\.\d+\//, "");
		const subrequest: CompositeBatchSubrequest = { method, url: `${this._apiVersion}/${relative}` };
		if (body !== undefined) {
			subrequest.richInput = body;
		}
		this._subrequests.push(subrequest);
		return { index: this._subrequests.length - 1 };
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

/** The result of a composite batch request. */
export class CompositeBatchResponse {
	constructor(
		readonly results: CompositeBatchSubrequestResult[],
		/** `true` when any subrequest failed. */
		readonly hasErrors: boolean,
	) {}

	/** The raw subrequest result for `ref`. */
	result<T>(ref: BatchRef<T>): CompositeBatchSubrequestResult<T> {
		const result = this.results[ref.index];
		if (!result) {
			throw new Error(`No composite batch result at index ${ref.index}.`);
		}
		return result as CompositeBatchSubrequestResult<T>;
	}

	/** The result of the subrequest for `ref`. Throws `SalesforceError` when that subrequest failed. */
	get<T>(ref: BatchRef<T>): T {
		const result = this.result(ref);
		if (result.statusCode >= 400) {
			throw new SalesforceError({
				status: result.statusCode,
				method: "POST",
				path: `/composite/batch (#${ref.index})`,
				body: result.result,
				headers: {},
			});
		}
		return result.result as T;
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

export interface CompositeBatchOptions {
	/** Skip the remaining subrequests once one fails. Defaults to `false`. */
	haltOnError?: boolean;
	/** Throw a `SalesforceError` for the first failed subrequest. Defaults to `false`. */
	throwOnError?: boolean;
	/**
	 * Timeout for this call in milliseconds; `0` disables it. Defaults to the client timeout, or no
	 * timeout when the batch uploads files. Salesforce itself stops a batch after 10 minutes.
	 */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface CompositeGraphInput<R extends object, TRefs = void> {
	graphId: string;
	/** Adds the graph's subrequests. Return handles (e.g. `{ account }`) to read their results from `response.refs`. */
	build: (graph: CompositeRequestBuilder<R>) => TRefs;
}

export interface CompositeGraphResult<TRefs = unknown> {
	graphId: string;
	isSuccessful: boolean;
	response: CompositeResponse & { refs: TRefs };
}

/** The refs type a graph input's `build` returns. */
export type CompositeGraphRefs<G> = G extends { build: (graph: never) => infer TRefs } ? TRefs : unknown;

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

	/**
	 * `/composite/batch`: up to 25 independent subrequests in one call (each counts against API limits).
	 * Subrequests run in order and each commits on its own: a failure doesn't roll back earlier ones.
	 * Salesforce stops a batch after 10 minutes; pass `timeoutMs` for batches that take longer than the client timeout.
	 *
	 * ```ts
	 * const result = await sf.composite.batch(b => ({
	 * 	account: b.get("Account", accountId, ["Name"]),
	 * 	contacts: b.query(sf.soql("Contact").select("Id", "LastName").limit(10)),
	 * 	limits: b.limits(),
	 * }));
	 * const name = result.get(result.refs.account).Name;
	 * ```
	 *
	 * The array form sends untyped subrequests and returns the raw response.
	 */
	batch<TRefs = void>(
		build: (batch: CompositeBatchBuilder<R>) => TRefs,
		options?: CompositeBatchOptions,
	): Promise<CompositeBatchResponse & { refs: TRefs }>;
	batch(
		requests: CompositeBatchRequest[],
		options?: Pick<CompositeBatchOptions, "haltOnError" | "timeoutMs" | "signal">,
	): Promise<CompositeBatchResult>;
	async batch(
		input: ((batch: CompositeBatchBuilder<R>) => unknown) | CompositeBatchRequest[],
		options: CompositeBatchOptions = {},
	): Promise<unknown> {
		const builder = new CompositeBatchBuilder<R>(this._connection.apiVersion);
		const refs = typeof input === "function" ? input(builder) : addRawBatchRequests(builder, input);
		const count = builder.subrequests.length;
		if (count === 0 || count > MAX_SUBREQUESTS) {
			throw new Error(`A composite batch needs 1 to ${MAX_SUBREQUESTS} subrequests, got ${count}.`);
		}
		const json = { haltOnError: options.haltOnError ?? false, batchRequests: builder.subrequests };
		const raw = await this._connection.request<CompositeBatchResult>(
			builder.binaryParts.length === 0
				? { method: "POST", path: "/composite/batch", body: json, signal: options.signal, timeoutMs: options.timeoutMs }
				: multipartBatch(json, builder.binaryParts, options),
		);
		if (typeof input !== "function") {
			return raw;
		}
		const response = Object.assign(new CompositeBatchResponse(raw.results, raw.hasErrors), { refs });
		if (options.throwOnError) {
			throwFirstBatchError(response);
		}
		return response;
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

	/**
	 * `/composite/graph`: several independent all-or-nothing graphs of subrequests in one call.
	 * Results come back in the order of `graphs`, each with the refs its `build` returned.
	 */
	async graph<const G extends readonly CompositeGraphInput<R, unknown>[]>(
		graphs: G,
		options: { signal?: AbortSignal } = {},
	): Promise<{ -readonly [I in keyof G]: CompositeGraphResult<CompositeGraphRefs<G[I]>> }> {
		if (graphs.length === 0 || graphs.length > MAX_GRAPHS) {
			throw new Error(`A composite graph request needs 1 to ${MAX_GRAPHS} graphs, got ${graphs.length}.`);
		}
		const seen = new Set<string>();
		const built = graphs.map((graph) => {
			if (seen.has(graph.graphId)) {
				throw new Error(`Duplicate graphId "${graph.graphId}".`);
			}
			seen.add(graph.graphId);
			const builder = new CompositeRequestBuilder<R>(this._connection.apiVersion);
			const refs = graph.build(builder);
			if (builder.subrequests.length === 0) {
				throw new Error(`Graph "${graph.graphId}" has no subrequests.`);
			}
			return { graphId: graph.graphId, compositeRequest: builder.subrequests, refs };
		});
		const nodes = built.reduce((sum, graph) => sum + graph.compositeRequest.length, 0);
		if (nodes > MAX_GRAPH_NODES) {
			throw new Error(`A composite graph request allows at most ${MAX_GRAPH_NODES} nodes, got ${nodes}.`);
		}
		const raw = await this._connection.request<{
			graphs: {
				graphId: string;
				isSuccessful: boolean;
				graphResponse: { compositeResponse: CompositeSubrequestResult[] };
			}[];
		}>({
			method: "POST",
			path: "/composite/graph",
			body: { graphs: built.map(({ graphId, compositeRequest }) => ({ graphId, compositeRequest })) },
			signal: options.signal,
		});
		const results = built.map(({ graphId, refs }): CompositeGraphResult<unknown> => {
			const graph = raw.graphs.find((item) => item.graphId === graphId);
			if (!graph) {
				throw new Error(`No composite graph response for graphId "${graphId}".`);
			}
			return {
				graphId,
				isSuccessful: graph.isSuccessful,
				response: Object.assign(new CompositeResponse(graph.graphResponse.compositeResponse), { refs }),
			};
		});
		return results as { -readonly [I in keyof G]: CompositeGraphResult<CompositeGraphRefs<G[I]>> };
	}
}

function addRawBatchRequests<R extends object>(
	builder: CompositeBatchBuilder<R>,
	requests: readonly CompositeBatchRequest[],
): undefined {
	for (const request of requests) {
		builder.request({ method: request.method, path: request.path, body: request.body });
	}
	return undefined;
}

/** The multipart form of a batch: the JSON request first, then one part per file. */
function multipartBatch(
	json: object,
	binaryParts: readonly MultipartPart[],
	options: Pick<CompositeBatchOptions, "timeoutMs" | "signal">,
): RestRequest {
	const { body, contentType } = buildMultipart([
		{ name: "json", contentType: "application/json", data: JSON.stringify(json) },
		...binaryParts,
	]);
	return {
		method: "POST",
		path: "/composite/batch",
		body,
		headers: { "Content-Type": contentType },
		signal: options.signal,
		// Uploads can take long, so files disable the client timeout unless one is passed.
		timeoutMs: options.timeoutMs ?? 0,
	};
}

function toBinaryPart(blob: BatchBlob): BatchBinaryPart {
	return { alias: blob.field, fileName: blob.fileName, contentType: blob.contentType, data: blob.data };
}

function assertCollectionSize(count: number, max: number): void {
	if (count === 0 || count > max) {
		throw new Error(`An sObject collection subrequest needs 1 to ${max} items, got ${count}.`);
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

function throwFirstBatchError(response: CompositeBatchResponse): void {
	const index = response.results.findIndex((item) => item.statusCode >= 400 && !isProcessingHalted(item.result));
	if (index >= 0) {
		response.get({ index });
	}
}

/** Subrequests skipped because an earlier one failed (`allOrNone` or `haltOnError`). */
function isProcessingHalted(body: unknown): boolean {
	return (
		Array.isArray(body) &&
		body.some((error) => {
			const code = (error as { errorCode?: string }).errorCode;
			return code === "PROCESSING_HALTED" || code === "BATCH_PROCESSING_HALTED";
		})
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
