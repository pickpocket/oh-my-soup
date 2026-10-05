import type { AgentSession } from "@oh-my-soup/pi-coding-agent/session/agent-session";
import { untilAborted } from "@oh-my-soup/pi-utils";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		baseSystemPrompt: [],
		runToolRegistryMutation: <T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
			untilAborted(signal, mutation),
		setActiveToolsByName: async (_toolNames: string[]) => {},
		setActiveToolPresentation: async (_toolNames: string[], _mountedToolNames: string[]) => {},
		getMountedXdevToolNames: (): string[] => [],
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
	} satisfies Partial<AgentSession>;
}
