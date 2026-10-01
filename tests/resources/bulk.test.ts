import { describe, expect, it } from "vitest";

import { SalesforceBulkJobError } from "../../src/errors";
import { parseCsv, parseCsvRows, toCsv } from "../../src/resources/csv";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, type FakeResponse, FakeTransport } from "../helpers/fake-transport";

const job = (state: string, extra: Record<string, unknown> = {}): FakeResponse => ({
	body: {
		id: "750J",
		object: "Account",
		operation: "insert",
		state,
		columnDelimiter: "COMMA",
		lineEnding: "LF",
		...extra,
	},
});

describe("csv", () => {
	it("serializes records with nulls, dates, relationships and quoting", () => {
		expect(
			toCsv([
				{ Name: 'Acme, "Inc"', Phone: null, Account: { External_Id__c: "A1" } },
				{ Name: " padded", Birthdate: new Date("2026-01-02T00:00:00.000Z"), Tags: ["a", "b"], Active: true },
			]),
		).toBe(
			'Name,Phone,Account.External_Id__c,Birthdate,Tags,Active\n"Acme, ""Inc""",#N/A,A1,,,\n" padded",,,2026-01-02T00:00:00.000Z,a;b,true\n',
		);
		expect(toCsv([{ A: "1" }], { delimiter: "|", lineEnding: "CRLF" })).toBe("A\r\n1\r\n");
		expect(() => toCsv([{}])).toThrow(/no fields/);
	});

	it("parses quoted fields, CRLF and BOM", () => {
		expect(parseCsvRows('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",2\n')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"'],
			["multi\nline", "2"],
		]);
		expect(parseCsv("sf__Id,sf__Created,Name\n001,true,Acme\n")).toEqual([
			{ sf__Id: "001", sf__Created: "true", Name: "Acme" },
		]);
		expect(parseCsv("A;B\n1;2", ";")).toEqual([{ A: "1", B: "2" }]);
		expect(parseCsv("")).toEqual([]);
	});
});

describe("bulk ingest", () => {
	it("creates, uploads, closes and waits for a job", async () => {
		const transport = new FakeTransport().reply(
			job("Open"),
			{ status: 201 },
			job("UploadComplete"),
			job("InProgress"),
			job("JobComplete", { numberRecordsProcessed: 2, numberRecordsFailed: 0 }),
			{ body: "sf__Id,sf__Created,Name\n001,true,A\n002,true,B\n", headers: { "content-type": "text/csv" } },
		);
		const sf = createClient<SObjectRegistry>(transport);
		const ingest = await sf.bulk.ingest({
			object: "Account",
			operation: "insert",
			records: [{ Name: "A" }, { Name: "B", Phone: null }],
			wait: { pollIntervalMs: 1 },
		});
		const [create, upload, close] = transport.requests;
		expect(create?.path).toBe(`${API}/jobs/ingest`);
		expect(create?.json).toMatchObject({ object: "Account", operation: "insert", contentType: "CSV" });
		expect(upload?.method).toBe("PUT");
		expect(upload?.path).toBe(`${API}/jobs/ingest/750J/batches`);
		expect(upload?.headers.get("content-type")).toBe("text/csv");
		expect(upload?.body).toBe("Name,Phone\nA,\nB,#N/A\n");
		expect(close?.json).toEqual({ state: "UploadComplete" });
		expect(ingest.info.state).toBe("JobComplete");

		const results = await ingest.successfulResults();
		expect(transport.last.path).toBe(`${API}/jobs/ingest/750J/successfulResults/`);
		expect(transport.last.headers.get("accept")).toBe("text/csv");
		expect(results).toEqual([
			{ sf__Id: "001", sf__Created: "true", Name: "A" },
			{ sf__Id: "002", sf__Created: "true", Name: "B" },
		]);
	});

	it("throws SalesforceBulkJobError when the job fails", async () => {
		const transport = new FakeTransport().reply(
			job("Open"),
			{ status: 201 },
			job("UploadComplete"),
			job("Failed", { errorMessage: "InvalidBatch" }),
		);
		const error = await createClient(transport)
			.bulk.ingest({ object: "Account", operation: "insert", csv: "Name\nA\n", wait: { pollIntervalMs: 1 } })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceBulkJobError);
		expect((error as SalesforceBulkJobError).state).toBe("Failed");
		expect((error as Error).message).toContain("InvalidBatch");
	});

	it("aborts the job when the upload fails and validates input", async () => {
		const transport = new FakeTransport().reply(
			job("Open"),
			{ status: 400, body: [{ errorCode: "X", message: "bad csv" }] },
			job("Aborted"),
		);
		const bulk = createClient(transport).bulk;
		await expect(bulk.ingest({ object: "Account", operation: "insert", csv: "x", wait: false })).rejects.toThrow(
			/bad csv/,
		);
		expect(transport.last.json).toEqual({ state: "Aborted" });
		await expect(bulk.ingest({ object: "Account", operation: "insert", records: [] })).rejects.toThrow(/non-empty/);
		await expect(bulk.createIngestJob({ object: "Account", operation: "upsert" })).rejects.toThrow(
			/externalIdFieldName/,
		);
	});

	it("times out while waiting", async () => {
		const transport = new FakeTransport(() => job("InProgress"));
		const ingest = await createClient(transport).bulk.ingestJob("750J");
		await expect(ingest.waitForCompletion({ pollIntervalMs: 5, timeoutMs: 1 })).rejects.toThrow(/did not complete/);
	});
});

describe("bulk query", () => {
	it("runs a query job and follows Sforce-Locator pages", async () => {
		const transport = new FakeTransport().reply(
			job("UploadComplete", { operation: "query" }),
			job("JobComplete", { operation: "query" }),
			{
				body: "Id,Name,Account.Name\n003,Doe,Acme\n",
				headers: { "content-type": "text/csv", "sforce-locator": "LOC1" },
			},
			{ body: "Id,Name,Account.Name\n004,Roe,\n", headers: { "content-type": "text/csv", "sforce-locator": "null" } },
		);
		const sf = createClient<SObjectRegistry>(transport);
		const rows = [];
		for await (const row of sf.bulk.query(
			sf.soql("Contact").select("Id", "LastName").selectRelated("Account", "Name"),
			{
				maxRecords: 1,
				wait: { pollIntervalMs: 1 },
			},
		)) {
			rows.push(row);
		}
		expect(transport.requests[0]?.json).toMatchObject({
			operation: "query",
			query: "SELECT Id, LastName, Account.Name FROM Contact",
		});
		expect(transport.requests[2]?.url.searchParams.get("maxRecords")).toBe("1");
		expect(transport.requests[3]?.url.searchParams.get("locator")).toBe("LOC1");
		expect(rows).toEqual([
			{ Id: "003", Name: "Doe", "Account.Name": "Acme" },
			{ Id: "004", Name: "Roe", "Account.Name": "" },
		]);
	});

	it("uses queryAll for includeDeleted", async () => {
		const transport = new FakeTransport().reply(job("UploadComplete"));
		await createClient(transport).bulk.createQueryJob("SELECT Id FROM Account", { includeDeleted: true });
		expect(transport.last.json).toMatchObject({ operation: "queryAll" });
	});
});

describe("bulk query restrictions", () => {
	it("rejects TYPEOF queries", async () => {
		const sf = createClient<SObjectRegistry>(new FakeTransport());
		const query = sf
			.soql("Task")
			.select("Id")
			.selectTypeOf("What", (t) => t.when("Account", "Name"));
		await expect(sf.bulk.createQueryJob(query)).rejects.toThrow(/TYPEOF/);
	});
});

describe("bulk ingest validation", () => {
	it("rejects records and csv together without sending a request", async () => {
		const transport = new FakeTransport();
		const sf = createClient<SObjectRegistry>(transport);
		await expect(
			sf.bulk.ingest({ object: "Account", operation: "insert", records: [{ Name: "A" }], csv: "Name\nA\n" }),
		).rejects.toThrow("bulk.ingest() takes either records or csv, not both.");
		await expect(sf.bulk.ingest({ object: "Account", operation: "insert", records: [], csv: "" })).rejects.toThrow(
			/not both/,
		);
		expect(transport.requests).toHaveLength(0);
	});

	it("rejects missing, empty and blank data without sending a request", async () => {
		const transport = new FakeTransport();
		const bulk = createClient(transport).bulk;
		for (const data of [{}, { csv: "" }, { csv: "  \n\r\n" }, { records: [] }]) {
			await expect(bulk.ingest({ object: "Account", operation: "insert", ...data })).rejects.toThrow(
				"bulk.ingest() requires non-empty records or csv.",
			);
		}
		expect(transport.requests).toHaveLength(0);
	});

	it("checks externalIdFieldName for upsert before uploading", async () => {
		const transport = new FakeTransport();
		await expect(
			createClient(transport).bulk.ingest({ object: "Account", operation: "upsert", csv: "Name\nA\n" }),
		).rejects.toThrow(/externalIdFieldName/);
		expect(transport.requests).toHaveLength(0);
	});
});

describe("bulk wait signal", () => {
	it("stops polling an ingest job when the ingest signal aborts, even with wait options", async () => {
		const controller = new AbortController();
		const transport = new FakeTransport((request) => {
			if (request.method === "GET") {
				controller.abort(new Error("stop"));
				return job("InProgress");
			}
			return job("UploadComplete");
		}).reply(job("Open"), { status: 201 });
		const promise = createClient(transport).bulk.ingest({
			object: "Account",
			operation: "insert",
			csv: "Name\nA\n",
			signal: controller.signal,
			// No signal here: the ingest signal must still reach the polling loop.
			wait: { pollIntervalMs: 60_000, timeoutMs: 600_000 },
		});
		await expect(promise).rejects.toThrow("stop");
		expect(transport.requests.map((request) => request.method)).toEqual(["POST", "PUT", "PATCH", "GET"]);
	});

	it("uses the signal in the wait options for polling", async () => {
		const controller = new AbortController();
		const transport = new FakeTransport((request) => {
			if (request.method === "GET") {
				controller.abort(new Error("wait aborted"));
				return job("InProgress");
			}
			return job("UploadComplete");
		}).reply(job("Open"), { status: 201 });
		await expect(
			createClient(transport).bulk.ingest({
				object: "Account",
				operation: "insert",
				csv: "Name\nA\n",
				wait: { pollIntervalMs: 60_000, signal: controller.signal },
			}),
		).rejects.toThrow("wait aborted");
		expect(transport.requests).toHaveLength(4);
	});

	it("honours both the ingest signal and the wait signal", async () => {
		const outer = new AbortController();
		const inner = new AbortController();
		const transport = new FakeTransport((request) => {
			if (request.method === "GET") {
				outer.abort(new Error("outer aborted"));
				return job("InProgress");
			}
			return job("UploadComplete");
		}).reply(job("Open"), { status: 201 });
		await expect(
			createClient(transport).bulk.ingest({
				object: "Account",
				operation: "insert",
				csv: "Name\nA\n",
				signal: outer.signal,
				wait: { pollIntervalMs: 60_000, signal: inner.signal },
			}),
		).rejects.toThrow("outer aborted");
		expect(transport.requests).toHaveLength(4);
		expect(inner.signal.aborted).toBe(false);
	});

	it("stops polling a bulk query when the query signal aborts", async () => {
		const controller = new AbortController();
		const transport = new FakeTransport(() => {
			controller.abort(new Error("query aborted"));
			return job("InProgress", { operation: "query" });
		}).reply(job("UploadComplete", { operation: "query" }));
		const rows = createClient(transport).bulk.query("SELECT Id FROM Account", {
			signal: controller.signal,
			wait: { pollIntervalMs: 60_000 },
		});
		await expect(rows.next()).rejects.toThrow("query aborted");
		expect(transport.requests).toHaveLength(2);
	});

	it("doesn't send another poll once the signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		const transport = new FakeTransport(() => job("InProgress"));
		const ingest = await createClient(transport).bulk.ingestJob("750J");
		await expect(ingest.waitForCompletion({ pollIntervalMs: 1, signal: controller.signal })).rejects.toThrow(
			"already aborted",
		);
		expect(transport.requests).toHaveLength(1);
	});
});
