import { emit, SharedLog, type SalesforceLogger } from "./logging";
import { share, type SharedRequest } from "./shared";

interface CacheEntry {
	request: SharedRequest<unknown>;
	/** The load's log, shared by every caller waiting for it. */
	log: SharedLog;
}

/**
 * An in-memory cache for metadata calls (describe, UI API object info, record type ids).
 * Concurrent callers share one in-flight request, each waiting with its own abort signal;
 * failed loads are not cached.
 */
export class MetadataCache {
	private _entries = new Map<string, CacheEntry>();

	/** With a `logger`, every lookup is logged as `cache.hit` or `cache.miss` (`debug`). */
	constructor(
		private readonly _enabled: boolean = true,
		private readonly _logger?: SalesforceLogger,
	) {}

	/**
	 * A cache that shares this one's entries but logs to `logger`, e.g. for a client view with
	 * another log setting.
	 */
	withLogger(logger: SalesforceLogger | undefined): MetadataCache {
		const view = new MetadataCache(this._enabled, logger);
		view._entries = this._entries;
		return view;
	}

	/**
	 * Returns the cached value for `key`, or loads (and caches) it. `load` receives a signal of
	 * its own: aborting `signal` only stops this caller from waiting. It also receives the logger
	 * to log the load to: every caller waiting for the load gets its entries.
	 */
	getOrLoad<T>(
		key: string,
		load: (signal: AbortSignal | undefined, logger: SalesforceLogger | undefined) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		if (!this._enabled) {
			return load(signal, this._logger);
		}
		let entry = this._entries.get(key);
		const hit = entry !== undefined && !entry.request.abandoned;
		emit(this._logger, "debug", `Metadata cache ${hit ? "hit" : "miss"}: ${key}`, {
			type: hit ? "cache.hit" : "cache.miss",
			key,
		});
		if (!entry || entry.request.abandoned) {
			const log = new SharedLog();
			const created: CacheEntry = { request: share<unknown>((ownSignal) => load(ownSignal, log)), log };
			this._entries.set(key, created);
			created.request.promise
				.finally(() => log.close())
				.catch(() => {
					// Only drop this entry; a newer one may have replaced it after clear().
					if (this._entries.get(key) === created) {
						this._entries.delete(key);
					}
				});
			entry = created;
		}
		entry.log.join(this._logger);
		return entry.request.join(signal) as Promise<T>;
	}

	/** Removes one entry, or every entry when `key` is omitted. */
	clear(key?: string): void {
		if (key === undefined) {
			this._entries.clear();
		} else {
			this._entries.delete(key);
		}
	}
}
