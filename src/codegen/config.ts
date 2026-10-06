import type { AuthProvider } from "../auth/types";
import type { HttpTransport } from "../http/transport";
import type { ApiVersion } from "../types/common";

/** Client credentials read from environment variables (defaults shown). */
export interface EnvClientCredentialsAuth {
	type: "clientCredentials";
	/** Defaults to `SF_LOGIN_URL` (your My Domain URL). */
	loginUrlEnv?: string;
	/** Defaults to `SF_CLIENT_ID`. */
	clientIdEnv?: string;
	/** Defaults to `SF_CLIENT_SECRET`. */
	clientSecretEnv?: string;
}

/** An access token read from environment variables (defaults shown), e.g. from `sf org display`. */
export interface EnvAccessTokenAuth {
	type: "accessToken";
	/** Defaults to `SF_ACCESS_TOKEN`. */
	accessTokenEnv?: string;
	/** Defaults to `SF_INSTANCE_URL`. */
	instanceUrlEnv?: string;
}

/** JWT bearer flow with values read from environment variables (defaults shown). */
export interface EnvJwtBearerAuth {
	type: "jwtBearer";
	/** Defaults to `SF_LOGIN_URL`. */
	loginUrlEnv?: string;
	/** Defaults to `SF_CLIENT_ID`. */
	clientIdEnv?: string;
	/** Defaults to `SF_USERNAME`. */
	usernameEnv?: string;
	/** The PEM key itself. Defaults to `SF_PRIVATE_KEY`. */
	privateKeyEnv?: string;
	/** A path to the PEM key file, used when the key variable is empty. Defaults to `SF_PRIVATE_KEY_PATH`. */
	privateKeyPathEnv?: string;
}

/** An auth setting that reads credentials from environment variables. The only kind a JSON config can use. */
/** An org you are logged into with the Salesforce CLI (`sf org login web --alias my-org`). */
export interface SfCliAuth {
	type: "sfCli";
	/** The org alias or username. Defaults to the CLI's default org. */
	targetOrg?: string;
}

export type EnvAuth = EnvClientCredentialsAuth | EnvAccessTokenAuth | EnvJwtBearerAuth | SfCliAuth;

/** Env-based auth, or any auth provider (TypeScript configs only). */
export type CodegenAuth = EnvAuth | AuthProvider;

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
	/** How to authenticate. Defaults to client credentials from `SF_LOGIN_URL`, `SF_CLIENT_ID` and `SF_CLIENT_SECRET`. */
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
	auth?: EnvAuth;
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
