import { emit, errorText } from "../logging";
import { share, type SharedRequest } from "../shared";

import type { AccessToken, AuthContext, AuthProvider } from "./types";

/** Refresh tokens that carry an expiry this many milliseconds early (at most half their lifetime). */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Caches the token from `fetchToken` in memory and shares one in-flight request between
 * concurrent callers. A caller that aborts only stops waiting; the token request itself is
 * cancelled once every waiting caller has aborted. `invalidate` drops the cached token so the
 * next call fetches a new one.
 *
 * Token events (`auth.tokenIssued`, `auth.tokenCached`, `auth.error`) go to `context.logger`,
 * labeled with `name`. A request shared by concurrent callers is logged with the logger of the
 * caller that started it.
 */
export class CachingAuthProvider implements AuthProvider {
	private _pending: SharedRequest<AccessToken> | undefined;
	private _token: { value: AccessToken; fetchedAt: number } | undefined;

	constructor(
		private readonly _fetchToken: (context: AuthContext) => Promise<AccessToken>,
		private readonly _name: string = "tokenProvider",
	) {}

	getToken(context: AuthContext): Promise<AccessToken> {
		if (this._token && !isExpired(this._token.value, this._token.fetchedAt)) {
			const token = this._token.value;
			emit(context.logger, "debug", `Using the cached access token from ${this._name}`, {
				type: "auth.tokenCached",
				provider: this._name,
				instanceUrl: token.instanceUrl,
				expiresAt: token.expiresAt,
			});
			return Promise.resolve(token);
		}
		if (!this._pending || this._pending.abandoned) {
			const { logger } = context;
			const started = Date.now();
			const pending = share((signal) =>
				this._fetchToken({ transport: context.transport, signal, logger }).then(
					(token) => {
						this._token = { value: token, fetchedAt: Date.now() };
						const durationMs = Date.now() - started;
						emit(logger, "info", `${this._name} issued an access token for ${token.instanceUrl} (${durationMs} ms)`, {
							type: "auth.tokenIssued",
							provider: this._name,
							instanceUrl: token.instanceUrl,
							expiresAt: token.expiresAt,
							durationMs,
						});
						return token;
					},
					(error: unknown) => {
						if (!signal.aborted) {
							emit(logger, "error", `${this._name} could not get an access token: ${errorText(error)}`, {
								type: "auth.error",
								provider: this._name,
								error,
								durationMs: Date.now() - started,
							});
						}
						throw error;
					},
				),
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
