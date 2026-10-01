import { describe, expect, it } from "vitest";

import {
	formatNumber,
	isSoqlLiteral,
	soqlDate,
	soqlEscape,
	soqlEscapeDateOnly,
	soqlLike,
	soqlLiteral,
} from "../../src/soql/escape";
import { soqlFor } from "../../src/soql/query-builder";
import type { SObjectRegistry } from "../fixtures/generated-sobjects";

const soql = soqlFor<SObjectRegistry>();

describe("soqlLike", () => {
	it("adds wildcards per mode", () => {
		expect(soqlEscape(soqlLike("Acme"))).toBe("'%Acme%'");
		expect(soqlEscape(soqlLike("Acme", "contains"))).toBe("'%Acme%'");
		expect(soqlEscape(soqlLike("Acme", "startsWith"))).toBe("'Acme%'");
		expect(soqlEscape(soqlLike("Acme", "endsWith"))).toBe("'%Acme'");
		expect(soqlEscape(soqlLike("Acme", "exact"))).toBe("'Acme'");
	});

	it("escapes % and _ so they match literally", () => {
		expect(soqlEscape(soqlLike("50%_off", "startsWith"))).toBe("'50\\%\\_off%'");
		expect(soqlEscape(soqlLike("%", "exact"))).toBe("'\\%'");
		expect(soqlEscape(soqlLike("__", "endsWith"))).toBe("'%\\_\\_'");
	});

	it("escapes quotes and backslashes", () => {
		expect(soqlEscape(soqlLike("O'Brien", "exact"))).toBe("'O\\'Brien'");
		expect(soqlEscape(soqlLike('say "hi"', "exact"))).toBe("'say \\\"hi\\\"'");
		expect(soqlEscape(soqlLike("a\\b", "exact"))).toBe("'a\\\\b'");
		// A backslash before a wildcard stays a literal backslash, and the wildcard stays literal too.
		expect(soqlEscape(soqlLike("a\\%", "exact"))).toBe("'a\\\\\\%'");
		expect(soqlEscape(soqlLike("' OR Name LIKE '%", "contains"))).toBe("'%\\' OR Name LIKE \\'\\%%'");
	});

	it("rejects control characters", () => {
		expect(() => soqlLike("a\u0001b")).toThrow(/U\+0001/);
	});

	it("is a literal the query builder inserts verbatim", () => {
		const like = soqlLike("50%", "startsWith");
		expect(isSoqlLiteral(like)).toBe(true);
		expect(soql("Account").select("Id").where("Name", "LIKE", like).build()).toBe(
			"SELECT Id FROM Account WHERE Name LIKE '50\\%%'",
		);
	});
});

describe("literal branding", () => {
	it("only treats values created by soqlLiteral as raw SOQL", () => {
		const literal = soqlLiteral("LAST_N_DAYS:30");
		expect(isSoqlLiteral(literal)).toBe(true);
		expect(isSoqlLiteral({ sql: "LAST_N_DAYS:30" })).toBe(false);
		expect(isSoqlLiteral({ ...literal })).toBe(false);
		expect(isSoqlLiteral(null)).toBe(false);
		expect(isSoqlLiteral("TODAY")).toBe(false);
		expect(soqlEscape(literal)).toBe("LAST_N_DAYS:30");
	});

	it("rejects plain objects shaped like a literal", () => {
		const forged = { sql: "'' OR Id != null" } as never;
		expect(() => soqlEscape(forged)).toThrow(TypeError);
		expect(() => soqlEscape(forged)).toThrow(/soqlLiteral\(\)/);
		expect(() => soql("Account").select("Id").where("Name", "=", forged)).toThrow(TypeError);
		expect(() => soql("Account").select("Id").whereIn("Name", [forged])).toThrow(TypeError);
		expect(() => soqlEscape(["a"] as never)).toThrow(TypeError);
	});

	it("freezes literals and rejects blank fragments", () => {
		const literal = soqlLiteral("TODAY");
		expect(Object.isFrozen(literal)).toBe(true);
		expect(() => soqlLiteral("  ")).toThrow(/non-blank/);
		expect(() => soqlLiteral(42 as never)).toThrow(/non-blank/);
	});

	it("rejects unsupported value types", () => {
		expect(() => soqlEscape(undefined as never)).toThrow(TypeError);
		expect(() => soqlEscape(10n as never)).toThrow(/bigint/);
	});
});

describe("formatNumber", () => {
	it("never uses exponent notation", () => {
		expect(formatNumber(1e21)).toBe("1000000000000000000000");
		expect(formatNumber(1.2345e25)).toBe("12345000000000000000000000");
		expect(formatNumber(1e-7)).toBe("0.0000001");
		expect(formatNumber(-1e-7)).toBe("-0.0000001");
		expect(formatNumber(1.5e-10)).toBe("0.00000000015");
		expect(soqlEscape(1e21)).toBe("1000000000000000000000");
		expect(soqlEscape(1e-7)).toBe("0.0000001");
	});

	it("keeps ordinary numbers and normalises negative zero", () => {
		expect(formatNumber(42)).toBe("42");
		expect(formatNumber(-3.25)).toBe("-3.25");
		expect(formatNumber(123456789012345680000)).toBe("123456789012345680000");
		expect(formatNumber(-0)).toBe("0");
		expect(formatNumber(-1e-21)).toBe("-0.000000000000000000001");
		expect(formatNumber(1.5e-30)).toBe("0.0000000000000000000000000000015");
		expect(formatNumber(Number.MIN_VALUE)).toBe(`0.${"0".repeat(323)}5`);
		expect(formatNumber(Number.MAX_VALUE)).toBe(`17976931348623157${"0".repeat(292)}`);
	});

	it("rejects NaN and Infinity", () => {
		expect(() => formatNumber(Number.NaN)).toThrow(/Cannot use NaN/);
		expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(/Cannot use Infinity/);
		expect(() => formatNumber(Number.NEGATIVE_INFINITY)).toThrow(/Cannot use -Infinity/);
		expect(() => soql("Case").select("Id").where("Score__c", ">", Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
	});
});

describe("DateTime and Date values", () => {
	it("formats DateTimes in UTC without milliseconds", () => {
		expect(soqlEscape(new Date("2026-03-04T05:06:07.999Z"))).toBe("2026-03-04T05:06:07Z");
		expect(soqlEscape(new Date("2026-03-04T05:06:07.000Z"))).toBe("2026-03-04T05:06:07Z");
		expect(soqlEscape(new Date("2026-03-04T05:06:07.123+02:00"))).toBe("2026-03-04T03:06:07Z");
	});

	it("accepts the boundary years and rejects years outside 1700-4000", () => {
		expect(soqlEscape(new Date("1700-01-01T00:00:00.000Z"))).toBe("1700-01-01T00:00:00Z");
		expect(soqlEscape(new Date("4000-12-31T23:59:59.999Z"))).toBe("4000-12-31T23:59:59Z");
		expect(() => soqlEscape(new Date("1699-12-31T23:59:59.000Z"))).toThrow(/1700 to 4000/);
		expect(() => soqlEscape(new Date("4001-01-01T00:00:00.000Z"))).toThrow(/1700 to 4000/);
		expect(() => soqlEscape(new Date(Date.UTC(10_000, 0, 1)))).toThrow(/1700 to 4000/);
		expect(() => soqlEscape(new Date(Number.NaN))).toThrow(/Invalid Date/);
	});

	it("rejects out-of-range and invalid date-only values", () => {
		expect(() => soqlEscapeDateOnly(new Date("1600-01-01T00:00:00.000Z"))).toThrow(/1700 to 4000/);
		expect(() => soqlDate(new Date("5000-01-01T00:00:00.000Z"))).toThrow(/1700 to 4000/);
		expect(() => soqlDate(new Date(Number.NaN))).toThrow(/Invalid Date/);
		expect(() => soqlDate(new Date(1600, 5, 1), { local: true })).toThrow(/1700 to 4000/);
		expect(() => soqlDate(new Date(Number.NaN), { local: true })).toThrow(/Invalid Date/);
	});

	it("uses the UTC date by default and the local date with { local: true }", () => {
		expect(soqlEscape(soqlDate(new Date(Date.UTC(2026, 0, 31, 23, 30))))).toBe("2026-01-31");
		expect(soqlEscape(soqlDate(new Date(2026, 0, 31), { local: true }))).toBe("2026-01-31");
		expect(soqlEscape(soqlDate(new Date(2026, 0, 31, 23, 59, 59), { local: true }))).toBe("2026-01-31");
		expect(soqlEscape(soqlDate(new Date(2026, 8, 5), { local: true }))).toBe("2026-09-05");
		expect(soqlEscapeDateOnly(new Date(2026, 11, 1, 0, 0, 1), { local: true })).toBe("2026-12-01");
		const local = new Date(2026, 0, 31, 12);
		expect(soqlEscape(soqlDate(local, { local: false }))).toBe(local.toISOString().slice(0, 10));
	});

	it("validates date strings", () => {
		expect(isSoqlLiteral(soqlDate("2026-01-31"))).toBe(true);
		expect(() => soqlDate("2026-1-31")).toThrow(/yyyy-MM-dd/);
		expect(() => soqlDate("2026-01-31' OR Id != null")).toThrow(/yyyy-MM-dd/);
	});
});
