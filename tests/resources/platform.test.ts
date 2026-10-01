import { describe, expect, it } from "vitest";

import { SalesforceSaveError } from "../../src/errors";
import { FilesApi } from "../../src/resources/files";
import { reportRows } from "../../src/resources/reports";
import type { ReportResult } from "../../src/types/platform";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, FakeTransport } from "../helpers/fake-transport";

const decoder = new TextDecoder();

describe("approvals", () => {
	const approvalResult = {
		actorIds: ["005A"],
		entityId: "001A",
		errors: null,
		instanceId: "04gA",
		instanceStatus: "Pending",
		newWorkItemIds: ["04iA"],
		success: true,
	};

	it("submits a record and normalises newWorkitemIds", async () => {
		const transport = new FakeTransport().reply({ body: [approvalResult] });
		const result = await createClient(transport).approvals.submit("001A", {
			comments: "please",
			processDefinitionNameOrId: "Discount_Approval",
		});
		expect(transport.last.path).toBe(`${API}/process/approvals/`);
		expect(transport.last.json).toEqual({
			requests: [
				{
					actionType: "Submit",
					contextId: "001A",
					comments: "please",
					processDefinitionNameOrId: "Discount_Approval",
				},
			],
		});
		expect(result.newWorkitemIds).toEqual(["04iA"]);
	});

	it("approves by record id via the pending work item", async () => {
		const transport = new FakeTransport().reply(
			{
				body: {
					totalSize: 1,
					done: true,
					records: [
						{ Id: "04iB", ActorId: "005A", ProcessInstanceId: "04gA", ProcessInstance: { TargetObjectId: "001A" } },
					],
				},
			},
			{ body: [{ ...approvalResult, instanceStatus: "Approved", newWorkItemIds: [] }] },
		);
		const result = await createClient(transport).approvals.approve("001A", { comments: "ok" });
		expect(transport.requests[0]?.url.searchParams.get("q")).toContain("ProcessInstance.TargetObjectId = '001A'");
		expect(
			(transport.last.json as { requests: { contextId: string; actionType: string }[] }).requests[0],
		).toMatchObject({
			actionType: "Approve",
			contextId: "04iB",
		});
		expect(result.instanceStatus).toBe("Approved");
	});

	it("rejects by work item id without a lookup and reports failures", async () => {
		const transport = new FakeTransport().reply({
			body: [
				{ ...approvalResult, success: false, errors: [{ statusCode: "INVALID_OPERATION", message: "no", fields: [] }] },
			],
		});
		await expect(createClient(transport).approvals.reject("04iZ")).rejects.toBeInstanceOf(SalesforceSaveError);
		expect(transport.requests).toHaveLength(1);
	});

	it("explains when no or several work items are pending", async () => {
		const empty = { body: { totalSize: 0, done: true, records: [] } };
		const two = {
			body: {
				totalSize: 2,
				done: true,
				records: [
					{ Id: "04i1", ActorId: "a", ProcessInstanceId: "p", ProcessInstance: null },
					{ Id: "04i2", ActorId: "b", ProcessInstanceId: "p", ProcessInstance: null },
				],
			},
		};
		const approvals = createClient(new FakeTransport().reply(empty, two)).approvals;
		await expect(approvals.approve("001A")).rejects.toThrow(/no pending approval/);
		await expect(approvals.approve("001A")).rejects.toThrow(/2 pending work items \(04i1, 04i2\)/);
	});
});

describe("quick actions", () => {
	it("lists, describes, reads defaults and invokes", async () => {
		const transport = new FakeTransport(() => ({
			body: {
				success: true,
				created: true,
				id: "003A",
				ids: ["003A"],
				feedItemIds: null,
				successMessage: "ok",
				errors: [],
			},
		}));
		const sf = createClient<SObjectRegistry>(transport);
		const actions = sf.sobject("Account").quickActions;
		await actions.list();
		expect(transport.last.path).toBe(`${API}/sobjects/Account/quickActions/`);
		await actions.describe("NewContact");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/quickActions/NewContact/describe/`);
		await actions.defaultValues("NewContact", "001A");
		expect(transport.last.path).toBe(`${API}/sobjects/Account/quickActions/NewContact/defaultValues/001A`);
		const result = await actions.invoke("NewContact", { LastName: "Doe" }, { contextId: "001A" });
		expect(transport.last.json).toEqual({ record: { LastName: "Doe" }, contextId: "001A" });
		expect(result.ids).toEqual(["003A"]);
		await sf.quickActions.invoke("LogACall", { Subject: "Call" });
		expect(transport.last.path).toBe(`${API}/quickActions/LogACall`);
		await expect(actions.describe("../x")).rejects.toThrow(/Invalid quick action/);
	});

	it("falls back to the global action when the sObject has no action of that name", async () => {
		const transport = new FakeTransport((request) =>
			request.path.includes("/sobjects/") || request.path.includes("/Nope")
				? { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] }
				: { body: { attributes: { type: "Contact" }, AccountId: "001A" } },
		);
		const sf = createClient<SObjectRegistry>(transport);
		const defaults = await sf.sobject("Account").quickActions.defaultValues("NewContact", "001A");
		expect(defaults).toMatchObject({ AccountId: "001A" });
		expect(transport.requests.map((request) => request.path)).toEqual([
			`${API}/sobjects/Account/quickActions/NewContact/defaultValues/001A`,
			`${API}/quickActions/NewContact/defaultValues/001A`,
		]);
		// Other errors, and 404s of global actions, are not retried.
		const missing = await sf.quickActions.describe("Nope").catch((caught: unknown) => caught);
		expect(missing).toMatchObject({ status: 404 });
		expect(transport.requests).toHaveLength(3);
	});
});

describe("UI API, record types and picklists", () => {
	it("loads typed records and object info (cached)", async () => {
		const transport = new FakeTransport(() => ({ body: { apiName: "Account", fields: {} } }));
		const sf = createClient<SObjectRegistry>(transport);
		await sf.uiApi.record("Account", "001A", { fields: ["Name"], optionalFields: ["Industry"] });
		expect(transport.last.path).toBe(`${API}/ui-api/records/001A`);
		expect(transport.last.url.searchParams.get("fields")).toBe("Account.Name");
		expect(transport.last.url.searchParams.get("optionalFields")).toBe("Account.Industry");
		expect(() => sf.uiApi.record("Account", "001A", {})).toThrow(/requires fields/);
		await sf.uiApi.objectInfo("Account");
		await sf.uiApi.objectInfo("Account");
		expect(transport.requests.filter((request) => request.path.endsWith("/object-info/Account"))).toHaveLength(1);
		await sf.uiApi.layout("Account", { mode: "Edit" });
		expect(transport.last.url.searchParams.get("mode")).toBe("Edit");
	});

	it("resolves record type ids by DeveloperName and caches describe", async () => {
		const describe = {
			name: "Case",
			fields: [
				{
					name: "Status",
					picklistValues: [
						{ active: true, defaultValue: true, label: "New", value: "New", validFor: null },
						{ active: false, defaultValue: false, label: "Old", value: "Old", validFor: null },
					],
				},
			],
			recordTypeInfos: [
				{ developerName: "Complaint", recordTypeId: "012A" },
				{ developerName: "Master", recordTypeId: "012000000000000AAA" },
			],
		};
		const transport = new FakeTransport((request) =>
			request.path.includes("picklist-values")
				? {
						body: {
							controllerValues: {},
							defaultValue: { value: "Working" },
							values: [{ label: "Working", value: "Working", validFor: [], attributes: null }],
							url: "",
						},
					}
				: { body: describe },
		);
		const sf = createClient<SObjectRegistry>(transport);
		expect(await sf.sobject("Case").recordTypeId("Complaint")).toBe("012A");
		await expect(sf.sobject("Case").recordTypeId("Nope" as "Complaint")).rejects.toThrow(
			/Available: Complaint, Master/,
		);
		expect(await sf.sobject("Case").picklistValues("Status")).toEqual([
			{ value: "New", label: "New", isDefault: true },
		]);
		expect(await sf.sobject("Case").picklistValues("Status", { recordType: "Complaint" })).toEqual([
			{ value: "Working", label: "Working", isDefault: true },
		]);
		expect(transport.last.path).toBe(`${API}/ui-api/object-info/Case/picklist-values/012A/Status`);
		expect(transport.requests.filter((request) => request.path.endsWith("/describe"))).toHaveLength(1);
		sf.clearCache();
		await sf.sobject("Case").recordTypeId("Complaint");
		expect(transport.requests.filter((request) => request.path.endsWith("/describe"))).toHaveLength(2);
	});

	it("can disable the cache", async () => {
		const transport = new FakeTransport(() => ({ body: { sobjects: [] } }));
		const sf = createClient(transport, { cache: false });
		await sf.describeGlobal();
		await sf.describeGlobal();
		expect(transport.requests).toHaveLength(2);
	});
});

describe("files", () => {
	const saved = { status: 201, body: { id: "068A", success: true, errors: [] } };
	const version = { body: { ContentDocumentId: "069A" } };

	it("uploads small files as JSON and links them with FirstPublishLocationId", async () => {
		const transport = new FakeTransport().reply(saved, version);
		const result = await createClient(transport).files.upload({ data: "hello", fileName: "note.txt", linkTo: "001A" });
		expect(result).toEqual({ contentVersionId: "068A", contentDocumentId: "069A" });
		expect(transport.requests[0]?.json).toEqual({
			Title: "note",
			PathOnClient: "note.txt",
			FirstPublishLocationId: "001A",
			VersionData: Buffer.from("hello").toString("base64"),
		});
	});

	it("uploads large files as multipart and creates an explicit link for share settings", async () => {
		const transport = new FakeTransport().reply(saved, version, {
			status: 201,
			body: { id: "06AA", success: true, errors: [] },
		});
		const client = createClient(transport);
		const files = new FilesApi(client.connection, 4);
		await files.upload({ data: new Uint8Array([1, 2, 3, 4, 5]), fileName: "a.bin", linkTo: "001A", shareType: "C" });
		const upload = transport.requests[0];
		const contentType = upload.headers.get("content-type") ?? "";
		expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
		const boundary = contentType.split("boundary=")[1];
		const body = upload.body ?? "";
		expect(body).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="entity_content"`);
		expect(body).toContain('{"Title":"a","PathOnClient":"a.bin"}');
		expect(body).toContain('name="VersionData"; filename="a.bin"\r\nContent-Type: application/octet-stream');
		expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
		expect(transport.last.path).toBe(`${API}/sobjects/ContentDocumentLink`);
		expect(transport.last.json).toEqual({ ContentDocumentId: "069A", LinkedEntityId: "001A", ShareType: "C" });
	});

	it("downloads by ContentDocument id through the latest version and adds versions", async () => {
		const transport = new FakeTransport().reply(
			{ body: { LatestPublishedVersionId: "068B" } },
			{ body: new Uint8Array([7, 8]), headers: { "content-type": "application/octet-stream" } },
			saved,
			version,
		);
		const files = createClient(transport).files;
		expect(await files.download("069A")).toEqual(new Uint8Array([7, 8]));
		expect(transport.requests[1]?.path).toBe(`${API}/sobjects/ContentVersion/068B/VersionData`);
		await files.newVersion("069A", { data: "v2", fileName: "note.txt", reasonForChange: "typo" });
		expect(transport.requests[2]?.json).toMatchObject({ ContentDocumentId: "069A", ReasonForChange: "typo" });
		expect(
			decoder.decode(Buffer.from((transport.requests[2].json as { VersionData: string }).VersionData, "base64")),
		).toBe("v2");
	});
});

describe("reports and query plans", () => {
	const result = {
		reportMetadata: {
			reportFormat: "SUMMARY",
			detailColumns: ["ACCOUNT.NAME", "AMOUNT"],
			groupingsDown: [{ name: "TYPE" }],
			groupingsAcross: [],
		},
		factMap: {
			"T!T": { aggregates: [{ label: "2", value: 2 }] },
			"0!T": {
				aggregates: [],
				rows: [
					{
						dataCells: [
							{ label: "Acme", value: "001A" },
							{ label: "$5", value: 5 },
						],
					},
				],
			},
			"1!T": {
				aggregates: [],
				rows: [
					{
						dataCells: [
							{ label: "Globex", value: "001B" },
							{ label: "$7", value: 7 },
						],
					},
				],
			},
		},
	} as unknown as ReportResult;

	it("flattens detail rows", () => {
		expect(reportRows(result)).toEqual([
			{ "ACCOUNT.NAME": { label: "Acme", value: "001A" }, AMOUNT: { label: "$5", value: 5 } },
			{ "ACCOUNT.NAME": { label: "Globex", value: "001B" }, AMOUNT: { label: "$7", value: 7 } },
		]);
	});

	it("only takes rows from the deepest grouping level", () => {
		const row = { dataCells: [{ label: "Acme", value: "001A" }] };
		const nested = {
			reportMetadata: {
				reportFormat: "SUMMARY",
				detailColumns: ["ACCOUNT.NAME"],
				groupingsDown: [{ name: "TYPE" }, { name: "INDUSTRY" }],
				groupingsAcross: [],
			},
			factMap: {
				"T!T": { aggregates: [], rows: [row] },
				"0!T": { aggregates: [], rows: [row] },
				"0_0!T": { aggregates: [], rows: [row] },
			},
		} as unknown as ReportResult;
		expect(reportRows(nested)).toHaveLength(1);
		const tabular = {
			reportMetadata: {
				reportFormat: "TABULAR",
				detailColumns: ["ACCOUNT.NAME"],
				groupingsDown: [],
				groupingsAcross: [],
			},
			factMap: { "T!T": { aggregates: [], rows: [row, row] } },
		} as unknown as ReportResult;
		expect(reportRows(tabular)).toHaveLength(2);
	});

	it("runs reports with filters, async runs and explains queries", async () => {
		const transport = new FakeTransport().reply(
			{ body: result },
			{ body: { id: "0LGA", status: "New" } },
			{ body: { ...result, attributes: { status: "Running" } } },
			{ body: { ...result, attributes: { status: "Success" } } },
			{ body: { plans: [{ leadingOperationType: "Index", relativeCost: 0.2 }] } },
		);
		const sf = createClient<SObjectRegistry>(transport);
		await sf.reports.run("00OA00000000001", { filters: [{ column: "AMOUNT", operator: "greaterThan", value: "1" }] });
		expect(transport.last.method).toBe("POST");
		expect(transport.last.path).toBe(`${API}/analytics/reports/00OA00000000001`);
		expect(transport.last.json).toEqual({
			reportMetadata: { reportFilters: [{ column: "AMOUNT", operator: "greaterThan", value: "1" }] },
		});
		const instance = await sf.reports.runAsync("00OA00000000001");
		const finished = await sf.reports.waitForInstance("00OA00000000001", instance.id, { pollIntervalMs: 1 });
		expect(sf.reports.toRows(finished)).toHaveLength(2);
		const plans = await sf.explain(sf.soql("Account").select("Id").where("Name", "=", "Acme"));
		expect(transport.last.url.searchParams.get("explain")).toBe("SELECT Id FROM Account WHERE Name = 'Acme'");
		expect(plans[0]?.leadingOperationType).toBe("Index");
		expect(() => sf.reports.run("../x")).toThrow(/Invalid report id/);
	});
});
