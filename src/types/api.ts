import type { GenericRecord, RestError, SaveError, WithAttributes } from "./common";

// ─── Org ────────────────────────────────────────────────────────────────────

export interface ApiVersionInfo {
	label: string;
	url: string;
	version: string;
}

export interface LimitInfo {
	Max: number;
	Remaining: number;
	/** Some limits nest per-app sub-limits, e.g. `DailyApiRequests["Salesforce CLI"]`. */
	[subLimit: string]: number | { Max: number; Remaining: number };
}

/** The `/limits` response, keyed by limit name (e.g. `DailyApiRequests`, `DataStorageMB`). */
export type KnownOrgLimit =
	| "ActiveScratchOrgs"
	| "ConcurrentAsyncGetReportInstances"
	| "ConcurrentSyncReportRuns"
	| "DailyAnalyticsDataflowJobExecutions"
	| "DailyApiRequests"
	| "DailyAsyncApexExecutions"
	| "DailyAsyncApexTests"
	| "DailyBulkApiBatches"
	| "DailyBulkV2QueryFileStorageMB"
	| "DailyBulkV2QueryJobs"
	| "DailyDeliveredPlatformEvents"
	| "DailyDurableGenericStreamingApiEvents"
	| "DailyDurableStreamingApiEvents"
	| "DailyGenericStreamingApiEvents"
	| "DailyScratchOrgs"
	| "DailyStandardVolumePlatformEvents"
	| "DailyStreamingApiEvents"
	| "DailyWorkflowEmails"
	| "DataStorageMB"
	| "FileStorageMB"
	| "HourlyAsyncReportRuns"
	| "HourlyDashboardRefreshes"
	| "HourlyDashboardResults"
	| "HourlyDashboardStatuses"
	| "HourlyLongTermIdMapping"
	| "HourlyPublishedPlatformEvents"
	| "HourlyPublishedStandardVolumePlatformEvents"
	| "HourlyShortTermIdMapping"
	| "HourlySyncReportRuns"
	| "HourlyTimeBasedWorkflow"
	| "MassEmail"
	| "MonthlyPlatformEventsUsageEntitlement"
	| "Package2VersionCreates"
	| "PermissionTypes"
	| "SingleEmail"
	| "StreamingApiConcurrentClients";

/** The `/limits` response, keyed by limit name. Well-known names autocomplete; others are allowed. */
export type OrgLimits = { [Name in KnownOrgLimit]?: LimitInfo } & Record<string, LimitInfo>;

// ─── Query plan ─────────────────────────────────────────────────────────────

export interface QueryPlan {
	cardinality: number;
	fields: string[];
	leadingOperationType: "Index" | "Other" | "Sharing" | "TableScan";
	notes: { description: string; fields: string[]; tableEnumOrId: string }[];
	/** Above 1 means the query is not selective. */
	relativeCost: number;
	sobjectCardinality: number;
	sobjectType: string;
}

export interface RecordCountResult {
	sObjects: { count: number; name: string }[];
}

export interface DeletedRecordsResult {
	deletedRecords: { id: string; deletedDate: string }[];
	earliestDateAvailable: string;
	latestDateCovered: string;
}

export interface UpdatedRecordsResult {
	ids: string[];
	latestDateCovered: string;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchResult<T = GenericRecord> {
	searchRecords: WithAttributes<T>[];
	metadata?: { entityMetadata: { entityName: string; fieldMetadata: { name: string; label: string }[] }[] };
}

export interface ParameterizedSearchSObject {
	name: string;
	fields?: string[];
	limit?: number;
	where?: string;
	orderBy?: string;
}

export interface ParameterizedSearchRequest {
	q: string;
	fields?: string[];
	sobjects?: ParameterizedSearchSObject[];
	in?: "ALL" | "NAME" | "EMAIL" | "PHONE" | "SIDEBAR";
	overallLimit?: number;
	defaultLimit?: number;
	offset?: number;
	division?: string;
	dataCategories?: { groupName: string; operator: string; categories: string[] }[];
	networkIds?: string[];
	metadata?: "LABELS";
	snippet?: string;
	spellCorrection?: boolean;
}

export interface SearchSuggestionsResult<T = GenericRecord> {
	autoSuggestResults: WithAttributes<T>[];
	hasMoreResults: boolean;
}

// ─── Composite ──────────────────────────────────────────────────────────────

export type CompositeMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface CompositeSubrequest {
	method: CompositeMethod;
	/** Must start with `/services/data/vXX.X/`. */
	url: string;
	referenceId: string;
	body?: unknown;
	httpHeaders?: Record<string, string>;
}

export interface CompositeSubrequestResult<T = unknown> {
	body: T | RestError[] | null;
	httpHeaders: Record<string, string>;
	httpStatusCode: number;
	referenceId: string;
}

export interface CompositeBatchSubrequest {
	method: CompositeMethod;
	/** Relative to the API version, e.g. `"sobjects/Account/001..."`. */
	url: string;
	richInput?: unknown;
	binaryPartName?: string;
	binaryPartNameAlias?: string;
}

export interface CompositeBatchSubrequestResult<T = unknown> {
	statusCode: number;
	result: T | RestError[] | null;
}

export interface CompositeBatchResult {
	hasErrors: boolean;
	/** In the order of the subrequests. */
	results: CompositeBatchSubrequestResult[];
}

export interface TreeSaveResult {
	hasErrors: boolean;
	results: { referenceId: string; id?: string; errors?: SaveError[] }[];
}

// ─── List views and layouts ─────────────────────────────────────────────────

export interface ListViewSummary {
	id: string;
	developerName: string;
	label: string;
	describeUrl: string;
	resultsUrl: string;
	soqlCompatible: boolean;
	url: string;
}

/** The `/sobjects/{name}/listviews` and `/listviews/recent` response. */
export interface ListViewsResult {
	done: boolean;
	listviews: ListViewSummary[];
	nextRecordsUrl: string | null;
	size: number;
	sobjectType: string;
}

export interface ListViewColumn {
	fieldNameOrPath: string;
	label: string;
	type: string;
	selectListItem: string;
	hidden: boolean;
	sortable: boolean;
	sortDirection: string | null;
	sortIndex: number | null;
	ascendingLabel: string | null;
	descendingLabel: string | null;
	[key: string]: unknown;
}

/** The `/sobjects/{name}/listviews/{id}/describe` response. */
export interface ListViewDescribe {
	id: string;
	sobjectType: string;
	/** The SOQL query behind the list view. */
	query: string;
	columns: ListViewColumn[];
	orderBy: { fieldNameOrPath: string; nullsPosition: string | null; sortDirection: string | null }[];
	scope: string | null;
	scopeEntityId?: string | null;
	whereCondition: unknown;
	[key: string]: unknown;
}

/** The `/sobjects/{name}/listviews/{id}/results` response. Values are formatted as strings. */
export interface ListViewResults {
	id: string;
	developerName: string;
	label: string;
	columns: ListViewColumn[];
	records: { columns: { fieldNameOrPath: string; value: string | null }[] }[];
	done: boolean;
	size: number;
}

/** One page layout, from `/sobjects/{name}/describe/layouts`. */
export interface DescribeLayout {
	id: string | null;
	buttonLayoutSection: unknown;
	detailLayoutSections: unknown[];
	editLayoutSections: unknown[];
	relatedLists: unknown[];
	[key: string]: unknown;
}

/** The `/sobjects/{name}/describe/layouts` response. */
export interface DescribeLayoutsResult {
	/** `null` when the object has more than one record type: get those layouts by record type id. */
	layouts: DescribeLayout[] | null;
	recordTypeMappings: {
		recordTypeId: string;
		name: string;
		layoutId: string;
		available: boolean;
		[key: string]: unknown;
	}[];
	recordTypeSelectorRequired: boolean[];
	[key: string]: unknown;
}

export interface CompactLayout {
	id: string | null;
	name: string;
	label: string;
	objectType: string;
	fieldItems: unknown[];
	imageItems: unknown[];
	actions: unknown[];
	[key: string]: unknown;
}

/** The `/sobjects/{name}/describe/compactLayouts` response. */
export interface CompactLayoutsResult {
	compactLayouts: CompactLayout[];
	defaultCompactLayoutId: string | null;
	recordTypeCompactLayoutMappings: {
		recordTypeId: string;
		recordTypeName: string;
		compactLayoutId: string | null;
		compactLayoutName: string;
		available: boolean;
		[key: string]: unknown;
	}[];
}

/** The `/sobjects/{name}/describe/approvalLayouts` response. */
export interface ApprovalLayoutsResult {
	approvalLayouts: { id: string; name: string; label: string; layoutItems: unknown[] }[];
}

/** A recently viewed record, from `/recent`. */
export type RecentItem = WithAttributes<{ Id: string; Name: string }>;

// ─── Invocable actions ──────────────────────────────────────────────────────

export interface ActionSummary {
	label: string;
	name: string;
	type: string;
	url?: string;
}

export interface ActionParameterDescribe {
	name: string;
	label: string;
	type: string;
	required: boolean;
	description: string | null;
	maxOccurs: number;
	sobjectType: string | null;
	picklistValues: unknown[] | null;
	[key: string]: unknown;
}

export interface ActionDescribe {
	name: string;
	label: string;
	type: string;
	description: string | null;
	category?: string;
	inputs: ActionParameterDescribe[];
	outputs: ActionParameterDescribe[];
	[key: string]: unknown;
}

export interface InvocableActionResult<TOutput = GenericRecord> {
	actionName: string;
	errors: SaveError[] | null;
	isSuccess: boolean;
	outputValues: TOutput | null;
	sortOrder?: number;
	version?: number;
	invocationId?: string | null;
}

// ─── Tooling ────────────────────────────────────────────────────────────────

export interface ExecuteAnonymousResult {
	line: number;
	column: number;
	compiled: boolean;
	success: boolean;
	compileProblem: string | null;
	exceptionMessage: string | null;
	exceptionStackTrace: string | null;
}

export interface RunTestsRequest {
	/** Comma-separated class ids, or use `tests`. */
	classids?: string;
	suiteids?: string;
	maxFailedTests?: number;
	testLevel?: "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";
	skipCodeCoverage?: boolean;
	tests?: { classId?: string; className?: string; testMethods?: string[] }[];
}

// ─── Bulk API 2.0 ───────────────────────────────────────────────────────────

export type BulkIngestOperation = "insert" | "update" | "upsert" | "delete" | "hardDelete";
export type BulkQueryOperation = "query" | "queryAll";
export type BulkJobState = "Open" | "UploadComplete" | "InProgress" | "JobComplete" | "Failed" | "Aborted";
export type BulkColumnDelimiter = "COMMA" | "TAB" | "PIPE" | "SEMICOLON" | "CARET" | "BACKQUOTE";
export type BulkLineEnding = "LF" | "CRLF";

export interface BulkJobInfo {
	id: string;
	operation: BulkIngestOperation | BulkQueryOperation;
	object: string;
	createdById: string;
	createdDate: string;
	systemModstamp: string;
	state: BulkJobState;
	concurrencyMode: string;
	contentType: "CSV";
	/** A number, e.g. `66.0`. */
	apiVersion: number;
	jobType?: string;
	lineEnding: BulkLineEnding;
	columnDelimiter: BulkColumnDelimiter;
	contentUrl?: string;
	externalIdFieldName?: string;
	assignmentRuleId?: string;
	numberRecordsProcessed?: number;
	numberRecordsFailed?: number;
	retries?: number;
	totalProcessingTime?: number;
	apiActiveProcessingTime?: number;
	apexProcessingTime?: number;
	errorMessage?: string;
	isPkChunkingSupported?: boolean;
	[key: string]: unknown;
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
	access_token: string;
	instance_url: string;
	id?: string;
	token_type?: string;
	/** Epoch milliseconds, as a string. */
	issued_at?: string;
	signature?: string;
	scope?: string;
	refresh_token?: string;
	id_token?: string;
	api_instance_url?: string;
}
