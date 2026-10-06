import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { accessToken, tokenProvider } from "../../src/auth/providers";
import type { AccessToken } from "../../src/auth/types";
import { SalesforceClient } from "../../src/client";
import { SalesforceError } from "../../src/errors";
import { type ConnectionOptions, type ResponseEvent, SalesforceConnection } from "../../src/http/connection";
import type {
	HttpTransport,
	StreamingTransportResponse,
	TransportRequest,
	TransportResponse,
} from "../../src/http/transport";
import { CsvRowParser, parseCsvStream } from "../../src/resources/csv";
import { createClient, FakeTransport, INSTANCE_URL } from "../helpers/fake-transport";

describe("retry on error codes", () => {
	const lock = {
		status: 400,
		body: [{ errorCode: "UNABLE_TO_LOCK_ROW", message: "unable to obtain exclusive access" }],
	};

	it("retries mutations that failed with a configured error code", async () => {
		const transport = new FakeTransport().reply(lock, lock, { status: 204 });
		const sf = createClient(transport, { retry: { errorCodes: ["UNABLE_TO_LOCK_ROW"], baseDelayMs: 1 } });
		await sf.sobject("Account").update("001A", { Name: "Acme" });
		expect(transport.requests).toHaveLength(3);
		expect(transport.requests.every((request) => request.method === "PATCH")).toBe(true);
	});

	it("does not retry other errors or when not configured", async () => {
		const transport = new FakeTransport().reply(
			{ status: 400, body: [{ errorCode: "REQUIRED_FIELD_MISSING", message: "missing" }] },
			lock,
		);
		const sf = createClient(transport, { retry: { errorCodes: ["UNABLE_TO_LOCK_ROW"], baseDelayMs: 1 } });
		await expect(sf.sobject("Account").update("001A", {})).rejects.toBeInstanceOf(SalesforceError);
		await expect(
			createClient(new FakeTransport().reply(lock)).sobject("Account").update("001A", {}),
		).rejects.toMatchObject({
			errorCode: "UNABLE_TO_LOCK_ROW",
		});
		expect(transport.requests).toHaveLength(1);
	});
});

describe("CsvRowParser", () => {
	it("handles quotes, escaped quotes and CRLF split across chunks", () => {
		const parser = new CsvRowParser();
		const text = '﻿Id,Name\r\n1,"Acme, ""Inc"""\r\n2,"multi\nline"\r\n3,plain';
		const rows: string[][] = [];
		for (let index = 0; index < text.length; index += 3) {
			rows.push(...parser.push(text.slice(index, index + 3)));
		}
		rows.push(...parser.end());
		expect(rows).toEqual([
			["Id", "Name"],
			["1", 'Acme, "Inc"'],
			["2", "multi\nline"],
			["3", "plain"],
		]);
	});

	it("parses a byte stream split inside multi-byte characters", async () => {
		const bytes = new TextEncoder().encode("Name,City\nZoë,Zürich\n");
		async function* chunks(): AsyncGenerator<Uint8Array> {
			for (let index = 0; index < bytes.length; index += 2) {
				yield await Promise.resolve(bytes.slice(index, index + 2));
			}
		}
		const rows = [];
		for await (const row of parseCsvStream(chunks())) {
			rows.push(row);
		}
		expect(rows).toEqual([{ Name: "Zoë", City: "Zürich" }]);
	});
});

describe("bulk query streaming over fetch", () => {
	let server: Server;
	let baseUrl: string;
	const pagesServed: string[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname.endsWith("/jobs/query/750J")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "750J", state: "JobComplete", columnDelimiter: "COMMA", lineEnding: "LF" }));
				return;
			}
			if (url.pathname.endsWith("/jobs/query/750J/results")) {
				const locator = url.searchParams.get("locator");
				pagesServed.push(locator ?? "first");
				res.writeHead(200, { "content-type": "text/csv", "sforce-locator": locator ? "null" : "PAGE2" });
				// Send the CSV in small chunks, split inside a quoted field.
				const csv = locator ? 'Id,Name\n3,"Globex"\n' : 'Id,Name\n1,"Acme, Inc"\n2,Initech\n';
				const parts = csv.match(/.{1,4}/gs) ?? [];
				const write = (index: number): void => {
					if (index >= parts.length) {
						res.end();
						return;
					}
					res.write(parts[index]);
					setTimeout(() => write(index + 1), 1);
				};
				write(0);
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify([{ errorCode: "NOT_FOUND", message: url.pathname }]));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("streams rows across result pages", async () => {
		const sf = new SalesforceClient({
			auth: accessToken({ accessToken: "t", instanceUrl: baseUrl }),
			apiVersion: "v67.0",
		});
		const job = await sf.bulk.queryJob("750J");
		const rows = [];
		for await (const row of job.records()) {
			rows.push(row);
		}
		expect(rows).toEqual([
			{ Id: "1", Name: "Acme, Inc" },
			{ Id: "2", Name: "Initech" },
			{ Id: "3", Name: "Globex" },
		]);
		expect(pagesServed).toEqual(["first", "PAGE2"]);
	});
});

const encoder = new TextEncoder();
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface StreamReply {
	status?: number;
	headers?: Record<string, string>;
	/** Body chunks, sent one by one. */
	chunks?: string[];
	/** Delay before the response headers arrive. */
	headerDelayMs?: number;
	/** Delay before each body chunk. */
	chunkDelayMs?: number;
}

/** A transport whose `stream` serves scripted replies, honouring the request signal while waiting for headers. */
class StreamingFakeTransport implements HttpTransport {
	readonly requests: TransportRequest[] = [];
	private readonly _queue: StreamReply[];

	constructor(...replies: StreamReply[]) {
		this._queue = replies;
	}

	send(request: TransportRequest): Promise<TransportResponse> {
		return Promise.reject(new Error(`send() should not be used for ${request.url.toString()}`));
	}

	async stream(request: TransportRequest): Promise<StreamingTransportResponse> {
		this.requests.push(request);
		const reply = this._queue.shift();
		if (!reply) {
			throw new Error(`Unexpected request ${request.url.toString()}`);
		}
		if (reply.headerDelayMs) {
			await new Promise<void>((resolve, reject) => {
				const signal = request.signal;
				const timer = setTimeout(resolve, reply.headerDelayMs);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(signal.reason as Error);
					},
					{ once: true },
				);
			});
		}
		const chunks = reply.chunks ?? [];
		const chunkDelayMs = reply.chunkDelayMs ?? 0;
		const signal = request.signal;
		async function* body(): AsyncGenerator<Uint8Array> {
			for (const chunk of chunks) {
				if (chunkDelayMs > 0) {
					await delay(chunkDelayMs);
				}
				// Like fetch: an aborted request signal also breaks reading the body.
				signal?.throwIfAborted();
				yield encoder.encode(chunk);
			}
		}
		return { status: reply.status ?? 200, headers: new Headers(reply.headers), body: body() };
	}
}

function streamingConnection(transport: HttpTransport, options: Partial<ConnectionOptions> = {}): SalesforceConnection {
	return new SalesforceConnection({
		auth: accessToken({ accessToken: "TOKEN", instanceUrl: INSTANCE_URL }),
		transport,
		apiVersion: "v67.0",
		...options,
	});
}

async function readText(response: StreamingTransportResponse | undefined): Promise<string> {
	if (!response) {
		throw new Error("Expected a streamed response.");
	}
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of response.body) {
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
}

const errorBody = (errorCode: string, message: string): string[] => {
	const json = JSON.stringify([{ errorCode, message }]);
	// Split the error body across chunks to check it is collected before parsing.
	return [json.slice(0, 10), json.slice(10)];
};

describe("SalesforceConnection.stream", () => {
	it("returns undefined when the transport cannot stream", async () => {
		const transport = new FakeTransport();
		await expect(streamingConnection(transport).stream({ path: "/x" })).resolves.toBeUndefined();
		expect(transport.requests).toHaveLength(0);
	});

	it("only times out waiting for headers, not while the body is read slowly", async () => {
		const transport = new StreamingFakeTransport({
			headers: { "content-type": "text/csv" },
			chunks: ["Id\n", "1\n", "2\n"],
			chunkDelayMs: 40,
		});
		const response = await streamingConnection(transport, { timeoutMs: 25 }).stream({
			path: "/jobs/query/750/results",
		});
		expect(response?.status).toBe(200);
		// Reading takes ~120 ms, well past the 25 ms timeout.
		expect(await readText(response)).toBe("Id\n1\n2\n");
		expect(transport.requests[0]?.signal?.aborted).toBe(false);
		// The transport is not given its own per-request timeout either.
		expect(transport.requests[0]?.timeoutMs).toBeUndefined();
	});

	it("times out when the headers are late", async () => {
		const transport = new StreamingFakeTransport({ headerDelayMs: 1_000, chunks: ["late"] });
		await expect(streamingConnection(transport, { timeoutMs: 20 }).stream({ path: "/x" })).rejects.toMatchObject({
			name: "TimeoutError",
			message: "The request timed out after 20 ms.",
		});
		expect(transport.requests[0]?.signal?.aborted).toBe(true);
	});

	it("waits for headers indefinitely with timeoutMs 0", async () => {
		const transport = new StreamingFakeTransport({ headerDelayMs: 30, chunks: ["ok"] });
		const response = await streamingConnection(transport, { timeoutMs: 0 }).stream({ path: "/x" });
		expect(await readText(response)).toBe("ok");
	});

	it("aborts on the caller's signal while waiting for headers", async () => {
		const transport = new StreamingFakeTransport({ headerDelayMs: 1_000 });
		const controller = new AbortController();
		const pending = streamingConnection(transport).stream({ path: "/x", signal: controller.signal });
		await delay(5);
		controller.abort(new Error("caller stopped"));
		await expect(pending).rejects.toThrow("caller stopped");
	});

	it("buffers a non-2xx body and throws SalesforceError with its details", async () => {
		const transport = new StreamingFakeTransport({
			status: 404,
			headers: { "content-type": "application/json", "sforce-limit-info": "api-usage=3/15000" },
			chunks: errorBody("NOT_FOUND", "The requested resource does not exist"),
		});
		const error = await streamingConnection(transport)
			.stream({ path: "/jobs/query/750/results?locator=abc" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceError);
		expect(error).toMatchObject({
			status: 404,
			errorCode: "NOT_FOUND",
			path: "/jobs/query/750/results",
			limitInfo: "api-usage=3/15000",
		});
		expect(transport.requests).toHaveLength(1);
	});

	it("passes the buffered error body to hooks and still throws SalesforceError", async () => {
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const transport = new StreamingFakeTransport({
			status: 404,
			headers: { "content-type": "application/json" },
			chunks: errorBody("NOT_FOUND", "The requested resource does not exist"),
		});
		await expect(
			streamingConnection(transport, { hooks: { onResponse } }).stream({ path: "/x" }),
		).rejects.toBeInstanceOf(SalesforceError);
		expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
			status: 404,
			responseBody: JSON.stringify([{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]),
		});
	});

	it("passes no response body to hooks for a successful stream", async () => {
		const onResponse = vi.fn<(event: ResponseEvent) => void>();
		const transport = new StreamingFakeTransport({ headers: { "content-type": "text/csv" }, chunks: ["Id\n1\n"] });
		const response = await streamingConnection(transport, { hooks: { onResponse } }).stream({ path: "/x" });
		expect(onResponse.mock.calls[0]?.[0].status).toBe(200);
		expect(onResponse.mock.calls[0]?.[0].responseBody).toBeUndefined();
		expect(await readText(response)).toBe("Id\n1\n");
	});

	it("retries a 503 when retries are enabled", async () => {
		const transport = new StreamingFakeTransport(
			{ status: 503, headers: { "retry-after": "0" }, chunks: ["busy"] },
			{ headers: { "content-type": "text/csv" }, chunks: ["Id\n1\n"] },
		);
		const response = await streamingConnection(transport, { retry: { baseDelayMs: 1 } }).stream({ path: "/x" });
		expect(await readText(response)).toBe("Id\n1\n");
		expect(transport.requests).toHaveLength(2);
	});

	it("does not retry a 503 by default and gives up after the configured retries", async () => {
		const busy = (): StreamReply => ({ status: 503, chunks: ["busy"] });
		const once = new StreamingFakeTransport(busy());
		await expect(streamingConnection(once).stream({ path: "/x" })).rejects.toMatchObject({ status: 503 });
		expect(once.requests).toHaveLength(1);

		const limited = new StreamingFakeTransport(busy(), busy(), busy());
		await expect(
			streamingConnection(limited, { retry: { retries: 1, baseDelayMs: 1 } }).stream({ path: "/x" }),
		).rejects.toMatchObject({ status: 503 });
		expect(limited.requests).toHaveLength(2);
	});

	it("retries on a configured error code in the streamed error body", async () => {
		const transport = new StreamingFakeTransport(
			{
				status: 400,
				headers: { "content-type": "application/json" },
				chunks: errorBody("UNABLE_TO_LOCK_ROW", "locked"),
			},
			{ chunks: ["done"] },
		);
		const response = await streamingConnection(transport, {
			retry: { errorCodes: ["UNABLE_TO_LOCK_ROW"], baseDelayMs: 1 },
		}).stream({ path: "/x" });
		expect(await readText(response)).toBe("done");
		expect(transport.requests).toHaveLength(2);
	});

	it("re-authenticates once on 401 and retries with the new token", async () => {
		const tokens = ["OLD", "NEW"];
		const fetchToken = vi.fn<() => Promise<AccessToken>>((): Promise<AccessToken> =>
			Promise.resolve({ accessToken: tokens.shift() ?? "X", instanceUrl: INSTANCE_URL }),
		);
		const transport = new StreamingFakeTransport(
			{
				status: 401,
				headers: { "content-type": "application/json" },
				chunks: errorBody("INVALID_SESSION_ID", "Session expired"),
			},
			{ chunks: ["ok"] },
		);
		const response = await streamingConnection(transport, { auth: tokenProvider(fetchToken) }).stream({ path: "/x" });
		expect(await readText(response)).toBe("ok");
		expect(fetchToken).toHaveBeenCalledTimes(2);
		expect(transport.requests.map((request) => request.headers.get("authorization"))).toEqual([
			"Bearer OLD",
			"Bearer NEW",
		]);
	});

	it("throws the 401 when re-authentication returns the same token", async () => {
		const fetchToken = vi.fn<() => Promise<AccessToken>>((): Promise<AccessToken> =>
			Promise.resolve({ accessToken: "SAME", instanceUrl: INSTANCE_URL }),
		);
		const transport = new StreamingFakeTransport(
			{
				status: 401,
				headers: { "content-type": "application/json" },
				chunks: errorBody("INVALID_SESSION_ID", "Session expired"),
			},
			{ chunks: ["never"] },
		);
		await expect(
			streamingConnection(transport, { auth: tokenProvider(fetchToken) }).stream({ path: "/x" }),
		).rejects.toMatchObject({ status: 401, errorCode: "INVALID_SESSION_ID" });
		expect(transport.requests).toHaveLength(1);
	});
});
