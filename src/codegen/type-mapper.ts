import type { FieldDescribe } from "../types/describe";

import type { PicklistMode } from "./config";

/** The subset of a field describe the generator needs. */
export type CodegenField = Pick<
	FieldDescribe,
	| "name"
	| "label"
	| "type"
	| "nillable"
	| "createable"
	| "updateable"
	| "defaultedOnCreate"
	| "referenceTo"
	| "relationshipName"
> &
	Partial<Pick<FieldDescribe, "picklistValues" | "restrictedPicklist" | "externalId" | "idLookup">>;

export const ADDRESS_TYPE = "SalesforceAddress";
export const GEOLOCATION_TYPE = "SalesforceGeolocation";

/** Maps each Salesforce field type to a TypeScript type. Types not listed become `unknown`. */
export const FIELD_TYPE_MAP: Readonly<Record<string, string>> = {
	boolean: "boolean",
	int: "number",
	long: "number",
	double: "number",
	currency: "number",
	percent: "number",
	/** ISO date, `yyyy-MM-dd`. */
	date: "string",
	/** ISO date-time, e.g. `2026-01-31T12:00:00.000+0000`. */
	datetime: "string",
	/** `HH:mm:ss.SSSZ`. */
	time: "string",
	id: "string",
	reference: "string",
	string: "string",
	textarea: "string",
	picklist: "string",
	/** Values separated by `;`. */
	multipicklist: "string",
	combobox: "string",
	email: "string",
	phone: "string",
	url: "string",
	encryptedstring: "string",
	/** Base64-encoded content. */
	base64: "string",
	address: ADDRESS_TYPE,
	location: GEOLOCATION_TYPE,
};

/** Returns the TypeScript type for a field, including `| null` for nillable fields. */
export function mapFieldType(field: CodegenField, picklists: PicklistMode = "union"): string {
	const base = picklistType(field, picklists) ?? FIELD_TYPE_MAP[field.type] ?? "unknown";
	return field.nillable && base !== "unknown" ? `${base} | null` : base;
}

function picklistType(field: CodegenField, picklists: PicklistMode): string | undefined {
	if (picklists !== "union" || (field.type !== "picklist" && field.type !== "combobox")) {
		return undefined;
	}
	const values = [...new Set((field.picklistValues ?? []).filter((entry) => entry.active).map((entry) => entry.value))];
	if (values.length === 0) {
		return undefined;
	}
	const union = values.map((value) => JSON.stringify(value)).join(" | ");
	return field.restrictedPicklist && field.type === "picklist" ? union : `${union} | (string & {})`;
}
