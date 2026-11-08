import { SalesforceAuthError } from "../errors";
import { headersToObject } from "../http/connection";
import type { HttpTransport, TransportResponse } from "../http/transport";
import { emit, errorText, redactForm, redactTokenResponse, type SalesforceLogger } from "../logging";
import type { OAuthTokenResponse } from "../types/api";

import type { AccessToken } from "./types";

const decoder = new TextDecoder();

/**
 * POSTs a form to `{loginUrl}/services/oauth2/token` and turns the response into an
 * `AccessToken`. Errors never include the submitted parameters. With a `logger`, the request and
 * response are logged as `auth.request`/`auth.response` with every credential and token redacted.
 */
export async function requestOAuthToken(
	transport: HttpTransport,
	loginUrl: string,
	params: Record<string, string>,
	signal?: AbortSignal,
	logger?: SalesforceLogger,
): Promise<{ token: AccessToken; response: OAuthTokenResponse }> {
	const url = new URL("/services/oauth2/token", normalizeLoginUrl(loginUrl));
	const headers = new Headers({
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	});
	const body = new URLSearchParams(params).toString();
	const log = tokenRequestLog(logger, url, headers, body, params.grant_type);
	let response: TransportResponse;
	try {
		response = await transport.send({ method: "POST", url, headers, body, signal });
	} catch (error) {
		log.failed(error);
		throw error;
	}
	const text = decoder.decode(response.body);
	log.answered(response, text);
	const json = parseJson(text);

	if (response.status < 200 || response.status >= 300) {
		const error = typeof json?.error === "string" ? json.error : undefined;
		const errorDescription = typeof json?.error_description === "string" ? json.error_description : undefined;
		throw new SalesforceAuthError(
			`Salesforce token request to ${url.origin} failed with status ${response.status}${
				error ? ` - ${error}${errorDescription ? `: ${errorDescription}` : ""}` : ""
			}`,
			{ status: response.status, error, errorDescription },
		);
	}
	if (typeof json?.access_token !== "string" || typeof json.instance_url !== "string") {
		throw new SalesforceAuthError(`Salesforce token response from ${url.origin} has no access_token/instance_url.`, {
			status: response.status,
		});
	}
	const tokenResponse = json as unknown as OAuthTokenResponse;
	return {
		token: { accessToken: tokenResponse.access_token, instanceUrl: tokenResponse.instance_url },
		response: tokenResponse,
	};
}

/**
 * Logs a token request as `auth.request` now and `auth.response` (or `http.error`) later. The
 * form body and the response have every credential and token replaced by `[REDACTED]`.
 */
function tokenRequestLog(
	logger: SalesforceLogger | undefined,
	url: URL,
	headers: Headers,
	body: string,
	grantType: string | undefined,
): { failed(error: unknown): void; answered(response: TransportResponse, text: string): void } {
	if (!logger) {
		return { failed: () => undefined, answered: () => undefined };
	}
	const request = {
		method: "POST" as const,
		url: url.toString(),
		headers: headersToObject(headers),
		body: redactForm(body),
		attempt: 1,
	};
	emit(logger, "debug", `POST ${request.url} (${grantType})`, { type: "auth.request", grantType, ...request });
	const started = Date.now();
	return {
		failed(error) {
			emit(logger, "error", `POST ${request.url} failed: ${errorText(error)}`, {
				type: "http.error",
				method: "POST",
				url: request.url,
				attempt: 1,
				durationMs: Date.now() - started,
				error,
				willRetry: false,
			});
		},
		answered(response, text) {
			const durationMs = Date.now() - started;
			emit(
				logger,
				response.status >= 400 ? "warn" : "debug",
				`POST ${request.url} → ${response.status} (${durationMs} ms)`,
				{
					type: "auth.response",
					grantType,
					...request,
					status: response.status,
					durationMs,
					responseHeaders: headersToObject(response.headers),
					responseBody: redactTokenResponse(text),
				},
			);
		},
	};
}

/** Accepts `https://x.my.salesforce.com`, with or without a trailing slash or path. */
export function normalizeLoginUrl(loginUrl: string): string {
	let url: URL;
	try {
		url = new URL(loginUrl);
	} catch {
		throw new TypeError(`Invalid Salesforce login URL: "${loginUrl}".`);
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		throw new TypeError(`Salesforce login URL must use https: "${url.origin}".`);
	}
	return url.origin;
}

function parseJson(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
