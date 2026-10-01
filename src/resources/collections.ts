import { runChunks, SalesforceSaveError } from "../errors";
import { type SalesforceConnection, segment } from "../http/connection";
import type {
	ExternalIdField,
	SObjectCreateInput,
	SObjectFieldName,
	SObjectName,
	SObjectRecord,
	SObjectUpdateInput,
} from "../registry";
import type { DeleteResult, SaveResult, UpsertResult, WithAttributes } from "../types/common";

const MAX_RECORDS = 200;
const MAX_RETRIEVE_IDS = 2000;

export interface CollectionOptions {
	/** Roll back the whole call when one record fails. */
	allOrNone?: boolean;
	/** Throw a `SalesforceSaveError` when any record failed. Defaults to `true`. */
	throwOnError?: boolean;
	/**
	 * Split more than 200 records into several sequential calls. Each call is its own
	 * transaction, so this cannot be combined with `allOrNone`.
	 */
	chunk?: boolean;
	signal?: AbortSignal;
}

/** sObject Collections (`/composite/sobjects`): create, update, upsert, delete and retrieve up to 200 records per call. */
export class CollectionsApi<R extends object> {
	constructor(private readonly _connection: SalesforceConnection) {}

	create<K extends SObjectName<R>>(
		sobject: K,
		records: readonly SObjectCreateInput<R, K>[],
		options: CollectionOptions = {},
	): Promise<SaveResult[]> {
		return this.save("POST", "/composite/sobjects", sobject, records, options, "Creating");
	}

	/** Updates records; every record needs its `Id`. */
	update<K extends SObjectName<R>>(
		sobject: K,
		records: readonly (SObjectUpdateInput<R, K> & { Id: string })[],
		options: CollectionOptions = {},
	): Promise<SaveResult[]> {
		return this.save("PATCH", "/composite/sobjects", sobject, records, options, "Updating");
	}

	/** Upserts records of one sObject by external id. Every record needs the external id field. */
	upsert<K extends SObjectName<R>, F extends ExternalIdField<R, K>>(
		sobject: K,
		externalIdField: F,
		records: readonly SObjectCreateInput<R, K>[],
		options: CollectionOptions = {},
	): Promise<UpsertResult[]> {
		return this.save(
			"PATCH",
			`/composite/sobjects/${segment(sobject)}/${segment(externalIdField)}`,
			sobject,
			records,
			options,
			"Upserting",
		);
	}

	/** Deletes records by id (they may be of different sObjects). */
	async delete(ids: readonly string[], options: CollectionOptions = {}): Promise<DeleteResult[]> {
		const results = await runChunks(
			chunks(ids, MAX_RECORDS, options),
			(chunk) =>
				this._connection.request<DeleteResult[]>({
					method: "DELETE",
					path: "/composite/sobjects",
					query: { ids: chunk, allOrNone: options.allOrNone },
					signal: options.signal,
				}),
			"Deleting records failed",
		);
		assertSuccess("Deleting records", results, options);
		return results;
	}

	/** Retrieves records by id with the given fields. Inaccessible or unknown ids yield `null`. */
	async retrieve<K extends SObjectName<R>, F extends SObjectFieldName<R, K>>(
		sobject: K,
		ids: readonly string[],
		fields: readonly F[],
		options: { signal?: AbortSignal } = {},
	): Promise<(WithAttributes<Pick<SObjectRecord<R, K>, F>> | null)[]> {
		if (fields.length === 0) {
			throw new Error("retrieve() requires at least one field.");
		}
		const results: (WithAttributes<Pick<SObjectRecord<R, K>, F>> | null)[] = [];
		for (const chunk of chunks(ids, MAX_RETRIEVE_IDS, { chunk: true })) {
			results.push(
				...(await this._connection.request<(WithAttributes<Pick<SObjectRecord<R, K>, F>> | null)[]>({
					method: "POST",
					path: `/composite/sobjects/${segment(sobject)}`,
					body: { ids: chunk, fields },
					signal: options.signal,
				})),
			);
		}
		return results;
	}

	private async save<T extends SaveResult>(
		method: "POST" | "PATCH",
		path: string,
		sobject: string,
		records: readonly object[],
		options: CollectionOptions,
		verb: string,
	): Promise<T[]> {
		const results = await runChunks(
			chunks(records, MAX_RECORDS, options),
			(chunk) => {
				const body = {
					allOrNone: options.allOrNone ?? false,
					records: chunk.map((record) => ({ attributes: { type: sobject }, ...record })),
				};
				return this._connection.request<T[]>({ method, path, body, signal: options.signal });
			},
			`${verb} ${sobject} records failed`,
		);
		assertSuccess(`${verb} ${sobject} records`, results, options);
		return results;
	}
}

function chunks<T>(items: readonly T[], size: number, options: Pick<CollectionOptions, "chunk" | "allOrNone">): T[][] {
	if (items.length === 0) {
		throw new Error("At least one record or id is required.");
	}
	if (items.length > size && !options.chunk) {
		throw new Error(
			`sObject collections accept at most ${size} items per call, got ${items.length}. Pass { chunk: true } or use the Bulk API.`,
		);
	}
	if (items.length > size && options.allOrNone) {
		throw new Error("allOrNone cannot be guaranteed across chunks. Send at most 200 records or drop allOrNone.");
	}
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		result.push(items.slice(index, index + size));
	}
	return result;
}

function assertSuccess<T extends SaveResult>(message: string, results: T[], options: CollectionOptions): void {
	if (options.throwOnError === false) {
		return;
	}
	const failed = results.filter((result) => !result.success);
	if (failed.length > 0) {
		throw new SalesforceSaveError(
			`${message} failed for ${failed.length} of ${results.length} item(s)`,
			results,
			failed.flatMap((result) => result.errors),
		);
	}
}
