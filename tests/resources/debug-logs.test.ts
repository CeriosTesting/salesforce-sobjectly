import { describe, expect, it, vi } from "vitest";

import { SalesforceError } from "../../src/errors";
import { DebugLogCaptureError } from "../../src/resources/debug-logs";
import { ApexExecutionError } from "../../src/resources/tooling";
import { API, createClient, type FakeResponse, FakeTransport, type RecordedRequest } from "../helpers/fake-transport";

interface OrgState {
	logs: { Id: string; Operation: string; Status: string; StartTime: string }[];
	traceFlag?: { Id: string; DebugLevelId: string; StartDate: string | null; ExpirationDate: string };
	debugLevel?: string;
	/** Response for deleting or restoring the trace flag. */
	restoreResponse?: FakeResponse;
}

/** Deleting the temporary trace flag, or patching the original one back (to debug level 7dlDEV). */
function isRestore(request: RecordedRequest): boolean {
	if (!request.path.includes("/TraceFlag/")) {
		return false;
	}
	return (
		request.method === "DELETE" ||
		(request.method === "PATCH" && (request.json as { DebugLevelId?: string }).DebugLevelId === "7dlDEV")
	);
}

/** A fake org that understands the Tooling calls debug-log capture makes. */
function fakeOrg(state: OrgState): FakeTransport {
	const query = (request: RecordedRequest): string => request.url.searchParams.get("q") ?? "";
	const page = (records: unknown[]): FakeResponse => ({
		body: { totalSize: records.length, done: true, records },
	});
	const queryResponse = (q: string): FakeResponse | undefined => {
		if (q.startsWith("SELECT Id, Operation")) {
			return page(
				state.logs.map((log) => ({ ...log, Request: "API", DurationMilliseconds: 5, LogLength: 10 })).reverse(),
			);
		}
		if (q.includes("FROM DebugLevel")) {
			return page(state.debugLevel ? [{ Id: state.debugLevel }] : []);
		}
		return q.includes("FROM TraceFlag") ? page(state.traceFlag ? [state.traceFlag] : []) : undefined;
	};
	const executeAnonymous = (request: RecordedRequest): FakeResponse => {
		state.logs.push({
			Id: `07LNEW${state.logs.length}`,
			Operation: "/services/data/v67.0/tooling/executeAnonymous",
			Status: "Success",
			StartTime: "2026-01-01T00:00:01Z",
		});
		const failing = (request.url.searchParams.get("anonymousBody") ?? "").includes("throw");
		return {
			body: {
				line: 1,
				column: 1,
				compiled: true,
				success: !failing,
				compileProblem: null,
				exceptionMessage: failing ? "boom" : null,
				exceptionStackTrace: null,
			},
		};
	};
	const created = (id: string): FakeResponse => ({ status: 201, body: { id, success: true, errors: [] } });
	return new FakeTransport((request) => {
		const q = query(request);
		const fromQuery = queryResponse(q);
		if (fromQuery) {
			return fromQuery;
		}
		if (request.path === "/services/oauth2/userinfo") {
			return { body: { user_id: "005U" } };
		}
		if (request.method === "POST" && request.path.endsWith("/tooling/sobjects/DebugLevel")) {
			state.debugLevel = "7dlNEW";
			return created("7dlNEW");
		}
		if (request.method === "POST" && request.path.endsWith("/tooling/sobjects/TraceFlag")) {
			return created("7tfNEW");
		}
		if (request.path.includes("/tooling/executeAnonymous")) {
			return executeAnonymous(request);
		}
		if (request.path.endsWith("/Body/")) {
			return { body: "USER_DEBUG|hello", headers: { "content-type": "text/plain" } };
		}
		if (state.restoreResponse && isRestore(request)) {
			return state.restoreResponse;
		}
		if (request.method === "PATCH" || request.method === "DELETE") {
			return { status: 204 };
		}
		throw new Error(`unexpected ${request.method} ${request.path} ${q}`);
	});
}

describe("debugLogs.capture", () => {
	it("creates a debug level and trace flag, collects new logs and removes the flag", async () => {
		const state: OrgState = {
			logs: [{ Id: "07LOLD", Operation: "old", Status: "Success", StartTime: "2025-01-01T00:00:00Z" }],
		};
		const transport = fakeOrg(state);
		const sf = createClient(transport);
		const { result, logs } = await sf.tooling.debugLogs.capture(
			() => sf.tooling.executeAnonymous("System.debug('hello');"),
			{ settleMs: 0 },
		);
		expect(result.success).toBe(true);
		expect(logs.map((log) => log.id)).toEqual(["07LNEW1"]);
		expect(logs[0]?.body).toBe("USER_DEBUG|hello");

		const debugLevel = transport.requests.find((request) => request.path.endsWith("/tooling/sobjects/DebugLevel"));
		expect(debugLevel?.json).toMatchObject({ DeveloperName: "sobjectly", ApexCode: "FINEST" });
		const traceFlag = transport.requests.find((request) => request.path.endsWith("/tooling/sobjects/TraceFlag"));
		expect(traceFlag?.json).toMatchObject({ TracedEntityId: "005U", LogType: "USER_DEBUG", DebugLevelId: "7dlNEW" });
		expect(
			transport.requests.some((request) => request.method === "DELETE" && request.path.endsWith("/TraceFlag/7tfNEW")),
		).toBe(true);
	});

	it("reuses and restores an existing trace flag", async () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const state: OrgState = {
			logs: [],
			debugLevel: "7dlOLD",
			traceFlag: { Id: "7tfOLD", DebugLevelId: "7dlDEV", StartDate: null, ExpirationDate: future },
		};
		const transport = fakeOrg(state);
		const sf = createClient(transport);
		await sf.tooling.debugLogs.capture(() => Promise.resolve("ok"), {
			settleMs: 0,
			userId: "005X",
			levels: { ApexCode: "DEBUG" },
		});
		const patches = transport.requests.filter((request) => request.method === "PATCH");
		expect(patches.map((request) => request.path)).toEqual([
			`${API}/tooling/sobjects/DebugLevel/7dlOLD`,
			`${API}/tooling/sobjects/TraceFlag/7tfOLD`,
			`${API}/tooling/sobjects/TraceFlag/7tfOLD`,
		]);
		expect(patches[0]?.json).toMatchObject({ ApexCode: "DEBUG" });
		expect(patches[2]?.json).toEqual({ DebugLevelId: "7dlDEV", StartDate: null, ExpirationDate: future });
		expect(transport.requests.some((request) => request.path === "/services/oauth2/userinfo")).toBe(false);
	});

	it("keeps the logs when the work throws", async () => {
		const sf = createClient(fakeOrg({ logs: [] }));
		const error = await sf.tooling.debugLogs
			.capture(
				async () => {
					await sf.tooling.executeAnonymous("throw", { throwOnError: false });
					throw new Error("assertion failed");
				},
				{ settleMs: 0 },
			)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DebugLogCaptureError);
		expect((error as DebugLogCaptureError).logs).toHaveLength(1);
		expect((error as Error).message).toContain("assertion failed");
	});

	it("attaches logs to executeAnonymous with captureLog", async () => {
		const sf = createClient(fakeOrg({ logs: [] }));
		const result = await sf.tooling.executeAnonymous("System.debug(1);", {
			captureLog: true,
			logOptions: { settleMs: 0 },
		});
		expect(result.logs[0]?.body).toBe("USER_DEBUG|hello");
		const error = await sf.tooling
			.executeAnonymous("throw", { captureLog: true, logOptions: { settleMs: 0 } })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApexExecutionError);
		expect((error as ApexExecutionError).logs).toHaveLength(1);
	});

	it("only looks at USER_DEBUG trace flags", async () => {
		const transport = fakeOrg({ logs: [] });
		await createClient(transport).tooling.debugLogs.capture(() => Promise.resolve(1), { settleMs: 0, userId: "005U" });
		const flagQuery = transport.requests
			.map((request) => request.url.searchParams.get("q") ?? "")
			.find((q) => q.includes("FROM TraceFlag"));
		expect(flagQuery).toContain("AND LogType = 'USER_DEBUG'");
	});

	it("runs captures for the same user one after another", async () => {
		const transport = fakeOrg({ logs: [] });
		const sf = createClient(transport);
		const order: string[] = [];
		let release: () => void = () => undefined;
		const first = sf.tooling.debugLogs.capture(
			async () => {
				order.push("first:start");
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				order.push("first:end");
			},
			{ settleMs: 0, userId: "005U" },
		);
		const second = sf.tooling.debugLogs.capture(
			() => {
				order.push("second");
				return Promise.resolve();
			},
			{ settleMs: 0, userId: "005U" },
		);
		await vi.waitFor(() => expect(order).toEqual(["first:start"]));
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("tolerates a trace flag that was removed meanwhile", async () => {
		const sf = createClient(
			fakeOrg({ logs: [], restoreResponse: { status: 404, body: [{ errorCode: "NOT_FOUND", message: "gone" }] } }),
		);
		const outcome = await sf.tooling.debugLogs.capture(() => Promise.resolve("ok"), { settleMs: 0, userId: "005U" });
		expect(outcome.result).toBe("ok");
		expect(outcome.cleanupError).toBeUndefined();
	});

	it("does not let a failed restore hide the work's result or error", async () => {
		const restoreResponse: FakeResponse = { status: 400, body: [{ errorCode: "INVALID_FIELD", message: "nope" }] };
		const sf = createClient(fakeOrg({ logs: [], restoreResponse }));
		const outcome = await sf.tooling.debugLogs.capture(() => Promise.resolve("ok"), { settleMs: 0, userId: "005U" });
		expect(outcome.result).toBe("ok");
		expect(outcome.cleanupError).toBeInstanceOf(SalesforceError);

		const error = await sf.tooling.debugLogs
			.capture(() => Promise.reject(new Error("assertion failed")), { settleMs: 0, userId: "005U" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DebugLogCaptureError);
		expect((error as DebugLogCaptureError).cause).toEqual(new Error("assertion failed"));
		expect((error as DebugLogCaptureError).cleanupError).toBeInstanceOf(SalesforceError);
	});
});
