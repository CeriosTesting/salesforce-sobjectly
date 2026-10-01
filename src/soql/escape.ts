declare const soqlLiteralBrand: unique symbol;

/** A value that is inserted into SOQL verbatim. Create one with {@link soqlLiteral}. */
export interface SoqlLiteral {
	readonly [soqlLiteralBrand]: true;
	readonly sql: string;
}

/** A value accepted by the typed `where` helpers. */
export type SoqlValue = string | number | boolean | null | Date | SoqlLiteral;

/**
 * Literals created by this module. Checking membership (instead of the shape `{ sql }`) means a
 * plain object from user input can never be mistaken for raw SOQL.
 */
const literals = new WeakSet<object>();

/**
 * Marks `sql` as a raw SOQL literal, e.g. a date literal such as `soqlLiteral("LAST_N_DAYS:30")`
 * or `soqlLiteral("TODAY")`. Never pass untrusted input.
 */
export function soqlLiteral(sql: string): SoqlLiteral {
	if (typeof sql !== "string" || sql.trim().length === 0) {
		throw new Error("soqlLiteral() requires a non-blank SOQL fragment.");
	}
	const literal = Object.freeze({ sql }) as SoqlLiteral;
	literals.add(literal);
	return literal;
}

/** `true` for values created with `soqlLiteral` (and the helpers built on it). */
export function isSoqlLiteral(value: unknown): value is SoqlLiteral {
	return typeof value === "object" && value !== null && literals.has(value);
}

/** Salesforce accepts dates and date-times from 1700-01-01 to 4000-12-31. */
const MIN_YEAR = 1700;
const MAX_YEAR = 4000;

/**
 * Formats a value as a SOQL literal. Strings are quoted with backslashes, quotes and control
 * characters escaped, which prevents SOQL injection for values from user or external input.
 * In `LIKE` patterns `%` and `_` stay wildcards; use {@link soqlLike} to match them literally.
 *
 * A `Date` becomes a DateTime literal (`yyyy-MM-ddTHH:mm:ssZ`, UTC), which only works against
 * DateTime fields. Use {@link soqlDate} for Date-only fields (e.g. `Birthdate`).
 */
export function soqlEscape(value: SoqlValue): string {
	if (value === null) {
		return "null";
	}
	if (value instanceof Date) {
		return formatDateTime(value);
	}
	if (typeof value === "object") {
		if (isSoqlLiteral(value)) {
			return value.sql;
		}
		throw new TypeError("Objects can't be used as SOQL values; use soqlLiteral() for raw SOQL.");
	}
	if (typeof value === "number") {
		return formatNumber(value);
	}
	if (typeof value === "boolean") {
		return String(value);
	}
	if (typeof value !== "string") {
		throw new TypeError(`Unsupported SOQL value of type ${typeof value}.`);
	}
	return `'${escapeText(value)}'`;
}

/** Escapes quotes, backslashes and control characters for use inside a quoted SOQL string. */
function escapeText(value: string): string {
	// oxlint-disable-next-line no-control-regex -- control characters are exactly what must be escaped
	return value.replace(/[\\'"\n\r\t\b\f\u0000-\u001f]/g, (char) => {
		switch (char) {
			case "\\":
				return "\\\\";
			case "'":
				return "\\'";
			case '"':
				return '\\"';
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			case "\b":
				return "\\b";
			case "\f":
				return "\\f";
			default:
				throw new Error(
					`SOQL strings can't contain the control character U+${char.charCodeAt(0).toString(16).padStart(4, "0")}.`,
				);
		}
	});
}

/** Formats a number without exponent notation, which SOQL doesn't accept (`1e21`, `1e-7`). */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error(`Cannot use ${value} in a SOQL query.`);
	}
	const plain = String(value);
	if (!/e/i.test(plain)) {
		return Object.is(value, -0) ? "0" : plain;
	}
	// Move the decimal point instead of rounding, so even 1e-30 keeps every digit.
	const [, sign = "", whole = "", fraction = "", exponent = "0"] =
		/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(plain) ?? [];
	const digits = whole + fraction;
	const point = whole.length + Number(exponent);
	if (point <= 0) {
		return `${sign}0.${"0".repeat(-point)}${digits}`;
	}
	if (point >= digits.length) {
		return sign + digits + "0".repeat(point - digits.length);
	}
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function assertYear(year: number, value: Date): void {
	if (Number.isNaN(year)) {
		throw new Error("Invalid Date can't be used in a SOQL query.");
	}
	if (year < MIN_YEAR || year > MAX_YEAR) {
		throw new Error(`Salesforce only accepts dates from ${MIN_YEAR} to ${MAX_YEAR}, got ${value.toISOString()}.`);
	}
}

/** `yyyy-MM-ddTHH:mm:ssZ` in UTC, one of the DateTime formats SOQL documents. */
function formatDateTime(value: Date): string {
	assertYear(value.getUTCFullYear(), value);
	return `${value.toISOString().slice(0, 19)}Z`;
}

/**
 * Formats a `Date` as a Date-only literal (`yyyy-MM-dd`), for use against Date fields. Uses the
 * UTC date unless `local` is set, in which case the date in the local time zone is used.
 */
export function soqlEscapeDateOnly(value: Date, options: { local?: boolean } = {}): string {
	if (!options.local) {
		assertYear(value.getUTCFullYear(), value);
		return value.toISOString().slice(0, 10);
	}
	assertYear(value.getFullYear(), value);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * A Date-only literal for the typed `where` helpers, e.g. `where("Birthdate", ">", soqlDate(d))`.
 * Accepts a `Date` or a `yyyy-MM-dd` string. A `Date` uses its UTC date; pass `{ local: true }`
 * to use the date in the local time zone (e.g. for `new Date(2026, 0, 31)`).
 */
export function soqlDate(value: Date | string, options: { local?: boolean } = {}): SoqlLiteral {
	if (typeof value === "string") {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			throw new Error(`soqlDate() expects a yyyy-MM-dd string, got "${value}".`);
		}
		return soqlLiteral(value);
	}
	return soqlLiteral(soqlEscapeDateOnly(value, options));
}

/**
 * A `LIKE` pattern that matches `text` literally (its `%`, `_` and `\` are escaped), with
 * wildcards added for `mode`:
 *
 * ```ts
 * where("Name", "LIKE", soqlLike(userInput, "startsWith")) // Name LIKE 'Acme 50\% off%'
 * ```
 */
export function soqlLike(
	text: string,
	mode: "contains" | "startsWith" | "endsWith" | "exact" = "contains",
): SoqlLiteral {
	const escaped = escapeText(text).replace(/[%_]/g, (char) => `\\${char}`);
	const prefix = mode === "contains" || mode === "endsWith" ? "%" : "";
	const suffix = mode === "contains" || mode === "startsWith" ? "%" : "";
	return soqlLiteral(`'${prefix}${escaped}${suffix}'`);
}

/** Date literals without a number, e.g. `TODAY` or `THIS_FISCAL_QUARTER`. */
export type SoqlFixedDateLiteral =
	| "YESTERDAY"
	| "TODAY"
	| "TOMORROW"
	| "LAST_WEEK"
	| "THIS_WEEK"
	| "NEXT_WEEK"
	| "LAST_MONTH"
	| "THIS_MONTH"
	| "NEXT_MONTH"
	| "LAST_90_DAYS"
	| "NEXT_90_DAYS"
	| "THIS_QUARTER"
	| "LAST_QUARTER"
	| "NEXT_QUARTER"
	| "THIS_YEAR"
	| "LAST_YEAR"
	| "NEXT_YEAR"
	| "THIS_FISCAL_QUARTER"
	| "LAST_FISCAL_QUARTER"
	| "NEXT_FISCAL_QUARTER"
	| "THIS_FISCAL_YEAR"
	| "LAST_FISCAL_YEAR"
	| "NEXT_FISCAL_YEAR";

/** Date literals that take a number, e.g. `LAST_N_DAYS:30`. */
export type SoqlRelativeDateLiteral =
	| "LAST_N_DAYS"
	| "NEXT_N_DAYS"
	| "N_DAYS_AGO"
	| "LAST_N_WEEKS"
	| "NEXT_N_WEEKS"
	| "N_WEEKS_AGO"
	| "LAST_N_MONTHS"
	| "NEXT_N_MONTHS"
	| "N_MONTHS_AGO"
	| "LAST_N_QUARTERS"
	| "NEXT_N_QUARTERS"
	| "N_QUARTERS_AGO"
	| "LAST_N_YEARS"
	| "NEXT_N_YEARS"
	| "N_YEARS_AGO"
	| "LAST_N_FISCAL_QUARTERS"
	| "NEXT_N_FISCAL_QUARTERS"
	| "N_FISCAL_QUARTERS_AGO"
	| "LAST_N_FISCAL_YEARS"
	| "NEXT_N_FISCAL_YEARS"
	| "N_FISCAL_YEARS_AGO";

const FIXED_DATE_LITERALS = new Set<string>([
	"YESTERDAY",
	"TODAY",
	"TOMORROW",
	"LAST_WEEK",
	"THIS_WEEK",
	"NEXT_WEEK",
	"LAST_MONTH",
	"THIS_MONTH",
	"NEXT_MONTH",
	"LAST_90_DAYS",
	"NEXT_90_DAYS",
	"THIS_QUARTER",
	"LAST_QUARTER",
	"NEXT_QUARTER",
	"THIS_YEAR",
	"LAST_YEAR",
	"NEXT_YEAR",
	"THIS_FISCAL_QUARTER",
	"LAST_FISCAL_QUARTER",
	"NEXT_FISCAL_QUARTER",
	"THIS_FISCAL_YEAR",
	"LAST_FISCAL_YEAR",
	"NEXT_FISCAL_YEAR",
]);

/**
 * A typed SOQL date literal for date and datetime fields:
 * `soqlDateLiteral("TODAY")`, `soqlDateLiteral("LAST_N_DAYS", 30)`.
 */
export function soqlDateLiteral(name: SoqlFixedDateLiteral): SoqlLiteral;
export function soqlDateLiteral(name: SoqlRelativeDateLiteral, n: number): SoqlLiteral;
export function soqlDateLiteral(name: string, n?: number): SoqlLiteral {
	if (FIXED_DATE_LITERALS.has(name)) {
		return soqlLiteral(name);
	}
	if (!/^(LAST|NEXT)_N_|_AGO$/.test(name) || !/^[A-Z_]+$/.test(name)) {
		throw new Error(`Unknown SOQL date literal "${name}".`);
	}
	if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
		throw new Error(`soqlDateLiteral("${name}", n) requires a non-negative integer n.`);
	}
	return soqlLiteral(`${name}:${n}`);
}

/**
 * Escapes a term for a SOSL `FIND {...}` clause by backslash-escaping the reserved characters
 * `? & | ! { } [ ] ( ) ^ ~ * : \ " ' + -`.
 */
export function soslEscape(term: string): string {
	return term.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, (match) => `\\${match}`);
}
