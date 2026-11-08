import type { RequestEvent, RequestHooks, ResponseEvent } from "./http/connection";
import type { HttpMethod } from "./http/transport";
import type { BulkJobState } from "./types/api";

/** The level of a log entry. (`LogLevel` is the Apex debug log level type.) */
export type SalesforceLogLevel = "debug" | "info" | "warn" | "error";

/**
 * Receives everything the client does: HTTP traffic with Salesforce, token requests (with secrets
 * redacted), retries, failures, metadata cache use, long-running operations and codegen. Every
 * method is optional, so `console`, a `{ info, warn }` object or a pino/winston adapter all work.
 *
 * Each call gets a human-readable `message` and a structured `event`; switch on `event.type`
 * to handle a kind of event (e.g. attach every `"http.response"` to a test report). A method
 * may return a promise; it is not awaited, and a throw or rejection never affects the request.
 */
export interface SalesforceLogger {
	debug?(message: string, event: SalesforceLogEvent): unknown;
	info?(message: string, event: SalesforceLogEvent): unknown;
	warn?(message: string, event: SalesforceLogEvent): unknown;
	error?(message: string, event: SalesforceLogEvent): unknown;
}

/** One handler for every level, see `createLogger`. */
/** The return value is ignored; a returned promise is not awaited, and its rejection is swallowed. */
export type SalesforceLogHandler = (level: SalesforceLogLevel, message: string, event: SalesforceLogEvent) => unknown;

/** A request to Salesforce is about to be sent (once per attempt). `debug`. */
export interface HttpRequestLogEvent extends RequestEvent {
	type: "http.request";
}

/** Salesforce answered (once per attempt). `debug` below 400, `warn` from 400. */
export interface HttpResponseLogEvent extends ResponseEvent {
	type: "http.response";
}

/** A request is retried after a delay. `warn`. */
export interface HttpRetryLogEvent {
	type: "http.retry";
	method: HttpMethod;
	url: string;
	/** The attempt that failed; the next one is `attempt + 1`. */
	attempt: number;
	/** `status`: a retryable status; `errorCode`: a configured Salesforce error code; `network`: the transport threw. */
	reason: "status" | "errorCode" | "network";
	status?: number;
	delayMs: number;
}

/** The transport threw (network failure, timeout, abort). `warn` when retried, `error` otherwise. */
export interface HttpErrorLogEvent {
	type: "http.error";
	method: HttpMethod;
	url: string;
	attempt: number;
	durationMs: number;
	error: unknown;
	willRetry: boolean;
}

/** Salesforce answered 401: the token is dropped and the request is sent once more. `info`. */
export interface AuthReauthenticateLogEvent {
	type: "auth.reauthenticate";
	method: HttpMethod;
	url: string;
}

/**
 * An OAuth token request (client credentials, JWT bearer, refresh token). `debug`. The form body
 * has `client_secret`, `assertion`, `refresh_token` and the like replaced by `[REDACTED]`.
 */
export interface AuthRequestLogEvent extends RequestEvent {
	type: "auth.request";
	grantType?: string;
}

/** The OAuth token response, with `access_token`, `refresh_token` and `id_token` redacted. `debug`. */
export interface AuthResponseLogEvent extends ResponseEvent {
	type: "auth.response";
	grantType?: string;
}

/** An auth provider issued a new access token (the token itself is never logged). `info`. */
export interface AuthTokenIssuedLogEvent {
	type: "auth.tokenIssued";
	/** E.g. `clientCredentials`, `jwtBearer`, `refreshToken`, `sfCli`, `tokenProvider`. */
	provider: string;
	instanceUrl: string;
	expiresAt?: number;
	durationMs: number;
}

/** A cached access token was reused. `debug`. */
export interface AuthTokenCachedLogEvent {
	type: "auth.tokenCached";
	provider: string;
	instanceUrl: string;
	expiresAt?: number;
}

/** Getting an access token failed. `error`. */
export interface AuthErrorLogEvent {
	type: "auth.error";
	provider: string;
	error: unknown;
	durationMs: number;
}

/** Salesforce issued a new refresh token (its value is never logged). `info`. */
export interface AuthRefreshTokenRotatedLogEvent {
	type: "auth.refreshTokenRotated";
	provider: string;
}

/** `sfCli()` ran the Salesforce CLI. Its output holds the token and is never logged. `debug`. */
export interface AuthCliLogEvent {
	type: "auth.cli";
	command: string;
	args: string[];
	durationMs: number;
	ok: boolean;
}

/** Metadata (describe, UI API object info) came from the client's cache, or had to be loaded. `debug`. */
export interface CacheLogEvent {
	type: "cache.hit" | "cache.miss";
	key: string;
}

/** A Bulk API 2.0 job was polled. `info` when its state changed, `debug` otherwise. */
export interface BulkJobStateLogEvent {
	type: "bulk.jobState";
	jobId: string;
	state: BulkJobState;
	changed: boolean;
	numberRecordsProcessed?: number;
	numberRecordsFailed?: number;
}

/** An asynchronous report run was polled. `debug` while running, `info` when it finished. */
export interface ReportStatusLogEvent {
	type: "report.status";
	reportId: string;
	instanceId: string;
	status?: string;
}

/** `debugLogs.capture` changed a trace flag. `info`. */
export interface DebugLogsTraceFlagLogEvent {
	type: "debugLogs.traceFlag";
	action: "created" | "updated" | "restored" | "deleted";
	userId: string;
	traceFlagId: string;
}

/** `debugLogs.capture` collected the logs of its work. `info`. */
export interface DebugLogsCapturedLogEvent {
	type: "debugLogs.captured";
	userId: string;
	count: number;
}

/** Apex tests ran (synchronously) or were enqueued (asynchronously). `info`. */
export interface ToolingRunTestsLogEvent {
	type: "tooling.runTests";
	mode: "sync" | "async";
	/** The AsyncApexJob id, for `async`. */
	jobId?: string;
	numTestsRun?: number;
	numFailures?: number;
}

/** Codegen progress (`info`). */
export interface CodegenProgressLogEvent {
	type: "codegen.progress";
	done: number;
	total: number;
	apiVersion: string;
}

/** Codegen skipped an sObject whose describe failed (`continueOnDescribeError`). `warn`. */
export interface CodegenSkipLogEvent {
	type: "codegen.skip";
	sobject: string;
	error: string;
}

/** Codegen wrote the generated file. `info`. */
export interface CodegenWriteLogEvent {
	type: "codegen.write";
	outputPath: string;
	count: number;
}

/** A codegen configuration warning, e.g. a deprecated option. `warn`. */
export interface CodegenWarningLogEvent {
	type: "codegen.warning";
}

/** An event of your own, e.g. from a custom auth provider logging through `AuthContext.logger`. */
export interface CustomLogEvent {
	type: "custom";
	/** Where it comes from, e.g. `"vault-auth"`. */
	source?: string;
	data?: unknown;
}

export type SalesforceLogEvent =
	| HttpRequestLogEvent
	| HttpResponseLogEvent
	| HttpRetryLogEvent
	| HttpErrorLogEvent
	| AuthReauthenticateLogEvent
	| AuthRequestLogEvent
	| AuthResponseLogEvent
	| AuthTokenIssuedLogEvent
	| AuthTokenCachedLogEvent
	| AuthErrorLogEvent
	| AuthRefreshTokenRotatedLogEvent
	| AuthCliLogEvent
	| CacheLogEvent
	| BulkJobStateLogEvent
	| ReportStatusLogEvent
	| DebugLogsTraceFlagLogEvent
	| DebugLogsCapturedLogEvent
	| ToolingRunTestsLogEvent
	| CodegenProgressLogEvent
	| CodegenSkipLogEvent
	| CodegenWriteLogEvent
	| CodegenWarningLogEvent
	| CustomLogEvent;

export type SalesforceLogEventType = SalesforceLogEvent["type"];

const LEVELS: readonly SalesforceLogLevel[] = ["debug", "info", "warn", "error"];

/**
 * Builds a logger that sends every level to one handler. Handy for custom sinks such as a test
 * report, which want every response whatever its level:
 *
 * ```ts
 * const logger = createLogger((level, message, event) => {
 * 	if (event.type === "http.response") {
 * 		return allure.attachment(message, JSON.stringify(event, null, 2), "application/json");
 * 	}
 * 	console[level](message);
 * });
 * ```
 */
export function createLogger(handler: SalesforceLogHandler): Required<SalesforceLogger> {
	return {
		debug: (message, event) => handler("debug", message, event),
		info: (message, event) => handler("info", message, event),
		warn: (message, event) => handler("warn", message, event),
		error: (message, event) => handler("error", message, event),
	};
}

/**
 * Passes on only the entries `filter` accepts, e.g. to drop `debug` when logging to the console:
 *
 * ```ts
 * logger: filterLogger(console, (level) => level !== "debug")
 * ```
 */
export function filterLogger(
	logger: SalesforceLogger,
	filter: (level: SalesforceLogLevel, event: SalesforceLogEvent) => boolean,
): SalesforceLogger {
	const filtered = createLogger((level, message, event) =>
		filter(level, event) ? logger[level]?.(message, event) : undefined,
	);
	// A filtered console is still the console, so `log: { console: false }` keeps applying to it.
	return isConsoleLogger(logger) ? markConsole(filtered) : filtered;
}

/** The `logger` option: one logger, or several that each receive every entry. */
export type SalesforceLoggerOption = SalesforceLogger | readonly SalesforceLogger[];

/** Per-request logging, the object form of `RestRequest.log`. */
export interface RequestLogOptions {
	/**
	 * `false` keeps this request away from console loggers (`console` itself and
	 * `consoleLogger()`) while your other loggers, e.g. a test report, still get it.
	 */
	console?: boolean;
}

export interface ConsoleLoggerOptions {
	/** `false` turns the console off; the client's other loggers keep running. Defaults to `true`. */
	enabled?: boolean;
	/** The lowest level that is printed. Defaults to `"info"`, so requests (`debug`) aren't printed. */
	level?: SalesforceLogLevel;
	/**
	 * Print each event's data after the message:
	 * - `"full"`: the whole event, as your custom loggers get it.
	 * - `"compact"`: the same, except `http.response` leaves out the request fields (`method`, `url`,
	 *   `headers`, `body`) that its `http.request` already printed.
	 *
	 * Left out, only the message is printed. Other loggers always get the full event.
	 */
	details?: "compact" | "full";
	/** Where to print. Defaults to the global `console`. */
	output?: Pick<Console, SalesforceLogLevel>;
}

const consoleLoggers = new WeakSet<object>();

function markConsole<T extends SalesforceLogger>(logger: T): T {
	consoleLoggers.add(logger);
	return logger;
}

/**
 * A console logger you can switch off without touching your other loggers:
 *
 * ```ts
 * new SalesforceClient({
 * 	auth,
 * 	apiVersion,
 * 	logger: [consoleLogger({ enabled: !process.env.CI, level: "debug" }), allureLogger],
 * });
 * ```
 *
 * A request can skip it (and `console` itself) with `log: { console: false }`.
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): SalesforceLogger {
	if (options.enabled === false) {
		return markConsole({});
	}
	const minimum = options.level ?? "info";
	return markConsole(
		createLogger((level, message, event) => {
			if (!isLevelEnabled(level, minimum)) {
				return;
			}
			const output = options.output ?? console;
			if (options.details === undefined) {
				output[level](message);
			} else {
				output[level](message, options.details === "compact" ? compactEvent(event) : event);
			}
		}),
	);
}

/** `consoleLogger({ details: "compact" })`: the event, without what its request already printed. */
function compactEvent(event: SalesforceLogEvent): object {
	if (event.type === "http.response") {
		const { method: _method, url: _url, headers: _headers, body: _body, ...response } = event;
		return response;
	}
	return event;
}

/** Whether `logger` writes to the console: the global `console` or a `consoleLogger()`. */
export function isConsoleLogger(logger: SalesforceLogger): boolean {
	return logger === globalThis.console || consoleLoggers.has(logger);
}

export interface FlushLogsOptions {
	/** Stop waiting after this many milliseconds; `flushLogs` then resolves `false`. No limit by default. */
	timeoutMs?: number;
}

/**
 * Remembers the promises loggers return, so they can be awaited later (`flushLogs`). Requests
 * never wait for them; only `flush` does.
 */
export class PendingLogs {
	private readonly _pending = new Set<Promise<void>>();

	/** How many logger promises are still running. */
	get size(): number {
		return this._pending.size;
	}

	/** Wraps `logger` so the promises its methods return are tracked. Console loggers stay console loggers. */
	track(logger: SalesforceLogger): SalesforceLogger {
		const tracked = createLogger((level, message, event) => {
			const result = logger[level]?.(message, event);
			if (result instanceof Object && typeof (result as PromiseLike<unknown>).then === "function") {
				const settled = Promise.resolve(result as PromiseLike<unknown>).then(
					() => undefined,
					() => undefined,
				);
				this._pending.add(settled);
				void settled.then(() => this._pending.delete(settled));
			}
			return result;
		});
		return isConsoleLogger(logger) ? markConsole(tracked) : tracked;
	}

	/**
	 * Waits until every tracked promise has settled, including ones started while waiting.
	 * Rejections are ignored. Resolves `false` when `timeoutMs` passed first, `true` otherwise.
	 */
	async flush(options: FlushLogsOptions = {}): Promise<boolean> {
		const drain = async (): Promise<true> => {
			while (this._pending.size > 0) {
				await Promise.all(this._pending);
			}
			return true;
		};
		if (options.timeoutMs === undefined) {
			return drain();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), options.timeoutMs);
		});
		try {
			return await Promise.race([drain(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}
}

/** The `logger` option as a list. */
export function toLoggers(option: SalesforceLoggerOption | undefined): SalesforceLogger[] {
	if (option === undefined) {
		return [];
	}
	return Array.isArray(option) ? [...(option as readonly SalesforceLogger[])] : [option as SalesforceLogger];
}

/**
 * Sends one entry to `logger`, if any. A logger must never change the outcome of a call: a
 * throw is ignored, and a returned promise is not awaited and its rejection swallowed.
 */
export function emit(
	logger: SalesforceLogger | undefined,
	level: SalesforceLogLevel,
	message: string,
	event: SalesforceLogEvent,
): void {
	if (!logger) {
		return;
	}
	try {
		// Any return value is ignored, but a returned promise must not reject unhandled.
		swallowRejection(logger[level]?.(message, event));
	} catch {
		// Ignored on purpose: logging is best effort.
	}
}

function swallowRejection(result: unknown): void {
	if (result instanceof Object && typeof (result as Promise<unknown>).catch === "function") {
		(result as Promise<unknown>).catch(() => undefined);
	}
}

/** The loggers a `combineLoggers` result sends to. */
const combinedMembers = new WeakMap<SalesforceLogger, readonly SalesforceLogger[]>();

/** Joins loggers into one; each is guarded on its own. */
export function combineLoggers(...loggers: (SalesforceLogger | undefined)[]): SalesforceLogger | undefined {
	const present = [...new Set(loggers.flatMap(loggerMembers))];
	if (present.length <= 1) {
		return present[0];
	}
	const combined = createLogger((level, message, event) => {
		for (const logger of present) {
			emit(logger, level, message, event);
		}
	});
	combinedMembers.set(combined, present);
	return combined;
}

/** The individual loggers behind `logger`: its members when it was combined, otherwise itself. */
export function loggerMembers(logger: SalesforceLogger | undefined): readonly SalesforceLogger[] {
	if (!logger) {
		return [];
	}
	return combinedMembers.get(logger) ?? [logger];
}

/**
 * The log of work that several callers share (a token request, a metadata load). Every caller
 * that joins gets its entries, also the ones logged before it joined, and a logger that joins
 * through several callers gets each entry once. `close` drops the recorded entries once the work
 * has settled.
 */
export class SharedLog implements Required<SalesforceLogger> {
	private _entries: [SalesforceLogLevel, string, SalesforceLogEvent][] | undefined = [];
	private readonly _targets = new Set<SalesforceLogger>();

	join(logger: SalesforceLogger | undefined): void {
		for (const member of loggerMembers(logger)) {
			if (this._targets.has(member)) {
				continue;
			}
			this._targets.add(member);
			for (const [level, message, event] of this._entries ?? []) {
				emit(member, level, message, event);
			}
		}
	}

	close(): void {
		this._entries = undefined;
	}

	debug(message: string, event: SalesforceLogEvent): void {
		this.log("debug", message, event);
	}

	info(message: string, event: SalesforceLogEvent): void {
		this.log("info", message, event);
	}

	warn(message: string, event: SalesforceLogEvent): void {
		this.log("warn", message, event);
	}

	error(message: string, event: SalesforceLogEvent): void {
		this.log("error", message, event);
	}

	private log(level: SalesforceLogLevel, message: string, event: SalesforceLogEvent): void {
		this._entries?.push([level, message, event]);
		for (const target of this._targets) {
			emit(target, level, message, event);
		}
	}
}

/** Adapts the (deprecated) request hooks: they receive the same events as before, without `type`. */
// oxlint-disable-next-line typescript/no-deprecated -- hooks stay supported, through the logger
export function hooksLogger(hooks: RequestHooks | undefined): SalesforceLogger | undefined {
	if (!hooks?.onRequest && !hooks?.onResponse) {
		return undefined;
	}
	return createLogger((_level, _message, event) => {
		// The hook's promise is returned, so `emit` swallows its rejection and `flushLogs` can await it.
		if (event.type === "http.request") {
			const { type: _type, ...request } = event;
			return hooks.onRequest?.(request);
		}
		if (event.type === "http.response") {
			const { type: _type, ...response } = event;
			return hooks.onResponse?.(response);
		}
		return undefined;
	});
}

/** Whether `level` is at least `minimum`, e.g. for `filterLogger`. */
export function isLevelEnabled(level: SalesforceLogLevel, minimum: SalesforceLogLevel): boolean {
	return LEVELS.indexOf(level) >= LEVELS.indexOf(minimum);
}

/** An error's message, for log messages. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const REDACTED = "[REDACTED]";
const SECRET_FORM_FIELDS = new Set([
	"client_secret",
	"assertion",
	"client_assertion",
	"refresh_token",
	"password",
	"code",
	"code_verifier",
]);
const SECRET_RESPONSE_FIELDS = new Set(["access_token", "refresh_token", "id_token", "signature"]);

/** A form body with every credential replaced by `[REDACTED]`. */
export function redactForm(body: string): string {
	return [...new URLSearchParams(body)]
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${SECRET_FORM_FIELDS.has(key) ? REDACTED : encodeURIComponent(value)}`,
		)
		.join("&");
}

/** A token response body with tokens and signatures replaced by `[REDACTED]`. */
export function redactTokenResponse(text: string): string | undefined {
	if (text.length === 0) {
		return undefined;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		// Not JSON (e.g. an HTML error page): it can't be a token response.
		return text;
	}
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return text;
	}
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(json)) {
		redacted[key] = SECRET_RESPONSE_FIELDS.has(key) ? REDACTED : value;
	}
	return JSON.stringify(redacted);
}
