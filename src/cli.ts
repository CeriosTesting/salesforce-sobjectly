#!/usr/bin/env node
/* oxlint-disable no-console */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { normalizeApiVersion } from "./api-version";
import { checkGenerated, findConfigFiles, generate, loadConfig } from "./codegen/index";
import { type InitAnswers, parseSObjects, runInit } from "./codegen/init";
import { readlinePrompter } from "./codegen/prompter";

const HELP = `Usage: sobjectly <command> [options]

Commands:
  init        Create a sobjectly.config file by answering a few questions
  generate    Generate TypeScript types for Salesforce sObjects (default)

Options for generate:
  -c, --config <path>       Config file (default: sobjectly.config.ts or sobjectly.config.json)
  -e, --env-file <path>     Load environment variables from a .env file first
      --check               Don't write; exit with 1 when the generated file is out of date
                            (formatting-only differences don't count)
      --stdout              Print the generated source instead of writing it

Options for init (skip the matching questions; useful in scripts):
      --api-version <v>     Salesforce API version, e.g. v66.0
      --output <path>       Generated types file, e.g. src/generated/sobjects.ts
      --sobjects <list>     Comma-separated sObject API names
      --auth <type>         clientCredentials | sfCli | accessToken | jwtBearer
      --target-org <alias>  Salesforce CLI org alias (with --auth sfCli)
      --picklists <mode>    union | string
      --format <format>     ts | json
  -y, --yes                 Use the suggested answer for every other question (needs --api-version)
  -f, --force               Replace an existing config without asking

  -h, --help                Show this help
`;

const options = {
	config: { type: "string", short: "c" },
	"env-file": { type: "string", short: "e" },
	"api-version": { type: "string" },
	output: { type: "string" },
	sobjects: { type: "string" },
	auth: { type: "string" },
	picklists: { type: "string" },
	format: { type: "string" },
	check: { type: "boolean" },
	stdout: { type: "boolean" },
	"target-org": { type: "string" },
	yes: { type: "boolean", short: "y" },
	force: { type: "boolean", short: "f" },
	help: { type: "boolean", short: "h" },
} as const;

interface Values {
	config?: string;
	"env-file"?: string;
	"api-version"?: string;
	output?: string;
	sobjects?: string;
	auth?: string;
	picklists?: string;
	format?: string;
	check?: boolean;
	stdout?: boolean;
	"target-org"?: string;
	yes?: boolean;
	force?: boolean;
	help?: boolean;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options });
	const command = positionals[0] ?? "generate";
	if (values.help) {
		console.log(HELP);
		return 0;
	}
	if (command === "init") {
		return init(values);
	}
	if (command === "generate") {
		return runGenerate(values);
	}
	console.error(`Unknown command "${command}".\n\n${HELP}`);
	return 1;
}

async function init(values: Values): Promise<number> {
	const preset = initPreset(values);
	const prompter = readlinePrompter();
	try {
		await runInit({
			cwd: process.cwd(),
			prompter,
			log: (message) => console.log(message),
			preset,
			yes: values.yes,
			force: values.force,
		});
		return 0;
	} finally {
		prompter.close();
	}
}

function initPreset(values: Values): Partial<InitAnswers> {
	const preset: Partial<InitAnswers> = {};
	if (values["api-version"] !== undefined) {
		const apiVersion = normalizeApiVersion(values["api-version"]);
		if (!apiVersion) {
			throw new Error(`Invalid --api-version "${values["api-version"]}". Expected a value like v66.0.`);
		}
		preset.apiVersion = apiVersion;
	}
	if (values.output !== undefined) {
		preset.output = values.output;
	}
	if (values.sobjects !== undefined) {
		preset.sobjects = parseSObjects(values.sobjects);
	}
	const auth = oneOf("--auth", values.auth, ["clientCredentials", "sfCli", "accessToken", "jwtBearer"] as const);
	if (values["target-org"] !== undefined) {
		preset.targetOrg = values["target-org"];
	}
	const picklists = oneOf("--picklists", values.picklists, ["union", "string"] as const);
	const format = oneOf("--format", values.format, ["ts", "json"] as const);
	return { ...preset, ...(auth && { auth }), ...(picklists && { picklists }), ...(format && { format }) };
}

function oneOf<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
	if (value === undefined) {
		return undefined;
	}
	const match = allowed.find((item) => item === value);
	if (!match) {
		throw new Error(`Invalid ${flag} "${value}". Expected one of: ${allowed.join(", ")}.`);
	}
	return match;
}

async function runGenerate(values: Values): Promise<number> {
	if (values["env-file"]) {
		const envFile = resolve(values["env-file"]);
		if (!existsSync(envFile)) {
			console.error(`Env file not found: ${envFile}`);
			return 1;
		}
		process.loadEnvFile(envFile);
	}
	const found = findConfigFiles();
	if (!values.config && found.length > 1) {
		console.warn(`warning: found ${found.join(" and ")}; using ${found[0]}. Remove the other one.`);
	}
	const configPath = values.config ? resolve(values.config) : found[0];
	if (!configPath) {
		console.error('No sobjectly config file found. Run "npx sobjectly init" to create one, or pass --config.');
		return 1;
	}
	const { config, directory } = await loadConfig(configPath);
	// With --stdout the source goes to stdout, so progress goes to stderr.
	const log = values.stdout
		? (message: string): void => console.error(message)
		: (message: string): void => console.log(message);
	const logger = { info: log, warn: (message: string): void => console.warn(`warning: ${message}`) };
	if (values.check) {
		return reportCheck(await checkGenerated(config, { cwd: directory, logger }));
	}
	const result = await generate(config, { cwd: directory, logger, write: !values.stdout });
	if (values.stdout) {
		process.stdout.write(result.source);
	}
	if (result.skipped.length > 0) {
		console.warn(`Skipped ${result.skipped.length} sObject(s): ${result.skipped.map((item) => item.name).join(", ")}`);
	}
	return 0;
}

function reportCheck(result: Awaited<ReturnType<typeof checkGenerated>>): number {
	if (result.upToDate) {
		console.log(`${result.outputPath} is up to date.`);
		return 0;
	}
	if (result.reason === "missing") {
		console.error(`${result.outputPath} does not exist. Run "sobjectly generate".`);
		return 1;
	}
	const details = [
		result.added.length > 0 ? `added: ${result.added.join(", ")}` : "",
		result.removed.length > 0 ? `removed: ${result.removed.join(", ")}` : "",
		result.changed.length > 0 ? `changed: ${result.changed.join(", ")}` : "",
	].filter((detail) => detail.length > 0);
	console.error(
		`${result.outputPath} is out of date${details.length > 0 ? ` (${details.join("; ")})` : ""}. Run "sobjectly generate".`,
	);
	return 1;
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
