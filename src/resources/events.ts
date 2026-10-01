import { runChunks, SalesforceError, SalesforceSaveError } from "../errors";
import { type SalesforceConnection, segment } from "../http/connection";
import type { SObjectCreateInput, SObjectName } from "../registry";
import type { CompositeSubrequestResult } from "../types/api";
import type { RestError, SaveError, SaveResult } from "../types/common";

/** Composite allows 25 subrequests per call. */
const MAX_PER_COMPOSITE = 25;

/** Platform event sObject names (`...__e`) in registry `R`. */
export type PlatformEventName<R> =
	string extends SObjectName<R> ? `${string}__e` : Extract<SObjectName<R>, `${string}__e`>;

export interface PublishResult {
	/** `true` when Salesforce accepted (enqueued) the event. */
	success: boolean;
	/** The event UUID (`EventUuid`), taken from the `OPERATION_ENQUEUED` entry Salesforce returns. */
	uuid: string | undefined;
	/** The returned id. Not unique or meaningful for events; use `uuid` to correlate. */
	id: string | undefined;
	/** Real errors (the `OPERATION_ENQUEUED` entry is not an error and is left out). */
	errors: SaveError[];
}

export interface PublishOptions {
	/** Throw a `SalesforceSaveError` when any event was not accepted. Defaults to `true`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

/**
 * Publishes platform events. Payloads are typed by the event's generated create input.
 *
 * ```ts
 * await sf.events.publish("Order_Shipped__e", { Order_Number__c: "A-1" });
 * await sf.events.publish("Order_Shipped__e", [{ Order_Number__c: "A-1" }, { Order_Number__c: "A-2" }]);
 * ```
 *
 * With the default "Publish Immediately" behaviour, events are published even when later
 * events in the same call fail; there is no rollback.
 */
export class EventsApi<R extends object> {
	constructor(private readonly _connection: SalesforceConnection) {}

	async publish<K extends PlatformEventName<R> & SObjectName<R>>(
		eventName: K,
		events: SObjectCreateInput<R, K> | readonly SObjectCreateInput<R, K>[],
		options: PublishOptions = {},
	): Promise<PublishResult[]> {
		if (typeof eventName !== "string" || !/^[A-Za-z][A-Za-z0-9_]*__e$/.test(eventName)) {
			throw new Error(`"${String(eventName)}" is not a platform event name (it must end with __e).`);
		}
		const list = Array.isArray(events) ? (events as readonly object[]) : [events as object];
		if (list.length === 0) {
			throw new Error("publish() requires at least one event.");
		}
		const batches: (readonly object[])[] = [];
		for (let index = 0; list.length > 1 && index < list.length; index += MAX_PER_COMPOSITE) {
			batches.push(list.slice(index, index + MAX_PER_COMPOSITE));
		}
		const results =
			list.length === 1
				? [await this.publishOne(eventName, list[0], options)]
				: await runChunks(
						batches,
						(batch) => this.publishBatch(eventName, batch, options),
						`Publishing ${eventName} failed`,
					);
		if (options.throwOnError !== false && results.some((result) => !result.success)) {
			const failed = results.filter((result) => !result.success);
			throw new SalesforceSaveError(
				`Publishing ${eventName} failed for ${failed.length} of ${results.length} event(s)`,
				results,
				failed.flatMap((result) => result.errors),
			);
		}
		return results;
	}

	private async publishOne(eventName: string, event: object, options: PublishOptions): Promise<PublishResult> {
		try {
			const result = await this._connection.request<SaveResult>({
				method: "POST",
				path: `/sobjects/${segment(eventName)}`,
				body: event,
				signal: options.signal,
			});
			return toPublishResult(result);
		} catch (error) {
			// A rejected event (e.g. a missing required field) is a 400 with an error array: report it
			// like the batch path does, so `throwOnError: false` behaves the same for one or many events.
			if (error instanceof SalesforceError && error.status === 400 && error.errors.length > 0) {
				return { success: false, uuid: undefined, id: undefined, errors: toSaveErrors(error.body) };
			}
			throw error;
		}
	}

	private async publishBatch(
		eventName: string,
		events: readonly object[],
		options: PublishOptions,
	): Promise<PublishResult[]> {
		const url = `/services/data/${this._connection.apiVersion}/sobjects/${segment(eventName)}`;
		const response = await this._connection.request<{ compositeResponse: CompositeSubrequestResult[] }>({
			method: "POST",
			path: "/composite",
			body: {
				allOrNone: false,
				compositeRequest: events.map((body, index) => ({ method: "POST", url, referenceId: `event${index}`, body })),
			},
			signal: options.signal,
		});
		return response.compositeResponse.map((item) =>
			item.httpStatusCode < 400
				? toPublishResult(item.body as SaveResult)
				: { success: false, uuid: undefined, id: undefined, errors: toSaveErrors(item.body) },
		);
	}
}

/** Converts a save result, treating the `OPERATION_ENQUEUED` entry as the UUID instead of an error. */
export function toPublishResult(result: SaveResult): PublishResult {
	const errors = result.errors ?? [];
	const enqueued = errors.find((error) => error.statusCode === "OPERATION_ENQUEUED");
	const realErrors = errors.filter((error) => error.statusCode !== "OPERATION_ENQUEUED");
	return {
		success: result.success && realErrors.length === 0,
		uuid: enqueued?.message,
		id: result.id,
		errors: realErrors,
	};
}

function toSaveErrors(body: unknown): SaveError[] {
	if (!Array.isArray(body)) {
		return [{ statusCode: "UNKNOWN_EXCEPTION", message: JSON.stringify(body) ?? "", fields: [] }];
	}
	return (body as RestError[]).map((error) => ({
		statusCode: error.errorCode,
		message: error.message,
		fields: error.fields ?? [],
	}));
}
