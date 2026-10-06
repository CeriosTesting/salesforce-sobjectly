---
"@cerios/salesforce-sobjectly": minor
---

The codegen `auth` setting now holds the credentials themselves, so you choose where they come from: `clientId: process.env.ANY_NAME` in a TypeScript config, or a `"${ANY_NAME}"` placeholder in JSON. `sfCli`'s `targetOrg` takes the same kinds of values; left out, the CLI's default org is used. `sobjectly init` writes the full object for the chosen login method. Keys you leave out still fall back to the `SF_*` variables, and every missing credential is now reported in one error. The `*Env` keys (`clientIdEnv` etc.) still work but are deprecated and print a warning; they will be removed in 2.0.
