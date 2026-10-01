/**
 * Compile-time tests: `npm run compile` type-checks this file; `@ts-expect-error` lines must
 * fail to compile. The runtime part only checks that the builders run.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { BulkCsvRecord } from "../../src/resources/bulk";
import type { CompositeRef } from "../../src/resources/composite";
import type { QueryResult } from "../../src/resources/query";
import type { SoqlChildQueryResult, SoqlQueryRecord } from "../../src/soql/query-builder";
import type { RecordAttributes, SaveResult, WithAttributes } from "../../src/types/common";
import {
	API_VERSION,
	type Account,
	type AccountCreateInput,
	type SObjectRegistry,
	type User,
} from "../fixtures/generated-sobjects";
import { createClient, FakeTransport } from "../helpers/fake-transport";

const sf = createClient<SObjectRegistry>(new FakeTransport(), { apiVersion: API_VERSION });
const untyped = createClient(new FakeTransport());

describe("type safety", () => {
	it("narrows query results to the selected fields", () => {
		const query = sf.soql("Account").select("Id", "Name");
		type Row = SoqlQueryRecord<SObjectRegistry, "Account", Pick<Account, "Id" | "Name">>;
		expectTypeOf<Row>().toEqualTypeOf<WithAttributes<Pick<Account, "Id" | "Name">>>();

		const run = async (): Promise<void> => {
			const page = await sf.query(query);
			const record = page.records[0];
			expectTypeOf(record.Name).toEqualTypeOf<string>();
			expectTypeOf(record.attributes).toEqualTypeOf<RecordAttributes>();
			// @ts-expect-error Phone was not selected
			void record.Phone;
			if (page.nextRecordsUrl) {
				expectTypeOf(await sf.queryMore(page.nextRecordsUrl)).toEqualTypeOf<typeof page>();
			}
		};
		expect(typeof run).toBe("function");
		expect(query.build()).toBe("SELECT Id, Name FROM Account");
	});

	it("returns the full record when nothing is selected", () => {
		const run = async (): Promise<void> => {
			const [record] = await sf.collect(sf.soql("User").limit(10));
			expectTypeOf(record).toEqualTypeOf<WithAttributes<User>>();
		};
		expect(typeof run).toBe("function");
	});

	it("types parent and child relationships", () => {
		const run = async (): Promise<void> => {
			const [record] = await sf.collect(
				sf
					.soql("Account")
					.select("Id")
					.selectRelated("Owner", "Username")
					.selectChild("Contacts", (contact) => contact.select("Email").selectRelated("Account", "Name")),
			);
			expectTypeOf(record.Owner).toEqualTypeOf<WithAttributes<Pick<User, "Username">> | null>();
			const contacts = record.Contacts;
			expectTypeOf(contacts).toExtend<SoqlChildQueryResult<unknown> | null>();
			expectTypeOf(contacts!.records[0].Email).toEqualTypeOf<string | null>();
			expectTypeOf(contacts!.records[0].Account!.Name).toEqualTypeOf<string>();
		};
		expect(typeof run).toBe("function");

		const invalid = (): void => {
			// @ts-expect-error polymorphic Owner on Case is not in the registry
			sf.soql("Case").selectRelated("Owner", "Name");
			// @ts-expect-error unknown child relationship
			sf.soql("Account").selectChild("Opportunities", (q) => q);
			// @ts-expect-error field does not exist on the parent
			sf.soql("Contact").whereRelated("Account", "Email", "=", "x");
		};
		expect(typeof invalid).toBe("function");
	});

	it("checks field names, numeric aggregates and sObject names", () => {
		const invalid = (): void => {
			// @ts-expect-error unknown field
			sf.soql("Account").select("Nope");
			// @ts-expect-error unknown field in where
			sf.soql("Account").where("Nope", "=", 1);
			// @ts-expect-error SUM requires a numeric field
			sf.soql("Account").sum("Name", "total");
			// @ts-expect-error unknown sObject
			sf.soql("Opportunity");
		};
		expect(typeof invalid).toBe("function");

		const aggregate = sf.soql("Case").select("Status").sum("Score__c", "score").count("Id", "total");
		const run = async (): Promise<void> => {
			const [row] = await sf.collect(aggregate);
			expectTypeOf(row.score).toEqualTypeOf<number | null>();
			expectTypeOf(row.total).toEqualTypeOf<number>();
			expectTypeOf(row.Status).toEqualTypeOf<"New" | "Working" | "Closed">();
		};
		expect(typeof run).toBe("function");
		expect(() => sf.soql("Account").select("Id").where("Name", "=", "x").build()).not.toThrow();
	});

	it("checks create and update inputs", () => {
		const accounts = sf.sobject("Account");
		const run = async (): Promise<void> => {
			expectTypeOf(await accounts.create({ Name: "Acme", Industry: "Energy" })).toEqualTypeOf<string>();
			// @ts-expect-error Name is required
			await accounts.create({ Phone: "1" });
			// @ts-expect-error restricted picklist value
			await accounts.create({ Name: "A", Industry: "Retail" });
			// open picklists accept other strings
			await accounts.create({ Name: "A", Type: "Prospect" });
			// @ts-expect-error BillingAddress is not createable
			await accounts.create({ Name: "A", BillingAddress: null });
			// @ts-expect-error Id is not updateable
			await accounts.update("001", { Id: "001" });
			await accounts.update("001", { Name: "B" });

			const picked = await accounts.get("001", ["Id", "Name"]);
			expectTypeOf(picked).toEqualTypeOf<WithAttributes<Pick<Account, "Id" | "Name">>>();
			expectTypeOf(await accounts.get("001")).toEqualTypeOf<WithAttributes<Account>>();
			// @ts-expect-error unknown field
			await accounts.get("001", ["Nope"]);

			await accounts.upsert("External_Id__c", "X", { Name: "A" });
			await sf.collections.update("Account", [{ Id: "001", Name: "B" }]);
			// @ts-expect-error update records need an Id
			await sf.collections.update("Account", [{ Name: "B" }]);
		};
		expect(typeof run).toBe("function");
		expectTypeOf<AccountCreateInput>().toHaveProperty("Name");
	});

	it("types composite references and results", () => {
		const run = async (): Promise<void> => {
			const result = await sf.composite.execute((c) => {
				const account = c.create("Account", { Name: "Acme" });
				expectTypeOf(account).toEqualTypeOf<CompositeRef<SaveResult>>();
				c.create("Contact", { LastName: "Doe", AccountId: account.ref("id") });
				return { account, contacts: c.query(sf.soql("Contact").select("Id", "Email")) };
			});
			expectTypeOf(result.get(result.refs.account).id).toEqualTypeOf<string | undefined>();
			expectTypeOf(result.get(result.refs.contacts).records[0].Email).toEqualTypeOf<string | null>();
		};
		expect(typeof run).toBe("function");
	});

	it("types bulk query rows as flattened CSV strings", () => {
		type Row = BulkCsvRecord<WithAttributes<{ Id: string; Account: WithAttributes<{ Name: string }> | null }>>;
		expectTypeOf<Row>().toEqualTypeOf<{ Id: string; "Account.Name": string }>();
	});

	it("keeps the untyped client permissive", () => {
		const run = async (): Promise<void> => {
			await untyped.sobject("Anything__c").create({ Foo: 1 });
			const page = await untyped.query(
				untyped.soql("Whatever").select("A", "B").selectRelated("Parent", "C").sum("D", "d"),
			);
			expectTypeOf(page).toExtend<QueryResult<{ A: unknown }>>();
			const raw = await untyped.query<{ Name: string }>("SELECT Name FROM Account");
			expectTypeOf(raw.records[0].Name).toEqualTypeOf<string>();
		};
		expect(typeof run).toBe("function");
	});
});
