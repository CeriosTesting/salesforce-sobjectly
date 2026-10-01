import { SalesforceError, SalesforceSaveError } from "../errors";
import { type SalesforceConnection, segment } from "../http/connection";
import type { ActionDescribe, ActionSummary, InvocableActionResult } from "../types/api";
import type { GenericRecord } from "../types/common";

export interface InvokeOptions {
	/** Throw a `SalesforceSaveError` when any input reported `isSuccess: false`. Defaults to `true`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

/** The custom action types of `/actions/custom/{type}`. */
export type CustomActionType =
	| "flow"
	| "apex"
	| "quickAction"
	| "emailAlert"
	| "submit"
	| "externalService"
	| (string & {});

/** Invocable actions (`/actions/standard`, `/actions/custom`), including autolaunched Flows and `@InvocableMethod` Apex. */
export class ActionsApi {
	constructor(private readonly _connection: SalesforceConnection) {}

	async listStandard(options: { signal?: AbortSignal } = {}): Promise<ActionSummary[]> {
		const result = await this._connection.request<{ actions: ActionSummary[] }>({
			path: "/actions/standard",
			signal: options.signal,
		});
		return result.actions;
	}

	async listCustom(type: CustomActionType, options: { signal?: AbortSignal } = {}): Promise<ActionSummary[]> {
		const result = await this._connection.request<{ actions: ActionSummary[] }>({
			path: `/actions/custom/${segment(type)}`,
			signal: options.signal,
		});
		return result.actions;
	}

	describeStandard(name: string, options: { signal?: AbortSignal } = {}): Promise<ActionDescribe> {
		return this._connection.request({ path: `/actions/standard/${segment(name)}`, signal: options.signal });
	}

	describeCustom(
		type: CustomActionType,
		name: string,
		options: { signal?: AbortSignal } = {},
	): Promise<ActionDescribe> {
		return this._connection.request({
			path: `/actions/custom/${segment(type)}/${segment(name)}`,
			signal: options.signal,
		});
	}

	/** Invokes a standard action, e.g. `"emailSimple"` or `"chatterPost"`. One result per input. */
	invokeStandard<TInput extends object = GenericRecord, TOutput = GenericRecord>(
		name: string,
		inputs: readonly TInput[],
		options?: InvokeOptions,
	): Promise<InvocableActionResult<TOutput>[]> {
		return this.invoke(`/actions/standard/${segment(name)}`, name, inputs, options);
	}

	/** Invokes a custom action of `type`. One result per input. */
	invokeCustom<TInput extends object = GenericRecord, TOutput = GenericRecord>(
		type: CustomActionType,
		name: string,
		inputs: readonly TInput[],
		options?: InvokeOptions,
	): Promise<InvocableActionResult<TOutput>[]> {
		return this.invoke(`/actions/custom/${segment(type)}/${segment(name)}`, name, inputs, options);
	}

	/**
	 * Runs an autolaunched Flow by API name. Input keys are the Flow's input variable names;
	 * `outputValues` holds its output variables plus `Flow__InterviewStatus`.
	 */
	invokeFlow<TInput extends object = GenericRecord, TOutput = GenericRecord>(
		apiName: string,
		inputs: readonly TInput[],
		options?: InvokeOptions,
	): Promise<InvocableActionResult<TOutput>[]> {
		return this.invokeCustom("flow", apiName, inputs, options);
	}

	/** Invokes an `@InvocableMethod` of an Apex class (`Namespace__ClassName` for managed packages). */
	invokeApex<TInput extends object = GenericRecord, TOutput = GenericRecord>(
		className: string,
		inputs: readonly TInput[],
		options?: InvokeOptions,
	): Promise<InvocableActionResult<TOutput>[]> {
		return this.invokeCustom("apex", className, inputs, options);
	}

	private async invoke<TOutput>(
		path: string,
		name: string,
		inputs: readonly object[],
		options: InvokeOptions = {},
	): Promise<InvocableActionResult<TOutput>[]> {
		if (inputs.length === 0) {
			throw new Error(`Invoking "${name}" requires at least one input (use [{}] for actions without inputs).`);
		}
		let results: InvocableActionResult<TOutput>[];
		try {
			results = await this._connection.request<InvocableActionResult<TOutput>[]>({
				method: "POST",
				path,
				body: { inputs },
				signal: options.signal,
			});
		} catch (error) {
			// A failing action (e.g. a faulting Flow) answers 400 with the usual per-input results.
			const recovered = actionResults<TOutput>(error);
			if (!recovered) {
				throw error;
			}
			results = recovered;
		}
		if (options.throwOnError !== false) {
			const failed = results.filter((result) => !result.isSuccess);
			if (failed.length > 0) {
				throw new SalesforceSaveError(
					`Action "${name}" failed for ${failed.length} of ${results.length} input(s)`,
					results,
					failed.flatMap((result) => result.errors ?? []),
				);
			}
		}
		return results;
	}
}

function actionResults<TOutput>(error: unknown): InvocableActionResult<TOutput>[] | undefined {
	if (
		!(error instanceof SalesforceError) ||
		error.status !== 400 ||
		!Array.isArray(error.body) ||
		error.body.length === 0
	) {
		return undefined;
	}
	const items = error.body as unknown[];
	const isResult = (item: unknown): boolean => typeof item === "object" && item !== null && "isSuccess" in item;
	return items.every(isResult) ? (items as InvocableActionResult<TOutput>[]) : undefined;
}
