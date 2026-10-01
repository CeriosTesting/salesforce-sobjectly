/** Every field `type` a describe call can report. */
export type FieldType =
	| "id"
	| "boolean"
	| "string"
	| "textarea"
	| "picklist"
	| "multipicklist"
	| "combobox"
	| "reference"
	| "currency"
	| "double"
	| "percent"
	| "int"
	| "long"
	| "date"
	| "datetime"
	| "time"
	| "url"
	| "email"
	| "phone"
	| "encryptedstring"
	| "base64"
	| "address"
	| "location"
	| "anyType"
	| "complexvalue"
	| "datacategorygroupreference";

export interface PicklistEntry {
	active: boolean;
	defaultValue: boolean;
	label: string | null;
	validFor: string | null;
	value: string;
}

export interface FieldDescribe {
	name: string;
	label: string;
	/** Usually a {@link FieldType}; typed as `string` because Salesforce adds types over time. */
	type: FieldType | (string & {});
	soapType: string;
	length: number;
	byteLength: number;
	precision: number;
	scale: number;
	digits: number;
	nillable: boolean;
	createable: boolean;
	updateable: boolean;
	defaultedOnCreate: boolean;
	defaultValue: unknown;
	defaultValueFormula: string | null;
	calculated: boolean;
	calculatedFormula: string | null;
	autoNumber: boolean;
	unique: boolean;
	externalId: boolean;
	idLookup: boolean;
	nameField: boolean;
	caseSensitive: boolean;
	filterable: boolean;
	sortable: boolean;
	groupable: boolean;
	aggregatable: boolean;
	custom: boolean;
	deprecatedAndHidden: boolean;
	encrypted: boolean;
	htmlFormatted: boolean;
	inlineHelpText: string | null;
	picklistValues: PicklistEntry[];
	restrictedPicklist: boolean;
	dependentPicklist: boolean;
	controllerName: string | null;
	/** Non-empty only for lookup and master-detail fields. More than one entry means a polymorphic lookup. */
	referenceTo: string[];
	/** The relationship name used for SOQL traversal, e.g. `"Account"` for `AccountId`. */
	relationshipName: string | null;
	relationshipOrder: number | null;
	polymorphicForeignKey: boolean;
	cascadeDelete: boolean;
	restrictedDelete: boolean;
	writeRequiresMasterRead: boolean;
	compoundFieldName: string | null;
	extraTypeInfo: string | null;
	[key: string]: unknown;
}

export interface ChildRelationship {
	cascadeDelete: boolean;
	/** API name of the child sObject, e.g. `"Case"` for Account's `Cases` relationship. */
	childSObject: string;
	deprecatedAndHidden: boolean;
	/** The field on the child that points to this sObject. */
	field: string;
	junctionIdListNames: string[];
	junctionReferenceTo: string[];
	/** The name used in a nested SOQL subquery, e.g. `"Cases"`; `null` when not queryable. */
	relationshipName: string | null;
	restrictedDelete: boolean;
}

export interface RecordTypeInfo {
	active: boolean;
	available: boolean;
	defaultRecordTypeMapping: boolean;
	developerName: string;
	master: boolean;
	name: string;
	recordTypeId: string;
	urls: Record<string, string>;
}

/** An entry of the `/sobjects` (describe global) response. */
export interface DescribeGlobalSObject {
	activateable: boolean;
	createable: boolean;
	custom: boolean;
	customSetting: boolean;
	deletable: boolean;
	deprecatedAndHidden: boolean;
	feedEnabled: boolean;
	hasSubtypes: boolean;
	isInterface: boolean;
	isSubtype: boolean;
	keyPrefix: string | null;
	label: string;
	labelPlural: string;
	layoutable: boolean;
	mergeable: boolean;
	mruEnabled: boolean;
	name: string;
	queryable: boolean;
	replicateable: boolean;
	retrieveable: boolean;
	searchable: boolean;
	triggerable: boolean;
	undeletable: boolean;
	updateable: boolean;
	urls: Record<string, string>;
	[key: string]: unknown;
}

export interface DescribeGlobalResult {
	encoding: string;
	maxBatchSize: number;
	sobjects: DescribeGlobalSObject[];
}

/** The `/sobjects/{name}/describe` response. */
export interface DescribeSObjectResult extends DescribeGlobalSObject {
	childRelationships: ChildRelationship[];
	fields: FieldDescribe[];
	recordTypeInfos: RecordTypeInfo[];
	compactLayoutable: boolean;
	listviewable: boolean | null;
	lookupLayoutable: boolean | null;
	searchLayoutable: boolean;
	networkScopeFieldName: string | null;
	supportedScopes: { label: string; name: string }[];
	actionOverrides: unknown[];
	namedLayoutInfos: unknown[];
}

/** The `/sobjects/{name}` (basic information) response. */
export interface SObjectBasicInfo {
	objectDescribe: DescribeGlobalSObject;
	recentItems: Record<string, unknown>[];
}
