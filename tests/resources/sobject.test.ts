import { describe, expect, it } from "vitest";

import { SalesforceError, SalesforceSaveError } from "../../src/errors";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, FakeTransport } from "../helpers/fake-transport";

describe("sobject()", () => {
	it("creates a record and returns the id", async () => {
		const transport = new FakeTransport().reply({ status: 201, body: { id: "001A", success: true, errors: [] } });
		const sf = createClient<SObjectRegistry>(transport);
		expect(await sf.sobject("Account").create({ Name: "Acme" })).toBe("001A");
		expect(transport.last.method).toBe("POST");
		expect(transport.last.path).toBe(`${API}/sobjects/Account`);
		expect(transport.last.json).toEqual({ Name: "Acme" });
	});

	it("throws SalesforceSaveError when success is false", async () => {
		const transport = new FakeTransport().reply({
			status: 201,
			body: { success: false, errors: [{ statusCode: "DUPLICATES_DETECTED", message: "dup", fields: [] }] },
		});
		await expect(
			createClient<SObjectRegistry>(transport).sobject("Account").create({ Name: "A" }),
		).rejects.toBeInstanceOf(SalesforceSaveError);
	});

	it("gets a record, optionally with fields", async () => {
		const record = { attributes: { type: "Account" }, Id: "001A", Name: "Acme" };
		const transport = new FakeTransport().reply({ body: record }, { body: record });
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		expect(await accounts.get("001A", ["Id", "Name"])).toEqual(record);
		expect(transport.last.url.search).toBe("?fields=Id%2CName");
		await accounts.get("001A");
		expect(transport.last.url.search).toBe("");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/001A`);
	});

	it("updates and deletes", async () => {
		const transport = new FakeTransport().reply({ status: 204 }, { status: 204 });
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		await accounts.update("001A", { Phone: "123" });
		expect(transport.last.method).toBe("PATCH");
		expect(transport.last.json).toEqual({ Phone: "123" });
		await accounts.delete("001A");
		expect(transport.last.method).toBe("DELETE");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/001A`);
	});

	it("encodes ids and rejects empty ones", async () => {
		const transport = new FakeTransport().reply({ status: 204 });
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		await accounts.delete("../../x");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/..%2F..%2Fx`);
		await expect(accounts.delete("")).rejects.toThrow(/record id/);
	});

	it("upserts by external id and reports created/updated", async () => {
		const transport = new FakeTransport().reply(
			{ status: 201, body: { id: "001A", success: true, errors: [], created: true } },
			{ status: 200, body: { id: "001A", success: true, errors: [], created: false } },
			{ status: 204 },
		);
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		expect(await accounts.upsert("External_Id__c", "EXT 1", { Name: "Acme" })).toEqual({ id: "001A", created: true });
		expect(transport.last.path).toBe(`${API}/sobjects/Account/External_Id__c/EXT%201`);
		expect(await accounts.upsert("External_Id__c", "EXT 1", { Name: "Acme" }, { updateOnly: true })).toEqual({
			id: "001A",
			created: false,
		});
		expect(transport.last.url.searchParams.get("updateOnly")).toBe("true");
		expect(await accounts.upsert("External_Id__c", 5, { Name: "Acme" })).toEqual({ id: "", created: false });
	});

	it("surfaces 300 Multiple Choices as SalesforceError", async () => {
		const transport = new FakeTransport().reply({ status: 300, body: ["/services/data/v67.0/sobjects/Account/001A"] });
		const error = await createClient<SObjectRegistry>(transport)
			.sobject("Account")
			.upsert("External_Id__c", "dup", { Name: "A" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceError);
		expect((error as SalesforceError).status).toBe(300);
	});

	it("reads deleted/updated ids, blobs and describe", async () => {
		const transport = new FakeTransport().reply(
			{ body: { deletedRecords: [], earliestDateAvailable: "", latestDateCovered: "" } },
			{ body: { ids: ["001"], latestDateCovered: "" } },
			{ body: new Uint8Array([1, 2]), headers: { "content-type": "application/octet-stream" } },
			{ body: { name: "Account", fields: [] } },
		);
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		await accounts.getDeleted(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		expect(transport.last.url.searchParams.get("start")).toBe("2026-01-01T00:00:00+00:00");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/deleted/`);
		expect((await accounts.getUpdated(new Date(), new Date())).ids).toEqual(["001"]);
		expect(await accounts.getBlob("001", "Description")).toEqual(new Uint8Array([1, 2]));
		expect((await accounts.describe()).name).toBe("Account");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/describe`);
	});

	it("gets by external id", async () => {
		const transport = new FakeTransport().reply({ body: { Id: "001" } });
		await createClient<SObjectRegistry>(transport).sobject("Account").getByExternalId("External_Id__c", "A/1", ["Id"]);
		expect(transport.last.path).toBe(`${API}/sobjects/Account/External_Id__c/A%2F1`);
		expect(transport.last.url.searchParams.get("fields")).toBe("Id");
	});

	it("rejects invalid sObject names", () => {
		expect(() => createClient(new FakeTransport()).sobject("Account/../x")).toThrow(/Invalid sObject/);
	});
});

describe("sobject() relationships, list views and layouts", () => {
	it("reads child and parent records by relationship name", async () => {
		const transport = new FakeTransport().reply(
			{ body: { totalSize: 1, done: true, records: [{ attributes: { type: "Contact" }, LastName: "Doe" }] } },
			{ body: { attributes: { type: "Account" }, Name: "Acme" } },
		);
		const sf = createClient<SObjectRegistry>(transport);
		const contacts = await sf.sobject("Account").children("001", "Contacts", ["LastName"]);
		expect(contacts.records[0]?.LastName).toBe("Doe");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/001/Contacts`);
		expect(transport.last.url.search).toBe("?fields=LastName");
		const account = await sf.sobject("Contact").parent("003", "Account");
		expect(account.Name).toBe("Acme");
		expect(transport.last.path).toBe(`${API}/sobjects/Contact/003/Account`);
		expect(transport.last.url.search).toBe("");
		expect(() => sf.sobject("Account").children(" ", "Contacts")).toThrow(/record id/);
	});

	it("calls the list view resources", async () => {
		const transport = new FakeTransport(() => ({ body: {} }));
		const accounts = createClient<SObjectRegistry>(transport).sobject("Account");
		await accounts.listViews();
		await accounts.recentListViews();
		await accounts.listViewDescribe("00B1");
		await accounts.listViewResults("00B1", { limit: 10, offset: 20 });
		expect(transport.requests.map((request) => `${request.path}${request.url.search}`)).toEqual([
			`${API}/sobjects/Account/listviews`,
			`${API}/sobjects/Account/listviews/recent`,
			`${API}/sobjects/Account/listviews/00B1/describe`,
			`${API}/sobjects/Account/listviews/00B1/results?limit=10&offset=20`,
		]);
	});

	it("calls the layout resources", async () => {
		const transport = new FakeTransport(() => ({ body: {} }));
		const cases = createClient<SObjectRegistry>(transport).sobject("Case");
		await cases.layouts();
		await cases.layouts("012A", { signal: new AbortController().signal });
		await cases.compactLayouts();
		await cases.approvalLayouts();
		await cases.approvalLayouts({ approvalProcessName: "Escalation" });
		expect(transport.requests.map((request) => request.path)).toEqual([
			`${API}/sobjects/Case/describe/layouts`,
			`${API}/sobjects/Case/describe/layouts/012A`,
			`${API}/sobjects/Case/describe/compactLayouts`,
			`${API}/sobjects/Case/describe/approvalLayouts`,
			`${API}/sobjects/Case/describe/approvalLayouts/Escalation`,
		]);
		expect(transport.requests[1]?.signal).toBeDefined();
	});
});

describe("recently viewed and user passwords", () => {
	it("lists recently viewed records", async () => {
		const transport = new FakeTransport().reply({ body: [{ attributes: { type: "Account" }, Id: "001", Name: "A" }] });
		const items = await createClient(transport).recentlyViewed({ limit: 5 });
		expect(items[0]?.Name).toBe("A");
		expect(`${transport.last.path}${transport.last.url.search}`).toBe(`${API}/recent?limit=5`);
	});

	it("checks, sets and resets a password", async () => {
		const transport = new FakeTransport().reply(
			{ body: { isExpired: true } },
			{ status: 204 },
			{ body: { NewPassword: "generated" } },
		);
		const users = createClient(transport).users;
		expect(await users.passwordExpired("005A")).toBe(true);
		expect(transport.last.path).toBe(`${API}/sobjects/User/005A/password`);
		await users.setPassword("005A", "s3cret!");
		expect(transport.last.method).toBe("POST");
		expect(transport.last.json).toEqual({ NewPassword: "s3cret!" });
		expect(await users.resetPassword("005A")).toBe("generated");
		expect(transport.last.method).toBe("DELETE");
		await expect(users.setPassword("005A", "")).rejects.toThrow(/new password/);
		await expect(users.passwordExpired("")).rejects.toThrow(/user id/);
	});
});
