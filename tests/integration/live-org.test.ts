/**
 * Runs against a real org; see tests/integration/org.ts for the environment variables.
 * Creates and deletes a few records.
 *
 *   npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SalesforceClient } from "../../src/index";

import { liveClient, liveOrgConfigured, runMarker } from "./org";

describe.skipIf(!liveOrgConfigured)("live org", () => {
	let sf: SalesforceClient;
	const created: string[] = [];

	beforeAll(() => {
		sf = liveClient();
	});
	const marker = runMarker;

	afterAll(async () => {
		if (created.length > 0) {
			await sf.collections.delete(created, { throwOnError: false, chunk: true });
		}
	});

	it("reads limits and versions", async () => {
		const limits = await sf.limits();
		expect(limits.DailyApiRequests?.Max).toBeGreaterThan(0);
		const versions = await sf.versions();
		expect(versions.map((version) => `v${version.version}`)).toContain(sf.apiVersion);
	});

	it("creates, reads, updates, queries and deletes a record", async () => {
		const accounts = sf.sobject("Account");
		const id = await accounts.create({ Name: `${marker} crud` });
		created.push(id);
		await accounts.update(id, { Description: "updated" });
		const record = await accounts.get(id, ["Id", "Name", "Description"]);
		expect(record.Description).toBe("updated");

		const rows = await sf.collect(sf.soql("Account").select("Id", "Name").where("Id", "=", id));
		expect(rows).toHaveLength(1);

		await accounts.delete(id);
		created.splice(created.indexOf(id), 1);
	});

	it("runs a composite request with references", async () => {
		const result = await sf.composite.execute(
			(c) => {
				const account = c.create("Account", { Name: `${marker} composite` });
				const read = c.get("Account", account.ref("id"), ["Name"]);
				return { account, read };
			},
			{ allOrNone: true, throwOnError: true },
		);
		const id = result.get(result.refs.account).id;
		expect(id).toBeTruthy();
		created.push(id ?? "");
		expect(result.get(result.refs.read).Name).toBe(`${marker} composite`);
	});

	it("ingests and queries with Bulk API 2.0", async () => {
		const job = await sf.bulk.ingest({
			object: "Account",
			operation: "insert",
			records: [{ Name: `${marker} bulk 1` }, { Name: `${marker} bulk 2` }],
			wait: { pollIntervalMs: 2_000, timeoutMs: 120_000 },
		});
		const results = await job.successfulResults();
		created.push(...results.map((row) => row.sf__Id ?? ""));
		expect(results).toHaveLength(2);

		const rows = [];
		for await (const row of sf.bulk.query(`SELECT Id FROM Account WHERE Name LIKE '${marker} bulk%'`, {
			wait: { pollIntervalMs: 2_000, timeoutMs: 120_000 },
		})) {
			rows.push(row);
		}
		expect(rows).toHaveLength(2);
	});

	it("uploads, downloads and deletes a file", async () => {
		const { contentVersionId, contentDocumentId } = await sf.files.upload({
			data: `${marker} file`,
			fileName: `${marker}.txt`,
		});
		expect(new TextDecoder().decode(await sf.files.download(contentVersionId))).toBe(`${marker} file`);
		await sf.sobject("ContentDocument").delete(contentDocumentId);
	});

	it("explains a query", async () => {
		const plans = await sf.explain("SELECT Id FROM Account WHERE Name = 'x'");
		expect(plans.length).toBeGreaterThan(0);
	});

	it("captures the debug log of anonymous Apex", async () => {
		const result = await sf.tooling.executeAnonymous(`System.debug('${marker}');`, { captureLog: true });
		expect(result.logs.some((log) => log.body?.includes(marker))).toBe(true);
	});
});
