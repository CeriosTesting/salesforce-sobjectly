import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeApiVersion } from "../../src/api-version";
import { resolveAuth } from "../../src/codegen/index";
import { renderConfig, runInit } from "../../src/codegen/init";
import { loadConfig } from "../../src/codegen/load-config";
import { type Choice, type Prompter, readlinePrompter } from "../../src/codegen/prompter";

const directories: string[] = [];
function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "sobjectly-init-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Answers questions from a queue. An empty answer takes the default. Records questions and validation errors. */
function scriptedPrompter(answers: string[]): Prompter & { questions: string[]; errors: string[] } {
	const questions: string[] = [];
	const errors: string[] = [];
	const next = (question: string): string => {
		questions.push(question);
		const answer = answers.shift();
		if (answer === undefined) {
			throw new Error(`No scripted answer for "${question}"`);
		}
		return answer;
	};
	const ask: Prompter["ask"] = (question, options = {}) => {
		for (;;) {
			const raw = next(question);
			const answer = raw === "" ? (options.defaultValue ?? "") : raw;
			const error = options.validate?.(answer);
			if (error === undefined) {
				return Promise.resolve(answer);
			}
			errors.push(error);
		}
	};
	return {
		questions,
		errors,
		ask,
		choose<T extends string>(question: string, choices: readonly Choice<T>[], defaultValue: T): Promise<T> {
			const answer = next(question);
			if (answer === "") {
				return Promise.resolve(defaultValue);
			}
			const choice = choices[Number(answer) - 1] ?? choices.find((item) => item.value === answer);
			if (!choice) {
				throw new Error(`Invalid choice "${answer}"`);
			}
			return Promise.resolve(choice.value);
		},
		confirm(question: string, defaultValue: boolean): Promise<boolean> {
			const answer = next(question);
			return Promise.resolve(answer === "" ? defaultValue : /^y/i.test(answer));
		},
		close: () => undefined,
	};
}

describe("normalizeApiVersion", () => {
	it.each([
		["66", "v66.0"],
		["66.0", "v66.0"],
		["v66", "v66.0"],
		["V61.0", "v61.0"],
		[" v67.0 ", "v67.0"],
	])("normalizes %s to %s", (input, expected) => {
		expect(normalizeApiVersion(input)).toBe(expected);
	});

	it.each(["", "latest", "v", "66.0.1", "abc"])("rejects %j", (input) => {
		expect(normalizeApiVersion(input)).toBeUndefined();
	});
});

describe("runInit", () => {
	it("asks for every setting and writes the config, .env.example and npm script", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app", scripts: { test: "vitest" } }, null, 2));
		writeFileSync(join(cwd, ".env.example"), "OTHER=1");
		const prompter = scriptedPrompter([
			"latest", // rejected: not a version
			"66", // API version
			"types/salesforce.js", // rejected: not a .ts file
			"", // output: default
			"Account, Case Account, My_Object__c", // sObjects
			"1", // client credentials
			"2", // plain string picklists
			"", // TypeScript
			"", // add to .env.example: yes
			"y", // add npm script
		]);
		const logs: string[] = [];

		const result = await runInit({ cwd, prompter, log: (message) => logs.push(message) });

		expect(prompter.errors).toEqual([
			'Enter a version like "v66.0" or "66".',
			"The output must be a TypeScript file, e.g. src/generated/sobjects.ts.",
		]);
		expect(result.configPath).toBe(join(cwd, "sobjectly.config.ts"));
		expect(readFileSync(join(cwd, "sobjectly.config.ts"), "utf8")).toBe(
			renderConfig({
				apiVersion: "v66.0",
				output: "src/generated/sobjects.ts",
				sobjects: ["Account", "Case", "My_Object__c"],
				auth: "clientCredentials",
				picklists: "string",
				format: "ts",
			}),
		);
		expect(readFileSync(join(cwd, ".env.example"), "utf8")).toBe(
			"OTHER=1\n\n# Salesforce credentials for `sobjectly generate`\nSF_LOGIN_URL=\nSF_CLIENT_ID=\nSF_CLIENT_SECRET=\n",
		);
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts: Record<string, string> };
		expect(pkg.scripts).toEqual({ test: "vitest", "sobjects:generate": "sobjectly generate" });
		expect(logs.join("\n")).toContain("npm run sobjects:generate -- --env-file .env");
	});

	it("renders a readable config", () => {
		expect(
			renderConfig({
				apiVersion: "v66.0",
				output: "src/generated/sobjects.ts",
				sobjects: ["Account", "Contact"],
				auth: "jwtBearer",
				picklists: "union",
				format: "ts",
			}),
		).toMatchInlineSnapshot(`
			"import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";

			export default defineConfig({
				// The Salesforce REST API version. The generated file exports it as API_VERSION for the client.
				apiVersion: "v66.0",
				// Where the generated types are written, relative to this file.
				output: "src/generated/sobjects.ts",
				// The sObjects to generate types for.
				sobjects: ["Account", "Contact"],
				// Fill these in from process.env (any variable names), a secret store or elsewhere. Keep secrets out of this file.
				auth: {
					type: "jwtBearer",
					loginUrl: process.env.SF_LOGIN_URL,
					clientId: process.env.SF_CLIENT_ID,
					username: process.env.SF_USERNAME,
					privateKeyPath: process.env.SF_PRIVATE_KEY_PATH,
				},
				picklists: "union",
			});
			"
		`);
	});

	it("skips preset questions and uses defaults with --yes", async () => {
		const cwd = tempDir();
		const prompter = scriptedPrompter([]);
		const result = await runInit({
			cwd,
			prompter,
			log: () => undefined,
			yes: true,
			preset: { apiVersion: "v67.0", auth: "accessToken", format: "json" },
		});
		expect(prompter.questions).toEqual([]);
		expect(result.answers).toEqual({
			apiVersion: "v67.0",
			output: "src/generated/sobjects.ts",
			sobjects: ["Account", "Contact"],
			auth: "accessToken",
			picklists: "union",
			format: "json",
		});
		expect(JSON.parse(readFileSync(join(cwd, "sobjectly.config.json"), "utf8"))).toEqual({
			$schema: "./node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json",
			apiVersion: "v67.0",
			output: "src/generated/sobjects.ts",
			sobjects: ["Account", "Contact"],
			auth: { type: "accessToken", accessToken: "${SF_ACCESS_TOKEN}", instanceUrl: "${SF_INSTANCE_URL}" },
			picklists: "union",
		});
		const { config } = await loadConfig(join(cwd, "sobjectly.config.json"));
		expect(config.apiVersion).toBe("v67.0");
		expect(() =>
			resolveAuth(config.auth, { SF_ACCESS_TOKEN: "T", SF_INSTANCE_URL: "https://x.my.salesforce.com" }),
		).not.toThrow();
		expect(readFileSync(join(cwd, ".env.example"), "utf8")).toContain("SF_ACCESS_TOKEN=\nSF_INSTANCE_URL=\n");
	});

	it("requires an API version with --yes", async () => {
		await expect(
			runInit({ cwd: tempDir(), prompter: scriptedPrompter([]), log: () => undefined, yes: true }),
		).rejects.toThrow(/--api-version/);
	});

	it("replaces a config of the other format", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "sobjectly.config.ts"), "// old");
		const logs: string[] = [];
		await runInit({
			cwd,
			prompter: scriptedPrompter(["y", "n"]), // replace: yes; update .env.example: no
			log: (message) => logs.push(message),
			preset: {
				apiVersion: "v66.0",
				output: "x.ts",
				sobjects: ["Account"],
				auth: "accessToken",
				picklists: "union",
				format: "json",
			},
		});
		expect(existsSync(join(cwd, "sobjectly.config.ts"))).toBe(false);
		expect(existsSync(join(cwd, "sobjectly.config.json"))).toBe(true);
		expect(logs).toContain("Removed sobjectly.config.ts");
	});

	it("keeps an existing config unless the user confirms or --force is given", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "sobjectly.config.ts"), "// mine");
		const declined = await runInit({ cwd, prompter: scriptedPrompter(["n"]), log: () => undefined });
		expect(declined.configPath).toBeUndefined();
		expect(readFileSync(join(cwd, "sobjectly.config.ts"), "utf8")).toBe("// mine");

		await runInit({
			cwd,
			prompter: scriptedPrompter([]),
			log: () => undefined,
			force: true,
			yes: true,
			preset: { apiVersion: "v66.0" },
		});
		expect(readFileSync(join(cwd, "sobjectly.config.ts"), "utf8")).toContain('apiVersion: "v66.0"');
	});
});

describe("readlinePrompter", () => {
	it("reads answers, applies defaults, re-asks on invalid input and parses choices", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const answers = ["", "nope", "v66.0", "3", "2", "maybe", "y"];
		let transcript = "";
		output.on("data", (chunk: Buffer) => {
			transcript += chunk.toString();
			if (/: $/.test(chunk.toString())) {
				input.write(`${answers.shift() ?? ""}\n`);
			}
		});
		const prompter = readlinePrompter(input, output);
		try {
			expect(await prompter.ask("Name", { defaultValue: "Acme" })).toBe("Acme");
			expect(
				await prompter.ask("Version", { validate: (value) => (value.startsWith("v") ? undefined : "Use vXX.X") }),
			).toBe("v66.0");
			const choices = [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			] as const;
			expect(await prompter.choose("Pick", choices, "a")).toBe("b");
			expect(await prompter.confirm("Sure?", false)).toBe(true);
		} finally {
			prompter.close();
		}
		expect(transcript).toContain("Use vXX.X");
		expect(transcript).toContain("Enter a number from 1 to 2.");
		expect(transcript).toContain("1) A (default)");
		expect(transcript).toContain("Answer y or n.");
	});
});

describe("runInit with the Salesforce CLI", () => {
	it("asks for the org alias and renders sfCli auth without env variables", async () => {
		const cwd = tempDir();
		const prompter = scriptedPrompter(["v66.0", "", "Account", "2", "my-org", "", ""]);
		const logs: string[] = [];
		const result = await runInit({ cwd, prompter, log: (message) => logs.push(message) });
		expect(result.answers).toMatchObject({ auth: "sfCli", targetOrg: "my-org" });
		const config = readFileSync(join(cwd, "sobjectly.config.ts"), "utf8");
		expect(config).toContain('auth: { type: "sfCli", targetOrg: "my-org" },');
		expect(config).toContain("sf org login web");
		expect(result.envExampleUpdated).toBe(false);
		expect(logs.join("\n")).toContain("sf org login web --alias my-org");
		expect(logs.join("\n")).toContain("npx sobjectly generate\n");
	});

	it("renders sfCli auth in JSON and omits an empty alias", () => {
		const base = {
			apiVersion: "v66.0" as const,
			output: "x.ts",
			sobjects: ["Account"],
			picklists: "union" as const,
			format: "json" as const,
		};
		expect(JSON.parse(renderConfig({ ...base, auth: "sfCli", targetOrg: "dev" })).auth).toEqual({
			type: "sfCli",
			targetOrg: "dev",
		});
		expect(JSON.parse(renderConfig({ ...base, auth: "sfCli" })).auth).toEqual({ type: "sfCli" });
	});
});

describe("runInit preset validation", () => {
	const preset = {
		apiVersion: "v66.0" as const,
		output: "src/generated/sobjects.ts",
		sobjects: ["Account"],
		auth: "sfCli" as const,
		picklists: "union" as const,
		format: "ts" as const,
	};

	it.each([
		[{ sobjects: ["Account", "Bad Name"] }, /Not a valid sObject API name: Bad Name/],
		[{ sobjects: ["1Account"] }, /Not a valid sObject API name: 1Account/],
		[{ sobjects: [] }, /Enter at least one sObject/],
		[{ output: "types.js" }, /The output must be a TypeScript file/],
		[{ targetOrg: "my org; rm -rf" }, /Invalid org alias "my org; rm -rf"/],
	])("rejects the preset %j", async (invalid, message) => {
		const cwd = tempDir();
		await expect(
			runInit({
				cwd,
				prompter: scriptedPrompter([]),
				log: () => undefined,
				yes: true,
				preset: { ...preset, ...invalid },
			}),
		).rejects.toThrow(message);
		expect(existsSync(join(cwd, "sobjectly.config.ts"))).toBe(false);
	});

	it("reports every invalid preset answer at once", async () => {
		await expect(
			runInit({
				cwd: tempDir(),
				prompter: scriptedPrompter([]),
				log: () => undefined,
				yes: true,
				preset: { ...preset, sobjects: ["Bad-Name"], output: "x.js" },
			}),
		).rejects.toThrow(
			"Not a valid sObject API name: Bad-Name The output must be a TypeScript file, e.g. src/generated/sobjects.ts.",
		);
	});

	it("accepts a valid preset, including an org alias with dots, @ and dashes", async () => {
		const cwd = tempDir();
		const result = await runInit({
			cwd,
			prompter: scriptedPrompter([]),
			log: () => undefined,
			yes: true,
			preset: { ...preset, targetOrg: "me@example.com.dev-1" },
		});
		expect(result.answers).toMatchObject({ targetOrg: "me@example.com.dev-1" });
	});
});

describe("runInit package.json script", () => {
	const preset = {
		apiVersion: "v66.0" as const,
		output: "src/generated/sobjects.ts",
		sobjects: ["Account"],
		auth: "sfCli" as const,
		picklists: "union" as const,
		format: "ts" as const,
	};

	async function init(cwd: string): Promise<{ scriptAdded: boolean | undefined; logs: string[] }> {
		const logs: string[] = [];
		const result = await runInit({
			cwd,
			prompter: scriptedPrompter([]),
			log: (message) => logs.push(message),
			yes: true,
			preset,
		});
		return { scriptAdded: result.scriptAdded, logs };
	}

	it("keeps a UTF-8 BOM, CRLF line endings and the indentation", async () => {
		const cwd = tempDir();
		const original = `﻿${JSON.stringify({ name: "app", scripts: { test: "vitest" } }, null, 4).replace(/\n/g, "\r\n")}\r\n`;
		writeFileSync(join(cwd, "package.json"), original, "utf8");

		expect((await init(cwd)).scriptAdded).toBe(true);

		const written = readFileSync(join(cwd, "package.json"), "utf8");
		expect(written.startsWith('﻿{\r\n    "name"')).toBe(true);
		expect(written.endsWith("}\r\n")).toBe(true);
		expect(written.replace(/\r\n/g, "")).not.toContain("\n");
		expect(written.match(/﻿/g)).toHaveLength(1);
		expect(JSON.parse(written.slice(1))).toEqual({
			name: "app",
			scripts: { test: "vitest", "sobjects:generate": "sobjectly generate" },
		});
	});

	it("keeps LF line endings and tabs without a BOM", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "app" }, null, "\t")}\n`, "utf8");

		expect((await init(cwd)).scriptAdded).toBe(true);

		expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(
			'{\n\t"name": "app",\n\t"scripts": {\n\t\t"sobjects:generate": "sobjectly generate"\n\t}\n}\n',
		);
	});

	it("skips an invalid package.json with a message and leaves it untouched", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "package.json"), '{ "name": "app", }', "utf8");

		const { scriptAdded, logs } = await init(cwd);

		expect(scriptAdded).toBe(false);
		expect(logs).toContain('Skipped adding the "sobjects:generate" script: package.json is not valid JSON.');
		expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe('{ "name": "app", }');
		expect(existsSync(join(cwd, "sobjectly.config.ts"))).toBe(true);
		expect(logs.join("\n")).toContain("npx sobjectly generate");
	});

	it("does not add the script twice", async () => {
		const cwd = tempDir();
		const content = JSON.stringify({ scripts: { "sobjects:generate": "custom" } });
		writeFileSync(join(cwd, "package.json"), content, "utf8");
		expect((await init(cwd)).scriptAdded).toBe(false);
		expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(content);
	});
});

describe("readlinePrompter after the input has ended", () => {
	it("still writes the prompt for queued answers, then rejects", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let transcript = "";
		output.on("data", (chunk: Buffer) => {
			transcript += chunk.toString();
		});
		const prompter = readlinePrompter(input, output);
		const ended = new Promise((resolve) => input.once("end", resolve));
		input.end("first\nsecond\n");
		await ended;
		await new Promise((resolve) => setImmediate(resolve));
		try {
			expect(await prompter.ask("One")).toBe("first");
			expect(await prompter.ask("Two")).toBe("second");
			await expect(prompter.ask("Three")).rejects.toThrow("Input ended before all questions were answered.");
		} finally {
			prompter.close();
		}
		expect(transcript).toContain("? One: first\n");
		expect(transcript).toContain("? Two: second\n");
		expect(transcript).toContain("? Three: ");
	});
});
