import type { AuthProvider } from "../auth/types";
import type { HttpTransport } from "../http/transport";
import type { ApiVersion } from "../types/common";

/**
 * A credential value in the config: usually `process.env.ANY_NAME` (so `undefined` type-checks),
 * a `"${ANY_NAME}"` placeholder that is read from the environment (the way to do it in JSON), or
 * a literal. A key that is set but ends up empty is an error; a key that is left out falls back
 * to its default `SF_*` environment variable.
 */
export type ConfigValue = string | undefined;

/** OAuth 2.0 client credentials. Keys you leave out are read from the default variables shown. */
export interface ClientCredentialsAuth {
	type: "clientCredentials";
	/** Your My Domain URL. Defaults to the `SF_LOGIN_URL` variable. */
	loginUrl?: ConfigValue;
	/** Defaults to the `SF_CLIENT_ID` variable. */
	clientId?: ConfigValue;
	/** Defaults to the `SF_CLIENT_SECRET` variable. */
	clientSecret?: ConfigValue;
	/** @deprecated Use `loginUrl: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	loginUrlEnv?: string;
	/** @deprecated Use `clientId: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	clientIdEnv?: string;
	/** @deprecated Use `clientSecret: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	clientSecretEnv?: string;
}

/** A fixed access token, e.g. from `sf org display`. Keys you leave out are read from the default variables shown. */
export interface AccessTokenAuth {
	type: "accessToken";
	/** Defaults to the `SF_ACCESS_TOKEN` variable. */
	accessToken?: ConfigValue;
	/** Defaults to the `SF_INSTANCE_URL` variable. */
	instanceUrl?: ConfigValue;
	/** @deprecated Use `accessToken: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	accessTokenEnv?: string;
	/** @deprecated Use `instanceUrl: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	instanceUrlEnv?: string;
}

/** OAuth 2.0 JWT bearer flow. Keys you leave out are read from the default variables shown. */
export interface JwtBearerAuth {
	type: "jwtBearer";
	/** Defaults to the `SF_LOGIN_URL` variable. */
	loginUrl?: ConfigValue;
	/** Defaults to the `SF_CLIENT_ID` variable. */
	clientId?: ConfigValue;
	/** Defaults to the `SF_USERNAME` variable. */
	username?: ConfigValue;
	/** The PEM key itself. Defaults to the `SF_PRIVATE_KEY` variable. */
	privateKey?: ConfigValue;
	/** A path to the PEM key file, used when `privateKey` is empty. Defaults to the `SF_PRIVATE_KEY_PATH` variable. */
	privateKeyPath?: ConfigValue;
	/** @deprecated Use `loginUrl: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	loginUrlEnv?: string;
	/** @deprecated Use `clientId: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	clientIdEnv?: string;
	/** @deprecated Use `username: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	usernameEnv?: string;
	/** @deprecated Use `privateKey: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	privateKeyEnv?: string;
	/** @deprecated Use `privateKeyPath: process.env.NAME` (or `"${NAME}"` in JSON). Removed in 2.0. */
	privateKeyPathEnv?: string;
}

/** An org you are logged into with the Salesforce CLI (`sf org login web --alias my-org`). */
export interface SfCliAuth {
	type: "sfCli";
	/**
	 * The org alias or username, e.g. `process.env.NAME` or a `"${NAME}"` placeholder. Left out, the
	 * CLI's default org is used (the CLI's own `SF_TARGET_ORG` variable can set it). Set but empty is an error.
	 */
	targetOrg?: ConfigValue;
}

/** An auth setting that can be written as data. The only kind a JSON config can use. */
export type AuthSetting = ClientCredentialsAuth | AccessTokenAuth | JwtBearerAuth | SfCliAuth;

/** @deprecated Use `ClientCredentialsAuth`. */
export type EnvClientCredentialsAuth = ClientCredentialsAuth;
/** @deprecated Use `AccessTokenAuth`. */
export type EnvAccessTokenAuth = AccessTokenAuth;
/** @deprecated Use `JwtBearerAuth`. */
export type EnvJwtBearerAuth = JwtBearerAuth;
/** @deprecated Use `AuthSetting`. */
export type EnvAuth = AuthSetting;

/** An auth setting, or any auth provider (TypeScript configs only). */
export type CodegenAuth = AuthSetting | AuthProvider;

export type PicklistMode =
	/** Every picklist is `string`. */
	| "string"
	/** Restricted picklists become a union of their values; unrestricted ones `"A" | "B" | (string & {})`. */
	| "union"
	/**
	 * Like `"union"`, plus a named `as const` object and type per picklist: `CaseStatus.Working`,
	 * `Status: CaseStatus`. Plain strings such as `"Working"` are still accepted.
	 */
	| "const"
	/**
	 * A TypeScript `enum` per picklist: `CaseStatus.Working`, `Status: CaseStatus`. Enums are nominal,
	 * so restricted picklists only accept enum members, not plain strings. Not usable with
	 * `erasableSyntaxOnly` or Node's type stripping.
	 */
	| "enum";

/**
 * The codegen config. `S` is the union of the listed sObject names; `defineConfig` infers it, so
 * per-sObject options such as `excludeCreateFields` only accept listed names.
 */
export interface CodegenConfig<S extends string = string> {
	/** Output file, relative to the config file's directory, e.g. `"src/generated/sobjects.ts"`. */
	output: string;
	/**
	 * The API version to describe with, e.g. `"v66.0"`. Required. It is also written to the
	 * generated file as `API_VERSION`, so the client can use the same version.
	 */
	apiVersion: ApiVersion;
	/**
	 * sObjects to generate. Strongly recommended: without it every queryable sObject in the org
	 * is generated, which can be thousands of types.
	 */
	sobjects?: readonly S[];
	/** sObjects to skip (applied after `sobjects`). */
	exclude?: readonly string[];
	/**
	 * How to authenticate, e.g. `{ type: "clientCredentials", clientId: process.env.MY_CLIENT_ID, ... }`.
	 * Defaults to client credentials from `SF_LOGIN_URL`, `SF_CLIENT_ID` and `SF_CLIENT_SECRET`.
	 */
	auth?: CodegenAuth;
	/** Fields to leave out of the create input per sObject (e.g. fields describe marks createable but REST rejects). */
	excludeCreateFields?: Partial<Record<NoInfer<S>, readonly string[]>>;
	/** Fields to leave out of the update input per sObject. */
	excludeUpdateFields?: Partial<Record<NoInfer<S>, readonly string[]>>;
	/** How picklists are typed. Defaults to `"union"`. */
	picklists?: PicklistMode;
	/** Emit the `PICKLIST_VALUES` and `RECORD_TYPES` runtime constants. Defaults to `true`. */
	constants?: boolean;
	/** Parallel describe calls. Defaults to 10. */
	concurrency?: number;
	/** Skip sObjects whose describe fails instead of failing the run. Defaults to `false`. */
	continueOnDescribeError?: boolean;
	/** Where the generated file imports helper types from. Defaults to `"@cerios/salesforce-sobjectly"`. */
	importSource?: string;
	/** Post-processes the generated source, e.g. with your formatter. TypeScript configs only. */
	format?: (source: string, filePath: string) => string | Promise<string>;
	/** A custom transport for the describe calls (e.g. behind a proxy). TypeScript configs only. */
	transport?: HttpTransport;
}

/**
 * The shape of `sobjectly.config.json`: everything that can be written as JSON (no functions,
 * no auth providers). `$schema` points editors at the bundled JSON Schema.
 */
export type JsonCodegenConfig = Omit<CodegenConfig, "auth" | "format" | "transport"> & {
	$schema?: string;
	auth?: AuthSetting;
};

/**
 * Type-checks a `sobjectly.config.ts`. The listed `sobjects` become a literal union, so a typo in
 * a per-sObject option is a compile error:
 *
 * ```ts
 * export default defineConfig({
 * 	apiVersion: "v66.0",
 * 	output: "src/generated/sobjects.ts",
 * 	sobjects: ["Account", "Contact"],
 * 	excludeCreateFields: { Acount: ["Name"] }, // ❌ "Acount" is not in sobjects
 * });
 * ```
 */
export function defineConfig<const S extends string = string>(config: CodegenConfig<S>): CodegenConfig<S> {
	return config;
}
