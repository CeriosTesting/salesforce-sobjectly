import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { accessToken, clientCredentials, jwtBearer } from "../auth/providers";
import { sfCli } from "../auth/sf-cli";
import type { AuthProvider } from "../auth/types";
import { SalesforceClient } from "../client";
import type { ApiVersion } from "../types/common";
import type { DescribeSObjectResult } from "../types/describe";

import type { CodegenAuth, CodegenConfig, EnvJwtBearerAuth } from "./config";
import { type CodegenDescribe, type GeneratedFileHashes, generateSource, readGeneratedHashes } from "./generator";
import { validateConfig } from "./validate-config";

export { defineConfig } from "./config";
export type {
	CodegenAuth,
	CodegenConfig,
	EnvAuth,
	JsonCodegenConfig,
	EnvAccessTokenAuth,
	EnvClientCredentialsAuth,
	EnvJwtBearerAuth,
	PicklistMode,
	SfCliAuth,
} from "./config";
export { generateSource, readGeneratedHashes } from "./generator";
export type { CodegenDescribe, GeneratedFileHashes, GenerateSourceOptions } from "./generator";
export { FIELD_TYPE_MAP, mapFieldType } from "./type-mapper";
export type { CodegenField } from "./type-mapper";
export { CONFIG_FILE_NAMES, findConfigFile, findConfigFiles, loadConfig } from "./load-config";
export { AUTH_OPTIONS, CONFIG_OPTIONS, CodegenConfigError, validateConfig } from "./validate-config";
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
	/** Environment to read credentials from. Defaults to `process.env`. */
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
		auth: resolveAuth(config.auth, env),
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

/** Turns the config's auth setting into an auth provider, reading env-based credentials. */
export function resolveAuth(auth: CodegenAuth | undefined, env: Record<string, string | undefined>): AuthProvider {
	const setting = auth ?? { type: "clientCredentials" };
	if ("getToken" in setting) {
		return setting;
	}
	const read = (name: string): string => {
		const value = env[name];
		if (!value) {
			throw new Error(`Environment variable ${name} is not set.`);
		}
		return value;
	};
	switch (setting.type) {
		case "accessToken":
			return accessToken({
				accessToken: read(setting.accessTokenEnv ?? "SF_ACCESS_TOKEN"),
				instanceUrl: read(setting.instanceUrlEnv ?? "SF_INSTANCE_URL"),
			});
		case "jwtBearer":
			return jwtBearerFromEnv(setting, env, read);
		case "sfCli":
			return sfCli({ targetOrg: setting.targetOrg });
		case "clientCredentials":
			return clientCredentials({
				loginUrl: read(setting.loginUrlEnv ?? "SF_LOGIN_URL"),
				clientId: read(setting.clientIdEnv ?? "SF_CLIENT_ID"),
				clientSecret: read(setting.clientSecretEnv ?? "SF_CLIENT_SECRET"),
			});
		default:
			throw new Error(`Unknown codegen auth type "${(setting as { type: string }).type}".`);
	}
}

function jwtBearerFromEnv(
	setting: EnvJwtBearerAuth,
	env: Record<string, string | undefined>,
	read: (name: string) => string,
): AuthProvider {
	const keyEnv = setting.privateKeyEnv ?? "SF_PRIVATE_KEY";
	const privateKey = env[keyEnv]
		? read(keyEnv)
		: readFileSync(read(setting.privateKeyPathEnv ?? "SF_PRIVATE_KEY_PATH"), "utf8");
	return jwtBearer({
		loginUrl: read(setting.loginUrlEnv ?? "SF_LOGIN_URL"),
		clientId: read(setting.clientIdEnv ?? "SF_CLIENT_ID"),
		username: read(setting.usernameEnv ?? "SF_USERNAME"),
		privateKey,
	});
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
