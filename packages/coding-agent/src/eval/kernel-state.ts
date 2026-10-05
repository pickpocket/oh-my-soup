/**
 * Post-compaction kernel-state probe: after a successful compaction, ask any
 * live eval kernel (Python subprocess, JS VM worker) which user-defined
 * top-level names survived, so the session can remind the model that kernel
 * state persisted through the history rewrite.
 *
 * Probes are best-effort and bounded: no live kernel, a dead kernel, a probe
 * error, and the timeout all mean "skip silently" — a wedged kernel must
 * never stall compaction recovery.
 */
import type { ToolSession } from "../tools";
import { resolveJsKernelIdentity } from "./js";
import { probeLiveVmGlobals } from "./js/context-manager";
import { resolvePythonKernelIdentity } from "./py";
import { type PythonKernelExecutor, peekLivePythonKernel } from "./py/executor";

/** Custom-message type for the LLM-visible post-compaction kernel notice. */
export const KERNEL_PERSISTED_MESSAGE_TYPE = "kernel-persisted";

/** Cap on the namespace probe so a wedged kernel can't stall recovery. */
const KERNEL_STATE_PROBE_TIMEOUT_MS = 5_000;

/** Cap on reported surviving names; the notice is a reminder, not an inventory. */
const KERNEL_STATE_NAME_LIMIT = 50;

const PY_NAME_MARKER = "\x00OMPNS\x00";
const PY_NAME_PROBE = `print(${JSON.stringify(PY_NAME_MARKER)} + __import__("json").dumps(__oms_list_new_globals__(${KERNEL_STATE_NAME_LIMIT})) + ${JSON.stringify(PY_NAME_MARKER)})`;

export interface KernelStateSnapshot {
	language: "Python" | "JavaScript";
	/** User-defined top-level names surviving in the kernel (bounded). */
	names: string[];
}

async function probePythonNames(kernel: PythonKernelExecutor, timeoutMs: number): Promise<string[] | null> {
	let out = "";
	const result = await kernel.execute(PY_NAME_PROBE, {
		timeoutMs,
		onChunk: text => {
			out += text;
		},
	});
	if (result.status !== "ok" || result.cancelled || result.timedOut) return null;
	const start = out.indexOf(PY_NAME_MARKER);
	const end = out.indexOf(PY_NAME_MARKER, start + PY_NAME_MARKER.length);
	if (start === -1 || end === -1) return null;
	try {
		const parsed: unknown = JSON.parse(out.slice(start + PY_NAME_MARKER.length, end));
		return Array.isArray(parsed) && parsed.every(name => typeof name === "string") ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Collect the surviving-namespace snapshot for every live eval kernel of one
 * agent session. Kernels that are absent, dead, or fail their bounded probe
 * are omitted — an empty array means "nothing to announce".
 */
export async function collectPostCompactionKernelState(session: ToolSession): Promise<KernelStateSnapshot[]> {
	const snapshots: KernelStateSnapshot[] = [];
	const pyKernel = peekLivePythonKernel(resolvePythonKernelIdentity(session));
	if (pyKernel) {
		const names = await probePythonNames(pyKernel, KERNEL_STATE_PROBE_TIMEOUT_MS).catch(() => null);
		if (names !== null) snapshots.push({ language: "Python", names });
	}
	const { sessionKey, ownerId } = resolveJsKernelIdentity(session);
	const jsNames = await probeLiveVmGlobals(
		sessionKey,
		KERNEL_STATE_PROBE_TIMEOUT_MS,
		KERNEL_STATE_NAME_LIMIT,
		ownerId,
	).catch(() => null);
	if (jsNames !== undefined && jsNames !== null) snapshots.push({ language: "JavaScript", names: jsNames });
	return snapshots;
}
