import { createSign } from "node:crypto";

import { CachingAuthProvider } from "./caching-provider";
import { requestOAuthToken } from "./oauth";
import type { AccessToken, AuthContext, AuthProvider } from "./types";

/** Uses a fixed access token, e.g. one issued by the Salesforce CLI (`sf org display`). */
export function accessToken(token: AccessToken): AuthProvider {
	if (!token.accessToken || !token.instanceUrl) {
		throw new TypeError("accessToken() requires both accessToken and instanceUrl.");
	}
	return {
		getToken: (): Promise<AccessToken> => Promise.resolve(token),
	};
}

/**
 * Wraps your own token source. The result is cached until Salesforce answers 401, after which
 * `fetchToken` is called again.
 */
export function tokenProvider(fetchToken: (context: AuthContext) => Promise<AccessToken>): AuthProvider {
	return new CachingAuthProvider(fetchToken);
}

export interface ClientCredentialsOptions {
	/** Your My Domain URL, e.g. `https://mydomain.my.salesforce.com`. Required for this flow. */
	loginUrl: string;
	clientId: string;
	clientSecret: string;
	/** Optional space-separated scopes. */
	scope?: string;
}

/**
 * OAuth 2.0 client credentials flow (server-to-server, runs as the app's "Run As" user).
 * The token is cached in memory and refreshed once when Salesforce answers 401.
 */
export function clientCredentials(options: ClientCredentialsOptions): AuthProvider {
	requireOptions("clientCredentials", options, ["loginUrl", "clientId", "clientSecret"]);
	return new CachingAuthProvider(async (context) => {
		const params: Record<string, string> = {
			grant_type: "client_credentials",
			client_id: options.clientId,
			client_secret: options.clientSecret,
		};
		if (options.scope) {
			params.scope = options.scope;
		}
		const { token } = await requestOAuthToken(context.transport, options.loginUrl, params, context.signal);
		return token;
	});
}

export interface JwtBearerOptions {
	/** `https://login.salesforce.com`, `https://test.salesforce.com` or your My Domain URL. */
	loginUrl: string;
	/** The consumer key of the connected app / external client app. */
	clientId: string;
	/** The username to act as. */
	username: string;
	/** The PEM-encoded RSA private key whose certificate is uploaded to the app. */
	privateKey: string;
	/**
	 * The JWT `aud` claim. Defaults to `https://test.salesforce.com` for sandbox login URLs and
	 * `https://login.salesforce.com` otherwise.
	 */
	audience?: string;
	/** Lifetime of the assertion in seconds (max 180). Defaults to 180. */
	expiresInSeconds?: number;
}

/** OAuth 2.0 JWT bearer flow. The assertion is signed locally with RS256; no extra dependencies. */
export function jwtBearer(options: JwtBearerOptions): AuthProvider {
	requireOptions("jwtBearer", options, ["loginUrl", "clientId", "username", "privateKey"]);
	return new CachingAuthProvider(async (context) => {
		const assertion = createJwtAssertion(options);
		const { token } = await requestOAuthToken(
			context.transport,
			options.loginUrl,
			{ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion },
			context.signal,
		);
		return token;
	});
}

export interface RefreshTokenOptions {
	loginUrl: string;
	clientId: string;
	/** Required unless the app is configured without a secret for the refresh token flow. */
	clientSecret?: string;
	refreshToken: string;
	/** Called when Salesforce rotates the refresh token, so you can store the new one. Errors it throws are ignored. */
	onRefreshTokenRotated?: (refreshToken: string) => void;
}

/** Exchanges a refresh token for access tokens. */
export function refreshToken(options: RefreshTokenOptions): AuthProvider {
	requireOptions("refreshToken", options, ["loginUrl", "clientId", "refreshToken"]);
	let currentRefreshToken = options.refreshToken;
	return new CachingAuthProvider(async (context) => {
		const params: Record<string, string> = {
			grant_type: "refresh_token",
			client_id: options.clientId,
			refresh_token: currentRefreshToken,
		};
		if (options.clientSecret) {
			params.client_secret = options.clientSecret;
		}
		const { token, response } = await requestOAuthToken(context.transport, options.loginUrl, params, context.signal);
		if (response.refresh_token && response.refresh_token !== currentRefreshToken) {
			currentRefreshToken = response.refresh_token;
			try {
				options.onRefreshTokenRotated?.(response.refresh_token);
			} catch {
				// A failing callback must not throw away the access token that was just issued.
			}
		}
		return token;
	});
}

/** Builds a signed RS256 JWT assertion for the JWT bearer flow. Exported for testing. */
export function createJwtAssertion(options: JwtBearerOptions, now: number = Date.now()): string {
	const expiresIn = Math.min(Math.max(Math.floor(options.expiresInSeconds ?? 180), 1), 180);
	const header = { alg: "RS256", typ: "JWT" };
	const claims = {
		iss: options.clientId,
		sub: options.username,
		aud: options.audience ?? defaultAudience(options.loginUrl),
		exp: Math.floor(now / 1000) + expiresIn,
	};
	const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
	const signature = createSign("RSA-SHA256").update(unsigned).sign(options.privateKey);
	return `${unsigned}.${base64Url(signature)}`;
}

function defaultAudience(loginUrl: string): string {
	const host = new URL(loginUrl).hostname;
	// Sandboxes and scratch orgs authenticate against test.salesforce.com.
	return host === "test.salesforce.com" || host.includes(".sandbox.") || host.includes(".scratch.")
		? "https://test.salesforce.com"
		: "https://login.salesforce.com";
}

function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function requireOptions<T extends object>(provider: string, options: T, keys: (keyof T & string)[]): void {
	const missing = keys.filter((key) => !options[key]);
	if (missing.length > 0) {
		throw new TypeError(`${provider}() is missing required option(s): ${missing.join(", ")}.`);
	}
}
