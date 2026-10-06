import { describe, expect, it } from "vitest";

import { type CodegenDescribe, generateSource } from "../../src/codegen/generator";
import { pascalApiName, picklistMemberKeys, picklistTypeNames } from "../../src/codegen/picklist-types";
import type { CodegenField } from "../../src/codegen/type-mapper";

function picklist(name: string, values: string[], overrides: Partial<CodegenField> = {}): CodegenField {
	return {
		name,
		label: name,
		type: "picklist",
		nillable: true,
		createable: true,
		updateable: true,
		defaultedOnCreate: false,
		referenceTo: [],
		relationshipName: null,
		picklistValues: values.map((value) => ({ active: true, defaultValue: false, label: value, validFor: null, value })),
		restrictedPicklist: true,
		...overrides,
	};
}

function sobject(name: string, fields: CodegenField[]): CodegenDescribe {
	return { name, fields, childRelationships: [] };
}

describe("pascalApiName", () => {
	it.each([
		["Case", "sobject", "Case"],
		["Status", "field", "Status"],
		["Status__c", "field", "StatusCustom"],
		["Lead_Source__c", "field", "LeadSourceCustom"],
		["My_Object__c", "sobject", "MyObject"],
		["ns__Obj__c", "sobject", "NsObj"],
		["ns__Field__c", "field", "NsFieldCustom"],
		["Foo__pc", "field", "FooPc"],
		["Config__mdt", "sobject", "ConfigMdt"],
		["Order_Shipped__e", "sobject", "OrderShippedE"],
		["My_Object__History", "sobject", "MyObjectHistory"],
	] as const)("%s (%s) -> %s", (name, kind, expected) => {
		expect(pascalApiName(name, kind)).toBe(expected);
	});
});

describe("picklistTypeNames", () => {
	const names = (describes: CodegenDescribe[], taken: string[] = []): Record<string, Record<string, string>> =>
		Object.fromEntries(
			[...picklistTypeNames(describes, new Set(taken))].map(([name, fields]) => [name, Object.fromEntries(fields)]),
		);

	it("joins the sObject and field names", () => {
		const describes = [
			sobject("Case", [picklist("Status", ["New"]), picklist("Status__c", ["Open"])]),
			sobject("Project__c", [picklist("Stage__c", ["Plan"])]),
		];
		expect(names(describes)).toEqual({
			Case: { Status: "CaseStatus", Status__c: "CaseStatusCustom" },
			Project__c: { Stage__c: "ProjectStageCustom" },
		});
	});

	it("skips fields without active values and non-picklist fields", () => {
		const inactive = picklist("Old__c", ["Gone"]);
		inactive.picklistValues = inactive.picklistValues?.map((entry) => ({ ...entry, active: false }));
		const describes = [sobject("Case", [inactive, picklist("Subject", ["x"], { type: "string" })])];
		expect(names(describes)).toEqual({});
	});

	it("suffixes a name that is taken, by the file or by an earlier picklist", () => {
		const describes = [
			sobject("Case", [
				picklist("Status", ["New"]),
				picklist("Lead_Source__c", ["Web"]),
				picklist("LeadSource__c", ["Web"]),
			]),
		];
		// Fields are processed in sorted order: "LeadSource__c" sorts before "Lead_Source__c".
		expect(names(describes, ["Case", "CaseStatus"])).toEqual({
			Case: {
				Status: "CaseStatusPicklist",
				LeadSource__c: "CaseLeadSourceCustom",
				Lead_Source__c: "CaseLeadSourceCustomPicklist",
			},
		});
	});

	it("fails when the suffixed name is taken too", () => {
		const describes = [sobject("Case", [picklist("Status", ["New"])])];
		expect(() => names(describes, ["CaseStatus", "CaseStatusPicklist"])).toThrow(
			'The picklist type "CaseStatusPicklist" for Case.Status clashes with a type the generated file defines; exclude one of the sObjects or use picklists: "union".',
		);
	});

	it("fails in generateSource when a picklist name can't be resolved", () => {
		const describes = [
			sobject("Case", [picklist("Status", ["New"])]),
			sobject("CaseStatus", []),
			sobject("CaseStatusPicklist", []),
		];
		expect(() => generateSource(describes, { picklists: "const" })).toThrow(/CaseStatusPicklist/);
		expect(() => generateSource(describes, { picklists: "union" })).not.toThrow();
	});
});

describe("picklistMemberKeys", () => {
	it("keeps identifier values and sanitizes the rest", () => {
		expect(
			picklistMemberKeys(
				["New", "Closed Won", "Proposal/Price Quote", "Id. Decision Makers", "3rd Party", "- None -", "Geïnteresseerd"],
				"const",
			),
		).toEqual([
			"New",
			"Closed_Won",
			"Proposal_Price_Quote",
			"Id_Decision_Makers",
			"_3rd_Party",
			"None",
			"Geinteresseerd",
		]);
	});

	it("falls back to the quoted value when the sanitized key is empty or taken", () => {
		expect(picklistMemberKeys(["日本", "Closed Won", "Closed-Won"], "const")).toEqual([
			"日本",
			"Closed_Won",
			"Closed-Won",
		]);
	});

	it("lets identifier values keep their own name, whatever the order", () => {
		expect(picklistMemberKeys(["Closed Won", "Closed_Won"], "const")).toEqual(["Closed Won", "Closed_Won"]);
	});

	it("never uses __proto__ as a key", () => {
		expect(picklistMemberKeys(["__proto__"], "const")).toEqual(["proto"]);
	});

	it("avoids numeric member names in enum mode", () => {
		expect(picklistMemberKeys(["_1", "1"], "const")).toEqual(["_1", "1"]);
		expect(picklistMemberKeys(["_1", "1"], "enum")).toEqual(["_1", "_1_2"]);
		expect(picklistMemberKeys(["NaN", "-1"], "enum")).toEqual(["NaN", "_1"]);
	});
});

describe("edge-case output", () => {
	// `npm run compile` type-checks the snapshot, so every emitted name must be valid TypeScript.
	const describes = [
		sobject("Opportunity", [
			picklist("StageName", ["Prospecting", "Closed Won", "Closed-Won", "Proposal/Price Quote", "3rd Party", "日本"]),
			picklist("Odd__c", ["1", "_1", "-1", "NaN", "new", "class", "constructor", "__proto__", "a\"b'c", "*/"]),
		]),
		sobject("OpportunityStageName", []),
	];

	it.each(["const", "enum"] as const)("compiles with picklists: %s", async (picklists) => {
		await expect(
			generateSource(describes, { picklists, importSource: "../../src/index", constants: false }),
		).toMatchFileSnapshot(`../fixtures/generated-picklist-edge-cases-${picklists}.ts`);
	});
});
