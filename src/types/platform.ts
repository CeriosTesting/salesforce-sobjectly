import type { SaveError } from "./common";

// ─── Approvals ──────────────────────────────────────────────────────────────

export interface ApprovalProcessInfo {
	description: string | null;
	id: string;
	name: string;
	object: string;
	sortOrder: number;
}

export interface ApprovalResult {
	actorIds: string[];
	entityId: string;
	errors: SaveError[] | null;
	instanceId: string;
	instanceStatus: "Approved" | "Rejected" | "Removed" | "Pending" | (string & {});
	/** Ids of the new work items (normalised from `newWorkitemIds` / `newWorkItemIds`). */
	newWorkitemIds: string[];
	success: boolean;
}

export interface PendingApprovalWorkItem {
	/** The ProcessInstanceWorkitem id (`04i...`), used to approve or reject. */
	id: string;
	actorId: string;
	processInstanceId: string;
	targetObjectId: string;
}

// ─── Quick actions ──────────────────────────────────────────────────────────

export interface QuickActionSummary {
	actionEnumOrId: string;
	label: string;
	name: string;
	type: string;
	urls?: Record<string, string>;
}

export interface QuickActionDescribe {
	name: string;
	label: string;
	type: string;
	targetSobjectType: string | null;
	targetParentField: string | null;
	targetRecordTypeId: string | null;
	contextSobjectType: string | null;
	defaultValues: { field: string; defaultValue: unknown }[] | null;
	layout: unknown;
	[key: string]: unknown;
}

export interface QuickActionResult {
	success: boolean;
	created: boolean;
	id?: string;
	ids: string[];
	contextId?: string;
	feedItemIds: string[] | null;
	successMessage: string | null;
	errors: SaveError[];
}

// ─── UI API ─────────────────────────────────────────────────────────────────

export interface UiFieldInfo {
	apiName: string;
	label: string;
	dataType: string;
	required: boolean;
	createable: boolean;
	updateable: boolean;
	custom: boolean;
	calculated: boolean;
	nameField: boolean;
	reference: boolean;
	referenceToInfos: { apiName: string; nameFields: string[] }[];
	relationshipName: string | null;
	controllerName: string | null;
	length: number;
	precision: number;
	scale: number;
	[key: string]: unknown;
}

export interface UiRecordTypeInfo {
	available: boolean;
	defaultRecordTypeMapping: boolean;
	master: boolean;
	name: string;
	recordTypeId: string;
}

export interface ObjectInfo {
	apiName: string;
	label: string;
	labelPlural: string;
	keyPrefix: string | null;
	custom: boolean;
	createable: boolean;
	updateable: boolean;
	deletable: boolean;
	queryable: boolean;
	nameFields: string[];
	/** The master record type (`012000000000000AAA`) when there is no other default. */
	defaultRecordTypeId: string | null;
	recordTypeInfos: Record<string, UiRecordTypeInfo>;
	dependentFields: Record<string, unknown>;
	fields: Record<string, UiFieldInfo>;
	childRelationships: unknown[];
	[key: string]: unknown;
}

export interface PicklistValue {
	label: string;
	value: string;
	/** Indexes into the controlling field's `controllerValues`. */
	validFor: number[];
	attributes: Record<string, unknown> | null;
}

export interface PicklistValues {
	controllerValues: Record<string, number>;
	defaultValue: PicklistValue | null;
	values: PicklistValue[];
	url: string;
	eTag?: string;
}

export interface UiFieldValue<T = unknown> {
	displayValue: string | null;
	value: T;
}

/** A UI API record. `fields` is typed when the record was loaded with typed field names. */
export interface UiRecord<TFields extends object = Record<string, UiFieldValue>> {
	apiName: string;
	id: string;
	fields: TFields;
	childRelationships: Record<string, unknown>;
	lastModifiedById: string | null;
	lastModifiedDate: string | null;
	recordTypeId: string | null;
	recordTypeInfo: UiRecordTypeInfo | null;
	systemModstamp: string | null;
	eTag?: string;
	weakEtag?: number;
}

export interface UiLayoutComponent {
	apiName: string | null;
	componentType: "Field" | "Canvas" | "CustomLink" | "EmptySpace" | "ReportChart" | "VisualforcePage" | (string & {});
	label: string;
}

export interface UiLayout {
	id: string;
	layoutType: string;
	mode: string;
	objectApiName: string;
	recordTypeId: string;
	sections: {
		collapsible: boolean;
		columns: number;
		heading: string;
		id: string;
		rows: number;
		useHeading: boolean;
		layoutRows: {
			layoutItems: {
				editableForNew: boolean;
				editableForUpdate: boolean;
				label: string;
				required: boolean;
				layoutComponents: UiLayoutComponent[];
			}[];
		}[];
	}[];
	[key: string]: unknown;
}

// ─── Reports ────────────────────────────────────────────────────────────────

export interface ReportSummary {
	id: string;
	name: string;
	url: string;
	describeUrl: string;
	instancesUrl: string;
}

export interface ReportFilter {
	column: string;
	operator:
		| "equals"
		| "notEqual"
		| "lessThan"
		| "greaterThan"
		| "lessOrEqual"
		| "greaterOrEqual"
		| "contains"
		| "notContain"
		| "startsWith"
		| "includes"
		| "excludes"
		| "within"
		| (string & {});
	value: string;
	isRunPageEditable?: boolean;
}

export interface ReportMetadata {
	id: string;
	name: string;
	developerName: string;
	reportFormat: "TABULAR" | "SUMMARY" | "MATRIX" | "MULTI_BLOCK";
	detailColumns: string[];
	aggregates: string[];
	reportFilters: ReportFilter[];
	reportBooleanFilter: string | null;
	groupingsDown: { name: string; dateGranularity: string; sortOrder: string }[];
	groupingsAcross: { name: string; dateGranularity: string; sortOrder: string }[];
	hasDetailRows: boolean;
	[key: string]: unknown;
}

export interface ReportDataCell {
	label: string;
	value: unknown;
}

export interface ReportFact {
	aggregates: ReportDataCell[];
	rows?: { dataCells: ReportDataCell[] }[];
}

export interface ReportExtendedMetadata {
	aggregateColumnInfo: Record<string, { label: string; dataType: string }>;
	detailColumnInfo: Record<string, { label: string; dataType: string }>;
	groupingColumnInfo: Record<string, { label: string; dataType: string; groupingLevel: number }>;
}

export interface ReportResult {
	attributes: { describeUrl: string; instancesUrl: string; reportId: string; reportName: string; type: string };
	allData: boolean;
	hasDetailRows: boolean;
	/** Keys like `"T!T"` (grand total), `"0!T"` (first grouping) or `"0_1!0"` (matrix cell). */
	factMap: Record<string, ReportFact>;
	groupingsDown: { groupings: unknown[] };
	groupingsAcross: { groupings: unknown[] };
	reportMetadata: ReportMetadata;
	reportExtendedMetadata: ReportExtendedMetadata;
	[key: string]: unknown;
}

export interface ReportDescribe {
	reportMetadata: ReportMetadata;
	reportExtendedMetadata: ReportExtendedMetadata;
	reportTypeMetadata: Record<string, unknown>;
}

export interface ReportInstance {
	id: string;
	status: "New" | "Running" | "Success" | "Error";
	url: string;
	ownerId: string;
	hasDetailRows: boolean;
	queryable: boolean;
	requestDate: string;
	completionDate: string | null;
}
