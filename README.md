# @cerios/salesforce-sobjectly

A type-safe Salesforce REST API client for TypeScript. It generates types for your org's sObjects and gives you a typed SOQL builder, CRUD, composite requests, sObject collections, SOSL, invocable actions and Flows, the Tooling API and Bulk API 2.0. Requests go through native `fetch` by default, and any other HTTP client can be plugged in.

[![npm version](https://img.shields.io/npm/v/@cerios/salesforce-sobjectly.svg)](https://www.npmjs.com/package/@cerios/salesforce-sobjectly)
[![npm downloads](https://img.shields.io/npm/dm/@cerios/salesforce-sobjectly.svg)](https://www.npmjs.com/package/@cerios/salesforce-sobjectly)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4+-blue.svg)](https://www.typescriptlang.org/)

## ✨ Key Features

- **Generated sObject types**: `sobjectly generate` reads describe metadata and writes a read type, a create input and an update input for every sObject. Required fields, restricted picklists and relationships all come from your org. Picklists can also become named constants or enums, e.g. `CaseStatus.Working`.
- **Typed SOQL builder**: field names are checked and autocompleted. The query result only contains the fields you selected, so `record.Phone` is a compile error unless you selected `Phone`.
- **Relationship queries**: `selectRelated("Account", "Name")` and `selectChild("Contacts", c => c.select("Email"))` produce typed nested results.
- **The whole REST API**: sObject CRUD, upsert by external id, query and queryAll with pagination, SOSL, Composite, Composite Graph, sObject Tree, sObject Collections, invocable actions and Flows, the Tooling API, Apex REST and Bulk API 2.0. Anything else is reachable through `request<T>()`.
- **Platform APIs**: platform events, approvals, quick actions, UI API, files, reports, query plans and Apex debug-log capture.
- **CI-friendly codegen**: `sobjectly generate --check` fails when the generated file is out of date and ignores formatting-only differences.
- **Bring your own HTTP client**: `fetch` is the default; any other client (axios, undici, Playwright's `APIRequestContext`, a logging wrapper) fits a one-method interface.
- **Built-in auth**: Salesforce CLI login (`sfCli`), static access token, client credentials, JWT bearer, refresh token or your own provider. Tokens are cached, and the client re-authenticates once on a 401.
- **Safe by default**: values are escaped in SOQL, absolute URLs are limited to your instance's origin, tokens are never logged, and retries are opt-in. Mutations are only retried when you ask for it, e.g. on `UNABLE_TO_LOCK_ROW`, where Salesforce rolled the request back.
- **Small footprint**: dual ESM/CJS builds. The only runtime dependency is `jiti`, which the codegen CLI uses to load TypeScript configs; the client never loads it.

## 📦 Installation

```bash
npm install @cerios/salesforce-sobjectly
```

It needs Node.js 20.19 or later, and TypeScript 5.4 or later for the types.

## 🎯 Quick Start

### 1. Create a config

```bash
npx sobjectly init
```

`init` asks a few questions and writes `sobjectly.config.ts` or `sobjectly.config.json`:

- the API version, e.g. `v66.0`;
- where to write the generated types;
- which sObjects to generate;
- how to log in;
- how to type picklists;
- the config format: TypeScript (type-checked with `defineConfig`) or JSON (with a bundled JSON Schema for editor autocomplete).

It can also add the credential variables to `.env.example` and an npm script to `package.json`. Both formats are validated when loaded, and all problems are reported at once. A TypeScript config looks like this:

```ts
import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";

export default defineConfig({
	apiVersion: "v66.0",
	output: "src/generated/sobjects.ts",
	sobjects: ["Account", "Contact", "Case", "User"],
	// Fill these in from process.env (any variable names), a secret store or elsewhere.
	auth: {
		type: "clientCredentials",
		loginUrl: process.env.SF_LOGIN_URL,
		clientId: process.env.SF_CLIENT_ID,
		clientSecret: process.env.SF_CLIENT_SECRET,
	},
	picklists: "union",
});
```

The variable names are only suggestions; use whatever names your environment already has. A JSON config uses `"${NAME}"` placeholders instead. See [Auth](docs/codegen.md#auth) for every login method.

### 2. Generate types for your org

```bash
npx sobjectly generate --env-file .env
```

### 3. Use the typed client

```ts
import { SalesforceClient, clientCredentials } from "@cerios/salesforce-sobjectly";
import { API_VERSION, type SObjectRegistry } from "./generated/sobjects";

const sf = new SalesforceClient<SObjectRegistry>({
	apiVersion: API_VERSION, // the same version the types were generated with
	auth: clientCredentials({
		loginUrl: process.env.SF_LOGIN_URL!, // your My Domain URL
		clientId: process.env.SF_CLIENT_ID!,
		clientSecret: process.env.SF_CLIENT_SECRET!,
	}),
	// or reuse the config's auth: auth: await loadAuth() from "@cerios/salesforce-sobjectly/codegen"
});

// CRUD
const accountId = await sf.sobject("Account").create({ Name: "Acme" });
await sf.sobject("Account").update(accountId, { Phone: "+31 20 123 4567" });
const account = await sf.sobject("Account").get(accountId, ["Id", "Name", "Phone"]);

// Typed SOQL
const page = await sf.query(
	sf
		.soql("Contact")
		.select("Id", "Email")
		.selectRelated("Account", "Name")
		.where("Email", "LIKE", "%@acme.com")
		.orderBy("LastName")
		.limit(50),
);
page.records[0].Account?.Name; // string
page.records[0].Phone; // ❌ compile error: Phone was not selected

// Every record, across all pages
for await (const contact of sf.iterate(sf.soql("Contact").select("Id", "Email"))) {
	console.log(contact.Email);
}
```

## 📖 Documentation

| Guide                                                        | What's in it                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [Authentication](docs/authentication.md)                     | Salesforce CLI, access tokens, client credentials, JWT bearer, refresh tokens, custom providers              |
| [Code generation](docs/codegen.md)                           | Config reference, type mapping, required fields, picklists, CI usage                                         |
| [SOQL builder](docs/soql.md)                                 | Selecting, relationships, filters, aggregates, pagination, escaping                                          |
| [Composite & collections](docs/composite-and-collections.md) | Composite with references, batch, tree, graph, sObject collections                                           |
| [Approvals, files, reports & more](docs/platform.md)         | Record types, picklists, platform events, approvals, quick actions, UI API, files, reports, query plans      |
| [Bulk API 2.0](docs/bulk.md)                                 | Ingest jobs, query jobs, CSV handling                                                                        |
| [Transports](docs/transports.md)                             | Custom HTTP clients (axios and Playwright examples), streaming, hooks and request logging, retries, timeouts |
| [Endpoint coverage](docs/endpoints.md)                       | Which Salesforce REST resources have typed helpers                                                           |

## 🧭 API Overview

```ts
sf.sobject("Account"): basicInfo, describe, create, get, update, delete, upsert, getByExternalId,
                       getDeleted, getUpdated, getBlob, children, parent, listViews, listViewResults,
                       layouts, compactLayouts, approvalLayouts, query, collect, iterate
sf.soql("Account") → SoqlQueryBuilder
sf.query / sf.queryMore / sf.iterate / sf.collect     (queryAll via { includeDeleted: true })
sf.search:      sosl, parameterized, suggestions
sf.composite:   execute, batch, tree, graph   (typed builders; batch also uploads files)
sf.collections: create, update, upsert, delete, retrieve        (≤ 200 per call, or { chunk: true })
sf.actions:     invokeFlow, invokeApex, invokeStandard, invokeCustom, list*/describe*
sf.tooling:     query, sobject, executeAnonymous, runTestsSynchronous, runTestsAsynchronous, request
sf.bulk:        ingest, createIngestJob, query, createQueryJob
sf.events:      publish (platform events)
sf.approvals:   list, submit, approve, reject, pending
sf.files:       upload, download, newVersion, link
sf.reports:     list, describe, run, runAsync, instance, waitForInstance, toRows
sf.uiApi:       objectInfo, picklistValues, record, layout
sf.quickActions / sf.sobject(name).quickActions: list, describe, defaultValues, invoke
sf.sobject(name).recordTypeId(), .picklistValues();  sf.explain(query);  sf.clearCache()
sf.tooling.debugLogs: capture, list, body   (executeAnonymous(apex, { captureLog: true }))
sf.users:       passwordExpired, setPassword, resetPassword
sf.apexRest(), sf.request(), sf.limits(), sf.versions(), sf.describeGlobal(), sf.recordCount(), sf.recentlyViewed()
```

### Flows and invocable actions

```ts
const [result] = await sf.actions.invokeFlow<{ accountId: string }, { caseId: string }>("Start_Onboarding", [
	{ accountId },
]);
result.outputValues?.caseId;
```

### Composite with references

```ts
const result = await sf.composite.execute(
	(c) => {
		const account = c.create("Account", { Name: "Acme" });
		const contact = c.create("Contact", { LastName: "Doe", AccountId: account.ref("id") });
		return { account, contact };
	},
	{ allOrNone: true },
);
const contactId = result.get(result.refs.contact).id;
```

### Any other endpoint

```ts
import type { OrgLimits } from "@cerios/salesforce-sobjectly";

const limits = await sf.request<OrgLimits>({ path: "/limits" });
const tooling = await sf.request({ path: "/tooling/query", query: { q: "SELECT Id FROM ApexClass" } });
const custom = await sf.apexRest<{ ok: boolean }>({ method: "POST", path: "/orders", body: { id: 1 } });
```

`path` is relative to `/services/data/{apiVersion}`. Paths that start with `/services/` are used as-is, and absolute URLs must be on your instance's origin.

## 🔢 API version

There is no default API version: you always choose one.

- **Codegen:** `apiVersion` is required in `sobjectly.config.ts`, and `sobjectly generate` fails without it.
- **Client:** `apiVersion` is required in `new SalesforceClient({ ... })`, both as a TypeScript type and at runtime.

A fixed version means a Salesforce release, or an update of this package, never silently changes the API contract you call. Salesforce freezes behaviour per API version.

The generated file exports the version it was generated with as `API_VERSION`. Pass that to the client, so your types and your requests always use the same version. To upgrade, change `apiVersion` in the config and run `sobjectly generate` again.

## 🧯 Errors

| Error                           | When                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SalesforceError`               | Any non-2xx response. Carries `status`, `errorCode`, `errors[]`, `body`, `limitInfo` and a path without the query string.                                                              |
| `SalesforceSaveError`           | A 2xx response in which an item reported `success: false` (create, collections, actions).                                                                                              |
| `SalesforcePartialFailureError` | A call split into several requests (chunked collections, batched events) failed after earlier chunks succeeded. `completedResults` holds their results; `cause` is the original error. |
| `SalesforceAuthError`           | The token request failed. Carries the OAuth `error` and `errorDescription`, never secrets.                                                                                             |
| `SalesforceBulkJobError`        | A Bulk job ended as `Failed` or `Aborted`, or timed out.                                                                                                                               |
| `ApexExecutionError`            | Anonymous Apex failed to compile or threw.                                                                                                                                             |
| `DebugLogCaptureError`          | The work passed to `sf.tooling.debugLogs.capture()` threw. `logs` holds the logs collected anyway; `cause` is the original error.                                                      |

Error codes are typed, with autocomplete for the common ones (`SalesforceErrorCode`). Check them with the guards:

```ts
import { hasErrorCode, isSalesforceError } from "@cerios/salesforce-sobjectly";

try {
	await sf.sobject("Account").update(id, { Name: "Acme" });
} catch (error) {
	if (hasErrorCode(error, "UNABLE_TO_LOCK_ROW")) {
		// retry later
	} else if (isSalesforceError(error, "INSUFFICIENT_ACCESS_OR_READONLY")) {
		// ...
	}
}
```

## 🤝 Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## 📄 License

MIT © Ronald Veth - Cerios

## 🔗 Links

- [GitHub repository](https://github.com/CeriosTesting/salesforce-sobjectly)
- [npm package](https://www.npmjs.com/package/@cerios/salesforce-sobjectly)
- [Issue tracker](https://github.com/CeriosTesting/salesforce-sobjectly/issues)
- [Changelog](CHANGELOG.md)
