import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accessToken } from "../../src/auth/providers";
import { CodegenConfigError, findConfigFile, generate, loadConfig, resolveAuth } from "../../src/codegen/index";
import { describes } from "../fixtures/describes";
import { API, FakeTransport, INSTANCE_URL } from "../helpers/fake-transport";

const directories: string[] = [];
function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "sobjectly-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function orgTransport(failing: string[] = []): FakeTransport {
	return new FakeTransport((request) => {
		if (/^\/services\/data\/v\d+\.\d+\/sobjects$/.test(request.path)) {
			return {
				body: {
					sobjects: [
						...describes.map((describe) => ({ name: describe.name, queryable: true, deprecatedAndHidden: false })),
						{ name: "Hidden", queryable: true, deprecatedAndHidden: true },
						{ name: "NotQueryable", queryable: false, deprecatedAndHidden: false },
					],
				},
			};
		}
		const match = /\/sobjects\/(\w+)\/describe$/.exec(request.path);
		if (match && failing.includes(match[1])) {
			return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] };
		}
		const describe = describes.find((item) => item.name === match?.[1]);
		return describe ? { body: describe } : { status: 404, body: [{ errorCode: "NOT_FOUND", message: "missing" }] };
	});
}

const auth = accessToken({ accessToken: "T", instanceUrl: INSTANCE_URL });

describe("generate", () => {
	it("describes the configured sObjects and writes the file", async () => {
		const cwd = tempDir();
		const transport = orgTransport();
		const result = await generate(
			{ output: "out/sobjects.ts", sobjects: ["User", "Account", "User"], auth, transport, apiVersion: "v67.0" },
			{ cwd },
		);
		expect(result.sobjects).toEqual(["Account", "User"]);
		const source = readFileSync(join(cwd, "out/sobjects.ts"), "utf8");
		expect(source).toContain("export interface Account {");
		expect(source).toContain(
			'import type { SalesforceAddress, SalesforceGeolocation } from "@cerios/salesforce-sobjectly";',
		);
		expect(readdirSync(join(cwd, "out"))).toEqual(["sobjects.ts"]);
		expect(transport.requests.some((request) => request.path === `${API}/sobjects`)).toBe(false);
	});

	it("uses describeGlobal when no sObjects are listed and applies exclude", async () => {
		const cwd = tempDir();
		const warnings: string[] = [];
		const result = await generate(
			{ output: "all.ts", exclude: ["User"], auth, transport: orgTransport(), apiVersion: "v67.0" },
			{ cwd, logger: { info: () => undefined, warn: (message) => warnings.push(message) } },
		);
		expect(result.sobjects).toEqual(["Account", "Case", "Contact", "Order_Shipped__e", "Task"]);
		expect(warnings[0]).toMatch(/No `sobjects` configured/);
	});

	it("fails fast on describe errors unless continueOnDescribeError is set", async () => {
		const cwd = tempDir();
		const config = {
			output: "x.ts",
			apiVersion: "v67.0" as const,
			sobjects: ["Account", "Broken"],
			auth,
			transport: orgTransport(["Broken"]),
		};
		await expect(generate(config, { cwd })).rejects.toThrow(/Describing sObject "Broken" failed/);
		expect(existsSync(join(cwd, "x.ts"))).toBe(false);

		const result = await generate({ ...config, continueOnDescribeError: true }, { cwd });
		expect(result.skipped.map((item) => item.name)).toEqual(["Broken"]);
		expect(result.sobjects).toEqual(["Account"]);
	});

	it("requires an apiVersion in the config", async () => {
		const cwd = tempDir();
		const config = { output: "x.ts", sobjects: ["User"], auth, transport: orgTransport() };
		await expect(generate(config as never, { cwd })).rejects.toThrow(/apiVersion: required[\s\S]*sobjectly init/);
		await expect(generate({ ...config, apiVersion: "66" as never }, { cwd })).rejects.toThrow(
			/apiVersion: must look like "v66.0", got "66"/,
		);
	});

	it("exports the configured API version in the generated file", async () => {
		const cwd = tempDir();
		const transport = orgTransport();
		const result = await generate(
			{ output: "v.ts", sobjects: ["User"], auth, transport, apiVersion: "v61.0" },
			{ cwd },
		);
		expect(result.apiVersion).toBe("v61.0");
		expect(transport.last.path).toBe("/services/data/v61.0/sobjects/User/describe");
		expect(readFileSync(join(cwd, "v.ts"), "utf8")).toContain('export const API_VERSION = "v61.0";');
	});

	it("runs the format hook", async () => {
		const cwd = tempDir();
		await generate(
			{
				output: "f.ts",
				apiVersion: "v67.0",
				sobjects: ["User"],
				auth,
				transport: orgTransport(),
				format: (source) => `// formatted\n${source}`,
			},
			{ cwd },
		);
		expect(readFileSync(join(cwd, "f.ts"), "utf8").startsWith("// formatted\n")).toBe(true);
	});
});

describe("resolveAuth", () => {
	it("reads client credentials and access tokens from the environment", () => {
		expect(
			resolveAuth(undefined, { SF_LOGIN_URL: INSTANCE_URL, SF_CLIENT_ID: "id", SF_CLIENT_SECRET: "secret" }),
		).toHaveProperty("getToken");
		expect(
			resolveAuth({ type: "accessToken" }, { SF_ACCESS_TOKEN: "T", SF_INSTANCE_URL: INSTANCE_URL }),
		).toHaveProperty("getToken");
		expect(() => resolveAuth({ type: "clientCredentials", clientIdEnv: "MY_ID" }, {})).toThrow(/SF_LOGIN_URL/);
		expect(resolveAuth(auth, {})).toBe(auth);
	});
});

describe("loadConfig", () => {
	it("loads and validates a TypeScript config", async () => {
		const directory = tempDir();
		writeFileSync(
			join(directory, "sobjectly.config.ts"),
			[
				"type Config = { apiVersion: `v${number}.${number}`; output: string; sobjects: string[] };",
				'const config: Config = { apiVersion: "v66.0", output: "generated/sobjects.ts", sobjects: ["Account"] };',
				"export default config;",
			].join("\n"),
		);
		const found = findConfigFile(directory);
		expect(found).toBe(join(directory, "sobjectly.config.ts"));
		const { config, directory: configDirectory } = await loadConfig(found!);
		expect(config).toEqual({ apiVersion: "v66.0", output: "generated/sobjects.ts", sobjects: ["Account"] });
		expect(configDirectory).toBe(directory);
	});

	it("loads a JSON config and drops $schema", async () => {
		const directory = tempDir();
		writeFileSync(
			join(directory, "sobjectly.config.json"),
			JSON.stringify({
				$schema: "./node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json",
				apiVersion: "v66.0",
				output: "src/generated/sobjects.ts",
				sobjects: ["Account"],
				auth: { type: "clientCredentials", clientIdEnv: "MY_CLIENT_ID" },
			}),
		);
		expect(findConfigFile(directory)).toBe(join(directory, "sobjectly.config.json"));
		const { config } = await loadConfig(join(directory, "sobjectly.config.json"));
		expect(config).toEqual({
			apiVersion: "v66.0",
			output: "src/generated/sobjects.ts",
			sobjects: ["Account"],
			auth: { type: "clientCredentials", clientIdEnv: "MY_CLIENT_ID" },
		});
	});

	it("prefers the TypeScript config when both exist", () => {
		const directory = tempDir();
		writeFileSync(join(directory, "sobjectly.config.json"), "{}");
		writeFileSync(join(directory, "sobjectly.config.ts"), "export default {};");
		expect(findConfigFile(directory)).toBe(join(directory, "sobjectly.config.ts"));
	});

	it("reports invalid configs with every problem", async () => {
		const directory = tempDir();
		writeFileSync(join(directory, "bad.json"), JSON.stringify({ sobjects: ["Account"], format: "prettier" }));
		const error = await loadConfig(join(directory, "bad.json")).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CodegenConfigError);
		expect((error as CodegenConfigError).problems).toEqual([
			'apiVersion: required, e.g. "v66.0".',
			'output: required, e.g. "src/generated/sobjects.ts".',
			"format: only supported in a TypeScript config.",
			'Run "npx sobjectly init" to create a valid config.',
		]);

		writeFileSync(join(directory, "broken.json"), "{ apiVersion: ");
		await expect(loadConfig(join(directory, "broken.json"))).rejects.toThrow(/not valid JSON/);
		writeFileSync(join(directory, "config.js"), "module.exports = {}");
		await expect(loadConfig(join(directory, "config.js"))).rejects.toThrow(/Unsupported config file/);
		await expect(loadConfig(join(directory, "missing.ts"))).rejects.toThrow(/not found/);
		expect(findConfigFile(directory)).toBeUndefined();
	});
});

/** An org whose describe endpoint, like Salesforce, matches sObject names case-insensitively. */
function caseInsensitiveTransport(aliases: Record<string, string> = {}): FakeTransport {
	return new FakeTransport((request) => {
		if (/^\/services\/data\/v\d+\.\d+\/sobjects$/.test(request.path)) {
			return {
				body: {
					sobjects: describes.map((describe) => ({ name: describe.name, queryable: true, deprecatedAndHidden: false })),
				},
			};
		}
		const requested = /\/sobjects\/(\w+)\/describe$/.exec(request.path)?.[1] ?? "";
		const name = aliases[requested] ?? requested;
		const describe = describes.find((item) => item.name.toLowerCase() === name.toLowerCase());
		return describe ? { body: describe } : { status: 404, body: [{ errorCode: "NOT_FOUND", message: "missing" }] };
	});
}

function describedNames(transport: FakeTransport): string[] {
	return transport.requests
		.map((request) => /\/sobjects\/(\w+)\/describe$/.exec(request.path)?.[1])
		.filter((name): name is string => name !== undefined);
}

describe("generate: sObject name resolution", () => {
	it("matches configured names case-insensitively and uses the org's casing", async () => {
		const cwd = tempDir();
		const transport = caseInsensitiveTransport();
		const result = await generate(
			{ output: "s.ts", apiVersion: "v67.0", sobjects: ["account", "CONTACT"], auth, transport },
			{ cwd },
		);
		expect(result.sobjects).toEqual(["Account", "Contact"]);
		const source = readFileSync(join(cwd, "s.ts"), "utf8");
		expect(source).toContain("export interface Account {");
		expect(source).toContain("export interface Contact {");
		expect(source).not.toContain("interface account");
	});

	it("describes names that differ only in case once", async () => {
		const cwd = tempDir();
		const transport = caseInsensitiveTransport();
		const result = await generate(
			{ output: "s.ts", apiVersion: "v67.0", sobjects: ["Account", "account", "ACCOUNT", "Contact"], auth, transport },
			{ cwd },
		);
		expect(result.sobjects).toEqual(["Account", "Contact"]);
		expect(describedNames(transport)).toEqual(["Account", "Contact"]);
	});

	it("keeps one sObject when two configured names describe the same sObject", async () => {
		const cwd = tempDir();
		const transport = caseInsensitiveTransport({ AccountAlias: "Account" });
		const result = await generate(
			{ output: "s.ts", apiVersion: "v67.0", sobjects: ["Account", "AccountAlias"], auth, transport },
			{ cwd },
		);
		expect(result.sobjects).toEqual(["Account"]);
		expect(readFileSync(join(cwd, "s.ts"), "utf8").match(/export interface Account \{/g)).toHaveLength(1);
	});

	it("applies exclude case-insensitively, with and without a sobjects list", async () => {
		const cwd = tempDir();
		const listed = await generate(
			{
				output: "a.ts",
				apiVersion: "v67.0",
				sobjects: ["Account", "Contact"],
				exclude: ["CONTACT"],
				auth,
				transport: caseInsensitiveTransport(),
			},
			{ cwd },
		);
		expect(listed.sobjects).toEqual(["Account"]);

		const all = await generate(
			{ output: "b.ts", apiVersion: "v67.0", exclude: ["user", "TASK"], auth, transport: caseInsensitiveTransport() },
			{ cwd },
		);
		expect(all.sobjects).toEqual(["Account", "Case", "Contact", "Order_Shipped__e"]);
	});
});

describe("generate: describe failures", () => {
	it("aborts the other describes when one fails and surfaces the error", async () => {
		const cwd = tempDir();
		let slowSignal: AbortSignal | undefined;
		const transport = new FakeTransport(async (request) => {
			const name = /\/sobjects\/(\w+)\/describe$/.exec(request.path)?.[1];
			if (name === "Slow") {
				slowSignal = request.signal;
				// Never answers on its own: only an abort settles it.
				return new Promise((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(request.signal?.reason as Error), { once: true });
				});
			}
			if (name === "Broken") {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { status: 404, body: [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }] };
			}
			const describe = describes.find((item) => item.name === name);
			return describe ? { body: describe } : { status: 404, body: [{ errorCode: "NOT_FOUND", message: "missing" }] };
		});

		const error = await generate(
			{
				output: "x.ts",
				apiVersion: "v67.0",
				sobjects: ["Slow", "Broken", "Account", "Contact"],
				concurrency: 2,
				auth,
				transport,
			},
			{ cwd },
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/Describing sObject "Broken" failed: .*does not exist/);
		expect((error as Error).cause).toBeInstanceOf(Error);
		expect(slowSignal?.aborted).toBe(true);
		// The workers stop picking up new sObjects once one describe has failed.
		expect(describedNames(transport)).toEqual(["Slow", "Broken"]);
		expect(existsSync(join(cwd, "x.ts"))).toBe(false);
	});
});

describe("generate: field excludes", () => {
	it("accepts excludes keyed and listed in a different case than the sObject", async () => {
		const cwd = tempDir();
		const result = await generate(
			{
				output: "e.ts",
				apiVersion: "v67.0",
				sobjects: ["Contact"],
				excludeCreateFields: { contact: ["lastname", "EMAIL"] },
				auth,
				transport: caseInsensitiveTransport(),
			},
			{ cwd, write: false },
		);
		const create = result.source.split("\n").find((line) => line.startsWith("export type ContactCreateInput")) ?? "";
		expect(create).toContain('"FirstName"');
		expect(create).not.toContain('"LastName"');
		expect(create).not.toContain('"Email"');
	});
});
