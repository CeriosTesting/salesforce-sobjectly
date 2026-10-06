# Code generation

`sobjectly generate` calls the describe API for each sObject and writes one TypeScript file. That file contains:

- a **read interface** per sObject (`Account`): every field with its TypeScript type, plus `| null` for nillable fields;
- a **create input** (`AccountCreateInput`): createable fields only. Fields that are `createable && !nillable && !defaultedOnCreate` are required;
- an **update input** (`AccountUpdateInput`): updateable fields only, all optional;
- **`SObjectRegistry`**: ties the types together. Pass it to `new SalesforceClient<SObjectRegistry>()`. Per sObject it also records:
  - relationships: `parents`, `children` and `polymorphicParents`;
  - `externalIds`: the fields upsert accepts;
  - `fieldKinds`: date, datetime, time and multipicklist fields, so `where()` can check values;
  - `recordTypes`: record type DeveloperNames.
- with `picklists: "const"` or `"enum"`, a **named type per picklist** (`CaseStatus`), declared before its sObject;
- **`PICKLIST_VALUES`** and **`RECORD_TYPES`**: runtime constants, e.g. to loop over every status in a test. Turn them off with `constants: false`;
- **`API_VERSION`**: the version the types were generated with.

## Getting started: `sobjectly init`

```bash
npx sobjectly init
```

`init` asks for everything the config needs:

1. **API version** (required, no default). Enter e.g. `v66.0` or just `66`. Your org lists its versions at `https://<my-domain>.my.salesforce.com/services/data/`.
2. **Output file** for the generated types (suggested: `src/generated/sobjects.ts`).
3. **sObjects**: comma-separated API names, e.g. `Account, Contact, My_Object__c`.
4. **Login method**: client credentials, a Salesforce CLI org, an access token or JWT bearer. The config gets an [`auth`](#auth) object with one key per credential, read from `process.env` (TypeScript) or `"${NAME}"` placeholders (JSON). The suggested `SF_*` names are only a starting point; rename them to whatever your environment uses.
5. **Picklist typing**: unions of values, a named constant or enum per picklist, or plain strings.
6. **Config format**: TypeScript (`sobjectly.config.ts`) or JSON (`sobjectly.config.json`).

Then it offers to:

- add the variables the config reads to `.env.example`;
- add a `sobjects:generate` script to `package.json`.

It prints the next steps when done. If a config already exists, `init` asks before replacing it. When you switch formats, the old file is removed, so only one config remains.

For scripts and CI, pass answers as flags. `--yes` accepts the suggestions for everything else, but `--api-version` is always required:

```bash
npx sobjectly init --yes --api-version v66.0 --sobjects "Account,Contact" --auth clientCredentials
```

Other flags: `--output`, `--target-org <alias>` (with `--auth sfCli`), `--picklists union|string|const|enum`, `--format ts|json`, `--force`.

## Config

The config is either `sobjectly.config.ts` (`.mts` and `.cts` also work) or `sobjectly.config.json`. If both exist, the TypeScript file wins and `generate` prints a warning. Pass `--config <path>` to use another file name.

Both formats are validated when they are loaded. An invalid config fails with every problem listed at once:

```text
Invalid sobjectly config (/app/sobjectly.config.json):
  - apiVersion: must look like "v66.0", got "66".
  - excludeCreateFields.Acount: "Acount" is not listed in sobjects.
  - picklist: unknown option. Valid options: output, apiVersion, sobjects, ...
```

### TypeScript: type-checked with `defineConfig`

`defineConfig` gives autocomplete and compile-time checks:

- `apiVersion` must look like `"v66.0"`;
- `auth` must be a known type, with only that type's options. Credentials are strings, and `process.env.NAME` (`string | undefined`) is accepted;
- `picklists` must be `"union"`, `"string"`, `"const"` or `"enum"`;
- unknown options are errors.

The listed `sobjects` also become a type, so a typo in a per-sObject option is a compile error:

```ts
import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";

export default defineConfig({
	output: "src/generated/sobjects.ts",
	apiVersion: "v66.0",
	sobjects: ["Account", "Contact", "Case", "Opportunity", "User", "My_Object__c"],
	auth: {
		type: "clientCredentials",
		loginUrl: process.env.SF_LOGIN_URL,
		clientId: process.env.SF_CLIENT_ID,
		clientSecret: process.env.SF_CLIENT_SECRET,
	},
	excludeCreateFields: {
		// Fields that describe calls createable but that the REST API rejects in your org
		Account: ["PersonMailingAddress"],
	},
	picklists: "union",
});
```

```ts
export default defineConfig({
	apiVersion: "v66.0",
	output: "src/generated/sobjects.ts",
	sobjects: ["Account", "Contact"],
	excludeCreateFields: { Acount: ["Name"] }, // ❌ Type error: "Acount" is not in sobjects
});
```

Three things only work in a TypeScript config: an `AuthProvider` object as `auth`, a `format` hook, and a custom `transport`.

### JSON: validated with a JSON Schema

```json
{
	"$schema": "./node_modules/@cerios/salesforce-sobjectly/sobjectly.config.schema.json",
	"apiVersion": "v66.0",
	"output": "src/generated/sobjects.ts",
	"sobjects": ["Account", "Contact", "Case"],
	"auth": {
		"type": "clientCredentials",
		"loginUrl": "${SF_LOGIN_URL}",
		"clientId": "${SF_CLIENT_ID}",
		"clientSecret": "${SF_CLIENT_SECRET}"
	},
	"picklists": "union"
}
```

The package ships `sobjectly.config.schema.json`. The `$schema` line gives VS Code and other editors autocomplete, descriptions and inline errors. JSON configs support every option except `format`, `transport` and auth providers. Use an [auth setting](#auth) with `"${NAME}"` placeholders instead.

### Options

| Option                    | Default                          | Description                                                                                                                                 |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `output`                  | (required)                       | Output file, relative to the config file.                                                                                                   |
| `apiVersion`              | (required)                       | The API version, e.g. `"v66.0"`. Exported as `API_VERSION` (see below).                                                                     |
| `sobjects`                | every queryable sObject          | sObjects to generate. **Set this.** An org can have thousands of sObjects. Names are matched case-insensitively; an empty list is an error. |
| `exclude`                 | `[]`                             | sObjects to skip.                                                                                                                           |
| `auth`                    | client credentials from `SF_*`   | An auth setting with your credentials (see [Auth](#auth)) or any `AuthProvider`.                                                            |
| `excludeCreateFields`     | `{}`                             | Per-sObject fields to drop from the create input.                                                                                           |
| `excludeUpdateFields`     | `{}`                             | Per-sObject fields to drop from the update input.                                                                                           |
| `picklists`               | `"union"`                        | `"union"`, `"string"`, `"const"` or `"enum"` (see [Picklists](#picklists)).                                                                 |
| `constants`               | `true`                           | Emit the `PICKLIST_VALUES` and `RECORD_TYPES` runtime constants.                                                                            |
| `concurrency`             | `10`                             | Parallel describe calls.                                                                                                                    |
| `continueOnDescribeError` | `false`                          | Skip sObjects whose describe fails instead of aborting.                                                                                     |
| `importSource`            | `"@cerios/salesforce-sobjectly"` | Where the generated file imports `SalesforceAddress` / `SalesforceGeolocation` from.                                                        |
| `format`                  | none                             | TypeScript only. `(source, path) => string`: post-process the output.                                                                       |
| `transport`               | fetch                            | TypeScript only. A custom transport for describe calls.                                                                                     |

### Auth

`auth` picks a login method with `type` and holds its credentials. You decide where the values come from. In a TypeScript config that is usually `process.env`, with any variable names you like:

```ts
auth: {
	type: "clientCredentials",
	loginUrl: process.env.ACME_SF_LOGIN_URL,
	clientId: process.env.ACME_SF_CLIENT_ID,
	clientSecret: readFileSync("/run/secrets/sf_client_secret", "utf8").trim(), // or any other source
},
```

A JSON config can't run code, so it uses `"${NAME}"` placeholders. A value that is exactly `"${NAME}"` is read from the environment variable `NAME`:

```json
"auth": { "type": "clientCredentials", "loginUrl": "${ACME_SF_LOGIN_URL}", "clientId": "${ACME_SF_CLIENT_ID}", "clientSecret": "${ACME_SF_CLIENT_SECRET}" }
```

| `type`              | Keys (the default variable when a key is left out)                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sfCli`             | `targetOrg`: an org you're logged into with the Salesforce CLI (`sf org login web`). Left out, the CLI's default org is used, which the CLI's own `SF_TARGET_ORG` variable can set. No secrets. |
| `clientCredentials` | `loginUrl` (`SF_LOGIN_URL`), `clientId` (`SF_CLIENT_ID`), `clientSecret` (`SF_CLIENT_SECRET`)                                                                                                   |
| `accessToken`       | `accessToken` (`SF_ACCESS_TOKEN`), `instanceUrl` (`SF_INSTANCE_URL`)                                                                                                                            |
| `jwtBearer`         | `loginUrl` (`SF_LOGIN_URL`), `clientId` (`SF_CLIENT_ID`), `username` (`SF_USERNAME`), and `privateKey` (`SF_PRIVATE_KEY`, the PEM text) or `privateKeyPath` (`SF_PRIVATE_KEY_PATH`)             |

How values are resolved:

- **A key you set is always used.** If it ends up empty, for example because `process.env.ACME_SF_CLIENT_ID` is not set, `generate` fails. It does not fall back to `SF_CLIENT_ID`.
- **A key you leave out** is read from its default `SF_*` variable. Without `auth`, client credentials come from `SF_LOGIN_URL`, `SF_CLIENT_ID` and `SF_CLIENT_SECRET`.
- **JWT keys:** `privateKey` wins when it has a value; otherwise the file at `privateKeyPath` is read. Once you set either one, neither falls back to its `SF_*` variable, so a stray `SF_PRIVATE_KEY` can't override your key file.
- **Every missing credential is reported at once**, with where it was expected to come from.

Keep secrets out of the config file. `--env-file .env` loads a dotenv file before the config is read, so `process.env` and `"${NAME}"` both see its values.

**Deprecated: `*Env` keys.** Keys such as `clientIdEnv: "MY_CLIENT_ID"` still work in 1.x, but print a warning and will be removed in 2.0. Replace them with the value itself:

```ts
auth: { type: "clientCredentials", clientIdEnv: "MY_CLIENT_ID" },       // before
auth: { type: "clientCredentials", clientId: process.env.MY_CLIENT_ID }, // after (TypeScript)
```

In JSON, use `"clientId": "${MY_CLIENT_ID}"`. A key and its `*Env` variant can't be used together.

The client can log in with the same setting: `auth: await loadAuth()`. See [Reuse the codegen config's auth](authentication.md#reuse-the-codegen-configs-auth).

## API version

The generated file ends with the version it was generated with:

```ts
export const API_VERSION = "v66.0";
```

Pass it to the client so requests use the same version as the types:

```ts
import { API_VERSION, type SObjectRegistry } from "./generated/sobjects";

const sf = new SalesforceClient<SObjectRegistry>({ apiVersion: API_VERSION, auth });
```

There is no default version. `sobjectly generate` fails when `apiVersion` is missing, and so does the client. To move to a newer version, change `apiVersion` in the config, run `sobjectly generate` again, and review the diff.

## CLI

```bash
npx sobjectly init                              # create sobjectly.config.ts interactively
npx sobjectly generate                          # finds sobjectly.config.* in the current directory
npx sobjectly generate --config tools/sf.config.ts --env-file .env.ci
npx sobjectly generate --check                  # CI: fail when the generated file is out of date
npx sobjectly generate --stdout > preview.ts    # print instead of writing
```

### `--check` in CI

`--check` generates the types in memory and compares them with the file on disk, without writing anything.

**Exit codes**

- **0**: the file is up to date.
- **1**: the file is missing, or the org's schema changed. The output names the sObjects that were added, removed or changed.

**Formatting doesn't count.** The generated header records a hash of the content, taken before your `format` hook or any formatter runs:

```ts
// sobjectly-content-hash: sha256:3f5a...
// sobjectly-sobjects: Account:518a815feb9e,Case:2a84e0d2628b,...
```

Prettier, oxfmt and the `format` hook keep these comments, so a reformatted file still counts as up to date.

**Older files.** Files written before these header lines existed are compared with whitespace, quote style, semicolons and commas ignored.

`--check` still calls the describe API, so CI needs credentials. For example, expose client credentials from your CI secrets as environment variables with the names your config reads.

The file is written atomically (to a temp file, then renamed), and the output is deterministic: sObjects and fields are sorted and `Id` comes first. That keeps diffs readable. Commit the generated file and re-run the generator when the org's schema changes.

## Programmatic use

```ts
import { checkGenerated, generate, generateSource } from "@cerios/salesforce-sobjectly/codegen";

await generate(config, { cwd: process.cwd(), logger: console });
const { source } = await generate(config, { write: false }); // don't write, just return the source
const check = await checkGenerated(config); // { upToDate, reason, added, removed, changed }
const source = generateSource(describes, { picklists: "string" }); // pure: describes in, source out
```

`generate` and `checkGenerated` read `"${NAME}"` placeholders and the default `SF_*` variables from `process.env`. Pass `env` to use another source, e.g. `generate(config, { env: secrets })`. To get the auth provider by itself, call `resolveAuth(config.auth, process.env)`, or `await loadAuth()` to find and load the config file first. Both throw one error listing every missing credential.

## Type mapping

| Salesforce type                                                                               | TypeScript                            |
| --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `boolean`                                                                                     | `boolean`                             |
| `int`, `long`, `double`, `currency`, `percent`                                                | `number`                              |
| `date`                                                                                        | `string` (`yyyy-MM-dd`)               |
| `datetime`                                                                                    | `string` (ISO 8601)                   |
| `time`                                                                                        | `string` (`HH:mm:ss.SSSZ`)            |
| `id`, `reference`, `string`, `textarea`, `email`, `phone`, `url`, `encryptedstring`, `base64` | `string`                              |
| `picklist`, `combobox`                                                                        | union, named type or `string` (below) |
| `multipicklist`                                                                               | `string` (values joined by `;`)       |
| `address`                                                                                     | `SalesforceAddress`                   |
| `location`                                                                                    | `SalesforceGeolocation`               |
| anything else (`anyType`, `complexvalue`, new types)                                          | `unknown`                             |

Dates and date-times stay strings because that is what the REST API returns. Convert them with `new Date(value)` where needed.

### Picklists

The `picklists` option sets how picklist and combobox fields are typed:

| Mode                | `Case.Status` is                 | Also emits                                    |
| ------------------- | -------------------------------- | --------------------------------------------- |
| `"union"` (default) | `"New" \| "Working" \| "Closed"` | nothing                                       |
| `"const"`           | `CaseStatus`, the same union     | `CaseStatus` as an `as const` object and type |
| `"enum"`            | `CaseStatus`, a TypeScript enum  | `export enum CaseStatus`                      |
| `"string"`          | `string`                         | nothing                                       |

In every mode except `"string"`:

- **Restricted picklists** only accept their active values: `"New" | "Working" | "Closed"`. An invalid value is a compile error.
- **Unrestricted picklists** and comboboxes become `"A" | "B" | (string & {})`. You get autocomplete, and any other string is still accepted.

Values can differ per record type; the type covers all of them.

#### Named picklist types: `"const"` and `"enum"`

With `picklists: "const"`, every picklist gets an `as const` object and a type of the same name, declared before its sObject:

```ts
/** Active values of Case.Status (picklist). */
export const CaseStatus = {
	New: "New",
	Working: "Working",
	Closed: "Closed",
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export interface Case {
	Status: CaseStatus;
	// ...
}
```

`CaseStatus` is the same union as in `"union"` mode, so plain strings keep working next to the members:

```ts
sf.soql("Case").where("Status", "=", CaseStatus.Working);
sf.soql("Case").where("Status", "=", "Working"); // also fine
```

With `picklists: "enum"`, every picklist gets a TypeScript `enum` instead: `export enum CaseStatus { New = "New", ... }`. Enums are nominal, so a restricted picklist then only accepts enum members: `where("Status", "=", "Working")` and `create({ Status: "Working" })` become compile errors. Enums also don't work with `erasableSyntaxOnly` or Node's type stripping. Prefer `"const"` unless you specifically want enums.

Multi-select picklists get a named type too, for building values. The field itself stays a `string` (values joined by `;`).

**Type names** are the sObject name followed by the field name, in PascalCase without underscores:

| Field                 | Type name              |
| --------------------- | ---------------------- |
| `Case.Status`         | `CaseStatus`           |
| `Case.Status__c`      | `CaseStatusCustom`     |
| `Case.Lead_Source__c` | `CaseLeadSourceCustom` |
| `Project__c.Stage__c` | `ProjectStageCustom`   |

A custom field's `__c` becomes `Custom`, so `Status` and `Status__c` on the same sObject get different names. A custom sObject's `__c` is dropped.

When a name is already taken, `Picklist` is appended. Standard sObjects such as `CaseStatus`, `TaskStatus` and `LeadStatus` cause this: if you also generate the `CaseStatus` sObject, the type for `Case.Status` is `CaseStatusPicklist`. If that name is taken as well, generation fails; exclude one of the sObjects.

**Member names** are the values themselves when those are valid identifiers (`New`). Other values are cleaned up: `"Closed Won"` becomes `Closed_Won`, `"Proposal/Price Quote"` becomes `Proposal_Price_Quote` and `"3rd Party"` becomes `_3rd_Party`. When that leaves nothing, or another member already has the name, the value is used as a quoted key: `CaseStatus["Closed-Won"]`. The values themselves are never changed.

## Relationships

- **`parents`** includes lookups with a relationship name and a single target (e.g. `Contact.Account`) whose target sObject is also generated.
- **`polymorphicParents`** lists lookups with several targets, e.g. `Owner` on Case (`"Group" | "User"`) or `What` on Task. Query them with `selectPolymorphic` or `selectTypeOf` (see the SOQL guide).
- **`children`** includes child relationships with a relationship name (e.g. `Account.Contacts`) whose child sObject is also generated.

## Caveats

- Required fields come from describe metadata. Validation rules, record types and triggers can require more at runtime.
- Field-level security applies: the generated types only contain fields the describing user can see.
