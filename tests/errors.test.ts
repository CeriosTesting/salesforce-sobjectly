import { describe, expect, it, vi } from "vitest";

import {
	hasErrorCode,
	isSalesforceError,
	runChunks,
	SalesforceAuthError,
	SalesforceError,
	SalesforcePartialFailureError,
	SalesforceSaveError,
} from "../src/errors";
import type { SaveError } from "../src/types/common";

const errorFor = (body: unknown, status = 400): SalesforceError =>
	new SalesforceError({ status, method: "GET", path: "/x", body, headers: {} });

const saveError = (statusCode: SaveError["statusCode"], message = "failed"): SaveError => ({
	statusCode,
	message,
	fields: [],
});

describe("runChunks", () => {
	it("runs every chunk in order and concatenates the results", async () => {
		const run = vi.fn<(chunk: number[]) => Promise<string[]>>((chunk) =>
			Promise.resolve(chunk.map((item) => `r${item}`)),
		);
		await expect(runChunks([[1, 2], [3], [4, 5]], run, "Saving")).resolves.toEqual(["r1", "r2", "r3", "r4", "r5"]);
		expect(run.mock.calls.map(([chunk]) => chunk)).toEqual([[1, 2], [3], [4, 5]]);
	});

	it("returns an empty array for no chunks", async () => {
		await expect(runChunks([], () => Promise.resolve(["never"]), "Saving")).resolves.toEqual([]);
	});

	it("rethrows the original error when the first chunk fails", async () => {
		const cause = new Error("first chunk failed");
		const error = await runChunks([[1], [2]], () => Promise.reject(cause), "Saving").catch((caught: unknown) => caught);
		expect(error).toBe(cause);
	});

	it("keeps the results of earlier chunks when a later chunk fails", async () => {
		const cause = errorFor([{ errorCode: "UNABLE_TO_LOCK_ROW", message: "locked" }]);
		const run = vi
			.fn<(chunk: string[]) => Promise<{ id: string }[]>>()
			.mockResolvedValueOnce([{ id: "001A" }, { id: "001B" }])
			.mockRejectedValueOnce(cause);
		const error = await runChunks([["a", "b"], ["c"], ["d"]], run, "Updating Account records").catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(SalesforcePartialFailureError);
		const partial = error as SalesforcePartialFailureError<{ id: string }>;
		expect(partial.name).toBe("SalesforcePartialFailureError");
		expect(partial.completedResults).toEqual([{ id: "001A" }, { id: "001B" }]);
		expect(partial.cause).toBe(cause);
		expect(partial.message).toBe(`Updating Account records (2 item(s) were already processed): ${cause.message}`);
		// The remaining chunks are not attempted.
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rethrows the original error when the earlier chunks produced no results", async () => {
		const cause = new Error("second failed");
		const run = vi.fn<(chunk: number) => Promise<number[]>>().mockResolvedValueOnce([]).mockRejectedValueOnce(cause);
		await expect(runChunks([1, 2], run, "Saving")).rejects.toBe(cause);
	});
});

describe("SalesforcePartialFailureError", () => {
	it("describes non-Error causes as strings", () => {
		const error = new SalesforcePartialFailureError("Publishing events", [1, 2, 3], "socket hang up");
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Publishing events (3 item(s) were already processed): socket hang up");
		expect(error.cause).toBe("socket hang up");
		expect(error.completedResults).toEqual([1, 2, 3]);
	});
});

describe("SalesforceError body parsing", () => {
	it("reads the standard error array", () => {
		const error = errorFor([
			{ errorCode: "INVALID_FIELD", message: "No such column 'Foo'" },
			{ errorCode: "MALFORMED_QUERY", message: "second" },
		]);
		expect(error.errorCode).toBe("INVALID_FIELD");
		expect(error.errors).toHaveLength(2);
		expect(error.message).toBe("Salesforce GET /x failed with status 400 - INVALID_FIELD: No such column 'Foo'");
	});

	it("accepts a single error object instead of an array", () => {
		const error = errorFor({ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }, 404);
		expect(error.errorCode).toBe("NOT_FOUND");
		expect(error.errors).toEqual([{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]);
		expect(error.message).toContain("NOT_FOUND: The requested resource does not exist");
	});

	it("ignores objects that are not errors and describes the body instead", () => {
		const error = errorFor({ error: "something", detail: 1 }, 500);
		expect(error.errorCode).toBeUndefined();
		expect(error.errors).toEqual([]);
		expect(error.message).toBe('Salesforce GET /x failed with status 500 - {"error":"something","detail":1}');
	});

	it("skips array items that are not errors", () => {
		const error = errorFor([null, "text", { message: "no code" }, { errorCode: "DUPLICATE_VALUE", message: "dup" }]);
		expect(error.errors).toEqual([{ errorCode: "DUPLICATE_VALUE", message: "dup" }]);
		expect(error.errorCode).toBe("DUPLICATE_VALUE");
	});

	it("describes text, binary and empty bodies", () => {
		expect(errorFor("Service Unavailable", 503).message).toBe(
			"Salesforce GET /x failed with status 503 - Service Unavailable",
		);
		expect(errorFor(new Uint8Array(12), 502).message).toBe("Salesforce GET /x failed with status 502 - 12 bytes");
		expect(errorFor(undefined, 500).message).toBe("Salesforce GET /x failed with status 500");
		expect(errorFor(null, 500).errors).toEqual([]);
	});

	it("reads the API usage header", () => {
		const error = new SalesforceError({
			status: 403,
			method: "POST",
			path: "/x",
			body: [{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "limit" }],
			headers: { "sforce-limit-info": "api-usage=15000/15000" },
		});
		expect(error.limitInfo).toBe("api-usage=15000/15000");
	});
});

describe("isSalesforceError", () => {
	const error = errorFor([
		{ errorCode: "INVALID_FIELD", message: "first" },
		{ errorCode: "MALFORMED_QUERY", message: "second" },
	]);

	it("narrows SalesforceError instances", () => {
		expect(isSalesforceError(error)).toBe(true);
		expect(isSalesforceError(new Error("x"))).toBe(false);
		expect(isSalesforceError({ status: 400, errors: [] })).toBe(false);
		expect(isSalesforceError(undefined)).toBe(false);
	});

	it("matches any of the error codes when a code is given", () => {
		expect(isSalesforceError(error, "INVALID_FIELD")).toBe(true);
		expect(isSalesforceError(error, "MALFORMED_QUERY")).toBe(true);
		expect(isSalesforceError(error, "NOT_FOUND")).toBe(false);
	});

	it("is false for save errors and auth errors", () => {
		const save = new SalesforceSaveError("Create failed", [], [saveError("DUPLICATE_VALUE")]);
		expect(isSalesforceError(save)).toBe(false);
		expect(isSalesforceError(save, "DUPLICATE_VALUE")).toBe(false);
		expect(isSalesforceError(new SalesforceAuthError("nope"))).toBe(false);
	});
});

describe("hasErrorCode", () => {
	it("checks every error of a SalesforceError", () => {
		const error = errorFor([
			{ errorCode: "INVALID_FIELD", message: "first" },
			{ errorCode: "UNABLE_TO_LOCK_ROW", message: "second" },
		]);
		expect(hasErrorCode(error, "UNABLE_TO_LOCK_ROW")).toBe(true);
		expect(hasErrorCode(error, "INVALID_FIELD")).toBe(true);
		expect(hasErrorCode(error, "NOT_FOUND")).toBe(false);
	});

	it("checks the status codes of a SalesforceSaveError", () => {
		const error = new SalesforceSaveError(
			"Update failed",
			[{ success: false }],
			[saveError("REQUIRED_FIELD_MISSING"), saveError("UNABLE_TO_LOCK_ROW")],
		);
		expect(error.message).toBe("Update failed - REQUIRED_FIELD_MISSING: failed");
		expect(hasErrorCode(error, "UNABLE_TO_LOCK_ROW")).toBe(true);
		expect(hasErrorCode(error, "DUPLICATE_VALUE")).toBe(false);
	});

	it("is false for anything else", () => {
		expect(hasErrorCode(new Error("UNABLE_TO_LOCK_ROW"), "UNABLE_TO_LOCK_ROW")).toBe(false);
		expect(hasErrorCode({ errorCode: "UNABLE_TO_LOCK_ROW" }, "UNABLE_TO_LOCK_ROW")).toBe(false);
		expect(hasErrorCode(undefined, "UNABLE_TO_LOCK_ROW")).toBe(false);
		const partial = new SalesforcePartialFailureError(
			"Saving",
			[1],
			errorFor([{ errorCode: "UNABLE_TO_LOCK_ROW", message: "x" }]),
		);
		expect(hasErrorCode(partial, "UNABLE_TO_LOCK_ROW")).toBe(false);
	});
});
