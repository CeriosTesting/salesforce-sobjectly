import { SalesforceAuthError } from "../errors";
import type { HttpTransport } from "../http/transport";
import type { OAuthTokenResponse } from "../types/api";

import type { AccessToken } from "./types";

const decoder = new TextDecoder();

/**
 * POSTs a form to `{loginUrl}/services/oauth2/token` and turns the response into an
 * `AccessToken`. Errors never include the submitted parameters.
 */
export async function requestOAuthToken(
	transport: HttpTransport,
	loginUrl: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ token: AccessToken; response: OAuthTokenResponse }> {
	const url = new URL("/services/oauth2/token", normalizeLoginUrl(loginUrl));
	const response = await transport.send({
		method: "POST",
		url,
		headers: new Headers({
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		}),
		body: new URLSearchParams(params).toString(),
		signal,
	});
	const text = decoder.decode(response.body);
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
