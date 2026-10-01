/**
 * The Salesforce CLI login (`sfCli`). Runs when `SF_TARGET_ORG` names an org you are logged into
 * with `sf`, e.g. `SF_TARGET_ORG=my-dev npm run test:integration`.
 */
import { describe, expect, it } from "vitest";

import { sfCli } from "../../src/auth/sf-cli";
import { SalesforceClient } from "../../src/client";

import { liveApiVersion, liveClient, liveOrgConfigured } from "./org";

const targetOrg = process.env.SF_TARGET_ORG?.trim();

describe.skipIf(!targetOrg || !liveOrgConfigured)("live org: sf CLI login", () => {
	it("authenticates through the sf CLI and reaches the same org", async () => {
		const sf = new SalesforceClient({ auth: sfCli({ targetOrg }), apiVersion: liveApiVersion() });
		const [viaCli] = await sf.collect<{ Id: string }>("SELECT Id FROM Organization");
		const [viaEnv] = await liveClient().collect<{ Id: string }>("SELECT Id FROM Organization");
		expect(viaCli?.Id).toBe(viaEnv?.Id);
		expect(await sf.instanceUrl()).toMatch(/^https:\/\//);
	});
});
