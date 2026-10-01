/**
 * UI API, quick actions, search, Apex, events, reports, files and debug logs against a real org.
 * Uses the fixtures from ./fixtures.ts (created in Developer Edition orgs and sandboxes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SalesforceSaveError } from "../../src/errors";
import { FilesApi, type SalesforceClient } from "../../src/index";

import { ensureFixtures, type OrgFixtures, TEST_EVENT, TEST_INVOCABLE } from "./fixtures";
import { liveClient, liveOrgConfigured, runMarker } from "./org";

const MASTER_RECORD_TYPE = "012000000000000AAA";

describe.skipIf(!liveOrgConfigured)("live org: platform", () => {
	let sf: SalesforceClient;
	let fixtures: OrgFixtures;
	const marker = `${runMarker}-platform`;
	let accountId = "";

	beforeAll(async () => {
		sf = liveClient();
		fixtures = await ensureFixtures(sf);
		accountId = await sf.sobject("Account").create({ Name: `${marker} account`, Industry: "Energy" });
	}, 300_000);

	afterAll(async () => {
		if (accountId) {
			await sf.sobject("Account").delete(accountId);
		}
	});

	it("reads object info, records, layouts and picklists through the UI API", async () => {
		const info = await sf.uiApi.objectInfo("Account");
		expect(info.apiName).toBe("Account");
		expect(info.fields.Industry).toBeDefined();

		const record = await sf.uiApi.record("Account", accountId, { fields: ["Name", "Industry"] });
		expect(record.fields.Name?.value).toBe(`${marker} account`);
		expect(record.fields.Industry?.value).toBe("Energy");

		const industry = await sf.uiApi.picklistValues("Account", MASTER_RECORD_TYPE, "Industry");
		expect(industry.values.map((value) => value.value)).toContain("Energy");
		const all = await sf.uiApi.picklistValues("Account", MASTER_RECORD_TYPE);
		expect(all.Industry?.values.length).toBeGreaterThan(0);

		const values = await sf.sobject("Account").picklistValues("Industry");
		expect(values.map((value) => value.value)).toContain("Energy");

		const layout = await sf.uiApi.layout("Account");
		expect(layout.sections.length).toBeGreaterThan(0);
	});

	it("lists, describes and reads defaults of quick actions", async () => {
		const actions = await sf.quickActions.list();
		const logACall = actions.find((action) => action.name === "LogACall");
		expect(logACall).toBeDefined();
		const describe = await sf.quickActions.describe("LogACall");
		expect(describe.name).toBe("LogACall");
		const accountActions = await sf.sobject("Account").quickActions.list();
		expect(accountActions.some((action) => action.name === "NewContact")).toBe(true);
		// NewContact is a global action on the Account layout here: the call falls back to /quickActions.
		const defaults = await sf.sobject("Account").quickActions.defaultValues("NewContact", accountId);
		expect(defaults).toMatchObject({ attributes: { type: "Contact" }, AccountId: accountId });
	});

	it("searches with SOSL and parameterized search", async () => {
		const sosl = await sf.search.sosl("FIND {sobjectly} IN NAME FIELDS RETURNING Account(Id, Name) LIMIT 5");
		expect(Array.isArray(sosl.searchRecords)).toBe(true);
		const parameterized = await sf.search.parameterized({
			q: "sobjectly",
			sobjects: [{ name: "Account" }],
			fields: ["Id"],
		});
		expect(Array.isArray(parameterized.searchRecords)).toBe(true);
	});

	it("lists standard actions and approval processes", async () => {
		const standard = await sf.actions.listStandard();
		expect(standard.some((action) => action.name === "chatterPost")).toBe(true);
		const approvals = await sf.approvals.list();
		expect(typeof approvals).toBe("object");
		expect(await sf.approvals.pending(accountId)).toEqual([]);
	});

	describe("with fixtures", () => {
		it("calls an Apex REST resource", async (context) => {
			context.skip(!fixtures.apex, "Apex fixtures are missing");
			const get = await sf.apexRest<{ method: string; path: string; params: Record<string, string> }>({
				path: "/sobjectly/echo/a b",
				query: { q: "x&y" },
			});
			expect(get).toEqual({ method: "GET", path: "/sobjectly/echo/a%20b", params: { q: "x&y" } });
			const post = await sf.apexRest<{ body: unknown }>({
				method: "POST",
				path: "/sobjectly/echo",
				body: { nested: { list: [1, "two", null] } },
			});
			expect(post.body).toEqual({ nested: { list: [1, "two", null] } });
		});

		it("invokes invocable Apex and recovers per-item failures", async (context) => {
			context.skip(!fixtures.apex, "Apex fixtures are missing");
			const results = await sf.actions.invokeApex<{ value: number }, { doubled: number }>(TEST_INVOCABLE, [
				{ value: 2 },
				{ value: 21 },
			]);
			expect(results.map((result) => result.outputValues?.doubled)).toEqual([4, 42]);
			const failed = await sf.actions.invokeApex(TEST_INVOCABLE, [{ value: -1 }]).catch((caught: unknown) => caught);
			expect(failed).toBeInstanceOf(SalesforceSaveError);
			const soft = await sf.actions.invokeApex(TEST_INVOCABLE, [{ value: -1 }], { throwOnError: false });
			expect(soft[0]?.isSuccess).toBe(false);
		});

		it("publishes platform events, one and in batches", async (context) => {
			context.skip(!fixtures.platformEvent, "the platform event fixture is missing");
			const [one] = await sf.events.publish(TEST_EVENT, { Message__c: marker });
			expect(one).toMatchObject({ success: true });
			expect(one?.uuid).toMatch(/^[0-9a-f-]{36}$/);
			const many = await sf.events.publish(
				TEST_EVENT,
				Array.from({ length: 30 }, (_, index) => ({ Message__c: `${marker} ${index}` })),
			);
			expect(many).toHaveLength(30);
			expect(many.every((result) => result.success)).toBe(true);
		});

		it("runs a report synchronously and asynchronously", async (context) => {
			const reportId = fixtures.reportId ?? "";
			context.skip(!reportId, "the report fixture is missing");
			const describe = await sf.reports.describe(reportId);
			expect(describe.reportMetadata.reportFormat).toBe("SUMMARY");
			const result = await sf.reports.run(reportId, {
				filters: [{ column: "ACCOUNT.NAME", operator: "equals", value: `${marker} account` }],
			});
			const rows = sf.reports.toRows(result);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.["ACCOUNT.NAME"]?.label).toBe(`${marker} account`);

			const instance = await sf.reports.runAsync(reportId);
			const finished = await sf.reports.waitForInstance(reportId, instance.id, { pollIntervalMs: 1_000 });
			expect(finished.factMap["T!T"]).toBeDefined();
		});
	});

	it("uploads (JSON and multipart), versions, links and downloads files", async () => {
		const binary = new Uint8Array(256).map((_, index) => index);
		const json = await sf.files.upload({ data: binary, fileName: `${marker}.bin`, linkTo: accountId });
		const multipart = await new FilesApi(sf.connection, 0).upload({
			data: "héllo wörld ✓",
			fileName: `${marker}.txt`,
		});
		try {
			expect(await sf.files.download(json.contentVersionId)).toEqual(binary);
			expect(await sf.files.download(json.contentDocumentId)).toEqual(binary);
			expect(new TextDecoder().decode(await sf.files.download(multipart.contentVersionId))).toBe("héllo wörld ✓");

			const links = await sf.collect<{ LinkedEntityId: string }>(
				`SELECT LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId = '${json.contentDocumentId}'`,
			);
			expect(links.map((link) => link.LinkedEntityId)).toContain(accountId);

			const version = await sf.files.newVersion(multipart.contentDocumentId, {
				data: "second version",
				fileName: `${marker}-v2.txt`,
			});
			expect(version.contentDocumentId).toBe(multipart.contentDocumentId);
			expect(new TextDecoder().decode(await sf.files.download(multipart.contentDocumentId))).toBe("second version");

			await sf.files.link(multipart.contentDocumentId, accountId);
		} finally {
			await sf.collections.delete([json.contentDocumentId, multipart.contentDocumentId], { throwOnError: false });
		}
	});

	it("captures debug logs, also when the work throws", async () => {
		const run = await sf.tooling.executeAnonymous(`System.debug('${marker}');`, { captureLog: true });
		expect(run.logs.some((log) => log.body?.includes(marker))).toBe(true);

		const error = await sf.tooling
			.executeAnonymous(`System.debug('${marker} fail'); Integer x = 1 / 0;`, { captureLog: true })
			.catch((caught: unknown) => caught);
		expect((error as { logs?: { body?: string }[] }).logs?.some((log) => log.body?.includes(`${marker} fail`))).toBe(
			true,
		);

		const flags = await sf.tooling.collect<{ ExpirationDate: string }>(
			"SELECT ExpirationDate FROM TraceFlag WHERE LogType = 'USER_DEBUG'",
		);
		// Our temporary flag is gone again; any remaining flag belongs to someone else.
		expect(flags.every((flag) => Date.parse(flag.ExpirationDate) > Date.now() - 60_000)).toBe(true);
	});
});
