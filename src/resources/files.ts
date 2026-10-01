import { SalesforceSaveError } from "../errors";
import { type SalesforceConnection, segment } from "../http/connection";
import { buildMultipart } from "../http/multipart";
import type { SaveResult } from "../types/common";

/** JSON uploads send base64, which Salesforce caps at 37.5 MB encoded (about 28 MB of file data). */
export const MAX_JSON_UPLOAD_BYTES = Math.floor((37.5 * 1024 * 1024 * 3) / 4);
/** Multipart ContentVersion uploads are limited to 2 GB. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const encoder = new TextEncoder();

export type FileShareType = "V" | "C" | "I";
export type FileVisibility = "AllUsers" | "InternalUsers" | "SharedUsers";

export interface UploadFileOptions {
	/** The file content. Strings are encoded as UTF-8. */
	data: Uint8Array | string;
	/** The file name including extension, e.g. `"invoice.pdf"` (`PathOnClient`). */
	fileName: string;
	/** Defaults to the file name without extension. */
	title?: string;
	description?: string;
	/** A record id (or user/library id) to share the file with. */
	linkTo?: string;
	/** Link permission: `V` viewer (default), `C` collaborator, `I` inferred from the record. */
	shareType?: FileShareType;
	visibility?: FileVisibility;
	signal?: AbortSignal;
}

export interface NewVersionOptions {
	data: Uint8Array | string;
	fileName: string;
	title?: string;
	reasonForChange?: string;
	signal?: AbortSignal;
}

export interface UploadedFile {
	contentVersionId: string;
	contentDocumentId: string;
}

/**
 * Salesforce Files (ContentVersion / ContentDocument). Small files go up as JSON with base64,
 * larger ones as multipart (up to 2 GB), which works with every transport.
 */
export class FilesApi {
	constructor(
		private readonly _connection: SalesforceConnection,
		/** Files up to this size go up as JSON/base64, larger ones as multipart. */
		private readonly _jsonUploadLimit: number = MAX_JSON_UPLOAD_BYTES,
	) {}

	/** Uploads a file and optionally links it to a record. */
	async upload(options: UploadFileOptions): Promise<UploadedFile> {
		const fields: Record<string, unknown> = {
			Title: options.title ?? stripExtension(options.fileName),
			PathOnClient: options.fileName,
		};
		if (options.description !== undefined) {
			fields.Description = options.description;
		}
		const explicitLink = options.linkTo !== undefined && (options.shareType ?? options.visibility) !== undefined;
		if (options.linkTo !== undefined && !explicitLink) {
			// Creates the ContentDocumentLink in the same call.
			fields.FirstPublishLocationId = options.linkTo;
		}
		const uploaded = await this.createVersion(fields, options.data, options.signal);
		if (explicitLink && options.linkTo !== undefined) {
			await this.link(uploaded.contentDocumentId, options.linkTo, {
				shareType: options.shareType,
				visibility: options.visibility,
				signal: options.signal,
			});
		}
		return uploaded;
	}

	/** Adds a new version to an existing file. */
	newVersion(contentDocumentId: string, options: NewVersionOptions): Promise<UploadedFile> {
		const fields: Record<string, unknown> = {
			ContentDocumentId: contentDocumentId,
			Title: options.title ?? stripExtension(options.fileName),
			PathOnClient: options.fileName,
		};
		if (options.reasonForChange !== undefined) {
			fields.ReasonForChange = options.reasonForChange;
		}
		return this.createVersion(fields, options.data, options.signal);
	}

	/** Downloads file content by ContentVersion id (`068...`) or ContentDocument id (`069...`, latest version). */
	async download(id: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
		let versionId = id;
		if (id.startsWith("069")) {
			const document = await this._connection.request<{ LatestPublishedVersionId: string }>({
				path: `/sobjects/ContentDocument/${segment(id)}`,
				query: { fields: "LatestPublishedVersionId" },
				signal: options.signal,
			});
			versionId = document.LatestPublishedVersionId;
		}
		return this._connection.request({
			path: `/sobjects/ContentVersion/${segment(versionId)}/VersionData`,
			responseType: "binary",
			signal: options.signal,
		});
	}

	/** Shares a file with a record, user or library. Returns the ContentDocumentLink id. */
	async link(
		contentDocumentId: string,
		linkedEntityId: string,
		options: { shareType?: FileShareType; visibility?: FileVisibility; signal?: AbortSignal } = {},
	): Promise<string> {
		const body: Record<string, unknown> = {
			ContentDocumentId: contentDocumentId,
			LinkedEntityId: linkedEntityId,
			ShareType: options.shareType ?? "V",
		};
		if (options.visibility) {
			body.Visibility = options.visibility;
		}
		const result = await this._connection.request<SaveResult>({
			method: "POST",
			path: "/sobjects/ContentDocumentLink",
			body,
			signal: options.signal,
		});
		return requireSaved(result, "Linking the file");
	}

	private async createVersion(
		fields: Record<string, unknown>,
		data: Uint8Array | string,
		signal: AbortSignal | undefined,
	): Promise<UploadedFile> {
		const bytes = typeof data === "string" ? encoder.encode(data) : data;
		if (bytes.byteLength > MAX_UPLOAD_BYTES) {
			throw new Error(`File of ${bytes.byteLength} bytes exceeds the 2 GB ContentVersion limit.`);
		}
		const result =
			bytes.byteLength <= this._jsonUploadLimit
				? await this._connection.request<SaveResult>({
						method: "POST",
						path: "/sobjects/ContentVersion",
						body: { ...fields, VersionData: Buffer.from(bytes).toString("base64") },
						signal,
					})
				: await this.createVersionMultipart(fields, bytes, signal);
		const contentVersionId = requireSaved(result, "Uploading the file");
		const version = await this._connection.request<{ ContentDocumentId: string }>({
			path: `/sobjects/ContentVersion/${segment(contentVersionId)}`,
			query: { fields: "ContentDocumentId" },
			signal,
		});
		return { contentVersionId, contentDocumentId: version.ContentDocumentId };
	}

	private createVersionMultipart(
		fields: Record<string, unknown>,
		bytes: Uint8Array,
		signal: AbortSignal | undefined,
	): Promise<SaveResult> {
		const { body, contentType } = buildMultipart([
			{ name: "entity_content", contentType: "application/json", data: JSON.stringify(fields) },
			{
				name: "VersionData",
				filename: String(fields.PathOnClient),
				contentType: "application/octet-stream",
				data: bytes,
			},
		]);
		return this._connection.request<SaveResult>({
			method: "POST",
			path: "/sobjects/ContentVersion",
			body,
			headers: { "Content-Type": contentType },
			signal,
			timeoutMs: 0,
		});
	}
}

function requireSaved(result: SaveResult, action: string): string {
	if (!result.success || !result.id) {
		throw new SalesforceSaveError(`${action} failed`, [result], result.errors ?? []);
	}
	return result.id;
}

function stripExtension(fileName: string): string {
	const index = fileName.lastIndexOf(".");
	return index > 0 ? fileName.slice(0, index) : fileName;
}
