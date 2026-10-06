---
"@cerios/salesforce-sobjectly": patch
---

`sfCli()` now works when `FORCE_COLOR` is set, for example in tests run by the Vitest VS Code extension. The Salesforce CLI colored its `--json` output, so the login failed with "did not return JSON". The CLI now runs with colors turned off.
