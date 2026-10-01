/** SOQL builder, long queries, deleted records and errors against a real org. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasErrorCode, isSalesforceError } from "../../src/errors";
import type { SalesforceClient } from "../../src/index";
import { soqlDate, soqlDateLiteral, soqlLike, soqlLiteral } from "../../src/soql/escape";

import { liveClient, liveOrgConfigured, runMarker } from "./org";

describe.skipIf(!liveOrgConfigured)("live org: queries", () => {
	let sf: SalesforceClient;
	const marker = `${runMarker}-query`;
	let accountId = "";
	let contactIds: string[] = [];

	beforeAll(async () => {
		sf = liveClient();
		accountId = await sf.sobject("Account").create({
			Name: `${marker} 50% off_deal`,
			Industry: "Energy",
			NumberOfEmployees: 42,
			Site: "it's \\ here",
			Description: "line one\nline 'two' \\ three",
		});
		const results = await sf.collections.create("Contact", [
			{ LastName: `${marker} A`, AccountId: accountId, Birthdate: "1990-05-17" },
			{ LastName: `${marker} B`, AccountId: accountId },
		]);
		contactIds = results.map((result) => result.id ?? "");
	});

	afterAll(async () => {
		await sf.collections.delete([...contactIds, accountId].filter(Boolean), { throwOnError: false });
	});

	it("round-trips escaped text and matches LIKE patterns literally", async () => {
		const [exact] = await sf.collect(
			sf
				.soql("Account")
				.select("Id", "Description")
				.where("Name", "LIKE", soqlLike(`${marker} 50% off_`, "startsWith")),
		);
		expect(exact?.Id).toBe(accountId);
		expect(exact?.Description).toBe("line one\nline 'two' \\ three");
		// Without escaping, `_` and `%` are wildcards and would match this record too.
		const literal = await sf.collect(
			sf
				.soql("Account")
				.select("Id")
				.where("Name", "LIKE", soqlLike(`${marker} 50X off`, "startsWith")),
		);
		expect(literal).toHaveLength(0);
		const description = await sf.collect(
			sf.soql("Account").select("Id").where("Id", "=", accountId).where("Site", "LIKE", soqlLike("'s \\")),
		);
		expect(description).toHaveLength(1);
	});

	it("selects parents, children, nulls and dates", async () => {
		const [account] = await sf.collect(
			sf
				.soql("Account")
				.select("Id", "Name")
				.selectRelated("Owner", "Name")
				.selectChild("Contacts", (contacts) => contacts.select("LastName", "Birthdate").orderBy("LastName"))
				.where("Id", "=", accountId)
				.where("ParentId", "=", null)
				.where("CreatedDate", "=", soqlDateLiteral("TODAY"))
				.where("NumberOfEmployees", ">=", 42),
		);
		expect(account?.Owner).toMatchObject({ Name: expect.any(String) });
		type Contacts = { records: { LastName: string; Birthdate: string | null }[] } | undefined;
		const contacts = (account?.Contacts as unknown as Contacts)?.records ?? [];
		expect(contacts.map((contact) => [contact.LastName, contact.Birthdate])).toEqual([
			[`${marker} A`, "1990-05-17"],
			[`${marker} B`, null],
		]);

		const born = await sf.collect(
			sf
				.soql("Contact")
				.select("Id")
				.where("AccountId", "=", accountId)
				.where("Birthdate", "=", soqlDate("1990-05-17")),
		);
		expect(born).toHaveLength(1);
		const recent = await sf.collect(
			sf
				.soql("Contact")
				.select("Id")
				.where("AccountId", "=", accountId)
				.where("CreatedDate", ">", new Date(Date.now() - 3_600_000)),
		);
		expect(recent).toHaveLength(2);
	});

	it("groups, counts and filters with OR / NOT groups", async () => {
		const total = await sf.query(sf.soql("Contact").count().where("AccountId", "=", accountId));
		expect(total.totalSize).toBe(2);

		const grouped = await sf.collect(
			sf
				.soql("Contact")
				.select("AccountId")
				.count("Id", "total")
				.where("AccountId", "=", accountId)
				.groupBy("AccountId"),
		);
		expect(grouped).toEqual([expect.objectContaining({ AccountId: accountId, total: 2 })]);

		const either = await sf.collect(
			sf
				.soql("Contact")
				.select("LastName")
				.where("AccountId", "=", accountId)
				.whereGroup((group) => group.where("LastName", "=", `${marker} A`).where("Birthdate", "=", null), "OR")
				.whereNot((group) => group.where("LastName", "=", `${marker} B`)),
		);
		expect(either.map((contact) => contact.LastName)).toEqual([`${marker} A`]);
		const raw = await sf.collect(
			sf.soql("Account").select("Id").where("Id", "=", accountId).whereRaw("Name LIKE 'nope%' OR Industry = 'Energy'"),
		);
		expect(raw).toHaveLength(1);
	});

	it("runs a whereIn too long for a URL through composite", async () => {
		const fake = Array.from({ length: 900 }, (_, index) => `003000000000${String(index).padStart(6, "0")}`);
		const query = sf
			.soql("Contact")
			.select("Id")
			.whereIn("Id", [...fake, ...contactIds]);
		expect(encodeURIComponent(query.build()).length).toBeGreaterThan(16_000);
		const rows = await sf.collect(query);
		const byId = (a: unknown, b: unknown): number => String(a).localeCompare(String(b));
		expect(rows.map((row) => row.Id).sort(byId)).toEqual([...contactIds].sort(byId));
		const tooling = await sf.tooling.query(
			`SELECT Id FROM ApexClass WHERE Id IN (${fake.map((id) => soqlLiteral(`'${id}'`).sql).join(",")})`,
		);
		expect(tooling.records).toEqual([]);
	});

	it("finds deleted records with includeDeleted", async () => {
		const id = await sf.sobject("Contact").create({ LastName: `${marker} deleted` });
		await sf.sobject("Contact").delete(id);
		const soql = `SELECT Id, IsDeleted FROM Contact WHERE Id = '${id}'`;
		expect(await sf.collect(soql)).toEqual([]);
		expect(await sf.collect(soql, { includeDeleted: true })).toEqual([
			expect.objectContaining({ Id: id, IsDeleted: true }),
		]);
	});

	it("reports query errors with typed codes", async () => {
		const error = await sf.collect("SELECT Nope__c FROM Account").catch((caught: unknown) => caught);
		expect(isSalesforceError(error)).toBe(true);
		expect(hasErrorCode(error, "INVALID_FIELD")).toBe(true);
		const longError = await sf
			.collect(`SELECT Nope__c FROM Account WHERE Name IN ('${"x".repeat(20_000)}')`)
			.catch((caught: unknown) => caught);
		expect(hasErrorCode(longError, "INVALID_FIELD")).toBe(true);
	});

	it("explains and counts", async () => {
		const plans = await sf.explain(sf.soql("Account").select("Id").where("Name", "=", "x"));
		expect(plans[0]?.relativeCost).toEqual(expect.any(Number));
		const counts = await sf.recordCount(["Account", "Contact"]);
		expect(counts.sObjects.map((item) => item.name).sort()).toEqual(["Account", "Contact"]);
	});
});
