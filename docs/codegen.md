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
4. **Login method**: client credentials, access token or JWT bearer.
5. **Picklist typing**: unions of values, or plain strings.
6. **Config format**: TypeScript (`sobjectly.config.ts`) or JSON (`sobjectly.config.json`).

Then it offers to:

- add the credential variables for your login method to `.env.example`;
- add a `sobjects:generate` script to `package.json`.

It prints the next steps when done. If a config already exists, `init` asks before replacing it. When you switch formats, the old file is removed, so only one config remains.

For scripts and CI, pass answers as flags. `--yes` accepts the suggestions for everything else, but `--api-version` is always required:

```bash
npx sobjectly init --yes --api-version v66.0 --sobjects "Account,Contact" --auth clientCredentials
```

Other flags: `--output`, `--picklists union|string`, `--format ts|json`, `--force`.

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
- `auth` must be a known type, with only that type's options;
- `picklists` must be `"union"` or `"string"`;
- unknown options are errors.

The listed `sobjects` also become a type, so a typo in a per-sObject option is a compile error:

```ts
import { defineConfig } from "@cerios/salesforce-sobjectly/codegen";

export default defineConfig({
	output: "src/generated/sobjects.ts",
	apiVersion: "v66.0",
	sobjects: ["Account", "Contact", "Case", "Opportunity", "User", "My_Object__c"],
	auth: { type: "clientCredentials" },
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
	"auth": { "type": "clientCredentials" },
	"picklists": "union"
}
```

The package ships `sobjectly.config.schema.json`. The `$schema` line gives VS Code and other editors autocomplete, descriptions and inline errors. JSON configs support every option except `format`, `transport` and auth providers; use env-based `auth` instead.

### Options

| Option                    | Default                          | Description                                                                                                                                 |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `output`                  | (required)                       | Output file, relative to the config file.                                                                                                   |
| `apiVersion`              | (required)                       | The API version, e.g. `"v66.0"`. Exported as `API_VERSION` (see below).                                                                     |
| `sobjects`                | every queryable sObject          | sObjects to generate. **Set this.** An org can have thousands of sObjects. Names are matched case-insensitively; an empty list is an error. |
| `exclude`                 | `[]`                             | sObjects to skip.                                                                                                                           |
| `auth`                    | client credentials from env      | An env-based auth setting (see below) or any `AuthProvider`.                                                                                |
| `excludeCreateFields`     | `{}`                             | Per-sObject fields to drop from the create input.                                                                                           |
| `excludeUpdateFields`     | `{}`                             | Per-sObject fields to drop from the update input.                                                                                           |
| `picklists`               | `"union"`                        | `"union"` or `"string"` (see below).                                                                                                        |
| `constants`               | `true`                           | Emit the `PICKLIST_VALUES` and `RECORD_TYPES` runtime constants.                                                                            |
| `concurrency`             | `10`                             | Parallel describe calls.                                                                                                                    |
| `continueOnDescribeError` | `false`                          | Skip sObjects whose describe fails instead of aborting.                                                                                     |
| `importSource`            | `"@cerios/salesforce-sobjectly"` | Where the generated file imports `SalesforceAddress` / `SalesforceGeolocation` from.                                                        |
| `format`                  | none                             | TypeScript only. `(source, path) => string`: post-process the output.                                                                       |
| `transport`               | fetch                            | TypeScript only. A custom transport for describe calls.                                                                                     |

### Auth

| `type`              | Credentials                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sfCli`             | An org you're logged into with the Salesforce CLI (`sf org login web`); optional `targetOrg` alias. No secrets needed. |
| `clientCredentials` | `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`                                                                     |
| `accessToken`       | `SF_ACCESS_TOKEN`, `SF_INSTANCE_URL`                                                                                   |
| `jwtBearer`         | `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY` or `SF_PRIVATE_KEY_PATH`                               |

Rename any variable, e.g. `{ type: "clientCredentials", clientIdEnv: "MY_APP_CLIENT_ID" }`. Keep secrets out of the config file; `--env-file .env` loads a dotenv file first.

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

`--check` still calls the describe API, so CI needs credentials, e.g. client credentials from secrets.

The file is written atomically (to a temp file, then renamed), and the output is deterministic: sObjects and fields are sorted and `Id` comes first. That keeps diffs readable. Commit the generated file and re-run the generator when the org's schema changes.

## Programmatic use

```ts
import { checkGenerated, generate, generateSource } from "@cerios/salesforce-sobjectly/codegen";

await generate(config, { cwd: process.cwd(), logger: console });
const { source } = await generate(config, { write: false }); // don't write, just return the source
const check = await checkGenerated(config); // { upToDate, reason, added, removed, changed }
const source = generateSource(describes, { picklists: "string" }); // pure: describes in, source out
```

## Type mapping

| Salesforce type                                                                               | TypeScript                      |
| --------------------------------------------------------------------------------------------- | ------------------------------- |
| `boolean`                                                                                     | `boolean`                       |
| `int`, `long`, `double`, `currency`, `percent`                                                | `number`                        |
| `date`                                                                                        | `string` (`yyyy-MM-dd`)         |
| `datetime`                                                                                    | `string` (ISO 8601)             |
| `time`                                                                                        | `string` (`HH:mm:ss.SSSZ`)      |
| `id`, `reference`, `string`, `textarea`, `email`, `phone`, `url`, `encryptedstring`, `base64` | `string`                        |
| `picklist`, `combobox`                                                                        | union or `string` (below)       |
| `multipicklist`                                                                               | `string` (values joined by `;`) |
| `address`                                                                                     | `SalesforceAddress`             |
| `location`                                                                                    | `SalesforceGeolocation`         |
| anything else (`anyType`, `complexvalue`, new types)                                          | `unknown`                       |

Dates and date-times stay strings because that is what the REST API returns. Convert them with `new Date(value)` where needed.

### Picklists

With `picklists: "union"` (the default):

- **Restricted picklists** become a strict union of their active values: `"New" | "Working" | "Closed"`. An invalid value is a compile error.
- **Unrestricted picklists** and comboboxes become `"A" | "B" | (string & {})`. You get autocomplete, and any other string is still accepted.

Values can differ per record type; the union covers all of them. Use `picklists: "string"` to turn this off.

## Relationships

- **`parents`** includes lookups with a relationship name and a single target (e.g. `Contact.Account`) whose target sObject is also generated.
- **`polymorphicParents`** lists lookups with several targets, e.g. `Owner` on Case (`"Group" | "User"`) or `What` on Task. Query them with `selectPolymorphic` or `selectTypeOf` (see the SOQL guide).
- **`children`** includes child relationships with a relationship name (e.g. `Account.Contacts`) whose child sObject is also generated.

## Caveats

- Required fields come from describe metadata. Validation rules, record types and triggers can require more at runtime.
- Field-level security applies: the generated types only contain fields the describing user can see.
