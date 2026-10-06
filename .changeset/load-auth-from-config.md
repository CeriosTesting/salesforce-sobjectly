---
"@cerios/salesforce-sobjectly": minor
---

`loadAuth()` (from `@cerios/salesforce-sobjectly/codegen`) reads your `sobjectly.config.*` and returns an auth provider for its `auth` setting, so the client logs in the same way as `sobjectly generate`: `new SalesforceClient({ apiVersion: API_VERSION, auth: await loadAuth() })`. Pass another provider to override it. Without a config file it throws an error that explains how to fix it.
