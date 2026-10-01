import { hasErrorCode } from "../errors";
import { segment, sleep } from "../http/connection";
import { soqlEscape } from "../soql/escape";

import type { ToolingApi } from "./tooling";

export type LogLevel = "NONE" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "FINE" | "FINER" | "FINEST";

/** Log levels per category, as on a DebugLevel record. */
export interface DebugLevels {
	ApexCode: LogLevel;
	ApexProfiling: LogLevel;
	Callout: LogLevel;
	Database: LogLevel;
	System: LogLevel;
	Validation: LogLevel;
	Visualforce: LogLevel;
	Workflow: LogLevel;
}

/** Defaults tuned for debugging Apex: everything from `System.debug` and exceptions, little noise. */
export const DEFAULT_DEBUG_LEVELS: DebugLevels = {
	ApexCode: "FINEST",
	ApexProfiling: "INFO",
	Callout: "INFO",
	Database: "INFO",
	System: "DEBUG",
	Validation: "INFO",
	Visualforce: "INFO",
	Workflow: "INFO",
};

/** The DebugLevel this library creates and reuses. */
export const DEBUG_LEVEL_NAME = "sobjectly";

export interface ApexLogEntry {
	id: string;
	operation: string;
	request: string;
	/** `"Success"` or the unhandled exception message. */
	status: string;
	startTime: string;
	durationMilliseconds: number;
	logLength: number;
	/** The log text (when `includeBodies` is on). */
	body?: string;
}

export interface CaptureLogsOptions {
	/** The user to trace. Defaults to the authenticated user. */
	userId?: string;
	/** Log levels; defaults to `DEFAULT_DEBUG_LEVELS`. */
	levels?: Partial<DebugLevels>;
	/** Download the log text. Defaults to `true`. */
	includeBodies?: boolean;
	/** Wait this long after the callback before collecting logs. Defaults to 1 000 ms. */
	settleMs?: number;
	/** How long the trace flag stays active if cleanup fails. Defaults to 30 minutes (max 24 hours). */
	expirationMinutes?: number;
	signal?: AbortSignal;
}

export interface CaptureLogsResult<T> {
	result: T;
	logs: ApexLogEntry[];
	/**
	 * Set when restoring the user's trace flag failed. The work's result is still returned; the
	 * flag lapses on its own after `expirationMinutes`.
	 */
	cleanupError?: unknown;
}

/** Thrown by `capture` when the callback throws; carries the logs collected anyway. */
export class DebugLogCaptureError extends Error {
	override readonly name: string = "DebugLogCaptureError";

	constructor(
		readonly logs: ApexLogEntry[],
		override readonly cause: unknown,
		/** Set when restoring the user's trace flag failed as well. */
		readonly cleanupError?: unknown,
	) {
		super(`${cause instanceof Error ? cause.message : String(cause)} (${logs.length} Apex log(s) captured)`);
	}
}

interface ApexLogRow {
	Id: string;
	Operation: string;
	Request: string;
	Status: string;
	StartTime: string;
	DurationMilliseconds: number;
	LogLength: number;
}

interface TraceFlagRow {
	Id: string;
	DebugLevelId: string;
	StartDate: string | null;
	ExpirationDate: string;
}

const LOG_FIELDS = "Id, Operation, Request, Status, StartTime, DurationMilliseconds, LogLength";

/** Apex debug logs through the Tooling API: capture the logs of a block of work, list and read logs. */
export class DebugLogsApi {
	/** The latest capture per user: a user has one trace flag, so captures for a user take turns. */
	private readonly _captures = new Map<string, Promise<void>>();

	constructor(private readonly _tooling: ToolingApi) {}

	/** The id of the authenticated user (from `/services/oauth2/userinfo`). */
	async currentUserId(options: { signal?: AbortSignal } = {}): Promise<string> {
		const info = await this._tooling.connection.request<{ user_id: string }>({
			path: "/services/oauth2/userinfo",
			signal: options.signal,
		});
		return info.user_id;
	}

	/** The most recent Apex logs, newest first. */
	async list(options: { userId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ApexLogEntry[]> {
		const where = options.userId ? ` WHERE LogUserId = ${soqlEscape(options.userId)}` : "";
		const rows = await this._tooling.collect<ApexLogRow>(
			`SELECT ${LOG_FIELDS} FROM ApexLog${where} ORDER BY StartTime DESC LIMIT ${options.limit ?? 50}`,
			{ signal: options.signal },
		);
		return rows.map(toEntry);
	}

	/** The text of one Apex log. */
	body(logId: string, options: { signal?: AbortSignal } = {}): Promise<string> {
		return this._tooling.connection.request({
			path: `/tooling/sobjects/ApexLog/${segment(logId)}/Body/`,
			responseType: "text",
			signal: options.signal,
		});
	}

	/**
	 * Runs `work` with debug logging enabled for the user, then returns its result together with
	 * the Apex logs it produced (e.g. from triggers, flows or Apex REST calls):
	 *
	 * ```ts
	 * const { result, logs } = await sf.tooling.debugLogs.capture(() => sf.sobject("Case").create({ Subject: "x" }));
	 * console.log(logs.map((log) => log.body).join("\n"));
	 * ```
	 *
	 * Salesforce allows one trace flag per user; an existing flag is reused and restored afterwards,
	 * and captures for the same user through this client run one after another. Only work that runs
	 * while the callback does is traced: async Apex it enqueues (queueable, batch, future) usually
	 * runs later. At most the 200 newest logs of the user are collected.
	 */
	async capture<T>(work: () => Promise<T>, options: CaptureLogsOptions = {}): Promise<CaptureLogsResult<T>> {
		const userId = options.userId ?? (await this.currentUserId({ signal: options.signal }));
		const previous = this._captures.get(userId) ?? Promise.resolve();
		const current = previous.then(() => this.captureFor(userId, work, options));
		const settled = current.then(
			() => undefined,
			() => undefined,
		);
		this._captures.set(userId, settled);
		try {
			return await current;
		} finally {
			if (this._captures.get(userId) === settled) {
				this._captures.delete(userId);
			}
		}
	}

	private async captureFor<T>(
		userId: string,
		work: () => Promise<T>,
		options: CaptureLogsOptions,
	): Promise<CaptureLogsResult<T>> {
		const { signal } = options;
		signal?.throwIfAborted();
		const before = new Set((await this.list({ userId, limit: 200, signal })).map((log) => log.id));
		const debugLevelId = await this.ensureDebugLevel({ ...DEFAULT_DEBUG_LEVELS, ...options.levels }, signal);
		const restore = await this.enableTraceFlag(userId, debugLevelId, options.expirationMinutes ?? 30, signal);

		let result: T | undefined;
		let failure: { error: unknown } | undefined;
		let cleanupError: unknown;
		try {
			result = await work();
		} catch (error) {
			failure = { error };
		}
		try {
			await restore();
		} catch (error) {
			cleanupError = error;
		}

		await sleep(options.settleMs ?? 1_000, signal);
		const logs = (await this.list({ userId, limit: 200, signal })).filter((log) => !before.has(log.id)).reverse();
		if (options.includeBodies !== false) {
			for (const log of logs) {
				log.body = await this.body(log.id, { signal });
			}
		}
		if (failure) {
			throw new DebugLogCaptureError(logs, failure.error, cleanupError);
		}
		return cleanupError === undefined ? { result: result as T, logs } : { result: result as T, logs, cleanupError };
	}

	private async ensureDebugLevel(levels: DebugLevels, signal: AbortSignal | undefined): Promise<string> {
		const [existing] = await this._tooling.collect<{ Id: string }>(
			`SELECT Id FROM DebugLevel WHERE DeveloperName = ${soqlEscape(DEBUG_LEVEL_NAME)}`,
			{ signal },
		);
		const levelSObject = this._tooling.sobject("DebugLevel");
		if (existing) {
			await levelSObject.update(existing.Id, { ...levels }, { signal });
			return existing.Id;
		}
		return levelSObject.create(
			{ DeveloperName: DEBUG_LEVEL_NAME, MasterLabel: DEBUG_LEVEL_NAME, ...levels },
			{ signal },
		);
	}

	/** Enables tracing and returns a function that restores the previous state. */
	private async enableTraceFlag(
		userId: string,
		debugLevelId: string,
		minutes: number,
		signal: AbortSignal | undefined,
	): Promise<() => Promise<void>> {
		const expiration = new Date(Date.now() + Math.min(Math.max(minutes, 1), 24 * 60 - 1) * 60_000).toISOString();
		const flags = this._tooling.sobject("TraceFlag");
		const [existing] = await this._tooling.collect<TraceFlagRow>(
			`SELECT Id, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = ${soqlEscape(userId)} AND LogType = 'USER_DEBUG'`,
			{ signal },
		);
		if (!existing) {
			const id = await flags.create(
				{
					TracedEntityId: userId,
					LogType: "USER_DEBUG",
					DebugLevelId: debugLevelId,
					StartDate: null,
					ExpirationDate: expiration,
				},
				{ signal },
			);
			return () => ignoreMissing(flags.delete(id));
		}
		await flags.update(
			existing.Id,
			{ DebugLevelId: debugLevelId, StartDate: null, ExpirationDate: expiration },
			{ signal },
		);
		return async () => {
			if (Date.parse(existing.ExpirationDate) > Date.now()) {
				await ignoreMissing(
					flags.update(existing.Id, {
						DebugLevelId: existing.DebugLevelId,
						StartDate: existing.StartDate,
						ExpirationDate: existing.ExpirationDate,
					}),
				);
			} else {
				// The original flag had already expired; an expired flag can't be restored, and it logged nothing.
				await ignoreMissing(flags.delete(existing.Id));
			}
		};
	}
}

/** The trace flag was removed meanwhile (by a person or another tool): nothing left to restore. */
async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (!hasErrorCode(error, "NOT_FOUND") && !hasErrorCode(error, "ENTITY_IS_DELETED")) {
			throw error;
		}
	}
}

function toEntry(row: ApexLogRow): ApexLogEntry {
	return {
		id: row.Id,
		operation: row.Operation,
		request: row.Request,
		status: row.Status,
		startTime: row.StartTime,
		durationMilliseconds: row.DurationMilliseconds,
		logLength: row.LogLength,
	};
}
