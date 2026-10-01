import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
	accessToken,
	clientCredentials,
	createJwtAssertion,
	jwtBearer,
	refreshToken,
	tokenProvider,
} from "../../src/auth/providers";
import type { AccessToken } from "../../src/auth/types";
import { SalesforceAuthError } from "../../src/errors";
import { FakeTransport } from "../helpers/fake-transport";

const LOGIN_URL = "https://example.my.salesforce.com";
const tokenResponse = (token: string): { body: Record<string, string> } => ({
	body: {
		access_token: token,
		instance_url: "https://example.my.salesforce.com",
		token_type: "Bearer",
		issued_at: "1767225600000",
	},
});

describe("accessToken", () => {
	it("returns the static token", async () => {
		const provider = accessToken({ accessToken: "A", instanceUrl: LOGIN_URL });
		expect(await provider.getToken({ transport: new FakeTransport() })).toEqual({
			accessToken: "A",
			instanceUrl: LOGIN_URL,
		});
	});

	it("requires both values", () => {
		expect(() => accessToken({ accessToken: "", instanceUrl: LOGIN_URL })).toThrow(TypeError);
	});
});

describe("clientCredentials", () => {
	it("posts the client credentials grant and caches the token", async () => {
		const transport = new FakeTransport().reply(tokenResponse("T1"));
		const provider = clientCredentials({ loginUrl: `${LOGIN_URL}/`, clientId: "id", clientSecret: "secret" });
		const [first, second] = await Promise.all([provider.getToken({ transport }), provider.getToken({ transport })]);
		expect(first).toEqual({ accessToken: "T1", instanceUrl: LOGIN_URL });
		expect(second).toBe(first);
		expect(transport.requests).toHaveLength(1);
		expect(transport.last.url.toString()).toBe(`${LOGIN_URL}/services/oauth2/token`);
		expect(transport.last.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(Object.fromEntries(new URLSearchParams(transport.last.body))).toEqual({
			grant_type: "client_credentials",
			client_id: "id",
			client_secret: "secret",
		});
	});

	it("fetches a new token after invalidate", async () => {
		const transport = new FakeTransport().reply(tokenResponse("T1"), tokenResponse("T2"));
		const provider = clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "secret" });
		const first = await provider.getToken({ transport });
		provider.invalidate?.(first);
		expect((await provider.getToken({ transport })).accessToken).toBe("T2");
	});

	it("throws SalesforceAuthError without leaking the secret", async () => {
		const transport = new FakeTransport().reply({
			status: 400,
			body: { error: "invalid_client", error_description: "invalid client credentials" },
		});
		const provider = clientCredentials({ loginUrl: LOGIN_URL, clientId: "id", clientSecret: "super-secret" });
		const error = await provider.getToken({ transport }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceAuthError);
		expect((error as SalesforceAuthError).error).toBe("invalid_client");
		expect(String((error as Error).message)).not.toContain("super-secret");
	});

	it("rejects non-https login URLs and missing options", () => {
		expect(() => clientCredentials({ loginUrl: LOGIN_URL, clientId: "", clientSecret: "s" })).toThrow(/clientId/);
	});

	it("rejects insecure login URLs when fetching", async () => {
		const provider = clientCredentials({ loginUrl: "http://example.com", clientId: "id", clientSecret: "s" });
		await expect(provider.getToken({ transport: new FakeTransport() })).rejects.toThrow(/https/);
	});
});

describe("jwtBearer", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const options = {
		loginUrl: "https://login.salesforce.com",
		clientId: "cid",
		username: "user@example.com",
		privateKey,
	};

	it("creates a verifiable RS256 assertion with the expected claims", () => {
		const assertion = createJwtAssertion(options, 1_000_000);
		const [header, claims, signature] = assertion.split(".");
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
			iss: "cid",
			sub: "user@example.com",
			aud: "https://login.salesforce.com",
			exp: 1000 + 180,
		});
		const verify = createVerify("RSA-SHA256").update(`${header}.${claims}`);
		expect(verify.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
	});

	it("uses the sandbox audience for sandbox login URLs", () => {
		const assertion = createJwtAssertion({ ...options, loginUrl: "https://acme--dev.sandbox.my.salesforce.com" });
		const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()) as { aud: string };
		expect(claims.aud).toBe("https://test.salesforce.com");
	});

	const claimsOf = (assertion: string): { aud: string; exp: number } =>
		JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()) as { aud: string; exp: number };

	it("clamps the assertion lifetime to between 1 and 180 seconds", () => {
		const now = 1_000_000;
		const expFor = (expiresInSeconds: number | undefined): number =>
			claimsOf(createJwtAssertion({ ...options, expiresInSeconds }, now)).exp - now / 1000;
		expect(expFor(undefined)).toBe(180);
		expect(expFor(60)).toBe(60);
		expect(expFor(59.9)).toBe(59);
		expect(expFor(180)).toBe(180);
		expect(expFor(3600)).toBe(180);
		expect(expFor(0)).toBe(1);
		expect(expFor(-30)).toBe(1);
	});

	it("uses whole seconds for exp", () => {
		expect(claimsOf(createJwtAssertion(options, 1_000_999)).exp).toBe(1000 + 180);
	});

	it("uses the test audience for test.salesforce.com and scratch orgs", () => {
		for (const loginUrl of [
			"https://test.salesforce.com",
			"https://site-power-1234-dev-ed.scratch.my.salesforce.com",
			"https://acme--uat.sandbox.my.salesforce.com/",
		]) {
			expect(claimsOf(createJwtAssertion({ ...options, loginUrl })).aud).toBe("https://test.salesforce.com");
		}
	});

	it("uses the login audience for production and My Domain URLs", () => {
		for (const loginUrl of ["https://login.salesforce.com", "https://acme.my.salesforce.com"]) {
			expect(claimsOf(createJwtAssertion({ ...options, loginUrl })).aud).toBe("https://login.salesforce.com");
		}
	});

	it("lets an explicit audience win", () => {
		const assertion = createJwtAssertion({
			...options,
			loginUrl: "https://acme--uat.sandbox.my.salesforce.com",
			audience: "https://acme--uat.sandbox.my.salesforce.com",
		});
		expect(claimsOf(assertion).aud).toBe("https://acme--uat.sandbox.my.salesforce.com");
	});

	it("exchanges the assertion for a token", async () => {
		const transport = new FakeTransport().reply(tokenResponse("JWT"));
		const token = await jwtBearer(options).getToken({ transport });
		expect(token.accessToken).toBe("JWT");
		const params = new URLSearchParams(transport.last.body);
		expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
		expect(params.get("assertion")?.split(".")).toHaveLength(3);
	});
});

describe("refreshToken", () => {
	it("reports rotated refresh tokens and uses them next time", async () => {
		const onRotated = vi.fn<(token: string) => void>();
		const transport = new FakeTransport().reply(
			{ body: { ...tokenResponse("A1").body, refresh_token: "R2" } },
			tokenResponse("A2"),
		);
		const provider = refreshToken({
			loginUrl: LOGIN_URL,
			clientId: "id",
			refreshToken: "R1",
			onRefreshTokenRotated: onRotated,
		});
		const first = await provider.getToken({ transport });
		expect(onRotated).toHaveBeenCalledWith("R2");
		provider.invalidate?.(first);
		await provider.getToken({ transport });
		expect(new URLSearchParams(transport.last.body).get("refresh_token")).toBe("R2");
	});

	it("keeps the access token and the rotated refresh token when the callback throws", async () => {
		const onRotated = vi.fn<(token: string) => void>(() => {
			throw new Error("could not store the refresh token");
		});
		const transport = new FakeTransport().reply(
			{ body: { ...tokenResponse("A1").body, refresh_token: "R2" } },
			tokenResponse("A2"),
		);
		const provider = refreshToken({
			loginUrl: LOGIN_URL,
			clientId: "id",
			clientSecret: "secret",
			refreshToken: "R1",
			onRefreshTokenRotated: onRotated,
		});
		const first = await provider.getToken({ transport });
		expect(first.accessToken).toBe("A1");
		expect(onRotated).toHaveBeenCalledTimes(1);
		expect(new URLSearchParams(transport.last.body).get("client_secret")).toBe("secret");

		provider.invalidate?.(first);
		expect((await provider.getToken({ transport })).accessToken).toBe("A2");
		expect(new URLSearchParams(transport.last.body).get("refresh_token")).toBe("R2");
	});

	it("does not report an unchanged refresh token", async () => {
		const onRotated = vi.fn<(token: string) => void>();
		const transport = new FakeTransport().reply({ body: { ...tokenResponse("A1").body, refresh_token: "R1" } });
		const provider = refreshToken({
			loginUrl: LOGIN_URL,
			clientId: "id",
			refreshToken: "R1",
			onRefreshTokenRotated: onRotated,
		});
		await provider.getToken({ transport });
		expect(onRotated).not.toHaveBeenCalled();
		expect(new URLSearchParams(transport.last.body).has("client_secret")).toBe(false);
	});
});

describe("tokenProvider", () => {
	it("caches short-lived tokens and refreshes expired ones", async () => {
		let lifetimeMs = 30_000;
		let count = 0;
		const fetchToken = vi.fn<() => Promise<AccessToken>>((): Promise<AccessToken> =>
			Promise.resolve({ accessToken: `T${++count}`, instanceUrl: LOGIN_URL, expiresAt: Date.now() + lifetimeMs }),
		);
		const provider = tokenProvider(fetchToken);
		const transport = new FakeTransport();
		await provider.getToken({ transport });
		await provider.getToken({ transport });
		// A 30 s token is cached: the refresh margin is at most half its lifetime.
		expect(fetchToken).toHaveBeenCalledTimes(1);

		const expiring = tokenProvider(fetchToken);
		lifetimeMs = -1;
		await expiring.getToken({ transport });
		await expiring.getToken({ transport });
		expect(fetchToken).toHaveBeenCalledTimes(3);
	});

	it("lets one caller abort without failing the others", async () => {
		let resolveToken: (token: AccessToken) => void = () => undefined;
		const fetchSignals: AbortSignal[] = [];
		const provider = tokenProvider(({ signal }) => {
			if (signal) {
				fetchSignals.push(signal);
			}
			return new Promise<AccessToken>((resolve) => {
				resolveToken = resolve;
			});
		});
		const transport = new FakeTransport();
		const first = new AbortController();
		const firstCall = provider.getToken({ transport, signal: first.signal });
		const secondCall = provider.getToken({ transport, signal: new AbortController().signal });
		first.abort(new Error("first gave up"));
		await expect(firstCall).rejects.toThrow("first gave up");
		expect(fetchSignals[0]?.aborted).toBe(false);
		resolveToken({ accessToken: "T", instanceUrl: LOGIN_URL });
		expect((await secondCall).accessToken).toBe("T");
	});

	it("cancels the token request when every caller aborted", async () => {
		const fetchSignals: AbortSignal[] = [];
		const provider = tokenProvider(({ signal }) => {
			if (signal) {
				fetchSignals.push(signal);
			}
			return new Promise<AccessToken>(() => undefined);
		});
		const controller = new AbortController();
		const call = provider.getToken({ transport: new FakeTransport(), signal: controller.signal });
		controller.abort(new Error("stop"));
		await expect(call).rejects.toThrow("stop");
		expect(fetchSignals[0]?.aborted).toBe(true);
	});
});
