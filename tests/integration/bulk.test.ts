/** Bulk API 2.0 and query pagination against a real org. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SalesforceClient } from "../../src/index";

import { liveClient, liveOrgConfigured, runMarker } from "./org";

const WAIT = { pollIntervalMs: 2_000, timeoutMs: 180_000 };

describe.skipIf(!liveOrgConfigured)("live org: bulk", () => {
	let sf: SalesforceClient;
	const marker = `${runMarker}-bulk`;
	const created: string[] = [];

	beforeAll(() => {
		sf = liveClient();
	});

	afterAll(async () => {
		if (created.length > 0) {
			const job = await sf.bulk.ingest({
				object: "Contact",
				operation: "delete",
				records: created.map((Id) => ({ Id })),
				wait: WAIT,
			});
			if ((job.info.numberRecordsFailed ?? 0) > 0) {
				throw new Error(`Cleanup failed for ${job.info.numberRecordsFailed ?? 0} test contacts.`);
			}
		}
	});

	it("ingests special values the way the REST API would store them", async () => {
		const job = await sf.bulk.ingest({
			object: "Contact",
			operation: "insert",
			records: [
				{
					LastName: `${marker} values`,
					Birthdate: new Date("1990-05-17T23:30:00Z"),
					Description: 'multi\nline, with "quotes"; and ünïcode ✓',
					Title: "#N/A",
					Department: null,
				},
				{ LastName: `${marker} empty`, Title: undefined },
			],
			wait: WAIT,
		});
		const results = await job.successfulResults();
		created.push(...results.map((row) => row.sf__Id ?? ""));
		expect(await job.failedResults()).toEqual([]);

		const [values] = await sf.collect<Record<string, unknown>>(
			`SELECT Birthdate, Description, Title, Department FROM Contact WHERE LastName = '${marker} values'`,
		);
		expect(values).toMatchObject({
			Birthdate: "1990-05-17", // the UTC date
			Description: 'multi\nline, with "quotes"; and ünïcode ✓',
			Title: "#N/A", // text, not null
			Department: null,
		});
	});

	it("pages through query results (REST and Bulk)", async () => {
		const job = await sf.bulk.ingest({
			object: "Contact",
			operation: "insert",
			records: Array.from({ length: 250 }, (_, index) => ({
				LastName: `${marker} page ${String(index).padStart(3, "0")}`,
			})),
			wait: WAIT,
		});
		const results = await job.successfulResults();
		created.push(...results.map((row) => row.sf__Id ?? ""));
		expect(results).toHaveLength(250);

		const soql = `SELECT Id, LastName FROM Contact WHERE LastName LIKE '${marker} page%' ORDER BY LastName`;
		const first = await sf.query(soql, { batchSize: 200 });
		expect(first.records).toHaveLength(200);
		expect(first.done).toBe(false);
		expect(await sf.collect(soql, { batchSize: 200 })).toHaveLength(250);

		const streamed: string[] = [];
		for await (const row of sf.bulk.query(soql, { wait: WAIT })) {
			streamed.push(row.LastName ?? "");
		}
		expect(streamed).toHaveLength(250);
		expect(new Set(streamed).size).toBe(250);

		const queryJob = await sf.bulk.createQueryJob(soql);
		await queryJob.waitForCompletion(WAIT);
		let pages = 0;
		let rows = 0;
		for await (const page of queryJob.pages({ maxRecords: 100 })) {
			pages++;
			rows += page.length;
		}
		expect([pages, rows]).toEqual([3, 250]);
		await queryJob.delete();
	});
});
