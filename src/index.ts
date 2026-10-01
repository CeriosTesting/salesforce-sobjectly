export { SalesforceClient } from "./client";
export type { ApexRestRequest, SalesforceClientOptions } from "./client";

export {
	accessToken,
	clientCredentials,
	createJwtAssertion,
	jwtBearer,
	refreshToken,
	tokenProvider,
} from "./auth/providers";
export type { ClientCredentialsOptions, JwtBearerOptions, RefreshTokenOptions } from "./auth/providers";
export { sfCli } from "./auth/sf-cli";
export type { RunCommand, SfCliOptions } from "./auth/sf-cli";
export type { AccessToken, AuthContext, AuthProvider } from "./auth/types";

export { isApiVersion, normalizeApiVersion } from "./api-version";
export { SalesforceConnection } from "./http/connection";
export type {
	ApiUsage,
	ConnectionOptions,
	QueryParamValue,
	RequestEvent,
	RequestHooks,
	ResponseEvent,
	ResponseType,
	RestRequest,
	RestResponse,
	RetryOptions,
} from "./http/connection";
export { fetchTransport } from "./http/fetch-transport";
export type { FetchTransportOptions } from "./http/fetch-transport";
export type {
	HttpMethod,
	HttpTransport,
	StreamingTransportResponse,
	TransportRequest,
	TransportResponse,
} from "./http/transport";

export {
	hasErrorCode,
	isSalesforceError,
	SalesforceAuthError,
	SalesforceBulkJobError,
	SalesforceError,
	SalesforcePartialFailureError,
	SalesforceSaveError,
} from "./errors";

export type {
	ChildRelationshipName,
	ChildSObjectName,
	ExternalIdField,
	FieldKind,
	FieldKindName,
	GenericRegistry,
	MultiPicklistField,
	ParentPath,
	ParentPathTarget,
	ParentRelationshipName,
	ParentSObjectName,
	PolymorphicRelationshipName,
	PolymorphicTargets,
	RecordTypeName,
	SObjectCreateInput,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
	SObjectRegistryEntry,
	SObjectUpdateInput,
} from "./registry";

export { soqlDate, soqlDateLiteral, soqlEscape, soqlEscapeDateOnly, soqlLiteral, soslEscape } from "./soql/escape";
export type { SoqlFixedDateLiteral, SoqlLiteral, SoqlRelativeDateLiteral, SoqlValue } from "./soql/escape";
export { isSObjectType, SoqlQueryBuilder, soqlFor, TypeOfBuilder } from "./soql/query-builder";
export type {
	NoSelection,
	SoqlChildQueryResult,
	SoqlDirection,
	SoqlNullOrder,
	SoqlQueryRecord,
} from "./soql/query-builder";
export type {
	NestPath,
	PathTarget,
	PolymorphicName,
	PolymorphicNameField,
	SoqlComparisonOperator,
	SoqlFieldValue,
	SoqlOperator,
	SoqlOperatorFor,
	SoqlScalar,
	SoqlWhereValue,
	TypedRecord,
} from "./soql/types";

export { MetadataCache } from "./cache";
export { buildMultipart } from "./http/multipart";
export type { MultipartPart } from "./http/multipart";
export { ActionsApi } from "./resources/actions";
export { ApprovalsApi } from "./resources/approvals";
export type { DecisionOptions, SubmitOptions } from "./resources/approvals";
export { FilesApi, MAX_JSON_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from "./resources/files";
export type {
	FileShareType,
	FileVisibility,
	NewVersionOptions,
	UploadedFile,
	UploadFileOptions,
} from "./resources/files";
export { QuickActionsApi } from "./resources/quick-actions";
export type { InvokeQuickActionOptions } from "./resources/quick-actions";
export { reportRows, ReportsApi } from "./resources/reports";
export type { ReportRow, RunReportOptions, WaitForReportOptions } from "./resources/reports";
export { UiApi } from "./resources/ui-api";
export type { UiLayoutOptions, UiRecordFields, UiRecordOptions } from "./resources/ui-api";
export type { CustomActionType, InvokeOptions } from "./resources/actions";
export { BulkApi, BulkIngestJob, BulkQueryJob } from "./resources/bulk";
export type {
	BulkCsvRecord,
	BulkIngestJobOptions,
	BulkIngestOptions,
	BulkIngestRecord,
	BulkQueryOptions,
	WaitOptions,
} from "./resources/bulk";
export { CollectionsApi } from "./resources/collections";
export type { CollectionOptions } from "./resources/collections";
export { CompositeApi, CompositeRequestBuilder, CompositeResponse } from "./resources/composite";
export type {
	CompositeBatchRequest,
	CompositeGraphInput,
	CompositeGraphResult,
	CompositeOptions,
	CompositeRawSubrequest,
	CompositeRef,
	SubrequestOptions,
	TreeChildRecord,
	TreeRecord,
} from "./resources/composite";
export { EventsApi, toPublishResult } from "./resources/events";
export type { PlatformEventName, PublishOptions, PublishResult } from "./resources/events";
export { parseCsv, parseCsvRows, toCsv } from "./resources/csv";
export type { CsvOptions } from "./resources/csv";
export { QueryApi } from "./resources/query";
export type { QueryCursor, QueryOptions, QueryResult } from "./resources/query";
export { SearchApi } from "./resources/search";
export type { SearchSuggestionsOptions } from "./resources/search";
export { SObjectResource } from "./resources/sobject";
export type { PicklistOption, RequestSignal, UpsertOutcome } from "./resources/sobject";
export { ApexExecutionError, ToolingApi } from "./resources/tooling";
export type { ExecuteAnonymousOptions, RunTestsResult } from "./resources/tooling";
export { DEBUG_LEVEL_NAME, DEFAULT_DEBUG_LEVELS, DebugLogCaptureError, DebugLogsApi } from "./resources/debug-logs";
export type {
	ApexLogEntry,
	CaptureLogsOptions,
	CaptureLogsResult,
	DebugLevels,
	LogLevel,
} from "./resources/debug-logs";
export { CsvRowParser, parseCsvStream } from "./resources/csv";

export type * from "./types/api";
export type * from "./types/common";
export type * from "./types/describe";
export type * from "./types/error-codes";
export type * from "./types/platform";
