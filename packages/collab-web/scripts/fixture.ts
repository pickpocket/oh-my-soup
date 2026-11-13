/**
 * Canned session data for the offline collab harness.
 *
 * One realistic host session (header + ~14 entries covering every renderer
 * branch), an agent registry (main + a running sub with ticking progress + a
 * parked sub with a transcript), a subagent transcript JSONL blob, and a
 * scripted streaming turn the mock host replays on every guest prompt. The
 * `makeLong*` generators build a long session and a large subagent transcript
 * for exercising transcript paging by hand (`mock-host --long`).
 */
import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	SessionEntry,
	SessionHeader,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	ToolCallContent,
	ToolResultMessage,
	WireModel,
	WireUsage,
} from "@oh-my-soup/pi-wire";

export const HOST_DISPLAY_NAME = "kai";

export const fixtureModel: WireModel = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	provider: "anthropic",
	contextWindow: 200_000,
};

const NOW = Date.now();
const MIN = 60_000;

function iso(tsMs: number): string {
	return new Date(tsMs).toISOString();
}

function mkUsage(input: number, output: number, cacheRead: number, cost: number): WireUsage {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } };
}

export const fixtureHeader: SessionHeader = {
	type: "session",
	id: "mock-collab-session",
	title: "relay reconnect audit",
	timestamp: iso(NOW - 32 * MIN),
	cwd: "/Users/kai/Projects/pi",
};

const ASSISTANT_AUDIT_TEXT = `## Reconnect audit

Three things to verify before touching anything:

- backoff window (1s → 30s, exponential)
- fatal close codes that must *never* retry
- the resync \`hello\` → \`welcome\` handshake on reopen

\`\`\`ts
const FATAL = new Set([4001, 4004, 4009, 4029]);
const delay = Math.min(1000 * 2 ** attempt, 30_000);
\`\`\`

Checking the actual implementation now.`;

export const fixtureEntries: SessionEntry[] = [
	{
		id: "e01",
		parentId: null,
		timestamp: iso(NOW - 31 * MIN),
		type: "message",
		message: {
			role: "user",
			content:
				"the guest socket sometimes stays dead after a relay redeploy — can you audit the reconnect path in relay-client.ts?",
			timestamp: NOW - 31 * MIN,
		},
	},
	{
		id: "e02",
		parentId: "e01",
		timestamp: iso(NOW - 30 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking:
						"Reconnect semantics live in two places: the backoff loop in relay-client.ts and the fatal close codes in protocol.ts. I should read both before claiming anything — a redeploy closes with 1001, which must be treated as transient.",
				},
				{ type: "text", text: ASSISTANT_AUDIT_TEXT },
				{
					type: "toolCall",
					id: "call-bash-01",
					name: "bash",
					arguments: { command: 'rg -n "BACKOFF|MAX_PENDING" packages/coding-agent/src/collab/relay-client.ts' },
					intent: "Checking backoff constants",
				},
				{
					type: "toolCall",
					id: "call-read-01",
					name: "read",
					arguments: { path: "packages/coding-agent/src/collab/relay-clinet.ts", offset: 160, limit: 60 },
					intent: "Reading the close handler",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(2_410, 386, 18_200, 0.0119),
			stopReason: "toolUse",
			timestamp: NOW - 30 * MIN,
		},
	},
	{
		id: "e03",
		parentId: "e02",
		timestamp: iso(NOW - 30 * MIN + 4_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-bash-01",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: "20:const BACKOFF_BASE_MS = 1_000;\n21:const BACKOFF_MAX_MS = 30_000;\n23:const MAX_PENDING_SENDS = 256;",
				},
			],
			isError: false,
			timestamp: NOW - 30 * MIN + 4_000,
		},
	},
	{
		id: "e04",
		parentId: "e03",
		timestamp: iso(NOW - 30 * MIN + 5_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-read-01",
			toolName: "read",
			content: [
				{
					type: "text",
					text: "ENOENT: no such file or directory\n  open 'packages/coding-agent/src/collab/relay-clinet.ts'\n    at open (node:internal/fs/promises:642:23)\n    at readRange (src/tools/read.ts:88:9)",
				},
			],
			isError: true,
			timestamp: NOW - 30 * MIN + 5_000,
		},
	},
	{
		id: "e05",
		parentId: "e04",
		timestamp: iso(NOW - 29 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Typo on my end — the file is `relay-client.ts`. The backoff constants match the spec (1s base, 30s cap, 256-frame reconnect buffer); reading the close handler next.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_080, 64, 20_540, 0.0124),
			stopReason: "stop",
			timestamp: NOW - 29 * MIN,
		},
	},
	{
		id: "e06",
		parentId: "e05",
		timestamp: iso(NOW - 26 * MIN),
		type: "message",
		message: {
			role: "user",
			content: "what about half-open sockets after a NAT rebind? do we ping at all?",
			timestamp: NOW - 26 * MIN,
		},
	},
	{
		id: "e07",
		parentId: "e06",
		timestamp: iso(NOW - 25 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "The relay sends protocol-level pings, so a half-open socket dies within the idle window and lands in the normal close path. From there the client splits three ways:\n\n- transient drop → exponential retry, fresh `hello` on reopen\n- fatal close code (4001/4004/4009/4029) → surface the reason, stay down\n- decrypt failure → treated as fatal, since the key cannot heal",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_420, 142, 21_900, 0.0131),
			stopReason: "stop",
			timestamp: NOW - 25 * MIN,
		},
	},
	{
		id: "e08",
		parentId: "e07",
		timestamp: iso(NOW - 21 * MIN),
		type: "custom_message",
		customType: "collab-prompt",
		content:
			"also verify the relay drops the send buffer past 256 frames — we saw memory creep on a 6h session last week",
		details: { from: "ada" },
		display: true,
	},
	{
		id: "e09",
		parentId: "e08",
		timestamp: iso(NOW - 20 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Good catch ada — `MAX_PENDING_SENDS` caps the reconnect buffer at 256 sealed envelopes and overflow is dropped (debug-logged), so no unbounded growth. The cost is silent frame loss, which the `welcome` resync on reopen covers.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(3_900, 98, 23_400, 0.0138),
			stopReason: "stop",
			timestamp: NOW - 20 * MIN,
		},
	},
	{
		id: "e09-legacy-call",
		parentId: "e09",
		timestamp: iso(NOW - 19 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Legacy transcript aliases should still render for old saved sessions." },
				{
					type: "toolCall",
					id: "legacy-search-01",
					name: "search",
					arguments: { pattern: "relay", paths: ["docs/collab.md"] },
					intent: "Legacy search alias sample",
				},
				{
					type: "toolCall",
					id: "legacy-find-01",
					name: "find",
					arguments: { paths: ["docs/**/*.md"] },
					intent: "Legacy find alias sample",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(4_020, 54, 23_500, 0.014),
			stopReason: "toolUse",
			timestamp: NOW - 19 * MIN,
		},
	},
	{
		id: "e09-legacy-search-result",
		parentId: "e09-legacy-call",
		timestamp: iso(NOW - 19 * MIN + 1_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "legacy-search-01",
			toolName: "search",
			content: [{ type: "text", text: "docs/collab.md:12:relay reconnect notes" }],
			isError: false,
			timestamp: NOW - 19 * MIN + 1_000,
		},
	},
	{
		id: "e09-legacy-find-result",
		parentId: "e09-legacy-call",
		timestamp: iso(NOW - 19 * MIN + 1_500),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "legacy-find-01",
			toolName: "find",
			content: [{ type: "text", text: "docs/collab.md\ndocs/collab-protocol.md" }],
			isError: false,
			timestamp: NOW - 19 * MIN + 1_500,
		},
	},
	{
		id: "e10",
		parentId: "e09",
		timestamp: iso(NOW - 14 * MIN),
		type: "compaction",
		summary:
			"Audited the collab reconnect path: exponential backoff 1s→30s confirmed; fatal close codes 4001/4004/4009/4029 never retry; decrypt failures are terminal; the reconnect buffer is capped at 256 sealed frames with drop-on-overflow, recovered by the welcome resync. Open question: ping cadence on idle relays behind aggressive NATs.",
		shortSummary: "reconnect audit findings",
		firstKeptEntryId: "e08",
		tokensBefore: 48_213,
	},
	{
		id: "e11",
		parentId: "e10",
		timestamp: iso(NOW - 13 * MIN),
		type: "model_change",
		model: fixtureModel.id,
	},
	{
		id: "e12",
		parentId: "e11",
		timestamp: iso(NOW - 13 * MIN + 5_000),
		type: "thinking_level_change",
		thinkingLevel: "medium",
	},
	{
		id: "e13",
		parentId: "e12",
		timestamp: iso(NOW - 9 * MIN),
		type: "message",
		message: {
			role: "user",
			content: "summarize what changed and what's left",
			timestamp: NOW - 9 * MIN,
		},
	},
	{
		id: "e14",
		parentId: "e13",
		timestamp: iso(NOW - 8 * MIN),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Done: backoff window verified, fatal-code table cross-checked against the relay, buffer cap documented. Left: an integration test that kills the relay mid-stream and asserts the guest resyncs from `welcome` without duplicated entries — RelayProbe is running that now, DocSweep already swept the docs.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(12_640, 187, 31_780, 0.0212),
			stopReason: "stop",
			timestamp: NOW - 8 * MIN,
		},
	},
];

// ─── agents ──────────────────────────────────────────────────────────────────

export const fixtureAgents: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 32 * MIN,
		lastActivity: NOW - 5_000,
	},
	// Top-level coordinator subagent with 8 children + 1 grandchild
	{
		id: "RelayProbe",
		displayName: "task",
		kind: "sub",
		parentId: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 8 * MIN,
		lastActivity: NOW - 2_000,
	},
	{
		id: "ProtocolVerify",
		displayName: "task",
		kind: "sub",
		parentId: "main",
		status: "idle",
		hasSessionFile: true,
		createdAt: NOW - 12 * MIN,
		lastActivity: NOW - 90_000,
	},
	{
		id: "DocSweep",
		displayName: "scout",
		kind: "sub",
		parentId: "main",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 25 * MIN,
		lastActivity: NOW - 11 * MIN,
	},
	{
		id: "LegacyFrameFuzzer",
		displayName: "task",
		kind: "sub",
		parentId: "main",
		status: "aborted",
		hasSessionFile: true,
		createdAt: NOW - 22 * MIN,
		lastActivity: NOW - 18 * MIN,
	},
	{
		id: "ColdArchiveAudit",
		displayName: "task",
		kind: "sub",
		parentId: "main",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 30 * MIN,
		lastActivity: NOW - 27 * MIN,
	},
	// 8 children spawned by RelayProbe
	{
		id: "RelayProbe.KevlarLookups",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN,
		lastActivity: NOW - 1_500,
	},
	{
		id: "RelayProbe.CrtExact",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 2_000,
		lastActivity: NOW - 1_800,
	},
	{
		id: "RelayProbe.FrameBoundaryChecksumVerification",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 4_000,
		lastActivity: NOW - 1_200,
	},
	{
		id: "RelayProbe.TimeOrigin",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "idle",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 6_000,
		lastActivity: NOW - 45_000,
	},
	{
		id: "RelayProbe.NatHalfOpenSweep",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 8_000,
		lastActivity: NOW - 3 * MIN,
	},
	{
		id: "RelayProbe.SendBufferCap",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 10_000,
		lastActivity: NOW - 4 * MIN,
	},
	{
		id: "RelayProbe.DecryptKeyHeal",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "parked",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 12_000,
		lastActivity: NOW - 5 * MIN,
	},
	{
		id: "RelayProbe.CloseCodeTable",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe",
		status: "aborted",
		hasSessionFile: true,
		createdAt: NOW - 7 * MIN + 14_000,
		lastActivity: NOW - 5 * MIN + 15_000,
	},
	// Grandchild (depth 2) spawned by KevlarLookups
	{
		id: "RelayProbe.KevlarLookups.WindowDriftCheck",
		displayName: "task",
		kind: "sub",
		parentId: "RelayProbe.KevlarLookups",
		status: "running",
		hasSessionFile: true,
		createdAt: NOW - 4 * MIN,
		lastActivity: NOW - 900,
	},
];

export const fixtureLifecycle: readonly SubagentLifecyclePayload[] = [
	{
		id: "RelayProbe",
		agent: "task",
		description: "relay reconnect coordinator",
		status: "started",
		sessionFile: "/tmp/oms/agents/RelayProbe.jsonl",
		index: 0,
	},
	{
		id: "DocSweep",
		agent: "scout",
		description: "sweep close-code docs",
		status: "completed",
		sessionFile: "/tmp/oms/agents/DocSweep.jsonl",
		index: 1,
	},
	{
		id: "LegacyFrameFuzzer",
		agent: "task",
		description: "fuzz legacy sealed frames",
		status: "aborted",
		sessionFile: "/tmp/oms/agents/LegacyFrameFuzzer.jsonl",
		index: 2,
	},
	{
		id: "RelayProbe.KevlarLookups",
		agent: "task",
		description: "lookup table stress test",
		status: "started",
		sessionFile: "/tmp/oms/agents/RelayProbe.KevlarLookups.jsonl",
		index: 0,
	},
	{
		id: "RelayProbe.CrtExact",
		agent: "scout",
		description: "verify exact retry backoff bounds",
		status: "started",
		sessionFile: "/tmp/oms/agents/RelayProbe.CrtExact.jsonl",
		index: 1,
	},
	{
		id: "RelayProbe.FrameBoundaryChecksumVerification",
		agent: "task",
		description: "verify multi-chunk frame boundary checksums",
		status: "started",
		sessionFile: "/tmp/oms/agents/RelayProbe.FrameBoundaryChecksumVerification.jsonl",
		index: 2,
	},
	{
		id: "RelayProbe.NatHalfOpenSweep",
		agent: "scout",
		description: "NAT half-open idle timeout audit",
		status: "completed",
		sessionFile: "/tmp/oms/agents/RelayProbe.NatHalfOpenSweep.jsonl",
		index: 4,
	},
	{
		id: "RelayProbe.SendBufferCap",
		agent: "scout",
		description: "256-frame outbound ring cap check",
		status: "completed",
		sessionFile: "/tmp/oms/agents/RelayProbe.SendBufferCap.jsonl",
		index: 5,
	},
	{
		id: "RelayProbe.DecryptKeyHeal",
		agent: "task",
		description: "simulate corrupt room-key rotation",
		status: "failed",
		sessionFile: "/tmp/oms/agents/RelayProbe.DecryptKeyHeal.jsonl",
		index: 6,
	},
	{
		id: "RelayProbe.CloseCodeTable",
		agent: "sonic",
		description: "enumerate fatal websocket codes",
		status: "aborted",
		sessionFile: "/tmp/oms/agents/RelayProbe.CloseCodeTable.jsonl",
		index: 7,
	},
	{
		id: "RelayProbe.KevlarLookups.WindowDriftCheck",
		agent: "scout",
		description: "entry window byte-bound drift check",
		status: "started",
		sessionFile: "/tmp/oms/agents/RelayProbe.KevlarLookups.WindowDriftCheck.jsonl",
		index: 0,
	},
];

interface RunningSpec {
	id: string;
	index: number;
	agent: string;
	task: string;
	description: string;
	assignment: string;
	intents: readonly string[];
	tools: readonly { name: string; args: string }[];
	baseTokens: number;
	baseCost: number;
	baseDurationMs: number;
}

const RUNNING_SPECS: readonly RunningSpec[] = [
	{
		id: "RelayProbe",
		index: 0,
		agent: "task",
		task: "coordinate relay reconnect stress matrix",
		description: "relay reconnect probe",
		assignment: "Coordinate 8 reconnect verification subagents and synthesize findings.",
		intents: ["Coordinating child probes", "Reviewing resync invariants", "Checking child outputs"],
		tools: [
			{ name: "wait", args: "" },
			{ name: "read", args: "packages/coding-agent/src/collab/relay-client.ts:168-197" },
			{ name: "grep", args: "scheduleRetry|failFatal" },
			{ name: "bash", args: "bun test packages/coding-agent/test/collab --filter reconnect" },
		],
		baseTokens: 28_400,
		baseCost: 0.064,
		baseDurationMs: 142_000,
	},
	{
		id: "RelayProbe.KevlarLookups",
		index: 0,
		agent: "task",
		task: "verify fast peer-id and room-key lookup tables",
		description: "lookup table stress test",
		assignment: "Audit lookup hot paths and delegate entry-window drift checks.",
		intents: ["Benchmarking envelope dispatch", "Inspecting peer map churn", "Tracing window bounds"],
		tools: [
			{ name: "bash", args: "bun test packages/collab-web/test/codec.test.ts" },
			{ name: "read", args: "packages/collab-web/src/lib/codec.ts:1-90" },
			{ name: "grep", args: "unpackEnvelope|sealPlaintext" },
		],
		baseTokens: 16_200,
		baseCost: 0.038,
		baseDurationMs: 96_000,
	},
	{
		id: "RelayProbe.CrtExact",
		index: 1,
		agent: "scout",
		task: "confirm exact exponential backoff curve and jitter bounds",
		description: "exact backoff curve check",
		assignment: "Verify retry schedule clamps cleanly at 30s with zero timer leaks.",
		intents: ["Tracing backoff clamps", "Reading socket retry timer", "Checking abort cleanup"],
		tools: [
			{ name: "read", args: "packages/collab-web/src/lib/socket.ts:80-165" },
			{ name: "grep", args: "BACKOFF|clearTimeout" },
		],
		baseTokens: 11_900,
		baseCost: 0.024,
		baseDurationMs: 74_000,
	},
	{
		id: "RelayProbe.FrameBoundaryChecksumVerification",
		index: 2,
		agent: "task",
		task: "verify multi-chunk frame boundary checksums across reconnects",
		description: "frame boundary checksums",
		assignment: "Ensure snapshot chunks and sealed frame boundaries never split UTF-8 lines.",
		intents: ["Verifying UTF-8 chunk boundaries", "Editing boundary test cases", "Running pager suite"],
		tools: [
			{ name: "edit", args: "packages/collab-web/test/transcript-pager.test.ts" },
			{ name: "bash", args: "bun test packages/collab-web/test/transcript-pager.test.ts" },
			{ name: "read", args: "packages/collab-web/scripts/mock-transcript.ts:1-85" },
		],
		baseTokens: 21_500,
		baseCost: 0.049,
		baseDurationMs: 88_000,
	},
	{
		id: "RelayProbe.KevlarLookups.WindowDriftCheck",
		index: 0,
		agent: "scout",
		task: "check EntryWindow trimOldest/trimNewest byte accounting",
		description: "entry window drift check",
		assignment: "Confirm EntryWindow byte counter stays exact across unshift/push/trim cycles.",
		intents: ["Auditing EntryWindow.#bytes", "Checking trimOldest invariants"],
		tools: [
			{ name: "read", args: "packages/collab-web/src/lib/client.ts:190-265" },
			{ name: "grep", args: "trimOldest|trimNewest" },
		],
		baseTokens: 8_700,
		baseCost: 0.019,
		baseDurationMs: 41_000,
	},
];

function buildSpecProgress(spec: RunningSpec, tick: number): SubagentProgressPayload {
	// Hold each tool steady across several ticks so live UI resembles real tool runs.
	const step = Math.floor((tick + spec.index * 2) / 3);
	const current = spec.tools[step % spec.tools.length]!;
	const intent = spec.intents[step % spec.intents.length]!;
	const now = Date.now();
	const stepOffsetMs = ((tick + spec.index * 2) % 3) * 1_000 + 800;
	const recentTools = [1, 2].map(back => {
		const prior = spec.tools[(step + spec.tools.length * back - back) % spec.tools.length]!;
		return { tool: prior.name, args: prior.args, endMs: now - back * 4_000 };
	});
	return {
		index: spec.index,
		agent: spec.agent,
		task: spec.task,
		parentToolCallId: `call-task-${spec.id}`,
		assignment: spec.assignment,
		sessionFile: `/tmp/oms/agents/${spec.id}.jsonl`,
		progress: {
			index: spec.index,
			id: spec.id,
			agent: spec.agent,
			status: "running",
			task: spec.task,
			description: spec.description,
			lastIntent: intent,
			currentTool: current.name,
			currentToolArgs: current.args,
			currentToolIntent: intent,
			currentToolStartMs: now - stepOffsetMs,
			recentTools,
			recentOutput: ["3 sockets reconnected in 1.2s", "0 duplicate entries after resync"],
			toolCount: 7 + step,
			requests: 3 + Math.floor(step / 2),
			tokens: spec.baseTokens + tick * 180,
			contextTokens: spec.baseTokens + 3_900 + tick * 210,
			contextWindow: fixtureModel.contextWindow ?? undefined,
			cost: spec.baseCost + tick * 0.0004,
			durationMs: spec.baseDurationMs + tick * 1_000,
			resolvedModel: fixtureModel.id,
		},
	};
}

/** Progress payload for the primary running coordinator; `tick` advances counters. */
export function makeProbeProgress(tick: number): SubagentProgressPayload {
	return buildSpecProgress(RUNNING_SPECS[0]!, tick);
}

/** Progress payloads for all running subagents in the nested fixture. */
export function makeRunningProgressPayloads(tick: number): SubagentProgressPayload[] {
	return RUNNING_SPECS.map(spec => buildSpecProgress(spec, tick));
}

/** Final progress snapshots for settled subagents so their drawers show usage metrics. */
export const fixtureSettledProgress: readonly SubagentProgressPayload[] = [
	{
		index: 1,
		agent: "scout",
		task: "sweep docs/collab.md for stale close-code references",
		sessionFile: "/tmp/oms/agents/DocSweep.jsonl",
		progress: {
			index: 1,
			id: "DocSweep",
			agent: "scout",
			status: "completed",
			task: "sweep docs/collab.md for stale close-code references",
			description: "sweep close-code docs",
			lastIntent: "Summarizing close-code verification",
			recentTools: [
				{ tool: "read", args: "packages/coding-agent/src/collab/relay-client.ts", endMs: NOW - 11 * MIN },
			],
			recentOutput: [],
			toolCount: 4,
			requests: 3,
			tokens: 9_420,
			contextTokens: 11_200,
			contextWindow: fixtureModel.contextWindow ?? undefined,
			cost: 0.019,
			durationMs: 28_400,
			resolvedModel: fixtureModel.id,
		},
	},
	{
		index: 6,
		agent: "task",
		task: "simulate corrupt room-key rotation",
		sessionFile: "/tmp/oms/agents/RelayProbe.DecryptKeyHeal.jsonl",
		progress: {
			index: 6,
			id: "RelayProbe.DecryptKeyHeal",
			agent: "task",
			status: "failed",
			task: "simulate corrupt room-key rotation",
			description: "simulate corrupt room-key rotation",
			lastIntent: "Testing GCM tag rejection path",
			recentTools: [{ tool: "bash", args: "bun test packages/collab-web/test/codec.test.ts", endMs: NOW - 5 * MIN }],
			recentOutput: ["OperationError: AES-GCM tag mismatch"],
			toolCount: 5,
			requests: 3,
			tokens: 12_310,
			contextTokens: 14_800,
			contextWindow: fixtureModel.contextWindow ?? undefined,
			cost: 0.027,
			durationMs: 34_100,
			resolvedModel: fixtureModel.id,
		},
	},
];

// ─── subagent transcript ─────────────────────────────────────────────────────

const SUB_T0 = NOW - 25 * MIN;

const subagentTranscriptLines: unknown[] = [
	{ type: "session", id: "mock-docsweep", timestamp: iso(SUB_T0), cwd: "/Users/kai/Projects/pi" },
	// Unknown entry type — guests must skip it (tolerant default branch).
	{ type: "session_init", id: "s00", parentId: null, timestamp: iso(SUB_T0), version: 3 },
	{
		id: "s01",
		parentId: null,
		timestamp: iso(SUB_T0 + 2_000),
		type: "message",
		message: {
			role: "user",
			content: "Sweep docs/collab.md for stale close-code references and report mismatches.",
			timestamp: SUB_T0 + 2_000,
		},
	},
	{
		id: "s02",
		parentId: "s01",
		timestamp: iso(SUB_T0 + 9_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Grep the doc for 4xxx codes, then diff against protocol.ts." },
				{ type: "text", text: "Scanning `docs/collab.md` for close-code mentions." },
				{
					type: "toolCall",
					id: "sub-call-01",
					name: "grep",
					arguments: { pattern: "40\\d\\d", paths: ["docs/collab.md"] },
					intent: "Finding close codes",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_180, 96, 0, 0.0021),
			stopReason: "toolUse",
			timestamp: SUB_T0 + 9_000,
		},
	},
	{
		id: "s03",
		parentId: "s02",
		timestamp: iso(SUB_T0 + 11_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "sub-call-01",
			toolName: "grep",
			content: [
				{
					type: "text",
					text: "docs/collab.md:41: 4001 room closed\ndocs/collab.md:42: 4004 no such room\ndocs/collab.md:43: 4009 host conflict\ndocs/collab.md:44: 4029 room full",
				},
			],
			isError: false,
			timestamp: SUB_T0 + 11_000,
		},
	},
	{
		id: "s04",
		parentId: "s03",
		timestamp: iso(SUB_T0 + 20_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "sub-call-02",
					name: "read",
					arguments: { path: "packages/coding-agent/src/collab/relay-client.ts", offset: 13, limit: 6 },
					intent: "Cross-checking the fatal table",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_460, 41, 980, 0.0024),
			stopReason: "toolUse",
			timestamp: SUB_T0 + 20_000,
		},
	},
	{
		id: "s05",
		parentId: "s04",
		timestamp: iso(SUB_T0 + 22_000),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "sub-call-02",
			toolName: "read",
			content: [
				{
					type: "text",
					text: '13:const FATAL_CLOSE_REASONS: Record<number, string> = {\n14:\t4001: "room closed",\n15:\t4004: "no such room",\n16:\t4009: "a host is already connected for this room",\n17:\t4029: "room is full",\n18:};',
				},
			],
			isError: false,
			timestamp: SUB_T0 + 22_000,
		},
	},
	{
		id: "s06",
		parentId: "s05",
		timestamp: iso(SUB_T0 + 30_000),
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "All four close codes in `docs/collab.md` match `FATAL_CLOSE_REASONS` — no stale references. The doc could additionally mention that decrypt failures are fatal; flagged as a suggestion, not a mismatch.",
				},
			],
			model: fixtureModel.id,
			usage: mkUsage(1_720, 88, 1_240, 0.0029),
			stopReason: "stop",
			timestamp: SUB_T0 + 30_000,
		},
	},
];

/** DocSweep's session file, served by the mock host's fetch-transcript-page handler. */
export const subagentTranscriptJsonl: string = `${subagentTranscriptLines
	.map(line => JSON.stringify(line))
	.join("\n")}\n`;

/** Builds a realistic per-agent JSONL transcript so every row's drawer opens cleanly. */
export function makeSubagentTranscriptJsonl(agent: AgentSnapshot): string {
	if (agent.id === "DocSweep") return subagentTranscriptJsonl;
	const startTs = agent.createdAt;
	const lines: unknown[] = [
		{ type: "session", id: `mock-${agent.id}`, timestamp: iso(startTs), cwd: fixtureHeader.cwd },
		{
			id: `${agent.id}-u1`,
			parentId: null,
			timestamp: iso(startTs + 1_000),
			type: "message",
			message: {
				role: "user",
				content: `Investigate slice for ${agent.id}${agent.parentId ? ` under ${agent.parentId}` : ""}.`,
				timestamp: startTs + 1_000,
			},
		},
		{
			id: `${agent.id}-a1`,
			parentId: `${agent.id}-u1`,
			timestamp: iso(startTs + 4_000),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Checking target invariants for ${agent.id}.` },
					{
						type: "toolCall",
						id: `${agent.id}-call-1`,
						name: "read",
						arguments: { path: "packages/collab-web/src/lib/client.ts", offset: 1, limit: 60 },
						intent: `Inspecting client state for ${agent.id}`,
					},
				],
				model: fixtureModel.id,
				usage: mkUsage(1_320, 74, 840, 0.0022),
				stopReason: "toolUse",
				timestamp: startTs + 4_000,
			},
		},
		{
			id: `${agent.id}-r1`,
			parentId: `${agent.id}-a1`,
			timestamp: iso(startTs + 6_000),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: `${agent.id}-call-1`,
				toolName: "read",
				content: [{ type: "text", text: "GuestClient snapshot invariants verified across reconnect frames." }],
				isError: false,
				timestamp: startTs + 6_000,
			},
		},
		{
			id: `${agent.id}-a2`,
			parentId: `${agent.id}-r1`,
			timestamp: iso(startTs + 10_000),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							agent.status === "running"
								? `Active probe \`${agent.id}\` is verifying live reconnect invariants.`
								: `Completed check for \`${agent.id}\` (final status: \`${agent.status}\`).`,
					},
				],
				model: fixtureModel.id,
				usage: mkUsage(1_680, 62, 1_100, 0.0028),
				stopReason: "stop",
				timestamp: startTs + 10_000,
			},
		},
	];
	return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
}

/** Appends one live transcript line scoped to `agentId`. */
export function makeAgentTranscriptLine(agentId: string, tick: number): string {
	const ts = Date.now();
	const entry: SessionEntry = {
		id: `${agentId}-live-${tick}`,
		parentId: null,
		timestamp: iso(ts),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `[${agentId}] pass ${tick}: reconnect invariants holding.` }],
			model: fixtureModel.id,
			usage: mkUsage(1_200 + tick, 24, 900, 0.0011),
			stopReason: "stop",
			timestamp: ts,
		},
	};
	return `${JSON.stringify(entry)}\n`;
}

/** One row the running sub appends to its session file; `tick` keeps IDs unique. */
export function makeProbeTranscriptLine(tick: number): string {
	const ts = Date.now();
	const entry: SessionEntry = {
		id: `probe-live-${tick}`,
		parentId: null,
		timestamp: iso(ts),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `Replay ${tick}: 3 sockets reconnected, 0 duplicate entries after resync.` }],
			model: fixtureModel.id,
			usage: mkUsage(1_200 + tick, 24, 900, 0.0011),
			stopReason: "stop",
			timestamp: ts,
		},
	};
	return `${JSON.stringify(entry)}\n`;
}

// ─── long session and transcript (mock-host --long) ──────────────────────────

const LONG_TURNS = 360;
const LONG_TURN_MS = 45_000;
const LONG_TOOLS = ["bash", "read", "grep"] as const;
const LONG_TOPICS = [
	"backoff jitter",
	"close-code table",
	"resync handshake",
	"send buffer cap",
	"ping cadence",
	"room recreation",
] as const;

/** Deterministic prose of `sentences` sentences, so generated rows differ in height. */
function proseFor(seed: number, sentences: number): string {
	const parts: string[] = [];
	for (let i = 0; i < sentences; i++) {
		const topic = LONG_TOPICS[(seed + i) % LONG_TOPICS.length]!;
		parts.push(`Pass ${seed + 1}.${i + 1} re-checked the ${topic} against the relay and the guest replica.`);
	}
	return parts.join(" ");
}

function longToolArgs(tool: (typeof LONG_TOOLS)[number], turn: number, topic: string): Record<string, unknown> {
	switch (tool) {
		case "bash":
			return { command: `bun test packages/coding-agent/test/collab --filter "${topic}"` };
		case "read":
			return { path: "packages/coding-agent/src/collab/relay-client.ts", offset: 20 + turn, limit: 40 };
		case "grep":
			return { pattern: topic.replaceAll(" ", "|"), paths: ["packages/coding-agent/src/collab"] };
	}
}

/**
 * About 1,500 entries of mixed kinds that end in {@link fixtureEntries}: user
 * and guest prompts, assistant turns with tool calls and results, and the
 * occasional model change, thinking-level change, compaction and branch summary.
 */
export function makeLongSessionEntries(): SessionEntry[] {
	const generated: SessionEntry[] = [];
	const start = NOW - 33 * MIN - LONG_TURNS * LONG_TURN_MS;
	const at = (id: string, ts: number): { id: string; parentId: null; timestamp: string } => ({
		id,
		parentId: null,
		timestamp: iso(ts),
	});
	for (let turn = 0; turn < LONG_TURNS; turn++) {
		const ts = start + turn * LONG_TURN_MS;
		const tag = `h${String(turn + 1).padStart(4, "0")}`;
		const topic = LONG_TOPICS[turn % LONG_TOPICS.length]!;
		const tool = LONG_TOOLS[turn % LONG_TOOLS.length]!;
		const callId = `${tag}-call`;
		if (turn % 25 === 24) {
			generated.push({ ...at(`${tag}-model`, ts), type: "model_change", model: fixtureModel.id });
		}
		if (turn % 33 === 32) {
			generated.push({
				...at(`${tag}-thinking`, ts),
				type: "thinking_level_change",
				thinkingLevel: turn % 2 === 0 ? "medium" : "high",
			});
		}
		if (turn % 7 === 6) {
			generated.push({
				...at(`${tag}-guest`, ts + 1_000),
				type: "custom_message",
				customType: "collab-prompt",
				content: `can you also re-check the ${topic} while you are there?`,
				details: { from: "ada" },
				display: true,
			});
		} else {
			generated.push({
				...at(`${tag}-user`, ts + 1_000),
				type: "message",
				message: {
					role: "user",
					content: `audit pass ${turn + 1}: look at the ${topic}`,
					timestamp: ts + 1_000,
				},
			});
		}
		generated.push({
			...at(`${tag}-plan`, ts + 5_000),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `The ${topic} moved in pass ${turn}; verify before claiming anything.` },
					{ type: "text", text: `Checking the ${topic}.` },
					{
						type: "toolCall",
						id: callId,
						name: tool,
						arguments: longToolArgs(tool, turn, topic),
						intent: `Inspecting the ${topic}`,
					},
				],
				model: fixtureModel.id,
				usage: mkUsage(2_000 + turn * 3, 120, 18_000, 0.011),
				stopReason: "toolUse",
				timestamp: ts + 5_000,
			},
		});
		generated.push({
			...at(`${tag}-result`, ts + 9_000),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: tool,
				content: [
					{
						type: "text",
						text: Array.from(
							{ length: 3 + (turn % 12) },
							(_, line) => `${line + 1}: ${topic} check ${turn + 1}.${line + 1} ok`,
						).join("\n"),
					},
				],
				isError: turn % 9 === 8,
				timestamp: ts + 9_000,
			},
		});
		generated.push({
			...at(`${tag}-answer`, ts + 20_000),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							turn % 5 === 0
								? `### Pass ${turn + 1}\n\n- ${topic}: verified\n- regressions: none\n\n\`\`\`ts\nconst pass = ${turn + 1};\n\`\`\``
								: proseFor(turn, 1 + (turn % 4)),
					},
				],
				model: fixtureModel.id,
				usage: mkUsage(2_400 + turn * 3, 90, 19_000, 0.012),
				stopReason: "stop",
				timestamp: ts + 20_000,
			},
		});
		if (turn % 40 === 39) {
			generated.push({
				...at(`${tag}-compaction`, ts + 30_000),
				type: "compaction",
				summary: `Passes up to ${turn + 1} verified the reconnect path; nothing regressed.`,
				shortSummary: `passes 1–${turn + 1}`,
				firstKeptEntryId: `${tag}-answer`,
				tokensBefore: 40_000 + turn * 25,
			});
		}
		if (turn % 50 === 49) {
			generated.push({
				...at(`${tag}-branch`, ts + 31_000),
				type: "branch_summary",
				fromId: `${tag}-answer`,
				summary: `Explored an alternative for the ${topic} and returned.`,
			});
		}
	}
	const entries: SessionEntry[] = generated.map((entry, index) => ({
		...entry,
		parentId: generated[index - 1]?.id ?? null,
	}));
	for (const entry of fixtureEntries) {
		entries.push(entry.parentId === null ? { ...entry, parentId: entries.at(-1)?.id ?? null } : entry);
	}
	return entries;
}

/**
 * A subagent session file of about `targetBytes`: a header, tool calls with
 * multi-kilobyte results (multi-byte text included), short assistant notes and
 * the occasional line of an unknown entry type.
 */
export function makeLongTranscriptJsonl(targetBytes = 2 * 1024 * 1024): string {
	const lines: string[] = [];
	let bytes = 0;
	const add = (line: unknown): void => {
		const json = JSON.stringify(line);
		lines.push(json);
		bytes += Buffer.byteLength(json) + 1;
	};
	add({ type: "session", id: "mock-long-sub", timestamp: iso(SUB_T0), cwd: fixtureHeader.cwd });
	for (let step = 0; bytes < targetBytes; step++) {
		const ts = SUB_T0 + step * 7_000;
		const tag = `t${String(step + 1).padStart(4, "0")}`;
		const callId = `${tag}-call`;
		// Unknown entry type — guests skip the row and still account for its bytes.
		if (step % 40 === 0) {
			add({ type: "session_init", id: `${tag}-init`, parentId: null, timestamp: iso(ts), version: 3 });
		}
		const call: SessionEntry = {
			id: `${tag}-plan`,
			parentId: null,
			timestamp: iso(ts),
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: callId,
						name: "bash",
						arguments: { command: `bun test packages/coding-agent/test/collab --filter replay-${step + 1}` },
						intent: `Replaying drop scenario ${step + 1}`,
					},
				],
				model: fixtureModel.id,
				usage: mkUsage(1_400 + step, 40, 900, 0.0023),
				stopReason: "toolUse",
				timestamp: ts,
			},
		};
		const result: SessionEntry = {
			id: `${tag}-result`,
			parentId: call.id,
			timestamp: iso(ts + 3_000),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [
					{
						type: "text",
						text: Array.from(
							{ length: 12 + ((step * 7) % 60) },
							(_, line) =>
								`${line + 1}: ✓ replay ${step + 1}.${line + 1} — 3 sockets reconnected in 1.${line % 10}s, 재동기화 후 중복 0`,
						).join("\n"),
					},
				],
				isError: false,
				timestamp: ts + 3_000,
			},
		};
		add(call);
		add(result);
		if (step % 3 === 2) {
			const note: SessionEntry = {
				id: `${tag}-note`,
				parentId: result.id,
				timestamp: iso(ts + 5_000),
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Scenario ${step + 1} holds: no duplicate entries after resync.` }],
					model: fixtureModel.id,
					usage: mkUsage(1_500 + step, 30, 1_000, 0.0024),
					stopReason: "stop",
					timestamp: ts + 5_000,
				},
			};
			add(note);
		}
	}
	return `${lines.join("\n")}\n`;
}

// ─── scripted streaming turn ─────────────────────────────────────────────────

export type ScriptedStep =
	| { kind: "event"; event: AgentEvent }
	| { kind: "entry"; entry: SessionEntry }
	| { kind: "state"; streaming: boolean };

const TURN_THINKING_1 = "Guest wants a live check. ";
const TURN_THINKING_2 = "Guest wants a live check. I'll run the reconnect suite once and summarize the result.";
const TURN_TEXT_1 = "Kicking off a live reconnect probe ";
const TURN_TEXT_2 = "Kicking off a live reconnect probe — one suite run, then a verdict.";
const TURN_CLOSE_1 = "Probe passed: 3 reconnects, ";
const TURN_CLOSE_2 = "Probe passed: 3 reconnects, 0 duplicate entries after resync. The reconnect path holds.";

/**
 * One scripted streaming turn, replayed by the mock host at ~40ms cadence.
 *
 * `seq` keeps ids unique across replays; `parentId` chains the appended
 * entries onto the current transcript tail.
 */
export function makeScriptedTurn(seq: number, parentId: string | null): ScriptedStep[] {
	const ts = Date.now();
	const a1Id = `turn${seq}-a1`;
	const callId = `turn${seq}-call1`;
	const r1Id = `turn${seq}-r1`;
	const a2Id = `turn${seq}-a2`;
	const command = "bun test packages/coding-agent/test/collab --filter reconnect";
	const toolResultText =
		"3 tests passed (reconnect.test.ts)\n3 sockets reconnected in 1.2s\n0 duplicate entries after resync";

	const partial = (content: AssistantMessage["content"]): AssistantMessage => ({
		role: "assistant",
		content,
		model: fixtureModel.id,
		usage: mkUsage(0, 0, 0, 0),
		stopReason: "stop",
		timestamp: ts,
	});

	const toolCall: ToolCallContent = {
		type: "toolCall",
		id: callId,
		name: "bash",
		arguments: { command },
		intent: "Running the reconnect suite",
	};

	const a1Final: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: TURN_THINKING_2 }, { type: "text", text: TURN_TEXT_2 }, toolCall],
		model: fixtureModel.id,
		usage: mkUsage(4_310, 164, 24_800, 0.0147),
		stopReason: "toolUse",
		timestamp: ts,
	};

	const r1Message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: toolResultText }],
		isError: false,
		timestamp: ts,
	};

	const a2Final: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: TURN_CLOSE_2 }],
		model: fixtureModel.id,
		usage: mkUsage(4_690, 52, 25_400, 0.0153),
		stopReason: "stop",
		timestamp: ts,
	};

	return [
		{ kind: "event", event: { type: "agent_start" } },
		{ kind: "state", streaming: true },
		{ kind: "event", event: { type: "turn_start" } },
		{ kind: "event", event: { type: "message_start", message: partial([]) } },
		{
			kind: "event",
			event: { type: "message_update", message: partial([{ type: "thinking", thinking: TURN_THINKING_1 }]) },
		},
		{
			kind: "event",
			event: { type: "message_update", message: partial([{ type: "thinking", thinking: TURN_THINKING_2 }]) },
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_1 },
				]),
			},
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_2 },
				]),
			},
		},
		{
			kind: "event",
			event: {
				type: "message_update",
				message: partial([
					{ type: "thinking", thinking: TURN_THINKING_2 },
					{ type: "text", text: TURN_TEXT_2 },
					toolCall,
				]),
			},
		},
		{ kind: "event", event: { type: "message_end", message: a1Final } },
		{ kind: "entry", entry: { id: a1Id, parentId, timestamp: iso(ts), type: "message", message: a1Final } },
		{
			kind: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: "bash",
				args: { command },
				intent: "Running the reconnect suite",
			},
		},
		{
			kind: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: callId,
				toolName: "bash",
				args: { command },
				partialResult: "3 sockets reconnected in 1.2s",
			},
		},
		{
			kind: "event",
			event: {
				type: "tool_execution_end",
				toolCallId: callId,
				toolName: "bash",
				result: toolResultText,
				isError: false,
			},
		},
		{ kind: "entry", entry: { id: r1Id, parentId: a1Id, timestamp: iso(ts), type: "message", message: r1Message } },
		{ kind: "event", event: { type: "message_start", message: partial([]) } },
		{ kind: "event", event: { type: "message_update", message: partial([{ type: "text", text: TURN_CLOSE_1 }]) } },
		{ kind: "event", event: { type: "message_update", message: partial([{ type: "text", text: TURN_CLOSE_2 }]) } },
		{ kind: "event", event: { type: "message_end", message: a2Final } },
		{ kind: "entry", entry: { id: a2Id, parentId: r1Id, timestamp: iso(ts), type: "message", message: a2Final } },
		{ kind: "event", event: { type: "turn_end" } },
		{ kind: "event", event: { type: "agent_end" } },
		{ kind: "state", streaming: false },
	];
}
