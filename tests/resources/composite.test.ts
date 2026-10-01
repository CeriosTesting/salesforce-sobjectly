import { describe, expect, it } from "vitest";

import { SalesforceError, SalesforcePartialFailureError, SalesforceSaveError } from "../../src/errors";
import type { SaveResult } from "../../src/types/common";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, type FakeResponse, FakeTransport } from "../helpers/fake-transport";

describe("composite.execute", () => {
	it("builds subrequests with references and reads typed results", async () => {
		const transport = new FakeTransport().reply({
			body: {
				compositeResponse: [
					{ referenceId: "ref1", httpStatusCode: 201, httpHeaders: {}, body: { id: "001", success: true, errors: [] } },
					{
						referenceId: "contact",
						httpStatusCode: 201,
						httpHeaders: {},
						body: { id: "003", success: true, errors: [] },
					},
					{
						referenceId: "ref3",
						httpStatusCode: 200,
						httpHeaders: {},
						body: { totalSize: 1, done: true, records: [{ attributes: { type: "Contact" }, Id: "003" }] },
					},
				],
			},
		});
		const sf = createClient<SObjectRegistry>(transport);
		const result = await sf.composite.execute(
			(c) => {
				const account = c.create("Account", { Name: "Acme" });
				const contact = c.create(
					"Contact",
					{ LastName: "Doe", AccountId: account.ref("id") },
					{ referenceId: "contact" },
				);
				const contacts = c.query(sf.soql("Contact").select("Id").where("AccountId", "=", account.ref("id")));
				return { account, contact, contacts };
			},
			{ allOrNone: true },
		);

		expect(transport.last.path).toBe(`${API}/composite`);
		expect(transport.last.json).toEqual({
			allOrNone: true,
			compositeRequest: [
				{ method: "POST", url: `${API}/sobjects/Account`, referenceId: "ref1", body: { Name: "Acme" } },
				{
					method: "POST",
					url: `${API}/sobjects/Contact`,
					referenceId: "contact",
					body: { LastName: "Doe", AccountId: "@{ref1.id}" },
				},
				{
					method: "GET",
					// References stay readable; Salesforce doesn't substitute an encoded one.
					url: `${API}/query?q=${encodeURIComponent("SELECT Id FROM Contact WHERE AccountId = '")}@{ref1.id}'`,
					referenceId: "ref3",
				},
			],
		});
		expect(result.get(result.refs.account).id).toBe("001");
		expect(result.get(result.refs.contacts).records[0]?.Id).toBe("003");
		expect(result.hasErrors).toBe(false);
	});

	it("throws for failed subrequests on get() or with throwOnError", async () => {
		const response = {
			body: {
				compositeResponse: [
					{
						referenceId: "ref1",
						httpStatusCode: 400,
						httpHeaders: {},
						body: [{ errorCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing: [Name]" }],
					},
					{
						referenceId: "ref2",
						httpStatusCode: 400,
						httpHeaders: {},
						body: [{ errorCode: "PROCESSING_HALTED", message: "halted" }],
					},
				],
			},
		};
		const transport = new FakeTransport().reply(response, response);
		const sf = createClient<SObjectRegistry>(transport);
		const result = await sf.composite.execute((c) => ({
			account: c.create("Account", { Name: "" }),
			other: c.delete("Account", "001"),
		}));
		expect(result.hasErrors).toBe(true);
		expect(() => result.get(result.refs.account)).toThrow(SalesforceError);
		await expect(
			sf.composite.execute((c) => c.create("Account", { Name: "" }), { throwOnError: true }),
		).rejects.toMatchObject({ errorCode: "REQUIRED_FIELD_MISSING" });
	});

	it("enforces subrequest limits and reference id rules", async () => {
		const sf = createClient<SObjectRegistry>(new FakeTransport());
		await expect(sf.composite.execute(() => undefined)).rejects.toThrow(/1 to 25/);
		await expect(
			sf.composite.execute((c) => {
				for (let index = 0; index < 26; index++) {
					c.delete("Account", `00${index}`);
				}
			}),
		).rejects.toThrow(/1 to 25/);
		await expect(
			sf.composite.execute((c) => {
				for (let index = 0; index < 6; index++) {
					c.query("SELECT Id FROM Account");
				}
			}),
		).rejects.toThrow(/at most 5/);
		await expect(sf.composite.execute((c) => c.delete("Account", "1", { referenceId: "bad-id" }))).rejects.toThrow(
			/Invalid composite referenceId/,
		);
		await expect(
			sf.composite.execute((c) => {
				c.delete("Account", "1", { referenceId: "a" });
				c.delete("Account", "2", { referenceId: "a" });
			}),
		).rejects.toThrow(/Duplicate/);
	});

	it("supports update, upsert, get and raw subrequests", async () => {
		const transport = new FakeTransport().reply({ body: { compositeResponse: [] } });
		await createClient<SObjectRegistry>(transport).composite.execute((c) => {
			c.update("Account", "001", { Name: "B" });
			c.upsert("Account", "External_Id__c", "X 1", { Name: "C" });
			c.get("Account", "001", ["Id", "Name"]);
			c.request({ method: "GET", path: "/limits" });
		});
		const urls = (transport.last.json as { compositeRequest: { url: string }[] }).compositeRequest.map(
			(item) => item.url,
		);
		expect(urls).toEqual([
			`${API}/sobjects/Account/001`,
			`${API}/sobjects/Account/External_Id__c/X%201`,
			`${API}/sobjects/Account/001?fields=Id,Name`,
			`${API}/limits`,
		]);
	});
});

describe("composite batch, tree and graph", () => {
	it("sends batch subrequests with versioned urls", async () => {
		const transport = new FakeTransport().reply({ body: { hasErrors: false, results: [] } });
		await createClient(transport).composite.batch(
			[
				{ method: "GET", path: "/sobjects/Account/001" },
				{ method: "PATCH", path: "sobjects/Account/001", body: { Name: "X" } },
			],
			{ haltOnError: true },
		);
		expect(transport.last.json).toEqual({
			haltOnError: true,
			batchRequests: [
				{ method: "GET", url: "v67.0/sobjects/Account/001" },
				{ method: "PATCH", url: "v67.0/sobjects/Account/001", richInput: { Name: "X" } },
			],
		});
		await expect(createClient(transport).composite.batch([])).rejects.toThrow(/1 to 25/);
	});

	it("posts an sObject tree and counts nested records", async () => {
		const transport = new FakeTransport().reply({ status: 201, body: { hasErrors: false, results: [] } });
		const sf = createClient<SObjectRegistry>(transport);
		await sf.composite.tree("Account", [
			{
				attributes: { type: "Account", referenceId: "acc1" },
				Name: "Acme",
				Contacts: { records: [{ attributes: { type: "Contact", referenceId: "c1" }, LastName: "Doe" }] },
			},
		]);
		expect(transport.last.path).toBe(`${API}/composite/tree/Account`);
		const tooMany = Array.from(
			{ length: 201 },
			(_, index): { attributes: { type: "Account"; referenceId: string }; Name: string } => ({
				attributes: { type: "Account" as const, referenceId: `a${index}` },
				Name: "x",
			}),
		);
		expect(() => sf.composite.tree("Account", tooMany)).toThrow(/1 to 200/);
	});

	it("builds graphs and wraps each graph response", async () => {
		const transport = new FakeTransport().reply({
			body: {
				graphs: [
					{
						graphId: "g1",
						isSuccessful: true,
						graphResponse: {
							compositeResponse: [
								{
									referenceId: "g1_1",
									httpStatusCode: 201,
									httpHeaders: {},
									body: { id: "001", success: true, errors: [] },
								},
							],
						},
					},
				],
			},
		});
		let ref: { referenceId: string } | undefined;
		const [graph] = await createClient<SObjectRegistry>(transport).composite.graph([
			{
				graphId: "g1",
				build: (c): void => {
					ref = c.create("Account", { Name: "A" }, { referenceId: "g1_1" });
				},
			},
		]);
		expect(transport.last.path).toBe(`${API}/composite/graph`);
		expect(graph?.isSuccessful).toBe(true);
		expect(graph?.response.responses[0]?.referenceId).toBe(ref?.referenceId);
		await expect(
			createClient(transport).composite.graph([{ graphId: "empty", build: (): void => undefined }]),
		).rejects.toThrow(/no subrequests/);
	});
});

describe("collections", () => {
	const ok = (count: number): FakeResponse => ({
		body: Array.from({ length: count }, (_, index) => ({ id: `id${index}`, success: true, errors: [] })),
	});

	it("creates records with attributes", async () => {
		const transport = new FakeTransport().reply(ok(2));
		const results = await createClient<SObjectRegistry>(transport).collections.create(
			"Account",
			[{ Name: "A" }, { Name: "B" }],
			{ allOrNone: true },
		);
		expect(results).toHaveLength(2);
		expect(transport.last.method).toBe("POST");
		expect(transport.last.path).toBe(`${API}/composite/sobjects`);
		expect(transport.last.json).toEqual({
			allOrNone: true,
			records: [
				{ attributes: { type: "Account" }, Name: "A" },
				{ attributes: { type: "Account" }, Name: "B" },
			],
		});
	});

	it("chunks more than 200 records only when allowed", async () => {
		const transport = new FakeTransport().reply(ok(200), ok(50));
		const collections = createClient<SObjectRegistry>(transport).collections;
		const records = Array.from({ length: 250 }, (_, index): { Id: string; Name: string } => ({
			Id: `001${index}`,
			Name: "X",
		}));
		await expect(collections.update("Account", records)).rejects.toThrow(/at most 200/);
		await expect(collections.update("Account", records, { chunk: true, allOrNone: true })).rejects.toThrow(/allOrNone/);
		expect(await collections.update("Account", records, { chunk: true })).toHaveLength(250);
		expect(transport.requests).toHaveLength(2);
	});

	it("throws SalesforceSaveError on partial failure unless throwOnError is false", async () => {
		const failure = {
			body: [
				{ id: "1", success: true, errors: [] },
				{ success: false, errors: [{ statusCode: "INVALID_FIELD", message: "bad", fields: ["Name"] }] },
			],
		};
		const transport = new FakeTransport().reply(failure, failure);
		const collections = createClient<SObjectRegistry>(transport).collections;
		const error = await collections
			.create("Account", [{ Name: "A" }, { Name: "B" }])
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect((error as SalesforceSaveError).results).toHaveLength(2);
		expect((error as SalesforceSaveError).errors[0]?.statusCode).toBe("INVALID_FIELD");
		expect(await collections.create("Account", [{ Name: "A" }, { Name: "B" }], { throwOnError: false })).toHaveLength(
			2,
		);
	});

	it("upserts, deletes and retrieves", async () => {
		const transport = new FakeTransport().reply(ok(1), ok(2), { body: [{ Id: "1", Name: "A" }, null] });
		const collections = createClient<SObjectRegistry>(transport).collections;
		await collections.upsert("Account", "External_Id__c", [{ Name: "A", External_Id__c: "X" }]);
		expect(transport.last.path).toBe(`${API}/composite/sobjects/Account/External_Id__c`);
		await collections.delete(["1", "2"], { allOrNone: true });
		expect(transport.last.method).toBe("DELETE");
		expect(transport.last.url.searchParams.get("ids")).toBe("1,2");
		expect(transport.last.url.searchParams.get("allOrNone")).toBe("true");
		const records = await collections.retrieve("Account", ["1", "2"], ["Id", "Name"]);
		expect(records[1]).toBeNull();
		expect(transport.last.json).toEqual({ ids: ["1", "2"], fields: ["Id", "Name"] });
		await expect(collections.delete([])).rejects.toThrow(/At least one/);
	});
});

describe("collections partial failures", () => {
	const ok = (count: number, prefix = "id"): FakeResponse => ({
		body: Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, success: true, errors: [] })),
	});
	const serverError: FakeResponse = { status: 503, body: [{ errorCode: "SERVER_UNAVAILABLE", message: "try later" }] };
	const records = Array.from({ length: 450 }, (_, index): { Name: string } => ({ Name: `A${index}` }));

	it("keeps the results of committed chunks when a later chunk fails", async () => {
		const transport = new FakeTransport().reply(ok(200, "a"), serverError);
		const error = await createClient<SObjectRegistry>(transport)
			.collections.create("Account", records, { chunk: true })
			.catch((caught: unknown) => caught);
		expect(transport.requests).toHaveLength(2);
		expect(error).toBeInstanceOf(SalesforcePartialFailureError);
		const partial = error as SalesforcePartialFailureError<SaveResult>;
		expect(partial.completedResults).toHaveLength(200);
		expect(partial.completedResults[199]?.id).toBe("a199");
		expect(partial.cause).toBeInstanceOf(SalesforceError);
		expect(partial.message).toBe(
			"Creating Account records failed (200 item(s) were already processed): Salesforce POST /composite/sobjects failed with status 503 - SERVER_UNAVAILABLE: try later",
		);
	});

	it("collects every successful chunk before the failing one", async () => {
		const transport = new FakeTransport().reply(ok(200, "a"), ok(200, "b"), serverError);
		const error = await createClient<SObjectRegistry>(transport)
			.collections.update(
				"Account",
				records.map((record, index) => ({ ...record, Id: `001${index}` })),
				{ chunk: true },
			)
			.catch((caught: unknown) => caught);
		expect(transport.requests).toHaveLength(3);
		const partial = error as SalesforcePartialFailureError<SaveResult>;
		expect(partial).toBeInstanceOf(SalesforcePartialFailureError);
		expect(partial.completedResults.map((result) => result.id)).toEqual([
			...Array.from({ length: 200 }, (_, index) => `a${index}`),
			...Array.from({ length: 200 }, (_, index) => `b${index}`),
		]);
		expect(partial.message).toMatch(/^Updating Account records failed \(400 item\(s\)/);
	});

	it("wraps chunked deletes and rethrows a first-chunk failure as is", async () => {
		const ids = Array.from({ length: 201 }, (_, index) => `001${index}`);
		const transport = new FakeTransport().reply(ok(200), serverError, serverError);
		const collections = createClient<SObjectRegistry>(transport).collections;
		const error = await collections.delete(ids, { chunk: true }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforcePartialFailureError);
		expect((error as SalesforcePartialFailureError).completedResults).toHaveLength(200);
		expect((error as Error).message).toMatch(/^Deleting records failed/);
		expect(transport.last.url.searchParams.get("ids")).toBe("001200");

		const first = await collections.delete(ids, { chunk: true }).catch((caught: unknown) => caught);
		expect(first).toBeInstanceOf(SalesforceError);
		expect(first).not.toBeInstanceOf(SalesforcePartialFailureError);
	});
});

describe("composite reference ids", () => {
	const subrequests = (transport: FakeTransport): { referenceId: string; url: string }[] =>
		(transport.last.json as { compositeRequest: { referenceId: string; url: string }[] }).compositeRequest;

	it("skips ids already taken by a custom referenceId", async () => {
		const transport = new FakeTransport().reply({ body: { compositeResponse: [] } });
		const result = await createClient<SObjectRegistry>(transport).composite.execute((c) => ({
			custom: c.create("Account", { Name: "A" }, { referenceId: "ref2" }),
			first: c.create("Account", { Name: "B" }),
			second: c.create("Account", { Name: "C" }),
			customLater: c.create("Account", { Name: "D" }, { referenceId: "ref5" }),
			third: c.create("Account", { Name: "E" }),
		}));
		expect(subrequests(transport).map((item) => item.referenceId)).toEqual(["ref2", "ref3", "ref4", "ref5", "ref6"]);
		expect(result.refs.first.referenceId).toBe("ref3");
		expect(result.refs.third.ref("id")).toBe("@{ref6.id}");
	});

	it("generates unique, valid ids among many custom ones", async () => {
		const transport = new FakeTransport().reply({ body: { compositeResponse: [] } });
		await createClient<SObjectRegistry>(transport).composite.execute((c) => {
			for (let index = 0; index < 25; index++) {
				const custom = index % 3 === 0 ? { referenceId: `ref${25 - index}` } : undefined;
				c.delete("Account", `001${index}`, custom);
			}
		});
		const ids = subrequests(transport).map((item) => item.referenceId);
		expect(ids).toHaveLength(25);
		expect(new Set(ids).size).toBe(25);
		expect(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(id))).toBe(true);
	});

	it("rejects a custom id that an earlier generated id already uses", async () => {
		const sf = createClient<SObjectRegistry>(new FakeTransport());
		await expect(
			sf.composite.execute((c) => {
				c.create("Account", { Name: "A" });
				c.create("Account", { Name: "B" }, { referenceId: "ref1" });
			}),
		).rejects.toThrow('Duplicate composite referenceId "ref1".');
		await expect(
			sf.composite.execute((c) => c.create("Account", { Name: "A" }, { referenceId: "_x" })),
		).rejects.toThrow(/Invalid composite referenceId "_x"/);
		await expect(sf.composite.execute((c) => c.create("Account", { Name: "A" }, { referenceId: "" }))).rejects.toThrow(
			/Invalid composite referenceId/,
		);
	});

	it("generates ids per graph", async () => {
		const transport = new FakeTransport().reply({ body: { graphs: [] } });
		await createClient<SObjectRegistry>(transport).composite.graph([
			{
				graphId: "g1",
				build: (c): void => {
					c.create("Account", { Name: "A" }, { referenceId: "ref1" });
					c.create("Account", { Name: "B" });
				},
			},
			{ graphId: "g2", build: (c): void => void c.create("Account", { Name: "C" }) },
		]);
		const graphs = (transport.last.json as { graphs: { compositeRequest: { referenceId: string }[] }[] }).graphs;
		expect(graphs.map((graph) => graph.compositeRequest.map((item) => item.referenceId))).toEqual([
			["ref1", "ref2"],
			["ref1"],
		]);
	});

	it("counts raw query and collection subrequests against the limit of 5", async () => {
		const sf = createClient<SObjectRegistry>(new FakeTransport().reply({ body: { compositeResponse: [] } }));
		await expect(
			sf.composite.execute((c) => {
				c.request({ method: "GET", path: "/query?q=SELECT+Id+FROM+Account" });
				c.request({ method: "GET", path: "/services/data/v67.0/queryAll?q=x" });
				c.request({ method: "GET", path: "tooling/query?q=x" });
				c.request({ method: "POST", path: "/composite/sobjects", body: { records: [] } });
				c.request({ method: "GET", path: "/composite/sobjects/Account?ids=1&fields=Id" });
				c.query("SELECT Id FROM Account");
			}),
		).rejects.toThrow("A composite request allows at most 5 query/collection subrequests, got 6.");
		await sf.composite.execute((c) => {
			for (let index = 0; index < 5; index++) {
				c.request({ method: "GET", path: "/query?q=x" });
			}
			c.request({ method: "GET", path: "/queryPlans" });
			c.request({ method: "GET", path: "/sobjects/Account/describe" });
		});
	});
});

describe("composite references in URLs", () => {
	it("keeps @{...} references unencoded in ids, external ids and queries", async () => {
		const transport = new FakeTransport(() => ({ body: { compositeResponse: [] } }));
		const sf = createClient(transport);
		await sf.composite.execute(
			(c) => {
				const account = c.create("Account", { Name: "Acme" });
				c.get("Account", account.ref("id"), ["Name"]);
				c.update("Account", account.ref("id"), { Name: "x" });
				c.upsert("Account", "Ext__c", "a/b @{ref1.id}", { Name: "y" });
				c.delete("Account", "001 x");
				return { account };
			},
			{ throwOnError: false },
		);
		const urls = (transport.last.json as { compositeRequest: { url: string }[] }).compositeRequest.map(
			(request) => request.url,
		);
		expect(urls.slice(1)).toEqual([
			`${API}/sobjects/Account/@{ref1.id}?fields=Name`,
			`${API}/sobjects/Account/@{ref1.id}`,
			`${API}/sobjects/Account/Ext__c/a%2Fb%20@{ref1.id}`,
			`${API}/sobjects/Account/001%20x`,
		]);
	});
});
