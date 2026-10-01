# Transports

The client sends every HTTP request through a **transport**. A transport is an object with one method:

```ts
interface HttpTransport {
	send(request: {
		method: HttpMethod;
		url: URL;
		headers: Headers;
		body?: string | Uint8Array;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<{ status: number; headers: Headers; body: Uint8Array }>;
}
```

A transport must **return** error responses, not throw them. The client turns them into `SalesforceError`s.

## fetch (default)

```ts
import { fetchTransport } from "@cerios/salesforce-sobjectly";

new SalesforceClient({ apiVersion: "v66.0", auth, transport: fetchTransport({ fetch: myInstrumentedFetch }) });
```

## axios

The package does not bundle axios, because Node's built-in `fetch` does the same job. If you already use axios (for its interceptors, proxy agents or mocking), it takes about 15 lines:

```ts
import axios from "axios";
import type { HttpTransport } from "@cerios/salesforce-sobjectly";

export function axiosTransport(instance = axios.create()): HttpTransport {
	return {
		async send(request) {
			const response = await instance.request<ArrayBuffer>({
				url: request.url.toString(),
				method: request.method,
				headers: Object.fromEntries(request.headers),
				data: request.body,
				signal: request.signal,
				responseType: "arraybuffer",
				validateStatus: () => true, // never throw on HTTP errors
			});
			const headers = new Headers();
			for (const [key, value] of Object.entries(response.headers)) {
				if (value !== undefined) headers.set(key, String(value));
			}
			return { status: response.status, headers, body: new Uint8Array(response.data) };
		},
	};
}
```

Other clients (undici, got, ky) follow the same pattern.

## Playwright

In Playwright tests you can send requests through Playwright's [`APIRequestContext`](https://playwright.dev/docs/api/class-apirequestcontext). They then show up in the trace viewer, and the context's proxy and `ignoreHTTPSErrors` settings apply. The package does not depend on Playwright, so copy this adapter:

```ts
import type { APIRequestContext } from "@playwright/test";
import type { HttpTransport } from "@cerios/salesforce-sobjectly";

export function playwrightTransport(context: APIRequestContext): HttpTransport {
	return {
		async send(request) {
			// Playwright can't cancel a request in flight; the client's timeout is passed as `timeout` instead.
			request.signal?.throwIfAborted();
			const body = request.body;
			const response = await context.fetch(request.url.toString(), {
				method: request.method,
				headers: Object.fromEntries(request.headers),
				// Bytes must be a Buffer, or Playwright serializes them as JSON.
				data: typeof body === "string" ? body : body && Buffer.from(body.buffer, body.byteOffset, body.byteLength),
				timeout: request.timeoutMs ?? 0, // 0 = no timeout
				failOnStatusCode: false, // never throw on HTTP errors
				maxRedirects: 0, // like fetchTransport: a redirect must not bypass the origin check
			});
			const headers = new Headers();
			for (const { name, value } of response.headersArray()) headers.append(name, value);
			return { status: response.status(), headers, body: await response.body() };
		},
	};
}
```

Use it with the `request` fixture, or with a context from `request.newContext()`:

```ts
import { test, expect } from "@playwright/test";
import { SalesforceClient } from "@cerios/salesforce-sobjectly";
import { API_VERSION, type SObjectRegistry } from "./generated/sobjects";

test("creates an account", async ({ request }) => {
	const sf = new SalesforceClient<SObjectRegistry>({
		apiVersion: API_VERSION,
		auth,
		transport: playwrightTransport(request),
	});
	const id = await sf.sobject("Account").create({ Name: "Acme" });
	expect(id).toMatch(/^001/);
});
```

The adapter has no `stream()`, so Bulk API results are read page by page.

> [!WARNING]
> Traces record request headers and bodies, so they contain the `Authorization` header. Token requests also go through the client's transport, so a trace can contain your client secret, refresh token or JWT assertion as well. Treat traces from these tests as secrets. To keep the token request out of them, give the auth provider its own `fetch` transport:
>
> ```ts
> import { clientCredentials, fetchTransport, type AuthProvider } from "@cerios/salesforce-sobjectly";
>
> const credentials = clientCredentials({ loginUrl, clientId, clientSecret });
> const tokenTransport = fetchTransport();
> const auth: AuthProvider = {
> 	getToken: (context) => credentials.getToken({ ...context, transport: tokenTransport }),
> 	invalidate: (token) => credentials.invalidate?.(token),
> };
> ```

## Timeouts, retries and hooks

```ts
new SalesforceClient({
	auth,
	apiVersion: "v66.0", // required; e.g. API_VERSION from your generated types
	timeoutMs: 60_000, // per request; 0 disables it (default 120 000)
	retry: { retries: 3, statusCodes: [429, 502, 503, 504], errorCodes: ["UNABLE_TO_LOCK_ROW"] }, // opt-in
	headers: { "Sforce-Call-Options": "client=my-test-suite" },
	hooks: {
		onRequest: (event) => console.log(event.method, event.url), // Authorization is redacted
		onResponse: (event) => console.log(event.status, `${event.durationMs}ms`),
	},
});
```

- Retries are off by default. When you turn them on, only `GET` and `HEAD` are retried on the listed statuses and on network errors, respecting `Retry-After`. A single request can opt in with `retry: true`, or opt out with `retry: false`.
- `errorCodes` retries any method, including mutations, when Salesforce answers with one of the codes. The typical case is `UNABLE_TO_LOCK_ROW` in parallel test runs. This is safe because Salesforce rolled the failed request back.
- **Streaming:** a transport can implement the optional `stream()` method. `fetchTransport` does. Bulk API query results then stream through an incremental CSV parser, so memory stays flat regardless of page size. Transports without `stream()` fall back to buffered pages.
- `sf.apiUsage` holds the API usage from the most recent `Sforce-Limit-Info` header, e.g. `{ used: 1834, max: 100000 }`.
- Absolute URLs (for example `nextRecordsUrl`) must be on the instance origin. Add other origins with `allowedOrigins`.
- Redirects are not followed: `fetchTransport` uses `redirect: "manual"`, so a redirect can't bypass the origin check. A 3xx response surfaces as a `SalesforceError`.
- A request body must be JSON-serializable, a string or bytes (`Uint8Array`, `ArrayBuffer`, typed arrays). `Blob`, `FormData` and streams are rejected; use `buildMultipart` for multipart bodies.
