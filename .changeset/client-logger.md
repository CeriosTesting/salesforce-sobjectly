---
"@cerios/salesforce-sobjectly": minor
---

Add a dedicated logger: `new SalesforceClient({ logger, log: true })`. The logger has optional `debug`/`info`/`warn`/`error` methods that each receive a message and a typed event, so `logger: console` works as-is.

- **Off by default:** a logger logs nothing until logging is turned on. Turn it on for the whole client with `log: true`, for a group of calls with `sf.withLog(true)`, or for one call with its own `log: true`. The most specific setting wins, and `false` or `{ console: false }` work at every level too.
- **What it receives:** requests and responses (with bodies), token requests with every credential and token redacted, retries, network failures, 401 re-authentication, metadata cache hits, Bulk API job states, report runs, Apex test runs, debug-log trace flags, and codegen progress.
- **Per call:** `log` on `sf.request()`, `sf.instanceUrl()` and friends covers that call and the token request it triggers. Long-running operations take it too: `bulk.ingest`/`query` (and the job they return), `job.waitForCompletion`, `reports.run`/`runAsync`/`waitForInstance`, `tooling.runTests*` and `debugLogs.capture`.
- **`sf.withLog(log)`:** returns a client that uses `log` for everything done through it, including token requests, metadata lookups and long-running operations. It shares the token, cache, API usage, loggers and `flushLogs` with `sf`.
- **Shared requests:** when several calls share one token or metadata request, each call gets its events according to its own `log`, including the ones logged before it joined. A logger gets each event once.
- **Helpers:**
  - `createLogger` sends every level to one handler, e.g. for Allure or Playwright reports.
  - `filterLogger` and `isLevelEnabled` filter entries.
- **Console vs. custom loggers:**
  - `logger` accepts a list, e.g. `[consoleLogger(), allureLogger]`.
  - `consoleLogger({ enabled, level, details })` can be switched off on its own. `details: "full"` prints the event data after the message; `details: "compact"` does the same without repeating the request fields on `http.response`.
  - `log: { console: false }` logs to the custom loggers only.
- **Waiting for async loggers:** `sf.flushLogs({ timeoutMs })` waits for promises your loggers and hooks returned (e.g. report attachments), so nothing is lost when a test ends. Requests still never wait. `generate()` and `checkGenerated()` wait for their loggers before resolving.
- **Codegen:** `generate()` accepts any `SalesforceLogger` for progress and warnings. `log: true` also logs its describe and token calls, and `sobjectly generate --verbose` prints them.
- **Deprecated:** `hooks` and `CodegenLogger`. They keep working. Hooks fire as before without `log: true`; only an explicit `log: false` skips them.
