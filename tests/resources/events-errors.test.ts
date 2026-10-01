import { describe, expect, it } from "vitest";

import {
	hasErrorCode,
	isSalesforceError,
	SalesforceError,
	SalesforcePartialFailureError,
	SalesforceSaveError,
} from "../../src/errors";
import type { PublishResult } from "../../src/resources/events";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";
import { API, createClient, FakeTransport } from "../helpers/fake-transport";

const enqueued = (uuid: string): Record<string, unknown> => ({
	id: "e00xx0000000001AAA",
	success: true,
	errors: [{ statusCode: "OPERATION_ENQUEUED", message: uuid, fields: [] }],
});

describe("events.publish", () => {
	it("publishes one event and treats OPERATION_ENQUEUED as success", async () => {
		const transport = new FakeTransport().reply({ status: 201, body: enqueued("uuid-1") });
		const [result] = await createClient<SObjectRegistry>(transport).events.publish("Order_Shipped__e", {
			Order_Number__c: "A-1",
		});
		expect(transport.last.path).toBe(`${API}/sobjects/Order_Shipped__e`);
		expect(result).toEqual({ success: true, uuid: "uuid-1", id: "e00xx0000000001AAA", errors: [] });
	});

	it("publishes many events through composite, 25 per call", async () => {
		const transport = new FakeTransport((request) => {
			const subrequests = (request.json as { compositeRequest: { referenceId: string }[] }).compositeRequest;
			return {
				body: {
					compositeResponse: subrequests.map((item) => ({
						referenceId: item.referenceId,
						httpStatusCode: 201,
						httpHeaders: {},
						body: enqueued(item.referenceId),
					})),
				},
			};
		});
		const events = Array.from({ length: 30 }, (_, index) => ({ Order_Number__c: `A-${index}` }));
		const results = await createClient<SObjectRegistry>(transport).events.publish("Order_Shipped__e", events);
		expect(transport.requests).toHaveLength(2);
		expect((transport.requests[0].json as { compositeRequest: unknown[] }).compositeRequest).toHaveLength(25);
		expect((transport.requests[0].json as { compositeRequest: { url: string }[] }).compositeRequest[0]?.url).toBe(
			`${API}/sobjects/Order_Shipped__e`,
		);
		expect(results).toHaveLength(30);
		expect(results.every((result) => result.success)).toBe(true);
	});

	it("throws SalesforceSaveError when an event is rejected, unless throwOnError is false", async () => {
		const response = {
			body: {
				compositeResponse: [
					{ referenceId: "event0", httpStatusCode: 201, httpHeaders: {}, body: enqueued("u0") },
					{
						referenceId: "event1",
						httpStatusCode: 400,
						httpHeaders: {},
						body: [{ errorCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing", fields: ["X"] }],
					},
				],
			},
		};
		const transport = new FakeTransport().reply(response, response);
		const events = createClient<SObjectRegistry>(transport).events;
		const payload = [{ Order_Number__c: "A" }, { Order_Number__c: "B" }];
		const error = await events.publish("Order_Shipped__e", payload).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect(hasErrorCode(error, "REQUIRED_FIELD_MISSING")).toBe(true);
		const results = await events.publish("Order_Shipped__e", payload, { throwOnError: false });
		expect(results[1]).toEqual({
			success: false,
			uuid: undefined,
			id: undefined,
			errors: [{ statusCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing", fields: ["X"] }],
		});
	});

	it("rejects names that are not platform events", async () => {
		await expect(createClient(new FakeTransport()).events.publish("Account" as never, {})).rejects.toThrow(/__e/);
	});
});

describe("error code guards", () => {
	const restError = new SalesforceError({
		status: 400,
		method: "PATCH",
		path: "/sobjects/Account/001",
		body: [{ errorCode: "UNABLE_TO_LOCK_ROW", message: "unable to obtain exclusive access" }],
		headers: {},
	});

	it("checks SalesforceError codes", () => {
		expect(isSalesforceError(restError)).toBe(true);
		expect(isSalesforceError(restError, "UNABLE_TO_LOCK_ROW")).toBe(true);
		expect(isSalesforceError(restError, "MALFORMED_QUERY")).toBe(false);
		expect(isSalesforceError(new Error("x"))).toBe(false);
		expect(hasErrorCode(restError, "UNABLE_TO_LOCK_ROW")).toBe(true);
	});

	it("checks SalesforceSaveError status codes", () => {
		const saveError = new SalesforceSaveError(
			"failed",
			[],
			[{ statusCode: "DUPLICATES_DETECTED", message: "dup", fields: [] }],
		);
		expect(hasErrorCode(saveError, "DUPLICATES_DETECTED")).toBe(true);
		expect(hasErrorCode(saveError, "UNABLE_TO_LOCK_ROW")).toBe(false);
		expect(hasErrorCode("nope", "UNABLE_TO_LOCK_ROW")).toBe(false);
	});
});

describe("events.publish partial failures", () => {
	const composite = (request: { json: unknown }): { body: unknown } => ({
		body: {
			compositeResponse: (request.json as { compositeRequest: { referenceId: string }[] }).compositeRequest.map(
				(item) => ({
					referenceId: item.referenceId,
					httpStatusCode: 201,
					httpHeaders: {},
					body: enqueued(item.referenceId),
				}),
			),
		},
	});
	const events = Array.from({ length: 30 }, (_, index) => ({ Order_Number__c: `A-${index}` }));
	const serverError = { status: 500, body: [{ errorCode: "UNKNOWN_EXCEPTION", message: "server down" }] };

	it("throws SalesforcePartialFailureError with the results of earlier batches", async () => {
		let calls = 0;
		const transport = new FakeTransport((request) => (++calls === 1 ? composite(request) : serverError));
		const error = await createClient<SObjectRegistry>(transport)
			.events.publish("Order_Shipped__e", events)
			.catch((caught: unknown) => caught);
		expect(transport.requests).toHaveLength(2);
		expect(error).toBeInstanceOf(SalesforcePartialFailureError);
		const partial = error as SalesforcePartialFailureError<PublishResult>;
		expect(partial.name).toBe("SalesforcePartialFailureError");
		expect(partial.completedResults).toHaveLength(25);
		expect(partial.completedResults.every((result) => result.success)).toBe(true);
		expect(partial.completedResults[0]?.uuid).toBe("event0");
		expect(partial.cause).toBeInstanceOf(SalesforceError);
		expect((partial.cause as SalesforceError).status).toBe(500);
		expect(partial.message).toMatch(/^Publishing Order_Shipped__e failed \(25 item\(s\) were already processed\): /);
		expect(partial.message).toContain("server down");
	});

	it("rethrows the original error when the first batch fails", async () => {
		const transport = new FakeTransport(() => serverError);
		const error = await createClient<SObjectRegistry>(transport)
			.events.publish("Order_Shipped__e", events)
			.catch((caught: unknown) => caught);
		expect(transport.requests).toHaveLength(1);
		expect(error).toBeInstanceOf(SalesforceError);
		expect(error).not.toBeInstanceOf(SalesforcePartialFailureError);
	});
});

describe("events.publish single event 400", () => {
	const rejected = {
		status: 400,
		body: [{ errorCode: "REQUIRED_FIELD_MISSING", message: "Required fields are missing: [Order_Number__c]" }],
	};

	it("maps a 400 with an error array to a failure result", async () => {
		const transport = new FakeTransport().reply(rejected);
		const results = await createClient<SObjectRegistry>(transport).events.publish(
			"Order_Shipped__e",
			{ Order_Number__c: "" },
			{ throwOnError: false },
		);
		expect(results).toEqual([
			{
				success: false,
				uuid: undefined,
				id: undefined,
				errors: [
					{
						statusCode: "REQUIRED_FIELD_MISSING",
						message: "Required fields are missing: [Order_Number__c]",
						fields: [],
					},
				],
			},
		]);
	});

	it("throws SalesforceSaveError for the 400 by default, like the batch path", async () => {
		const transport = new FakeTransport().reply(rejected);
		const error = await createClient<SObjectRegistry>(transport)
			.events.publish("Order_Shipped__e", { Order_Number__c: "" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SalesforceSaveError);
		expect((error as SalesforceSaveError).results).toHaveLength(1);
		expect(hasErrorCode(error, "REQUIRED_FIELD_MISSING")).toBe(true);
	});

	it("rethrows other failures", async () => {
		const transport = new FakeTransport().reply(
			{ status: 500, body: [{ errorCode: "UNKNOWN_EXCEPTION", message: "boom" }] },
			{ status: 400, body: { unexpected: true } },
			{ status: 403, body: [{ errorCode: "INSUFFICIENT_ACCESS", message: "no" }] },
		);
		const events = createClient<SObjectRegistry>(transport).events;
		const payload = { Order_Number__c: "A" };
		await expect(events.publish("Order_Shipped__e", payload, { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			status: 500,
		});
		await expect(events.publish("Order_Shipped__e", payload, { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			status: 400,
		});
		await expect(events.publish("Order_Shipped__e", payload, { throwOnError: false })).rejects.toMatchObject({
			name: "SalesforceError",
			errorCode: "INSUFFICIENT_ACCESS",
		});
	});
});
