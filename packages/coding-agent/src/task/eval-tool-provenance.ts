// Keep provenance independent of the eval runtimes: thread service registration reads it
// before the executor and its kernel integrations have finished initializing.
const evalToolSources = new WeakMap<object, string>();

/** A process-local retained-kernel identity, never a replaceable same-name host capability. */
export function getEvalToolSource(tool: object): string | undefined {
	return evalToolSources.get(tool);
}

/** Register local or trusted worker-codec provenance, never an arbitrary tool property. */
export function registerEvalToolSource(tool: object, source: string): void {
	evalToolSources.set(tool, source);
}
