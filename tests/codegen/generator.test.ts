import { describe, expect, it } from "vitest";

import { type CodegenDescribe, generateSource, readGeneratedHashes } from "../../src/codegen/generator";
import { FIELD_TYPE_MAP, mapFieldType, type CodegenField } from "../../src/codegen/type-mapper";
import type { PicklistEntry } from "../../src/types/describe";
import { describes } from "../fixtures/describes";

function field(type: string, overrides: Partial<CodegenField> = {}): CodegenField {
	return {
		name: "Field__c",
		label: "Field",
		type,
		nillable: false,
		createable: true,
		updateable: true,
		defaultedOnCreate: false,
		referenceTo: [],
		relationshipName: null,
		...overrides,
	};
}

describe("mapFieldType", () => {
	it.each([
		["boolean", "boolean"],
		["int", "number"],
		["long", "number"],
		["double", "number"],
		["currency", "number"],
		["percent", "number"],
		["date", "string"],
		["datetime", "string"],
		["time", "string"],
		["base64", "string"],
		["address", "SalesforceAddress"],
		["location", "SalesforceGeolocation"],
		["reference", "string"],
		["picklist", "string"],
		["multipicklist", "string"],
		["textarea", "string"],
		["string", "string"],
		["email", "string"],
		["phone", "string"],
		["url", "string"],
		["id", "string"],
		["combobox", "string"],
		["encryptedstring", "string"],
		["anyType", "unknown"],
		["complexvalue", "unknown"],
		["somethingNew", "unknown"],
	])("maps %s to %s", (type, expected) => {
		expect(mapFieldType(field(type))).toBe(expected);
	});

	it("adds | null for nillable fields but not to unknown", () => {
		expect(mapFieldType(field("string", { nillable: true }))).toBe("string | null");
		expect(mapFieldType(field("anyType", { nillable: true }))).toBe("unknown");
	});

	it("covers every documented type in FIELD_TYPE_MAP", () => {
		expect(Object.keys(FIELD_TYPE_MAP).sort()).toMatchInlineSnapshot(`
			[
			  "address",
			  "base64",
			  "boolean",
			  "combobox",
			  "currency",
			  "date",
			  "datetime",
			  "double",
			  "email",
			  "encryptedstring",
			  "id",
			  "int",
			  "location",
			  "long",
			  "multipicklist",
			  "percent",
			  "phone",
			  "picklist",
			  "reference",
			  "string",
			  "textarea",
			  "time",
			  "url",
			]
		`);
	});

	it("types restricted picklists as a strict union and others as an open union", () => {
		const values = ["A", "B'"].map((value) => ({
			active: true,
			defaultValue: false,
			label: value,
			validFor: null,
			value,
		}));
		const inactive = { active: false, defaultValue: false, label: "Old", validFor: null, value: "Old" };
		expect(mapFieldType(field("picklist", { picklistValues: [...values, inactive], restrictedPicklist: true }))).toBe(
			'"A" | "B\'"',
		);
		expect(mapFieldType(field("picklist", { picklistValues: values }))).toBe('"A" | "B\'" | (string & {})');
		expect(mapFieldType(field("picklist", { picklistValues: values }), "string")).toBe("string");
		expect(mapFieldType(field("picklist", { picklistValues: [], restrictedPicklist: true }))).toBe("string");
	});

	it("uses the named picklist type in const and enum mode", () => {
		const values = ["A", "B"].map((value) => ({
			active: true,
			defaultValue: false,
			label: value,
			validFor: null,
			value,
		}));
		const restricted = field("picklist", { picklistValues: values, restrictedPicklist: true, nillable: true });
		expect(mapFieldType(restricted, "const", "CaseStatus")).toBe("CaseStatus | null");
		expect(mapFieldType(restricted, "enum", "CaseStatus")).toBe("CaseStatus | null");
		expect(mapFieldType(field("combobox", { picklistValues: values }), "const", "CaseChannel")).toBe(
			"CaseChannel | (string & {})",
		);
		// Without a type name, or in the other modes, the name is not used.
		expect(mapFieldType(restricted, "const")).toBe('"A" | "B" | null');
		expect(mapFieldType(restricted, "union", "CaseStatus")).toBe('"A" | "B" | null');
		expect(mapFieldType(restricted, "string", "CaseStatus")).toBe("string | null");
		expect(mapFieldType(field("multipicklist", { picklistValues: values }), "const", "Interests")).toBe("string");
	});
});

describe("generateSource", () => {
	const options = { importSource: "../../src/index", apiVersion: "v67.0" as const };

	it("matches the generated fixture", async () => {
		await expect(generateSource(describes, options)).toMatchFileSnapshot("../fixtures/generated-sobjects.ts");
	});

	it.each(["const", "enum"] as const)("matches the generated fixture with picklists: %s", async (picklists) => {
		await expect(generateSource(describes, { ...options, picklists })).toMatchFileSnapshot(
			`../fixtures/generated-sobjects-${picklists}.ts`,
		);
	});

	it.each(["union", "const", "enum"] as const)(
		"is deterministic regardless of input order (picklists: %s)",
		(picklists) => {
			const reversed = [...describes]
				.reverse()
				.map((describe) => ({ ...describe, fields: [...describe.fields].reverse() }));
			expect(generateSource(reversed, { ...options, picklists })).toBe(
				generateSource(describes, { ...options, picklists }),
			);
		},
	);

	it("requires createable, non-nillable fields without a default on create", () => {
		const source = generateSource(describes, options);
		expect(source).toContain('export type ContactCreateInput = Pick<Contact, "LastName"> & Partial<Pick<Contact,');
		expect(source).toContain('export type CaseCreateInput = Partial<Pick<Case, "AccountId"');
	});

	it("honours excludeCreateFields and excludeUpdateFields", () => {
		const source = generateSource(describes, {
			...options,
			excludeCreateFields: { Contact: ["LastName", "Email"] },
			excludeUpdateFields: { Contact: ["Email"] },
		});
		const create = source.split("\n").find((line) => line.startsWith("export type ContactCreateInput"));
		const update = source.split("\n").find((line) => line.startsWith("export type ContactUpdateInput"));
		expect(create).not.toContain('"LastName"');
		expect(create).not.toContain('"Email"');
		expect(update).toContain('"LastName"');
		expect(update).not.toContain('"Email"');
	});

	it("puts polymorphic lookups in polymorphicParents and skips relationships outside the set", () => {
		const source = generateSource(describes, options);
		const caseEntry = source.slice(source.indexOf("\tCase: {"), source.indexOf("\tContact: {"));
		const parents = caseEntry.slice(caseEntry.indexOf("parents:"), caseEntry.indexOf("children:"));
		expect(parents).not.toContain("Owner:");
		expect(caseEntry).toContain('polymorphicParents: {\n\t\t\tOwner: "Group" | "User";\n\t\t}');
		expect(source).not.toContain("Histories");
	});

	it("records external ids, field kinds and record types", () => {
		const source = generateSource(describes, options);
		expect(source).toContain('externalIds: "External_Id__c" | "Id";');
		expect(source).toContain('externalIds: "Id" | "Username";');
		expect(source).toContain('Birthdate: "date";');
		expect(source).toContain('Interests__c: "multipicklist";');
		expect(source).toContain('recordTypes: "Complaint" | "Master" | "Question";');
		expect(source).toContain('What: "Account" | "Case" | "Opportunity";');
	});

	it("emits runtime constants unless disabled", () => {
		const source = generateSource(describes, options);
		expect(source).toContain('Status: ["New", "Working", "Closed"],');
		expect(source).toContain('Case: ["Complaint", "Master", "Question"],');
		const without = generateSource(describes, { ...options, constants: false });
		expect(without).not.toContain("PICKLIST_VALUES");
		expect(without).not.toContain("RECORD_TYPES");
	});

	it("emits Record<string, never> when nothing is settable", () => {
		const source = generateSource([
			{
				name: "Readonly__c",
				fields: [field("id", { name: "Id", createable: false, updateable: false })],
				childRelationships: [],
			},
		]);
		expect(source).toContain("export type Readonly__cCreateInput = Record<string, never>;");
		expect(source).not.toContain("import type");
	});

	it("exports API_VERSION only when an API version is given", () => {
		expect(generateSource(describes, options)).toContain('export const API_VERSION = "v67.0";');
		expect(generateSource(describes)).not.toContain("API_VERSION");
	});

	it("rejects sObject names that are not identifiers", () => {
		expect(() => generateSource([{ name: "Bad-Name", fields: [], childRelationships: [] }])).toThrow(
			/not a valid TypeScript identifier/,
		);
	});
});

describe("generateSource name checks", () => {
	const sobject = (name: string): CodegenDescribe => ({
		name,
		fields: [field("id", { name: "Id", createable: false, updateable: false })],
		childRelationships: [],
	});

	it.each([
		"Record",
		"Pick",
		"Partial",
		"SObjectRegistry",
		"PICKLIST_VALUES",
		"RECORD_TYPES",
		"API_VERSION",
		"SalesforceAddress",
		"SalesforceGeolocation",
	])("rejects the reserved type name %s", (name) => {
		expect(() => generateSource([sobject("Account"), sobject(name)])).toThrow(
			`sObject name "${name}" clashes with a type the generated file defines; exclude it.`,
		);
	});

	it("rejects an sObject named like another sObject's input type", () => {
		expect(() => generateSource([sobject("Foo"), sobject("FooCreateInput")])).toThrow(
			'sObject name "FooCreateInput" clashes with a type the generated file defines; exclude it.',
		);
		expect(() => generateSource([sobject("Foo"), sobject("FooUpdateInput")])).toThrow(/"FooUpdateInput" clashes/);
	});

	it("rejects sObjects that differ only in case", () => {
		expect(() => generateSource([sobject("Account"), sobject("ACCOUNT")])).toThrow(
			'sObjects "ACCOUNT" and "Account" differ only in case; list each sObject once.',
		);
	});

	it("accepts names that only resemble reserved names", () => {
		expect(() => generateSource([sobject("Record__c"), sobject("Picklist_Values__c")])).not.toThrow();
	});
});

describe("generateSource field excludes", () => {
	const options = { importSource: "../../src/index", apiVersion: "v67.0" as const };
	const line = (source: string, prefix: string): string =>
		source.split("\n").find((item) => item.startsWith(prefix)) ?? "";

	it("matches the sObject key and the field names case-insensitively", () => {
		const source = generateSource(describes, {
			...options,
			excludeCreateFields: { contact: ["lastname", "EMAIL"] },
			excludeUpdateFields: { CONTACT: ["email"] },
		});
		const create = line(source, "export type ContactCreateInput");
		const update = line(source, "export type ContactUpdateInput");
		expect(create).not.toContain('"LastName"');
		expect(create).not.toContain('"Email"');
		expect(update).toContain('"LastName"');
		expect(update).not.toContain('"Email"');
	});

	it("generates the same output for differently cased excludes", () => {
		expect(generateSource(describes, { ...options, excludeCreateFields: { contact: ["lastname"] } })).toBe(
			generateSource(describes, { ...options, excludeCreateFields: { Contact: ["LastName"] } }),
		);
	});
});

describe("generateSource picklist constants", () => {
	const options = { importSource: "../../src/index", apiVersion: "v67.0" as const };
	const value = (text: string, active = true): PicklistEntry => ({
		active,
		defaultValue: false,
		label: text,
		validFor: null,
		value: text,
	});
	const withAccountType = (values: PicklistEntry[]): CodegenDescribe[] =>
		describes.map((describe) =>
			describe.name === "Account"
				? {
						...describe,
						fields: describe.fields.map((item) => (item.name === "Type" ? { ...item, picklistValues: values } : item)),
					}
				: describe,
		);

	it("lists active, unique values of picklist, multi-select and combobox fields", () => {
		const source = generateSource(withAccountType([value("B"), value("A"), value("Old", false), value("B")]), options);
		const constants = source.slice(source.indexOf("export const PICKLIST_VALUES"));
		expect(constants).toContain('\tAccount: {\n\t\tIndustry: ["Banking", "Energy"],\n\t\tType: ["B", "A"],\n\t},');
		expect(constants).not.toContain('"Old"');
		expect(constants).toContain('Interests__c: ["Golf", "Tennis"],');
		expect(constants).toContain('Channel__c: ["Web", "Phone"],');
		expect(constants).not.toMatch(/\tUser: \{/);
	});

	it("changes the sObject's hash when only its picklist values change", () => {
		// With string picklists the values only appear in PICKLIST_VALUES.
		const before = generateSource(describes, { ...options, picklists: "string" });
		const after = generateSource(withAccountType([value("Customer"), value("Partner"), value("Prospect")]), {
			...options,
			picklists: "string",
		});
		expect(after).toContain('Type: ["Customer", "Partner", "Prospect"],');
		const beforeHashes = readGeneratedHashes(before);
		const afterHashes = readGeneratedHashes(after);
		expect(afterHashes?.contentHash).not.toBe(beforeHashes?.contentHash);
		expect(afterHashes?.sobjects.get("Account")).not.toBe(beforeHashes?.sobjects.get("Account"));
		for (const name of ["Case", "Contact", "Order_Shipped__e", "Task", "User"]) {
			expect(afterHashes?.sobjects.get(name)).toBe(beforeHashes?.sobjects.get(name));
		}
	});

	it("leaves the hashes alone for picklist value changes when constants are disabled", () => {
		const before = generateSource(describes, { ...options, picklists: "string", constants: false });
		const after = generateSource(withAccountType([value("Customer"), value("Prospect")]), {
			...options,
			picklists: "string",
			constants: false,
		});
		expect(readGeneratedHashes(after)).toEqual(readGeneratedHashes(before));
	});
});

describe("generateSource named picklist types", () => {
	const options = { importSource: "../../src/index", apiVersion: "v67.0" as const };

	it("declares each picklist type before its sObject and uses it for the field", () => {
		const source = generateSource(describes, { ...options, picklists: "const" });
		expect(source).toContain(
			'export const CaseStatus = {\n\tNew: "New",\n\tWorking: "Working",\n\tClosed: "Closed",\n} as const;\n' +
				"export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];",
		);
		expect(source.indexOf("export const CaseStatus")).toBeLessThan(source.indexOf("export interface Case {"));
		expect(source).toContain("\tStatus: CaseStatus;");
		expect(source).toContain("\tType: AccountType | (string & {}) | null;");
		expect(source).toContain("\tChannel__c: CaseChannelCustom | (string & {}) | null;");
		// Multi-select picklists get a named type, but the field stays a `;`-separated string.
		expect(source).toContain("export const ContactInterestsCustom = {");
		expect(source).toContain("\tInterests__c: string | null;");
	});

	it.each(["const", "enum"] as const)(
		"keeps the picklist's value order, not alphabetical (picklists: %s)",
		(picklists) => {
			const values = ["Working", "New", "10", "5", "1", "Closed Won", "Closed"];
			const status: CodegenField = {
				...field("picklist", { restrictedPicklist: true }),
				name: "Status",
				picklistValues: values.map((value) => ({
					active: true,
					defaultValue: false,
					label: value,
					validFor: null,
					value,
				})),
			};
			const source = generateSource([{ name: "Case", fields: [status], childRelationships: [] }], { picklists });
			const start = source.indexOf(picklists === "enum" ? "export enum CaseStatus {" : "export const CaseStatus = {");
			const body = source.slice(start, source.indexOf("}", start));
			const emitted = [...body.matchAll(/(?:=|:) ("[^"]*"),$/gm)].map((match) => JSON.parse(match[1]) as string);
			expect(emitted).toEqual(values);
		},
	);

	it("emits enums in enum mode", () => {
		const source = generateSource(describes, { ...options, picklists: "enum" });
		expect(source).toContain(
			'export enum CaseStatus {\n\tNew = "New",\n\tWorking = "Working",\n\tClosed = "Closed",\n}',
		);
		expect(source).toContain("\tStatus: CaseStatus;");
		expect(source).not.toContain("export const CaseStatus");
	});

	it("keeps the named types when constants are disabled", () => {
		const source = generateSource(describes, { ...options, picklists: "const", constants: false });
		expect(source).toContain("export const CaseStatus = {");
		expect(source).not.toContain("PICKLIST_VALUES");
	});

	it("suffixes a picklist type whose name is taken by a generated sObject", () => {
		const caseStatus: CodegenDescribe = { name: "CaseStatus", fields: [], childRelationships: [] };
		const source = generateSource([...describes, caseStatus], { ...options, picklists: "const" });
		expect(source).toContain("export interface CaseStatus {");
		expect(source).toContain("export const CaseStatusPicklist = {");
		expect(source).toContain("\tStatus: CaseStatusPicklist;");
	});

	it("changes the sObject's hash when its picklist values change, also without constants", () => {
		const withStatus = (values: string[]): CodegenDescribe[] =>
			describes.map((describe) =>
				describe.name === "Case"
					? {
							...describe,
							fields: describe.fields.map((item) =>
								item.name === "Status"
									? {
											...item,
											picklistValues: values.map((text) => ({
												active: true,
												defaultValue: false,
												label: text,
												validFor: null,
												value: text,
											})),
										}
									: item,
							),
						}
					: describe,
			);
		const settings = { ...options, picklists: "const" as const, constants: false };
		const before = readGeneratedHashes(generateSource(withStatus(["New", "Closed"]), settings));
		const after = readGeneratedHashes(generateSource(withStatus(["New", "Escalated", "Closed"]), settings));
		expect(after?.sobjects.get("Case")).not.toBe(before?.sobjects.get("Case"));
		expect(after?.sobjects.get("Account")).toBe(before?.sobjects.get("Account"));
	});

	it("leaves the default union output unchanged", () => {
		expect(generateSource(describes, { ...options, picklists: "union" })).toBe(generateSource(describes, options));
		expect(generateSource(describes, options)).not.toContain("export const CaseStatus");
	});
});
