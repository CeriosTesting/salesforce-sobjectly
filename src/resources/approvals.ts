import { SalesforceError, SalesforceSaveError } from "../errors";
import type { SalesforceConnection } from "../http/connection";
import { soqlEscape } from "../soql/escape";
import type { ApprovalProcessInfo, ApprovalResult, PendingApprovalWorkItem } from "../types/platform";

import type { QueryApi } from "./query";

/** ProcessInstanceWorkitem ids start with this prefix. */
const WORKITEM_PREFIX = "04i";

export interface SubmitOptions {
	comments?: string;
	/** Required when the process step lets the submitter choose the approver. */
	nextApproverIds?: string[];
	/** The approval process to use (API name or id); otherwise the first matching process runs. */
	processDefinitionNameOrId?: string;
	skipEntryCriteria?: boolean;
	/** Submit on behalf of this user id. */
	submitterId?: string;
	/** Throw a `SalesforceSaveError` when Salesforce reports `success: false`. Defaults to `true`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

export interface DecisionOptions {
	comments?: string;
	nextApproverIds?: string[];
	/** Throw a `SalesforceSaveError` when Salesforce reports `success: false`. Defaults to `true`. */
	throwOnError?: boolean;
	signal?: AbortSignal;
}

interface ProcessRequest {
	actionType: "Submit" | "Approve" | "Reject";
	contextId: string;
	comments?: string;
	nextApproverIds?: string[];
	processDefinitionNameOrId?: string;
	skipEntryCriteria?: boolean;
	contextActorId?: string;
}

interface WorkitemRow {
	Id: string;
	ActorId: string;
	ProcessInstanceId: string;
	ProcessInstance: { TargetObjectId: string } | null;
}

/** Approval processes (`/process/approvals`): submit records, approve and reject pending steps. */
export class ApprovalsApi {
	constructor(
		private readonly _connection: SalesforceConnection,
		private readonly _queries: QueryApi,
	) {}

	/** Lists the approval processes per sObject. */
	async list(options: { signal?: AbortSignal } = {}): Promise<Record<string, ApprovalProcessInfo[]>> {
		const result = await this._connection.request<{ approvals: Record<string, ApprovalProcessInfo[]> }>({
			path: "/process/approvals/",
			signal: options.signal,
		});
		return result.approvals;
	}

	/** Submits a record for approval. */
	submit(recordId: string, options: SubmitOptions = {}): Promise<ApprovalResult> {
		return this.process(
			{
				actionType: "Submit",
				contextId: requireId(recordId),
				comments: options.comments,
				nextApproverIds: options.nextApproverIds,
				processDefinitionNameOrId: options.processDefinitionNameOrId,
				skipEntryCriteria: options.skipEntryCriteria,
				contextActorId: options.submitterId,
			},
			options,
		);
	}

	/**
	 * Approves a pending step. Pass the work item id (`04i...`), or the record id to approve its
	 * single pending work item.
	 */
	async approve(recordOrWorkitemId: string, options: DecisionOptions = {}): Promise<ApprovalResult> {
		const contextId = await this.resolveWorkitem(recordOrWorkitemId, options.signal);
		return this.process(
			{ actionType: "Approve", contextId, comments: options.comments, nextApproverIds: options.nextApproverIds },
			options,
		);
	}

	/** Rejects a pending step. Accepts a work item id or a record id, like `approve`. */
	async reject(recordOrWorkitemId: string, options: DecisionOptions = {}): Promise<ApprovalResult> {
		const contextId = await this.resolveWorkitem(recordOrWorkitemId, options.signal);
		return this.process({ actionType: "Reject", contextId, comments: options.comments }, options);
	}

	/** The pending work items of a record (visible to the current user). */
	async pending(recordId: string, options: { signal?: AbortSignal } = {}): Promise<PendingApprovalWorkItem[]> {
		const soql =
			"SELECT Id, ActorId, ProcessInstanceId, ProcessInstance.TargetObjectId FROM ProcessInstanceWorkitem " +
			`WHERE ProcessInstance.TargetObjectId = ${soqlEscape(requireId(recordId))} AND ProcessInstance.Status = 'Pending'`;
		const rows = await this._queries.collect<WorkitemRow>(soql, { signal: options.signal });
		return rows.map((row) => ({
			id: row.Id,
			actorId: row.ActorId,
			processInstanceId: row.ProcessInstanceId,
			targetObjectId: row.ProcessInstance?.TargetObjectId ?? recordId,
		}));
	}

	private async resolveWorkitem(id: string, signal: AbortSignal | undefined): Promise<string> {
		if (requireId(id).startsWith(WORKITEM_PREFIX)) {
			return id;
		}
		const items = await this.pending(id, { signal });
		if (items.length === 0) {
			throw new Error(`Record ${id} has no pending approval work item visible to the current user.`);
		}
		if (items.length > 1) {
			throw new Error(
				`Record ${id} has ${items.length} pending work items (${items.map((item) => item.id).join(", ")}); pass the work item id instead.`,
			);
		}
		return items[0].id;
	}

	private async process(
		request: ProcessRequest,
		options: { throwOnError?: boolean; signal?: AbortSignal },
	): Promise<ApprovalResult> {
		const body = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
		const result = await this.send(request, body, options.signal);
		if (options.throwOnError !== false && !result.success) {
			throw new SalesforceSaveError(`Approval ${request.actionType} failed`, [result], result.errors ?? []);
		}
		return result;
	}

	/**
	 * Sends one approval request. Failures such as `NO_APPLICABLE_PROCESS` or `ALREADY_IN_PROCESS`
	 * come back as HTTP 400 with an error array; they become an unsuccessful result.
	 */
	private async send(
		request: ProcessRequest,
		body: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<ApprovalResult> {
		let raw: (ApprovalResult & { newWorkItemIds?: string[] }) | undefined;
		try {
			[raw] = await this._connection.request<(ApprovalResult & { newWorkItemIds?: string[] })[]>({
				method: "POST",
				path: "/process/approvals/",
				body: { requests: [body] },
				signal,
			});
		} catch (error) {
			if (error instanceof SalesforceError && error.status === 400 && error.errors.length > 0) {
				return {
					actorIds: [],
					entityId: request.contextId,
					errors: error.errors.map((item) => ({
						statusCode: item.errorCode,
						message: item.message,
						fields: item.fields ?? [],
					})),
					instanceId: "",
					instanceStatus: "",
					newWorkitemIds: [],
					success: false,
				};
			}
			throw error;
		}
		if (!raw) {
			throw new Error(`Approval ${request.actionType} returned no result.`);
		}
		const { newWorkItemIds, ...rest } = raw;
		return { ...rest, newWorkitemIds: rest.newWorkitemIds ?? newWorkItemIds ?? [] };
	}
}

function requireId(id: string): string {
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error("A record or work item id is required.");
	}
	return id;
}
