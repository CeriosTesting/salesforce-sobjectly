/**
 * Org fixtures some integration tests need, created once and reused by later runs:
 *
 * - platform event `Sobjectly_Test__e` with a `Message__c` text field;
 * - Apex REST resource `SobjectlyEcho` (`/sobjectly/echo/*`) and invocable Apex `SobjectlyDouble`;
 * - summary report `Sobjectly_Test_Accounts` on Accounts, grouped by Type.
 *
 * They are only created in Developer Edition orgs, scratch orgs and sandboxes, unless
 * `SF_IT_SETUP=1` is set. Elsewhere the tests that need them are skipped.
 */
import { buildMultipart } from "../../src/http/multipart";
import type { SalesforceClient } from "../../src/index";

import { zip } from "./zip";

export const TEST_EVENT = "Sobjectly_Test__e";
export const TEST_REPORT = "Sobjectly_Test_Accounts";
export const TEST_APEX_REST = "SobjectlyEcho";
export const TEST_INVOCABLE = "SobjectlyDouble";

export interface OrgFixtures {
	/** `false` when this org may not be changed (e.g. production); fixtures then only exist if added by hand. */
	setupAllowed: boolean;
	platformEvent: boolean;
	/** The Apex REST resource and invocable Apex classes. */
	apex: boolean;
	reportId?: string;
}

const METADATA_NS = "http://soap.sforce.com/2006/04/metadata";

async function setupAllowed(sf: SalesforceClient): Promise<boolean> {
	if (process.env.SF_IT_SETUP === "1") {
		return true;
	}
	const [org] = await sf.collect<{ OrganizationType: string; IsSandbox: boolean }>(
		"SELECT OrganizationType, IsSandbox FROM Organization",
	);
	return Boolean(org && (org.IsSandbox || org.OrganizationType === "Developer Edition"));
}

/** Deploys metadata in package format through the REST Metadata API and waits for the result. */
async function deploy(sf: SalesforceClient, files: Record<string, string>): Promise<void> {
	const { body, contentType } = buildMultipart([
		{
			name: "json",
			contentType: "application/json",
			data: JSON.stringify({ deployOptions: { singlePackage: true, rollbackOnError: true } }),
		},
		{ name: "file", filename: "deploy.zip", contentType: "application/zip", data: zip(files) },
	]);
	const { id } = await sf.request<{ id: string }>({
		method: "POST",
		path: "/metadata/deployRequest",
		headers: { "Content-Type": contentType },
		body,
	});
	for (let attempt = 0; attempt < 90; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const { deployResult } = await sf.request<{
			deployResult: { done: boolean; status: string; details?: { componentFailures?: unknown } };
		}>({ path: `/metadata/deployRequest/${id}`, query: { includeDetails: true } });
		if (deployResult.done) {
			if (deployResult.status !== "Succeeded") {
				throw new Error(
					`Deploying test metadata failed (${deployResult.status}): ${JSON.stringify(deployResult.details?.componentFailures)}`,
				);
			}
			return;
		}
	}
	throw new Error(`Deploying test metadata did not finish in time (deploy ${id}).`);
}

const APEX_REST_SOURCE = `@RestResource(urlMapping='/sobjectly/echo/*')
global with sharing class ${TEST_APEX_REST} {
	@HttpGet
	global static void ping() {
		respond(new Map<String, Object>{ 'method' => 'GET', 'path' => RestContext.request.requestURI, 'params' => RestContext.request.params });
	}

	@HttpPost
	global static void echo() {
		RestRequest request = RestContext.request;
		Object body = request.requestBody == null || request.requestBody.size() == 0
			? null
			: JSON.deserializeUntyped(request.requestBody.toString());
		respond(new Map<String, Object>{ 'method' => 'POST', 'path' => request.requestURI, 'params' => request.params, 'body' => body });
	}

	private static void respond(Map<String, Object> payload) {
		RestContext.response.addHeader('Content-Type', 'application/json');
		RestContext.response.responseBody = Blob.valueOf(JSON.serialize(payload));
	}
}`;

const INVOCABLE_SOURCE = `global with sharing class ${TEST_INVOCABLE} {
	global class Request {
		@InvocableVariable(required=true)
		global Integer value;
	}

	global class Result {
		@InvocableVariable
		global Integer doubled;
	}

	@InvocableMethod(label='Sobjectly Double')
	global static List<Result> run(List<Request> requests) {
		List<Result> results = new List<Result>();
		for (Request request : requests) {
			if (request.value < 0) {
				throw new IllegalArgumentException('value must not be negative');
			}
			Result result = new Result();
			result.doubled = request.value * 2;
			results.add(result);
		}
		return results;
	}
}`;

function apexClass(version: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="${METADATA_NS}">
	<apiVersion>${version}</apiVersion>
	<status>Active</status>
</ApexClass>`;
}

async function deployMetadata(sf: SalesforceClient): Promise<void> {
	const version = sf.apiVersion.slice(1);
	await deploy(sf, {
		"package.xml": `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="${METADATA_NS}">
	<types><members>${TEST_EVENT}</members><name>CustomObject</name></types>
	<types><members>${TEST_APEX_REST}</members><members>${TEST_INVOCABLE}</members><name>ApexClass</name></types>
	<version>${version}</version>
</Package>`,
		[`classes/${TEST_APEX_REST}.cls`]: APEX_REST_SOURCE,
		[`classes/${TEST_APEX_REST}.cls-meta.xml`]: apexClass(version),
		[`classes/${TEST_INVOCABLE}.cls`]: INVOCABLE_SOURCE,
		[`classes/${TEST_INVOCABLE}.cls-meta.xml`]: apexClass(version),
		[`objects/${TEST_EVENT}.object`]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="${METADATA_NS}">
	<deploymentStatus>Deployed</deploymentStatus>
	<eventType>HighVolume</eventType>
	<label>Sobjectly Test</label>
	<pluralLabel>Sobjectly Tests</pluralLabel>
	<publishBehavior>PublishImmediately</publishBehavior>
	<fields>
		<fullName>Message__c</fullName>
		<label>Message</label>
		<length>255</length>
		<required>false</required>
		<type>Text</type>
	</fields>
</CustomObject>`,
	});
}

async function findReport(sf: SalesforceClient): Promise<string | undefined> {
	const [report] = await sf.collect<{ Id: string }>(`SELECT Id FROM Report WHERE DeveloperName = '${TEST_REPORT}'`);
	return report?.Id;
}

async function createReport(sf: SalesforceClient): Promise<string> {
	const created = await sf.request<{ reportMetadata: { id: string } }>({
		method: "POST",
		path: "/analytics/reports",
		body: {
			reportMetadata: {
				name: "Sobjectly Test Accounts",
				developerName: TEST_REPORT,
				reportFormat: "SUMMARY",
				reportType: { type: "AccountList" },
				detailColumns: ["ACCOUNT.NAME"],
				groupingsDown: [{ name: "TYPE", sortOrder: "Asc", dateGranularity: "None" }],
			},
		},
	});
	return created.reportMetadata.id;
}

/** Finds the fixtures, creating missing ones where allowed. */
export async function ensureFixtures(sf: SalesforceClient): Promise<OrgFixtures> {
	const allowed = await setupAllowed(sf);
	const sobjects = await sf.describeGlobal();
	let platformEvent = sobjects.sobjects.some((sobject) => sobject.name === TEST_EVENT);
	const classes = await sf.tooling.collect<{ Name: string }>(
		`SELECT Name FROM ApexClass WHERE Name IN ('${TEST_APEX_REST}', '${TEST_INVOCABLE}')`,
	);
	let apex = classes.length === 2;
	if ((!platformEvent || !apex) && allowed) {
		await deployMetadata(sf);
		sf.clearCache();
		platformEvent = true;
		apex = true;
	}
	let reportId = await findReport(sf);
	if (!reportId && allowed) {
		reportId = await createReport(sf);
	}
	return { setupAllowed: allowed, platformEvent, apex, reportId };
}
