import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetadataCache } from "../src/cache";
import { share } from "../src/shared";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => undefined;
	let reject: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return { promise, resolve, reject };
}

/** A load that only settles when told to, and rejects with the abort reason when its signal aborts. */
function controllableLoad<T>(): {
	load: (signal: AbortSignal | undefined) => Promise<T>;
	signals: (AbortSignal | undefined)[];
	settle: Deferred<T>;
} {
	const settle = deferred<T>();
	const signals: (AbortSignal | undefined)[] = [];
	const load = (signal: AbortSignal | undefined): Promise<T> => {
		signals.push(signal);
		signal?.addEventListener("abort", () => settle.reject(signal.reason), { once: true });
		return settle.promise;
	};
	return { load, signals, settle };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("share", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};

	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("starts the load once and gives every caller the same result", async () => {
		const load = vi.fn<(signal: AbortSignal) => Promise<string>>(() => Promise.resolve("value"));
		const shared = share(load);
		const results = await Promise.all([
			shared.join(),
			shared.join(new AbortController().signal),
			shared.join(new AbortController().signal),
		]);
		expect(results).toEqual(["value", "value", "value"]);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("rejects only the caller whose signal aborted", async () => {
		const { load, signals, settle } = controllableLoad<string>();
		const shared = share(load);
		const first = new AbortController();
		const second = new AbortController();
		const firstCall = shared.join(first.signal);
		const secondCall = shared.join(second.signal);
		const thirdCall = shared.join(new AbortController().signal);

		first.abort(new Error("first gave up"));
		await expect(firstCall).rejects.toThrow("first gave up");
		expect(signals[0]?.aborted).toBe(false);

		settle.resolve("done");
		await expect(secondCall).resolves.toBe("done");
		await expect(thirdCall).resolves.toBe("done");
	});

	it("aborts the underlying load only once every caller has aborted", async () => {
		const { load, signals } = controllableLoad<string>();
		const shared = share(load);
		const first = new AbortController();
		const second = new AbortController();
		const firstCall = shared.join(first.signal);
		const secondCall = shared.join(second.signal);

		first.abort(new Error("one"));
		await expect(firstCall).rejects.toThrow("one");
		expect(signals[0]?.aborted).toBe(false);

		const reason = new Error("two");
		second.abort(reason);
		await expect(secondCall).rejects.toThrow("two");
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[0]?.reason).toBe(reason);
		await flush();
		expect(unhandled).toEqual([]);
	});

	it("never aborts the load while a caller without a signal is waiting", async () => {
		const { load, signals, settle } = controllableLoad<string>();
		const shared = share(load);
		const unsignalled = shared.join();
		const controller = new AbortController();
		const signalled = shared.join(controller.signal);
		controller.abort(new Error("stop"));
		await expect(signalled).rejects.toThrow("stop");
		expect(signals[0]?.aborted).toBe(false);
		settle.resolve("ok");
		await expect(unsignalled).resolves.toBe("ok");
	});

	it("rejects at once for an already aborted signal", async () => {
		const { load, signals } = controllableLoad<string>();
		const shared = share(load);
		await expect(shared.join(AbortSignal.abort(new Error("too late")))).rejects.toThrow("too late");
		expect(signals[0]?.aborted).toBe(true);
		await flush();
		expect(unhandled).toEqual([]);
	});

	it("passes a load failure to every waiting caller", async () => {
		const { load, settle } = controllableLoad<string>();
		const shared = share(load);
		const calls = [shared.join(), shared.join(new AbortController().signal)];
		settle.reject(new Error("load failed"));
		for (const call of calls) {
			await expect(call).rejects.toThrow("load failed");
		}
	});

	it("does not leave an unhandled rejection when the load fails after every caller left", async () => {
		const settle = deferred<string>();
		// This load ignores its signal and fails later on its own.
		const shared = share(() => settle.promise);
		const controller = new AbortController();
		const call = shared.join(controller.signal);
		controller.abort(new Error("left"));
		await expect(call).rejects.toThrow("left");
		settle.reject(new Error("late failure"));
		await flush();
		expect(unhandled).toEqual([]);
	});

	it("removes its abort listener once the load settles", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const shared = share(() => Promise.resolve(1));
		await expect(shared.join(controller.signal)).resolves.toBe(1);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		// Aborting afterwards has no effect on the settled call.
		controller.abort(new Error("after"));
		await flush();
		expect(unhandled).toEqual([]);
	});
});

describe("MetadataCache", () => {
	it("shares one load between concurrent callers and caches the result", async () => {
		const cache = new MetadataCache();
		const load = vi.fn<(signal: AbortSignal | undefined) => Promise<string>>(() => Promise.resolve("describe"));
		const results = await Promise.all([cache.getOrLoad("Account", load), cache.getOrLoad("Account", load)]);
		expect(results).toEqual(["describe", "describe"]);
		expect(await cache.getOrLoad("Account", load)).toBe("describe");
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("gives the load its own signal, not the caller's", async () => {
		const cache = new MetadataCache();
		const caller = new AbortController();
		const signals: (AbortSignal | undefined)[] = [];
		await cache.getOrLoad(
			"k",
			(signal) => {
				signals.push(signal);
				return Promise.resolve(1);
			},
			caller.signal,
		);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[0]).not.toBe(caller.signal);
	});

	it("lets one caller abort without breaking the others that share the load", async () => {
		const cache = new MetadataCache();
		const { load, signals, settle } = controllableLoad<string>();
		const first = new AbortController();
		const firstCall = cache.getOrLoad("Account", load, first.signal);
		const secondCall = cache.getOrLoad("Account", load, new AbortController().signal);

		first.abort(new Error("first gave up"));
		await expect(firstCall).rejects.toThrow("first gave up");
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);

		settle.resolve("describe");
		await expect(secondCall).resolves.toBe("describe");
		// The value stays cached for later callers.
		await expect(cache.getOrLoad("Account", () => Promise.resolve("other"))).resolves.toBe("describe");
	});

	it("cancels the load and evicts the entry when every caller aborted", async () => {
		const cache = new MetadataCache();
		const { load, signals } = controllableLoad<string>();
		const controller = new AbortController();
		const call = cache.getOrLoad("Account", load, controller.signal);
		controller.abort(new Error("stop"));
		await expect(call).rejects.toThrow("stop");
		expect(signals[0]?.aborted).toBe(true);
		await flush();
		await expect(cache.getOrLoad("Account", () => Promise.resolve("fresh"))).resolves.toBe("fresh");
	});

	it("starts a fresh load for a caller arriving right after every other caller aborted", async () => {
		const cache = new MetadataCache();
		const { load } = controllableLoad<string>();
		const controller = new AbortController();
		const call = cache.getOrLoad("Account", load, controller.signal);
		controller.abort(new Error("stop"));
		// Same tick: the abandoned load has not rejected yet, so it is still in the cache.
		const fresh = cache.getOrLoad("Account", () => Promise.resolve("fresh"));
		await expect(call).rejects.toThrow("stop");
		await expect(fresh).resolves.toBe("fresh");
		await flush();
		await expect(cache.getOrLoad("Account", () => Promise.resolve("other"))).resolves.toBe("fresh");
	});

	it("does not cache a failed load, so the next call retries", async () => {
		const cache = new MetadataCache();
		const load = vi
			.fn<(signal: AbortSignal | undefined) => Promise<string>>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce("second try");
		await expect(cache.getOrLoad("Account", load)).rejects.toThrow("boom");
		await flush();
		await expect(cache.getOrLoad("Account", load)).resolves.toBe("second try");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not let an old failed load evict a newer entry after clear()", async () => {
		const cache = new MetadataCache();
		const old = deferred<string>();
		const oldCall = cache.getOrLoad("k", () => old.promise);
		cache.clear("k");
		await expect(cache.getOrLoad("k", () => Promise.resolve("new"))).resolves.toBe("new");
		old.reject(new Error("old failure"));
		await expect(oldCall).rejects.toThrow("old failure");
		await flush();
		const load = vi.fn<(signal: AbortSignal | undefined) => Promise<string>>(() => Promise.resolve("reloaded"));
		await expect(cache.getOrLoad("k", load)).resolves.toBe("new");
		expect(load).not.toHaveBeenCalled();
	});

	it("passes the caller's signal straight through when disabled", async () => {
		const cache = new MetadataCache(false);
		const controller = new AbortController();
		const load = vi.fn<(signal: AbortSignal | undefined) => Promise<number>>(() => Promise.resolve(1));
		await cache.getOrLoad("k", load, controller.signal);
		await cache.getOrLoad("k", load, controller.signal);
		expect(load).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenCalledWith(controller.signal);
	});
});
