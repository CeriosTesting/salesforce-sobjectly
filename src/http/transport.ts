export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD";

/** A fully prepared HTTP request handed to a transport. */
export interface TransportRequest {
	method: HttpMethod;
	url: URL;
	headers: Headers;
	body?: string | Uint8Array;
	/** Aborts the request (covers both caller cancellation and the client timeout). */
	signal?: AbortSignal;
	/** The client timeout in milliseconds, for transports that take it as an option instead of a signal. */
	timeoutMs?: number;
}

/** A buffered HTTP response returned by a transport. Non-2xx statuses must be returned, not thrown. */
export interface TransportResponse {
	status: number;
	headers: Headers;
	body: Uint8Array;
}

/** A response whose body arrives as a stream of chunks. */
export interface StreamingTransportResponse {
	status: number;
	headers: Headers;
	body: AsyncIterable<Uint8Array>;
}

/**
 * The only thing the client needs from an HTTP library. Implement it to plug in any client
 * (undici, axios, got, a logging wrapper, ...). See `fetchTransport`.
 */
export interface HttpTransport {
	send(request: TransportRequest): Promise<TransportResponse>;
	/**
	 * Optional: sends a request and streams the response body. Used for large downloads such as
	 * Bulk API results; transports without it fall back to `send`.
	 */
	stream?(request: TransportRequest): Promise<StreamingTransportResponse>;
}
