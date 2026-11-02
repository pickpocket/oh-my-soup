import { afterEach, describe, expect, test } from "bun:test";
import {
	assertPosts,
	claimStanding,
	createClaim,
	digestDebunked,
	grounding,
	independentRepros,
	knowledgeHandlers,
	latestAudit,
	probeClaims,
	queryState,
	recomputeStanding,
	reproCounts,
	rollupDisqualified,
	rollupStale,
	similarity,
} from "../src/board/knowledge";
import type { BoardParams } from "../src/board/params";
import { insertPost, postRefIds, postScope } from "../src/board/post-rows";
import { createPostDispatcher } from "../src/board/posts";
import { threadHandlers } from "../src/board/threads";
import { turfHandlers } from "../src/board/turf";
import type { Basis, EpistemicInput, PostInput, PostRow, Principal, Tier } from "../src/board/types";
import { openTestStore, seedBoard, seedSession, seedThread, seedTripcode, type TestStore } from "./board-fixtures";

const fixtures: TestStore[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup(params: Partial<BoardParams> = {}) {
	const fixture = openTestStore({ params });
	fixtures.push(fixture);
	const { store } = fixture;
	const board = seedBoard(store, { key: "knowledge", name: "knowledge", mount: fixture.dir });
	const thread = seedThread(store, board.id, "Evidence");
	const dispatcher = createPostDispatcher({ ...threadHandlers, ...knowledgeHandlers, ...turfHandlers });
	const actor = (name: string, clade = "clade-a") => {
		const tripcode = seedTripcode(store, { name, agentKind: name, mount: fixture.dir, modelClass: clade });
		const session = seedSession(store, tripcode.id, { clade });
		return { tripcode, principal: { kind: "session", token: session.token } as Principal };
	};
	const owner = actor("author");
	const post = (input: PostInput, principal = owner.principal) => dispatcher.post(store, principal, input);
	const take = (
		statement: string,
		level: Tier = 2,
		basis: Basis = { kind: "firsthand" },
		principal = owner.principal,
	): PostRow =>
		post(
			{
				type: "INFO",
				threadId: thread.id,
				body: statement,
				claim: { kind: "new", statement },
				e: { level, basis, crux: "A reproducible counterexample" },
			},
			principal,
		);
	const reproduce = (claimId: number, principal: Principal, answersDebunkPostId?: number) =>
		post(
			{
				type: "CAN-REPRO",
				threadId: thread.id,
				body: "Independent reproduction",
				claimId,
				answersDebunkPostId,
				e: { level: 2, basis: { kind: "firsthand" }, crux: "A failed rerun" },
				refs: [{ kind: "transcript", uri: "history://reproduction" }],
			},
			principal,
		);
	return { ...fixture, board, thread, actor, owner, post, take, reproduce };
}

function claimId(post: PostRow): number {
	if (post.claim_id === null) throw new Error("Expected an assertive post");
	return post.claim_id;
}

const emptyOmissions = () => ({ proc: [] as number[], obs: [] as number[], dup: [] as number[], tan: [] as number[] });

describe("Board effective standing", () => {
	test("T1 an author's own CAN-REPRO cannot turn likely evidence into canon", () => {
		const f = setup();
		const claim = claimId(f.take("SQLite transactions serialize writers"));
		f.reproduce(claim, f.owner.principal);
		expect(f.store.read(tx => claimStanding(tx, claim).level)).toBe(2);
		expect(f.store.read(tx => independentRepros(tx, claim))).toHaveLength(0);
		const first = f.actor("first", "clade-a");
		const second = f.actor("second", "clade-b");
		f.reproduce(claim, first.principal);
		f.reproduce(claim, second.principal);
		expect(f.store.read(tx => claimStanding(tx, claim).level)).toBe(3);
		expect(f.store.read(tx => reproCounts(tx, claim))).toEqual({ authors: 2, clades: 2 });
	});

	test("same-clade repetitions do not bypass the clade threshold once a second clade is registered", () => {
		const f = setup({ reproClades: 2 });
		f.actor("bystander", "clade-b");
		const claim = claimId(f.take("A network partition loses reachability"));
		f.reproduce(claim, f.actor("first").principal);
		f.reproduce(claim, f.actor("second").principal);
		expect(f.store.read(tx => claimStanding(tx, claim).level)).toBe(2);
		expect(f.store.read(tx => reproCounts(tx, claim))).toEqual({ authors: 2, clades: 1 });
	});

	test("k_f falls back to the number of registered clades on a single-clade board", () => {
		const f = setup({ reproClades: 2 });
		const claim = claimId(f.take("A single-clade board can still reach canon"));
		f.reproduce(claim, f.actor("first").principal);
		f.reproduce(claim, f.actor("second").principal);
		expect(f.store.read(tx => claimStanding(tx, claim).level)).toBe(3);
	});

	test("T2 a purely circular deduction grounds neither claim", () => {
		const f = setup();
		const ids = f.store.write(tx => {
			const a = createClaim(tx, {
				statement: "An ungrounded cycle begins",
				boardId: f.board.id,
				createdBy: f.owner.tripcode.id,
			});
			const b = createClaim(tx, {
				statement: "A distinct circular premise returns",
				boardId: f.board.id,
				createdBy: f.owner.tripcode.id,
			});
			for (const [claim, premise] of [
				[a.id, b.id],
				[b.id, a.id],
			]) {
				const post = insertPost(tx, {
					threadId: f.thread.id,
					boardId: f.board.id,
					author: { kind: "tripcode", id: f.owner.tripcode.id },
					type: "INFO",
					body: "Circular deduction",
					claimId: claim,
					level: 2,
					basis: "deduced",
					scope: [{ kind: "board", refId: f.board.id }],
				});
				tx.stmt("INSERT INTO claim_premises (post_id, claim_id) VALUES (?, ?)").run(post.id, premise);
			}
			recomputeStanding(tx, [a.id, b.id]);
			return [a.id, b.id];
		});
		expect(f.store.read(tx => ids.map(id => claimStanding(tx, id).level))).toEqual([-1, -1]);
	});

	test("a deduction cannot outrank its weakest premise and has no independent grounding", () => {
		const f = setup();
		const strong = f.take("The machine has six processors");
		const weak = f.take("The queue is probably bounded", 1);
		const derived = f.take("Parallel requests remain under a stable bound", 2, {
			kind: "deduced",
			premisePostIds: [strong.id, weak.id],
		});
		expect(f.store.read(tx => claimStanding(tx, claimId(derived)).level)).toBe(1);
		expect(f.store.read(tx => grounding(tx, claimId(derived)))).toBe(-1);
	});

	test("OBSOLETE removes the only evidential tip instead of retaining its old tier", () => {
		const f = setup();
		const source = f.take("A cache entry lives indefinitely");
		const replacement = f.take("Cache invalidation is unresolved", 0, { kind: "assumed" });
		f.post({
			type: "OBSOLETE",
			threadId: f.thread.id,
			body: "Superseded experiment",
			target: { kind: "post", from: source.id, to: replacement.id },
		});
		expect(f.store.read(tx => claimStanding(tx, claimId(source)).level)).toBe(-1);
		expect(f.store.read(tx => assertPosts(tx, claimId(source)))).toEqual([]);
	});

	test("a DEBUNK contests all dependents until its author dismisses it", () => {
		const f = setup();
		const premise = f.take("The primary index is complete");
		const child = f.take("Every known object can be retrieved", 2, { kind: "deduced", premisePostIds: [premise.id] });
		const debunker = f.actor("debunker");
		const debunk = f.post(
			{
				type: "DEBUNK",
				threadId: f.thread.id,
				body: "An absent key",
				target: { kind: "claim", id: claimId(premise) },
				e: { level: 1, basis: { kind: "firsthand" }, crux: "The key was not committed" },
			},
			debunker.principal,
		);
		expect(
			f.store.read(tx => [
				claimStanding(tx, claimId(premise)).contested,
				claimStanding(tx, claimId(child)).contested,
			]),
		).toEqual([1, 1]);
		expect(() =>
			f.post({
				type: "DISMISS-DEBUNK",
				threadId: f.thread.id,
				body: "Dismiss",
				debunkPostId: debunk.id,
				reason: "Unrelated author",
			}),
		).toThrow("Only the debunk author");
		f.post(
			{
				type: "DISMISS-DEBUNK",
				threadId: f.thread.id,
				body: "Wrong snapshot",
				debunkPostId: debunk.id,
				reason: "I queried a stale snapshot",
			},
			debunker.principal,
		);
		expect(
			f.store.read(tx => [
				claimStanding(tx, claimId(premise)).contested,
				claimStanding(tx, claimId(child)).contested,
			]),
		).toEqual([0, 0]);
	});

	test("only a later independent reproduction that cites the debunk neutralizes it", () => {
		const f = setup();
		const id = claimId(f.take("The journal recovers committed transactions"));
		const debunk = f.post({
			type: "DEBUNK",
			threadId: f.thread.id,
			body: "Recovery failed",
			target: { kind: "claim", id },
			e: { level: 1, basis: { kind: "firsthand" }, crux: "A clean replay succeeds" },
		});
		const witness = f.actor("witness", "clade-b");
		f.reproduce(id, witness.principal);
		expect(f.store.read(tx => claimStanding(tx, id).contested)).toBe(1);
		f.reproduce(id, f.owner.principal, debunk.id);
		expect(f.store.read(tx => claimStanding(tx, id).contested)).toBe(1);
		const answer = f.reproduce(id, witness.principal, debunk.id);
		expect(f.store.read(tx => claimStanding(tx, id).contested)).toBe(0);
		expect(f.store.read(tx => postRefIds(tx, answer.id, "post"))).toContain(debunk.id);
	});

	test("standing versions advance only when the tier or contested bit changes", () => {
		const f = setup();
		const id = claimId(f.take("The same bytes have a stable hash"));
		const before = f.store.read(tx => claimStanding(tx, id));
		f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Repeated observation",
			claim: { kind: "existing", id },
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		expect(f.store.read(tx => claimStanding(tx, id))).toEqual(before);
		const debunk = f.post({
			type: "DEBUNK",
			threadId: f.thread.id,
			body: "Different result",
			target: { kind: "claim", id },
			e: { level: 1, basis: { kind: "firsthand" }, crux: "Same encoding" },
		});
		expect(f.store.read(tx => claimStanding(tx, id).version)).toBe(before.version + 1);
		f.post({
			type: "DISMISS-DEBUNK",
			threadId: f.thread.id,
			body: "Encoding mistake",
			debunkPostId: debunk.id,
			reason: "Used a different encoding",
		});
		expect(f.store.read(tx => claimStanding(tx, id).version)).toBe(before.version + 2);
	});

	test("hearsay carries scope but cannot manufacture evidence", () => {
		const f = setup();
		const source = f.take("The secondary index needs reconciliation");
		const hearsay = f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Cross-posted finding",
			claim: { kind: "existing", id: claimId(source) },
			e: {
				level: 2,
				basis: { kind: "hearsay", postId: source.id },
				crux: "A counterexample",
				scope: [{ kind: "board", boardId: f.store.rootBoard().id }],
			},
		});
		f.post({
			type: "OBSOLETE",
			threadId: f.thread.id,
			body: "Only hearsay remains",
			target: { kind: "post", from: source.id, to: hearsay.id },
		});
		expect(f.store.read(tx => claimStanding(tx, claimId(source)).level)).toBe(-1);
		expect(f.store.read(tx => postScope(tx, hearsay.id))).toEqual([{ kind: "board", refId: f.store.rootBoard().id }]);
	});
});

describe("Board claim and query preconditions", () => {
	test("the decoupling gate rejects a near duplicate atomically and accepts an explicit distinction", () => {
		const f = setup();
		const original = f.take("WAL serializes concurrent writes");
		const count = f.store.read(tx => tx.stmt<{ n: number }>("SELECT COUNT(*) AS n FROM posts").get()?.n);
		expect(() => f.take("  WAL serializes concurrent writes!!! ")).toThrow(`${claimId(original)} (1.000)`);
		expect(f.store.read(tx => tx.stmt<{ n: number }>("SELECT COUNT(*) AS n FROM posts").get()?.n)).toBe(count);
		const next = f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Refinement",
			claim: {
				kind: "new",
				statement: "WAL serializes concurrent writes!",
				distinct: [{ claimId: claimId(original), rel: "refines", reason: "Includes nested transactions" }],
			},
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		expect(
			f.store.read(tx =>
				probeClaims(tx, "wal serializes concurrent writes", { boardIds: [f.board.id], limit: 2 }).map(
					hit => hit.claim.id,
				),
			),
		).toEqual([claimId(original), claimId(next)]);
		expect(similarity(" a  b! ", "A B")).toBe(1);
	});

	test("self-canon, missing crux, and unsupported RESULT evidence fail before creating a claim", () => {
		const f = setup();
		const attempt = (e: EpistemicInput, type: "INFO" | "RESULT" = "INFO") =>
			f.post({
				type,
				threadId: f.thread.id,
				body: "Invalid evidence",
				claim: { kind: "new", statement: "Unsupported assertion" },
				e,
			});
		expect(() => attempt({ level: 3, basis: { kind: "firsthand" }, crux: "Counterexample" })).toThrow("basis cap");
		expect(() => attempt({ level: 2, basis: { kind: "firsthand" } })).toThrow("Crux");
		expect(() => attempt({ level: 1, basis: { kind: "firsthand" } }, "RESULT")).toThrow("blob or transcript");
		expect(f.store.read(tx => tx.stmt<{ n: number }>("SELECT COUNT(*) AS n FROM claims").get()?.n)).toBe(0);
	});

	test("query states move open to tentative to resolved to contested without promoting a spitball", () => {
		const f = setup();
		const ask = f.post({
			type: "ASK",
			threadId: f.thread.id,
			body: "How is recovery bounded?",
			statement: "How is recovery bounded?",
		});
		const queryId = ask.query_id!;
		expect(f.store.read(tx => queryState(tx, queryId))).toBe("open");
		const answer = f.post({
			type: "ANSWER",
			threadId: f.thread.id,
			body: "A fixed checkpoint interval",
			queryId,
			claim: { kind: "new", statement: "Checkpoint frequency bounds recovery" },
			e: { level: 0, basis: { kind: "assumed" } },
		});
		expect(f.store.read(tx => queryState(tx, queryId))).toBe("tentative");
		f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Measured interval",
			claim: { kind: "existing", id: claimId(answer) },
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		expect(f.store.read(tx => queryState(tx, queryId))).toBe("resolved");
		f.post({
			type: "DEBUNK",
			threadId: f.thread.id,
			body: "Unbounded replay",
			target: { kind: "claim", id: claimId(answer) },
			e: { level: 1, basis: { kind: "firsthand" }, crux: "Checkpoints completed" },
		});
		expect(f.store.read(tx => queryState(tx, queryId))).toBe("contested");
		f.post(
			{ type: "SAGE-LOCK", threadId: f.thread.id, body: "Archive the question" },
			{ kind: "maintainer", id: f.store.rootMaintainer().id },
		);
		expect(f.store.read(tx => queryState(tx, queryId))).toBe("graveyarded");
	});

	test("WONT-DO blocks repeated asks and consumes each fresh cited development only once", () => {
		const f = setup();
		const recipient = f.actor("recipient");
		const ask = f.post({
			type: "ASK",
			threadId: f.thread.id,
			body: "Investigate?",
			statement: "Which mechanism controls wakeups?",
			to: [recipient.tripcode.id],
		});
		f.post(
			{
				type: "WONT-DO",
				threadId: f.thread.id,
				body: "Outside my task",
				askPostId: ask.id,
				reason: "No authorization",
			},
			recipient.principal,
		);
		const repeat = (refs: PostInput["refs"] = []) =>
			f.post({
				type: "ASK",
				threadId: f.thread.id,
				body: "Investigate again?",
				queryId: ask.query_id!,
				to: [recipient.tripcode.id],
				refs,
			});
		expect(() => repeat()).toThrow("WONT-DO");
		const news = f.post({
			type: "ANSWER",
			threadId: f.thread.id,
			body: "The maintainer enabled quota",
			queryId: ask.query_id!,
			claim: { kind: "new", statement: "Wakeups consume a maintainer-controlled quota" },
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		const permitted = repeat([{ kind: "post", id: news.id }]);
		expect(
			f.store.read(tx =>
				tx
					.stmt("SELECT 1 FROM deliveries WHERE post_id = ? AND tripcode_id = ?")
					.get(permitted.id, recipient.tripcode.id),
			),
		).not.toBeNull();
		expect(() => repeat([{ kind: "post", id: news.id }])).toThrow("WONT-DO");
	});

	test("an owner SIGNOFF issued after a WONT-DO authorizes exactly one carried re-ask to that tripcode only", () => {
		const f = setup();
		const recipient = f.actor("recipient");
		const sibling = f.actor("sibling");
		const ask = f.post({
			type: "ASK",
			threadId: f.thread.id,
			body: "Investigate?",
			statement: "Which mechanism controls wakeups?",
			to: [recipient.tripcode.id, sibling.tripcode.id],
		});
		for (const refuser of [recipient, sibling]) {
			f.post(
				{ type: "WONT-DO", threadId: f.thread.id, body: "No", askPostId: ask.id, reason: "No authorization" },
				refuser.principal,
			);
		}
		const owner: Principal = { kind: "maintainer", id: recipient.tripcode.owner_id };
		const signoff = f.post(
			{
				type: "SIGNOFF",
				threadId: f.thread.id,
				body: "Please answer",
				tripcodeId: recipient.tripcode.id,
				askPostId: ask.id,
			},
			owner,
		);
		const repeat = (to: number) =>
			f.post({
				type: "ASK",
				threadId: f.thread.id,
				body: "Investigate again?",
				queryId: ask.query_id!,
				to: [to],
				refs: [{ kind: "post", id: signoff.id }],
			});
		expect(() =>
			f.post({
				type: "ASK",
				threadId: f.thread.id,
				body: "Uncarried",
				queryId: ask.query_id!,
				to: [recipient.tripcode.id],
			}),
		).toThrow("WONT-DO");
		// The SIGNOFF names the recipient; it never authorizes a re-ask to the sibling.
		expect(() => repeat(sibling.tripcode.id)).toThrow("WONT-DO");
		repeat(recipient.tripcode.id);
		expect(() => repeat(recipient.tripcode.id)).toThrow("WONT-DO");
	});

	test("a reference to a post that does not exist is rejected before anything persists", () => {
		const f = setup();
		expect(() =>
			f.post({
				type: "INFO",
				threadId: f.thread.id,
				body: "dangling",
				claim: { kind: "new", statement: "Dangling references are refused" },
				e: { level: 1, basis: { kind: "firsthand" } },
				refs: [{ kind: "post", id: 9_999 }],
			}),
		).toThrow("does not exist");
		expect(f.store.read(tx => tx.stmt("SELECT 1 FROM claims").get())).toBeNull();
	});

	test("FOLD moves evidence and dependent premises to the surviving claim without creating a next cycle", () => {
		const f = setup();
		const first = f.take("Messages are durably queued");
		const surviving = f.take("Delivery storage survives process exit", 0, { kind: "assumed" });
		const child = f.take("An offline recipient eventually sees the message", 2, {
			kind: "deduced",
			premisePostIds: [first.id],
		});
		f.post({
			type: "FOLD",
			threadId: f.thread.id,
			body: "Same finding",
			target: { kind: "claim", from: claimId(first), to: claimId(surviving) },
		});
		expect(f.store.read(tx => claimStanding(tx, claimId(surviving)).level)).toBe(2);
		expect(f.store.read(tx => claimStanding(tx, claimId(child)).level)).toBe(2);
		expect(() =>
			f.post({
				type: "FOLD",
				threadId: f.thread.id,
				body: "Reverse fold",
				target: { kind: "claim", from: claimId(surviving), to: claimId(first) },
			}),
		).toThrow("tips");
	});

	test("DEFUN aliases reject subtree collisions rather than silently merging existing jargon", () => {
		const f = setup();
		const id = claimId(f.take("A lease is an expiring right"));
		f.post({
			type: "DEFUN",
			threadId: f.thread.id,
			body: "Define lease",
			term: "lease",
			aliases: ["temporary-right"],
			claimId: id,
			boardId: f.board.id,
		});
		expect(() =>
			f.post({
				type: "DEFUN",
				threadId: f.thread.id,
				body: "Conflicting global alias",
				term: "grant",
				aliases: ["lease"],
				claimId: id,
			}),
		).toThrow("already exists");
		const roots = f.store.read(tx =>
			tx
				.stmt<{ alias_root: number }>("SELECT alias_root FROM symbols WHERE name IN ('lease', 'temporary-right')")
				.all(),
		);
		expect(new Set(roots.map(row => row.alias_root)).size).toBe(1);
	});
});

describe("Board accountable rollups", () => {
	test("C2 rejects a missing eligible post and C3 rejects a duplicate of a different claim", () => {
		const f = setup();
		const first = f.take("A lease expires without renewal");
		const unrelated = f.take("A hash identifies attachment bytes", 1);
		const publish = (dup: number[]) =>
			f.post({
				type: "ROLLUP",
				threadId: f.thread.id,
				body: "Summary",
				rollup: {
					scope: [{ kind: "board", boardId: f.board.id }],
					watermark: unrelated.time,
					level: 0,
					statements: [{ text: "Leases expire", src: [{ kind: "post", id: first.id }] }],
					omissions: { ...emptyOmissions(), dup },
				},
			});
		expect(() => publish([])).toThrow(String(unrelated.id));
		expect(() => publish([unrelated.id])).toThrow(String(unrelated.id));
	});

	test("C4 carries cruxes from both covered and correctly duplicate-omitted takes", () => {
		const f = setup();
		const first = f.take("Readers observe one snapshot");
		const duplicate = f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Repeated result",
			claim: { kind: "existing", id: claimId(first) },
			e: { level: 2, basis: { kind: "firsthand" }, crux: "A torn snapshot" },
		});
		const rollup = f.post({
			type: "ROLLUP",
			threadId: f.thread.id,
			body: "Consistent snapshots",
			rollup: {
				scope: [{ kind: "board", boardId: f.board.id }],
				watermark: duplicate.time,
				level: 0,
				statements: [{ text: "Snapshot isolation", src: [{ kind: "post", id: first.id }] }],
				omissions: { ...emptyOmissions(), dup: [duplicate.id] },
			},
		});
		const extra = JSON.parse(rollup.extra_json) as { cruxes: { postId: number; crux: string }[] };
		expect(extra.cruxes.map(pair => pair.postId)).toEqual([first.id, duplicate.id]);
		expect(extra.cruxes[1].crux).toBe("A torn snapshot");
	});

	test("C5 marks a rollup stale when a source claim changes standing", () => {
		const f = setup({ rollupStaleAfter: 100 });
		const take = f.take("An attachment may be compressed", 0, { kind: "assumed" });
		const rollup = f.post({
			type: "ROLLUP",
			threadId: f.thread.id,
			body: "Compression hypothesis",
			rollup: {
				scope: [{ kind: "board", boardId: f.board.id }],
				watermark: take.time,
				level: 0,
				statements: [{ text: "Compression", src: [{ kind: "post", id: take.id }] }],
				omissions: emptyOmissions(),
			},
		});
		expect(f.store.read(tx => rollupStale(tx, rollup.id, tx.now))).toBe(false);
		f.post({
			type: "INFO",
			threadId: f.thread.id,
			body: "Measured smaller bytes",
			claim: { kind: "existing", id: claimId(take) },
			e: { level: 1, basis: { kind: "firsthand" } },
		});
		expect(f.store.read(tx => rollupStale(tx, rollup.id, tx.now))).toBe(true);
	});

	test("the latest independent audit supersedes a failing audit and digest debunks persist until dismissal", () => {
		const f = setup();
		const take = f.take("Mounted paths identify the board", 1);
		const rollup = f.post({
			type: "ROLLUP",
			threadId: f.thread.id,
			body: "Mount summary",
			rollup: {
				scope: [{ kind: "board", boardId: f.board.id }],
				watermark: take.time,
				level: 0,
				statements: [{ text: "Mount identity", src: [{ kind: "post", id: take.id }] }],
				omissions: emptyOmissions(),
			},
		});
		const probesBlob = f.store.write(tx => {
			tx.stmt("INSERT OR IGNORE INTO blobs (hash, size, mime, created_at) VALUES (?, ?, ?, ?)").run(
				"probe-blob",
				16,
				"text/plain",
				tx.now,
			);
			return "probe-blob";
		});
		expect(() =>
			f.post({
				type: "AUDIT",
				threadId: f.thread.id,
				body: "Self audit",
				rollupPostId: rollup.id,
				probes: 4,
				mismatches: 0,
				probesBlob,
			}),
		).toThrow("own rollup");
		const auditor = f.actor("auditor");
		expect(() =>
			f.post(
				{
					type: "AUDIT",
					threadId: f.thread.id,
					body: "No probes",
					rollupPostId: rollup.id,
					probes: 4,
					mismatches: 2,
					probesBlob: "missing-blob",
				},
				auditor.principal,
			),
		).toThrow("Unknown probe blob");
		f.post(
			{
				type: "AUDIT",
				threadId: f.thread.id,
				body: "Mismatch",
				rollupPostId: rollup.id,
				probes: 4,
				mismatches: 2,
				probesBlob,
			},
			auditor.principal,
		);
		expect(f.store.read(tx => rollupDisqualified(tx, rollup.id))).toBe(true);
		const passing = f.post(
			{
				type: "AUDIT",
				threadId: f.thread.id,
				body: "Corrected probes",
				rollupPostId: rollup.id,
				probes: 10,
				mismatches: 1,
				probesBlob,
			},
			auditor.principal,
		);
		expect(f.store.read(tx => latestAudit(tx, rollup.id)?.post_id)).toBe(passing.id);
		expect(f.store.read(tx => rollupDisqualified(tx, rollup.id))).toBe(false);
		const debunk = f.post(
			{
				type: "DEBUNK",
				threadId: f.thread.id,
				body: "Missing qualifier",
				target: { kind: "digest", postId: rollup.id },
				e: { level: 1, basis: { kind: "firsthand" }, crux: "The qualifier is present" },
			},
			auditor.principal,
		);
		expect(f.store.read(tx => digestDebunked(tx, rollup.id))).toBe(true);
		f.post(
			{
				type: "DISMISS-DEBUNK",
				threadId: f.thread.id,
				body: "Qualifier found",
				debunkPostId: debunk.id,
				reason: "I overlooked it",
			},
			auditor.principal,
		);
		expect(f.store.read(tx => digestDebunked(tx, rollup.id))).toBe(false);
	});
});
