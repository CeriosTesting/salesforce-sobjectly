import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accessToken } from "../../src/auth/providers";
import type { CodegenConfig } from "../../src/codegen/config";
import { generateSource, readGeneratedHashes } from "../../src/codegen/generator";
import { checkGenerated, generate } from "../../src/codegen/index";
import { describes as fixtureDescribes } from "../fixtures/describes";
import { FakeTransport, INSTANCE_URL } from "../helpers/fake-transport";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function setup(describes = fixtureDescribes): { cwd: string; config: CodegenConfig } {
	const cwd = mkdtempSync(join(tmpdir(), "sobjectly-check-"));
	directories.push(cwd);
	const transport = new FakeTransport((request) => {
		const match = /\/sobjects\/(\w+)\/describe$/.exec(request.path);
		const describe = describes.find((item) => item.name === match?.[1]);
		return describe ? { body: describe } : { status: 404, body: [{ errorCode: "NOT_FOUND", message: "missing" }] };
	});
	return {
		cwd,
		config: {
			apiVersion: "v67.0",
			output: "sobjects.ts",
			sobjects: ["Account", "Contact"],
			auth: accessToken({ accessToken: "T", instanceUrl: INSTANCE_URL }),
			transport,
		},
	};
}

/** A crude "formatter": spaces instead of tabs, single quotes, no semicolons, extra blank lines. */
function reformat(source: string): string {
	return source
		.replace(/\t/g, "  ")
		.replace(/"([^"'\n]*)"/g, "'$1'")
		.replace(/;$/gm, "")
		.replace(/\n\n/g, "\n\n\n");
}

describe("content hash header", () => {
	it("records a content hash and per-sObject hashes", () => {
		const source = generateSource(fixtureDescribes, { apiVersion: "v67.0" });
		const hashes = readGeneratedHashes(source);
		expect(hashes?.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect([...(hashes?.sobjects.keys() ?? [])]).toEqual([
			"Account",
			"Case",
			"Contact",
			"Order_Shipped__e",
			"Task",
			"User",
		]);
		expect(readGeneratedHashes(reformat(source))).toEqual(hashes);
		expect(readGeneratedHashes("export const x = 1;")).toBeUndefined();
	});
});

describe("checkGenerated", () => {
	it("passes for an up-to-date file, also after reformatting", async () => {
		const { cwd, config } = setup();
		const result = await generate(config, { cwd });
		expect(result.source).toContain("sobjectly-content-hash");
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });

		writeFileSync(join(cwd, "sobjects.ts"), reformat(readFileSync(join(cwd, "sobjects.ts"), "utf8")));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });
	});

	it("reports a missing file", async () => {
		const { cwd, config } = setup();
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "missing" });
	});

	it("names the sObjects that changed, were added or removed", async () => {
		const { cwd, config } = setup();
		await generate(config, { cwd });
		const changedDescribes = fixtureDescribes.map((describe) =>
			describe.name === "Contact"
				? { ...describe, fields: [...describe.fields, { ...describe.fields[1], name: "Nickname__c" }] }
				: describe,
		);
		const changed = setup(changedDescribes);
		const result = await checkGenerated({ ...changed.config, sobjects: ["Contact", "User"] }, { cwd });
		expect(result).toMatchObject({
			upToDate: false,
			reason: "changed",
			added: ["User"],
			removed: ["Account"],
			changed: ["Contact"],
		});
	});

	it("falls back to a formatting-insensitive comparison for files without a hash header", async () => {
		const { cwd, config } = setup();
		const { source } = await generate(config, { cwd, write: false });
		const withoutHash = source
			.split("\n")
			.filter((line) => !line.startsWith("// sobjectly-"))
			.join("\n");
		writeFileSync(join(cwd, "sobjects.ts"), reformat(withoutHash));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });
		writeFileSync(join(cwd, "sobjects.ts"), withoutHash.replace("LastName: string", "Surname: string"));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "changed" });
	});

	it("does not write with write: false", async () => {
		const { cwd, config } = setup();
		await generate(config, { cwd, write: false });
		expect(await checkGenerated(config, { cwd })).toMatchObject({ reason: "missing" });
	});
});

describe("checkGenerated without a hash header", () => {
	/** Account with picklist values that contain spaces and comment-like text. */
	const spacedDescribes = fixtureDescribes.map((describe) =>
		describe.name === "Account"
			? {
					...describe,
					fields: describe.fields.map((field) =>
						field.name === "Type"
							? {
									...field,
									picklistValues: ["Closed Won", "a // b", "c /* d */ e"].map((value) => ({
										active: true,
										defaultValue: false,
										label: value,
										validFor: null,
										value,
									})),
								}
							: field,
					),
				}
			: describe,
	);

	async function writeWithoutHash(): Promise<{ cwd: string; config: CodegenConfig; source: string }> {
		const { cwd, config } = setup(spacedDescribes);
		const { source } = await generate(config, { cwd, write: false });
		const withoutHash = source
			.split("\n")
			.filter((line) => !line.startsWith("// sobjectly-"))
			.join("\n");
		expect(withoutHash).toContain('"Closed Won"');
		return { cwd, config, source: withoutHash };
	}

	it("treats whitespace inside string literals as content", async () => {
		const { cwd, config, source } = await writeWithoutHash();
		writeFileSync(join(cwd, "sobjects.ts"), source);
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });

		writeFileSync(join(cwd, "sobjects.ts"), source.replaceAll('"Closed Won"', '"Closed  Won"'));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "changed" });

		writeFileSync(join(cwd, "sobjects.ts"), source.replaceAll('"Closed Won"', '"ClosedWon"'));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "changed" });
	});

	it("does not treat comment markers inside strings as comments", async () => {
		const { cwd, config, source } = await writeWithoutHash();
		writeFileSync(join(cwd, "sobjects.ts"), source.replaceAll('"a // b"', '"a // B"'));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "changed" });

		writeFileSync(join(cwd, "sobjects.ts"), source.replaceAll('"c /* d */ e"', '"c /* D */ e"'));
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: false, reason: "changed" });
	});

	it("ignores formatting, comments and quote style outside strings", async () => {
		const { cwd, config, source } = await writeWithoutHash();
		const reformatted = source
			.replace(/\t/g, "    ")
			.replace(/;$/gm, "")
			.replaceAll('"Closed Won"', "'Closed Won'")
			.replace("export interface Account {", "// a comment\nexport interface Account {  /* inline */");
		writeFileSync(join(cwd, "sobjects.ts"), reformatted);
		expect(await checkGenerated(config, { cwd })).toMatchObject({ upToDate: true });
	});
});
