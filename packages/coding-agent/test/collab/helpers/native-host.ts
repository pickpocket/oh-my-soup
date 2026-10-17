import { Settings } from "../../../src/config/settings";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { SessionManager } from "../../../src/session/session-manager";

export interface CapturedPrompt {
	content: unknown;
	details?: { from?: string };
}

export interface NativeHostHarness {
	ctx: InteractiveModeContext;
	manager: SessionManager;
	prompts: CapturedPrompt[];
	aborts: { count: number };
	prompted: Promise<CapturedPrompt>;
	interrupted: Promise<void>;
}

/** Real session storage; only the interactive UI and agent execution are doubles. */
export function makeNativeHostContext(cwd: string): NativeHostHarness {
	const manager = SessionManager.inMemory(cwd);
	const prompts: CapturedPrompt[] = [];
	const aborts = { count: 0 };
	const prompted = Promise.withResolvers<CapturedPrompt>();
	const interrupted = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({ "collab.displayName": "native-host" }),
		sessionManager: manager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "Native relay session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: async (message: CapturedPrompt) => {
				prompts.push(message);
				prompted.resolve(message);
				return true;
			},
			abort: async () => {
				aborts.count++;
				interrupted.resolve();
			},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, manager, prompts, aborts, prompted: prompted.promise, interrupted: interrupted.promise };
}
