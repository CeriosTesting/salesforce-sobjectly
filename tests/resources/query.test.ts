import { describe, expect, it } from "vitest";

import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, type FakeResponse, FakeTransport } from "../helpers/fake-transport";

const page = (ids: string[], next?: string): FakeResponse => ({
	body: {
		totalSize: 3,
		done: next === undefined,
		nextRecordsUrl: next,
		records: ids.map((Id) => ({ attributes: { type: "Account" }, Id })),
	},
});

describe("queries", () => {
	it("runs a builder query and returns the first page", async () => {
		const transport = new FakeTransport().reply(page(["1", "2"], `${API}/query/01g-2`));
		const sf = createClient<SObjectRegistry>(transport);
		const result = await sf.query(sf.soql("Account").select("Id").limit(3));
		expect(transport.last.path).toBe(`${API}/query`);
		expect(transport.last.url.searchParams.get("q")).toBe("SELECT Id FROM Account LIMIT 3");
		expect(result.records.map((record) => record.Id)).toEqual(["1", "2"]);
		expect(result.done).toBe(false);

		transport.reply(page(["3"]));
		const next = await sf.queryMore(result.nextRecordsUrl!);
		expect(transport.last.path).toBe(`${API}/query/01g-2`);
		expect(next.records[0]?.Id).toBe("3");
	});

	it("uses queryAll for includeDeleted and sends batchSize", async () => {
		const transport = new FakeTransport().reply(page([]));
		await createClient(transport).query("SELECT Id FROM Account", { includeDeleted: true, batchSize: 500 });
		expect(transport.last.path).toBe(`${API}/queryAll`);
		expect(transport.last.headers.get("sforce-query-options")).toBe("batchSize=500");
		await expect(createClient(transport).query("SELECT Id FROM Account", { batchSize: 10 })).rejects.toThrow(
			/batchSize/,
		);
	});

	it("iterates and collects across pages", async () => {
		const transport = new FakeTransport().reply(
			page(["1"], `${API}/query/a-1`),
			page(["2"], `${API}/query/a-2`),
			page(["3"]),
		);
		const sf = createClient<SObjectRegistry>(transport);
		const ids: string[] = [];
		for await (const record of sf.iterate(sf.soql("Account").select("Id"))) {
			ids.push(record.Id);
		}
		expect(ids).toEqual(["1", "2", "3"]);

		transport.reply(page(["1"], `${API}/query/a-1`), page(["2"]));
		expect((await sf.sobject("Account").collect((q) => q.select("Id"))).map((record) => record.Id)).toEqual(["1", "2"]);
	});

	it("rejects blank SOQL and bad cursors", async () => {
		const sf = createClient(new FakeTransport());
		await expect(sf.query("  ")).rejects.toThrow(/non-blank/);
		await expect(sf.queryMore("https://evil.example.com/x" as never)).rejects.toThrow(/nextRecordsUrl/);
	});

	it("refuses to follow a cursor to another origin", async () => {
		const sf = createClient(new FakeTransport());
		await expect(sf.queryMore("https://evil.example.com/services/data/v67.0/query/x" as never)).rejects.toThrow(
			/Refusing/,
		);
	});

	it("queries through a sObject resource", async () => {
		const transport = new FakeTransport().reply(page(["1"]));
		const result = await createClient<SObjectRegistry>(transport)
			.sobject("Contact")
			.query((q) => q.select("Id", "Email").where("Email", "LIKE", "%@example.com"));
		expect(transport.last.url.searchParams.get("q")).toBe(
			"SELECT Id, Email FROM Contact WHERE Email LIKE '%@example.com'",
		);
		expect(result.records).toHaveLength(1);
	});
});

describe("org resources", () => {
	it("calls versions, resources, limits, recordCount and describeGlobal", async () => {
		const transport = new FakeTransport(() => ({ body: {} }));
		const sf = createClient<SObjectRegistry>(transport);
		await sf.versions();
		expect(transport.last.path).toBe("/services/data/");
		await sf.resources();
		expect(transport.last.path).toBe(`${API}/`);
		await sf.limits();
		expect(transport.last.path).toBe(`${API}/limits`);
		await sf.recordCount(["Account", "Contact"]);
		expect(transport.last.url.searchParams.get("sObjects")).toBe("Account,Contact");
		await sf.describeGlobal();
		expect(transport.last.path).toBe(`${API}/sobjects`);
		expect(await sf.instanceUrl()).toBe("https://example.my.salesforce.com");
	});

	it("calls Apex REST outside the versioned path", async () => {
		const transport = new FakeTransport().reply({ body: { ok: true } });
		await createClient(transport).apexRest({ method: "POST", path: "/ns/orders/1", body: { a: 1 } });
		expect(transport.last.path).toBe("/services/apexrest/ns/orders/1");
	});
});

describe("search", () => {
	it("runs SOSL, parameterized search and suggestions", async () => {
		const transport = new FakeTransport(() => ({ body: { searchRecords: [] } }));
		const sf = createClient(transport);
		await sf.search.sosl("FIND {Acme} RETURNING Account(Id)");
		expect(transport.last.path).toBe(`${API}/search`);
		expect(transport.last.url.searchParams.get("q")).toBe("FIND {Acme} RETURNING Account(Id)");
		await sf.search.parameterized({ q: "Acme", sobjects: [{ name: "Account", fields: ["Id"] }] });
		expect(transport.last.method).toBe("POST");
		expect(transport.last.path).toBe(`${API}/parameterizedSearch`);
		await sf.search.suggestions({ q: "Acm", sobject: "Account", limit: 5 });
		expect(transport.last.url.searchParams.get("sobject")).toBe("Account");
		expect(() => sf.search.sosl("")).toThrow(/non-blank/);
	});
});

describe("long queries", () => {
	const longIds = Array.from({ length: 800 }, (_, index) => `001${String(index).padStart(15, "0")}`);

	it("sends a query too long for a URL as a composite subrequest", async () => {
		const transport = new FakeTransport(() => ({
			body: {
				compositeResponse: [
					{
						referenceId: "query",
						httpStatusCode: 200,
						httpHeaders: {},
						body: page(["001A"], `${API}/query/01g-200`).body,
					},
				],
			},
		}));
		const sf = createClient<SObjectRegistry>(transport);
		const soql = sf.soql("Account").select("Id").whereIn("Id", longIds);
		const result = await sf.query(soql, { includeDeleted: true, batchSize: 500 });

		expect(result.records.map((record) => record.Id)).toEqual(["001A"]);
		expect(result.nextRecordsUrl).toBe(`${API}/query/01g-200`);
		expect(transport.last.method).toBe("POST");
		expect(transport.last.path).toBe(`${API}/composite`);
		expect(transport.last.json).toEqual({
			compositeRequest: [
				{
					method: "GET",
					referenceId: "query",
					url: `${API}/queryAll?q=${encodeURIComponent(soql.build())}`,
					httpHeaders: { "Sforce-Query-Options": "batchSize=500" },
				},
			],
		});
	});

	it("turns a failed subrequest into a SalesforceError", async () => {
		const transport = new FakeTransport(() => ({
			body: {
				compositeResponse: [
					{
						referenceId: "query",
						httpStatusCode: 400,
						httpHeaders: {},
						body: [{ errorCode: "MALFORMED_QUERY", message: "bad" }],
					},
				],
			},
		}));
		const sf = createClient(transport);
		const error = await sf.tooling
			.query(`SELECT Id FROM ApexClass WHERE Id IN ('${longIds.join("','")}')`)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ status: 400, errorCode: "MALFORMED_QUERY", path: "/tooling/query" });
		expect(transport.last.path).toBe(`${API}/tooling/composite`);
	});

	it("keeps short queries on GET", async () => {
		const transport = new FakeTransport(() => page(["001A"]));
		await createClient(transport).query("SELECT Id FROM Account");
		expect(transport.last.method).toBe("GET");
	});
});
