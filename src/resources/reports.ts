import { type SalesforceConnection, segment, sleep } from "../http/connection";
import type {
	ReportDataCell,
	ReportDescribe,
	ReportFilter,
	ReportInstance,
	ReportMetadata,
	ReportResult,
	ReportSummary,
} from "../types/platform";

export interface RunReportOptions {
	/** Include detail rows (not just aggregates). Defaults to `true`. */
	includeDetails?: boolean;
	/** Override filters for this run (other metadata comes from the saved report). */
	filters?: ReportFilter[];
	/** Boolean filter logic for `filters`, e.g. `"1 AND (2 OR 3)"`. */
	booleanFilter?: string;
	signal?: AbortSignal;
}

export interface WaitForReportOptions {
	/** Delay between status checks. Defaults to 2 000 ms. */
	pollIntervalMs?: number;
	/** Give up after this many milliseconds. Defaults to 5 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** A detail row: detail column API name -> `{ label, value }`. */
export type ReportRow = Record<string, ReportDataCell>;

/**
 * Reports and Dashboards REST API (`/analytics/reports`). Synchronous runs return at most the
 * first 2 000 detail rows; the org allows 500 synchronous runs per hour.
 */
export class ReportsApi {
	constructor(private readonly _connection: SalesforceConnection) {}

	/** Recently viewed reports. */
	list(options: { signal?: AbortSignal } = {}): Promise<ReportSummary[]> {
		return this._connection.request({ path: "/analytics/reports", signal: options.signal });
	}

	describe(reportId: string, options: { signal?: AbortSignal } = {}): Promise<ReportDescribe> {
		return this._connection.request({ path: `${reportPath(reportId)}/describe`, signal: options.signal });
	}

	/** Runs a report synchronously. */
	run(reportId: string, options: RunReportOptions = {}): Promise<ReportResult> {
		const reportMetadata = runMetadata(options);
		return this._connection.request({
			method: reportMetadata ? "POST" : "GET",
			path: reportPath(reportId),
			query: { includeDetails: options.includeDetails ?? true },
			body: reportMetadata ? { reportMetadata } : undefined,
			signal: options.signal,
			timeoutMs: 0,
		});
	}

	/** Starts an asynchronous run; results stay available for 24 hours. */
	runAsync(reportId: string, options: RunReportOptions = {}): Promise<ReportInstance> {
		const reportMetadata = runMetadata(options);
		return this._connection.request({
			method: "POST",
			path: `${reportPath(reportId)}/instances`,
			query: { includeDetails: options.includeDetails ?? true },
			body: reportMetadata ? { reportMetadata } : {},
			signal: options.signal,
		});
	}

	/** Status (and, when finished, results) of an asynchronous run. */
	instance(
		reportId: string,
		instanceId: string,
		options: { signal?: AbortSignal } = {},
	): Promise<ReportResult & { attributes: { status?: ReportInstance["status"] } }> {
		return this._connection.request({
			path: `${reportPath(reportId)}/instances/${segment(instanceId)}`,
			signal: options.signal,
		});
	}

	/** Polls an asynchronous run until it succeeds, then returns the results. */
	async waitForInstance(
		reportId: string,
		instanceId: string,
		options: WaitForReportOptions = {},
	): Promise<ReportResult> {
		const interval = options.pollIntervalMs ?? 2_000;
		const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
		for (;;) {
			const result = await this.instance(reportId, instanceId, { signal: options.signal });
			const status = result.attributes.status;
			if (status === "Success") {
				return result;
			}
			if (status === "Error") {
				throw new Error(`Report run ${instanceId} of report ${reportId} failed.`);
			}
			if (Date.now() + interval > deadline) {
				throw new Error(`Report run ${instanceId} of report ${reportId} did not finish in time (status ${status}).`);
			}
			await sleep(interval, options.signal);
		}
	}

	/** Flattens detail rows of a report result; see `reportRows`. */
	toRows(result: ReportResult): ReportRow[] {
		return reportRows(result);
	}
}

/**
 * Flattens the detail rows of a report result into objects keyed by detail column API name
 * (e.g. `ACCOUNT.NAME`), each with the cell's `label` and `value`. Works for tabular, summary
 * and matrix reports; requires `includeDetails`.
 */
export function reportRows(result: ReportResult): ReportRow[] {
	const columns = result.reportMetadata.detailColumns;
	const rows: ReportRow[] = [];
	const downDepth = result.reportMetadata.groupingsDown?.length ?? 0;
	const acrossDepth = result.reportMetadata.groupingsAcross?.length ?? 0;
	for (const [key, fact] of Object.entries(result.factMap)) {
		// Only the deepest grouping cells hold each detail row once; totals and subtotals
		// ("T!T", "0!T" above "0_0!T", ...) would repeat them.
		const [down = "T", across = "T"] = key.split("!");
		if (!fact.rows || groupingDepth(down) !== downDepth || groupingDepth(across) !== acrossDepth) {
			continue;
		}
		for (const row of fact.rows) {
			const record: ReportRow = {};
			columns.forEach((column, index) => {
				const cell = row.dataCells[index];
				if (cell) {
					record[column] = cell;
				}
			});
			rows.push(record);
		}
	}
	return rows;
}

/** `"T"` is the total (depth 0); `"0"` is depth 1, `"0_2"` depth 2, ... */
function groupingDepth(key: string): number {
	return key === "T" ? 0 : key.split("_").length;
}

function runMetadata(options: RunReportOptions): Partial<ReportMetadata> | undefined {
	if (!options.filters && options.booleanFilter === undefined) {
		return undefined;
	}
	const metadata: Partial<ReportMetadata> = {};
	if (options.filters) {
		metadata.reportFilters = options.filters;
	}
	if (options.booleanFilter !== undefined) {
		metadata.reportBooleanFilter = options.booleanFilter;
	}
	return metadata;
}

function reportPath(reportId: string): string {
	if (typeof reportId !== "string" || !/^[A-Za-z0-9]{15,18}$/.test(reportId)) {
		throw new Error(`Invalid report id "${String(reportId)}".`);
	}
	return `/analytics/reports/${reportId}`;
}
