/** sObject, collections and composite writes against a real org. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasErrorCode, SalesforceSaveError } from "../../src/errors";
import type { SalesforceClient } from "../../src/index";

import { liveClient, liveOrgConfigured, runMarker } from "./org";

describe.skipIf(!liveOrgConfigured)("live org: data", () => {
	let sf: SalesforceClient;
	const marker = `${runMarker}-data`;
	const created = new Set<string>();
	const track = (...ids: (string | undefined)[]): void => {
		for (const id of ids) {
			if (id) {
				created.add(id);
			}
		}
	};

	beforeAll(() => {
		sf = liveClient();
	});

	afterAll(async () => {
		// Contacts first, so deleting their accounts doesn't fail on them.
		const ids = [...created].sort((a, b) =>
			a.startsWith("003") === b.startsWith("003") ? 0 : a.startsWith("003") ? -1 : 1,
		);
		if (ids.length > 0) {
			await sf.collections.delete(ids, { throwOnError: false, chunk: true });
		}
	});

	it("upserts and reads by an external id containing / and @", async () => {
		const contacts = sf.sobject("Contact");
		const email = `${marker.toLowerCase()}/a+b@example.com`;
		const first = await contacts.upsert("Email", email, { LastName: `${marker} upsert` });
		track(first.id);
		expect(first.created).toBe(true);
		const second = await contacts.upsert("Email", email, { LastName: `${marker} upserted` });
		expect(second).toMatchObject({ id: first.id, created: false });
		const record = await contacts.getByExternalId("Email", email, ["Id", "LastName", "Email"]);
		expect(record).toMatchObject({ Id: first.id, LastName: `${marker} upserted`, Email: email });
	});

	it("reads record metadata and updated ids", async () => {
		const accounts = sf.sobject("Account");
		const id = await accounts.create({ Name: `${marker} meta` });
		track(id);
		const describe = await accounts.describe();
		expect(describe.fields.some((field) => field.name === "Name")).toBe(true);
		expect(await accounts.describe()).toBe(describe); // cached
		const info = await accounts.basicInfo();
		expect(info.objectDescribe.name).toBe("Account");
		const updated = await accounts.getUpdated(new Date(Date.now() - 10 * 60_000), new Date(Date.now() + 60_000));
		expect(updated.ids).toContain(id);
	});

	it("runs collections with partial failures and chunking", async () => {
		const results = await sf.collections.create(
			"Account",
			[{ Name: `${marker} col 1` }, { Name: "" }, { Name: `${marker} col 3` }],
			{ throwOnError: false },
		);
		track(...results.map((result) => result.id));
		expect(results.map((result) => result.success)).toEqual([true, false, true]);
		expect(results[1]?.errors[0]?.statusCode).toBe("REQUIRED_FIELD_MISSING");

		const error = await sf.collections.create("Account", [{ Name: "" }]).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect(hasErrorCode(error, "REQUIRED_FIELD_MISSING")).toBe(true);

		const ids = results.flatMap((result) => (result.id ? [result.id] : []));
		await sf.collections.update(
			"Account",
			ids.map((Id) => ({ Id, Description: "via collections" })),
		);
		const retrieved = await sf.collections.retrieve("Account", ids, ["Id", "Description"]);
		expect(retrieved.map((record) => record?.Description)).toEqual(["via collections", "via collections"]);

		const many = await sf.collections.create(
			"Account",
			Array.from({ length: 205 }, (_, index) => ({ Name: `${marker} chunk ${index}` })),
			{ chunk: true },
		);
		track(...many.map((result) => result.id));
		expect(many.filter((result) => result.success)).toHaveLength(205);
	});

	it("upserts collections by external id", async () => {
		const results = await sf.collections.upsert("Contact", "Email", [
			{ Email: `${marker.toLowerCase()}-c1@example.com`, LastName: `${marker} c1` },
			{ Email: `${marker.toLowerCase()}-c2@example.com`, LastName: `${marker} c2` },
		]);
		track(...results.map((result) => result.id));
		expect(results.map((result) => result.created)).toEqual([true, true]);
	});

	it("runs composite, batch, tree and graph requests", async () => {
		const composite = await sf.composite.execute(
			(c) => {
				const account = c.create("Account", { Name: `${marker} composite` });
				const contact = c.create("Contact", { LastName: `${marker} composite`, AccountId: account.ref("id") });
				const read = c.get("Account", account.ref("id"), ["Name"]);
				c.update("Account", account.ref("id"), { Description: "updated in composite" });
				const contacts = c.query(`SELECT Id FROM Contact WHERE AccountId = '${account.ref("id")}'`);
				return { account, contact, read, contacts };
			},
			{ allOrNone: true },
		);
		track(composite.get(composite.refs.contact).id, composite.get(composite.refs.account).id);
		expect(composite.get(composite.refs.read).Name).toBe(`${marker} composite`);
		expect(composite.get(composite.refs.contacts).totalSize).toBe(1);

		const batch = await sf.composite.batch([
			{ method: "GET", path: "/limits" },
			{ method: "GET", path: "/sobjects/Account/001000000000000AAA" },
		]);
		expect(batch.hasErrors).toBe(true);
		expect(batch.results.map((result) => result.statusCode)).toEqual([200, 404]);

		const tree = await sf.composite.tree("Account", [
			{
				attributes: { type: "Account", referenceId: "acc" },
				Name: `${marker} tree`,
				Contacts: { records: [{ attributes: { type: "Contact", referenceId: "con" }, LastName: `${marker} tree` }] },
			},
		]);
		expect(tree.hasErrors).toBe(false);
		track(...tree.results.filter((result) => result.referenceId === "con").map((result) => result.id));
		track(...tree.results.filter((result) => result.referenceId === "acc").map((result) => result.id));

		const graphs = await sf.composite.graph([
			{
				graphId: "g1",
				build: (graph): void => {
					const account = graph.create("Account", { Name: `${marker} graph` });
					graph.create("Contact", { LastName: `${marker} graph`, AccountId: account.ref("id") });
				},
			},
			{
				graphId: "g2",
				build: (graph): void => {
					graph.create("Account", { Name: "" });
				},
			},
		]);
		expect(graphs.map((graph) => [graph.graphId, graph.isSuccessful])).toEqual([
			["g1", true],
			["g2", false],
		]);
		const g1 = graphs[0]?.response.responses ?? [];
		track(...g1.map((item) => (item.body as { id?: string } | null)?.id).reverse());
	});

	it("runs typed batch subrequests and composite collection subrequests", async () => {
		const composite = await sf.composite.execute(
			(c) => {
				const account = c.create("Account", { Name: `${marker} batch` });
				const contacts = c.createMany("Contact", [
					{ LastName: `${marker} batch 1`, AccountId: account.ref("id") },
					{ LastName: `${marker} batch 2`, AccountId: account.ref("id") },
				]);
				return { account, contacts };
			},
			{ allOrNone: true, throwOnError: true },
		);
		const accountId = composite.get(composite.refs.account).id ?? "";
		const contactIds = composite.get(composite.refs.contacts).map((result) => result.id ?? "");
		track(...contactIds, accountId);

		const batch = await sf.composite.batch((b) => ({
			account: b.get("Account", accountId, ["Name"]),
			children: b.children("Account", accountId, "Contacts", ["LastName"]),
			parent: b.parent("Contact", contactIds[0] ?? "", "Account", ["Name"]),
			query: b.query(sf.soql("Contact").select("Id").where("AccountId", "=", accountId)),
			limits: b.limits(),
			missing: b.get("Account", "001000000000000AAA"),
		}));
		expect(batch.get(batch.refs.account).Name).toBe(`${marker} batch`);
		expect(batch.get(batch.refs.children).totalSize).toBe(2);
		expect(batch.get(batch.refs.parent).Name).toBe(`${marker} batch`);
		expect(batch.get(batch.refs.query).totalSize).toBe(2);
		expect(batch.get(batch.refs.limits).DailyApiRequests?.Max).toBeGreaterThan(0);
		expect(batch.result(batch.refs.missing).statusCode).toBe(404);
		expect(batch.hasErrors).toBe(true);

		const halted = await sf.composite.batch(
			(b) => [b.get("Account", "001000000000000AAA"), b.get("Account", accountId)],
			{ haltOnError: true },
		);
		expect(halted.results.map((result) => result.statusCode)).toEqual([404, 412]);
	});

	it("uploads a ContentVersion in a multipart batch", async () => {
		const batch = await sf.composite.batch(
			(b) => ({
				version: b.createWithBlob(
					"ContentVersion",
					{ Title: `${marker} batch file`, PathOnClient: `${marker}.txt` },
					{ field: "VersionData", fileName: `${marker}.txt`, contentType: "text/plain", data: "hello batch" },
				),
			}),
			{ throwOnError: true },
		);
		const versionId = batch.get(batch.refs.version).id ?? "";
		const version = await sf.sobject("ContentVersion").get(versionId, ["ContentDocumentId"]);
		const documentId = String(version.ContentDocumentId);
		try {
			expect(new TextDecoder().decode(await sf.files.download(versionId))).toBe("hello batch");
		} finally {
			await sf.sobject("ContentDocument").delete(documentId);
		}
	});

	it("reads list views and layouts", async () => {
		const accounts = sf.sobject("Account");
		const { listviews } = await accounts.listViews();
		expect(listviews.length).toBeGreaterThan(0);
		const listViewId = listviews[0]?.id ?? "";
		const describe = await accounts.listViewDescribe(listViewId);
		expect(describe.query).toMatch(/FROM Account/i);
		const results = await accounts.listViewResults(listViewId, { limit: 1 });
		expect(results.columns.length).toBeGreaterThan(0);
		const layouts = await accounts.layouts();
		// `layouts` is null when Account has more than one record type.
		expect((layouts.layouts ?? []).length + layouts.recordTypeMappings.length).toBeGreaterThan(0);
		const compact = await accounts.compactLayouts();
		expect(Array.isArray(compact.compactLayouts)).toBe(true);
		expect(Array.isArray(await sf.recentlyViewed({ limit: 5 }))).toBe(true);
	});
});
