import type { HttpTransport, StreamingTransportResponse, TransportRequest, TransportResponse } from "./transport";

export interface FetchTransportOptions {
	/** A custom `fetch` implementation. Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
}

/** The default transport, built on the platform `fetch` (Node.js 20+). Supports streaming. */
export function fetchTransport(options: FetchTransportOptions = {}): HttpTransport {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		throw new TypeError("No global fetch is available. Use Node.js 20+ or pass a fetch implementation.");
	}
	const call = (request: TransportRequest): Promise<Response> =>
		fetchImpl(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit | undefined,
			signal: request.signal,
			// Redirects are not followed: a redirect to another origin would bypass the origin check.
			redirect: "manual",
		});
	return {
		async send(request: TransportRequest): Promise<TransportResponse> {
			const response = await call(request);
			const body = new Uint8Array(await response.arrayBuffer());
			return { status: response.status, headers: response.headers, body };
		},
		async stream(request: TransportRequest): Promise<StreamingTransportResponse> {
			const response = await call(request);
			return { status: response.status, headers: response.headers, body: chunks(response) };
		},
	};
}

async function* chunks(response: Response): AsyncGenerator<Uint8Array, void, undefined> {
	if (!response.body) {
		return;
	}
	const reader = response.body.getReader();
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				return;
			}
			yield value;
		}
	} finally {
		if (!finished) {
			// The consumer stopped early: cancel so the connection is released instead of downloading the rest.
			await reader.cancel().catch(() => undefined);
		}
		reader.releaseLock();
	}
}
