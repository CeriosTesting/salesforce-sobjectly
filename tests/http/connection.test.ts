import { describe, expect, it, vi } from "vitest";

import { accessToken, tokenProvider } from "../../src/auth/providers";
import type { AccessToken } from "../../src/auth/types";
import { SalesforceError } from "../../src/errors";
import {
	parseBody,
	type RequestEvent,
	type ResponseEvent,
	SalesforceConnection,
	segment,
} from "../../src/http/connection";
import type { HttpTransport, TransportRequest } from "../../src/http/transport";
import {
	API,
	createClient,
	type FakeResponse,
	FakeTransport,
	INSTANCE_URL,
	type RecordedRequest,
	toTransportResponse,
} from "../helpers/fake-transport";

function connect(
	transport: FakeTransport,
	options: Partial<ConstructorParameters<typeof SalesforceConnection>[0]> = {},
): SalesforceConnection {
	return new SalesforceConnection({
		auth: accessToken({ accessToken: "TOKEN", instanceUrl: INSTANCE_URL }),
		transport,
		apiVersion: "v67.0",
		...options,
	});
}

describe("SalesforceConnection URL resolution", () => {
	const connection = connect(new FakeTransport());

	it("prefixes relative paths with the versioned data path", () => {
		expect(connection.resolveUrl("/limits", INSTANCE_URL).toString()).toBe(`${INSTANCE_URL}${API}/limits`);
		expect(connection.resolveUrl("sobjects", INSTANCE_URL).toString()).toBe(`${INSTANCE_URL}${API}/sobjects`);
	});

	it("keeps /services/ paths as they are", () => {
		expect(connection.resolveUrl("/services/apexrest/foo", INSTANCE_URL).pathname).toBe("/services/apexrest/foo");
		expect(connection.resolveUrl("/services/data/v60.0/query/01g-2000", INSTANCE_URL).pathname).toBe(
			"/services/data/v60.0/query/01g-2000",
		);
	});

	it("allows absolute URLs on the instance origin only", () => {
		expect(connection.resolveUrl(`${INSTANCE_URL}/services/data/`, INSTANCE_URL).origin).toBe(INSTANCE_URL);
		expect(() => connection.resolveUrl("https://evil.example.com/steal", INSTANCE_URL)).toThrow(/Refusing/);
		expect(() => connection.resolveUrl("//evil.example.com/steal", INSTANCE_URL)).not.toThrow();
		expect(connection.resolveUrl("//evil.example.com/steal", INSTANCE_URL).origin).toBe(INSTANCE_URL);
	});

	it("allows configured extra origins", () => {
		const custom = connect(new FakeTransport(), { allowedOrigins: ["https://files.example.com/"] });
		expect(custom.resolveUrl("https://files.example.com/a", INSTANCE_URL).origin).toBe("https://files.example.com");
	});

	it("encodes query parameters, joins arrays and skips empty values", () => {
		const url = connection.resolveUrl("/query", INSTANCE_URL, {
			q: "SELECT Id FROM Account WHERE Name = 'A&B'",
			fields: ["Id", "Name"],
			skip: undefined,
			none: null,
			at: new Date("2026-01-02T03:04:05.000Z"),
			flag: true,
		});
		expect(url.searchParams.get("q")).toBe("SELECT Id FROM Account WHERE Name = 'A&B'");
		expect(url.searchParams.get("fields")).toBe("Id,Name");
		expect(url.searchParams.has("skip")).toBe(false);
		expect(url.searchParams.has("none")).toBe(false);
		expect(url.searchParams.get("at")).toBe("2026-01-02T03:04:05.000Z");
		expect(url.searchParams.get("flag")).toBe("true");
	});

	it("rejects malformed API versions", () => {
		expect(() => connect(new FakeTransport(), { apiVersion: "67" as "v67.0" })).toThrow(/invalid apiVersion "67"/);
		expect(() => connect(new FakeTransport(), { apiVersion: undefined as never })).toThrow(
			/apiVersion is required.*API_VERSION/,
		);
	});
});

describe("SalesforceConnection requests", () => {
	it("sends JSON with auth and accept headers", async () => {
		const transport = new FakeTransport().reply({ body: { ok: true } });
		const result = await connect(transport).request({ method: "POST", path: "/x", body: { a: 1 } });
		expect(result).toEqual({ ok: true });
		expect(transport.last.headers.get("authorization")).toBe("Bearer TOKEN");
		expect(transport.last.headers.get("content-type")).toBe("application/json");
		expect(transport.last.headers.get("accept")).toBe("application/json");
		expect(transport.last.json).toEqual({ a: 1 });
	});

	it("parses 204, text and binary responses", async () => {
		const transport = new FakeTransport().reply(
			{ status: 204 },
			{ body: "hello", headers: { "content-type": "text/csv" } },
			{ body: new Uint8Array([1, 2, 3]), headers: { "content-type": "application/octet-stream" } },
			{ body: new Uint8Array([4]), headers: { "content-type": "application/json" } },
		);
		const connection = connect(transport);
		expect(await connection.request({ path: "/a" })).toBeUndefined();
		expect(await connection.request({ path: "/b" })).toBe("hello");
		expect(await connection.request({ path: "/c" })).toEqual(new Uint8Array([1, 2, 3]));
		expect(await connection.request({ path: "/d", responseType: "binary" })).toEqual(new Uint8Array([4]));
	});

	it("throws SalesforceError with the Salesforce error details and no query string", async () => {
		const transport = new FakeTransport().reply({
			status: 400,
			body: [{ message: "unexpected token: FORM", errorCode: "MALFORMED_QUERY" }],
			headers: { "sforce-limit-info": "api-usage=5/15000", "set-cookie": "secret=1" },
		});
		const error = await connect(transport)
			.request({ path: "/query?q=SELECT+secret", query: { q: "x" } })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceError);
		const salesforceError = error as SalesforceError;
		expect(salesforceError.status).toBe(400);
		expect(salesforceError.errorCode).toBe("MALFORMED_QUERY");
		expect(salesforceError.path).toBe("/query");
		expect(salesforceError.message).toContain("MALFORMED_QUERY: unexpected token: FORM");
		expect(salesforceError.message).not.toContain("secret");
		expect(salesforceError.limitInfo).toBe("api-usage=5/15000");
		expect(salesforceError.headers["set-cookie"]).toBeUndefined();
	});

	it("tracks API usage from Sforce-Limit-Info", async () => {
		const transport = new FakeTransport().reply({ body: {}, headers: { "sforce-limit-info": "api-usage=18/15000" } });
		const connection = connect(transport);
		await connection.request({ path: "/x" });
		expect(connection.apiUsage).toEqual({ used: 18, max: 15000 });
	});

	it("re-authenticates once on 401 and retries with the new token", async () => {
		const tokens = ["OLD", "NEW"];
		const fetchToken = vi.fn<() => Promise<AccessToken>>((): Promise<AccessToken> =>
			Promise.resolve({ accessToken: tokens.shift() ?? "X", instanceUrl: INSTANCE_URL }),
		);
		const transport = new FakeTransport().reply(
			{ status: 401, body: [{ message: "Session expired", errorCode: "INVALID_SESSION_ID" }] },
			{ body: { ok: 1 } },
		);
		const connection = connect(transport, { auth: tokenProvider(fetchToken) });
		expect(await connection.request({ path: "/x" })).toEqual({ ok: 1 });
		expect(fetchToken).toHaveBeenCalledTimes(2);
		expect(transport.requests.map((request) => request.headers.get("authorization"))).toEqual([
			"Bearer OLD",
			"Bearer NEW",
		]);
	});

	it("does not loop when the token cannot be refreshed", async () => {
		const transport = new FakeTransport().reply(
			{ status: 401, body: [{ message: "bad", errorCode: "INVALID_SESSION_ID" }] },
			{ status: 401, body: [{ message: "bad", errorCode: "INVALID_SESSION_ID" }] },
		);
		const fetchToken = vi.fn<() => Promise<AccessToken>>((): Promise<AccessToken> =>
			Promise.resolve({ accessToken: "SAME", instanceUrl: INSTANCE_URL }),
		);
		await expect(connect(transport, { auth: tokenProvider(fetchToken) }).request({ path: "/x" })).rejects.toMatchObject(
			{ status: 401 },
		);
		expect(transport.requests).toHaveLength(1);
	});

	it("does not retry by default", async () => {
		const transport = new FakeTransport().reply({ status: 503, body: "busy" });
		await expect(connect(transport).request({ path: "/x" })).rejects.toBeInstanceOf(SalesforceError);
		expect(transport.requests).toHaveLength(1);
	});

	it("retries idempotent requests on 429/503 when enabled, honouring Retry-After", async () => {
		const transport = new FakeTransport().reply(
			{ status: 429, headers: { "retry-after": "0" } },
			{ status: 503 },
			{ body: { ok: true } },
		);
		const connection = connect(transport, { retry: { baseDelayMs: 1 } });
		expect(await connection.request({ path: "/x" })).toEqual({ ok: true });
		expect(transport.requests).toHaveLength(3);
	});

	it("never retries mutations unless the request opts in", async () => {
		const transport = new FakeTransport().reply({ status: 503 }, { status: 503 }, { body: { ok: true } });
		const connection = connect(transport, { retry: { baseDelayMs: 1 } });
		await expect(connection.request({ method: "POST", path: "/x", body: {} })).rejects.toMatchObject({ status: 503 });
		expect(await connection.request({ method: "POST", path: "/x", body: {}, retry: true })).toEqual({ ok: true });
	});

	it("passes redacted events to hooks", async () => {
		const onRequest = vi.fn<(event: RequestEvent) => void>();
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const transport = new FakeTransport().reply({ body: {} });
		await connect(transport, { hooks: { onRequest, onResponse } }).request({ path: "/x" });
		expect(onRequest.mock.calls[0]?.[0]).toMatchObject({
			method: "GET",
			url: `${INSTANCE_URL}${API}/x`,
			headers: { authorization: "Bearer [REDACTED]" },
		});
		expect(onResponse.mock.calls[0]?.[0]).toMatchObject({ status: 200 });
		expect(JSON.stringify([onRequest.mock.calls, onResponse.mock.calls])).not.toContain("TOKEN");
	});

	it("passes request and response bodies to hooks", async () => {
		const onRequest = vi.fn<(event: RequestEvent) => void>();
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const transport = new FakeTransport().reply({ status: 201, body: { id: "001A", success: true } });
		await connect(transport, { hooks: { onRequest, onResponse } }).request({
			method: "POST",
			path: "/sobjects/Account",
			body: { Name: "Acme" },
		});
		expect(onRequest.mock.calls[0]?.[0].body).toBe('{"Name":"Acme"}');
		expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
			status: 201,
			body: '{"Name":"Acme"}',
			responseBody: '{"id":"001A","success":true}',
		});
	});

	it("passes no body for empty requests and responses, and bytes for binary responses", async () => {
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const bytes = new Uint8Array([1, 2, 3]);
		const transport = new FakeTransport().reply(
			{ status: 204 },
			{ body: bytes, headers: { "content-type": "application/octet-stream" } },
		);
		const connection = connect(transport, { hooks: { onResponse } });
		await connection.request({ method: "DELETE", path: "/sobjects/Account/001A" });
		await connection.request({ path: "/sobjects/ContentVersion/068A/VersionData", responseType: "binary" });
		expect(onResponse.mock.calls[0]?.[0].body).toBeUndefined();
		expect(onResponse.mock.calls[0]?.[0].responseBody).toBeUndefined();
		expect(onResponse.mock.calls[1]?.[0].responseBody).toEqual(bytes);
	});

	it("passes the bodies to hooks on every attempt", async () => {
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const transport = new FakeTransport().reply({ status: 503, body: "busy" }, { body: { ok: true } });
		await connect(transport, { retry: { baseDelayMs: 1 }, hooks: { onResponse } }).request({
			method: "POST",
			path: "/x",
			body: { a: 1 },
			retry: true,
		});
		expect(
			onResponse.mock.calls.map(([event]) => [event.attempt, event.status, event.body, event.responseBody]),
		).toEqual([
			[1, 503, '{"a":1}', "busy"],
			[2, 200, '{"a":1}', '{"ok":true}'],
		]);
	});

	it("ignores hooks that throw or return a rejected promise", async () => {
		const unhandled = vi.fn<(reason: unknown) => void>();
		process.on("unhandledRejection", unhandled);
		try {
			const transport = new FakeTransport().reply({ body: { ok: true } });
			const hooks = {
				onRequest: (): never => {
					throw new Error("sync hook failure");
				},
				onResponse: (): Promise<void> => Promise.reject(new Error("async hook failure")),
			};
			expect(await connect(transport, { hooks }).request({ path: "/x" })).toEqual({ ok: true });
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("aborts on timeout and on the caller's signal", async () => {
		const hang = (request: RecordedRequest): Promise<FakeResponse> =>
			new Promise((_resolve, reject) => {
				const signal = request.signal;
				if (signal?.aborted) {
					reject(signal.reason as Error);
				}
				signal?.addEventListener("abort", () => reject(signal.reason as Error));
			});
		await expect(connect(new FakeTransport(hang), { timeoutMs: 10 }).request({ path: "/x" })).rejects.toMatchObject({
			name: "TimeoutError",
		});
		const controller = new AbortController();
		const pending = connect(new FakeTransport(hang)).request({ path: "/x", signal: controller.signal });
		controller.abort(new Error("stop"));
		await expect(pending).rejects.toThrow("stop");
	});

	it("sends strings, bytes and URLSearchParams as-is", async () => {
		const transport = new FakeTransport().reply({ status: 204 }, { status: 204 }, { status: 204 });
		const connection = connect(transport);
		await connection.request({ method: "PUT", path: "/a", body: "a,b", headers: { "Content-Type": "text/csv" } });
		expect(transport.last.headers.get("content-type")).toBe("text/csv");
		expect(transport.last.body).toBe("a,b");
		await connection.request({ method: "POST", path: "/b", body: new Uint8Array([65]) });
		expect(transport.last.headers.get("content-type")).toBe("application/octet-stream");
		await connection.request({ method: "POST", path: "/c", body: new URLSearchParams({ a: "1" }) });
		expect(transport.last.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(transport.last.body).toBe("a=1");
	});
});

/** A transport that keeps the raw request bodies, so binary bodies can be compared byte for byte. */
function bodyRecorder(): HttpTransport & { bodies: TransportRequest["body"][]; contentTypes: (string | null)[] } {
	const bodies: TransportRequest["body"][] = [];
	const contentTypes: (string | null)[] = [];
	return {
		bodies,
		contentTypes,
		send: (request) => {
			bodies.push(request.body);
			contentTypes.push(request.headers.get("content-type"));
			return Promise.resolve(toTransportResponse({ status: 204 }));
		},
	};
}

describe("SalesforceConnection request body encoding", () => {
	const send = async (
		body: unknown,
		headers?: Record<string, string>,
	): Promise<{ bytes: number[]; raw: TransportRequest["body"]; contentType: string | null }> => {
		const transport = bodyRecorder();
		await new SalesforceConnection({
			auth: accessToken({ accessToken: "TOKEN", instanceUrl: INSTANCE_URL }),
			transport,
			apiVersion: "v67.0",
		}).request({ method: "POST", path: "/x", body, headers });
		const raw = transport.bodies[0];
		return { raw, bytes: raw instanceof Uint8Array ? [...raw] : [], contentType: transport.contentTypes[0] ?? null };
	};

	it("sends an ArrayBuffer as its bytes", async () => {
		const result = await send(new Uint8Array([1, 2, 3, 255]).buffer);
		expect(result.raw).toBeInstanceOf(Uint8Array);
		expect(result.bytes).toEqual([1, 2, 3, 255]);
		expect(result.contentType).toBe("application/octet-stream");
	});

	it("sends only the viewed bytes of a Uint8Array subarray", async () => {
		const whole = new Uint8Array([10, 20, 30, 40, 50]);
		expect((await send(whole.subarray(1, 4))).bytes).toEqual([20, 30, 40]);
	});

	it("sends other typed arrays and DataViews as their raw bytes", async () => {
		const words = new Uint16Array([0x0102, 0x0304, 0x0506]);
		const view = words.subarray(1, 2);
		const wordBytes = await send(view);
		expect(wordBytes.bytes).toEqual([...new Uint8Array(words.buffer, view.byteOffset, view.byteLength)]);
		expect(wordBytes.bytes).toHaveLength(2);

		const buffer = new Uint8Array([9, 8, 7, 6, 5]).buffer;
		const dataView = await send(new DataView(buffer, 1, 3));
		expect(dataView.bytes).toEqual([8, 7, 6]);
		expect(dataView.contentType).toBe("application/octet-stream");

		const floats = await send(new Float32Array([1.5]));
		expect(floats.raw).toBeInstanceOf(Uint8Array);
		expect(floats.bytes).toHaveLength(4);
	});

	it("keeps an explicit Content-Type for binary bodies", async () => {
		const result = await send(new Uint8Array([1]).buffer, { "Content-Type": "image/png" });
		expect(result.contentType).toBe("image/png");
	});

	it("rejects Blob, FormData and stream bodies with a TypeError instead of sending {}", async () => {
		for (const body of [new Blob(["abc"]), new FormData(), new ReadableStream()]) {
			const transport = new FakeTransport().reply({ status: 204 });
			const error = await connect(transport)
				.request({ method: "POST", path: "/x", body })
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toMatch(/Unsupported request body: Blob, FormData and streams can't be sent/);
			expect(transport.requests).toHaveLength(0);
		}
	});
});

describe("SalesforceConnection response parsing", () => {
	it("throws on invalid JSON in a successful JSON response instead of returning text", async () => {
		const transport = new FakeTransport().reply({
			body: "<html>Maintenance</html>",
			headers: { "content-type": "application/json;charset=UTF-8" },
		});
		const error = await connect(transport)
			.request({ path: "/x" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(SalesforceError);
		expect((error as Error).message).toBe(
			'Salesforce returned invalid JSON (status 200, content-type "application/json;charset=utf-8"): <html>Maintenance</html>',
		);
	});

	it("throws on invalid JSON when responseType is json, whatever the Content-Type", async () => {
		const transport = new FakeTransport().reply({ body: "not json", headers: { "content-type": "text/plain" } });
		await expect(connect(transport).request({ path: "/x", responseType: "json" })).rejects.toThrow(
			'invalid JSON (status 200, content-type "text/plain"): not json',
		);
	});

	it("truncates the invalid body in the message", async () => {
		const transport = new FakeTransport().reply({
			body: `{${"x".repeat(1000)}`,
			headers: { "content-type": "application/json" },
		});
		const error = await connect(transport)
			.request({ path: "/x" })
			.catch((caught: unknown) => caught);
		expect((error as Error).message.length).toBeLessThan(300);
	});

	it("still returns text for text responses and responseType text", async () => {
		const transport = new FakeTransport().reply(
			{ body: "plain text", headers: { "content-type": "text/plain" } },
			{ body: "{broken", headers: { "content-type": "application/json" } },
		);
		const connection = connect(transport);
		expect(await connection.request({ path: "/a" })).toBe("plain text");
		expect(await connection.request({ path: "/b", responseType: "text" })).toBe("{broken");
	});

	it("keeps an invalid JSON error body as text on the SalesforceError", async () => {
		const transport = new FakeTransport().reply({
			status: 502,
			body: "Bad Gateway",
			headers: { "content-type": "application/json" },
		});
		const error = await connect(transport)
			.request({ path: "/x" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceError);
		expect((error as SalesforceError).body).toBe("Bad Gateway");
		expect((error as SalesforceError).message).toContain("status 502 - Bad Gateway");
	});

	it("parseBody is lenient unless strict", () => {
		const response = toTransportResponse({ body: "nope", headers: { "content-type": "application/json" } });
		expect(parseBody(response, "auto")).toBe("nope");
		expect(() => parseBody(response, "auto", true)).toThrow(/invalid JSON/);
		expect(parseBody(toTransportResponse({ status: 204 }), "json", true)).toBeUndefined();
	});
});

describe("segment", () => {
	it("encodes ids, names and external id values", () => {
		expect(segment("001A0000001")).toBe("001A0000001");
		expect(segment("a/b?c#d")).toBe("a%2Fb%3Fc%23d");
		expect(segment("Ünïcode value")).toBe("%C3%9Cn%C3%AFcode%20value");
		expect(segment("...")).toBe("...");
		expect(segment(".hidden")).toBe(".hidden");
	});

	it('rejects "." and ".."', () => {
		expect(() => segment(".")).toThrow('"." is not a valid id or name in a URL path.');
		expect(() => segment("..")).toThrow('".." is not a valid id or name in a URL path.');
	});

	it("keeps dot segments from changing which resource is called", async () => {
		const transport = new FakeTransport().reply({ status: 204 });
		const sf = createClient(transport);
		await expect(sf.sobject("Account").delete("..")).rejects.toThrow(/not a valid id/);
		expect(transport.requests).toHaveLength(0);
	});
});
