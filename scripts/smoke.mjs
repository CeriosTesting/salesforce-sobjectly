// Packs the package, installs the tarball into a temporary consumer project and checks that
// every entry point loads from CommonJS and ESM, that the types compile for a consumer, and
// that the CLI starts. Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "sobjectly-smoke-"));
const isWindows = process.platform === "win32";

function run(command, args, cwd) {
	console.log(`$ ${command} ${args.join(" ")}`);
	// npm is a .cmd shim on Windows and needs a shell; everything else runs directly.
	const useShell = isWindows && command === "npm";
	const output = execFileSync(useShell ? `npm ${args.join(" ")}` : command, useShell ? [] : args, {
		cwd,
		stdio: ["ignore", "pipe", "inherit"],
		encoding: "utf8",
		shell: useShell,
	});
	if (command === "node" && output.trim()) {
		console.log(output.trim());
	}
	return output;
}

try {
	run("npm", ["pack", "--pack-destination", work], root);
	const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
	if (!tarball) {
		throw new Error("npm pack produced no tarball");
	}

	const consumer = join(work, "consumer");
	mkdirSync(consumer);
	writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "0.0.0" }));
	run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(work, tarball)], consumer);

	const fakeTransport = `{
	async send(request) {
		const body = request.url.pathname.endsWith("/query")
			? { totalSize: 1, done: true, records: [{ attributes: { type: "Account" }, Id: "001" }] }
			: {};
		return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new TextEncoder().encode(JSON.stringify(body)) };
	},
}`;

	writeFileSync(
		join(consumer, "check.cjs"),
		`const assert = require("node:assert");
const core = require("@cerios/salesforce-sobjectly");
const { defineConfig, generateSource } = require("@cerios/salesforce-sobjectly/codegen");
assert.equal(typeof defineConfig, "function");
assert.equal(typeof generateSource, "function");
const sf = new core.SalesforceClient({
	apiVersion: "v66.0",
	auth: core.accessToken({ accessToken: "t", instanceUrl: "https://example.my.salesforce.com" }),
	transport: ${fakeTransport},
});
sf.query(sf.soql("Account").select("Id")).then(page => {
	assert.equal(page.records[0].Id, "001");
	console.log("cjs ok");
});
`,
	);
	writeFileSync(
		join(consumer, "check.mjs"),
		`import assert from "node:assert";
import { SalesforceClient, accessToken, soqlEscape } from "@cerios/salesforce-sobjectly";
import { generate } from "@cerios/salesforce-sobjectly/codegen";
assert.equal(typeof generate, "function");
assert.equal(soqlEscape("O'Brien"), "'O\\\\'Brien'");
const sf = new SalesforceClient({
	apiVersion: "v66.0",
	auth: accessToken({ accessToken: "t", instanceUrl: "https://example.my.salesforce.com" }),
	transport: ${fakeTransport},
});
const page = await sf.query("SELECT Id FROM Account");
assert.equal(page.records[0].Id, "001");
console.log("esm ok");
`,
	);
	writeFileSync(
		join(consumer, "typed.ts"),
		`import { SalesforceClient, accessToken, type HttpTransport, type SalesforceAddress } from "@cerios/salesforce-sobjectly";
import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";

interface Account { Id: string; Name: string; Phone: string | null; BillingAddress: SalesforceAddress | null }
interface SObjectRegistry {
	Account: {
		read: Account;
		create: Pick<Account, "Name"> & Partial<Pick<Account, "Phone">>;
		update: Partial<Pick<Account, "Name" | "Phone">>;
		parents: Record<never, never>;
		children: Record<never, never>;
	};
}

declare const transport: HttpTransport;
const sf = new SalesforceClient<SObjectRegistry>({
	apiVersion: "v66.0",
	auth: accessToken({ accessToken: "t", instanceUrl: "https://example.my.salesforce.com" }),
	transport,
});

export async function run(): Promise<string> {
	const id = await sf.sobject("Account").create({ Name: "Acme" });
	const page = await sf.query(sf.soql("Account").select("Id", "Name"));
	// @ts-expect-error Phone was not selected
	void page.records[0]?.Phone;
	return id + (page.records[0]?.Name ?? "");
}

export default defineConfig({ apiVersion: "v66.0", output: "generated.ts", sobjects: ["Account"] });
`,
	);
	writeFileSync(
		join(consumer, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "es2022",
				module: "nodenext",
				moduleResolution: "nodenext",
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				types: ["node"],
				typeRoots: [join(root, "node_modules/@types")],
			},
			files: ["typed.ts"],
		}),
	);

	run("node", ["check.cjs"], consumer);
	run("node", ["check.mjs"], consumer);
	run("node", [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
	const cli = join(consumer, "node_modules/@cerios/salesforce-sobjectly/dist/cli.cjs");
	const help = run("node", [cli, "--help"], consumer);
	if (!help.includes("sobjectly <command>")) {
		throw new Error("CLI help output is unexpected");
	}
	run("node", [cli, "init", "--yes", "--api-version", "66", "--sobjects", "Account,Case"], consumer);
	writeFileSync(
		join(consumer, "check-config.mjs"),
		`import assert from "node:assert";
import { loadConfig } from "@cerios/salesforce-sobjectly/codegen";
const { config } = await loadConfig("sobjectly.config.ts");
assert.equal(config.apiVersion, "v66.0");
assert.deepEqual(config.sobjects, ["Account", "Case"]);
console.log("init ok");
`,
	);
	run("node", ["check-config.mjs"], consumer);
	run("node", [cli, "init", "--yes", "--force", "--format", "json", "--api-version", "v67.0"], consumer);
	writeFileSync(
		join(consumer, "check-json-config.mjs"),
		`import assert from "node:assert";
import { existsSync } from "node:fs";
import { loadConfig } from "@cerios/salesforce-sobjectly/codegen";
const { config } = await loadConfig("sobjectly.config.json");
assert.equal(config.apiVersion, "v67.0");
assert.ok(existsSync("node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json"), "schema is shipped");
console.log("json init ok");
`,
	);
	run("node", ["check-json-config.mjs"], consumer);
	console.log("smoke test passed");
} finally {
	rmSync(work, { recursive: true, force: true });
}
