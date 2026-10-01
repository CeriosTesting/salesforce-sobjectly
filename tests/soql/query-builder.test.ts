import { describe, expect, it } from "vitest";

import { soqlDate, soqlEscape, soqlEscapeDateOnly, soqlLiteral, soslEscape } from "../../src/soql/escape";
import { soqlFor } from "../../src/soql/query-builder";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";

const soql = soqlFor<SObjectRegistry>();

describe("soqlEscape", () => {
	it("quotes and escapes strings", () => {
		expect(soqlEscape("O'Brien")).toBe("'O\\'Brien'");
		expect(soqlEscape("back\\slash")).toBe("'back\\\\slash'");
		expect(soqlEscape("line\nbreak")).toBe("'line\\nbreak'");
		expect(soqlEscape("' OR Name != '")).toBe("'\\' OR Name != \\''");
	});

	it("formats other values", () => {
		expect(soqlEscape(null)).toBe("null");
		expect(soqlEscape(42)).toBe("42");
		expect(soqlEscape(false)).toBe("false");
		expect(soqlEscape(new Date("2026-03-04T05:06:07.089Z"))).toBe("2026-03-04T05:06:07Z");
		expect(soqlEscape(soqlLiteral("LAST_N_DAYS:30"))).toBe("LAST_N_DAYS:30");
		expect(() => soqlEscape(Number.NaN)).toThrow(/NaN/);
	});

	it("formats date-only values", () => {
		expect(soqlEscapeDateOnly(new Date("2026-03-04T23:00:00.000Z"))).toBe("2026-03-04");
		expect(soqlEscape(soqlDate(new Date("2026-03-04T00:00:00.000Z")))).toBe("2026-03-04");
	});

	it("escapes SOSL reserved characters", () => {
		expect(soslEscape('a-b (c)? "d" e*')).toBe('a\\-b \\(c\\)\\? \\"d\\" e\\*');
	});
});

describe("SoqlQueryBuilder", () => {
	it("builds a simple typed query", () => {
		expect(soql("Account").select("Id", "Name").where("Name", "LIKE", "Acme%").orderBy("Name").limit(50).build()).toBe(
			"SELECT Id, Name FROM Account WHERE Name LIKE 'Acme%' ORDER BY Name ASC LIMIT 50",
		);
	});

	it("uses FIELDS(ALL) without select and requires a limit of at most 200", () => {
		expect(soql("Account").limit(200).build()).toBe("SELECT FIELDS(ALL) FROM Account LIMIT 200");
		expect(() => soql("Account").build()).toThrow(/FIELDS\(ALL\)/);
		expect(() => soql("Account").limit(201).build()).toThrow(/FIELDS\(ALL\)/);
	});

	it("accumulates and de-duplicates selected fields", () => {
		expect(soql("Contact").select("Id").selectRelated("Account", "Name").select("Id", "Email").build()).toBe(
			"SELECT Id, Account.Name, Email FROM Contact",
		);
	});

	it("builds child subqueries", () => {
		expect(
			soql("Account")
				.select("Id")
				.selectChild("Contacts", (contact) => contact.select("Id", "Email").where("Email", "!=", null).limit(5))
				.build(),
		).toBe("SELECT Id, (SELECT Id, Email FROM Contacts WHERE Email != null LIMIT 5) FROM Account");
	});

	it("validates child subqueries", () => {
		expect(() => soql("Account").selectChild("Contacts", (sub) => sub)).toThrow(/requires select/);
		expect(() => soql("Account").selectChild("Contacts", () => soql("Contact").select("Id") as never)).toThrow(
			/must return the provided/,
		);
	});

	it("builds where groups, IN lists, semi-joins and related conditions", () => {
		const query = soql("Case")
			.select("Id")
			.whereGroup((group) => group.where("Status", "=", "New").where("Priority", "=", "High"))
			.whereIn("Status", ["New", "Working"])
			.whereNotIn("AccountId", soql("Account").select("Id").where("Industry", "=", "Energy"))
			.whereRelated("Account", "Name", "=", "O'Brien")
			.whereRaw("CALENDAR_YEAR(CreatedDate) = 2026")
			.build();
		expect(query).toBe(
			"SELECT Id FROM Case WHERE (Status = 'New' OR Priority = 'High') AND Status IN ('New', 'Working') AND AccountId NOT IN (SELECT Id FROM Account WHERE Industry = 'Energy') AND Account.Name = 'O\\'Brien' AND (CALENDAR_YEAR(CreatedDate) = 2026)",
		);
	});

	it("rejects empty IN lists and multi-field semi-joins", () => {
		expect(() => soql("Case").whereIn("Status", [])).toThrow(/IN \(\)/);
		expect(() => soql("Case").whereIn("AccountId", soql("Account").select("Id", "Name"))).toThrow(/exactly one field/);
	});

	it("builds aggregate queries", () => {
		expect(
			soql("Case")
				.select("Status")
				.count("Id", "total")
				.sum("Score__c", "score")
				.avg("Rate__c", "rate")
				.min("Score__c", "low")
				.max("Score__c", "high")
				.countDistinct("AccountId", "accounts")
				.groupBy("Status")
				.havingRaw("COUNT(Id) > 1")
				.havingGroup((group) => group.havingRaw("SUM(Score__c) > 5").havingRaw("AVG(Rate__c) < 2"))
				.build(),
		).toBe(
			"SELECT Status, COUNT(Id) total, SUM(Score__c) score, AVG(Rate__c) rate, MIN(Score__c) low, MAX(Score__c) high, COUNT_DISTINCT(AccountId) accounts FROM Case GROUP BY Status HAVING (COUNT(Id) > 1) AND ((SUM(Score__c) > 5) OR (AVG(Rate__c) < 2))",
		);
		expect(soql("Account").count().build()).toBe("SELECT COUNT() FROM Account");
	});

	it("validates aggregate aliases", () => {
		expect(() => soql("Case").count("Id", "1bad" as string)).toThrow(/alias/);
		expect(() => soql("Case").count("Id", "has space")).toThrow(/alias/);
	});

	it("rejects groupBy with FIELDS(ALL)", () => {
		expect(() => soql("Case").groupBy("Status").limit(10).build()).toThrow(/groupBy/);
	});

	it("adds USER_MODE, ORDER BY with nulls, OFFSET and FOR", () => {
		expect(
			soql("Account")
				.select("Id")
				.withUserMode()
				.orderBy("Name", "DESC", "NULLS LAST")
				.orderByRaw("Owner.Name ASC")
				.limit(10)
				.offset(20)
				.for("VIEW")
				.build(),
		).toBe(
			"SELECT Id FROM Account WITH USER_MODE ORDER BY Name DESC NULLS LAST, Owner.Name ASC LIMIT 10 OFFSET 20 FOR VIEW",
		);
	});

	it("validates limit, offset and raw fragments", () => {
		expect(() => soql("Account").limit(-1)).toThrow(/non-negative/);
		expect(() => soql("Account").limit(1.5)).toThrow(/non-negative/);
		expect(() => soql("Account").offset(2001)).toThrow(/2000/);
		expect(() => soql("Account").whereRaw("  ")).toThrow(/non-blank/);
		expect(() => soql("Account").selectRaw("")).toThrow(/non-blank/);
		expect(() => soql("Account").havingRaw("")).toThrow(/non-blank/);
		expect(() => soql("Bad Name" as "Account")).toThrow(/Invalid sObject/);
	});

	it("stringifies to the built query", () => {
		expect(String(soql("User").select("Id"))).toBe("SELECT Id FROM User");
	});
});
