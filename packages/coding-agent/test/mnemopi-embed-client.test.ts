import { afterEach, describe, expect, it, vi } from "bun:test";
import { MnemopiEmbedClient } from "@oh-my-soup/pi-coding-agent/mnemopi/embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "@oh-my-soup/pi-coding-agent/mnemopi/embed-protocol";
import type { MnemopiEmbedWorkerHandle } from "@oh-my-soup/pi-coding-agent/mnemopi/embed-client";

interface FakeWorker extends MnemopiEmbedWorkerHandle {
	sent: MnemopiEmbedWorkerInbound[];
	terminated: number;
	deliver(message: MnemopiEmbedWorkerOutbound): void;
}

function fakeWorker(): FakeWorker {
	let handler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
	const handle: FakeWorker = {
		sent: [],
		terminated: 0,
		send(message) {
			handle.sent.push(message);
		},
		onMessage(fn) {
			handler = fn;
			return () => {
				handler = undefined;
			};
		},
		onError() {
			return () => { };
		},
		async terminate() {
			handle.terminated++;
		},
		ref() { },
		unref() { },
		deliver(message) {
			handler?.(message);
		},
	};
	return handle;
}

/** Collect `model.embed` output. Iteration drives the request lazily. */
async function collect(iterable: AsyncIterable<number[][]>): Promise<number[][]> {
	const batches: number[][] = [];
	for await (const batch of iterable) batches.push(...batch);
	return batches;
}

describe("mnemopi embed client idle teardown", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("tears the subprocess down after the idle window and respawns on the next embed", async () => {
		vi.useFakeTimers();
		const workers: FakeWorker[] = [];
		let spawns = 0;
		const client = new MnemopiEmbedClient(() => {
			spawns++;
			const worker = fakeWorker();
			workers.push(worker);
			return worker;
		}, 5_000, 40);
		const initPromise = client.initialize("bge-test", undefined);
		workers[0].deliver({ type: "ready", id: workers[0].sent[0].id });
		const model = await initPromise;
		if (!model) throw new Error("initialize failed");

		// Nothing in flight: the idle window expires and the ~1.2 GB subprocess
		// is released instead of pinning memory for the session lifetime.
		vi.advanceTimersByTime(40);
		await Promise.resolve();
		expect(workers[0].terminated).toBe(1);

		// The next embed respawns a fresh subprocess instead of failing on the
		// dead handle.
		const embedPromise = collect(model.embed(["hello"]));
		await Promise.resolve();
		expect(spawns).toBe(2);
		const embedWorker = workers[1];
		embedWorker.deliver({ type: "vectors", id: embedWorker.sent.at(-1)!.id, vectors: [[0.1, 0.2]] });
		expect(await embedPromise).toEqual([[0.1, 0.2]]);
		await client.terminate();
	});

	it("keeps the subprocess alive when the idle teardown is disabled", async () => {
		vi.useFakeTimers();
		const workers: FakeWorker[] = [];
		const client = new MnemopiEmbedClient(() => {
			const worker = fakeWorker();
			workers.push(worker);
			return worker;
		}, 5_000, 0);
		const initPromise = client.initialize("bge-test", undefined);
		workers[0].deliver({ type: "ready", id: workers[0].sent[0].id });
		const model = await initPromise;
		if (!model) throw new Error("initialize failed");
		vi.advanceTimersByTime(600_000);
		await Promise.resolve();
		expect(workers[0].terminated).toBe(0);
		await client.terminate();
	});

	it("does not tear the subprocess down while a request is in flight", async () => {
		vi.useFakeTimers();
		const workers: FakeWorker[] = [];
		let spawns = 0;
		const client = new MnemopiEmbedClient(() => {
			spawns++;
			const worker = fakeWorker();
			workers.push(worker);
			return worker;
		}, 5_000, 40);
		const initPromise = client.initialize("bge-test", undefined);
		workers[0].deliver({ type: "ready", id: workers[0].sent[0].id });
		const model = await initPromise;
		if (!model) throw new Error("initialize failed");

		// The embed is in flight past the idle window: the teardown must wait.
		const embedPromise = collect(model.embed(["busy"]));
		await Promise.resolve();
		vi.advanceTimersByTime(400);
		await Promise.resolve();
		expect(workers[0].terminated).toBe(0);
		expect(spawns).toBe(1);
		workers[0].deliver({ type: "vectors", id: workers[0].sent.at(-1)!.id, vectors: [[1]] });
		expect(await embedPromise).toEqual([[1]]);
		await client.terminate();
	});

	it("arms the teardown after configure with a new idle window", async () => {
		vi.useFakeTimers();
		const workers: FakeWorker[] = [];
		const client = new MnemopiEmbedClient(() => {
			const worker = fakeWorker();
			workers.push(worker);
			return worker;
		}, 5_000, 0);
		const initPromise = client.initialize("bge-test", undefined);
		workers[0].deliver({ type: "ready", id: workers[0].sent[0].id });
		const model = await initPromise;
		if (!model) throw new Error("initialize failed");
		client.configure({ idleExitMs: 40 });
		vi.advanceTimersByTime(40);
		await Promise.resolve();
		expect(workers[0].terminated).toBe(1);
		await client.terminate();
	});
});
