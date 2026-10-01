import type { ApiVersion } from "./types/common";

const API_VERSION_PATTERN = /^v\d+\.\d+$/;

/** `true` for a version such as `"v66.0"`. */
export function isApiVersion(value: unknown): value is ApiVersion {
	return typeof value === "string" && API_VERSION_PATTERN.test(value);
}

/**
 * Throws a `TypeError` that explains how to set the version when `value` is missing or not a
 * version such as `"v66.0"`. `hint` is appended to the message.
 */
export function assertApiVersion(value: unknown, context: string, hint: string): asserts value is ApiVersion {
	if (value === undefined || value === null || value === "") {
		throw new TypeError(`${context}: apiVersion is required, e.g. "v66.0". ${hint}`);
	}
	if (!isApiVersion(value)) {
		throw new TypeError(
			`${context}: invalid apiVersion ${JSON.stringify(value)}. Expected a value like "v66.0". ${hint}`,
		);
	}
}

/**
 * Accepts the ways people write an API version (`"66"`, `"66.0"`, `"v66"`, `"v66.0"`) and
 * returns the canonical form (`"v66.0"`), or `undefined` when the input is not a version.
 */
export function normalizeApiVersion(input: string): ApiVersion | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?$/i.exec(input.trim());
	if (!match) {
		return undefined;
	}
	return `v${Number(match[1])}.${Number(match[2] ?? 0)}`;
}
