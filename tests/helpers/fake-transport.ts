import { accessToken } from "../../src/auth/providers";
import { SalesforceClient, type SalesforceClientOptions } from "../../src/client";
import type { HttpTransport, TransportRequest, TransportResponse } from "../../src/http/transport";
import type { GenericRegistry } from "../../src/registry";

export const INSTANCE_URL = "https://example.my.salesforce.com";
export const API = "/services/data/v67.0";

export interface RecordedRequest {
	method: string;
	url: URL;
	path: string;
	headers: Headers;
	body: string | undefined;
	json: unknown;
	signal: AbortSignal | undefined;
}

export interface FakeResponse {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

type Handler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A scriptable transport. Responses are served from a queue (`reply`) or, when the queue is
 * empty, from `handler`. Every request is recorded in `requests`.
 */
export class FakeTransport implements HttpTransport {
	readonly requests: RecordedRequest[] = [];
	private readonly _queue: FakeResponse[] = [];

	constructor(private readonly _handler?: Handler) {}

	reply(...responses: FakeResponse[]): this {
		this._queue.push(...responses);
		return this;
	}

	get last(): RecordedRequest {
		const request = this.requests.at(-1);
		if (!request) {
			throw new Error("No requests were sent.");
		}
		return request;
	}

	async send(request: TransportRequest): Promise<TransportResponse> {
		const body =
			request.body === undefined
				? undefined
				: typeof request.body === "string"
					? request.body
					: decoder.decode(request.body);
		const recorded: RecordedRequest = {
			method: request.method,
			url: request.url,
			path: request.url.pathname,
			headers: request.headers,
			body,
			json: parseJson(body),
			signal: request.signal,
		};
		this.requests.push(recorded);
		const response = this._queue.shift() ?? (await this._handler?.(recorded));
		if (!response) {
			throw new Error(`Unexpected request ${request.method} ${request.url.toString()}`);
		}
		return toTransportResponse(response);
	}
}

export function toTransportResponse(response: FakeResponse): TransportResponse {
	const headers = new Headers(response.headers);
	let body: Uint8Array;
	if (response.body === undefined) {
		body = new Uint8Array();
	} else if (response.body instanceof Uint8Array) {
		body = response.body;
	} else if (typeof response.body === "string") {
		body = encoder.encode(response.body);
		if (!headers.has("content-type")) {
			headers.set("content-type", "text/plain");
		}
	} else {
		body = encoder.encode(JSON.stringify(response.body));
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json;charset=UTF-8");
		}
	}
	return { status: response.status ?? 200, headers, body };
}

function parseJson(body: string | undefined): unknown {
	if (body === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return undefined;
	}
}

/** A client with a static token and a fake transport. */
export function createClient<R extends object = GenericRegistry>(
	transport: FakeTransport,
	options: Partial<SalesforceClientOptions> = {},
): SalesforceClient<R> {
	return new SalesforceClient<R>({
		auth: accessToken({ accessToken: "TOKEN", instanceUrl: INSTANCE_URL }),
		transport,
		apiVersion: "v67.0",
		...options,
	});
}
