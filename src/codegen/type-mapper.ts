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

/**
 * Returns the TypeScript type for a field, including `| null` for nillable fields. With picklist
 * mode `"const"` or `"enum"`, `typeName` is the field's named picklist type; it replaces the union.
 */
export function mapFieldType(field: CodegenField, picklists: PicklistMode = "union", typeName?: string): string {
	const base = picklistType(field, picklists, typeName) ?? FIELD_TYPE_MAP[field.type] ?? "unknown";
	return field.nillable && base !== "unknown" ? `${base} | null` : base;
}

function picklistType(field: CodegenField, picklists: PicklistMode, typeName: string | undefined): string | undefined {
	if (picklists === "string" || (field.type !== "picklist" && field.type !== "combobox")) {
		return undefined;
	}
	const values = activePicklistValues(field);
	if (values.length === 0) {
		return undefined;
	}
	const members =
		picklists !== "union" && typeName !== undefined
			? typeName
			: values.map((value) => JSON.stringify(value)).join(" | ");
	return field.restrictedPicklist && field.type === "picklist" ? members : `${members} | (string & {})`;
}

/** The distinct active values of a picklist, multi-select picklist or combobox, in describe order. */
export function activePicklistValues(field: CodegenField): string[] {
	if (field.type !== "picklist" && field.type !== "multipicklist" && field.type !== "combobox") {
		return [];
	}
	return [...new Set((field.picklistValues ?? []).filter((entry) => entry.active).map((entry) => entry.value))];
}
