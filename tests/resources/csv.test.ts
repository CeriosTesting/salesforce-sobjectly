import { describe, expect, it } from "vitest";

import { CsvRowParser, parseCsv, parseCsvRows, parseCsvStream, toCsv } from "../../src/resources/csv";

const encoder = new TextEncoder();

async function* chunksOf(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array, void, undefined> {
	for (const part of parts) {
		// Deliver each chunk asynchronously, like a network stream.
		await Promise.resolve();
		yield typeof part === "string" ? encoder.encode(part) : part;
	}
}

async function collect(chunks: AsyncIterable<Uint8Array>, delimiter?: string): Promise<Record<string, string>[]> {
	const rows: Record<string, string>[] = [];
	for await (const row of parseCsvStream(chunks, delimiter)) {
		rows.push(row);
	}
	return rows;
}

describe("parseCsvRows", () => {
	it("tells blank lines apart from empty values", () => {
		expect(parseCsvRows("x\n\ny")).toEqual([["x"], [], ["y"]]);
		expect(parseCsvRows("\n")).toEqual([[]]);
		expect(parseCsvRows('""\n')).toEqual([[""]]);
		expect(parseCsvRows('""')).toEqual([[""]]);
		expect(parseCsvRows("a,\n")).toEqual([["a", ""]]);
		expect(parseCsvRows(",")).toEqual([["", ""]]);
	});

	it("keeps a quoted empty last field at EOF", () => {
		expect(parseCsvRows('a,""')).toEqual([["a", ""]]);
		expect(parseCsvRows('a,""\n')).toEqual([["a", ""]]);
		expect(parseCsvRows('a,b\n1,""')).toEqual([
			["a", "b"],
			["1", ""],
		]);
		expect(parseCsvRows("a,")).toEqual([["a", ""]]);
	});

	it("treats a lone CR as a line ending and CRLF as one", () => {
		expect(parseCsvRows("a\rb\r\nc")).toEqual([["a"], ["b"], ["c"]]);
		expect(parseCsvRows("a\r\n\r\nb")).toEqual([["a"], [], ["b"]]);
	});
});

describe("parseCsv blank lines", () => {
	it("keeps blank lines as empty (null) values in single-column files", () => {
		expect(parseCsv("Name\nA\n\nB\n")).toEqual([{ Name: "A" }, { Name: "" }, { Name: "B" }]);
		expect(parseCsv('Id\n""\n001\n')).toEqual([{ Id: "" }, { Id: "001" }]);
		expect(parseCsv("Id\r\n\r\n001\r\n")).toEqual([{ Id: "" }, { Id: "001" }]);
	});

	it("skips blank lines in multi-column files", () => {
		expect(parseCsv("A,B\n1,2\n\n3,4\n\n")).toEqual([
			{ A: "1", B: "2" },
			{ A: "3", B: "4" },
		]);
		expect(parseCsv("A,B\r\n\r\n1,2\r\n")).toEqual([{ A: "1", B: "2" }]);
	});

	it("fills missing trailing columns with empty strings", () => {
		expect(parseCsv('A,B,C\n1\n2,""\n')).toEqual([
			{ A: "1", B: "", C: "" },
			{ A: "2", B: "", C: "" },
		]);
	});

	it("returns no records for a blank header", () => {
		expect(parseCsv("\nA\n")).toEqual([]);
		expect(parseCsv("Name")).toEqual([]);
	});
});

describe("CsvRowParser", () => {
	it("handles CRLF split across chunks", () => {
		const parser = new CsvRowParser();
		expect(parser.push("a,b\r")).toEqual([["a", "b"]]);
		expect(parser.push("\n1,2\r")).toEqual([["1", "2"]]);
		expect(parser.push("\n")).toEqual([]);
		expect(parser.end()).toEqual([]);
	});

	it("still sees a blank line after a CRLF split across chunks", () => {
		const parser = new CsvRowParser();
		expect(parser.push("a\r")).toEqual([["a"]]);
		expect(parser.push("\n\r")).toEqual([[]]);
		expect(parser.push("\nb")).toEqual([]);
		expect(parser.end()).toEqual([["b"]]);
	});

	it("handles quotes and escaped quotes split across chunks", () => {
		const parser = new CsvRowParser();
		expect(parser.push('"x"')).toEqual([]);
		expect(parser.push('"y",')).toEqual([]);
		expect(parser.push('"ab"')).toEqual([]);
		expect(parser.push("\r")).toEqual([['x"y', "ab"]]);
		expect(parser.push("\n")).toEqual([]);
		expect(parser.end()).toEqual([]);
	});

	it("keeps a quoted empty field pending at the end", () => {
		const parser = new CsvRowParser(";");
		expect(parser.push('a;"')).toEqual([]);
		expect(parser.push('"')).toEqual([]);
		expect(parser.end()).toEqual([["a", ""]]);
	});

	it("strips a BOM only at the start of the first non-empty chunk", () => {
		const parser = new CsvRowParser();
		expect(parser.push("")).toEqual([]);
		expect(parser.push("﻿a\n")).toEqual([["a"]]);
		expect(parser.push("﻿b\n")).toEqual([["﻿b"]]);
	});
});

describe("parseCsvStream", () => {
	it("parses rows split across chunks, including CRLF and multi-byte characters", async () => {
		const bytes = encoder.encode("Name,City\r\nZoë,Köln\r\n");
		const split = bytes.indexOf(0xc3) + 1; // inside the two-byte "ë"
		const crlf = bytes.lastIndexOf(0x0d) + 1; // between the final CR and LF
		expect(await collect(chunksOf(bytes.slice(0, split), bytes.slice(split, crlf), bytes.slice(crlf)))).toEqual([
			{ Name: "Zoë", City: "Köln" },
		]);
	});

	it("keeps blank lines in single-column streams and skips them otherwise", async () => {
		expect(await collect(chunksOf("Id\n001\n", "\n002\n"))).toEqual([{ Id: "001" }, { Id: "" }, { Id: "002" }]);
		expect(await collect(chunksOf("A|B\n1|2\r", "\n\r\n3|4"), "|")).toEqual([
			{ A: "1", B: "2" },
			{ A: "3", B: "4" },
		]);
	});

	it("yields the last row without a trailing newline", async () => {
		expect(await collect(chunksOf("A,B\n1,", '""'))).toEqual([{ A: "1", B: "" }]);
	});
});

describe("toCsv #N/A", () => {
	it("writes null as #N/A and the text #N/A with a leading space, so it is not read as null", () => {
		expect(toCsv([{ Cleared: null, Text: "#N/A", Lower: "#n/a", Other: "N/A" }])).toBe(
			'Cleared,Text,Lower,Other\n#N/A," #N/A",#n/a,N/A\n',
		);
	});
});

describe("toCsv numbers", () => {
	it("writes numbers without exponent notation", () => {
		expect(toCsv([{ Big: 1e21, Small: 1e-7, Zero: -0, Plain: 12.5 }])).toBe(
			"Big,Small,Zero,Plain\n1000000000000000000000,0.0000001,0,12.5\n",
		);
		expect(toCsv([{ Amount: 1.2345e25 }, { Amount: -1.5e-10 }])).toBe(
			"Amount\n12345000000000000000000000\n-0.00000000015\n",
		);
	});

	it("rejects non-finite numbers", () => {
		expect(() => toCsv([{ Amount: Number.NaN }])).toThrow(/NaN/);
		expect(() => toCsv([{ Amount: Number.POSITIVE_INFINITY }])).toThrow(/Infinity/);
	});

	it("round-trips values through parseCsv", () => {
		const csv = toCsv([{ Name: 'a, "b"', Note: "line\nbreak", Count: 1e21 }]);
		expect(parseCsv(csv)).toEqual([{ Name: 'a, "b"', Note: "line\nbreak", Count: "1000000000000000000000" }]);
	});
});
