/**
 * Process-wide Board access for the built-in tool and the write guard (docs/board.md §4.4–§4.6):
 * one shared repository per process and one lazily minted tripcode session per {@link ToolSession}.
 */
import { classifyModel } from "@oh-my-soup/pi-catalog/identity";
import { logger } from "@oh-my-soup/pi-utils";
import { cfgBoardEnabled, cfgBoardEnforceTurf } from "../session/settings";
import type { ToolSession } from "../tools/index";
import { isLive, requireTripcode } from "./identity";
import { BoardRepository } from "./repository";
import type { BoardRow, Principal, TripcodeRow } from "./types";

export interface BoardSessionHandle {
	repo: BoardRepository;
	principal: Principal;
	tripcode: TripcodeRow;
	board: BoardRow;
}

let shared: BoardRepository | null = null;
let override: BoardRepository | null = null;
const handles = new WeakMap<ToolSession, Promise<BoardSessionHandle>>();

/** The process-wide repository at `~/.oms/board/board.sqlite`, opened on first use. */
export function sharedBoardRepository(): BoardRepository {
	if (override) return override;
	if (!shared) shared = BoardRepository.open();
	return shared;
}

/** Tests point every caller at a temporary repository; `null` restores the default. */
export function overrideBoardRepositoryForTests(repo: BoardRepository | null): void {
	override = repo;
}

export function boardEnabled(session: ToolSession): boolean {
	return cfgBoardEnabled.get(session.settings);
}

export function boardTurfEnforced(session: ToolSession): boolean {
	return boardEnabled(session) && cfgBoardEnforceTurf.get(session.settings);
}

function sessionClade(session: ToolSession): string {
	const model = session.getActiveModel?.();
	if (!model) return "unknown";
	try {
		return classifyModel(model.provider, model.id, { lenient: true }).class;
	} catch (error) {
		logger.debug("Board: model classification failed", {
			provider: model.provider,
			id: model.id,
			error: String(error),
		});
		return "unknown";
	}
}

function openOwnerSession(repo: BoardRepository, tripcodeId: number, clade: string): Principal {
	const opened = repo.openSession({ tripcodeId, depth: 0, clade, kind: "owner", processId: process.pid });
	return { kind: "session", token: opened.token };
}

async function mintHandle(session: ToolSession): Promise<BoardSessionHandle> {
	const repo = sharedBoardRepository();
	const board = await repo.boardForPath(session.cwd);
	const mount = repo.mountOf(session.cwd)?.path ?? session.cwd;
	const agentKind = (session.getAgentId?.() ?? "main").toLowerCase();
	const clade = sessionClade(session);
	const tripcode = repo.registerTripcode({
		ownerId: repo.store.rootMaintainer().id,
		name: agentKind,
		recipe: { mount, modelClass: clade, agentKind },
	});
	const handle: BoardSessionHandle = { repo, principal: openOwnerSession(repo, tripcode.id, clade), tripcode, board };
	session.registerDisposeCallback?.(() => {
		try {
			if (handle.principal.kind === "session") repo.closeSession(handle.principal.token);
		} catch (error) {
			logger.debug("Board: closing session failed", { error: String(error) });
		}
		handles.delete(session);
	});
	return handle;
}

/**
 * A session closes when its lease lapses (§1.4). The harness is the trusted
 * opener, so an idle ToolSession gets a fresh board session on its next call
 * instead of a dead token; banned or halted tripcodes still fail to reopen.
 */
function ensureLive(session: ToolSession, handle: BoardSessionHandle): BoardSessionHandle {
	if (handle.principal.kind !== "session") return handle;
	const row = handle.repo.session(handle.principal.token);
	const tripcode = handle.repo.store.read(tx => requireTripcode(tx, handle.tripcode.id));
	if (row && row.closed_at === null && isLive(tripcode, handle.repo.now())) return handle;
	handle.principal = openOwnerSession(handle.repo, tripcode.id, row?.clade ?? sessionClade(session));
	handle.tripcode = tripcode;
	return handle;
}

/**
 * The tripcode session of a ToolSession, minted on first use (§4.6): owner = the
 * OS user, recipe = ⟨mount of cwd, model class, agent kind⟩, depth 0.
 */
export async function boardSessionFor(session: ToolSession): Promise<BoardSessionHandle> {
	let pending = handles.get(session);
	if (!pending) {
		pending = mintHandle(session).catch(error => {
			handles.delete(session);
			throw error;
		});
		handles.set(session, pending);
	}
	return ensureLive(session, await pending);
}
