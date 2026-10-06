import { assertApiVersion } from "../api-version";
import type { AccessToken, AuthProvider } from "../auth/types";
import { SalesforceError } from "../errors";
import { formatNumber } from "../soql/escape";
import type { ApiVersion, RestError } from "../types/common";
import type { SalesforceErrorCode } from "../types/error-codes";

import type { HttpMethod, HttpTransport, StreamingTransportResponse, TransportResponse } from "./transport";

const DEFAULT_TIMEOUT_MS = 120_000;
const decoder = new TextDecoder();

export type QueryParamValue =
	| string
	| number
	| boolean
	| Date
	| null
	| undefined
	| readonly (string | number | boolean)[];

export type ResponseType = "auto" | "json" | "text" | "binary";

export interface RestRequest {
	/** Defaults to `GET`. */
	method?: HttpMethod;
	/**
	 * - `"/limits"` or `"limits"`: relative to `/services/data/{apiVersion}`.
	 * - `"/services/apexrest/..."`: any path under `/services/` is used as-is on the instance.
	 * - `"https://..."`: absolute URLs must be on the instance origin or in `allowedOrigins`.
	 */
	path: string;
	/** Query string parameters. Arrays are joined with commas; `undefined`/`null` are skipped. */
	query?: Record<string, QueryParamValue>;
	/** Objects are sent as JSON. Strings, `Uint8Array` and `URLSearchParams` are sent as-is. */
	body?: unknown;
	headers?: Record<string, string>;
	/** How to read the response body. `auto` (default) goes by `Content-Type`. */
	responseType?: ResponseType;
	signal?: AbortSignal;
	/** Overrides the client timeout for this request. */
	timeoutMs?: number;
	/** Allow retries (see `RetryOptions`) for this request even when the method is not idempotent. */
	retry?: boolean;
}

export interface RestResponse<T> {
	status: number;
	headers: Headers;
	data: T;
}

export interface RetryOptions {
	/** How many times to retry. Defaults to 2. */
	retries?: number;
	/** Statuses that trigger a retry. Defaults to 429, 502, 503 and 504. */
	statusCodes?: number[];
	/** Methods that are retried automatically. Defaults to `GET` and `HEAD`; others need `retry: true` per request. */
	methods?: HttpMethod[];
	/** Backoff base delay. Defaults to 500 ms. `Retry-After` takes precedence. */
	baseDelayMs?: number;
	/** Maximum delay between attempts. Defaults to 30 s. */
	maxDelayMs?: number;
	/**
	 * Salesforce error codes that trigger a retry for **any** method, e.g. `["UNABLE_TO_LOCK_ROW"]`.
	 * Salesforce rolls the failed request back, so retrying is safe even for mutations.
	 */
	errorCodes?: SalesforceErrorCode[];
}

export interface RequestEvent {
	method: HttpMethod;
	url: string;
	/** Request headers with `Authorization` redacted. */
	headers: Record<string, string>;
	/** The body as sent: JSON or form text, or bytes for binary uploads. `undefined` without a body. */
	body?: string | Uint8Array;
	attempt: number;
}

export interface ResponseEvent extends RequestEvent {
	status: number;
	durationMs: number;
	/** Response headers without `set-cookie`. */
	responseHeaders: Record<string, string>;
	/**
	 * The response body: text for JSON, XML, CSV and `text/*`, bytes otherwise. `undefined` when
	 * empty, and for successful streamed responses (Bulk API query results), which aren't read yet.
	 */
	responseBody?: string | Uint8Array;
}

/**
 * Observability hooks, e.g. for logging requests and responses in test reports. Tokens are never
 * passed to hooks. A hook may return a promise; it is not awaited, and a rejection is ignored.
 */
export interface RequestHooks {
	onRequest?(event: RequestEvent): void | Promise<void>;
	onResponse?(event: ResponseEvent): void | Promise<void>;
}

export interface ApiUsage {
	used: number;
	max: number;
}

export interface ConnectionOptions {
	auth: AuthProvider;
	transport: HttpTransport;
	/** The REST API version, e.g. `"v66.0"`. Required. */
	apiVersion: ApiVersion;
	/** Per-request timeout in milliseconds. Defaults to 120 000. Use `0` to disable. */
	timeoutMs?: number;
	/** Opt-in retries on 429/5xx for idempotent requests. Disabled by default. */
	retry?: RetryOptions | boolean;
	/** Extra origins (besides the instance URL) that absolute URLs may point to. */
	allowedOrigins?: string[];
	/** Headers sent with every request, e.g. `{ "Sforce-Call-Options": "client=my-app" }`. */
	headers?: Record<string, string>;
	hooks?: RequestHooks;
}

type StartedEvent = RequestEvent & { started: number };

interface ResolvedRetry {
	retries: number;
	statusCodes: number[];
	errorCodes: string[];
	methods: HttpMethod[];
	baseDelayMs: number;
	maxDelayMs: number;
}

/** Low-level request executor: auth, URL resolution, encoding, timeouts, retries and errors. */
export class SalesforceConnection {
	readonly apiVersion: ApiVersion;
	private readonly _auth: AuthProvider;
	private readonly _transport: HttpTransport;
	private readonly _timeoutMs: number;
	private readonly _retry: ResolvedRetry | undefined;
	private readonly _allowedOrigins: Set<string>;
	private readonly _headers: Record<string, string>;
	private readonly _hooks: RequestHooks;
	private _apiUsage: ApiUsage | undefined;

	constructor(options: ConnectionOptions) {
		assertApiVersion(
			options.apiVersion,
			"SalesforceClient",
			"Pass it as { apiVersion }, e.g. the API_VERSION constant exported by your generated sObject types.",
		);
		this.apiVersion = options.apiVersion;
		this._auth = options.auth;
		this._transport = options.transport;
		this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this._retry = resolveRetry(options.retry);
		this._allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => new URL(origin).origin));
		this._headers = options.headers ?? {};
		this._hooks = options.hooks ?? {};
	}

	/** API usage as reported by the last response's `Sforce-Limit-Info` header. */
	get apiUsage(): ApiUsage | undefined {
		return this._apiUsage;
	}

	get transport(): HttpTransport {
		return this._transport;
	}

	/** Returns the instance URL of the current token (authenticating if needed). */
	async instanceUrl(signal?: AbortSignal): Promise<string> {
		const token = await this._auth.getToken({ transport: this._transport, signal });
		return new URL(token.instanceUrl).origin;
	}

	/** Sends a request and returns the parsed body. Throws `SalesforceError` for non-2xx responses. */
	async request<T>(request: RestRequest): Promise<T> {
		const response = await this.send<T>(request);
		return response.data;
	}

	/** Sends a request and returns status, headers and the parsed body. */
	async send<T>(request: RestRequest): Promise<RestResponse<T>> {
		const method = request.method ?? "GET";
		const timeoutMs = request.timeoutMs ?? this._timeoutMs;
		let token = await this.getToken(request.signal, timeoutMs);
		let reauthenticated = false;
		let retries = 0;

		for (let attempt = 1; ; attempt++) {
			let response: TransportResponse;
			try {
				response = await this.sendOnce(request, method, token, attempt, timeoutMs);
			} catch (error) {
				if (this.canRetryFailure(method, request, retries)) {
					retries++;
					await sleep(this.retryDelay(undefined, retries), request.signal);
					continue;
				}
				throw error;
			}

			if (response.status === 401 && !reauthenticated && this._auth.invalidate) {
				reauthenticated = true;
				const next = await this.reauthenticate(token, request.signal, timeoutMs);
				if (next.accessToken !== token.accessToken) {
					token = next;
					continue;
				}
			}
			if (this.shouldRetry(method, request, response, retries)) {
				retries++;
				await sleep(this.retryDelay(response, retries), request.signal);
				continue;
			}
			return this.toResult<T>(request, method, response);
		}
	}

	/** Gets a token, bounded by the caller's signal and the request timeout. */
	private getToken(signal: AbortSignal | undefined, timeoutMs: number): Promise<AccessToken> {
		return this._auth.getToken({ transport: this._transport, signal: combineSignals(signal, timeoutMs) });
	}

	private reauthenticate(token: AccessToken, signal: AbortSignal | undefined, timeoutMs: number): Promise<AccessToken> {
		this._auth.invalidate?.(token);
		return this.getToken(signal, timeoutMs);
	}

	/** Resolves a request path against the instance URL, enforcing the origin allowlist. */
	resolveUrl(path: string, instanceUrl: string, query?: Record<string, QueryParamValue>): URL {
		const base = new URL(instanceUrl);
		let url: URL;
		if (/^https?:\/\//i.test(path)) {
			url = new URL(path);
		} else if (path.startsWith("/services/")) {
			url = new URL(path, base.origin);
		} else {
			url = new URL(`/services/data/${this.apiVersion}${path.startsWith("/") ? path : `/${path}`}`, base.origin);
		}
		if (url.origin !== base.origin && !this._allowedOrigins.has(url.origin)) {
			throw new Error(
				`Refusing to send a Salesforce request to ${url.origin}: only the instance origin ${base.origin} and allowedOrigins are permitted.`,
			);
		}
		appendQuery(url, query);
		return url;
	}

	private async sendOnce(
		request: RestRequest,
		method: HttpMethod,
		token: AccessToken,
		attempt: number,
		timeoutMs: number,
	): Promise<TransportResponse> {
		const signal = combineSignals(request.signal, timeoutMs);
		const prepared = this.prepare(request, method, token, attempt, signal, timeoutMs);
		const response = await this._transport.send(prepared.transportRequest);
		this.afterResponse(prepared.event, response);
		return response;
	}

	private prepare(
		request: RestRequest,
		method: HttpMethod,
		token: AccessToken,
		attempt: number,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): { transportRequest: Parameters<HttpTransport["send"]>[0]; event: StartedEvent } {
		const url = this.resolveUrl(request.path, token.instanceUrl, request.query);
		const { headers, body } = encodeRequest(request, this._headers);
		headers.set("Authorization", `Bearer ${token.accessToken}`);

		signal?.throwIfAborted();
		const event: RequestEvent = { method, url: url.toString(), headers: redactHeaders(headers), body, attempt };
		callHook(() => this._hooks.onRequest?.(event));
		return {
			transportRequest: { method, url, headers, body, signal, timeoutMs: timeoutMs > 0 ? timeoutMs : undefined },
			event: { ...event, started: Date.now() },
		};
	}

	/** `body` is left out for a streamed response that hasn't been read yet. */
	private afterResponse(event: StartedEvent, response: { status: number; headers: Headers; body?: Uint8Array }): void {
		this.trackApiUsage(response.headers);
		const { started, ...requestEvent } = event;
		callHook(() =>
			this._hooks.onResponse?.({
				...requestEvent,
				status: response.status,
				durationMs: Date.now() - started,
				responseHeaders: headersToObject(response.headers),
				responseBody: response.body && eventBody(response.body, response.headers),
			}),
		);
	}

	private toResult<T>(request: RestRequest, method: HttpMethod, response: TransportResponse): RestResponse<T> {
		if (response.status < 200 || response.status >= 300) {
			throw this.errorFor(request, method, response);
		}
		const data = parseBody(response, request.responseType ?? "auto", true);
		return { status: response.status, headers: response.headers, data: data as T };
	}

	private errorFor(request: RestRequest, method: HttpMethod, response: TransportResponse): SalesforceError {
		return new SalesforceError({
			status: response.status,
			method,
			path: stripQuery(request.path),
			body: parseBody(response, "auto"),
			headers: headersToObject(response.headers),
		});
	}

	/**
	 * Sends a GET request and returns the body as a stream of chunks, when the transport supports
	 * streaming (`fetchTransport` does). Returns `undefined` otherwise, so callers can fall back to
	 * `send`. Non-2xx responses throw `SalesforceError`; the request is re-authenticated once on 401.
	 */
	async stream(request: RestRequest): Promise<StreamingTransportResponse | undefined> {
		const stream = this._transport.stream?.bind(this._transport);
		if (!stream) {
			return undefined;
		}
		const method = request.method ?? "GET";
		const timeoutMs = request.timeoutMs ?? this._timeoutMs;
		let token = await this.getToken(request.signal, timeoutMs);
		let reauthenticated = false;
		let retries = 0;
		for (let attempt = 1; ; attempt++) {
			const { event, response } = await this.openStream(stream, request, method, token, attempt, timeoutMs);
			if (response.status >= 200 && response.status < 300) {
				this.afterResponse(event, { status: response.status, headers: response.headers });
				return response;
			}
			const buffered = { status: response.status, headers: response.headers, body: await collect(response.body) };
			this.afterResponse(event, buffered);
			if (response.status === 401 && !reauthenticated && this._auth.invalidate) {
				reauthenticated = true;
				const next = await this.reauthenticate(token, request.signal, timeoutMs);
				if (next.accessToken !== token.accessToken) {
					token = next;
					continue;
				}
			}
			if (this.shouldRetry(method, request, buffered, retries)) {
				retries++;
				await sleep(this.retryDelay(buffered, retries), request.signal);
				continue;
			}
			throw this.errorFor(request, method, buffered);
		}
	}

	/**
	 * Opens a streamed response. The timeout only covers waiting for the response headers, so a
	 * consumer that reads a large body slowly is not cut off.
	 */
	private async openStream(
		stream: NonNullable<HttpTransport["stream"]>,
		request: RestRequest,
		method: HttpMethod,
		token: AccessToken,
		attempt: number,
		timeoutMs: number,
	): Promise<{ event: StartedEvent; response: StreamingTransportResponse }> {
		const headerTimeout = new AbortController();
		const timer =
			timeoutMs > 0
				? setTimeout(
						() => headerTimeout.abort(new DOMException(`The request timed out after ${timeoutMs} ms.`, "TimeoutError")),
						timeoutMs,
					)
				: undefined;
		const signal = request.signal ? AbortSignal.any([request.signal, headerTimeout.signal]) : headerTimeout.signal;
		try {
			const prepared = this.prepare(request, method, token, attempt, signal, 0);
			return { event: prepared.event, response: await stream(prepared.transportRequest) };
		} finally {
			clearTimeout(timer);
		}
	}

	private shouldRetry(method: HttpMethod, request: RestRequest, response: TransportResponse, retries: number): boolean {
		const retry = this._retry;
		if (!retry || retries >= retry.retries || request.retry === false) {
			return false;
		}
		if (retry.statusCodes.includes(response.status) && (request.retry === true || retry.methods.includes(method))) {
			return true;
		}
		return retry.errorCodes.length > 0 && response.status >= 400 && hasErrorCodeIn(response, retry.errorCodes);
	}

	/**
	 * Network failures and per-attempt timeouts (the transport threw) are retried for idempotent
	 * requests when retries are enabled; a caller abort never is.
	 */
	private canRetryFailure(method: HttpMethod, request: RestRequest, retries: number): boolean {
		const retry = this._retry;
		if (!retry || retries >= retry.retries || request.retry === false || request.signal?.aborted) {
			return false;
		}
		return request.retry === true || retry.methods.includes(method);
	}

	private retryDelay(response: TransportResponse | undefined, retries: number): number {
		const retry = this._retry as ResolvedRetry;
		const retryAfter = parseRetryAfter(response?.headers.get("retry-after") ?? null);
		const backoff = retry.baseDelayMs * 2 ** (retries - 1);
		return Math.min(retryAfter ?? backoff, retry.maxDelayMs);
	}

	private trackApiUsage(headers: Headers): void {
		const match = /(?:^|[\s,;])api-usage=(\d+)\/(\d+)/.exec(headers.get("sforce-limit-info") ?? "");
		if (match) {
			this._apiUsage = { used: Number(match[1]), max: Number(match[2]) };
		}
	}
}

function hasErrorCodeIn(response: TransportResponse, codes: readonly string[]): boolean {
	const body = parseBody(response, "auto");
	return Array.isArray(body) && body.some((error: RestError) => codes.includes(error.errorCode));
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of chunks) {
		parts.push(chunk);
		length += chunk.byteLength;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function resolveRetry(retry: RetryOptions | boolean | undefined): ResolvedRetry | undefined {
	if (!retry) {
		return undefined;
	}
	const options = retry === true ? {} : retry;
	return {
		retries: options.retries ?? 2,
		statusCodes: options.statusCodes ?? [429, 502, 503, 504],
		errorCodes: options.errorCodes ?? [],
		methods: options.methods ?? ["GET", "HEAD"],
		baseDelayMs: options.baseDelayMs ?? 500,
		maxDelayMs: options.maxDelayMs ?? 30_000,
	};
}

function appendQuery(url: URL, query: Record<string, QueryParamValue> | undefined): void {
	if (!query) {
		return;
	}
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (value instanceof Date) {
			url.searchParams.append(key, value.toISOString());
		} else if (Array.isArray(value)) {
			url.searchParams.append(key, value.join(","));
		} else {
			url.searchParams.append(key, String(value));
		}
	}
}

function encodeRequest(
	request: RestRequest,
	defaultHeaders: Record<string, string>,
): { headers: Headers; body: string | Uint8Array | undefined } {
	const headers = new Headers(defaultHeaders);
	for (const [key, value] of Object.entries(request.headers ?? {})) {
		headers.set(key, value);
	}
	const responseType = request.responseType ?? "auto";
	if (!headers.has("Accept")) {
		headers.set("Accept", responseType === "auto" || responseType === "json" ? "application/json" : "*/*");
	}

	const { body } = request;
	if (body === undefined || body === null) {
		return { headers, body: undefined };
	}
	if (typeof body === "string") {
		setDefault(headers, "Content-Type", "text/plain; charset=utf-8");
		return { headers, body };
	}
	const bytes = toBytes(body);
	if (bytes) {
		setDefault(headers, "Content-Type", "application/octet-stream");
		return { headers, body: bytes };
	}
	if (body instanceof URLSearchParams) {
		setDefault(headers, "Content-Type", "application/x-www-form-urlencoded");
		return { headers, body: body.toString() };
	}
	assertSerializable(body);
	setDefault(headers, "Content-Type", "application/json");
	return { headers, body: JSON.stringify(body) };
}

/** Binary bodies: `Uint8Array` (incl. `Buffer`), other typed arrays, `DataView` and `ArrayBuffer`. */
function toBytes(body: unknown): Uint8Array | undefined {
	if (body instanceof Uint8Array) {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	return undefined;
}

/** Rejects bodies that `JSON.stringify` would silently turn into `{}`. */
function assertSerializable(body: unknown): void {
	const unsupported =
		(typeof Blob !== "undefined" && body instanceof Blob) ||
		(typeof FormData !== "undefined" && body instanceof FormData) ||
		(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
	if (unsupported) {
		throw new TypeError(
			"Unsupported request body: Blob, FormData and streams can't be sent. Pass a Uint8Array (see buildMultipart for multipart).",
		);
	}
}

/**
 * Runs an observability hook; a throwing hook must never change the outcome of a request. A
 * returned promise is not awaited, and its rejection is swallowed so it can't go unhandled.
 */
function callHook(hook: () => void | Promise<void>): void {
	try {
		const result = hook();
		if (result && typeof result.catch === "function") {
			result.catch(() => undefined);
		}
	} catch {
		// Ignored on purpose: the request already happened.
	}
}

function setDefault(headers: Headers, name: string, value: string): void {
	if (!headers.has(name)) {
		headers.set(name, value);
	}
}

/**
 * Parses a response body according to `responseType` and the `Content-Type` header. With
 * `strict`, a body that should be JSON but isn't throws instead of being returned as text.
 */
export function parseBody(response: TransportResponse, responseType: ResponseType, strict: boolean = false): unknown {
	if (responseType === "binary") {
		return response.body;
	}
	if (response.body.byteLength === 0) {
		return responseType === "text" ? "" : undefined;
	}
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	if (responseType === "auto" && !isTextContentType(contentType)) {
		return response.body;
	}
	const text = decoder.decode(response.body);
	if (responseType === "text") {
		return text;
	}
	if (responseType === "json" || contentType.includes("json")) {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			if (strict) {
				throw new Error(
					`Salesforce returned invalid JSON (status ${response.status}, content-type "${contentType}"): ${text.slice(0, 200)}`,
				);
			}
			return text;
		}
	}
	return text;
}

/** A response body for hooks: decoded text for text content types, bytes otherwise. */
function eventBody(body: Uint8Array, headers: Headers): string | Uint8Array | undefined {
	if (body.byteLength === 0) {
		return undefined;
	}
	return isTextContentType((headers.get("content-type") ?? "").toLowerCase()) ? decoder.decode(body) : body;
}

function isTextContentType(contentType: string): boolean {
	return (
		contentType === "" ||
		contentType.includes("json") ||
		contentType.startsWith("text/") ||
		contentType.includes("xml") ||
		contentType.includes("csv")
	);
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
	if (timeoutMs <= 0) {
		return signal;
	}
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function redactHeaders(headers: Headers): Record<string, string> {
	const result = headersToObject(headers);
	if (result.authorization) {
		result.authorization = "Bearer [REDACTED]";
	}
	return result;
}

/** Converts headers to a plain object with lowercase names, dropping `set-cookie`. */
export function headersToObject(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (key.toLowerCase() !== "set-cookie") {
			result[key.toLowerCase()] = value;
		}
	});
	return result;
}

function stripQuery(path: string): string {
	const index = path.indexOf("?");
	return index === -1 ? path : path.slice(0, index);
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason as Error);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason as Error);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** An external id value as a path segment; numbers are written without exponent notation. */
export function externalIdText(value: string | number): string {
	return typeof value === "number" ? formatNumber(value) : value;
}

/**
 * Encodes one URL path segment (an sObject name, id or external id value). `.` and `..` are
 * rejected: URL parsing would resolve them and change which resource is called.
 */
export function segment(value: string): string {
	if (value === "." || value === "..") {
		throw new Error(`"${value}" is not a valid id or name in a URL path.`);
	}
	return encodeURIComponent(value);
}

export { sleep };
