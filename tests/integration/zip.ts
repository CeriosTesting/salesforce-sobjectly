import { crc32 } from "node:zlib";

/** Builds an uncompressed ("stored") zip archive: enough for a Metadata API deploy. */
export function zip(files: Record<string, string>): Uint8Array {
	const encoder = new TextEncoder();
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const [path, content] of Object.entries(files)) {
		const name = encoder.encode(path);
		const data = encoder.encode(content);
		const crc = crc32(data);

		const header = new DataView(new ArrayBuffer(30));
		header.setUint32(0, 0x04034b50, true); // local file header
		header.setUint16(4, 20, true); // version needed
		header.setUint32(14, crc, true);
		header.setUint32(18, data.length, true); // compressed size
		header.setUint32(22, data.length, true); // uncompressed size
		header.setUint16(26, name.length, true);
		local.push(new Uint8Array(header.buffer), name, data);

		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true); // central directory header
		entry.setUint16(4, 20, true); // version made by
		entry.setUint16(6, 20, true); // version needed
		entry.setUint32(16, crc, true);
		entry.setUint32(20, data.length, true);
		entry.setUint32(24, data.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(42, offset, true); // offset of the local header
		central.push(new Uint8Array(entry.buffer), name);

		offset += 30 + name.length + data.length;
	}
	const centralSize = central.reduce((size, part) => size + part.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true); // end of central directory
	end.setUint16(8, Object.keys(files).length, true);
	end.setUint16(10, Object.keys(files).length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);

	const parts = [...local, ...central, new Uint8Array(end.buffer)];
	const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let position = 0;
	for (const part of parts) {
		result.set(part, position);
		position += part.length;
	}
	return result;
}
