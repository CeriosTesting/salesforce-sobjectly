import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { accessToken, clientCredentials, jwtBearer } from "../auth/providers";
import { sfCli } from "../auth/sf-cli";
import type { AuthProvider } from "../auth/types";
import { SalesforceClient } from "../client";
import type { ApiVersion } from "../types/common";
import type { DescribeSObjectResult } from "../types/describe";

import type { AuthSetting, CodegenAuth, CodegenConfig } from "./config";
import { type CodegenDescribe, type GeneratedFileHashes, generateSource, readGeneratedHashes } from "./generator";
import { CONFIG_FILE_NAMES, findConfigFiles, loadConfig } from "./load-config";
import { validateConfig } from "./validate-config";

export { defineConfig } from "./config";
export type {
	AccessTokenAuth,
	AuthSetting,
	ClientCredentialsAuth,
	CodegenAuth,
	CodegenConfig,
	ConfigValue,
	JsonCodegenConfig,
	JwtBearerAuth,
	PicklistMode,
	SfCliAuth,
} from "./config";
/* oxlint-disable typescript/no-deprecated -- kept exported until 2.0 so existing imports keep working */
export type { EnvAuth, EnvAccessTokenAuth, EnvClientCredentialsAuth, EnvJwtBearerAuth } from "./config";
/* oxlint-enable typescript/no-deprecated */
export { generateSource, readGeneratedHashes } from "./generator";
export type { CodegenDescribe, GeneratedFileHashes, GenerateSourceOptions } from "./generator";
export { FIELD_TYPE_MAP, mapFieldType } from "./type-mapper";
export type { CodegenField } from "./type-mapper";
export { CONFIG_FILE_NAMES, findConfigFile, findConfigFiles, loadConfig } from "./load-config";
export {
	AUTH_OPTIONS,
	CONFIG_OPTIONS,
	CodegenConfigError,
	DEPRECATED_AUTH_OPTIONS,
	validateConfig,
} from "./validate-config";
export { AUTH_ENV_VARS, parseSObjects, renderConfig, runInit } from "./init";
export type { InitAnswers, InitAuthType, InitConfigFormat, InitOptions, InitResult } from "./init";
export { readlinePrompter } from "./prompter";
export type { Choice, Prompter } from "./prompter";

export interface CodegenLogger {
	info(message: string): void;
	warn(message: string): void;
}

export interface GenerateOptions {
	/** Directory that `output` is resolved against. Defaults to `process.cwd()`. */
	cwd?: string;
	logger?: CodegenLogger;
	/** Where `"${NAME}"` placeholders and the default `SF_*` variables are read from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Write the file. Defaults to `true`; with `false` the source is only returned. */
	write?: boolean;
}

export interface GenerateResult {
	outputPath: string;
	/** The concrete API version the types were generated with. */
	apiVersion: ApiVersion;
	sobjects: string[];
	skipped: { name: string; error: string }[];
	/** The generated source (after the `format` hook). */
	source: string;
	/** SHA-256 of the unformatted content, as recorded in the file header. */
	contentHash: string;
}

export interface CheckResult {
	/** `true` when the file on disk has the same content (formatting differences are ignored). */
	upToDate: boolean;
	/** Why the file is out of date. */
	reason?: "missing" | "changed";
	outputPath: string;
	/** sObjects that would be added, removed or changed (known when the file has hash headers). */
	added: string[];
	removed: string[];
	changed: string[];
}

const silentLogger: CodegenLogger = { info: () => undefined, warn: () => undefined };

/** Describes the configured sObjects and writes the generated types to `config.output`. */
export async function generate(input: CodegenConfig, options: GenerateOptions = {}): Promise<GenerateResult> {
	const logger = options.logger ?? silentLogger;
	const built = await buildSource(input, options);
	const { config } = built;
	let source = built.raw;
	if (config.format) {
		source = await config.format(source, built.outputPath);
	}
	if (options.write !== false) {
		await writeAtomically(built.outputPath, source);
		logger.info(`Wrote ${built.sobjects.length} sObject type(s) to ${built.outputPath}`);
	}
	const { contentHash } = readGeneratedHashes(built.raw) as GeneratedFileHashes;
	return {
		outputPath: built.outputPath,
		apiVersion: config.apiVersion,
		sobjects: built.sobjects,
		skipped: built.skipped,
		source,
		contentHash,
	};
}

/**
 * Checks whether the generated file on disk is up to date with the org, without writing it.
 * Only content counts: a file reformatted by Prettier, oxfmt or the `format` hook is up to date.
 */
export async function checkGenerated(input: CodegenConfig, options: GenerateOptions = {}): Promise<CheckResult> {
	const built = await buildSource(input, options);
	const empty = { outputPath: built.outputPath, added: [], removed: [], changed: [] };
	if (!existsSync(built.outputPath)) {
		return { ...empty, upToDate: false, reason: "missing" };
	}
	const existing = await readFile(built.outputPath, "utf8");
	const expected = readGeneratedHashes(built.raw) as GeneratedFileHashes;
	const actual = readGeneratedHashes(existing);
	if (!actual) {
		// Older files have no hash header: compare content, ignoring formatting.
		const upToDate = normalizeSource(existing) === normalizeSource(built.raw);
		return { ...empty, upToDate, reason: upToDate ? undefined : "changed" };
	}
	if (actual.contentHash === expected.contentHash) {
		return { ...empty, upToDate: true };
	}
	return { ...empty, upToDate: false, reason: "changed", ...diffObjects(actual.sobjects, expected.sobjects) };
}

async function buildSource(
	input: CodegenConfig,
	options: GenerateOptions,
): Promise<{
	config: CodegenConfig;
	outputPath: string;
	raw: string;
	sobjects: string[];
	skipped: GenerateResult["skipped"];
}> {
	const config = validateConfig(input, { source: "generate()" });
	const { apiVersion } = config;
	const logger = options.logger ?? silentLogger;
	const env = options.env ?? process.env;
	const outputPath = isAbsolute(config.output) ? config.output : resolve(options.cwd ?? process.cwd(), config.output);

	const client = new SalesforceClient({
		auth: resolveAuth(config.auth, env, { warn: (message) => logger.warn(message) }),
		apiVersion,
		transport: config.transport,
		retry: true,
	});

	const names = await resolveSObjectNames(client, config, logger);
	logger.info(`Describing ${names.length} sObject(s) with API ${apiVersion}...`);
	const { describes, skipped } = await describeAll(client, names, config, logger);

	const raw = generateSource(describes, {
		excludeCreateFields: config.excludeCreateFields,
		excludeUpdateFields: config.excludeUpdateFields,
		picklists: config.picklists,
		constants: config.constants,
		importSource: config.importSource,
		apiVersion,
	});
	return { config, outputPath, raw, sobjects: describes.map((describe) => describe.name).sort(), skipped };
}

function diffObjects(
	actual: ReadonlyMap<string, string>,
	expected: ReadonlyMap<string, string>,
): Pick<CheckResult, "added" | "removed" | "changed"> {
	return {
		added: [...expected.keys()].filter((name) => !actual.has(name)),
		removed: [...actual.keys()].filter((name) => !expected.has(name)),
		changed: [...expected.entries()]
			.filter(([name, hash]) => actual.has(name) && actual.get(name) !== hash)
			.map(([name]) => name),
	};
}

/** Strips comments, whitespace, quote style, semicolons and commas, so only content remains. */
function normalizeSource(source: string): string {
	let result = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (char === '"' || char === "'") {
			// Keep the string's content exactly; only the quote style is normalised.
			let end = index + 1;
			while (end < source.length && source[end] !== char) {
				end += source[end] === "\\" ? 2 : 1;
			}
			result += `"${source
				.slice(index + 1, end)
				.replace(/\\'/g, "'")
				.replace(/"/g, '\\"')}"`;
			index = end + 1;
		} else if (char === "/" && next === "/") {
			index = source.indexOf("\n", index) === -1 ? source.length : source.indexOf("\n", index);
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
		} else {
			if (!/[\s;,]/.test(char)) {
				result += char;
			}
			index++;
		}
	}
	return result;
}

export interface ResolveAuthOptions {
	/** Receives deprecation warnings, e.g. for the `*Env` keys. */
	warn?: (message: string) => void;
}

/** Where the JWT private key comes from, in order of preference, with each default variable. */
const PRIVATE_KEY_SOURCES = [
	["privateKey", "SF_PRIVATE_KEY"],
	["privateKeyPath", "SF_PRIVATE_KEY_PATH"],
] as const;

/** A `"${NAME}"` placeholder. Only a whole value counts, so a secret that contains `${` is kept as-is. */
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Turns the config's auth setting into an auth provider. Each credential comes from its key in
 * the setting (a `"${NAME}"` placeholder is read from `env`), else from the variable a deprecated
 * `*Env` key names, else from its default `SF_*` variable. Throws one error listing every
 * missing credential.
 */
export function resolveAuth(
	auth: CodegenAuth | undefined,
	env: Record<string, string | undefined>,
	options: ResolveAuthOptions = {},
): AuthProvider {
	const setting = auth ?? { type: "clientCredentials" };
	if ("getToken" in setting) {
		return setting;
	}
	const problems: string[] = [];
	const lookup = (key: string, defaultEnv: string): Credential =>
		readCredential(setting, key, defaultEnv, env, options.warn);
	const read = (key: string, defaultEnv: string): string => {
		const { value, problem } = lookup(key, defaultEnv);
		if (problem) {
			problems.push(problem);
		}
		return value;
	};
	switch (setting.type) {
		case "accessToken": {
			const token = {
				accessToken: read("accessToken", "SF_ACCESS_TOKEN"),
				instanceUrl: read("instanceUrl", "SF_INSTANCE_URL"),
			};
			throwIfMissing(setting.type, problems);
			return accessToken(token);
		}
		case "jwtBearer": {
			const loginUrl = read("loginUrl", "SF_LOGIN_URL");
			const clientId = read("clientId", "SF_CLIENT_ID");
			const username = read("username", "SF_USERNAME");
			// The key itself wins over the key file. Setting either one in the config skips both defaults,
			// so a stray SF_PRIVATE_KEY can't override a configured key file.
			const configured = PRIVATE_KEY_SOURCES.filter(([key]) => key in setting);
			const found = (configured.length > 0 ? configured : PRIVATE_KEY_SOURCES).map(([key, defaultEnv]) => ({
				key,
				...lookup(key, defaultEnv),
			}));
			const source = found.find((item) => item.value);
			if (source === undefined) {
				problems.push(`no private key: ${found.map((item) => item.problem).join(", and ")}`);
			}
			throwIfMissing(setting.type, problems);
			const privateKey = source?.key === "privateKeyPath" ? readFileSync(source.value, "utf8") : (source?.value ?? "");
			return jwtBearer({ loginUrl, clientId, username, privateKey });
		}
		case "sfCli": {
			// Left out: the CLI's default org. Set but empty fails like any other credential, so a typo
			// in `process.env.NAME` can't silently switch to the default org.
			const targetOrg = "targetOrg" in setting ? read("targetOrg", "") : undefined;
			throwIfMissing(setting.type, problems);
			return sfCli({ targetOrg });
		}
		case "clientCredentials": {
			const credentials = {
				loginUrl: read("loginUrl", "SF_LOGIN_URL"),
				clientId: read("clientId", "SF_CLIENT_ID"),
				clientSecret: read("clientSecret", "SF_CLIENT_SECRET"),
			};
			throwIfMissing(setting.type, problems);
			return clientCredentials(credentials);
		}
		default:
			throw new Error(`Unknown codegen auth type "${(setting as { type: string }).type}".`);
	}
}

export interface LoadAuthOptions extends ResolveAuthOptions {
	/** The config file. Defaults to the first `sobjectly.config.{ts,mts,cts,json}` in `cwd`. */
	configPath?: string;
	/** Where to look for the config file. Defaults to `process.cwd()`. */
	cwd?: string;
	/** Where `"${NAME}"` placeholders and the default `SF_*` variables are read from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/**
 * Loads the sobjectly config and returns an auth provider for its `auth` setting, so the client
 * logs in the same way as `sobjectly generate`:
 * `new SalesforceClient({ apiVersion: API_VERSION, auth: await loadAuth() })`.
 * Throws when no config file is found, or one error listing every missing credential.
 */
export async function loadAuth(options: LoadAuthOptions = {}): Promise<AuthProvider> {
	const cwd = options.cwd ?? process.cwd();
	let configPath = options.configPath === undefined ? undefined : resolve(cwd, options.configPath);
	if (configPath === undefined) {
		const found = findConfigFiles(cwd);
		if (found.length > 1) {
			options.warn?.(`found ${found.join(" and ")}; using ${found[0]}. Remove the other one.`);
		}
		configPath = found[0];
	}
	if (configPath === undefined) {
		throw new Error(
			`No sobjectly config file found in ${cwd} (looked for ${CONFIG_FILE_NAMES.join(", ")}).\n` +
				'Pass { configPath } to loadAuth(), run "npx sobjectly init" to create a config, ' +
				"or pass an auth provider such as clientCredentials() to SalesforceClient directly.",
		);
	}
	const { config } = await loadConfig(configPath);
	return resolveAuth(config.auth, options.env ?? process.env, { warn: options.warn });
}

interface Credential {
	value: string;
	problem?: string;
}

function readCredential(
	setting: AuthSetting,
	key: string,
	defaultEnv: string,
	env: Record<string, string | undefined>,
	warn: ((message: string) => void) | undefined,
): Credential {
	const values = setting as unknown as Record<string, unknown>;
	if (key in values) {
		// Set in the config: never fall back to a default variable, so `process.env.TYPO` fails loudly.
		const configured = values[key];
		const name = typeof configured === "string" ? ENV_PLACEHOLDER.exec(configured)?.[1] : undefined;
		if (name !== undefined) {
			return fromEnv(env, name, ` (from auth.${key} "${String(configured)}")`);
		}
		return typeof configured === "string" && configured.length > 0
			? { value: configured }
			: { value: "", problem: `auth.${key} is empty or undefined (if it reads process.env, that variable is not set)` };
	}
	const envKey = `${key}Env`;
	const legacy = values[envKey];
	if (typeof legacy === "string") {
		warn?.(
			`auth.${envKey} is deprecated and will be removed in 2.0. Use ${key}: process.env.${legacy} in a TypeScript config, or "${key}": "\${${legacy}}" in JSON.`,
		);
		return fromEnv(env, legacy, "");
	}
	return fromEnv(env, defaultEnv, "");
}

function fromEnv(env: Record<string, string | undefined>, name: string, origin: string): Credential {
	const value = env[name];
	return value ? { value } : { value: "", problem: `environment variable ${name}${origin} is not set` };
}

function throwIfMissing(type: string, problems: readonly string[]): void {
	if (problems.length > 0) {
		throw new Error(
			`Missing Salesforce credentials for auth "${type}":\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n` +
				"Fill them in under auth in the config, or set the environment variables (e.g. with --env-file .env).",
		);
	}
}

async function resolveSObjectNames(
	client: SalesforceClient,
	config: CodegenConfig,
	logger: CodegenLogger,
): Promise<string[]> {
	// sObject names are case-insensitive in Salesforce.
	const exclude = new Set((config.exclude ?? []).map((name) => name.toLowerCase()));
	if (config.sobjects && config.sobjects.length > 0) {
		const unique = new Map<string, string>();
		for (const name of config.sobjects) {
			if (!unique.has(name.toLowerCase())) {
				unique.set(name.toLowerCase(), name);
			}
		}
		return [...unique.entries()].filter(([key]) => !exclude.has(key)).map(([, name]) => name);
	}
	logger.warn("No `sobjects` configured: generating every queryable sObject. Consider an explicit list.");
	const global = await client.describeGlobal();
	return global.sobjects
		.filter((sobject) => sobject.queryable && !sobject.deprecatedAndHidden && !exclude.has(sobject.name.toLowerCase()))
		.map((sobject) => sobject.name);
}

async function describeAll(
	client: SalesforceClient,
	names: readonly string[],
	config: CodegenConfig,
	logger: CodegenLogger,
): Promise<{ describes: CodegenDescribe[]; skipped: GenerateResult["skipped"] }> {
	const concurrency = Math.max(1, config.concurrency ?? 10);
	const describes: CodegenDescribe[] = [];
	const skipped: GenerateResult["skipped"] = [];
	let next = 0;
	let done = 0;
	// Stops the other workers (and their in-flight requests) once one describe has failed.
	const failed = new AbortController();

	const worker = async (): Promise<void> => {
		while (next < names.length && !failed.signal.aborted) {
			const name = names[next++];
			try {
				const describe: DescribeSObjectResult = await client.sobject(name).describe({ signal: failed.signal });
				describes.push(describe);
			} catch (error) {
				if (failed.signal.aborted) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (!config.continueOnDescribeError) {
					failed.abort();
					throw new Error(`Describing sObject "${name}" failed: ${message}`, { cause: error });
				}
				logger.warn(`Skipping sObject "${name}": ${message}`);
				skipped.push({ name, error: message });
			}
			done++;
			if (done % 10 === 0 || done === names.length) {
				logger.info(`Described ${done}/${names.length} sObject(s)`);
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, () => worker()));
	// Two configured names can resolve to the same sObject (e.g. a different case): keep one.
	const unique = new Map(describes.map((describe) => [describe.name, describe] as const));
	return { describes: [...unique.values()], skipped };
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, content, "utf8");
		await renameWithRetry(temporary, filePath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** On Windows a virus scanner or indexer can briefly lock the target file; retry a few times. */
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
		}
	}
}
