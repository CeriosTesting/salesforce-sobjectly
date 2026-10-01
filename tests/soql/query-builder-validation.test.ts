import { describe, expect, it } from "vitest";

import { type SoqlQueryBuilder, soqlFor } from "../../src/soql/query-builder";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";

const soql = soqlFor<SObjectRegistry>();
const untyped = soqlFor();

type CaseQuery = SoqlQueryBuilder<SObjectRegistry, "Case">;
type ContactQuery = SoqlQueryBuilder<SObjectRegistry, "Contact">;

describe("clone", () => {
	it("returns an independent copy", () => {
		const base = soql("Account").select("Id").where("Name", "=", "Acme");
		const copy = base.clone().select("Name").where("Industry", "=", "Energy").orderBy("Name").limit(5).offset(10);
		expect(copy.build()).toBe(
			"SELECT Id, Name FROM Account WHERE Name = 'Acme' AND Industry = 'Energy' ORDER BY Name ASC LIMIT 5 OFFSET 10",
		);
		expect(base.build()).toBe("SELECT Id FROM Account WHERE Name = 'Acme'");

		base.where("Type", "=", "Customer").groupBy("Type").havingRaw("COUNT(Id) > 1");
		expect(base.build()).toBe(
			"SELECT Id FROM Account WHERE Name = 'Acme' AND Type = 'Customer' GROUP BY Type HAVING (COUNT(Id) > 1)",
		);
		expect(copy.build()).toBe(
			"SELECT Id, Name FROM Account WHERE Name = 'Acme' AND Industry = 'Energy' ORDER BY Name ASC LIMIT 5 OFFSET 10",
		);
	});

	it("copies every clause and flag", () => {
		const base = soql("Account").select("Id").withUserMode().limit(1).offset(2).for("UPDATE");
		expect(base.clone().build()).toBe("SELECT Id FROM Account WITH USER_MODE LIMIT 1 OFFSET 2 FOR UPDATE");
		expect(base.clone().sobjectName).toBe("Account");

		const typeOf = soql("Task")
			.select("Id")
			.selectTypeOf("What", (t) => t.when("Account", "Name"));
		expect(typeOf.clone().usesTypeOf).toBe(true);
		expect(() => typeOf.clone().groupBy("Subject").build()).toThrow(/TYPEOF/);

		const countAll = soql("Account").count();
		expect(() => countAll.clone().orderBy("Name").build()).toThrow(/count\(\) must be the only/);
		expect(countAll.build()).toBe("SELECT COUNT() FROM Account");
	});

	it("keeps an unselected base on FIELDS(ALL)", () => {
		const base = soql("Account").limit(10);
		expect(base.clone().select("Id").build()).toBe("SELECT Id FROM Account LIMIT 10");
		expect(base.build()).toBe("SELECT FIELDS(ALL) FROM Account LIMIT 10");
	});
});

describe("field and operator validation", () => {
	it("rejects invalid field names everywhere", () => {
		const bad = "Name; DELETE" as "Name";
		expect(() => soql("Account").select(bad)).toThrow('select(): invalid field name "Name; DELETE".');
		expect(() => soql("Account").select("Id", "Name, Phone" as "Name")).toThrow(/invalid field name/);
		expect(() => soql("Account").select("" as "Name")).toThrow(/at least one field/);
		expect(() => soql("Account").where(bad, "=", "x")).toThrow(/where\(\): invalid field name/);
		expect(() => soql("Account").where("Name) OR (Id" as "Name", "=", "x")).toThrow(/invalid field name/);
		expect(() => soql("Account").whereIn(bad, ["x"])).toThrow(/whereIn\(\): invalid field name/);
		expect(() => soql("Account").whereNotIn(bad, ["x"])).toThrow(/whereNotIn\(\): invalid field name/);
		expect(() => soql("Account").orderBy(bad)).toThrow(/orderBy\(\): invalid field name/);
		expect(() => soql("Account").groupBy("Name", bad)).toThrow(/groupBy\(\): invalid field name/);
		expect(() => soql("Contact").whereIncludes("Interests__c; x" as "Interests__c", ["a"])).toThrow(
			/whereIncludes\(\): invalid field name/,
		);
		expect(() => soql("Contact").selectRelated("Account", bad)).toThrow(/selectRelated\(\): invalid name/);
		expect(() => soql("Contact").whereRelated("Account", bad, "=", "x")).toThrow(/whereRelated\(\): invalid name/);
		expect(() => soql("Contact").orderByRelated("Account", bad)).toThrow(/orderByRelated\(\): invalid name/);
		expect(() => soql("Task").selectPolymorphic("Owner", "Name; x" as "Name")).toThrow(/selectPolymorphic\(\)/);
		expect(() => soql("Account").selectChild("Contacts) FROM x" as "Contacts", (c) => c.select("Id"))).toThrow(
			/selectChild\(\): invalid name/,
		);
	});

	it("accepts dotted paths only for well-formed identifiers", () => {
		expect(untyped("Contact").select("Id", "Account.Name").where("Account.Name", "=", "Acme").build()).toBe(
			"SELECT Id, Account.Name FROM Contact WHERE Account.Name = 'Acme'",
		);
		expect(() => untyped("Contact").select("Account..Name")).toThrow(/invalid field name/);
		expect(() => untyped("Contact").select("1Account.Name")).toThrow(/invalid field name/);
		expect(() => untyped("Contact").select("Account.Name ")).toThrow(/invalid field name/);
	});

	it("rejects unknown operators", () => {
		expect(() => soql("Account").where("Name", "==" as "=", "x")).toThrow(/Invalid SOQL operator "=="/);
		expect(() => soql("Account").where("Name", "IN" as "=", "x")).toThrow(/Invalid SOQL operator "IN"/);
		expect(() => soql("Account").where("Name", "= 'x' OR Name =" as "=", "x")).toThrow(/Invalid SOQL operator/);
		expect(() => soql("Account").where("Name", "like" as "LIKE", "x")).toThrow(/Invalid SOQL operator "like"/);
		expect(() => soql("Contact").whereRelated("Account", "Name", "<>" as "=", "x")).toThrow(/Invalid SOQL operator/);
		for (const operator of ["=", "!=", ">", "<", ">=", "<="] as const) {
			expect(soql("Case").select("Id").where("Score__c", operator, 1).build()).toBe(
				`SELECT Id FROM Case WHERE Score__c ${operator} 1`,
			);
		}
	});

	it("rejects invalid sort directions and null orders", () => {
		expect(() => soql("Account").orderBy("Name", "DESC; x" as "DESC")).toThrow(/Invalid sort direction/);
		expect(() => soql("Account").orderBy("Name", "ASC", "NULLS" as "NULLS LAST")).toThrow(/Invalid null order/);
		expect(() => soql("Contact").orderByRelated("Account", "Name", "UP" as "ASC")).toThrow(/Invalid sort direction/);
	});
});

describe("COUNT()", () => {
	it("allows WHERE, LIMIT and OFFSET", () => {
		expect(soql("Account").count().where("Name", "=", "A").limit(10).offset(5).build()).toBe(
			"SELECT COUNT() FROM Account WHERE Name = 'A' LIMIT 10 OFFSET 5",
		);
		expect(soql("Account").count().count().build()).toBe("SELECT COUNT() FROM Account");
	});

	it("must be the only selected item", () => {
		expect(() => soql("Account").count().select("Id").build()).toThrow(/count\(\) must be the only selected item/);
		expect(() => soql("Account").select("Id").count().build()).toThrow(/count\(\) must be the only/);
		expect(() => soql("Account").count().selectRaw("Name").build()).toThrow(/count\(\) must be the only/);
		expect(() => soql("Case").count().count("Id", "total").build()).toThrow(/count\(\) must be the only/);
	});

	it("can't be combined with groupBy() or orderBy()", () => {
		expect(() => soql("Account").count().groupBy("Name").build()).toThrow(/groupBy\(\) or orderBy\(\)/);
		expect(() => soql("Account").count().orderBy("Name").build()).toThrow(/groupBy\(\) or orderBy\(\)/);
		expect(() => soql("Account").count().orderByRaw("Name").build()).toThrow(/groupBy\(\) or orderBy\(\)/);
	});

	it("doesn't restrict COUNT(field) aggregates", () => {
		expect(soql("Case").select("Status").count("Id", "total").groupBy("Status").orderBy("Status").build()).toBe(
			"SELECT Status, COUNT(Id) total FROM Case GROUP BY Status ORDER BY Status ASC",
		);
	});
});

describe("aggregates", () => {
	it("rejects reserved words as aliases, in any case", () => {
		for (const alias of ["select", "FROM", "Limit", "nulls", "group", "order", "true", "typeof", "Desc"]) {
			expect(() => soql("Case").count("Id", alias)).toThrow(`Aggregate alias "${alias}" is a reserved SOQL keyword.`);
		}
		expect(() => soql("Case").sum("Score__c", "where")).toThrow(/reserved/);
		expect(() => soql("Case").countDistinct("AccountId", "AND")).toThrow(/reserved/);
		expect(soql("Case").count("Id", "selected").build()).toBe("SELECT COUNT(Id) selected FROM Case");
	});

	it("validates the field and alias", () => {
		expect(() => soql("Case").count("Id) x, (Name" as "Id", "total")).toThrow(/COUNT\(\): invalid field name/);
		expect(() => soql("Case").sum("Score__c + 1" as "Score__c", "total")).toThrow(/SUM\(\): invalid field name/);
		expect(() => soql("Case").min("Score__c", "")).toThrow(/Aggregate alias "" must be a valid/);
		expect(() => soql("Case").max("Score__c", "_x")).toThrow(/must be a valid SOQL identifier/);
		expect(() => soql("Case").avg("Rate__c", "a-b")).toThrow(/must be a valid SOQL identifier/);
		expect(() => soql("Case").count("Id", undefined as never)).toThrow(/Aggregate alias "undefined"/);
	});

	it("aggregates over dotted paths in untyped registries", () => {
		expect(
			untyped("Opportunity").select("StageName").sum("Account.AnnualRevenue", "revenue").groupBy("StageName").build(),
		).toBe("SELECT StageName, SUM(Account.AnnualRevenue) revenue FROM Opportunity GROUP BY StageName");
	});
});

describe("raw fragments", () => {
	it("wraps whereRaw in parentheses so OR can't leak", () => {
		expect(
			soql("Account").select("Id").where("Type", "=", "Customer").whereRaw("Name = 'A' OR Name = 'B'").build(),
		).toBe("SELECT Id FROM Account WHERE Type = 'Customer' AND (Name = 'A' OR Name = 'B')");
		expect(soql("Account").select("Id").whereRaw("Name = 'A' OR Name = 'B'").whereRaw("Type = 'X'").build()).toBe(
			"SELECT Id FROM Account WHERE (Name = 'A' OR Name = 'B') AND (Type = 'X')",
		);
	});

	it("wraps havingRaw in parentheses", () => {
		expect(
			soql("Case")
				.select("Status")
				.groupBy("Status")
				.havingRaw("COUNT(Id) > 1 OR SUM(Score__c) > 2")
				.havingRaw("MAX(Score__c) < 9")
				.build(),
		).toBe(
			"SELECT Status FROM Case GROUP BY Status HAVING (COUNT(Id) > 1 OR SUM(Score__c) > 2) AND (MAX(Score__c) < 9)",
		);
	});
});

describe("group callbacks", () => {
	it("nest groups and ignore empty ones", () => {
		expect(
			soql("Case")
				.select("Id")
				.whereGroup((g) =>
					g
						.where("Status", "=", "New")
						.whereGroup((h) => h.where("Priority", "=", "High").where("Score__c", ">", 1), "AND"),
				)
				.whereGroup(() => undefined)
				.build(),
		).toBe("SELECT Id FROM Case WHERE (Status = 'New' OR (Priority = 'High' AND Score__c > 1))");
		expect(
			soql("Case")
				.select("Status")
				.groupBy("Status")
				.havingGroup(() => undefined)
				.build(),
		).toBe("SELECT Status FROM Case GROUP BY Status");
	});

	it("reject methods other than where in whereGroup()/whereNot()", () => {
		const where = (g: CaseQuery): CaseQuery => g.where("Status", "=", "New");
		expect(() => soql("Case").whereGroup((g) => void where(g).select("Id"))).toThrow(
			"whereGroup()/whereNot() callbacks can only add where conditions, not select.",
		);
		expect(() => soql("Case").whereGroup((g) => void where(g).orderBy("Status"))).toThrow(/not orderBy/);
		expect(() => soql("Case").whereGroup((g) => void where(g).groupBy("Status"))).toThrow(/not groupBy/);
		expect(() => soql("Case").whereGroup((g) => void where(g).limit(1))).toThrow(/not limit\/offset/);
		expect(() => soql("Case").whereGroup((g) => void where(g).offset(1))).toThrow(/not limit\/offset/);
		expect(() => soql("Case").whereGroup((g) => void where(g).withUserMode())).toThrow(/not withUserMode\/for/);
		expect(() => soql("Case").whereNot((g) => void where(g).for("UPDATE"))).toThrow(/not withUserMode\/for/);
		expect(() => soql("Case").whereNot((g) => void where(g).havingRaw("COUNT(Id) > 1"))).toThrow(/not having/);
		expect(() => soql("Case").whereGroup((g) => void where(g).select("Id").orderBy("Status").limit(1))).toThrow(
			/not select, orderBy, limit\/offset\./,
		);
	});

	it("reject methods other than having in havingGroup()", () => {
		expect(() => soql("Case").havingGroup((g) => void g.where("Status", "=", "New"))).toThrow(
			"havingGroup() callbacks can only add having conditions, not where.",
		);
		expect(() => soql("Case").havingGroup((g) => void g.havingRaw("COUNT(Id) > 1").groupBy("Status"))).toThrow(
			/not groupBy/,
		);
		expect(() => soql("Case").havingGroup((g) => void g.havingRaw("COUNT(Id) > 1").count("Id", "n"))).toThrow(
			/not select/,
		);
	});
});

describe("selectChild restrictions", () => {
	const child = (build: (sub: ContactQuery) => unknown) => (): unknown =>
		soql("Account")
			.select("Id")
			.selectChild("Contacts", (sub) => {
				build(sub);
				return sub;
			});

	it("rejects clauses that aren't allowed in a subquery", () => {
		expect(child((sub) => sub.count("Id", "n"))).toThrow(
			'selectChild("Contacts"): aggregate functions can\'t be used in a subquery.',
		);
		expect(child((sub) => sub.count())).toThrow(/aggregate functions/);
		expect(child((sub) => sub.select("Id").groupBy("LastName"))).toThrow(/GROUP BY\/HAVING/);
		expect(child((sub) => sub.select("Id").havingRaw("COUNT(Id) > 1"))).toThrow(/GROUP BY\/HAVING/);
		expect(child((sub) => sub.select("Id").withUserMode())).toThrow(/WITH USER_MODE/);
		expect(child((sub) => sub.select("Id").for("UPDATE"))).toThrow(/FOR UPDATE/);
		expect(child((sub) => sub.select("Id").count("Id", "n").groupBy("LastName").withUserMode().for("VIEW"))).toThrow(
			'selectChild("Contacts"): aggregate functions, GROUP BY/HAVING, WITH USER_MODE, FOR VIEW can\'t be used in a subquery.',
		);
		expect(() =>
			untyped("Account")
				.select("Id")
				.selectChild("Tasks", (sub) => sub.select("Id").selectTypeOf("What", (t) => t.when("Account", "Name"))),
		).toThrow(/TYPEOF can't be used in a subquery/);
	});

	it("allows where, orderBy, limit and offset in a subquery", () => {
		expect(
			soql("Account")
				.select("Id")
				.selectChild("Contacts", (sub) =>
					sub.select("Id").whereRaw("Email != null OR Phone != null").orderBy("LastName", "DESC").limit(3).offset(1),
				)
				.build(),
		).toBe(
			"SELECT Id, (SELECT Id FROM Contacts WHERE (Email != null OR Phone != null) ORDER BY LastName DESC LIMIT 3 OFFSET 1) FROM Account",
		);
	});
});
