# Authentication

Every client needs an auth provider. A provider returns an access token and the instance URL it belongs to. The client caches the token. If Salesforce answers `401`, the client asks the provider for a new token once and retries the request once.

API calls go to the `instance_url` that comes back with the token, not to the login URL.

The code generator logs in with the same keys: its config's `auth` setting takes `loginUrl`, `clientId`, `clientSecret` and so on, as plain data. See [Auth in the codegen config](codegen.md#auth). To log the client in the same way, use [`loadAuth()`](#reuse-the-codegen-configs-auth).

## Static access token

Use this for a token you already have, for example from the Salesforce CLI (`sf org display --json`).

```ts
import { SalesforceClient, accessToken } from "@cerios/salesforce-sobjectly";

const sf = new SalesforceClient({
	apiVersion: "v66.0",
	auth: accessToken({ accessToken: process.env.SF_ACCESS_TOKEN!, instanceUrl: process.env.SF_INSTANCE_URL! }),
});
```

A static token cannot be refreshed, so an expired token results in a `SalesforceError` with status 401.

## Salesforce CLI (recommended for local development)

This uses an org you're logged into with the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli). You need no connected app and no secrets.

```ts
import { sfCli } from "@cerios/salesforce-sobjectly";

// sf org login web --alias my-org
const auth = sfCli({ targetOrg: "my-org" }); // omit targetOrg for the CLI's default org
```

**How it works**

- The token comes from `sf org auth show-access-token`, and the instance URL from `sf org display`. Since May 2026, `sf org display` no longer prints tokens.
- The CLI refreshes expired tokens itself. On a 401 the provider asks it again.
- The commands run without a shell.
- If `sf` isn't installed or the org isn't logged in, you get a clear error.

## Client credentials (recommended for servers and test automation)

This is the OAuth 2.0 client credentials flow. It needs an External Client App or Connected App with the flow enabled and a "Run As" user.

```ts
import { clientCredentials } from "@cerios/salesforce-sobjectly";

const auth = clientCredentials({
	loginUrl: "https://mydomain.my.salesforce.com", // must be your My Domain URL
	clientId: process.env.SF_CLIENT_ID!,
	clientSecret: process.env.SF_CLIENT_SECRET!,
});
```

## JWT bearer

This flow authenticates as a specific user with a certificate uploaded to the app. The assertion is signed locally with `node:crypto`, so it needs no extra dependency.

```ts
import { readFileSync } from "node:fs";
import { jwtBearer } from "@cerios/salesforce-sobjectly";

const auth = jwtBearer({
	loginUrl: "https://login.salesforce.com", // or https://test.salesforce.com / your My Domain
	clientId: process.env.SF_CLIENT_ID!,
	username: "integration@acme.com",
	privateKey: readFileSync("server.key", "utf8"),
});
```

The `aud` claim defaults to `https://test.salesforce.com` for sandbox URLs and to `https://login.salesforce.com` otherwise. Override it with `audience`.

## Refresh token

```ts
import { refreshToken } from "@cerios/salesforce-sobjectly";

const auth = refreshToken({
	loginUrl: "https://login.salesforce.com",
	clientId: process.env.SF_CLIENT_ID!,
	clientSecret: process.env.SF_CLIENT_SECRET,
	refreshToken: storedRefreshToken,
	onRefreshTokenRotated: (token) => save(token),
});
```

## Reuse the codegen config's auth

`loadAuth()` reads your `sobjectly.config.*` and returns a provider for its `auth` setting, so the client logs in the same way as `sobjectly generate`, with no second copy of the credentials:

```ts
import { SalesforceClient } from "@cerios/salesforce-sobjectly";
import { loadAuth } from "@cerios/salesforce-sobjectly/codegen";
import { API_VERSION, type SObjectRegistry } from "./generated/sobjects";

const sf = new SalesforceClient<SObjectRegistry>({ apiVersion: API_VERSION, auth: await loadAuth() });
```

- To use another login, pass a different provider as `auth`; the config is then not read.
- The config is looked up in `process.cwd()` only, not in parent folders. Pass `{ cwd }` or `{ configPath }` to point elsewhere.
- Values are resolved exactly as in [the codegen config](codegen.md#auth), from `process.env` unless you pass `{ env }`. Load your `.env` file first (e.g. `node --env-file=.env`).
- No config file, or a missing credential, throws an error that says what is missing and how to fix it.
- Pass `{ warn }` to receive warnings, such as for deprecated `*Env` keys.

`loadAuth` is Node-only and loads a TypeScript config with `jiti`, which is why it lives in the `/codegen` entry and not in the client.

## Your own provider

Wrap any token source with `tokenProvider`. The token is cached until Salesforce rejects it. Set `expiresAt` (epoch milliseconds) and the token is refreshed a minute before it expires.

```ts
import { tokenProvider } from "@cerios/salesforce-sobjectly";

const auth = tokenProvider(async () => {
	const { accessToken, instanceUrl } = await mySecretStore.getSalesforceSession();
	return { accessToken, instanceUrl };
});
```

You can also implement the `AuthProvider` interface directly: `getToken(context)` and, optionally, `invalidate(token)`.

## Notes

- Token requests go through the client's transport, so a custom transport (proxy, logging) also applies to them.
- Secrets and tokens are never included in errors or passed to hooks. The `Authorization` header is redacted in `onRequest` events.
- The username-password flow and SOAP `login()` are not supported: Salesforce blocks or retires both.
