---
"@cerios/salesforce-sobjectly": major
---

First stable release: a type-safe Salesforce REST API client for TypeScript, with types generated from your org's sObjects.

- **Codegen:**
  - `sobjectly init` creates a TypeScript config (type-checked with `defineConfig`) or a JSON config (with a bundled JSON Schema);
  - `sobjectly generate` writes a read type, a create input and an update input for every sObject, plus a registry of external-id fields, field kinds, record type DeveloperNames and polymorphic lookups;
  - the generated file exports `API_VERSION`, `PICKLIST_VALUES` and `RECORD_TYPES`;
  - `--check` for CI compares content hashes, so formatting-only differences pass; `--stdout`, `checkGenerated()` and `generate({ write: false })` are there for programmatic use.
- **Typed SOQL builder:**
  - field names are checked and autocompleted, and results only contain the fields you selected;
  - parent paths over several levels (`selectRelated("Account.Owner", ...)`), child subqueries, `TYPEOF` through `selectPolymorphic`/`selectTypeOf` with the `isSObjectType` guard, `whereIn`, `whereRelated`, `whereIncludes`/`whereExcludes`, `whereNot`, aggregates and ordering;
  - values are checked per field (date fields take `soqlDate()`/`soqlDateLiteral()`, `LIKE` only on text fields, `= null` only on nillable fields) and always escaped; `soqlLike()` builds literal `LIKE` patterns.
- **REST API:** sObject CRUD, upsert and lookups by external-id fields, query and queryAll with pagination and async iteration, SOSL, Composite with typed references, batch, tree and graph, sObject Collections (with opt-in chunking), invocable actions and Flows, Apex REST, and any other endpoint through `request<T>()`. A query too long for a URL is sent as a composite subrequest automatically.
- **Platform APIs:** platform events (`sf.events.publish()`), approvals, quick actions, UI API, record type ids and picklist values per record type, files (up to 2 GB), reports (synchronous and asynchronous, with `toRows()`), query plans (`sf.explain()`) and typed org limits. Describe and object-info calls are cached per client; clear the cache with `sf.clearCache()` or turn it off with `cache: false`.
- **Tooling API:** queries, anonymous Apex, test runs and Apex debug-log capture (`sf.tooling.debugLogs.capture(work)`, or `executeAnonymous(apex, { captureLog: true })`).
- **Bulk API 2.0:** ingest and query jobs. Query results stream through an incremental CSV parser when the transport supports streaming.
- **Auth:** Salesforce CLI login (`sfCli`), static access token, client credentials, JWT bearer, refresh token or your own provider. Tokens are cached and shared by concurrent callers, and the client re-authenticates once on a 401.
- **HTTP:**
  - native `fetch` by default, behind a one-method transport interface that supports streaming;
  - request hooks, timeouts, and opt-in retries on 429/5xx for idempotent requests; `retry.errorCodes` (e.g. `["UNABLE_TO_LOCK_ROW"]`) also retries mutations that Salesforce rolled back;
  - absolute URLs are limited to the instance origin, and tokens are never logged.
- **Errors:** `SalesforceError`, `SalesforceSaveError`, `SalesforcePartialFailureError` (with the results of the chunks that succeeded), `SalesforceAuthError`, `SalesforceBulkJobError`, `ApexExecutionError` and `DebugLogCaptureError`; typed error codes (`SalesforceErrorCode`) and the `isSalesforceError`/`hasErrorCode` guards.
- Dual ESM/CJS builds for Node.js 20.19 or later. The only runtime dependency is `jiti`, which only the codegen CLI uses.
