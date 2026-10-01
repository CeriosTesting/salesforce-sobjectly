/**
 * A request that several callers share. Each caller waits with its own `AbortSignal`: an abort
 * only rejects that caller, and the underlying request is cancelled once every caller has gone.
 */
export interface SharedRequest<T> {
	readonly promise: Promise<T>;
	/**
	 * `true` once every caller has aborted and the request was cancelled. Don't join it any more:
	 * start a new one (it may not have rejected yet, so it can still be in a cache).
	 */
	readonly abandoned: boolean;
	/** Waits for the shared result, giving up when `signal` aborts. */
	join(signal?: AbortSignal): Promise<T>;
}

/** Starts `load` with a signal of its own and returns a handle callers can `join`. */
export function share<T>(load: (signal: AbortSignal) => Promise<T>): SharedRequest<T> {
	const controller = new AbortController();
	let waiters = 0;
	const promise = load(controller.signal);
	// Every caller may have left; don't let a late rejection go unhandled.
	promise.catch(() => undefined);

	return {
		promise,
		get abandoned(): boolean {
			return controller.signal.aborted;
		},
		join(signal?: AbortSignal): Promise<T> {
			waiters++;
			if (!signal) {
				return promise;
			}
			return new Promise<T>((resolve, reject) => {
				const leave = (): void => {
					signal.removeEventListener("abort", onAbort);
				};
				const onAbort = (): void => {
					leave();
					waiters--;
					if (waiters === 0) {
						controller.abort(signal.reason);
					}
					reject(signal.reason as Error);
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				void promise.then(
					(value) => {
						leave();
						resolve(value);
					},
					(error: unknown) => {
						leave();
						reject(error);
					},
				);
			});
		},
	};
}
