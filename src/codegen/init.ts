import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { normalizeApiVersion } from "../api-version";
import type { ApiVersion } from "../types/common";

import type { PicklistMode } from "./config";
import { findConfigFiles } from "./load-config";
import type { Choice, Prompter } from "./prompter";

export type InitAuthType = "clientCredentials" | "accessToken" | "jwtBearer" | "sfCli";
export type InitConfigFormat = "ts" | "json";

export interface InitAnswers {
	apiVersion: ApiVersion;
	output: string;
	sobjects: string[];
	auth: InitAuthType;
	/** The Salesforce CLI org alias, for `auth: "sfCli"`. Omitted means the CLI's default org. */
	targetOrg?: string;
	picklists: PicklistMode;
	format: InitConfigFormat;
}

export interface InitOptions {
	cwd: string;
	prompter: Prompter;
	log: (message: string) => void;
	/** Answers given up front (e.g. CLI flags); those questions are skipped. */
	preset?: Partial<InitAnswers>;
	/** Accept the suggested answer for every question not in `preset`. `apiVersion` must then be preset. */
	yes?: boolean;
	/** Overwrite an existing config without asking. */
	force?: boolean;
}

export interface InitResult {
	/** `undefined` when the user chose not to overwrite an existing config. */
	configPath: string | undefined;
	answers?: InitAnswers;
	envExampleUpdated?: boolean;
	scriptAdded?: boolean;
}

const SOBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const NPM_SCRIPT = "sobjects:generate";

/** The environment variables each auth type reads by default. */
export const AUTH_ENV_VARS: Record<InitAuthType, string[]> = {
	clientCredentials: ["SF_LOGIN_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET"],
	accessToken: ["SF_ACCESS_TOKEN", "SF_INSTANCE_URL"],
	jwtBearer: ["SF_LOGIN_URL", "SF_CLIENT_ID", "SF_USERNAME", "SF_PRIVATE_KEY_PATH"],
	sfCli: [],
};

const AUTH_CHOICES: Choice<InitAuthType>[] = [
	{ value: "clientCredentials", label: "Client credentials (recommended for CI and test automation)" },
	{ value: "sfCli", label: "Salesforce CLI org (recommended for local development; no secrets needed)" },
	{ value: "accessToken", label: "Access token (e.g. from `sf org display`)" },
	{ value: "jwtBearer", label: "JWT bearer (certificate-based, runs as a user)" },
];

const PICKLIST_CHOICES: Choice<PicklistMode>[] = [
	{ value: "union", label: 'Union of values, e.g. "New" | "Closed" (type-safe)' },
	{ value: "string", label: "Plain string" },
	{ value: "const", label: "Union plus a named constant per picklist, e.g. CaseStatus.Closed" },
	{ value: "enum", label: "TypeScript enum per picklist (restricted picklists only accept enum members)" },
];

const FORMAT_CHOICES: Choice<InitConfigFormat>[] = [
	{ value: "ts", label: "TypeScript (sobjectly.config.ts, type-checked with defineConfig)" },
	{ value: "json", label: "JSON (sobjectly.config.json, validated with a JSON Schema)" },
];

/**
 * Creates a `sobjectly.config` file by asking for the API version, output path, sObjects, auth
 * method, picklist mode and file format. Optionally adds the auth variables to `.env.example`
 * and an npm script to `package.json`.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
	const { cwd, prompter, log } = options;
	const existing = findConfigFiles(cwd);
	if (existing.length > 0 && !options.force) {
		const names = existing.map((path) => relative(cwd, path)).join(" and ");
		const overwrite = options.yes ? false : await prompter.confirm(`${names} already exists. Replace it?`, false);
		if (!overwrite) {
			log(`Kept the existing ${names}.`);
			return { configPath: undefined };
		}
	}

	validatePreset(options.preset ?? {});
	const answers = await askQuestions(options);
	const configPath = join(cwd, `sobjectly.config.${answers.format}`);
	// Only one config may exist, otherwise the lookup order would silently pick one.
	for (const path of existing.filter((path) => path !== configPath)) {
		rmSync(path);
		log(`Removed ${relative(cwd, path)}`);
	}
	writeFileSync(configPath, renderConfig(answers), "utf8");
	log(`\nCreated ${relative(cwd, configPath)}`);

	const envExampleUpdated = await maybeUpdateEnvExample(options, answers.auth);
	const scriptAdded = await maybeAddScript(options);
	printNextSteps(log, answers, scriptAdded, cwd);
	return { configPath, answers, envExampleUpdated, scriptAdded };
}

async function askQuestions(options: InitOptions): Promise<InitAnswers> {
	const { prompter, preset = {}, yes } = options;
	const apiVersion = preset.apiVersion ?? (await askApiVersion(prompter, yes));
	const output =
		preset.output ??
		(yes
			? "src/generated/sobjects.ts"
			: await prompter.ask("Where should the generated types be written?", {
					defaultValue: "src/generated/sobjects.ts",
					validate: validateOutput,
				}));
	const sobjects = preset.sobjects ?? (await askSObjects(prompter, yes));
	const auth =
		preset.auth ??
		(yes
			? "clientCredentials"
			: await prompter.choose("How should the generator log in to Salesforce?", AUTH_CHOICES, "clientCredentials"));
	const targetOrg = auth === "sfCli" ? (preset.targetOrg ?? (await askTargetOrg(prompter, yes))) : undefined;
	const picklists =
		preset.picklists ??
		(yes ? "union" : await prompter.choose("How should picklist fields be typed?", PICKLIST_CHOICES, "union"));
	const format =
		preset.format ?? (yes ? "ts" : await prompter.choose("Which config file format?", FORMAT_CHOICES, "ts"));
	return { apiVersion, output, sobjects, auth, ...(targetOrg ? { targetOrg } : {}), picklists, format };
}

async function askTargetOrg(prompter: Prompter, yes: boolean | undefined): Promise<string | undefined> {
	if (yes) {
		return undefined;
	}
	const answer = await prompter.ask("Which Salesforce CLI org alias? Leave empty to use the CLI's default org", {
		validate: (value) => (value === "" || /^[\w.@+-]+$/.test(value) ? undefined : "Enter an org alias or username."),
	});
	return answer === "" ? undefined : answer;
}

async function askApiVersion(prompter: Prompter, yes: boolean | undefined): Promise<ApiVersion> {
	if (yes) {
		throw new Error("An API version is required: pass --api-version (e.g. --api-version v66.0).");
	}
	const answer = await prompter.ask(
		"Which Salesforce API version should be used? (e.g. v66.0; your org lists them at https://<my-domain>.my.salesforce.com/services/data/)",
		{ validate: (value) => (normalizeApiVersion(value) ? undefined : 'Enter a version like "v66.0" or "66".') },
	);
	return normalizeApiVersion(answer) as ApiVersion;
}

async function askSObjects(prompter: Prompter, yes: boolean | undefined): Promise<string[]> {
	const defaultValue = "Account, Contact";
	const answer = yes
		? defaultValue
		: await prompter.ask("Which sObjects do you want types for? Use comma-separated API names", {
				defaultValue,
				validate: validateSObjects,
			});
	return parseSObjects(answer);
}

/** Splits a comma/space separated list of sObject names, removing duplicates. */
export function parseSObjects(answer: string): string[] {
	return [...new Set(answer.split(/[\s,]+/).filter((name) => name.length > 0))];
}

function validateSObjects(answer: string): string | undefined {
	return validateSObjectNames(parseSObjects(answer));
}

function validateSObjectNames(names: readonly string[]): string | undefined {
	if (names.length === 0) {
		return "Enter at least one sObject, e.g. Account.";
	}
	const invalid = names.filter((name) => !SOBJECT_NAME.test(name));
	return invalid.length > 0 ? `Not a valid sObject API name: ${invalid.join(", ")}` : undefined;
}

/** Answers given as flags get the same checks as typed answers. */
function validatePreset(preset: Partial<InitAnswers>): void {
	const errors = [
		// Check the names as given: joining and re-splitting would let "Bad Name" pass as two names.
		preset.sobjects === undefined ? undefined : validateSObjectNames(preset.sobjects),
		preset.output === undefined ? undefined : validateOutput(preset.output),
		preset.targetOrg === undefined || /^[\w.@+-]+$/.test(preset.targetOrg)
			? undefined
			: `Invalid org alias "${preset.targetOrg}".`,
	].filter((error): error is string => error !== undefined);
	if (errors.length > 0) {
		throw new Error(errors.join(" "));
	}
}

function validateOutput(answer: string): string | undefined {
	return /\.(ts|mts|cts)$/.test(answer)
		? undefined
		: "The output must be a TypeScript file, e.g. src/generated/sobjects.ts.";
}

/** The `$schema` reference written into `sobjectly.config.json`. */
export const JSON_SCHEMA_REFERENCE = "./node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json";

/** Renders the config file in the chosen format. */
export function renderConfig(answers: InitAnswers): string {
	return answers.format === "json" ? renderJsonConfig(answers) : renderTypeScriptConfig(answers);
}

function renderJsonConfig(answers: InitAnswers): string {
	const config = {
		$schema: JSON_SCHEMA_REFERENCE,
		apiVersion: answers.apiVersion,
		output: answers.output,
		sobjects: answers.sobjects,
		auth: authSetting(answers),
		picklists: answers.picklists,
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

function renderTypeScriptConfig(answers: InitAnswers): string {
	const envVars = AUTH_ENV_VARS[answers.auth];
	const sobjects = answers.sobjects.map((name) => JSON.stringify(name)).join(", ");
	return [
		'import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";',
		"",
		"export default defineConfig({",
		"\t// The Salesforce REST API version. The generated file exports it as API_VERSION for the client.",
		`\tapiVersion: ${JSON.stringify(answers.apiVersion)},`,
		"\t// Where the generated types are written, relative to this file.",
		`\toutput: ${JSON.stringify(answers.output)},`,
		"\t// The sObjects to generate types for.",
		`\tsobjects: [${sobjects}],`,
		`\t// ${authComment(answers.auth, envVars)}`,
		`\tauth: ${renderAuth(answers)},`,
		`\tpicklists: ${JSON.stringify(answers.picklists)},`,
		"});",
		"",
	].join("\n");
}

function authSetting(answers: InitAnswers): { type: InitAuthType; targetOrg?: string } {
	return answers.auth === "sfCli" && answers.targetOrg
		? { type: "sfCli", targetOrg: answers.targetOrg }
		: { type: answers.auth };
}

function renderAuth(answers: InitAnswers): string {
	const setting = authSetting(answers);
	const targetOrg = setting.targetOrg ? `, targetOrg: ${JSON.stringify(setting.targetOrg)}` : "";
	return `{ type: ${JSON.stringify(setting.type)}${targetOrg} }`;
}

function authComment(auth: InitAuthType, envVars: readonly string[]): string {
	return auth === "sfCli"
		? "Uses an org you are logged into with the Salesforce CLI (sf org login web)."
		: `Reads ${formatList(envVars)} from the environment.`;
}

async function maybeUpdateEnvExample(options: InitOptions, auth: InitAuthType): Promise<boolean> {
	const path = join(options.cwd, ".env.example");
	const content = existsSync(path) ? readFileSync(path, "utf8") : "";
	const missing = AUTH_ENV_VARS[auth].filter((name) => !new RegExp(`^${name}=`, "m").test(content));
	if (missing.length === 0) {
		return false;
	}
	const add =
		options.yes === true || (await options.prompter.confirm(`Add ${formatList(missing)} to .env.example?`, true));
	if (!add) {
		return false;
	}
	const block = ["# Salesforce credentials for `sobjectly generate`", ...missing.map((name) => `${name}=`)].join("\n");
	const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${content}${separator}${block}\n`, "utf8");
	options.log("Updated .env.example");
	return true;
}

async function maybeAddScript(options: InitOptions): Promise<boolean> {
	const path = join(options.cwd, "package.json");
	if (!existsSync(path)) {
		return false;
	}
	const raw = readFileSync(path, "utf8");
	const bom = raw.startsWith("﻿") ? "﻿" : "";
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(raw.slice(bom.length)) as { scripts?: Record<string, string> };
	} catch {
		options.log(`Skipped adding the "${NPM_SCRIPT}" script: package.json is not valid JSON.`);
		return false;
	}
	if (pkg.scripts?.[NPM_SCRIPT]) {
		return false;
	}
	const add = options.yes === true || (await options.prompter.confirm(`Add an npm script "${NPM_SCRIPT}"?`, true));
	if (!add) {
		return false;
	}
	pkg.scripts = { ...pkg.scripts, [NPM_SCRIPT]: "sobjectly generate" };
	const indent = /^[ \t]+/m.exec(raw)?.[0] ?? "\t";
	const newline = raw.includes("\r\n") ? "\r\n" : "\n";
	const json = JSON.stringify(pkg, null, indent).replace(/\n/g, newline);
	writeFileSync(path, `${bom}${json}${newline}`, "utf8");
	options.log(`Added the "${NPM_SCRIPT}" script to package.json`);
	return true;
}

function printNextSteps(log: (message: string) => void, answers: InitAnswers, scriptAdded: boolean, cwd: string): void {
	const cli = answers.auth === "sfCli";
	const envFile = cli ? "" : " --env-file .env";
	const command = scriptAdded
		? `npm run ${NPM_SCRIPT}${envFile ? ` --${envFile}` : ""}`
		: `npx sobjectly generate${envFile}`;
	const gitignore = join(cwd, ".gitignore");
	const envIgnored = existsSync(gitignore) && /^\.env\b/m.test(readFileSync(gitignore, "utf8"));
	const firstStep = cli
		? `  1. Log in with the Salesforce CLI: sf org login web${answers.targetOrg ? ` --alias ${answers.targetOrg}` : " --set-default"}`
		: `  1. Put ${formatList(AUTH_ENV_VARS[answers.auth])} in a .env file${envIgnored ? "" : " (and add .env to .gitignore)"}.`;
	log(
		[
			"",
			"Next steps:",
			firstStep,
			`  2. Generate the types: ${command}`,
			"  3. Use them:",
			`       import { API_VERSION, type SObjectRegistry } from "./${answers.output.replace(/\.(ts|mts|cts)$/, "")}";`,
			"       const sf = new SalesforceClient<SObjectRegistry>({ apiVersion: API_VERSION, auth });",
		].join("\n"),
	);
}

function formatList(items: readonly string[]): string {
	if (items.length <= 1) {
		return items.join("");
	}
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
