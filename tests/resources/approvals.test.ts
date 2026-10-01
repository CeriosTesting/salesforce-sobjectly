import { describe, expect, it } from "vitest";

import { hasErrorCode, SalesforceError, SalesforceSaveError } from "../../src/errors";
import { API, createClient, FakeTransport } from "../helpers/fake-transport";

const rejected = (errorCode: string, message: string, fields?: string[]): { status: number; body: unknown } => ({
	status: 400,
	body: [{ errorCode, message, ...(fields ? { fields } : {}) }],
});

describe("approvals error handling", () => {
	it("turns a 400 with an error array into an unsuccessful result", async () => {
		const transport = new FakeTransport().reply(
			rejected("ALREADY_IN_PROCESS", "Cannot submit object already in process."),
		);
		const result = await createClient(transport).approvals.submit("001A", { throwOnError: false });
		expect(transport.last.path).toBe(`${API}/process/approvals/`);
		expect(result).toEqual({
			actorIds: [],
			entityId: "001A",
			errors: [{ statusCode: "ALREADY_IN_PROCESS", message: "Cannot submit object already in process.", fields: [] }],
			instanceId: "",
			instanceStatus: "",
			newWorkitemIds: [],
			success: false,
		});
	});

	it("throws SalesforceSaveError for a 400 by default", async () => {
		const transport = new FakeTransport().reply(
			rejected("NO_APPLICABLE_PROCESS", "No applicable approval process was found.", ["Status"]),
		);
		const error = await createClient(transport)
			.approvals.submit("001A")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect(error).not.toBeInstanceOf(SalesforceError);
		expect(hasErrorCode(error, "NO_APPLICABLE_PROCESS")).toBe(true);
		expect((error as SalesforceSaveError).errors).toEqual([
			{ statusCode: "NO_APPLICABLE_PROCESS", message: "No applicable approval process was found.", fields: ["Status"] },
		]);
		expect((error as Error).message).toBe(
			"Approval Submit failed - NO_APPLICABLE_PROCESS: No applicable approval process was found.",
		);
	});

	it("uses the work item id as entityId for approve and reject failures", async () => {
		const transport = new FakeTransport().reply(
			rejected("INVALID_CROSS_REFERENCE_KEY", "invalid work item"),
			rejected("INVALID_CROSS_REFERENCE_KEY", "invalid work item"),
		);
		const approvals = createClient(transport).approvals;
		const approved = await approvals.approve("04iA", { throwOnError: false });
		expect(approved).toMatchObject({ success: false, entityId: "04iA" });
		expect(transport.requests).toHaveLength(1);
		await expect(approvals.reject("04iA")).rejects.toThrow(/Approval Reject failed - INVALID_CROSS_REFERENCE_KEY/);
	});

	it("rethrows other failures", async () => {
		const transport = new FakeTransport().reply(
			{ status: 500, body: [{ errorCode: "UNKNOWN_EXCEPTION", message: "boom" }] },
			{ status: 400, body: { message: "not an error array" } },
			{ status: 404, body: [{ errorCode: "NOT_FOUND", message: "missing" }] },
		);
		const approvals = createClient(transport).approvals;
		await expect(approvals.submit("001A", { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			status: 500,
		});
		await expect(approvals.submit("001A", { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			status: 400,
		});
		await expect(approvals.submit("001A", { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			errorCode: "NOT_FOUND",
		});
	});

	it("throws when Salesforce returns no result", async () => {
		const transport = new FakeTransport().reply({ body: [] });
		await expect(createClient(transport).approvals.submit("001A")).rejects.toThrow(
			"Approval Submit returned no result.",
		);
	});

	it("keeps newWorkitemIds when Salesforce already uses that spelling", async () => {
		const transport = new FakeTransport().reply({
			body: [
				{
					actorIds: [],
					entityId: "001A",
					errors: null,
					instanceId: "04g",
					instanceStatus: "Pending",
					newWorkitemIds: ["04iX"],
					success: true,
				},
			],
		});
		const result = await createClient(transport).approvals.submit("001A");
		expect(result.newWorkitemIds).toEqual(["04iX"]);
		expect(result).not.toHaveProperty("newWorkItemIds");
	});

	it("requires an id before sending anything", async () => {
		const transport = new FakeTransport();
		const approvals = createClient(transport).approvals;
		expect(() => approvals.submit(" ")).toThrow(/id is required/);
		await expect(approvals.approve("")).rejects.toThrow(/id is required/);
		expect(transport.requests).toHaveLength(0);
	});
});
