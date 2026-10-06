/**
 * Compile-time tests for the named picklist types of `picklists: "const"` and `"enum"`.
 * `npm run compile` type-checks this file; `@ts-expect-error` lines must fail to compile.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import * as constTypes from "../fixtures/generated-sobjects-const";
import * as enumTypes from "../fixtures/generated-sobjects-enum";
import { createClient, FakeTransport } from "../helpers/fake-transport";

describe('picklists: "const"', () => {
	const { AccountIndustry, CaseStatus, ContactInterestsCustom } = constTypes;
	const sf = createClient<constTypes.SObjectRegistry>(new FakeTransport());

	it("types fields with the named type, which equals the union of values", () => {
		expectTypeOf<constTypes.Case["Status"]>().toEqualTypeOf<"New" | "Working" | "Closed">();
		expectTypeOf<constTypes.CaseStatus>().toEqualTypeOf<"New" | "Working" | "Closed">();
		expectTypeOf(CaseStatus.Working).toEqualTypeOf<"Working">();
		expect(Object.values(CaseStatus)).toEqual(["New", "Working", "Closed"]);
		expect(Object.values(ContactInterestsCustom)).toEqual(["Golf", "Tennis"]);
	});

	it("accepts members and plain strings alike", () => {
		const query = sf.soql("Case").select("Id").where("Status", "=", CaseStatus.Working).where("Status", "!=", "Closed");
		expect(query.build()).toBe("SELECT Id FROM Case WHERE Status = 'Working' AND Status != 'Closed'");
		sf.soql("Contact").whereIncludes("Interests__c", [ContactInterestsCustom.Golf]);

		const run = async (): Promise<void> => {
			const accounts = sf.sobject("Account");
			await accounts.create({ Name: "A", Industry: AccountIndustry.Energy });
			await accounts.create({ Name: "A", Industry: "Banking" });
			// @ts-expect-error restricted picklist value
			await accounts.create({ Name: "A", Industry: "Retail" });
			// open picklists accept other strings
			await accounts.create({ Name: "A", Type: "Prospect" });
		};
		expect(typeof run).toBe("function");
	});
});

describe('picklists: "enum"', () => {
	const { AccountIndustry, AccountType, CaseStatus } = enumTypes;
	const sf = createClient<enumTypes.SObjectRegistry>(new FakeTransport());

	it("types fields with the enum", () => {
		expectTypeOf<enumTypes.Case["Status"]>().toEqualTypeOf<enumTypes.CaseStatus>();
		expect(CaseStatus.Working).toBe("Working");
		expect(Object.values(CaseStatus)).toEqual(["New", "Working", "Closed"]);
	});

	it("accepts enum members; restricted picklists reject plain strings", () => {
		const query = sf.soql("Case").select("Id").where("Status", "=", CaseStatus.Working);
		expect(query.build()).toBe("SELECT Id FROM Case WHERE Status = 'Working'");

		const run = async (): Promise<void> => {
			const [row] = await sf.collect(sf.soql("Case").select("Status"));
			expectTypeOf(row.Status).toEqualTypeOf<enumTypes.CaseStatus>();

			const accounts = sf.sobject("Account");
			await accounts.create({ Name: "A", Industry: AccountIndustry.Energy });
			// @ts-expect-error enums are nominal: a plain string is not an enum member
			await accounts.create({ Name: "A", Industry: "Energy" });
			// open picklists still accept any string
			await accounts.create({ Name: "A", Type: AccountType.Partner });
			await accounts.create({ Name: "A", Type: "Prospect" });
		};
		expect(typeof run).toBe("function");

		const invalid = (): void => {
			// @ts-expect-error enums are nominal: a plain string is not an enum member
			sf.soql("Case").where("Status", "=", "Working");
		};
		expect(typeof invalid).toBe("function");
	});
});
