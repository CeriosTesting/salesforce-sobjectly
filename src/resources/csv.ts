import { formatNumber } from "../soql/escape";
import type { BulkColumnDelimiter, BulkLineEnding } from "../types/api";

export const DELIMITERS: Record<BulkColumnDelimiter, string> = {
	COMMA: ",",
	TAB: "\t",
	PIPE: "|",
	SEMICOLON: ";",
	CARET: "^",
	BACKQUOTE: "`",
};

/** In Bulk API CSV, `#N/A` sets a field to null; an empty value leaves it unchanged. */
const NULL_VALUE = "#N/A";

export interface CsvOptions {
	delimiter?: string;
	lineEnding?: BulkLineEnding;
}

/**
 * Serializes records to Bulk API CSV. Columns are the union of all keys in first-seen order.
 * `null` becomes `#N/A` (clears the field), `undefined` stays empty (leaves it unchanged),
 * `Date` becomes an ISO string (a Date field takes its UTC date), the text `"#N/A"` is written so
 * that it is stored as text rather than as null, and one level of nesting becomes a relationship column, so
 * `{ Account: { External_Id__c: "A1" } }` is written as column `Account.External_Id__c`.
 */
export function toCsv(records: readonly object[], options: CsvOptions = {}): string {
	const delimiter = options.delimiter ?? ",";
	const newline = options.lineEnding === "CRLF" ? "\r\n" : "\n";
	const rows = records.map((record) => flattenRecord(record));
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				columns.push(key);
			}
		}
	}
	if (columns.length === 0) {
		throw new Error("Cannot build CSV: the records have no fields.");
	}
	const lines = [columns.map((column) => quote(column, delimiter)).join(delimiter)];
	for (const row of rows) {
		lines.push(columns.map((column) => quote(formatValue(row[column]), delimiter)).join(delimiter));
	}
	return lines.join(newline) + newline;
}

/**
 * An incremental RFC 4180 CSV parser: feed it text chunks with `push` and it returns the rows
 * completed so far. Quotes, escaped quotes and CRLF may be split across chunks.
 *
 * A truly blank line is returned as an empty array (`[]`), so it can be told apart from a row
 * with one empty value (`[""]`, e.g. a quoted `""` in a single-column file).
 */
export class CsvRowParser {
	private _row: string[] = [];
	private _field = "";
	private _inQuotes = false;
	/** The current field was quoted, so it exists even when empty. */
	private _fieldQuoted = false;
	/** A `"` was seen inside quotes; the next character decides whether it was an escaped quote. */
	private _quotePending = false;
	/** The last row ended with `\r`; a following `\n` belongs to it. */
	private _skipLineFeed = false;
	private _started = false;

	constructor(private readonly _delimiter: string = ",") {}

	/** Parses a chunk and returns the rows it completed. */
	push(chunk: string): string[][] {
		const rows: string[][] = [];
		let text = chunk;
		if (!this._started && text.length > 0) {
			this._started = true;
			text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
		}
		for (const char of text) {
			this.consume(char, rows);
		}
		return rows;
	}

	/** Finishes parsing and returns the last row, if any. */
	end(): string[][] {
		this._quotePending = false;
		this._inQuotes = false;
		if (this._field.length > 0 || this._row.length > 0 || this._fieldQuoted) {
			this._row.push(this._field);
			const row = this._row;
			this._row = [];
			this._field = "";
			this._fieldQuoted = false;
			return [row];
		}
		return [];
	}

	private consume(char: string, rows: string[][]): void {
		if (this._skipLineFeed) {
			this._skipLineFeed = false;
			if (char === "\n") {
				return;
			}
		}
		if (this._quotePending) {
			this._quotePending = false;
			if (char === '"') {
				this._field += '"';
				return;
			}
			this._inQuotes = false;
		}
		if (this._inQuotes) {
			if (char === '"') {
				this._quotePending = true;
			} else {
				this._field += char;
			}
			return;
		}
		this.consumeUnquoted(char, rows);
	}

	private consumeUnquoted(char: string, rows: string[][]): void {
		if (char === '"') {
			this._inQuotes = true;
			this._fieldQuoted = true;
		} else if (char === this._delimiter) {
			this._row.push(this._field);
			this._field = "";
			this._fieldQuoted = false;
		} else if (char === "\n" || char === "\r") {
			this._skipLineFeed = char === "\r";
			const blank = this._row.length === 0 && this._field === "" && !this._fieldQuoted;
			rows.push(blank ? [] : [...this._row, this._field]);
			this._row = [];
			this._field = "";
			this._fieldQuoted = false;
		} else {
			this._field += char;
		}
	}
}

/** Parses CSV (RFC 4180: quoted fields, escaped quotes, CRLF or LF) into rows of strings. */
export function parseCsvRows(text: string, delimiter: string = ","): string[][] {
	const parser = new CsvRowParser(delimiter);
	return [...parser.push(text), ...parser.end()];
}

/**
 * Parses streamed CSV (with a header row) into objects keyed by column name, yielding each row
 * as soon as it is complete.
 */
export async function* parseCsvStream(
	chunks: AsyncIterable<Uint8Array>,
	delimiter: string = ",",
): AsyncGenerator<Record<string, string>, void, undefined> {
	const decoder = new TextDecoder();
	const parser = new CsvRowParser(delimiter);
	let header: string[] | undefined;
	const toRecords = function* (rows: string[][]): Generator<Record<string, string>, void, undefined> {
		for (const row of rows) {
			if (!header) {
				header = row;
			} else if (!isBlankLine(header, row)) {
				yield toRecord(header, row);
			}
		}
	};
	for await (const chunk of chunks) {
		yield* toRecords(parser.push(decoder.decode(chunk, { stream: true })));
	}
	yield* toRecords([...parser.push(decoder.decode()), ...parser.end()]);
}

function toRecord(header: readonly string[], row: readonly string[]): Record<string, string> {
	const record: Record<string, string> = {};
	header.forEach((column, index) => {
		record[column] = row[index] ?? "";
	});
	return record;
}

/** Parses CSV with a header row into objects keyed by column name. */
export function parseCsv(text: string, delimiter: string = ","): Record<string, string>[] {
	const [header, ...rows] = parseCsvRows(text, delimiter);
	if (!header || header.length === 0) {
		return [];
	}
	return rows.filter((row) => !isBlankLine(header, row)).map((row) => toRecord(header, row));
}

/**
 * A blank line separates nothing in multi-column CSV, but in a single-column file it is a row
 * with an empty (null) value and must be kept.
 */
function isBlankLine(header: readonly string[], row: readonly string[]): boolean {
	return row.length === 0 && header.length !== 1;
}

function flattenRecord(record: object): Record<string, unknown> {
	const flat: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "attributes") {
			continue;
		}
		if (isPlainObject(value)) {
			for (const [nestedKey, nestedValue] of Object.entries(value)) {
				if (nestedKey !== "attributes") {
					flat[`${key}.${nestedKey}`] = nestedValue;
				}
			}
		} else {
			flat[key] = value;
		}
	}
	return flat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function formatValue(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	if (value === null) {
		return NULL_VALUE;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		return value.join(";");
	}
	if (typeof value === "string") {
		// Bulk API reads `#N/A`, quoted or not, as null. Salesforce trims text values, so with a
		// leading space it is stored as the text "#N/A" (the REST API trims the same way).
		return value === NULL_VALUE ? ` ${NULL_VALUE}` : value;
	}
	if (typeof value === "number") {
		// Salesforce rejects exponent notation such as 1e+21.
		return formatNumber(value);
	}
	if (typeof value === "boolean" || typeof value === "bigint") {
		return value.toString();
	}
	return JSON.stringify(value) ?? "";
}

function quote(value: string, delimiter: string): string {
	if (
		value.includes(delimiter) ||
		value.includes('"') ||
		value.includes("\n") ||
		value.includes("\r") ||
		value !== value.trim()
	) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}
