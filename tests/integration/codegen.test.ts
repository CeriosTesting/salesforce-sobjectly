/** Generates sObject types from a real org and checks them with `--check` semantics. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { checkGenerated, generate } from "../../src/codegen/index";

import { liveApiVersion, liveAuth, liveOrgConfigured } from "./org";

describe.skipIf(!liveOrgConfigured)("live org: codegen", () => {
	const cwd = mkdtempSync(join(tmpdir(), "sobjectly-live-"));

	afterAll(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("generates types for standard objects and passes --check afterwards", async () => {
		const config = {
			apiVersion: liveApiVersion(),
			output: "sobjects.ts",
			sobjects: ["account", "Contact", "Case", "Opportunity", "Task", "User"],
			auth: liveAuth(),
		};
		const { source } = await generate(config, { cwd });
		expect(source).toContain("export interface Account ");
		expect(source).toContain("export interface Task ");
		// Industry is an unrestricted picklist: its values plus any string.
		expect(source).toMatch(/\tIndustry: "[^"]+"( \| "[^"]+")* \| \(string & \{\}\) \| null;/);
		expect(source).toContain("PICKLIST_VALUES");
		expect(source).toContain(`API_VERSION = "${liveApiVersion()}"`);
		// Task.What is polymorphic.
		expect(source).toMatch(/What: /);

		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });
	});
});
