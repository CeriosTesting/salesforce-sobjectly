import { SalesforceBulkJobError } from "../errors";
import { type SalesforceConnection, segment, sleep } from "../http/connection";
import type { ExternalIdField, SObjectFieldName, SObjectName, SObjectRecord } from "../registry";
import type { NoSelection, SoqlQueryBuilder, SoqlQueryRecord } from "../soql/query-builder";
import type {
	BulkColumnDelimiter,
	BulkIngestOperation,
	BulkJobInfo,
	BulkLineEnding,
	BulkQueryOperation,
} from "../types/api";

import { DELIMITERS, parseCsv, parseCsvStream, toCsv } from "./csv";

/** Bulk API 2.0 rejects uploads over 150 MB after base64 encoding; stay safely under 100 MB raw. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const encoder = new TextEncoder();

type Scalar = string | number | boolean | null | undefined;

type FlatKeys<T> = {
	[P in keyof T & string]: P extends "attributes"
		? never
		: NonNullable<T[P]> extends Scalar
			? P
			: NonNullable<T[P]> extends object
				? `${P}.${Exclude<keyof NonNullable<T[P]>, "attributes"> & string}`
				: P;
}[keyof T & string];

/**
 * A row of a Bulk API CSV result. All values are strings; relationship fields become dotted
 * columns (e.g. `"Account.Name"`).
 */
export type BulkCsvRecord<T> = string extends keyof T ? Record<string, string> : { [P in FlatKeys<T>]: string };

/**
 * A record to ingest: any subset of the sObject's fields (`null` clears a field), plus dotted
 * relationship columns for parent lookups by external id (e.g. `"Account.External_Id__c"`).
 */
export type BulkIngestRecord<R extends object, K extends SObjectName<R>> = {
	[F in SObjectFieldName<R, K>]?: SObjectRecord<R, K>[F] | Date | null;
} & { [relationshipColumn: `${string}.${string}`]: string | number | undefined };

export interface WaitOptions {
	/** Delay between status checks. Defaults to 2 000 ms. */
	pollIntervalMs?: number;
	/** Give up after this many milliseconds. Defaults to 10 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface BulkIngestJobOptions<K extends string = string> {
	object: K;
	operation: BulkIngestOperation;
	/** Required for `upsert`. */
	externalIdFieldName?: string;
	assignmentRuleId?: string;
	columnDelimiter?: BulkColumnDelimiter;
	lineEnding?: BulkLineEnding;
	signal?: AbortSignal;
}

export interface BulkIngestOptions<R extends object, K extends SObjectName<R>> extends BulkIngestJobOptions<K> {
	/** Required for `upsert`: an external id field of `object`. */
	externalIdFieldName?: ExternalIdField<R, K>;
	/** Records to upload; converted to CSV. Pass either `records` or `csv`. */
	records?: readonly BulkIngestRecord<R, K>[];
	/** Pre-built CSV to upload. */
	csv?: string;
	/** Wait until the job has finished. Defaults to `true`. */
	wait?: boolean | WaitOptions;
}

export interface BulkQueryOptions {
	/** `queryAll` also returns deleted and archived records. */
	includeDeleted?: boolean;
	columnDelimiter?: BulkColumnDelimiter;
	lineEnding?: BulkLineEnding;
	/** Maximum records per result page. */
	maxRecords?: number;
	wait?: WaitOptions;
	signal?: AbortSignal;
}

/** A Bulk API 2.0 ingest job. */
export class BulkIngestJob {
	constructor(
		private readonly _connection: SalesforceConnection,
		public info: BulkJobInfo,
	) {}

	get id(): string {
		return this.info.id;
	}

	private get path(): string {
		return `/jobs/ingest/${segment(this.id)}`;
	}

	private get delimiter(): string {
		return DELIMITERS[this.info.columnDelimiter] ?? ",";
	}

	/** Uploads CSV data, or records that are converted to CSV. Only allowed while the job is `Open`. */
	async upload(data: string | readonly object[], options: { signal?: AbortSignal } = {}): Promise<void> {
		const csv =
			typeof data === "string" ? data : toCsv(data, { delimiter: this.delimiter, lineEnding: this.info.lineEnding });
		const size = encoder.encode(csv).byteLength;
		if (size > MAX_UPLOAD_BYTES) {
			throw new Error(`Bulk upload of ${size} bytes exceeds the ${MAX_UPLOAD_BYTES} byte limit; split the data.`);
		}
		await this._connection.request({
			method: "PUT",
			path: `${this.path}/batches`,
			body: csv,
			headers: { "Content-Type": "text/csv" },
			signal: options.signal,
		});
	}

	/** Marks the upload as complete so Salesforce starts processing. */
	close(options: { signal?: AbortSignal } = {}): Promise<BulkJobInfo> {
		return this.setState("UploadComplete", options.signal);
	}

	abort(options: { signal?: AbortSignal } = {}): Promise<BulkJobInfo> {
		return this.setState("Aborted", options.signal);
	}

	async delete(options: { signal?: AbortSignal } = {}): Promise<void> {
		await this._connection.request({ method: "DELETE", path: this.path, signal: options.signal });
	}

	/** Fetches the current job status. */
	async refresh(options: { signal?: AbortSignal } = {}): Promise<BulkJobInfo> {
		this.info = await this._connection.request<BulkJobInfo>({ path: this.path, signal: options.signal });
		return this.info;
	}

	/** Polls until the job is `JobComplete`. Throws `SalesforceBulkJobError` on `Failed`, `Aborted` or timeout. */
	waitForCompletion(options: WaitOptions = {}): Promise<BulkJobInfo> {
		return waitForJob(this, options);
	}

	/** Successfully processed rows: `sf__Id`, `sf__Created` and the uploaded columns. */
	successfulResults(options: { signal?: AbortSignal } = {}): Promise<Record<string, string>[]> {
		return this.results("successfulResults", options.signal);
	}

	/** Failed rows: `sf__Id`, `sf__Error` and the uploaded columns. */
	failedResults(options: { signal?: AbortSignal } = {}): Promise<Record<string, string>[]> {
		return this.results("failedResults", options.signal);
	}

	/** Rows that were not processed (e.g. because the job was aborted). */
	unprocessedRecords(options: { signal?: AbortSignal } = {}): Promise<Record<string, string>[]> {
		return this.results("unprocessedrecords", options.signal);
	}

	private async results(resource: string, signal: AbortSignal | undefined): Promise<Record<string, string>[]> {
		const csv = await this._connection.request<string | undefined>({
			path: `${this.path}/${resource}/`,
			headers: { Accept: "text/csv" },
			responseType: "text",
			signal,
		});
		return csv ? parseCsv(csv, this.delimiter) : [];
	}

	private async setState(state: "UploadComplete" | "Aborted", signal: AbortSignal | undefined): Promise<BulkJobInfo> {
		this.info = await this._connection.request<BulkJobInfo>({
			method: "PATCH",
			path: this.path,
			body: { state },
			signal,
		});
		return this.info;
	}
}

/** A Bulk API 2.0 query job. */
export class BulkQueryJob<TRow = Record<string, string>> {
	constructor(
		private readonly _connection: SalesforceConnection,
		public info: BulkJobInfo,
	) {}

	get id(): string {
		return this.info.id;
	}

	private get path(): string {
		return `/jobs/query/${segment(this.id)}`;
	}

	async refresh(options: { signal?: AbortSignal } = {}): Promise<BulkJobInfo> {
		this.info = await this._connection.request<BulkJobInfo>({ path: this.path, signal: options.signal });
		return this.info;
	}

	/** Polls until the job is `JobComplete`. Throws `SalesforceBulkJobError` on `Failed`, `Aborted` or timeout. */
	waitForCompletion(options: WaitOptions = {}): Promise<BulkJobInfo> {
		return waitForJob(this, options);
	}

	async abort(options: { signal?: AbortSignal } = {}): Promise<BulkJobInfo> {
		this.info = await this._connection.request<BulkJobInfo>({
			method: "PATCH",
			path: this.path,
			body: { state: "Aborted" },
			signal: options.signal,
		});
		return this.info;
	}

	async delete(options: { signal?: AbortSignal } = {}): Promise<void> {
		await this._connection.request({ method: "DELETE", path: this.path, signal: options.signal });
	}

	/** Yields result pages (following `Sforce-Locator`). The job must be complete. */
	async *pages(options: { maxRecords?: number; signal?: AbortSignal } = {}): AsyncGenerator<TRow[], void, undefined> {
		const delimiter = DELIMITERS[this.info.columnDelimiter] ?? ",";
		let locator: string | undefined;
		do {
			const response = await this._connection.send<string | undefined>({
				path: `${this.path}/results`,
				query: { locator, maxRecords: options.maxRecords },
				headers: { Accept: "text/csv" },
				responseType: "text",
				signal: options.signal,
			});
			yield (response.data ? parseCsv(response.data, delimiter) : []) as TRow[];
			const next = response.headers.get("sforce-locator");
			locator = next && next !== "null" ? next : undefined;
		} while (locator);
	}

	/** Yields every result row. The job must be complete. */
	async *records(options: { maxRecords?: number; signal?: AbortSignal } = {}): AsyncGenerator<TRow, void, undefined> {
		const delimiter = DELIMITERS[this.info.columnDelimiter] ?? ",";
		let locator: string | undefined;
		do {
			const request = {
				path: `${this.path}/results`,
				query: { locator, maxRecords: options.maxRecords },
				headers: { Accept: "text/csv" },
				signal: options.signal,
			};
			// Stream the CSV when the transport can, so memory stays flat regardless of page size.
			const streamed = await this._connection.stream(request);
			if (!streamed) {
				for await (const page of this.pages(options)) {
					yield* page;
				}
				return;
			}
			yield* parseCsvStream(streamed.body, delimiter) as AsyncGenerator<TRow, void, undefined>;
			const next = streamed.headers.get("sforce-locator");
			locator = next && next !== "null" ? next : undefined;
		} while (locator);
	}
}

/** Bulk API 2.0: asynchronous ingest (insert/update/upsert/delete) and query of large data volumes. */
export class BulkApi<R extends object> {
	constructor(private readonly _connection: SalesforceConnection) {}

	/** Creates an ingest job in state `Open`. Upload data with `job.upload()` and then call `job.close()`. */
	async createIngestJob<K extends SObjectName<R>>(
		options: BulkIngestJobOptions<K> & { externalIdFieldName?: ExternalIdField<R, K> },
	): Promise<BulkIngestJob> {
		if (options.operation === "upsert" && !options.externalIdFieldName) {
			throw new Error("Bulk upsert requires externalIdFieldName.");
		}
		const info = await this._connection.request<BulkJobInfo>({
			method: "POST",
			path: "/jobs/ingest",
			body: {
				object: options.object,
				operation: options.operation,
				externalIdFieldName: options.externalIdFieldName,
				assignmentRuleId: options.assignmentRuleId,
				contentType: "CSV",
				columnDelimiter: options.columnDelimiter ?? "COMMA",
				lineEnding: options.lineEnding ?? "LF",
			},
			signal: options.signal,
		});
		return new BulkIngestJob(this._connection, info);
	}

	/** Attaches to an existing ingest job. */
	async ingestJob(id: string, options: { signal?: AbortSignal } = {}): Promise<BulkIngestJob> {
		const info = await this._connection.request<BulkJobInfo>({
			path: `/jobs/ingest/${segment(id)}`,
			signal: options.signal,
		});
		return new BulkIngestJob(this._connection, info);
	}

	/**
	 * Creates an ingest job, uploads the data, closes the job and (by default) waits for it.
	 * Check `job.info.numberRecordsFailed` and `job.failedResults()` afterwards.
	 */
	async ingest<K extends SObjectName<R>>(options: BulkIngestOptions<R, K>): Promise<BulkIngestJob> {
		if (options.csv !== undefined && options.records !== undefined) {
			throw new Error("bulk.ingest() takes either records or csv, not both.");
		}
		const data = options.csv ?? options.records;
		if (data === undefined || data.length === 0 || (typeof data === "string" && data.trim().length === 0)) {
			throw new Error("bulk.ingest() requires non-empty records or csv.");
		}
		const job = await this.createIngestJob(options);
		try {
			await job.upload(data, { signal: options.signal });
			await job.close({ signal: options.signal });
		} catch (error) {
			await job.abort().catch(() => undefined);
			throw error;
		}
		if (options.wait !== false) {
			await job.waitForCompletion(withSignal(typeof options.wait === "object" ? options.wait : {}, options.signal));
		}
		return job;
	}

	/** Creates a query job. Wait for it with `job.waitForCompletion()` and read rows with `job.records()`. */
	createQueryJob<K extends SObjectName<R>, S extends object = NoSelection>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: BulkQueryOptions,
	): Promise<BulkQueryJob<BulkCsvRecord<SoqlQueryRecord<R, K, S>>>>;
	createQueryJob<TRow = Record<string, string>>(soql: string, options?: BulkQueryOptions): Promise<BulkQueryJob<TRow>>;
	createQueryJob(
		query: string | { build(): string; usesTypeOf?: boolean },
		options: BulkQueryOptions = {},
	): Promise<BulkQueryJob<unknown>> {
		return this.startQueryJob(query, options);
	}

	private async startQueryJob(
		query: string | { build(): string; usesTypeOf?: boolean },
		options: BulkQueryOptions,
	): Promise<BulkQueryJob<unknown>> {
		if (typeof query !== "string" && query.usesTypeOf) {
			throw new Error("Bulk API 2.0 does not support TYPEOF; use sf.query()/sf.collect() instead.");
		}
		const operation: BulkQueryOperation = options.includeDeleted ? "queryAll" : "query";
		const info = await this._connection.request<BulkJobInfo>({
			method: "POST",
			path: "/jobs/query",
			body: {
				operation,
				query: typeof query === "string" ? query : query.build(),
				contentType: "CSV",
				columnDelimiter: options.columnDelimiter ?? "COMMA",
				lineEnding: options.lineEnding ?? "LF",
			},
			signal: options.signal,
		});
		return new BulkQueryJob(this._connection, info);
	}

	/** Attaches to an existing query job. */
	async queryJob<TRow = Record<string, string>>(
		id: string,
		options: { signal?: AbortSignal } = {},
	): Promise<BulkQueryJob<TRow>> {
		const info = await this._connection.request<BulkJobInfo>({
			path: `/jobs/query/${segment(id)}`,
			signal: options.signal,
		});
		return new BulkQueryJob<TRow>(this._connection, info);
	}

	/**
	 * Runs a query job, waits for it and yields every row (CSV values are strings).
	 *
	 * ```ts
	 * for await (const row of sf.bulk.query(sf.soql("Account").select("Id", "Name"))) { ... }
	 * ```
	 */
	query<K extends SObjectName<R>, S extends object = NoSelection>(
		query: SoqlQueryBuilder<R, K, S>,
		options?: BulkQueryOptions,
	): AsyncGenerator<BulkCsvRecord<SoqlQueryRecord<R, K, S>>, void, undefined>;
	query<TRow = Record<string, string>>(soql: string, options?: BulkQueryOptions): AsyncGenerator<TRow, void, undefined>;
	async *query(
		query: string | { build(): string; usesTypeOf?: boolean },
		options: BulkQueryOptions = {},
	): AsyncGenerator<unknown, void, undefined> {
		const job = await this.startQueryJob(query, options);
		await job.waitForCompletion(withSignal(options.wait ?? {}, options.signal));
		yield* job.records({ maxRecords: options.maxRecords, signal: options.signal });
	}
}

/** Wait options that abort on the call's signal as well as on the wait options' own signal. */
function withSignal(wait: WaitOptions, signal: AbortSignal | undefined): WaitOptions {
	const signals = [signal, wait.signal].filter((item): item is AbortSignal => item !== undefined);
	return { ...wait, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] };
}

async function waitForJob(
	job: { id: string; info: BulkJobInfo; refresh(options: { signal?: AbortSignal }): Promise<BulkJobInfo> },
	options: WaitOptions,
): Promise<BulkJobInfo> {
	const interval = options.pollIntervalMs ?? 2_000;
	const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
	for (;;) {
		const info = await job.refresh({ signal: options.signal });
		if (info.state === "JobComplete") {
			return info;
		}
		if (info.state === "Failed" || info.state === "Aborted") {
			throw new SalesforceBulkJobError(
				`Bulk job ${job.id} ended in state ${info.state}${info.errorMessage ? `: ${info.errorMessage}` : ""}`,
				job.id,
				info.state,
				info,
			);
		}
		if (Date.now() + interval > deadline) {
			throw new SalesforceBulkJobError(
				`Bulk job ${job.id} did not complete in time (state ${info.state}).`,
				job.id,
				info.state,
				info,
			);
		}
		await sleep(interval, options.signal);
	}
}
