const encoder = new TextEncoder();

export interface MultipartPart {
	/** The form field name, e.g. `entity_content` or `VersionData`. */
	name: string;
	filename?: string;
	contentType: string;
	data: string | Uint8Array;
}

/**
 * Builds a `multipart/form-data` body as bytes, so it can go through any transport without
 * FormData support.
 */
export function buildMultipart(
	parts: readonly MultipartPart[],
	boundary: string = randomBoundary(),
): {
	body: Uint8Array;
	contentType: string;
} {
	if (parts.length === 0) {
		throw new Error("A multipart body needs at least one part.");
	}
	const chunks: Uint8Array[] = [];
	for (const part of parts) {
		const filename = part.filename === undefined ? "" : `; filename="${escapeQuoted(part.filename)}"`;
		chunks.push(
			encoder.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(part.name)}"${filename}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
			),
			typeof part.data === "string" ? encoder.encode(part.data) : part.data,
			encoder.encode("\r\n"),
		);
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));
	return { body: concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function randomBoundary(): string {
	return `----sobjectly${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

function escapeQuoted(value: string): string {
	return value.replace(/["\r\n]/g, "_");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
