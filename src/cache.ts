import { share, type SharedRequest } from "./shared";

/**
 * An in-memory cache for metadata calls (describe, UI API object info, record type ids).
 * Concurrent callers share one in-flight request, each waiting with its own abort signal;
 * failed loads are not cached.
 */
export class MetadataCache {
	private readonly _entries = new Map<string, SharedRequest<unknown>>();

	constructor(private readonly _enabled: boolean = true) {}

	/**
	 * Returns the cached value for `key`, or loads (and caches) it. `load` receives a signal of
	 * its own: aborting `signal` only stops this caller from waiting.
	 */
	getOrLoad<T>(key: string, load: (signal: AbortSignal | undefined) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!this._enabled) {
			return load(signal);
		}
		let entry = this._entries.get(key) as SharedRequest<T> | undefined;
		if (!entry || entry.abandoned) {
			const created = share<T>((ownSignal) => load(ownSignal));
			this._entries.set(key, created);
			created.promise.catch(() => {
				// Only drop this entry; a newer one may have replaced it after clear().
				if (this._entries.get(key) === created) {
					this._entries.delete(key);
				}
			});
			entry = created;
		}
		return entry.join(signal);
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
