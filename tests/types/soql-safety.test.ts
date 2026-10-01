/**
 * Compile-time tests for field-aware SOQL typing, parent paths, polymorphic lookups, external ids
 * and platform events. `npm run compile` checks them; `@ts-expect-error` lines must fail.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { soqlDate, soqlDateLiteral } from "../../src/soql/escape";
import { isSObjectType } from "../../src/soql/query-builder";
import type { TypedRecord } from "../../src/soql/types";
import type { WithAttributes } from "../../src/types/common";
import type { Account, Case, SObjectRegistry, User } from "../fixtures/generated-sobjects";
import { createClient, FakeTransport } from "../helpers/fake-transport";

const sf = createClient<SObjectRegistry>(new FakeTransport());

describe("field-aware where()", () => {
	it("accepts values that match the field", () => {
		const query = sf
			.soql("Contact")
			.select("Id")
			.where("Birthdate", "<", soqlDate(new Date("2000-01-01T00:00:00Z")))
			.where("Birthdate", ">=", soqlDateLiteral("LAST_N_YEARS", 50))
			.where("Email", "LIKE", "%@example.com")
			.where("Email", "=", null);
		expect(query.build()).toBe(
			"SELECT Id FROM Contact WHERE Birthdate < 2000-01-01 AND Birthdate >= LAST_N_YEARS:50 AND Email LIKE '%@example.com' AND Email = null",
		);
		sf.soql("Account").where("CreatedDate", ">", new Date()).where("AnnualRevenue", ">=", 1000);
		sf.soql("Case").where("IsClosed", "=", false).where("Status", "=", "Working");
	});

	it("rejects values and operators that don't fit the field", () => {
		const invalid = (): void => {
			// @ts-expect-error a Date on a date-only field would render a DateTime literal
			sf.soql("Contact").where("Birthdate", "=", new Date());
			// @ts-expect-error a quoted string is not a valid date literal
			sf.soql("Contact").where("Birthdate", "=", "2000-01-01");
			// @ts-expect-error LIKE on a number field
			sf.soql("Account").where("AnnualRevenue", "LIKE", 5);
			// @ts-expect-error a string on a number field
			sf.soql("Account").where("AnnualRevenue", ">", "5");
			// @ts-expect-error > on a boolean field
			sf.soql("Case").where("IsClosed", ">", true);
			// @ts-expect-error not a value of the restricted picklist
			sf.soql("Case").where("Status", "=", "Escalated");
			// @ts-expect-error Name is not nillable
			sf.soql("Account").where("Name", "=", null);
			// @ts-expect-error null only with = or !=
			sf.soql("Contact").where("Email", "LIKE", null);
			// @ts-expect-error IN values are checked too
			sf.soql("Case").whereIn("Status", ["New", "Escalated"]);
			// @ts-expect-error INCLUDES only on multi-select picklists
			sf.soql("Contact").whereIncludes("Email", ["x"]);
		};
		expect(typeof invalid).toBe("function");
	});
});

describe("parent paths", () => {
	it("types nested parents up to three hops", () => {
		const run = async (): Promise<void> => {
			const [row] = await sf.collect(
				sf
					.soql("Contact")
					.select("Id")
					.selectRelated("Account.Owner", "Username", "Email")
					.selectRelated("Account", "Name"),
			);
			expectTypeOf(row.Account!.Name).toEqualTypeOf<string>();
			expectTypeOf(row.Account!.Owner).toEqualTypeOf<WithAttributes<Pick<User, "Username" | "Email">> | null>();
		};
		expect(typeof run).toBe("function");
		const invalid = (): void => {
			// @ts-expect-error Account has no "Bogus" parent
			sf.soql("Contact").selectRelated("Account.Bogus", "Name");
			// @ts-expect-error Email is not a field of Account
			sf.soql("Contact").whereRelated("Account", "Email", "=", "x");
			// @ts-expect-error IsActive is a boolean
			sf.soql("Contact").whereRelated("Account.Owner", "IsActive", "=", "yes");
		};
		expect(typeof invalid).toBe("function");
	});
});

describe("polymorphic lookups", () => {
	it("types Name fields and TYPEOF unions", () => {
		const run = async (): Promise<void> => {
			const [task] = await sf.collect(
				sf
					.soql("Task")
					.select("Id")
					.selectPolymorphic("Owner", "Name")
					.selectTypeOf("What", (t) => t.when("Account", "Phone", "Industry").when("Case", "Status").else("Name")),
			);
			expectTypeOf(task.Owner).toEqualTypeOf<TypedRecord<"Group" | "User", { Name: string | null }> | null>();
			const what = task.What;
			if (isSObjectType(what, "Account")) {
				expectTypeOf(what).toEqualTypeOf<TypedRecord<"Account", Pick<Account, "Phone" | "Industry">>>();
			} else if (isSObjectType(what, "Case")) {
				expectTypeOf(what.Status).toEqualTypeOf<Case["Status"]>();
			} else if (isSObjectType(what, "Opportunity")) {
				expectTypeOf(what.Name).toEqualTypeOf<string | null>();
			}
		};
		expect(typeof run).toBe("function");
		const invalid = (): void => {
			// @ts-expect-error Lead is not a target of What
			sf.soql("Task").selectTypeOf("What", (t) => t.when("Lead", "Name"));
			// @ts-expect-error Industry is not a Name field
			sf.soql("Task").selectPolymorphic("Owner", "Industry");
			// @ts-expect-error Owner on Task is polymorphic, not a regular parent
			sf.soql("Task").selectRelated("Owner", "Name");
		};
		expect(typeof invalid).toBe("function");
	});
});

describe("external ids and events", () => {
	it("only accepts external id fields for upsert", () => {
		const run = async (): Promise<void> => {
			await sf.sobject("Account").upsert("External_Id__c", "A-1", { Name: "Acme" });
			await sf.sobject("User").getByExternalId("Username", "someone@example.com");
			await sf.collections.upsert("Account", "External_Id__c", [{ Name: "Acme", External_Id__c: "A-1" }]);
			// @ts-expect-error Name is not an external id field
			await sf.sobject("Account").upsert("Name", "Acme", {});
			// @ts-expect-error Phone is not an external id field
			await sf.bulk.ingest({ object: "Account", operation: "upsert", externalIdFieldName: "Phone", csv: "x" });
		};
		expect(typeof run).toBe("function");
	});

	it("types platform event payloads", () => {
		const run = async (): Promise<void> => {
			await sf.events.publish("Order_Shipped__e", { Order_Number__c: "A-1", Shipped_At__c: "2026-01-01T00:00:00Z" });
			// @ts-expect-error Order_Number__c is required
			await sf.events.publish("Order_Shipped__e", { Shipped_At__c: null });
			// @ts-expect-error Account is not a platform event
			await sf.events.publish("Account", { Name: "x" });
		};
		expect(typeof run).toBe("function");
	});
});
