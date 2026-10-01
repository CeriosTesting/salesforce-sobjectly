import { describe, expect, it } from "vitest";

import { soqlDate, soqlDateLiteral } from "../../src/soql/escape";
import { isSObjectType, soqlFor } from "../../src/soql/query-builder";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";

const soql = soqlFor<SObjectRegistry>();

describe("parent paths", () => {
	it("selects, filters and orders through multi-level paths", () => {
		expect(
			soql("Contact")
				.select("Id")
				.selectRelated("Account.Owner", "Username")
				.whereRelated("Account.Owner", "IsActive", "=", true)
				.orderByRelated("Account", "Name", "DESC", "NULLS LAST")
				.build(),
		).toBe(
			"SELECT Id, Account.Owner.Username FROM Contact WHERE Account.Owner.IsActive = true ORDER BY Account.Name DESC NULLS LAST",
		);
	});

	it("validates paths at runtime", () => {
		expect(() => soql("Contact").selectRelated("Account..Owner" as "Account", "Name")).toThrow(
			/Invalid relationship path/,
		);
		expect(() => soql("Contact").selectRelated("A.B.C.D.E.F" as "Account", "Name")).toThrow(/maximum of 5 levels/);
	});
});

describe("polymorphic lookups", () => {
	it("selects Name fields and builds TYPEOF", () => {
		expect(
			soql("Task")
				.select("Id")
				.selectPolymorphic("Owner", "Name", "Type")
				.selectTypeOf("What", (t) => t.when("Account", "Phone", "Industry").when("Case", "Status").else("Name"))
				.build(),
		).toBe(
			"SELECT Id, Owner.Name, Owner.Type, TYPEOF What WHEN Account THEN Phone, Industry WHEN Case THEN Status ELSE Name END FROM Task",
		);
	});

	it("validates TYPEOF usage", () => {
		expect(() => soql("Task").selectTypeOf("What", (t) => t as never)).toThrow(/at least one when/);
		expect(() =>
			soql("Task").selectTypeOf("What", (t) => t.else("Name").when("Account" as never, "Name" as never)),
		).toThrow(/before else/);
		expect(() =>
			soql("Task").selectTypeOf("What", (t) => t.when("Account", "Name").when("Account" as never, "Name" as never)),
		).toThrow(/already has a WHEN Account/);
		const typeOf = soql("Task")
			.select("Id")
			.selectTypeOf("What", (t) => t.when("Account", "Name"));
		expect(typeOf.usesTypeOf).toBe(true);
		expect(() => typeOf.groupBy("Subject").build()).toThrow(/groupBy/);
		expect(() =>
			soql("Account")
				.select("Id")
				.whereIn(
					"Id",
					soql("Task")
						.selectTypeOf("What", (t) => t.when("Account", "Id"))
						.limit(1) as never,
				),
		).toThrow(/semi-join/);
	});

	it("narrows records with isSObjectType", () => {
		const record = { attributes: { type: "Account" as const }, Phone: "1" };
		expect(isSObjectType(record, "Account")).toBe(true);
		expect(isSObjectType(null, "Account" as never)).toBe(false);
	});
});

describe("new conditions", () => {
	it("builds INCLUDES, EXCLUDES and NOT", () => {
		expect(
			soql("Contact")
				.select("Id")
				.whereIncludes("Interests__c", [["Golf", "Tennis"], "Chess"])
				.whereExcludes("Interests__c", ["Darts"])
				.whereNot((group) => group.where("Email", "=", null).where("LastName", "LIKE", "Test%"))
				.build(),
		).toBe(
			"SELECT Id FROM Contact WHERE Interests__c INCLUDES ('Golf;Tennis', 'Chess') AND Interests__c EXCLUDES ('Darts') AND (NOT (Email = null AND LastName LIKE 'Test%'))",
		);
		expect(() => soql("Contact").whereIncludes("Interests__c", [])).toThrow(/at least one value/);
		expect(() => soql("Contact").whereNot(() => undefined)).toThrow(/at least one condition/);
	});

	it("renders date values correctly", () => {
		expect(
			soql("Contact")
				.select("Id")
				.where("Birthdate", "=", soqlDate("1990-05-01"))
				.where("Birthdate", ">", soqlDateLiteral("TODAY"))
				.where("Birthdate", "<", soqlDateLiteral("NEXT_N_DAYS", 7))
				.build(),
		).toBe("SELECT Id FROM Contact WHERE Birthdate = 1990-05-01 AND Birthdate > TODAY AND Birthdate < NEXT_N_DAYS:7");
		expect(() => soqlDate("01-05-1990")).toThrow(/yyyy-MM-dd/);
		expect(() => soqlDateLiteral("SOMEDAY" as "TODAY")).toThrow(/Unknown SOQL date literal/);
		expect(() => soqlDateLiteral("LAST_N_DAYS", -1)).toThrow(/non-negative integer/);
	});
});
