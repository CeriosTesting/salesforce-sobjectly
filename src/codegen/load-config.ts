import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { createJiti } from "jiti";

import type { CodegenConfig } from "./config";
import { CodegenConfigError, validateConfig } from "./validate-config";

/** Config file names, in lookup order. */
export const CONFIG_FILE_NAMES = [
	"sobjectly.config.ts",
	"sobjectly.config.mts",
	"sobjectly.config.cts",
	"sobjectly.config.json",
];

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/** Looks for a `sobjectly.config.{ts,mts,cts,json}` file in `cwd`; the first match in lookup order wins. */
export function findConfigFile(cwd: string = process.cwd()): string | undefined {
	return findConfigFiles(cwd)[0];
}

/** Every `sobjectly.config.*` file in `cwd`, in lookup order. */
export function findConfigFiles(cwd: string = process.cwd()): string[] {
	return CONFIG_FILE_NAMES.map((name) => join(cwd, name)).filter((path) => existsSync(path));
}

/**
 * Loads and validates a TypeScript (`.ts`, `.mts`, `.cts`) or JSON config file. Returns the
 * config and the directory it lives in. Throws a `CodegenConfigError` listing every problem.
 */
export async function loadConfig(configPath: string): Promise<{ config: CodegenConfig; directory: string }> {
	const absolutePath = resolve(configPath);
	if (!existsSync(absolutePath)) {
		throw new Error(`Config file not found: ${absolutePath}`);
	}
	const extension = extname(absolutePath).toLowerCase();
	const directory = dirname(absolutePath);
	if (extension === ".json") {
		return { config: validateConfig(readJson(absolutePath), { source: absolutePath, json: true }), directory };
	}
	if (!TYPESCRIPT_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported config file "${absolutePath}". Use sobjectly.config.ts or sobjectly.config.json.`);
	}
	const jiti = createJiti(join(directory, "_sobjectly_loader.js"), { interopDefault: true });
	const loaded = await jiti.import<unknown>(absolutePath, { default: true });
	return { config: validateConfig(loaded, { source: absolutePath }), directory };
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new CodegenConfigError(path, [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
	}
}
