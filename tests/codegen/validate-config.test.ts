import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { accessToken } from "../../src/auth/providers";
import {
	AUTH_OPTIONS,
	CONFIG_OPTIONS,
	CodegenConfigError,
	PICKLIST_MODES,
	validateConfig,
} from "../../src/codegen/validate-config";

const valid = { apiVersion: "v66.0", output: "src/generated/sobjects.ts" };

function problems(config: unknown, json = false): string[] {
	try {
		validateConfig(config, { source: "test", json });
		return [];
	} catch (error) {
		if (error instanceof CodegenConfigError) {
			return error.problems;
		}
		throw error;
	}
}

describe("validateConfig", () => {
	it("accepts a minimal and a full config", () => {
		expect(problems(valid)).toEqual([]);
		expect(
			problems({
				...valid,
				sobjects: ["Account", "My_Object__c"],
				exclude: ["Account"],
				auth: { type: "jwtBearer", usernameEnv: "SF_USER", privateKeyPathEnv: "KEY" },
				excludeCreateFields: { Account: ["Name"] },
				excludeUpdateFields: { My_Object__c: ["Field__c"] },
				picklists: "string",
				concurrency: 4,
				continueOnDescribeError: true,
				importSource: "../lib",
				format: (source: string) => source,
				transport: { send: () => Promise.resolve() },
			}),
		).toEqual([]);
		expect(
			problems({ ...valid, auth: accessToken({ accessToken: "a", instanceUrl: "https://x.example.com" }) }),
		).toEqual([]);
	});

	it("requires apiVersion and output and points to init", () => {
		expect(problems({})).toEqual([
			'apiVersion: required, e.g. "v66.0".',
			'output: required, e.g. "src/generated/sobjects.ts".',
			'Run "npx sobjectly init" to create a valid config.',
		]);
		expect(problems({ ...valid, apiVersion: "66.0" })[0]).toBe('apiVersion: must look like "v66.0", got "66.0".');
		expect(problems({ ...valid, output: "types.js" })[0]).toMatch(/output: must be a TypeScript file/);
	});

	it("rejects non-objects", () => {
		expect(problems([])).toEqual([expect.stringMatching(/must be an object/)]);
		expect(problems(null)).toEqual([expect.stringMatching(/must be an object/)]);
	});

	it("reports unknown options, typos in sObject keys and bad values", () => {
		expect(
			problems({
				...valid,
				sobject: ["Account"],
				sobjects: ["Account", "Bad Name"],
				excludeCreateFields: { Acount: ["Name"], Account: "Name" },
				picklists: "unions",
				concurrency: 0,
				continueOnDescribeError: "yes",
			}),
		).toEqual([
			expect.stringMatching(/^sobject: unknown option\. Valid options: output, apiVersion, sobjects/),
			'sobjects[1]: "Bad Name" is not a valid sObject API name.',
			'excludeCreateFields.Acount: "Acount" is not listed in sobjects.',
			'excludeCreateFields.Account: must be an array of field API names, got "Name".',
			'picklists: must be "union" or "string", got "unions".',
			"concurrency: must be a positive integer, got 0.",
			'continueOnDescribeError: must be true or false, got "yes".',
		]);
	});

	it("validates env-based auth", () => {
		expect(problems({ ...valid, auth: { type: "password" } })).toEqual([
			'auth.type: must be one of clientCredentials, accessToken, jwtBearer, sfCli, got "password".',
		]);
		expect(problems({ ...valid, auth: { type: "accessToken", clientIdEnv: "X", instanceUrlEnv: "" } })).toEqual([
			'auth.clientIdEnv: not an option of "accessToken". Valid options: accessTokenEnv, instanceUrlEnv.',
			'auth.instanceUrlEnv: must be a non-empty string, got "".',
		]);
	});

	it("rejects TypeScript-only options in JSON", () => {
		expect(
			problems({ ...valid, auth: { getToken: () => Promise.resolve() }, format: "x", transport: {} }, true),
		).toEqual([
			"auth: auth providers are only supported in a TypeScript config.",
			"format: only supported in a TypeScript config.",
			"transport: only supported in a TypeScript config.",
		]);
	});

	it("strips $schema from the result", () => {
		expect(validateConfig({ $schema: "x.json", ...valid }, { source: "test", json: true })).toEqual(valid);
	});
});

describe("sobjectly.config.schema.json", () => {
	const schema = JSON.parse(readFileSync(join(__dirname, "../../sobjectly.config.schema.json"), "utf8")) as {
		required: string[];
		properties: Record<string, { enum?: string[]; oneOf?: { properties: Record<string, { const?: string }> }[] }>;
	};

	it("covers every JSON-capable option", () => {
		const jsonOptions = CONFIG_OPTIONS.filter((option) => option !== "format" && option !== "transport");
		expect(Object.keys(schema.properties).sort()).toEqual(["$schema", ...jsonOptions].sort());
		expect(schema.required.sort()).toEqual(["apiVersion", "output"]);
		expect(schema.properties.picklists?.enum).toEqual([...PICKLIST_MODES]);
	});

	it("matches the auth options", () => {
		const variants = schema.properties.auth?.oneOf ?? [];
		const fromSchema = Object.fromEntries(
			variants.map((variant) => {
				const { type, ...rest } = variant.properties;
				return [type?.const, Object.keys(rest)];
			}),
		);
		expect(fromSchema).toEqual(AUTH_OPTIONS);
	});
});

describe("validateConfig sobjects", () => {
	it("rejects an empty sobjects list with a clear error", () => {
		expect(problems({ ...valid, sobjects: [] })).toEqual([
			"sobjects: list at least one sObject, or leave it out to generate every queryable sObject.",
		]);
		expect(() => validateConfig({ ...valid, sobjects: [] }, { source: "sobjectly.config.json" })).toThrow(
			/Invalid sobjectly config \(sobjectly\.config\.json\):\n {2}- sobjects: list at least one sObject/,
		);
	});

	it("allows an empty exclude list and a missing sobjects list", () => {
		expect(problems({ ...valid, exclude: [] })).toEqual([]);
		expect(problems({ ...valid, sobjects: undefined })).toEqual([]);
	});

	it("matches excludeCreateFields and excludeUpdateFields keys to sobjects case-insensitively", () => {
		expect(
			problems({
				...valid,
				sobjects: ["Contact", "my_object__c"],
				excludeCreateFields: { contact: ["LastName"] },
				excludeUpdateFields: { My_Object__c: ["Field__c"] },
			}),
		).toEqual([]);
		expect(problems({ ...valid, sobjects: ["Contact"], excludeCreateFields: { Contacts: ["LastName"] } })).toEqual([
			'excludeCreateFields.Contacts: "Contacts" is not listed in sobjects.',
		]);
	});
});
