---
"@cerios/salesforce-sobjectly": minor
---

Add a dedicated logger: `new SalesforceClient({ logger })`. The logger has optional `debug`/`info`/`warn`/`error` methods that each receive a message and a typed event, so `logger: console` works as-is.

- **What it receives:** requests and responses (with bodies), token requests with every credential and token redacted, retries, network failures, 401 re-authentication, metadata cache hits, Bulk API job states, report runs, Apex test runs, debug-log trace flags, and codegen progress.
- **Per-request opt-out:** a request (and the token request it triggers) can be kept out of the log with `log: false`, e.g. `sf.request({ path, log: false })` or `sf.instanceUrl({ log: false })`.
- **Helpers:** `createLogger` routes every level to one handler (for Allure or Playwright reports); `filterLogger` and `isLevelEnabled` filter entries.
- **Codegen:** `generate()` accepts any `SalesforceLogger`, and `sobjectly generate --verbose` prints every request.
- **Deprecated:** `hooks` and `CodegenLogger`. They keep working; `hooks` now run through the logger and receive the same events as before.
- **Console vs. custom loggers:** `logger` accepts a list, e.g. `[consoleLogger(), allureLogger]`. `consoleLogger({ enabled, level, details })` can be switched off on its own (`details: "full"` prints the event data after the message, `details: "compact"` without repeating the request fields on `http.response`), and `log: { console: false }` keeps a single request off the console while custom loggers still get it.
- **Waiting for async loggers:** `sf.flushLogs({ timeoutMs })` waits for promises your loggers and hooks returned (e.g. report attachments), so nothing is lost when a test ends. Requests still never wait. `generate()` and `checkGenerated()` wait for their loggers before resolving.
