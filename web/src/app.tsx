import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Sidebar } from "./components/shell/Sidebar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { type ActiveTool, GuestClient } from "./lib/client";
import { useGuestSnapshot } from "./lib/use-guest";
import { useMediaQuery } from "./lib/use-media-query";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "oms.collab.name";
const NO_ACTIVE_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();
/** At and above this width the sidebar docks beside the transcript; below it, it overlays (kept in sync with shell.css). */
const DOCKED_SIDEBAR_QUERY = "(min-width: 900px)";

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [session, setSession] = useState<{ client: GuestClient; name: string } | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);
	const client = session?.client ?? null;

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setSession(prev => {
			prev?.client.close();
			return { client: next, name };
		});
	}, []);

	const leave = useCallback((): void => {
		setSession(prev => {
			prev?.client.close();
			return null;
		});
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "oms collab";
	}, [client]);

	if (!session) {
		return <ConnectScreen defaultName={storedName()} error={connectError} onConnect={connect} />;
	}
	return <Session client={session.client} name={session.name} onLeave={leave} onRejoin={rejoin} />;
}

interface SessionProps {
	client: GuestClient;
	/** This guest's display name. */
	name: string;
	onLeave(): void;
	onRejoin(): void;
}

function Session({ client, name, onLeave, onRejoin }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const docked = useMediaQuery(DOCKED_SIDEBAR_QUERY);
	// One flag per presentation: resizing across the breakpoint never pops the
	// overlay open, and restores the docked sidebar as the reader left it.
	const [sidebar, setSidebar] = useState({ docked: true, overlay: false });
	const sidebarOpen = docked ? sidebar.docked : sidebar.overlay;
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same panel the sidebar opens.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// The first subagent reopens a docked sidebar the reader had closed. The
	// overlay stays shut: it would cover what they are reading, so the header
	// toggle carries the subagent count instead.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setSidebar(prev => (prev.docked ? prev : { ...prev, docked: true }));
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · oms collab`;
	}, [title]);

	const panelAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleSidebar = useCallback(
		() => setSidebar(prev => (docked ? { ...prev, docked: !prev.docked } : { ...prev, overlay: !prev.overlay })),
		[docked],
	);
	const closeOverlay = useCallback(() => setSidebar(prev => (prev.overlay ? { ...prev, overlay: false } : prev)), []);
	const selectAgent = useCallback(
		(id: string | null) => {
			setSelectedId(id);
			closeOverlay();
		},
		[closeOverlay],
	);
	const closePanel = useCallback(() => setSelectedId(null), []);
	const overlayOpen = !docked && sidebar.overlay;

	// Escape dismisses the overlay sidebar, unless something above it (the
	// agent panel, the slash palette) took the key.
	useEffect(() => {
		if (!overlayOpen || panelAgent !== undefined) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" && !e.defaultPrevented) closeOverlay();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [overlayOpen, panelAgent, closeOverlay]);

	const history = snap.history;
	const showLive = history.atLatest && snap.phase === "live" && snap.loading === null;
	const loadOlder = useCallback((byReader: boolean) => client.loadOlder(byReader), [client]);
	const loadNewer = useCallback(() => client.loadNewer(), [client]);
	const jumpToLatest = useCallback(() => client.jumpToLatest(), [client]);
	const setFollowingTail = useCallback((following: boolean) => client.setFollowingTail(following), [client]);

	return (
		<div className="sh-app">
			{sidebarOpen && (
				<>
					<div className="sb-backdrop" onClick={closeOverlay} />
					<Sidebar
						title={title}
						agents={snap.agents}
						progress={snap.progress}
						lifecycle={snap.lifecycle}
						selectedId={selectedId}
						onSelect={selectAgent}
						participants={snap.state?.participants}
						name={name}
						readOnly={snap.readOnly}
						onClose={toggleSidebar}
						onLeave={onLeave}
					/>
				</>
			)}
			<main className="sh-main">
				<HeaderBar
					header={snap.header}
					state={snap.state}
					phase={snap.phase}
					subCount={subCount}
					sidebarOpen={sidebarOpen}
					onToggleSidebar={toggleSidebar}
				/>
				<div className="sh-transcript">
					<Transcript
						key={history.version}
						entries={snap.entries}
						stream={showLive ? snap.stream : null}
						streamDone={snap.streamDone}
						activeTools={showLive ? snap.activeTools : NO_ACTIVE_TOOLS}
						working={showLive && snap.working}
						hasOlder={history.hasOlder}
						hasNewer={!history.atLatest}
						loading={history.loading}
						error={history.error}
						unseen={history.unseen}
						onReachStart={loadOlder}
						onReachEnd={loadNewer}
						onJumpToLatest={jumpToLatest}
						onFollowChange={setFollowingTail}
						host={toolHost}
						phase={snap.phase}
					/>
				</div>
				<Composer
					client={client}
					phase={snap.phase}
					readOnly={snap.readOnly}
					uiRequest={snap.uiRequest}
					working={snap.working}
					queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
					model={snap.state?.model?.name}
					effort={snap.state?.thinkingLevel}
					commands={snap.commands}
					commandRuns={snap.commandRuns}
					onToggleAgents={toggleSidebar}
					onLeave={onLeave}
				/>
				<Banners
					phase={snap.phase}
					endedReason={snap.endedReason}
					loading={snap.loading}
					onRejoin={onRejoin}
					onNewLink={onLeave}
				/>
			</main>
			{panelAgent && (
				<>
					<div className="ag-backdrop" onClick={closePanel} />
					<AgentDrawer
						agent={panelAgent}
						progress={snap.progress.get(panelAgent.id)}
						lifecycle={snap.lifecycle.get(panelAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closePanel}
					/>
				</>
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
