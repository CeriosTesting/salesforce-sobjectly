import type { CodegenField } from "./type-mapper";

/** Helpers shared by the modules that emit generated source. */

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Fields sorted by name, `Id` first, so the output is deterministic. */
export function sortedFields(describe: { readonly fields: readonly CodegenField[] }): CodegenField[] {
	return [...describe.fields].sort((a, b) => (a.name === "Id" ? -1 : b.name === "Id" ? 1 : compare(a.name, b.name)));
}

/** An object key: the bare name when it is an identifier, otherwise a quoted string. */
export function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

export function escapeComment(value: string | null | undefined): string {
	return String(value ?? "")
		.replace(/\*\//g, "*\\/")
		.replace(/\r?\n/g, " ");
}

export function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
