import { hasErrorCode, SalesforceSaveError } from "../errors";
import { type RestRequest, type SalesforceConnection, segment } from "../http/connection";
import type { GenericRecord } from "../types/common";
import type { QuickActionDescribe, QuickActionResult, QuickActionSummary } from "../types/platform";

export interface InvokeQuickActionOptions {
	/** The record the action runs on (e.g. the parent Account of a "New Contact" action). */
	contextId?: string;
	/** Throw a `SalesforceSaveError` when Salesforce reports `success: false`. Defaults to `true`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

const GLOBAL_BASE_PATH = "/quickActions";

/**
 * Quick actions of one sObject (`sf.sobject("Account").quickActions`) or global quick actions
 * (`sf.quickActions`). An sObject's list also includes the global actions on its layout; those
 * only exist under `/quickActions`, so calls for them fall back to the global path.
 */
export class QuickActionsApi {
	constructor(
		private readonly _connection: SalesforceConnection,
		private readonly _basePath: string,
	) {}

	list(options: { signal?: AbortSignal } = {}): Promise<QuickActionSummary[]> {
		return this._connection.request({ path: `${this._basePath}/`, signal: options.signal });
	}

	describe(name: string, options: { signal?: AbortSignal } = {}): Promise<QuickActionDescribe> {
		return this.send(name, "/describe/", { signal: options.signal });
	}

	/** The default field values the action would pre-fill, optionally for a context record. */
	defaultValues(name: string, contextId?: string, options: { signal?: AbortSignal } = {}): Promise<GenericRecord> {
		const suffix = contextId ? `/${segment(contextId)}` : "";
		return this.send(name, `/defaultValues${suffix}`, { signal: options.signal });
	}

	/** Runs the action with the given record values. */
	async invoke<TRecord extends object = GenericRecord>(
		name: string,
		record: TRecord,
		options: InvokeQuickActionOptions = {},
	): Promise<QuickActionResult> {
		const body: Record<string, unknown> = { record };
		if (options.contextId) {
			body.contextId = options.contextId;
		}
		const result = await this.send<QuickActionResult>(name, "", { method: "POST", body, signal: options.signal });
		if (options.throwOnError !== false && !result.success) {
			throw new SalesforceSaveError(`Quick action "${name}" failed`, [result], result.errors ?? []);
		}
		return result;
	}

	/** Calls the action under this sObject, falling back to the global action of that name. */
	private async send<T>(name: string, suffix: string, request: Omit<RestRequest, "path">): Promise<T> {
		if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
			throw new Error(`Invalid quick action name "${String(name)}".`);
		}
		const path = (base: string): string => `${base}/${segment(name)}${suffix}`;
		try {
			return await this._connection.request<T>({ ...request, path: path(this._basePath) });
		} catch (error) {
			// A 404 means nothing ran, so trying the global action is safe, also for invoke().
			if (this._basePath === GLOBAL_BASE_PATH || !hasErrorCode(error, "NOT_FOUND")) {
				throw error;
			}
			return this._connection.request<T>({ ...request, path: path(GLOBAL_BASE_PATH) });
		}
	}
}
