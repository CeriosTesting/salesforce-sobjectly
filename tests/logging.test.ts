import { describe, expect, it, vi } from "vitest";

import { clientCredentials, refreshToken, tokenProvider } from "../src/auth/providers";
import { type RunCommand, sfCli } from "../src/auth/sf-cli";
import { MetadataCache } from "../src/cache";
import type { SalesforceClient, SalesforceClientOptions } from "../src/client";
import { SalesforceError } from "../src/errors";
import type { HttpTransport } from "../src/http/transport";
import {
	consoleLogger,
	createLogger,
	filterLogger,
	isConsoleLogger,
	isLevelEnabled,
	type SalesforceLogEvent,
	type SalesforceLogger,
	type SalesforceLogLevel,
} from "../src/logging";

import { API, createClient as createBaseClient, FakeTransport, INSTANCE_URL } from "./helpers/fake-transport";

/** Logging is off by default; these tests turn it on for the client unless they pass `log`. */
function createClient(transport: FakeTransport, options: Partial<SalesforceClientOptions> = {}): SalesforceClient {
	return createBaseClient(transport, { log: true, ...options });
}

interface Entry {
	level: SalesforceLogLevel;
	message: string;
	event: SalesforceLogEvent;
}

function collector(): { logger: SalesforceLogger; entries: Entry[]; types: () => string[] } {
	const entries: Entry[] = [];
	const logger = createLogger((level, message, event) => {
		entries.push({ level, message, event });
	});
	return { logger, entries, types: () => entries.map((entry) => entry.event.type) };
}

const LOGIN_URL = "https://login.example.my.salesforce.com";
const tokenBody = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
	access_token: token,
	instance_url: INSTANCE_URL,
	token_type: "Bearer",
	signature: "SIGNATURE",
	...extra,
});

/** A transport that answers token requests and API calls separately. */
function oauthTransport(apiResponses: { status?: number; body?: unknown }[] = []): FakeTransport {
	let tokens = 0;
	return new FakeTransport((request) => {
		if (request.path === "/services/oauth2/token") {
			tokens++;
			return { body: tokenBody(`TOKEN${tokens}`, { refresh_token: `REFRESH${tokens}` }) };
		}
		return apiResponses.shift() ?? { body: { ok: true } };
	});
}

describe("logger: HTTP", () => {
	it("logs requests at debug and 4xx responses at warn, with bodies", async () => {
		const { logger, entries } = collector();
		const transport = new FakeTransport().reply(
			{ status: 201, body: { id: "001", success: true, errors: [] } },
			{ status: 404, body: [{ errorCode: "NOT_FOUND", message: "nope" }] },
		);
		const sf = createClient(transport, { logger });
		await sf.request({ method: "POST", path: "/sobjects/Account", body: { Name: "Acme" } });
		await expect(sf.request({ path: "/sobjects/Account/001" })).rejects.toThrow(/nope/);

		expect(entries.map(({ level, event }) => [level, event.type])).toEqual([
			["debug", "http.request"],
			["debug", "http.response"],
			["debug", "http.request"],
			["warn", "http.response"],
		]);
		const response = entries[1]?.event;
		expect(response).toMatchObject({
			type: "http.response",
			method: "POST",
			url: `${INSTANCE_URL}${API}/sobjects/Account`,
			body: '{"Name":"Acme"}',
			status: 201,
			responseBody: '{"id":"001","success":true,"errors":[]}',
		});
		expect(entries[1]?.message).toMatch(/^POST https:\/\/.+\/sobjects\/Account → 201 \(\d+ ms\)$/);
		expect(JSON.stringify(entries)).not.toContain("TOKEN");
	});

	it("logs retries on a status and on a network error", async () => {
		const { logger, entries } = collector();
		let calls = 0;
		const transport: HttpTransport = {
			send: () => {
				calls++;
				if (calls === 1) {
					return Promise.reject(new TypeError("fetch failed"));
				}
				const status = calls === 2 ? 503 : 200;
				return Promise.resolve({ status, headers: new Headers(), body: new Uint8Array() });
			},
		};
		await createClient(new FakeTransport(), { transport, logger, retry: { baseDelayMs: 1 } }).request({ path: "/x" });

		const relevant = entries.filter((entry) => entry.event.type !== "http.request");
		expect(relevant.map(({ level, event }) => [level, event.type])).toEqual([
			["warn", "http.error"],
			["warn", "http.retry"],
			["warn", "http.response"],
			["warn", "http.retry"],
			["debug", "http.response"],
		]);
		expect(relevant[0]?.event).toMatchObject({ type: "http.error", willRetry: true, attempt: 1 });
		expect(relevant[1]?.event).toMatchObject({ type: "http.retry", reason: "network", attempt: 1, delayMs: 1 });
		expect(relevant[3]?.event).toMatchObject({ type: "http.retry", reason: "status", status: 503, attempt: 2 });
	});

	it("logs a final transport failure at error", async () => {
		const { logger, entries } = collector();
		const transport: HttpTransport = { send: () => Promise.reject(new TypeError("fetch failed")) };
		await expect(createClient(new FakeTransport(), { transport, logger }).request({ path: "/x" })).rejects.toThrow(
			"fetch failed",
		);
		expect(entries.at(-1)).toMatchObject({
			level: "error",
			message: expect.stringMatching(/failed: fetch failed$/) as string,
			event: { type: "http.error", willRetry: false },
		});
	});

	it("logs re-authentication after a 401 and the new token", async () => {
		const { logger, entries, types } = collector();
		const transport = oauthTransport([{ status: 401, body: [{ errorCode: "INVALID_SESSION_ID" }] }]);
		const sf = createClient(transport, {
			logger,
			auth: clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" }),
		});
		await sf.request({ path: "/limits" });
		expect(types()).toEqual([
			"auth.request",
			"auth.response",
			"auth.tokenIssued",
			"http.request",
			"http.response",
			"auth.reauthenticate",
			"auth.request",
			"auth.response",
			"auth.tokenIssued",
			"http.request",
			"http.response",
		]);
		expect(entries.find((entry) => entry.event.type === "auth.reauthenticate")?.level).toBe("info");
	});
});

describe("logger: log: false", () => {
	it("keeps a request and the token request it triggers out of the logger and the hooks", async () => {
		const { logger, entries } = collector();
		const onResponse = vi.fn<() => void>();
		const transport = oauthTransport();
		const sf = createClient(transport, {
			logger,
			// oxlint-disable-next-line typescript/no-deprecated -- hooks are skipped too
			hooks: { onResponse },
			auth: clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" }),
		});
		await sf.request({ path: "/services/oauth2/userinfo", log: false });
		expect(entries).toEqual([]);
		expect(onResponse).not.toHaveBeenCalled();

		await sf.request({ path: "/limits" });
		expect(entries.map((entry) => entry.event.type)).toEqual(["auth.tokenCached", "http.request", "http.response"]);
		expect(onResponse).toHaveBeenCalledTimes(1);
	});

	it("applies to instanceUrl", async () => {
		const { logger, entries } = collector();
		const sf = createClient(oauthTransport(), {
			logger,
			auth: clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" }),
		});
		expect(await sf.instanceUrl({ log: false })).toBe(INSTANCE_URL);
		expect(entries).toEqual([]);
		await sf.instanceUrl();
		expect(entries.map((entry) => entry.event.type)).toEqual(["auth.tokenCached"]);
	});
});

describe("logger: auth", () => {
	it("redacts every credential and token from token requests", async () => {
		const { logger, entries } = collector();
		const transport = oauthTransport();
		const auth = refreshToken({
			loginUrl: LOGIN_URL,
			clientId: "id",
			clientSecret: "SECRET",
			refreshToken: "ORIGINAL_REFRESH",
		});
		await createClient(transport, { logger, auth }).request({ path: "/limits" });

		const serialized = JSON.stringify(entries);
		for (const secret of ["SECRET", "ORIGINAL_REFRESH", "REFRESH1", "TOKEN1", "SIGNATURE"]) {
			expect(serialized).not.toContain(secret);
		}
		const request = entries.find((entry) => entry.event.type === "auth.request")?.event;
		expect(request).toMatchObject({
			grantType: "refresh_token",
			body: "grant_type=refresh_token&client_id=id&refresh_token=[REDACTED]&client_secret=[REDACTED]",
		});
		const response = entries.find((entry) => entry.event.type === "auth.response")?.event;
		expect(response).toMatchObject({ status: 200, grantType: "refresh_token" });
		expect(JSON.parse((response as { responseBody: string }).responseBody)).toMatchObject({
			access_token: "[REDACTED]",
			refresh_token: "[REDACTED]",
			signature: "[REDACTED]",
			instance_url: INSTANCE_URL,
		});
		expect(entries.find((entry) => entry.event.type === "auth.refreshTokenRotated")).toMatchObject({ level: "info" });
		expect(entries.find((entry) => entry.event.type === "auth.tokenIssued")?.event).toMatchObject({
			provider: "refreshToken",
			instanceUrl: INSTANCE_URL,
		});
	});

	it("logs a failed token request at error", async () => {
		const { logger, entries } = collector();
		const transport = new FakeTransport().reply({ status: 400, body: { error: "invalid_client" } });
		const auth = clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" });
		await expect(createClient(transport, { logger, auth }).request({ path: "/limits" })).rejects.toThrow(
			/invalid_client/,
		);
		expect(entries.map(({ level, event }) => [level, event.type])).toEqual([
			["debug", "auth.request"],
			["warn", "auth.response"],
			["error", "auth.error"],
		]);
		expect(JSON.stringify(entries)).not.toContain("SECRET");
	});

	it("passes the logger to custom token providers", async () => {
		const { logger, entries } = collector();
		const auth = tokenProvider((context) => {
			context.logger?.info?.("fetching my token", { type: "custom", source: "test" });
			return Promise.resolve({ accessToken: "TOKEN", instanceUrl: INSTANCE_URL });
		});
		await createClient(new FakeTransport().reply({ body: {} }), { logger, auth }).request({ path: "/x" });
		expect(entries[0]?.message).toBe("fetching my token");
		expect(entries[1]?.event).toMatchObject({ type: "auth.tokenIssued", provider: "tokenProvider" });
	});

	it("logs Salesforce CLI calls without their output", async () => {
		const { logger, entries } = collector();
		const run: RunCommand = (_command, args) =>
			Promise.resolve(
				JSON.stringify({
					status: 0,
					result: args[1] === "display" ? { instanceUrl: INSTANCE_URL } : { accessToken: "00D!CLI_SECRET_TOKEN" },
				}),
			);
		await sfCli({ targetOrg: "my-org", runCommand: run }).getToken({ transport: new FakeTransport(), logger });
		expect(entries.map(({ level, event }) => [level, event.type])).toEqual([
			["debug", "auth.cli"],
			["debug", "auth.cli"],
			["info", "auth.tokenIssued"],
		]);
		expect(entries[0]?.event).toMatchObject({
			command: "sf",
			args: ["org", "display", "--json", "--target-org", "my-org"],
			ok: true,
		});
		expect(JSON.stringify(entries)).not.toContain("CLI_SECRET_TOKEN");
	});
});

describe("logger: resources", () => {
	it("logs metadata cache hits and misses", async () => {
		const { logger, entries } = collector();
		const cache = new MetadataCache(true, logger);
		await cache.getOrLoad("describe:Account", () => Promise.resolve(1));
		await cache.getOrLoad("describe:Account", () => Promise.resolve(2));
		expect(entries.map((entry) => entry.event)).toEqual([
			{ type: "cache.miss", key: "describe:Account" },
			{ type: "cache.hit", key: "describe:Account" },
		]);
	});

	it("logs bulk job states: info on change, debug otherwise", async () => {
		const { logger, entries } = collector();
		const job = (state: string): { body: Record<string, unknown> } => ({
			body: { id: "750J", object: "Account", operation: "insert", state, numberRecordsProcessed: 3 },
		});
		const transport = new FakeTransport().reply(
			job("UploadComplete"),
			job("InProgress"),
			job("InProgress"),
			job("JobComplete"),
		);
		const ingest = await createClient(transport, { logger }).bulk.ingestJob("750J");
		await ingest.waitForCompletion({ pollIntervalMs: 1 });
		const states = entries.filter((entry) => entry.event.type === "bulk.jobState");
		expect(states.map(({ level, event }) => [level, (event as { state: string }).state])).toEqual([
			["info", "InProgress"],
			["debug", "InProgress"],
			["info", "JobComplete"],
		]);
		expect(states[0]?.message).toBe("Bulk job 750J is InProgress (3 processed, 0 failed)");
	});

	it("logs report polling and Apex test runs", async () => {
		const { logger, entries } = collector();
		const transport = new FakeTransport().reply(
			{ body: { attributes: { status: "Running" } } },
			{ body: { attributes: { status: "Success" } } },
			{ body: { numTestsRun: 4, numFailures: 1, totalTime: 120, successes: [], failures: [] } },
			{ body: "707J" },
		);
		const sf = createClient(transport, { logger });
		await sf.reports.waitForInstance("00OA00000000001", "0LG1", { pollIntervalMs: 1 });
		await sf.tooling.runTestsSynchronous({ tests: [{ className: "MyTest" }] });
		await sf.tooling.runTestsAsynchronous({ classids: "01p" });
		const events = entries.filter((entry) => !entry.event.type.startsWith("http."));
		expect(events.map(({ level, event }) => [level, event])).toEqual([
			["debug", { type: "report.status", reportId: "00OA00000000001", instanceId: "0LG1", status: "Running" }],
			["info", { type: "report.status", reportId: "00OA00000000001", instanceId: "0LG1", status: "Success" }],
			["info", { type: "tooling.runTests", mode: "sync", numTestsRun: 4, numFailures: 1 }],
			["info", { type: "tooling.runTests", mode: "async", jobId: "707J" }],
		]);
	});
});

describe("logger: helpers and safety", () => {
	it("works with partial loggers such as console", async () => {
		const info = vi.fn<(message: string) => void>();
		const sf = createClient(new FakeTransport().reply({ body: {} }), { logger: { info } });
		await sf.request({ path: "/x" });
		expect(info).not.toHaveBeenCalled();
	});

	it("never lets a throwing or rejecting logger affect a request", async () => {
		const logger: SalesforceLogger = {
			debug: () => {
				throw new Error("sync failure");
			},
			warn: () => Promise.reject(new Error("async failure")),
		};
		const transport = new FakeTransport().reply({ status: 503 }, { body: { ok: true } });
		const sf = createClient(transport, { logger, retry: { baseDelayMs: 1 } });
		expect(await sf.request({ path: "/x" })).toEqual({ ok: true });
	});

	it("passes both the logger and the hooks the same request data", async () => {
		const { logger, entries } = collector();
		const onResponse = vi.fn<(event: unknown) => void>();
		// oxlint-disable-next-line typescript/no-deprecated -- hooks run next to the logger
		const sf = createClient(new FakeTransport().reply({ body: { a: 1 } }), { logger, hooks: { onResponse } });
		await sf.request({ path: "/x" });
		const { type, ...withoutType } = { ...entries[1]?.event };
		expect(type).toBe("http.response");
		expect(onResponse).toHaveBeenCalledWith(withoutType);
	});

	it("filterLogger and isLevelEnabled drop entries", async () => {
		const { logger, entries } = collector();
		const filtered = filterLogger(logger, (level) => isLevelEnabled(level, "warn"));
		const transport = new FakeTransport().reply({ body: {} }, { status: 400, body: [] });
		const sf = createClient(transport, { logger: filtered });
		await sf.request({ path: "/x" });
		await expect(sf.request({ path: "/y" })).rejects.toBeInstanceOf(SalesforceError);
		expect(entries.map(({ level, event }) => [level, event.type])).toEqual([["warn", "http.response"]]);
	});

	it("createLogger sends every level to the handler, and an async handler is not awaited", async () => {
		let resolveAttachment: () => void = () => undefined;
		const attachments: string[] = [];
		const logger = createLogger((_level, message, event) => {
			if (event.type !== "http.response") {
				return undefined;
			}
			return new Promise<void>((resolve) => {
				resolveAttachment = (): void => {
					attachments.push(`${message}: ${String(event.responseBody)}`);
					resolve();
				};
			});
		});
		const sf = createClient(new FakeTransport().reply({ status: 500, body: "boom" }), { logger });
		await expect(sf.request({ path: "/x" })).rejects.toBeInstanceOf(SalesforceError);
		resolveAttachment();
		expect(attachments).toEqual([expect.stringMatching(/^GET .+\/x → 500 \(\d+ ms\): boom$/)]);
	});
});

describe("logger: console vs custom loggers", () => {
	function output(): Pick<Console, SalesforceLogLevel> & { lines: string[] } {
		const lines: string[] = [];
		const write = (message: string): void => {
			lines.push(message);
		};
		return { lines, debug: write, info: write, warn: write, error: write };
	}

	it("accepts several loggers, and consoleLogger({ enabled: false }) silences only the console", async () => {
		const custom = collector();
		const out = output();
		const sf = createClient(new FakeTransport().reply({ status: 404, body: [] }), {
			logger: [consoleLogger({ enabled: false, output: out }), custom.logger],
		});
		await expect(sf.request({ path: "/x" })).rejects.toBeInstanceOf(SalesforceError);
		expect(out.lines).toEqual([]);
		expect(custom.types()).toEqual(["http.request", "http.response"]);
	});

	it("prints from the configured level", async () => {
		const out = output();
		const sf = createClient(new FakeTransport().reply({ body: {} }, { status: 404, body: [] }), {
			logger: consoleLogger({ output: out }),
		});
		await sf.request({ path: "/x" });
		await expect(sf.request({ path: "/y" })).rejects.toBeInstanceOf(SalesforceError);
		expect(out.lines).toEqual([expect.stringMatching(/^GET .+\/y → 404/)]);

		const verbose = output();
		await createClient(new FakeTransport().reply({ body: {} }), {
			logger: consoleLogger({ level: "debug", output: verbose }),
		}).request({ path: "/x" });
		expect(verbose.lines).toHaveLength(2);
	});

	async function printDetails(details: "compact" | "full"): Promise<unknown[][]> {
		const printed: unknown[][] = [];
		const write = (...args: unknown[]): void => {
			printed.push(args);
		};
		await createClient(new FakeTransport().reply({ body: { ok: true } }), {
			logger: consoleLogger({
				level: "debug",
				details,
				output: { debug: write, info: write, warn: write, error: write },
			}),
		}).request({ method: "POST", path: "/x", body: { name: "Acme" } });
		return printed;
	}

	it('details: "full" prints the whole event after the message', async () => {
		const printed = await printDetails("full");
		expect(printed).toHaveLength(2);
		const [[, request], [, response]] = printed;
		expect(request).toMatchObject({ type: "http.request", method: "POST" });
		expect(response).toMatchObject({
			type: "http.response",
			method: "POST",
			body: '{"name":"Acme"}',
			status: 200,
			responseBody: '{"ok":true}',
		});
	});

	it('details: "compact" does not repeat the request fields on the response', async () => {
		const printed = await printDetails("compact");
		expect(printed).toHaveLength(2);
		const [[, request], [, response]] = printed;
		expect(request).toMatchObject({ type: "http.request", method: "POST", body: '{"name":"Acme"}' });
		expect(response).toMatchObject({ type: "http.response", status: 200, attempt: 1, responseBody: '{"ok":true}' });
		expect(response).not.toHaveProperty("method");
		expect(response).not.toHaveProperty("url");
		expect(response).not.toHaveProperty("headers");
		expect(response).not.toHaveProperty("body");
	});

	it("log: { console: false } skips console loggers for one request and its token request", async () => {
		const custom = collector();
		const out = output();
		const filteredConsole = vi.fn<(message: string) => void>();
		const sf = createClient(oauthTransport(), {
			logger: [
				consoleLogger({ level: "debug", output: out }),
				filterLogger({ debug: filteredConsole }, () => true),
				custom.logger,
			],
			auth: clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" }),
		});
		await sf.request({ path: "/services/oauth2/userinfo", log: { console: false } });
		expect(out.lines).toEqual([]);
		expect(custom.types()).toEqual([
			"auth.request",
			"auth.response",
			"auth.tokenIssued",
			"http.request",
			"http.response",
		]);
		// A filterLogger around something that isn't a console still counts as custom.
		expect(filteredConsole).toHaveBeenCalled();

		await sf.instanceUrl({ log: { console: false } });
		expect(out.lines).toEqual([]);
		await sf.request({ path: "/limits" });
		expect(out.lines.length).toBeGreaterThan(0);
	});

	it("treats the global console and a filtered console as console loggers", () => {
		expect(isConsoleLogger(console)).toBe(true);
		expect(isConsoleLogger(filterLogger(console, () => true))).toBe(true);
		expect(isConsoleLogger(consoleLogger())).toBe(true);
		expect(isConsoleLogger(createLogger(() => undefined))).toBe(false);
	});
});

describe("flushLogs", () => {
	function deferredLogger(): { logger: SalesforceLogger; finish: () => void; done: string[] } {
		const done: string[] = [];
		const waiting: (() => void)[] = [];
		const logger = createLogger(
			(_level, message) =>
				new Promise<void>((resolve) => {
					waiting.push(() => {
						done.push(message);
						resolve();
					});
				}),
		);
		return { logger, done, finish: () => waiting.splice(0).forEach((resolve) => resolve()) };
	}

	it("waits for async loggers that requests didn't wait for", async () => {
		const { logger, finish, done } = deferredLogger();
		const sf = createClient(new FakeTransport().reply({ body: { ok: true } }), { logger });
		expect(await sf.request({ path: "/x" })).toEqual({ ok: true });
		expect(done).toEqual([]);

		let flushed = false;
		const flush = sf.flushLogs().then((result) => {
			flushed = result;
		});
		await Promise.resolve();
		expect(flushed).toBe(false);
		finish();
		await flush;
		expect(flushed).toBe(true);
		expect(done).toHaveLength(2);
	});

	it("resolves true right away with nothing pending, and ignores rejections", async () => {
		const sf = createClient(new FakeTransport().reply({ body: {} }), {
			logger: createLogger(() => Promise.reject(new Error("report failed"))),
		});
		await sf.request({ path: "/x" });
		expect(await sf.flushLogs()).toBe(true);
		expect(await createClient(new FakeTransport()).flushLogs()).toBe(true);
	});

	it("gives up after timeoutMs", async () => {
		const { logger, finish } = deferredLogger();
		const sf = createClient(new FakeTransport().reply({ body: {} }), { logger });
		await sf.request({ path: "/x" });
		expect(await sf.flushLogs({ timeoutMs: 5 })).toBe(false);
		finish();
		expect(await sf.flushLogs()).toBe(true);
	});

	it("covers hooks too", async () => {
		let resolveHook: () => void = () => undefined;
		const onResponse = (): Promise<void> =>
			new Promise<void>((resolve) => {
				resolveHook = resolve;
			});
		// oxlint-disable-next-line typescript/no-deprecated -- hooks are flushed as well
		const sf = createClient(new FakeTransport().reply({ body: {} }), { hooks: { onResponse } });
		await sf.request({ path: "/x" });
		expect(await sf.flushLogs({ timeoutMs: 5 })).toBe(false);
		resolveHook();
		expect(await sf.flushLogs()).toBe(true);
	});
});

const credentials = (): ReturnType<typeof clientCredentials> =>
	clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "SECRET" });

function printer(): Pick<Console, SalesforceLogLevel> & { lines: string[] } {
	const lines: string[] = [];
	const write = (message: string): void => {
		lines.push(message);
	};
	return { lines, debug: write, info: write, warn: write, error: write };
}

describe("logging is off by default", () => {
	it("logs nothing until a call turns it on, and then also its token request", async () => {
		const { logger, types } = collector();
		const sf = createBaseClient(oauthTransport(), { logger, auth: credentials() });
		await sf.request({ path: "/limits", log: true });
		expect(types()).toEqual(["auth.request", "auth.response", "auth.tokenIssued", "http.request", "http.response"]);

		const quiet = collector();
		const other = createBaseClient(oauthTransport([{ body: { name: "Account", fields: [] } }]), {
			logger: quiet.logger,
			auth: credentials(),
		});
		await other.sobject("Account").describe();
		await other.request({ path: "/limits" });
		await other.instanceUrl();
		expect(quiet.types()).toEqual([]);
	});

	it("logs to the custom loggers only with the client option log: { console: false }", async () => {
		const custom = collector();
		const out = printer();
		const sf = createBaseClient(new FakeTransport().reply({ body: {} }), {
			logger: [consoleLogger({ level: "debug", output: out }), custom.logger],
			log: { console: false },
		});
		await sf.request({ path: "/x" });
		expect(out.lines).toEqual([]);
		expect(custom.types()).toEqual(["http.request", "http.response"]);
	});

	it("keeps the deprecated hooks firing, unless a call or the client says log: false", async () => {
		const onRequest = vi.fn<() => void>();
		// oxlint-disable-next-line typescript/no-deprecated -- hooks keep their behavior
		const sf = createBaseClient(new FakeTransport().reply({ body: {} }, { body: {} }), { hooks: { onRequest } });
		await sf.request({ path: "/x" });
		await sf.request({ path: "/x", log: false });
		expect(onRequest).toHaveBeenCalledTimes(1);

		const silenced = vi.fn<() => void>();
		await createBaseClient(new FakeTransport().reply({ body: {} }), {
			// oxlint-disable-next-line typescript/no-deprecated -- hooks keep their behavior
			hooks: { onRequest: silenced },
			log: false,
		}).request({ path: "/x" });
		expect(silenced).not.toHaveBeenCalled();
	});
});

describe("withLog", () => {
	it("applies its setting to every call through the view, and a call's own log still wins", async () => {
		const { logger, types } = collector();
		const sf = createBaseClient(new FakeTransport(() => ({ body: { name: "Account", fields: [] } })), { logger });
		await sf.request({ path: "/a" });
		expect(types()).toEqual([]);

		const logged = sf.withLog(true);
		await logged.request({ path: "/b" });
		await logged.request({ path: "/c", log: false });
		await logged.sobject("Account").describe();
		expect(types()).toEqual(["http.request", "http.response", "cache.miss", "http.request", "http.response"]);
	});

	it("withLog(false) silences the calls and events of a logging client", async () => {
		const { logger, types } = collector();
		const job = (state: string): { body: Record<string, unknown> } => ({
			body: { id: "750J", object: "Account", operation: "insert", state },
		});
		const sf = createClient(new FakeTransport().reply(job("InProgress"), job("JobComplete")), { logger });
		const ingest = await sf.withLog(false).bulk.ingestJob("750J");
		await ingest.waitForCompletion({ pollIntervalMs: 1 });
		expect(types()).toEqual([]);
	});

	it("shares the token request, metadata cache, API usage and flushLogs with its client", async () => {
		let tokens = 0;
		let describes = 0;
		const transport = new FakeTransport((request) => {
			if (request.path === "/services/oauth2/token") {
				tokens++;
				return { body: tokenBody("TOKEN") };
			}
			describes++;
			return { body: { name: "Account", fields: [] }, headers: { "sforce-limit-info": "api-usage=5/100" } };
		});
		let settled = 0;
		const sf = createBaseClient(transport, {
			logger: createLogger(
				() =>
					new Promise<void>((resolve) => {
						setTimeout(() => {
							settled++;
							resolve();
						}, 5);
					}),
			),
			auth: credentials(),
		});
		const view = sf.withLog(true);
		await Promise.all([view.sobject("Account").describe(), sf.sobject("Account").describe()]);
		await sf.sobject("Account").describe();
		expect(tokens).toBe(1);
		expect(describes).toBe(1);
		expect(sf.apiUsage).toEqual({ used: 5, max: 100 });
		expect(view.apiUsage).toEqual({ used: 5, max: 100 });
		expect(await sf.flushLogs({ timeoutMs: 1_000 })).toBe(true);
		expect(settled).toBeGreaterThan(0);
	});
});

describe("shared work logs to every caller", () => {
	it("logs a shared token request once, also when the call that started it had log: false", async () => {
		const { logger, types } = collector();
		const sf = createClient(oauthTransport(), { logger, auth: credentials() });
		await Promise.all([sf.request({ path: "/a", log: false }), sf.request({ path: "/b" })]);
		expect(types()).toEqual(["auth.request", "auth.response", "auth.tokenIssued", "http.request", "http.response"]);
	});

	it("logs a token request shared by two logged calls once", async () => {
		const { logger, types } = collector();
		const sf = createClient(oauthTransport(), { logger, auth: credentials() });
		await Promise.all([sf.request({ path: "/a" }), sf.request({ path: "/b" })]);
		expect(types().filter((type) => type.startsWith("auth."))).toEqual([
			"auth.request",
			"auth.response",
			"auth.tokenIssued",
		]);
	});

	it("sends each logger the shared token request once when calls use different log settings", async () => {
		const custom = collector();
		const out = printer();
		const sf = createClient(oauthTransport(), {
			logger: [consoleLogger({ level: "debug", output: out }), custom.logger],
			auth: credentials(),
		});
		await Promise.all([sf.request({ path: "/a", log: { console: false } }), sf.request({ path: "/b" })]);
		expect(custom.types().filter((type) => type.startsWith("auth."))).toEqual([
			"auth.request",
			"auth.response",
			"auth.tokenIssued",
		]);
		expect(out.lines.filter((line) => line.includes("/services/oauth2/token"))).toHaveLength(2);
	});

	it("replays what was logged before a caller joined, in order", async () => {
		const { logger, types } = collector();
		let release = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transport = new FakeTransport(async (request) => {
			if (request.path === "/services/oauth2/token") {
				await gate;
				return { body: tokenBody("TOKEN") };
			}
			return { body: {} };
		});
		const sf = createClient(transport, { logger, auth: credentials() });
		const first = sf.request({ path: "/a", log: false });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(types()).toEqual([]);
		const second = sf.request({ path: "/b" });
		expect(types()).toEqual(["auth.request"]);
		release();
		await Promise.all([first, second]);
		expect(types()).toEqual(["auth.request", "auth.response", "auth.tokenIssued", "http.request", "http.response"]);
	});

	it("logs a shared metadata load to a caller that joined it", async () => {
		const { logger, types } = collector();
		const sf = createClient(new FakeTransport(() => ({ body: { name: "Account", fields: [] } })), { logger });
		await Promise.all([sf.withLog(false).sobject("Account").describe(), sf.sobject("Account").describe()]);
		expect(types()).toEqual(["cache.hit", "http.request", "http.response"]);
	});
});

describe("log on long-running operations", () => {
	it("bulk: the whole ingest, and later calls on its job, follow the option", async () => {
		const custom = collector();
		const out = printer();
		const job = (state: string): { body: Record<string, unknown> } => ({
			body: { id: "750J", object: "Account", operation: "insert", state },
		});
		const sf = createBaseClient(
			new FakeTransport().reply(job("Open"), { status: 201 }, job("UploadComplete"), job("JobComplete"), {
				body: "",
				headers: { "content-type": "text/csv" },
			}),
			{ logger: [consoleLogger({ level: "debug", output: out }), custom.logger] },
		);
		const ingest = await sf.bulk.ingest({
			object: "Account",
			operation: "insert",
			records: [{ Name: "Acme" }],
			wait: { pollIntervalMs: 1 },
			log: { console: false },
		});
		await ingest.failedResults();
		expect(out.lines).toEqual([]);
		expect(custom.types().filter((type) => type === "http.request")).toHaveLength(5);
		expect(custom.types()).toContain("bulk.jobState");
	});

	it("bulk: waitForCompletion({ log: false }) logs no polling", async () => {
		const { logger, types } = collector();
		const sf = createClient(
			new FakeTransport().reply(
				{ body: { id: "750J", state: "UploadComplete" } },
				{ body: { id: "750J", state: "JobComplete" } },
			),
			{ logger },
		);
		const ingest = await sf.bulk.ingestJob("750J");
		await ingest.waitForCompletion({ pollIntervalMs: 1, log: false });
		expect(types()).toEqual(["http.request", "http.response"]);
	});

	it("reports and Apex test runs follow their log option", async () => {
		const { logger, types } = collector();
		const transport = new FakeTransport().reply(
			{ body: { attributes: {} } },
			{ body: { numTestsRun: 1, numFailures: 0, totalTime: 5, successes: [], failures: [] } },
		);
		const sf = createClient(transport, { logger });
		await sf.reports.run("00OA00000000001", { log: false });
		await sf.tooling.runTestsSynchronous({ tests: [{ className: "MyTest" }] }, { log: false });
		expect(types()).toEqual([]);

		await createBaseClient(transport.reply({ body: { attributes: { status: "Success" } } }), {
			logger,
		}).reports.waitForInstance("00OA00000000001", "0LGA", { log: true });
		expect(types()).toEqual(["http.request", "http.response", "report.status"]);
	});
});
