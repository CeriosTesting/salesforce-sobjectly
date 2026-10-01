import { share, type SharedRequest } from "../shared";

import type { AccessToken, AuthContext, AuthProvider } from "./types";

/** Refresh tokens that carry an expiry this many milliseconds early (at most half their lifetime). */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Caches the token from `fetchToken` in memory and shares one in-flight request between
 * concurrent callers. A caller that aborts only stops waiting; the token request itself is
 * cancelled once every waiting caller has aborted. `invalidate` drops the cached token so the
 * next call fetches a new one.
 */
export class CachingAuthProvider implements AuthProvider {
	private _pending: SharedRequest<AccessToken> | undefined;
	private _token: { value: AccessToken; fetchedAt: number } | undefined;

	constructor(private readonly _fetchToken: (context: AuthContext) => Promise<AccessToken>) {}

	getToken(context: AuthContext): Promise<AccessToken> {
		if (this._token && !isExpired(this._token.value, this._token.fetchedAt)) {
			return Promise.resolve(this._token.value);
		}
		if (!this._pending || this._pending.abandoned) {
			const pending = share((signal) =>
				this._fetchToken({ transport: context.transport, signal }).then((token) => {
					this._token = { value: token, fetchedAt: Date.now() };
					return token;
				}),
			);
			this._pending = pending;
			pending.promise
				.finally(() => {
					if (this._pending === pending) {
						this._pending = undefined;
					}
				})
				.catch(() => undefined);
		}
		return this._pending.join(context.signal);
	}

	invalidate(token: AccessToken): void {
		if (this._token?.value.accessToken === token.accessToken) {
			this._token = undefined;
		}
	}
}

function isExpired(token: AccessToken, fetchedAt: number): boolean {
	if (token.expiresAt === undefined) {
		return false;
	}
	// A fixed margin would make short-lived tokens look expired right away and refetch on every call.
	const margin = Math.min(EXPIRY_MARGIN_MS, Math.max(0, (token.expiresAt - fetchedAt) / 2));
	return token.expiresAt - margin <= Date.now();
}
