import { isApiVersion } from "../api-version";

import type { CodegenConfig, EnvAuth } from "./config";

/** Thrown when a codegen config is invalid. Lists every problem found. */
export class CodegenConfigError extends Error {
	override readonly name: string = "CodegenConfigError";

	constructor(
		readonly source: string,
		readonly problems: string[],
	) {
		super(`Invalid sobjectly config (${source}):\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
	}
}

/** The env-variable options each env-based auth type accepts. */
export const AUTH_OPTIONS: Record<EnvAuth["type"], readonly string[]> = {
	clientCredentials: ["loginUrlEnv", "clientIdEnv", "clientSecretEnv"],
	accessToken: ["accessTokenEnv", "instanceUrlEnv"],
	jwtBearer: ["loginUrlEnv", "clientIdEnv", "usernameEnv", "privateKeyEnv", "privateKeyPathEnv"],
	sfCli: ["targetOrg"],
};

export const PICKLIST_MODES = ["union", "string", "const", "enum"] as const;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

interface Context {
	config: Record<string, unknown>;
	json: boolean;
	problem: (message: string) => void;
}

type Validator = (value: unknown, context: Context) => void;

const VALIDATORS: Record<string, Validator> = {
	$schema: (value, { problem }) => {
		if (typeof value !== "string") {
			problem("$schema: must be a string.");
		}
	},
	output: (value, { problem }) => {
		if (value === undefined) {
			problem('output: required, e.g. "src/generated/sobjects.ts".');
		} else if (typeof value !== "string" || !/\.(ts|mts|cts)$/.test(value)) {
			problem(`output: must be a TypeScript file path such as "src/generated/sobjects.ts", got ${show(value)}.`);
		}
	},
	apiVersion: (value, { problem }) => {
		if (value === undefined || value === "") {
			problem('apiVersion: required, e.g. "v66.0".');
		} else if (!isApiVersion(value)) {
			problem(`apiVersion: must look like "v66.0", got ${show(value)}.`);
		}
	},
	sobjects: (value, { problem }) => validateNames("sobjects", value, problem),
	exclude: (value, { problem }) => validateNames("exclude", value, problem),
	auth: validateAuth,
	excludeCreateFields: (value, context) => validateFieldMap("excludeCreateFields", value, context),
	excludeUpdateFields: (value, context) => validateFieldMap("excludeUpdateFields", value, context),
	picklists: (value, { problem }) => {
		if (!PICKLIST_MODES.includes(value as (typeof PICKLIST_MODES)[number])) {
			problem(`picklists: must be one of ${PICKLIST_MODES.join(", ")}, got ${show(value)}.`);
		}
	},
	constants: (value, { problem }) => {
		if (typeof value !== "boolean") {
			problem(`constants: must be true or false, got ${show(value)}.`);
		}
	},
	concurrency: (value, { problem }) => {
		if (!Number.isInteger(value) || (value as number) < 1) {
			problem(`concurrency: must be a positive integer, got ${show(value)}.`);
		}
	},
	continueOnDescribeError: (value, { problem }) => {
		if (typeof value !== "boolean") {
			problem(`continueOnDescribeError: must be true or false, got ${show(value)}.`);
		}
	},
	importSource: (value, { problem }) => {
		if (typeof value !== "string" || value.length === 0) {
			problem(`importSource: must be a non-empty string, got ${show(value)}.`);
		}
	},
	format: (value, { problem, json }) => {
		if (json) {
			problem("format: only supported in a TypeScript config.");
		} else if (typeof value !== "function") {
			problem("format: must be a function (source, filePath) => string.");
		}
	},
	transport: (value, { problem, json }) => {
		if (json) {
			problem("transport: only supported in a TypeScript config.");
		} else if (typeof (value as { send?: unknown } | null)?.send !== "function") {
			problem("transport: must be an HttpTransport (an object with a send() method).");
		}
	},
};

/** The options a config may contain. */
export const CONFIG_OPTIONS: readonly string[] = Object.keys(VALIDATORS).filter((key) => key !== "$schema");

/**
 * Checks a loaded config and returns it typed. Throws a `CodegenConfigError` listing every
 * problem. `json` disallows the options that only a TypeScript config can express.
 */
export function validateConfig(value: unknown, options: { source: string; json?: boolean }): CodegenConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodegenConfigError(options.source, [
			"the config must be an object (export default defineConfig({ ... }) or a JSON object).",
		]);
	}
	const problems: string[] = [];
	const context: Context = {
		config: value as Record<string, unknown>,
		json: options.json ?? false,
		problem: (message) => problems.push(message),
	};
	for (const required of ["apiVersion", "output"]) {
		if (!(required in value)) {
			VALIDATORS[required]?.(undefined, context);
		}
	}
	for (const [key, option] of Object.entries(value)) {
		const validate = VALIDATORS[key];
		if (!validate) {
			problems.push(`${key}: unknown option. Valid options: ${CONFIG_OPTIONS.join(", ")}.`);
		} else if (option !== undefined || key === "apiVersion" || key === "output") {
			validate(option, context);
		}
	}
	if (problems.length > 0) {
		if (problems.some((problem) => problem.startsWith("apiVersion") || problem.startsWith("output"))) {
			problems.push('Run "npx sobjectly init" to create a valid config.');
		}
		throw new CodegenConfigError(options.source, problems);
	}
	const { $schema: _schema, ...config } = value as Record<string, unknown>;
	return config as unknown as CodegenConfig;
}

function validateNames(key: string, value: unknown, problem: (message: string) => void): void {
	if (!Array.isArray(value)) {
		problem(`${key}: must be an array of sObject API names, got ${show(value)}.`);
		return;
	}
	if (key === "sobjects" && value.length === 0) {
		problem("sobjects: list at least one sObject, or leave it out to generate every queryable sObject.");
	}
	value.forEach((name, index) => {
		if (typeof name !== "string" || !IDENTIFIER.test(name)) {
			problem(`${key}[${index}]: ${show(name)} is not a valid sObject API name.`);
		}
	});
}

function validateFieldMap(key: string, value: unknown, { config, problem }: Context): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problem(`${key}: must be an object like { "Account": ["FieldName"] }, got ${show(value)}.`);
		return;
	}
	// sObject names are case-insensitive; the generator looks these keys up the same way.
	const listed = Array.isArray(config.sobjects)
		? new Set((config.sobjects as unknown[]).map((name) => (typeof name === "string" ? name.toLowerCase() : name)))
		: undefined;
	for (const [sobject, fields] of Object.entries(value)) {
		if (listed && !listed.has(sobject.toLowerCase())) {
			problem(`${key}.${sobject}: "${sobject}" is not listed in sobjects.`);
		}
		if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string" || field.length === 0)) {
			problem(`${key}.${sobject}: must be an array of field API names, got ${show(fields)}.`);
		}
	}
}

function validateAuth(value: unknown, { json, problem }: Context): void {
	if (typeof value !== "object" || value === null) {
		problem(`auth: must be an object like { "type": "clientCredentials" }, got ${show(value)}.`);
		return;
	}
	if (typeof (value as { getToken?: unknown }).getToken === "function") {
		if (json) {
			problem("auth: auth providers are only supported in a TypeScript config.");
		}
		return;
	}
	const { type, ...rest } = value as Record<string, unknown>;
	const allowed = AUTH_OPTIONS[type as EnvAuth["type"]] as readonly string[] | undefined;
	if (!allowed) {
		problem(`auth.type: must be one of ${Object.keys(AUTH_OPTIONS).join(", ")}, got ${show(type)}.`);
		return;
	}
	for (const [key, option] of Object.entries(rest)) {
		if (!allowed.includes(key)) {
			problem(`auth.${key}: not an option of "${String(type)}". Valid options: ${allowed.join(", ")}.`);
		} else if (typeof option !== "string" || option.length === 0) {
			problem(`auth.${key}: must be a non-empty string, got ${show(option)}.`);
		}
	}
}

function show(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "function") {
		return "a function";
	}
	try {
		return JSON.stringify(value) ?? typeof value;
	} catch {
		return typeof value;
	}
}
