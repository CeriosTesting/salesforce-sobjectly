/**
 * Connection to the live org for the integration tests. The first complete set of variables wins:
 *
 * - client credentials: `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`;
 * - access token: `SF_ACCESS_TOKEN`, `SF_INSTANCE_URL`;
 * - Salesforce CLI: `SF_TARGET_ORG` (an alias or username you are logged into with `sf`).
 *
 * `SF_API_VERSION` is always required (`"67.0"` and `"v67.0"` both work). Variables are read from
 * the environment or a local `.env`.
 */
import { normalizeApiVersion } from "../../src/api-version";
import { accessToken, clientCredentials } from "../../src/auth/providers";
import { sfCli } from "../../src/auth/sf-cli";
import type { AuthProvider } from "../../src/auth/types";
import { SalesforceClient } from "../../src/client";
import type { ApiVersion } from "../../src/types/common";

const env = (name: string): string | undefined => {
	const value = process.env[name]?.trim() ?? "";
	return value.length > 0 ? value : undefined;
};

function resolveAuth(): { auth: AuthProvider; method: string } | undefined {
	const loginUrl = env("SF_LOGIN_URL");
	const clientId = env("SF_CLIENT_ID");
	const clientSecret = env("SF_CLIENT_SECRET");
	if (loginUrl && clientId && clientSecret) {
		return { auth: clientCredentials({ loginUrl, clientId, clientSecret }), method: "client credentials" };
	}
	const token = env("SF_ACCESS_TOKEN");
	const instanceUrl = env("SF_INSTANCE_URL");
	if (token && instanceUrl) {
		return { auth: accessToken({ accessToken: token, instanceUrl }), method: "access token" };
	}
	const targetOrg = env("SF_TARGET_ORG");
	return targetOrg ? { auth: sfCli({ targetOrg }), method: `sf CLI (${targetOrg})` } : undefined;
}

const resolved = resolveAuth();
const apiVersion: ApiVersion | undefined = normalizeApiVersion(env("SF_API_VERSION") ?? "");

/** `true` when the environment describes an org to test against. */
export const liveOrgConfigured = Boolean(resolved && apiVersion);

/** The auth provider for the live org. Only call it when `liveOrgConfigured` is `true`. */
export function liveAuth(): AuthProvider {
	if (!resolved) {
		throw new Error("No live org configured; see tests/integration/org.ts.");
	}
	return resolved.auth;
}

/** The API version the live tests use. */
export function liveApiVersion(): ApiVersion {
	if (!apiVersion) {
		throw new Error("SF_API_VERSION is not set; see tests/integration/org.ts.");
	}
	return apiVersion;
}

/** A client for the live org. Only call it when `liveOrgConfigured` is `true`. */
export function liveClient(): SalesforceClient {
	if (!resolved || !apiVersion) {
		throw new Error("No live org configured; see tests/integration/org.ts.");
	}
	return new SalesforceClient({ auth: resolved.auth, apiVersion, retry: { errorCodes: ["UNABLE_TO_LOCK_ROW"] } });
}

/** A unique prefix for the records one test run creates, so cleanup can find them. */
export const runMarker = `sobjectly-it-${Date.now()}`;
