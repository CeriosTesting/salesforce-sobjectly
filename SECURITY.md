# Security Policy

## Supported versions

Only the latest published minor version gets security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through [GitHub Security Advisories](https://github.com/CeriosTesting/salesforce-sobjectly/security/advisories/new). Include:

- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- the affected version(s).

You can expect a first response within 5 working days.

## Design notes

- Access tokens, client secrets and private keys are never included in error messages or passed to hooks. The `Authorization` header is redacted.
- Absolute URLs (such as `nextRecordsUrl`) are only followed on the authenticated instance origin, unless `allowedOrigins` says otherwise.
- `SalesforceError.path` leaves out the query string, because SOQL in a query string can contain personal data.
- Values passed to the typed SOQL methods are escaped. Values you interpolate into `whereRaw`/`selectRaw` must be escaped with `soqlEscape`.
- The codegen config is meant to be committed, so don't write secrets into it as literals. Read them from the environment instead: `process.env.NAME` in `sobjectly.config.ts`, or a `"${NAME}"` placeholder in `sobjectly.config.json`. Error messages name the missing key or variable, never its value.
