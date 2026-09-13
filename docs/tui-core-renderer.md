# TUI core renderer — the append-only contract

What you are dealing with before you touch the rendering engine. This is the
companion to [`tui-runtime-internals.md`](./tui-runtime-internals.md): that doc
maps the _flow_ (input → component tree → render); this doc explains the
**render contract, why it is shaped this way, and the invariants you must not
violate**. Scope is the core engine only:

- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — frame pipeline, commit ledger, window math, emitters, cursor placement.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — `ProcessTerminal`, capability probes, private-CSI reassembly.
- [`packages/tui/src/terminal-capabilities.ts`](../packages/tui/src/terminal-capabilities.ts) — `TERMINAL` profile, sync-output / DECCARA / image detection.
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts) — escape-sequence reassembly.
- [`packages/tui/src/utils.ts`](../packages/tui/src/utils.ts) — width/slice/wrap (the width model).
- [`packages/tui/src/kitty-graphics.ts`](../packages/tui/src/kitty-graphics.ts) + [`components/image.ts`](../packages/tui/src/components/image.ts) — inline images.
- [`packages/tui/src/deccara.ts`](../packages/tui/src/deccara.ts) — rectangular-fill optimizer.

Application-layer renderers (transcript, tool calls, session tree, editor,
widgets) are **out of scope** — they live in `packages/coding-agent`. The one
app-layer file that is load-bearing for this contract is
[`transcript-container.ts`](../packages/coding-agent/src/modes/components/transcript-container.ts),
which implements the commit-boundary seam described below.

---

## 1. The one thing to understand first

> **The renderer cannot observe the terminal's scroll position** (ConPTY's
> probe lies; POSIX has no API at all). The previous engine tried to _guess_
> when it was safe to rewrite native scrollback, and every policy choice over
> that unobservable variable traded one failure family for another (yank ↔
> flash ↔ corruption ↔ invisible-until-resize — see the git history of this
> file for the full war journal). The default engine removes the guess entirely:
> **native scrollback is append-only.** An opt-in divergence-rebuild mode can
> instead clear and replay scrollback outside multiplexers when finalized
> content no longer matches committed history (§2); it does not probe viewport
> position.

We keep the transcript on the **normal screen** (native scrollback, native
selection, transcript persists after exit). The engine maintains one ledger:

- **`committedRows` (C)** — frame rows `[0, C)` have entered terminal history.
  Ordinary emitters never rewrite them. An opt-in destructive divergence replay
  clears the ledger and rebuilds history from the current frame.
- **`windowTopRow` (W)** — the frame row mapped to grid row 0. The visible
  window is frame rows `[W, W + height)`, repainted with relative cursor moves.
- **live-region boundary (B)** — the first row that may still mutate, reported
  by `NativeScrollbackLiveRegion`. Rows before B are exact and audited.
  Unpinned mutable rows that leave the window commit as frozen visual
  snapshots. A pinned live region instead keeps its mutable suffix
  viewport-local until the boundary advances.

For an ordinary unpinned frame, `W = max(C, L - height)` and the new commit end
is `max(C, W)`, clamped to the frame. The only bytes that enter history are the
chunk between the old and new commit indices. Exact rows remain subject to the
committed-prefix audit; frozen mutable snapshots are deliberately outside the
exactness claim. In the default mode, scrollback therefore records every
committed row once, in order, with its bytes at commit time. The renderer never
needs to know whether the user has scrolled away from the tail.

### What this costs (the accepted tradeoffs)

- A block that has scrolled past the window top cannot reflow in place. Exact
  settled rows commit with their final bytes; an unpinned mutable row commits
  the snapshot visible when it scrolls off, so a later layout change leaves a
  stale historical row rather than rewriting native scrollback.
- A component tree that reports **no seam** gets shell semantics: whatever
  scrolls off is final. Shrinking such a frame into its committed prefix
  re-anchors the window and leaves the stale copy in history (§3).
- Inside ED3-unsafe multiplexers, a width change terminates the physical-row
  coordinate epoch. The renderer captures an opaque
  `NativeScrollbackWidthEpoch` marker from the last emitted source state before
  `SIGWINCH`, then resolves that same logical boundary after the settled-width
  render. Host-reflowed history stays immutable. Output queued during
  settlement is emitted only from the resolved old boundary to the current
  source boundary at the terminal-owned viewport bottom; the settled viewport
  then repaints in place. No old-width and new-width row counts are compared,
  and no old viewport row is recommitted. Components without the source
  contract retain the conservative physical-row fallback. Visible overlays
  freeze the seam and pinned live regions clip advancement at their final
  boundary. Height-only resizes retain the existing ledger.
- Direct HerdR panes are not in that category. HerdR's Ghostty core implements
  ED3, so OMS clears and replays its source-owned transcript after settlement,
  matching direct terminals. Repainting host-reflowed rows in place would
  harden soft wraps and leave residual rows after a later width reversal.

---

## 2. The frame pipeline (what you are editing)

Before composing a frame, the renderer checks the terminal's optional
`outputBackpressured` capability. `ProcessTerminal` reports its existing stdout
backlog state and notifies `onOutputDrain` listeners after resetting it. While
blocked, full, component, direct-animation, forced, and resize paint requests
retain their pending intent without composing or advancing the cursor/history
ledger. Input handling continues. Drain resumes the latest pending state; an
already-started frame is always written completely, never dropped halfway.
The TUI unsubscribes on stop and subscribes again on start. Custom terminals
without these optional capabilities retain the existing eager behavior.

`#doRender` per frame:

1. Compose the frame, collecting the first root child's
   `getNativeScrollbackLiveRegionStart()` and optional pinning policy.
2. Audit the committed exact prefix (`findCommittedPrefixResync`, skipped on
   geometry frames). The detector samples the prefix tail (up to 8 non-blank
   rows in the last 24, SGR-stripped). A single in-place mismatch is accepted
   as stale history; a structural shift re-anchors at the first changed row,
   favoring duplication over content loss. An in-place width change does not
   audit or re-slice the prior epoch's physical coordinates; it resolves the
   captured logical source marker in the settled-width frame.
3. Classify the frame as a gesture-driven full paint, an opt-in divergence
   rebuild, or an ordinary update and calculate the window/commit chunk.
   Overlays freeze commits. A pinned live region clips its offscreen mutable
   suffix instead of snapshotting it.
4. Extract cursor markers, prepare width-safe lines, slice the window, and
   composite overlays into the screen-coordinate window only.
5. Emit:

| Emitter                      | Bytes                                              | When                                                                |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `#emitFullPaint`             | home + committed chunk + window rows; optional ED3 | initial paint, explicit geometry/session/reset gestures, or rebuild |
| `#emitUpdate` scroll-append  | new bottom rows plus changed-row range             | rows leaving the screen are exactly the commit chunk                |
| `#emitUpdate` in-window diff | relative move plus changed-row rewrite             | nothing scrolls or commits                                          |
| `#emitUpdate` seam rewrite   | commit chunk plus full window rewrite              | commit/window re-anchor or hidden-gap backfill                      |

**ED3 (`CSI 3 J`) is emitted in exactly one place** —
`#emitFullPaint({ clearScrollback: true })`. The normal callers are explicit
user gestures: session replace/branch/resume
(`requestRender(true, { clearScrollback: true })`), resize outside a
multiplexer, and `resetDisplay()` (the display-reset chord, `Alt+L` by
default). It clears native history without `ED2` first; the replay overwrites
every row from home so terminals without synchronized output do not expose a
blank viewport. A gesture pins the user to the tail, so the history snap is
acceptable.

The second caller is an ordinary-render divergence when
`tui.scrollbackRebuild` is enabled: if the committed prefix structurally
resynchronizes or the current frame collapses into committed rows, the renderer
clears and replays the current frame to replace stale preview history with the
final form. This path is disabled by default and never runs after the first
paint, during an explicit replacement/geometry frame, or inside a multiplexer.
Multiplexers never get ED3 (it is a no-op there and a replay would duplicate
pane history).

The ordinary update path never emits ED2/ED3 or an absolute cursor home —
several terminal families snap a scrolled reader to the bottom on those.

### The commit-boundary seam (the load-bearing app contract)

`NativeScrollbackLiveRegion` has one boundary and one optional policy:

- `getNativeScrollbackLiveRegionStart()` returns the first local row that may
  still mutate. Rows before it are declared byte-stable at the current width.
- `isNativeScrollbackLiveRegionPinned()` keeps the mutable suffix
  viewport-local rather than recording frozen snapshots as it scrolls off.
  This is for replacing dashboards, not append-shaped transcript content.
- Reporting no seam gives shell semantics: rows commit as they scroll.

When multiple root children report a seam, the topmost seam wins because
commits are prefix-only. `NativeScrollbackCommittedRows` lets containers pass
the committed count down to children, and `NativeScrollbackReplay` lets
components release layout locks before a destructive replay.

`NativeScrollbackWidthEpoch` is the cross-width source contract. Capture reads
only state that produced the last emitted frame. Resolve projects that source
boundary into the newly rendered width, while the current-boundary method
identifies the logical suffix queued during settlement. Containers propagate
the marker through nested sources; Markdown snapshots its last rendered source
text, so a streaming update received before `SIGWINCH` cannot masquerade as
already-emitted output.

`TranscriptContainer` implements the application seam. It scans for the first
unfinalized transcript block. Finalized blocks before it are exact; that live
block may extend the exact boundary through
`getTranscriptBlockSettledRows()`. Assistant messages derive those settled
rows from completed content blocks and markdown's frozen-token prefix, while
constructs that can re-layout asynchronously (for example Mermaid) defer
settling. Pinning is propagated from the first live block; tool execution uses
it for replacing preview/dashboard states.

`AnchoredLiveContainer` marks transient HUD/status rows live at row zero and
pins them independently of the transcript's earlier live seam. The seam alone
does not prevent snapshots from entering history: the pin keeps these
replaceable rows viewport-only when a panel grows beyond the screen or collapses.

Transcript assembly also reports `RenderStablePrefix`: unchanged component
array references at unchanged offsets let the engine skip work over the
byte-identical prefix. Components that discard or lock committed material must
honor the committed-row and replay hooks. Freezing/settling is a correctness
contract, not a terminal-specific optimization.

---

## 3. Invariants — MUST / NEVER

1. **NEVER add a new `CSI 3 J` (ED3) callsite.** ED3 flows only through
   `#emitFullPaint({ clearScrollback: true })`, for explicit gestures or the
   guarded opt-in divergence rebuild, and never inside multiplexers.
2. **Ordinary emitters NEVER rewrite a committed row.** They treat frame rows
   `< C` as immutable. A shrink or structural resync may re-anchor below the old
   commit point, but in default mode stale history remains and new bytes are
   appended; it is never silently skipped. The opt-in divergence rebuild is the
   deliberate exception: it clears and replays the complete current frame.
3. **Commits are exactly the chunk.** Any byte shape that scrolls the screen
   must scroll only rows accounted for by the commit advance.
4. **An ED3-unsafe multiplexer width resize NEVER advances history.** The old
   committed physical-row coordinate is opaque after reflow. The resize leaves
   the host-reflowed viewport in place and establishes a complete-frame
   baseline independent of the native commit count. Subsequent growth writes
   the exact current-width rows newly crossing the seam—not blank scroll
   commands—then repaints the bounded viewport; only that slice advances
   commits. Visible overlays advance neither the baseline nor the seam ledger;
   overlay exit backfills the exact hidden slice. Pinned live regions advance
   only through their final boundary; finalization releases the deferred
   mutable slice. During a height shrink, only occupied old-frame rows actually
   moved into history by the host are excluded from the append-owned seam;
   empty viewport rows do not consume content-driven movement. Height-only
   resizes do not terminate the epoch. Direct HerdR uses ED3 source replay
   instead.
5. **NEVER probe the viewport position or fork on platform in the update
   path.** win32 behaves like POSIX. The probe APIs are gone; do not
   reintroduce them.
6. **Only declare rows exact when their bytes are stable.** Mutable transcript
   content may commit as an unpinned frozen snapshot, but rows before the seam
   remain under the exact-prefix audit.
7. **Park the hardware cursor at real content bottom**, not the padded window
   bottom, or height shrinks scroll live rows into history and duplicate them
   per resize step.
8. **Cursor writes live inside the synchronized-output frame**, before ESU —
   never as a second frame after it.
9. **NEVER throw in the render hot path.** Clamp over-wide lines
   (`truncateToWidth`); a width mismatch is cosmetic, not fatal.
10. **Multiplexers get no destructive clear and no history rewrap on resize** —
    repaint the window in place; pane history keeps its old wrap.
11. **Any change to the ledger math, the emitters, or the seam must be
    validated by the stress harness (§6)** across its full scenario matrix,
    not by a single-terminal smoke test.

---

## 4. Terminal capability detection

`TERMINAL` (`terminal-capabilities.ts`) is resolved once at import from
`TERMINAL_ID` plus environment sniffing; detection helpers are pure over
`(env, platform)` and unit-testable.

- `shouldEnableSynchronizedOutputByDefault(env, id)` → DEC 2026 default.
  Precedence: user opt-out (`PI_NO_SYNC_OUTPUT`/`PI_TUI_SYNC_OUTPUT=0`) → user
  force-on (`PI_FORCE_SYNC_OUTPUT=1`/`PI_TUI_SYNC_OUTPUT=1`) → `TERM_FEATURES`
  advertises `Sy` → `WT_SESSION` → known direct terminals → off for risky
  multiplexers and unknowns. Reconciled at runtime by the DECRQM mode-2026
  report; a user override still wins.
- `detectRectangularSgrSupport(id, env)` → DECCARA fills: kitty only, off in
  multiplexers and under `PI_NO_DECCARA`.
- `supportsScreenToScrollback` → kitty's ED22 (used once, on the initial
  paint, to preserve the pre-existing shell screen).
- Inline images require a recognized terminal profile, a successful existing
  runtime probe, or `PI_FORCE_IMAGE_PROTOCOL`. A bare `screen*`/`tmux*` TERM is
  not evidence of Kitty support; unknown terminals keep the text fallback.
  Explicit protocol overrides, including `off`, retain precedence.

The old ED3-risk classifier (`eagerEraseScrollbackRisk`, `PI_TUI_ED3_SAFE`,
`submitPinsViewportToTail`) is gone: behavior no longer depends on which
terminal is rendering, so there is no risk class to detect. Env sniffing now
only selects _optimizations_ (sync output, DECCARA, images), where a miss is
cosmetic, not corrupting.

---

## 5. Width model

`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi`
(`utils.ts`) all agree on **one UAX#11 width model**. Slicing, truncation,
wrapping, and segment extraction run on the native engine
(`@oh-my-soup/pi-natives`, Rust `unicode-width`); `visibleWidth` measures with
`Bun.stringWidth` **pinned to that same model** (`STRING_WIDTH_OPTS`:
`countAnsiEscapeCodes: false`, `ambiguousIsNarrow: true`) — a JSC builtin that
shares the native width tables without the per-call N-API box the native
scanner traps on under Bun 1.3.x. The two must never disagree; mixing unpinned
width models in measure-vs-slice produced crashes.

- Fast path: printable ASCII is one cell per code unit.
- Anything past the ASCII prefix measures through `Bun.stringWidth` (CSI/OSC
  stripped to zero); tabs are added back at the fixed `DEFAULT_TAB_WIDTH` columns.
- OSC 66 sized spans are added back as `scale × (explicit w ?? payload width)` —
  `Bun.stringWidth` would otherwise strip the whole span to zero.

**Rule:** any new measuring code routes through these helpers, and the hot
path clamps instead of throwing. Known residual: combining-heavy scripts
(Arabic harakat) survive painting verbatim, but ghostty-web's cell readback can
migrate non-spacing marks across cells — the stress harness compares those rows
with marks stripped (`sameLinesAllowingMarkDrift`).

---

## 6. The fidelity gate (use it)

`packages/tui/test/render-stress-harness.ts` drives the renderer's **real
emitted ANSI** into a ghostty-web `VirtualTerminal` across randomized op
sequences and parameterized terminal shapes, and validates the contract with a
**shadow commit ledger**: an independent reimplementation of §1's math, fed
only by observed frames (a `render` wrap) and observed bytes (a `write` wrap).
Per op it asserts:

- the whole tape (scrollback + grid) equals `shadowTape + window slice`, row
  for row, including across resizes;
- scrolled readers stay pinned and visible history rows are never rewritten;
- multiplexer pane history grows by exactly the committed chunk;
- sync-output/autowrap bracket discipline, cursor parking, background columns,
  duplicate accounting.

Run it — plus `render-regressions.test.ts`,
`streaming-scrollback-defer.test.ts`, and the `issue-*-repro.test.ts` files —
before changing ledger math, emitters, or the seam. A change that passes one
terminal and one seed is not verified.

---

## 7. Capability probes & stdin reassembly

`ProcessTerminal` fuses capability queries with a bare DA1 (`CSI c`) sentinel so
a non-answering terminal is detected when DA1 returns first. Replies can arrive
**split across a stdin flush**, so:

- `#privateCsiResponseBuffer` accumulates `\x1b[?…` partials while a sentinel is
  outstanding, rejoins on the terminator byte, then runs the handlers on the
  **complete** reply. A new `\x1b` mid-reassembly or >256 bytes abandons the
  partial so real keys still reach input.
- `#da1SentinelOwners` is a **typed FIFO** discriminated by `kind` so a
  keyboard DA1 cannot be mistaken for an OSC 11 / DECRQM / graphics-probe
  sentinel.
- DECRQM probes (2026/2048/2031) drive runtime feature gating.

**Rule:** any new probe must own a typed sentinel and survive a split reply
(feed the reply byte-by-byte in a test and assert nothing leaks to input).

---

## 8. Inline images & memory

Kitty images are **transmit-once, place-many** (`kitty-graphics.ts`).
`ImageBudget` keeps only the most-recent N images live; when the cap is
exceeded the demoted image's pixels are deleted by id (`a=d,d=I`) and its
visible rows re-render as the text fallback through the ordinary window diff —
**no destructive replay**. A demoted placement already committed to history
simply loses its pixels (committed rows are immutable), and the text fallback
is **height-preserving** once a graphic has rendered (reserved rows + fallback
line), so demotion never shrinks the block and never shifts committed content
below it.

**Rule:** never re-emit full base64 per frame. Kitty Unicode placeholders are
default-on only for kitty/ghostty (`PI_NO_KITTY_PLACEHOLDERS` /
`PI_KITTY_PLACEHOLDERS`).

---

## 9. Escape hatches (env vars)

| Var                                                      | Effect                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_NO_SYNC_OUTPUT=1`                                    | Disable DEC 2026 BSU/ESU wrappers (autowrap discipline stays on).                                                                                                           |
| `PI_TUI_SYNC_OUTPUT=0\|1` / `PI_FORCE_SYNC_OUTPUT=1`     | Force sync output off / on.                                                                                                                                                 |
| `PI_NO_DECCARA`                                          | Disable Kitty DECCARA rectangular-fill optimization.                                                                                                                        |
| `PI_FORCE_IMAGE_PROTOCOL=kitty\|iterm2\|sixel\|off`      | Override image protocol detection.                                                                                                                                          |
| `PI_NO_KITTY_PLACEHOLDERS=1` / `PI_KITTY_PLACEHOLDERS=1` | Force Kitty Unicode placeholders off / on.                                                                                                                                  |
| `PI_HARDWARE_CURSOR=1`                                   | Show the real hardware cursor instead of a rendered one.                                                                                                                    |
| `PI_NOTIFICATIONS=off\|0\|false`                         | Suppress terminal notifications.                                                                                                                                            |
| `PI_DEBUG_REDRAW=1`                                      | Log the chosen render intent + ledger state per frame to the debug log.                                                                                                     |
| `PI_TUI_RESIZE_IN_PLACE=1\|0`                            | Force resize to repaint in place (no alt-screen borrow, no ED3 rewrap) on / off. Default-on for terminals that re-report size on alt-screen toggles (Warp).                 |
| `PI_TUI_SCROLLBACK_REBUILD=1`                            | Initialize low-level `TUI` divergence rebuild on. Coding-agent subsequently applies `tui.scrollbackRebuild` (default `false`), so use the setting for interactive sessions. |

Removed with the old engine: `PI_TUI_ED3_SAFE` (no ED3-risk lever exists),
`PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` (per-render dump superseded by
`PI_DEBUG_REDRAW` ledger logging and the stress-harness replay/reduce tooling).

---

## 10. Before you touch the render core — checklist

- [ ] Are you about to emit `CSI 3 J` anywhere other than the existing
      `clearScrollback` full-paint path for a gesture or guarded divergence
      rebuild? **Stop.**
- [ ] Could an ordinary emitter rewrite a row below `committedRows`? **Stop.**
- [ ] Does your byte shape scroll rows not accounted for by the commit chunk?
      That breaks the append-only ledger.
- [ ] Are you adding a viewport probe, a platform fork, or a terminal-brand
      branch to the update path? The contract exists so none are needed.
- [ ] New mutable UI above the editor? It must report (or live inside) the
      live-region seam, or it will freeze at first commit.
- [ ] Did you run the stress harness and the repro suite across the full
      scenario matrix — not just one terminal and one seed?
- [ ] New probe? Typed sentinel owner + split-reply test.
- [ ] New width path? Routed through the shared native engine, clamped (never
      thrown) in the hot path.
