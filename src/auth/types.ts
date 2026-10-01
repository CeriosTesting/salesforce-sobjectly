import type { HttpTransport } from "../http/transport";

/** An access token together with the instance it is valid for. */
export interface AccessToken {
	accessToken: string;
	/** The org's instance URL, e.g. `https://mydomain.my.salesforce.com`. API calls go here. */
	instanceUrl: string;
	/** Optional expiry in epoch milliseconds. When set, the token is refreshed shortly before it expires. */
	expiresAt?: number;
}

export interface AuthContext {
	/** The client's transport, so token requests use the same HTTP stack as API calls. */
	transport: HttpTransport;
	signal?: AbortSignal;
}

/**
 * Supplies access tokens to the client. Implementations should cache tokens; the client calls
 * `getToken` before every request.
 */
export interface AuthProvider {
	getToken(context: AuthContext): Promise<AccessToken>;
	/**
	 * Called when Salesforce answered 401 for `token`. Providers that can obtain a new token
	 * should drop it from their cache; the client then retries the request once.
	 */
	invalidate?(token: AccessToken): void;
}
