import { describe, expect, it } from "vitest";

import { SalesforceError, SalesforceSaveError } from "../../src/errors";
import { ApexExecutionError } from "../../src/resources/tooling";
import { API, createClient, FakeTransport } from "../helpers/fake-transport";

describe("actions", () => {
	it("invokes a flow with inputs and returns typed outputs", async () => {
		const transport = new FakeTransport().reply({
			body: [{ actionName: "Start_Onboarding", isSuccess: true, errors: null, outputValues: { caseId: "500" } }],
		});
		const [result] = await createClient(transport).actions.invokeFlow<{ accountId: string }, { caseId: string }>(
			"Start_Onboarding",
			[{ accountId: "001" }],
		);
		expect(transport.last.path).toBe(`${API}/actions/custom/flow/Start_Onboarding`);
		expect(transport.last.json).toEqual({ inputs: [{ accountId: "001" }] });
		expect(result?.outputValues?.caseId).toBe("500");
	});

	it("throws SalesforceSaveError when an input fails", async () => {
		const failure = {
			body: [
				{
					actionName: "x",
					isSuccess: false,
					outputValues: null,
					errors: [{ statusCode: "UNKNOWN_EXCEPTION", message: "boom", fields: [] }],
				},
			],
		};
		const transport = new FakeTransport().reply(failure, failure);
		const actions = createClient(transport).actions;
		await expect(actions.invokeApex("MyInvocable", [{}])).rejects.toBeInstanceOf(SalesforceSaveError);
		expect(transport.last.path).toBe(`${API}/actions/custom/apex/MyInvocable`);
		expect(await actions.invokeStandard("emailSimple", [{}], { throwOnError: false })).toHaveLength(1);
		await expect(actions.invokeFlow("x", [])).rejects.toThrow(/at least one input/);
	});

	it("lists and describes actions", async () => {
		const transport = new FakeTransport(() => ({ body: { actions: [{ name: "a", label: "A", type: "FLOW" }] } }));
		const actions = createClient(transport).actions;
		expect(await actions.listStandard()).toHaveLength(1);
		expect(transport.last.path).toBe(`${API}/actions/standard`);
		await actions.listCustom("flow");
		expect(transport.last.path).toBe(`${API}/actions/custom/flow`);
		await actions.describeCustom("flow", "My_Flow");
		expect(transport.last.path).toBe(`${API}/actions/custom/flow/My_Flow`);
		await actions.describeStandard("chatterPost");
		expect(transport.last.path).toBe(`${API}/actions/standard/chatterPost`);
	});
});

describe("tooling", () => {
	it("queries the Tooling API", async () => {
		const transport = new FakeTransport().reply({ body: { totalSize: 1, done: true, records: [{ Name: "Foo" }] } });
		const result = await createClient(transport).tooling.query<{ Name: string }>("SELECT Name FROM ApexClass");
		expect(transport.last.path).toBe(`${API}/tooling/query`);
		expect(result.records[0]?.Name).toBe("Foo");
	});

	it("executes anonymous Apex and throws on failure", async () => {
		const success = {
			line: -1,
			column: -1,
			compiled: true,
			success: true,
			compileProblem: null,
			exceptionMessage: null,
			exceptionStackTrace: null,
		};
		const failure = {
			...success,
			compiled: false,
			success: false,
			line: 1,
			column: 5,
			compileProblem: "Unexpected token",
		};
		const transport = new FakeTransport().reply({ body: success }, { body: failure }, { body: failure });
		const tooling = createClient(transport).tooling;
		expect((await tooling.executeAnonymous("System.debug(1);")).success).toBe(true);
		expect(transport.last.path).toBe(`${API}/tooling/executeAnonymous/`);
		expect(transport.last.url.searchParams.get("anonymousBody")).toBe("System.debug(1);");
		await expect(tooling.executeAnonymous("bad")).rejects.toBeInstanceOf(ApexExecutionError);
		expect((await tooling.executeAnonymous("bad", { throwOnError: false })).compiled).toBe(false);
	});

	it("uses tooling sObjects, tests and raw requests", async () => {
		const transport = new FakeTransport(() => ({ status: 201, body: { id: "7tf", success: true, errors: [] } }));
		const tooling = createClient(transport).tooling;
		await tooling.sobject("TraceFlag").create({ LogType: "USER_DEBUG" });
		expect(transport.last.path).toBe(`${API}/tooling/sobjects/TraceFlag`);
		await tooling.runTestsAsynchronous({ classids: "01p" });
		expect(transport.last.path).toBe(`${API}/tooling/runTestsAsynchronous/`);
		await tooling.request({ path: "completions", query: { type: "apex" } });
		expect(transport.last.path).toBe(`${API}/tooling/completions`);
		await tooling.describeGlobal();
		expect(transport.last.path).toBe(`${API}/tooling/sobjects`);
	});
});

describe("actions 400 recovery", () => {
	const faulted = {
		actionName: "Start_Onboarding",
		isSuccess: false,
		outputValues: null,
		errors: [{ statusCode: "UNKNOWN_EXCEPTION", message: "An unhandled fault has occurred in this flow", fields: [] }],
	};
	const succeeded = { actionName: "Start_Onboarding", isSuccess: true, outputValues: { caseId: "500" }, errors: null };

	it("returns per-input results from a 400 when throwOnError is false", async () => {
		const transport = new FakeTransport().reply({ status: 400, body: [succeeded, faulted] });
		const results = await createClient(transport).actions.invokeFlow("Start_Onboarding", [{ a: 1 }, { a: 2 }], {
			throwOnError: false,
		});
		expect(results).toEqual([succeeded, faulted]);
	});

	it("throws SalesforceSaveError (not SalesforceError) for a 400 with action results", async () => {
		const transport = new FakeTransport().reply({ status: 400, body: [succeeded, faulted] });
		const error = await createClient(transport)
			.actions.invokeFlow("Start_Onboarding", [{ a: 1 }, { a: 2 }])
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect(error).not.toBeInstanceOf(SalesforceError);
		const saveError = error as SalesforceSaveError;
		expect(saveError.results).toEqual([succeeded, faulted]);
		expect(saveError.errors).toEqual(faulted.errors);
		expect(saveError.message).toBe(
			'Action "Start_Onboarding" failed for 1 of 2 input(s) - UNKNOWN_EXCEPTION: An unhandled fault has occurred in this flow',
		);
	});

	it("rethrows 400s that aren't action results", async () => {
		const transport = new FakeTransport().reply(
			{ status: 400, body: [{ errorCode: "INVALID_TYPE", message: "Cannot find action" }] },
			{ status: 400, body: [] },
			{ status: 400, body: [faulted, { errorCode: "X", message: "mixed" }] },
			{ status: 400, body: { isSuccess: false } },
			{ status: 500, body: [{ errorCode: "UNKNOWN_EXCEPTION", message: "boom" }] },
		);
		const actions = createClient(transport).actions;
		const options = { throwOnError: false };
		await expect(actions.invokeStandard("nope", [{}], options)).rejects.toMatchObject({
			name: "SalesforceError",
			errorCode: "INVALID_TYPE",
		});
		await expect(actions.invokeStandard("nope", [{}], options)).rejects.toBeInstanceOf(SalesforceError);
		await expect(actions.invokeStandard("nope", [{}], options)).rejects.toBeInstanceOf(SalesforceError);
		await expect(actions.invokeStandard("nope", [{}], options)).rejects.toBeInstanceOf(SalesforceError);
		await expect(actions.invokeApex("Boom", [{}], options)).rejects.toMatchObject({
			name: "SalesforceError",
			status: 500,
		});
		expect(transport.requests).toHaveLength(5);
	});
});

describe("executeAnonymous length", () => {
	it("rejects Apex too long for the URL before sending anything", async () => {
		const transport = new FakeTransport(() => ({ body: {} }));
		const apex = `System.debug('${"x".repeat(13_000)}');`;
		await expect(createClient(transport).tooling.executeAnonymous(apex)).rejects.toThrow(/too long/);
		expect(transport.requests).toHaveLength(0);
	});
});
