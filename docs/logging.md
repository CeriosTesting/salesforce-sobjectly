# Logging

Attach a logger to see everything the client does: each request to Salesforce and its response (with bodies), token requests (with secrets redacted), retries, network failures, re-authentication, metadata cache use, long-running operations (Bulk API jobs, report runs, Apex tests, debug-log capture) and code generation.

```ts
import { SalesforceClient } from "@cerios/salesforce-sobjectly";

const sf = new SalesforceClient({ auth, apiVersion: "v66.0", logger: console });
```

Nothing is logged without a logger. With one, every call is logged unless it opts out with [`log: false`](#keeping-a-call-out-of-the-log). You can attach several loggers, and switch the console off while your [custom loggers](#console-and-custom-loggers) keep running.

## The logger interface

```ts
interface SalesforceLogger {
	debug?(message: string, event: SalesforceLogEvent): unknown;
	info?(message: string, event: SalesforceLogEvent): unknown;
	warn?(message: string, event: SalesforceLogEvent): unknown;
	error?(message: string, event: SalesforceLogEvent): unknown;
}
```

- **Every method is optional.** Leave out the levels you don't want. `console`, a `{ info, warn }` object, or an adapter for pino or winston all fit.
- **Each call gets a message and an event.** The `message` is meant for people, for example `GET https://acme.my.salesforce.com/services/data/v66.0/limits → 200 (84 ms)`. The `event` holds the structured data. Its `type` tells you which kind of event it is, and TypeScript narrows the rest of the fields when you check it.
- **A method may return a promise.** It is not awaited, so a slow reporter doesn't slow down requests. Use [`sf.flushLogs()`](#waiting-for-async-loggers) to wait for it, e.g. before a test ends.
- **A logger never affects a request.** If a method throws or its promise rejects, the error is ignored.

### Events

| `type`                     | Level                                   | Fields (besides `type`)                                                                                                 |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `http.request`             | debug                                   | `method`, `url`, `headers` (`Authorization` redacted), `body`, `attempt`                                                |
| `http.response`            | debug; warn from status 400             | All `http.request` fields, plus `status`, `durationMs`, `responseHeaders` (no `set-cookie`), `responseBody`             |
| `http.retry`               | warn                                    | `method`, `url`, `attempt`, `reason` (`"status"`, `"errorCode"` or `"network"`), `status`, `delayMs`                    |
| `http.error`               | warn when retried, otherwise error      | `method`, `url`, `attempt`, `durationMs`, `error`, `willRetry`. The transport threw: network failure, timeout or abort  |
| `auth.reauthenticate`      | info                                    | `method`, `url`. Salesforce answered 401: the token is dropped and the request is sent once more                        |
| `auth.request`             | debug                                   | Like `http.request`, plus `grantType`. The form body has credentials replaced by `[REDACTED]`                           |
| `auth.response`            | debug; warn from status 400             | Like `http.response`, plus `grantType`. `access_token`, `refresh_token`, `id_token` and `signature` are `[REDACTED]`    |
| `auth.tokenIssued`         | info                                    | `provider`, `instanceUrl`, `expiresAt`, `durationMs`. Never the token                                                   |
| `auth.tokenCached`         | debug                                   | `provider`, `instanceUrl`, `expiresAt`                                                                                  |
| `auth.error`               | error                                   | `provider`, `error`, `durationMs`                                                                                       |
| `auth.refreshTokenRotated` | info                                    | `provider`. Never the new refresh token                                                                                 |
| `auth.cli`                 | debug                                   | `command`, `args`, `durationMs`, `ok`. `sfCli()` ran the Salesforce CLI; its output holds the token and is never logged |
| `cache.hit`, `cache.miss`  | debug                                   | `key`, e.g. `ui-object-info:Account`                                                                                    |
| `bulk.jobState`            | info when the state changed, else debug | `jobId`, `state`, `changed`, `numberRecordsProcessed`, `numberRecordsFailed`                                            |
| `report.status`            | debug while running, info when finished | `reportId`, `instanceId`, `status`                                                                                      |
| `tooling.runTests`         | info                                    | `mode` (`"sync"` or `"async"`), `numTestsRun`, `numFailures` (sync), `jobId` (async)                                    |
| `debugLogs.traceFlag`      | info                                    | `action` (`"created"`, `"updated"`, `"restored"` or `"deleted"`), `userId`, `traceFlagId`                               |
| `debugLogs.captured`       | info                                    | `userId`, `count`                                                                                                       |
| `codegen.progress`         | info                                    | `done`, `total`, `apiVersion`                                                                                           |
| `codegen.skip`             | warn                                    | `sobject`, `error`                                                                                                      |
| `codegen.write`            | info                                    | `outputPath`, `count`                                                                                                   |
| `codegen.warning`          | warn                                    | None; the `message` says what's wrong                                                                                   |
| `custom`                   | any                                     | `source`, `data`. Events you emit yourself, e.g. from a custom auth provider                                            |

The request and response events fire once per attempt, so a retried request shows up once per try. `attempt` tells the tries apart.

A successful streamed response (Bulk API query results over `fetchTransport`) has no `responseBody`, because the body hasn't been read yet when the event fires. Error responses are buffered and do have one.

## Custom logging

`createLogger` sends every level to one function. That's the easiest way to build your own sink, because a report usually wants every response whatever its level.

```ts
import { createLogger, SalesforceClient } from "@cerios/salesforce-sobjectly";

const logger = createLogger((level, message, event) => {
	if (event.type === "http.response") {
		myReport.add({ title: message, status: event.status, request: event.body, response: event.responseBody });
	}
	if (level !== "debug") {
		console[level](message);
	}
});

const sf = new SalesforceClient({ auth, apiVersion: "v66.0", logger });
```

### Attach responses to an Allure report

With `allure-js-commons`, attach each call as JSON. The handler returns Allure's promise; requests don't wait for it, but [`sf.flushLogs()`](#waiting-for-async-loggers) does.

```ts
import { createLogger, type HttpResponseLogEvent } from "@cerios/salesforce-sobjectly";
import * as allure from "allure-js-commons";

function readable(body: string | Uint8Array | undefined): unknown {
	if (typeof body !== "string") return body && `<${body.byteLength} bytes>`;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		return body; // CSV, XML or plain text
	}
}

function describeCall(event: HttpResponseLogEvent): { name: string; json: string } {
	return {
		name: `${event.method} ${new URL(event.url).pathname} → ${event.status}`,
		json: JSON.stringify(
			{
				request: { method: event.method, url: event.url, attempt: event.attempt, body: readable(event.body) },
				response: { status: event.status, durationMs: event.durationMs, body: readable(event.responseBody) },
			},
			null,
			2,
		),
	};
}

export const allureLogger = createLogger((_level, _message, event) => {
	if (event.type === "http.response") {
		const { name, json } = describeCall(event);
		return allure.attachment(name, json, "application/json");
	}
	return undefined;
});
```

### Attach responses in Playwright tests

Without Allure, attach the calls to the Playwright test instead:

```ts
import { test } from "@playwright/test";

export const playwrightLogger = createLogger((_level, _message, event) => {
	if (event.type === "http.response") {
		const { name, json } = describeCall(event);
		return test.info().attach(name, { body: json, contentType: "application/json" });
	}
	return undefined;
});
```

### Report and log at the same time

`logger` takes a list, and every logger in it gets every entry. Here responses go to the Allure report, and everything from `info` up goes to the console:

```ts
new SalesforceClient({ auth, apiVersion: "v66.0", logger: [consoleLogger(), allureLogger] });
```

## Console and custom loggers

`consoleLogger()` prints to the console and can be switched off on its own, while your custom loggers keep running:

```ts
import { consoleLogger, SalesforceClient } from "@cerios/salesforce-sobjectly";

new SalesforceClient({
	auth,
	apiVersion: "v66.0",
	logger: [
		consoleLogger({ enabled: process.env.SF_LOG_CONSOLE !== "false", level: "debug" }),
		allureLogger, // always on
	],
});
```

| Option    | Default          | What it does                                                                     |
| --------- | ---------------- | -------------------------------------------------------------------------------- |
| `enabled` | `true`           | `false` prints nothing. The other loggers in the list are unaffected             |
| `level`   | `"info"`         | The lowest level printed. `"debug"` also prints every request and response       |
| `details` | message only     | `"full"` or `"compact"` also prints each event's data (see below)                |
| `output`  | global `console` | Anything with `debug`/`info`/`warn`/`error` methods, e.g. a console for a stream |

By default only the one-line message is printed. `details` adds the event's data after it:

| `details`   | What follows the message                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"full"`    | The whole event, as your custom loggers get it. An `http.response` repeats the method, url, request headers and request body from its `http.request`, like `logger: console` |
| `"compact"` | The same, except an `http.response` shows only the status, duration, attempt and response headers and body: its `http.request` line already printed the rest                 |

```ts
logger: consoleLogger({ level: "debug", details: "compact" });
```

Your custom loggers always get the full event, so a report can attach a request and its response from the `http.response` event alone.

These count as console loggers: the global `console`, `consoleLogger()`, and a `filterLogger` around either of them. Everything else is a custom logger. `isConsoleLogger(logger)` tells you which one a logger is.

### pino and winston

pino takes the data object first and the message second, so it needs a small adapter:

```ts
import pino from "pino";

const log = pino();
const logger = createLogger((level, message, event) => log[level](event, message));
```

winston takes the message first, so it fits directly: `logger: winston.createLogger({ ... })`.

## Waiting for async loggers

Requests never wait for your loggers. When a logger returns a promise, for example a report attachment that's still being written, `sf.flushLogs()` waits for it, and for every other logger and hook promise still running:

```ts
afterEach(async () => {
	await sf.flushLogs({ timeoutMs: 5_000 });
});
```

- **Result:** it resolves `true` once everything has settled, or `false` if `timeoutMs` passed first. Without `timeoutMs` it waits as long as it takes.
- **Failures:** a logger promise that rejects counts as settled; `flushLogs` never throws.
- **Order:** promises started while it waits are awaited too.
- **Codegen:** `generate()` and `checkGenerated()` already wait for their loggers before they resolve.

## Filtering

`filterLogger` passes on only the entries you accept. `isLevelEnabled` compares levels:

```ts
import { filterLogger, isLevelEnabled } from "@cerios/salesforce-sobjectly";

// Only warnings and errors:
logger: filterLogger(console, (level) => isLevelEnabled(level, "warn"));

// Everything except the metadata cache:
logger: filterLogger(console, (_level, event) => !event.type.startsWith("cache."));
```

## Keeping a call out of the log

Pass `log: false` to keep one request out of the logger, for example a call whose response holds credentials or personal data. A token request that call triggers isn't logged either.

```ts
await sf.request({ path: "/services/oauth2/userinfo", log: false });
await sf.apexRest({ path: "/credentials/vault", log: false });
await sf.instanceUrl({ log: false }); // the token request isn't logged
```

To keep a call off the console only, pass `log: { console: false }`. The console loggers skip it, but your custom loggers (an Allure report, say) still get it, including the token request it triggers:

```ts
await sf.request({ path: "/services/oauth2/userinfo", log: { console: false } });
await sf.instanceUrl({ log: { console: false } });
```

| `log`                | Console loggers | Custom loggers and hooks |
| -------------------- | --------------- | ------------------------ |
| `true` (default)     | yes             | yes                      |
| `{ console: false }` | no              | yes                      |
| `false`              | no              | no                       |

Events that don't belong to a single request (bulk job states, report polling, cache hits, codegen progress) aren't affected by `log`. To silence those on the console, use `consoleLogger({ enabled: false })` or a `filterLogger`.

`log` defaults to `true`. It works on `sf.request`, `sf.requestWithResponse`, `sf.apexRest`, `sf.tooling.request`, `sf.connection.send`/`stream` and `sf.instanceUrl`.

The token is cached, so later calls reuse it. When several calls wait on the same token request, the call that started it decides whether that token request is logged.

## Custom auth providers

`AuthContext` carries the client's loggers combined into one `logger` (`undefined` with `log: false`, without the console loggers with `log: { console: false }`). Your own `tokenProvider` or `AuthProvider` can log through it:

```ts
const auth = tokenProvider(async (context) => {
	context.logger?.info?.("Fetching a token from the vault", { type: "custom", source: "vault-auth" });
	return fetchFromVault(context.signal);
});
```

`tokenProvider` already logs `auth.tokenIssued`, `auth.tokenCached` and `auth.error` for you. Never put a token or secret in a log message.

## Code generation

`generate()` and `checkGenerated()` take the same logger. Progress arrives at `info` and problems at `warn`. At `debug` you also get the describe calls and the token request. Existing `{ info, warn }` loggers keep working. Both resolve only after an async logger's promises have settled.

```ts
await generate(config, { logger: filterLogger(console, (level) => level !== "debug") });
```

On the command line, `sobjectly generate --verbose` also prints every request and token call.

## Security

- **Tokens are never logged.** The `Authorization` header is replaced by `Bearer [REDACTED]`. Token request bodies and token responses have every credential replaced by `[REDACTED]`. `sfCli()` output is never logged.
- **Bodies contain your record data.** Treat reports and logs that include them accordingly, or drop the bodies in a `filterLogger`/`createLogger`.
- **The deprecated `hooks` see less.** They still receive only `http.request` and `http.response`. Token requests never reach them.

## Migrating from `hooks`

`hooks` still works but is deprecated. Each hook maps to one event:

| Before                         | After                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `hooks: { onRequest(event) }`  | `createLogger((level, message, event) => ...)`, `event.type === "http.request"`  |
| `hooks: { onResponse(event) }` | `createLogger((level, message, event) => ...)`, `event.type === "http.response"` |

The events carry the same fields as before, plus `type`.
