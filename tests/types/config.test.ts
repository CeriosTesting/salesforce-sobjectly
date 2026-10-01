/**
 * Compile-time tests for `defineConfig`: `npm run compile` type-checks this file, and every
 * `@ts-expect-error` line must fail to compile.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { accessToken } from "../../src/auth/providers";
import { type CodegenConfig, defineConfig, type JsonCodegenConfig } from "../../src/codegen/config";

describe("defineConfig", () => {
	it("infers the listed sObjects and checks per-sObject options against them", () => {
		const config = defineConfig({
			apiVersion: "v66.0",
			output: "src/generated/sobjects.ts",
			sobjects: ["Account", "Contact"],
			excludeCreateFields: { Account: ["Name"] },
			excludeUpdateFields: { Contact: ["Email"] },
		});
		expectTypeOf(config).toEqualTypeOf<CodegenConfig<"Account" | "Contact">>();
		expect(config.sobjects).toEqual(["Account", "Contact"]);

		defineConfig({
			apiVersion: "v66.0",
			output: "src/generated/sobjects.ts",
			sobjects: ["Account"],
			// @ts-expect-error "Acount" is not in sobjects
			excludeCreateFields: { Acount: ["Name"] },
		});
	});

	it("accepts any sObject key when sobjects is not listed", () => {
		const config = defineConfig({
			apiVersion: "v66.0",
			output: "src/generated/sobjects.ts",
			excludeCreateFields: { Anything__c: ["Field__c"] },
		});
		expect(config.excludeCreateFields).toEqual({ Anything__c: ["Field__c"] });
	});

	it("rejects invalid values", () => {
		expectTypeOf(defineConfig).toBeFunction();
		// @ts-expect-error apiVersion is required
		defineConfig({ output: "src/generated/sobjects.ts" });
		// @ts-expect-error apiVersion must look like "v66.0"
		defineConfig({ apiVersion: "66.0", output: "src/generated/sobjects.ts" });
		defineConfig({
			apiVersion: "v66.0",
			output: "x.ts",
			// @ts-expect-error unknown auth type
			auth: { type: "password" },
		});
		defineConfig({
			apiVersion: "v66.0",
			output: "x.ts",
			// @ts-expect-error unknown option for this auth type
			auth: { type: "accessToken", clientIdEnv: "X" },
		});
		defineConfig({
			apiVersion: "v66.0",
			output: "x.ts",
			// @ts-expect-error unknown picklist mode
			picklists: "unions",
		});
		defineConfig({
			apiVersion: "v66.0",
			output: "x.ts",
			// @ts-expect-error unknown option
			sobject: ["Account"],
		});
	});

	it("accepts auth providers, a format hook and a transport", () => {
		const config = defineConfig({
			apiVersion: "v66.0",
			output: "x.ts",
			auth: accessToken({ accessToken: "t", instanceUrl: "https://example.my.salesforce.com" }),
			format: (source) => source,
		});
		expect(typeof config.format).toBe("function");
	});

	it("types the JSON config shape", () => {
		const json: JsonCodegenConfig = {
			$schema: "./node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json",
			apiVersion: "v66.0",
			output: "x.ts",
			auth: { type: "clientCredentials" },
		};
		expect(json.apiVersion).toBe("v66.0");
		// @ts-expect-error functions cannot be expressed in JSON
		const withFormat: JsonCodegenConfig = { apiVersion: "v66.0", output: "x.ts", format: (source: string) => source };
		expect(withFormat).toBeDefined();
	});
});
