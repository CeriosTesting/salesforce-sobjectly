import { execFile } from "node:child_process";

import { SalesforceAuthError } from "../errors";

import { CachingAuthProvider } from "./caching-provider";
import type { AccessToken, AuthProvider } from "./types";

/** Runs a command and returns its stdout. Resolves even on a non-zero exit when stdout was written. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<string>;

export interface SfCliOptions {
	/** The org alias or username (`--target-org`). Defaults to the CLI's default org. */
	targetOrg?: string;
	/** The CLI executable. Defaults to `sf`. */
	command?: string;
	/** Replaces how the CLI is run, e.g. in tests. */
	runCommand?: RunCommand;
}

interface SfJson<T> {
	status: number;
	result?: T;
	message?: string;
	name?: string;
}

const ALIAS = /^[\w.@+-]+$/;

/**
 * Uses an org you are logged into with the Salesforce CLI (`sf org login web --alias my-org`).
 * Handy for local development: no connected app or secrets needed.
 *
 * The token comes from `sf org auth show-access-token`, the instance URL from `sf org display`
 * (which no longer returns tokens). Both run without a shell. On a 401 the CLI is asked again;
 * it refreshes the token itself.
 */
export function sfCli(options: SfCliOptions = {}): AuthProvider {
	if (options.targetOrg !== undefined && !ALIAS.test(options.targetOrg)) {
		throw new TypeError(`sfCli(): invalid targetOrg "${options.targetOrg}".`);
	}
	const command = options.command ?? "sf";
	const run = options.runCommand ?? runCommand;
	const target = options.targetOrg ? ["--target-org", options.targetOrg] : [];

	return new CachingAuthProvider(async (): Promise<AccessToken> => {
		const display = await callSf<{ instanceUrl?: string; accessToken?: string }>(run, command, [
			"org",
			"display",
			"--json",
			...target,
		]);
		const instanceUrl = display.instanceUrl;
		if (!instanceUrl) {
			throw new SalesforceAuthError("`sf org display` returned no instanceUrl.");
		}
		const token = await callSf<{ accessToken?: string }>(run, command, [
			"org",
			"auth",
			"show-access-token",
			"--json",
			...target,
		]).catch((error: unknown) => {
			// Older CLIs don't have `org auth show-access-token` but still return the token from display.
			if (usableToken(display.accessToken)) {
				return { accessToken: display.accessToken };
			}
			throw error;
		});
		if (!usableToken(token.accessToken)) {
			throw new SalesforceAuthError(
				"The Salesforce CLI returned no usable access token. Log in again with `sf org login web`.",
			);
		}
		return { accessToken: token.accessToken, instanceUrl };
	});
}

async function callSf<T>(run: RunCommand, command: string, args: readonly string[]): Promise<T> {
	let stdout: string;
	try {
		stdout = await run(command, args);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new SalesforceAuthError(
				"The Salesforce CLI (sf) was not found. Install it from https://developer.salesforce.com/tools/salesforcecli and log in with `sf org login web`.",
			);
		}
		throw error;
	}
	let json: SfJson<T>;
	try {
		// Update notices or warnings can precede the JSON document.
		json = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf("{")))) as SfJson<T>;
	} catch {
		throw new SalesforceAuthError(
			`\`sf ${args.slice(0, 3).join(" ")}\` did not return JSON: ${stdout.trim().slice(0, 200)}`,
		);
	}
	if (json.status !== 0 || !json.result) {
		throw new SalesforceAuthError(
			`\`sf ${args.slice(0, 3).join(" ")}\` failed: ${json.message ?? json.name ?? "unknown error"}`,
		);
	}
	return json.result;
}

function usableToken(token: string | undefined): token is string {
	return typeof token === "string" && token.length > 0 && !token.includes("REDACTED");
}

/** cmd.exe exit code for "'x' is not recognized as an internal or external command". */
const CMD_NOT_FOUND = 9009;

/**
 * Runs `command` without a shell. On Windows the CLI is a `.cmd` shim, which needs `cmd.exe`; the
 * arguments are fixed strings or a validated alias, so nothing user-controlled is interpreted.
 */
const runCommand: RunCommand = (command, args) =>
	new Promise((resolve, reject) => {
		const windows = process.platform === "win32";
		// Like Node's own `shell: true` on Windows: one quoted command line, passed verbatim.
		const [file, fileArgs] = windows
			? ["cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(quoteForCmd).join(" ")}"`]]
			: [command, [...args]];
		execFile(
			file,
			fileArgs,
			{
				windowsHide: true,
				windowsVerbatimArguments: windows,
				maxBuffer: 10 * 1024 * 1024,
				env: { ...process.env, SF_JSON_TO_STDOUT: "true" },
			},
			(error, stdout, stderr) => {
				if (
					error &&
					(error.code === "ENOENT" || (windows && (error.code === CMD_NOT_FOUND || /is not recognized/i.test(stderr))))
				) {
					reject(Object.assign(new Error(`${command} was not found`), { code: "ENOENT" }));
				} else if (error && !stdout.includes("{")) {
					// The CLI exits non-zero on failure but normally still prints JSON describing the error.
					reject(new Error(`${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
				} else {
					resolve(stdout);
				}
			},
		);
	});

function quoteForCmd(value: string): string {
	return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
