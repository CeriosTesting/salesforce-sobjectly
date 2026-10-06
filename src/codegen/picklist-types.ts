import type { PicklistMode } from "./config";
import { compare, escapeComment, IDENTIFIER, propertyKey, sortedFields } from "./emit";
import type { CodegenDescribe } from "./generator";
import { activePicklistValues, type CodegenField } from "./type-mapper";

/** The picklist modes that emit a named type per picklist. */
export type NamedPicklistMode = Extract<PicklistMode, "const" | "enum">;

export function isNamedPicklistMode(mode: PicklistMode): mode is NamedPicklistMode {
	return mode === "const" || mode === "enum";
}

/** Named picklist types per sObject and field, e.g. `Case` -> `Status` -> `CaseStatus`. */
export type PicklistTypeNames = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Appended to a picklist type name that is already taken, e.g. by the `CaseStatus` sObject. */
const CLASH_SUFFIX = "Picklist";

/**
 * Names the type of every picklist with active values: sObject and field in PascalCase, e.g.
 * `Case.Status` -> `CaseStatus` and `Case.Status__c` -> `CaseStatusCustom`. A name that is in
 * `taken` (the sObjects and other names the file defines) or already used by another picklist gets
 * the suffix `Picklist`; when that is taken too, this throws.
 */
export function picklistTypeNames(
	describes: readonly CodegenDescribe[],
	taken: ReadonlySet<string>,
): PicklistTypeNames {
	// Name -> the picklist that uses it, or undefined for names the file defines otherwise.
	const used = new Map<string, string | undefined>([...taken].map((name) => [name, undefined]));
	const result = new Map<string, Map<string, string>>();
	for (const describe of [...describes].sort((a, b) => compare(a.name, b.name))) {
		const names = new Map<string, string>();
		for (const field of sortedFields(describe).filter((item) => activePicklistValues(item).length > 0)) {
			const base = `${pascalApiName(describe.name, "sobject")}${pascalApiName(field.name, "field")}`;
			if (IDENTIFIER.test(base)) {
				const picklist = `${describe.name}.${field.name}`;
				const name = resolveName(base, picklist, used);
				used.set(name, picklist);
				names.set(field.name, name);
			}
		}
		if (names.size > 0) {
			result.set(describe.name, names);
		}
	}
	return result;
}

function resolveName(base: string, picklist: string, used: ReadonlyMap<string, string | undefined>): string {
	const name = used.has(base) ? `${base}${CLASH_SUFFIX}` : base;
	if (used.has(name)) {
		const owner = used.get(name);
		const other = owner === undefined ? "a type the generated file defines" : `the picklist type for ${owner}`;
		throw new Error(
			`The picklist type "${name}" for ${picklist} clashes with ${other}; exclude one of the sObjects or use picklists: "union".`,
		);
	}
	return name;
}

/**
 * An API name in PascalCase without underscores. A field's `__c` becomes `Custom`
 * (`Lead_Source__c` -> `LeadSourceCustom`) and an sObject's is dropped (`My_Object__c` ->
 * `MyObject`). Other suffixes are kept: `Foo__pc` -> `FooPc`, `Config__mdt` -> `ConfigMdt`.
 */
export function pascalApiName(name: string, kind: "sobject" | "field"): string {
	const match = /^(.+?)__([a-z]+)$/.exec(name);
	const body = match ? match[1] : name;
	const suffix = match ? match[2] : "";
	const suffixPart = suffix === "c" ? (kind === "field" ? "Custom" : "") : capitalize(suffix);
	const bodyPart = body
		.split("_")
		.filter((part) => part.length > 0)
		.map(capitalize)
		.join("");
	return `${bodyPart}${suffixPart}`;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The member names for a picklist's values, in the same order. A value that is an identifier is
 * its own name; other values are sanitized (`"Closed Won"` -> `Closed_Won`, `"3rd Party"` ->
 * `_3rd_Party`). When the sanitized name is empty or taken, the value itself is the (quoted) name.
 */
export function picklistMemberKeys(values: readonly string[], mode: NamedPicklistMode): string[] {
	const used = new Set<string>();
	const claim = (key: string): string => {
		used.add(key);
		return key;
	};
	// `__proto__` would set the prototype of the const object; enums can't have numeric member names.
	const usable = (key: string): boolean =>
		key.length > 0 && key !== "__proto__" && !used.has(key) && (mode === "const" || !isNumericName(key));
	// Identifier values claim their own name first, so a sanitized value can't take it.
	const own = values.map((value) => (IDENTIFIER.test(value) && usable(value) ? claim(value) : undefined));
	return values.map((value, index) => {
		const ownKey = own[index];
		if (ownKey !== undefined) {
			return ownKey;
		}
		const sanitized = sanitizeKey(value);
		if (usable(sanitized)) {
			return claim(sanitized);
		}
		if (usable(value)) {
			return claim(value);
		}
		let counter = 2;
		while (!usable(`${sanitized || "_"}_${counter}`)) {
			counter++;
		}
		return claim(`${sanitized || "_"}_${counter}`);
	});
}

function sanitizeKey(value: string): string {
	const key = value
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return /^[0-9]/.test(key) ? `_${key}` : key;
}

/** Names TypeScript rejects as enum members because they are numeric, e.g. `"1"` or `"-1"`. */
function isNumericName(key: string): boolean {
	const number = Number(key);
	return Number.isFinite(number) && String(number) === key;
}

/** The named type declarations for one sObject's picklists, in field order; `""` when there are none. */
export function picklistDeclarations(
	describe: CodegenDescribe,
	names: ReadonlyMap<string, string> | undefined,
	mode: NamedPicklistMode,
): string {
	if (!names) {
		return "";
	}
	return sortedFields(describe)
		.flatMap((field) => {
			const name = names.get(field.name);
			return name === undefined ? [] : [declaration(describe.name, field, name, mode)];
		})
		.join("\n\n");
}

function declaration(sobject: string, field: CodegenField, name: string, mode: NamedPicklistMode): string {
	const values = activePicklistValues(field);
	const keys = picklistMemberKeys(values, mode);
	const doc = `/** Active values of ${escapeComment(`${sobject}.${field.name}`)} (${escapeComment(field.type)}). */`;
	if (mode === "enum") {
		const members = values.map((value, index) => `\t${propertyKey(keys[index])} = ${JSON.stringify(value)},`);
		return [doc, `export enum ${name} {`, ...members, "}"].join("\n");
	}
	const members = values.map((value, index) => `\t${propertyKey(keys[index])}: ${JSON.stringify(value)},`);
	return [
		doc,
		`export const ${name} = {`,
		...members,
		"} as const;",
		`export type ${name} = (typeof ${name})[keyof typeof ${name}];`,
	].join("\n");
}
