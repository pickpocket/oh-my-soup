//! Generated wrong-target properties for whole-text `replace` matching and
//! `patch` hunk placement.
//!
//! Every case plants one intended target block `T` among filler lines whose
//! glyph alphabets are pairwise disjoint, plus optional decoys:
//! - marker decoys: `T` with one glyph swapped on a marker line that the query
//!   never alters except by whitespace;
//! - far decoys: `T` with up to three glyphs swapped on that marker line, so on
//!   long lines they can clear the similarity threshold while needing clearly
//!   more edits than `T`;
//! - inverted decoys: `T` carrying the query's typos on one long line and one
//!   glyph swapped on a short marker line, so they need fewer edits than `T`
//!   yet score lower; only the best-scoring window may ever be taken;
//! - twins: byte-identical copies of `T`;
//! - overlaps: one period of `T` placed flush against it, so a second copy of
//!   `T` shares lines (and bytes) with the first. `T` itself may be periodic
//!   (its lines repeat with a period shorter than `T`), which makes the shared
//!   span partial.
//!
//! The query is derived from `T` alone (uniform indent shift, trailing
//! whitespace, doubled inner space, glyph typo on a non-marker line), so every
//! marker decoy is strictly farther from the query than `T`, and every other
//! window either is a copy of `T` or contains a line sharing no glyph with the
//! query line it faces. Without assuming any scoring constant, a consumer may
//! therefore observe only: the edit lands exactly on `T` (every byte before and
//! after `T` preserved), no edit, or an ambiguity error. Any second copy of
//! `T`, overlapping or not, makes the target genuinely ambiguous, so it must
//! never be edited. A small set of outcomes is forced independently of
//! thresholds: an exact query must edit (or, with a second copy, be refused),
//! and a whitespace-only query with no decoy must edit.
//! `.md` replacement rows inherit the preceding row's indentation, so forced
//! edits never change Markdown block structure; structure-changing insertions
//! are refused by contract and covered by dedicated tests.
//!
//! `patch` cases may add what the patch contract lets a hunk use to single
//! out one copy: an `@@` Markdown heading on a fresh line right above `T` in a
//! `.md` file (copies outside the heading's section drop out; a heading with
//! an empty section bounds nothing), possibly with a twin of the
//! anchor line heading the decoys before `T` (a line hint inside `T`'s block
//! then picks the right anchor; otherwise the hunk's own lines must be unique
//! in the file), a unique lead hunk on a fresh line before `T` or after every
//! copy (a disjoint lead never narrows `T`'s candidate set), and a line hint
//! (a hint naming `T`'s first line exactly picks it; a hint never names another
//! copy or the twin anchor's block). Ambiguity is judged among all copies left
//! in scope, and a kept context line must keep the file's bytes. A separate
//! lane pairs anchored hunks: unique changed rows may exclude conflicting
//! placements, but different effects cannot be assigned to copies in order.
//!
//! Cases come from a deterministic parametric generator (Padhye et al.,
//! "Semantic Fuzzing with Zest", ISSTA 2019, §3.1): proptest draws small
//! untyped choices and `build_case` maps any choice vector to a valid case,
//! recomputing byte offsets, the target line and the case flags. Because
//! validity is re-established by the builder, shrinking the choices keeps
//! every reduced case valid (internal reduction, `MacIver` & Donaldson,
//! ECOOP 2020, §2.2). The RNG is fixed, so the sampled set is reproducible and
//! the per-lane outcome counters prove both edit and no-edit lanes ran.

mod common;

use std::{cell::Cell, fmt::Write};

use common::{DiskWriter, Workspace};
use pi_edit::{
	EditMode,
	fuzzy::{
		FindMatchOptions, ReplaceOutcome, SequenceSearchResult, find_match, levenshtein_distance,
		replace_text, seek_sequence,
	},
};
use proptest::{
	collection::vec,
	option,
	prelude::*,
	test_runner::{RngAlgorithm, TestCaseError, TestRng, TestRunner},
};
use serde_json::json;

/// Glyphs an inverted decoy swaps on its marker line: it is that many edits
/// from the query, so `T` counts as further away only beyond twice that, plus
/// one for a swap the alignment may split.
const INVERTED_DECOY_EDITS: usize = 1;

const LOWER: &str = "abcdefghijklmnopqrstuvwx";
const GREEK: &str = "αβγδεζηθικλμνξοπρστυφχψω";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWX";
const PATH: &str = "target.txt";
/// `patch` cases run on Markdown, whose syntax tree gives an `@@ # heading`
/// anchor the region of its section.
const PATCH_PATH: &str = "target.md";
/// Similarity thresholds the `replace` properties sample from.
const THRESHOLDS: [f64; 3] = [0.85, 0.9, 0.95];

/// Exclusive three-glyph alphabet of the `index`-th generated line: one
/// one-byte and two differently cased glyphs, one of them two bytes wide, so
/// byte and char offsets disagree.
fn alphabet(index: usize) -> [char; 3] {
	let pick = |set: &str| set.chars().nth(index).expect("at most 24 generated lines");
	[pick(LOWER), pick(GREEK), pick(UPPER)]
}

#[derive(Debug, Clone, Copy)]
enum IndentStyle {
	TwoSpaces,
	FourSpaces,
	Tab,
}

impl IndentStyle {
	fn render(self, level: u8) -> String {
		let unit = match self {
			Self::TwoSpaces => "  ",
			Self::FourSpaces => "    ",
			Self::Tab => "\t",
		};
		unit.repeat(usize::from(level))
	}
}

#[derive(Debug, Clone)]
struct LineSpec {
	level:  u8,
	first:  Vec<u8>,
	second: Option<Vec<u8>>,
}

impl LineSpec {
	fn render(&self, indent: IndentStyle, glyphs: [char; 3]) -> String {
		let word = |choices: &[u8]| {
			choices
				.iter()
				.map(|choice| glyphs[usize::from(*choice) % 3])
				.collect::<String>()
		};
		let mut line = indent.render(self.level);
		line.push_str(&word(&self.first));
		if let Some(second) = &self.second {
			line.push(' ');
			line.push_str(&word(second));
		}
		line
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecoyKind {
	Marker,
	Far,
	Inverted,
	Twin,
	Overlap,
}

#[derive(Debug, Clone)]
struct DecoySpec {
	kind:         DecoyKind,
	after_target: bool,
	gap:          Option<LineSpec>,
	pos:          u8,
	step:         bool,
}

#[derive(Debug, Clone)]
enum Perturb {
	IndentShift { tab: bool, width: u8 },
	TrailingWhitespace { line: u8, tab: bool },
	DoubleSpace { line: u8 },
	Typo { line: u8, pos: u8, step: bool },
}

#[derive(Debug, Clone)]
struct ReplacementLine {
	level:  u8,
	digits: Vec<u8>,
}

/// Untyped choices; every value maps to a valid [`Case`].
#[derive(Debug, Clone)]
struct Params {
	target:           Vec<LineSpec>,
	/// Odd values make a multi-line `T` periodic.
	period:           u8,
	marker:           u8,
	before:           Vec<LineSpec>,
	after:            Vec<LineSpec>,
	decoys:           Vec<DecoySpec>,
	perturbs:         Vec<Perturb>,
	replacement:      Vec<ReplacementLine>,
	indent:           IndentStyle,
	/// Picks the `replace` similarity threshold from [`THRESHOLDS`].
	threshold:        u8,
	trailing_newline: bool,
	crlf:             bool,
	bom:              bool,
	crlf_query:       bool,
	/// `patch` hunks keep one query line as a context line.
	patch_context:    bool,
	/// Picks which query line stays context.
	context_at:       u8,
	/// `patch` hunks re-add every removed line before the replacement.
	echo_removed:     bool,
	/// `patch` hunks add a copy of the context line before the replacement.
	echo_context:     bool,
	/// The line hint names a near-miss decoy instead of an offset from `T`.
	hint_on_decoy:    bool,
	/// `patch` hunks carry an `@@` anchor: a fresh `# heading` right before
	/// `T`, with `T` indented beneath it.
	anchor:           bool,
	/// A twin of the anchor line heads the decoys placed before `T`.
	twin_anchor:      bool,
	/// `patch` sends a unique hunk on a fresh line first.
	lead_hunk:        bool,
	/// Picks the lead hunk's line among the fresh lines allowed for it.
	lead_pick:        u8,
	/// `patch` hunk line hint, as an offset from `T`'s first line.
	hint:             Option<i8>,
}

fn line_spec() -> impl Strategy<Value = LineSpec> {
	(0u8..=2, vec(0u8..3, 2..=12), option::of(vec(0u8..3, 2..=12)))
		.prop_map(|(level, first, second)| LineSpec { level, first, second })
}

fn decoy_spec() -> impl Strategy<Value = DecoySpec> {
	(
		prop_oneof![
			3 => Just(DecoyKind::Marker),
			1 => Just(DecoyKind::Far),
			2 => Just(DecoyKind::Inverted),
			2 => Just(DecoyKind::Twin),
			1 => Just(DecoyKind::Overlap)
		],
		any::<bool>(),
		option::of(line_spec()),
		any::<u8>(),
		any::<bool>(),
	)
		.prop_map(|(kind, after_target, gap, pos, step)| DecoySpec {
			kind,
			after_target,
			gap,
			pos,
			step,
		})
}

fn perturb() -> impl Strategy<Value = Perturb> {
	prop_oneof![
		(any::<bool>(), 1u8..=3).prop_map(|(tab, width)| Perturb::IndentShift { tab, width }),
		(any::<u8>(), any::<bool>())
			.prop_map(|(line, tab)| Perturb::TrailingWhitespace { line, tab }),
		any::<u8>().prop_map(|line| Perturb::DoubleSpace { line }),
		(any::<u8>(), any::<u8>(), any::<bool>()).prop_map(|(line, pos, step)| Perturb::Typo {
			line,
			pos,
			step
		}),
	]
}

fn replacement_line() -> impl Strategy<Value = ReplacementLine> {
	(0u8..=2, vec(0u8..10, 1..=4)).prop_map(|(level, digits)| ReplacementLine { level, digits })
}

fn params() -> impl Strategy<Value = Params> {
	(
		vec(line_spec(), 1..=4),
		any::<[u8; 5]>(),
		vec(line_spec(), 0..=3),
		vec(line_spec(), 0..=3),
		vec(decoy_spec(), 0..=2),
		vec(perturb(), 0..=3),
		vec(replacement_line(), 0..=3),
		prop_oneof![
			Just(IndentStyle::TwoSpaces),
			Just(IndentStyle::FourSpaces),
			Just(IndentStyle::Tab)
		],
		any::<[bool; 11]>(),
		option::of(prop_oneof![2 => Just(0i8), 1 => -3i8..=3]),
	)
		.prop_map(
			|(
				target,
				[period, marker, threshold, lead_pick, context_at],
				before,
				after,
				decoys,
				perturbs,
				replacement,
				indent,
				[
					trailing_newline,
					crlf,
					bom,
					crlf_query,
					patch_context,
					anchor,
					twin_anchor,
					lead_hunk,
					echo_removed,
					hint_on_decoy,
					echo_context,
				],
				hint,
			)| Params {
				target,
				period,
				marker,
				before,
				after,
				decoys,
				perturbs,
				replacement,
				indent,
				threshold,
				trailing_newline,
				crlf,
				bom,
				crlf_query,
				patch_context,
				context_at,
				echo_removed,
				echo_context,
				hint_on_decoy,
				anchor,
				twin_anchor,
				lead_hunk,
				lead_pick,
				hint,
			},
		)
}

/// One materialized case over LF content.
#[derive(Debug)]
struct Case {
	content:               String,
	/// Byte range of `T` in `content`, excluding its trailing newline.
	target_start:          usize,
	target_end:            usize,
	/// 0-based line index of the first line of `T`.
	target_line:           usize,
	query:                 String,
	replacement:           String,
	/// `replace` similarity threshold.
	threshold:             f64,
	/// First line of every line-aligned placement of `T` in `content`,
	/// overlapping ones included.
	copy_lines:            Vec<usize>,
	/// Marker, far and inverted decoys: near misses of `T`.
	marker_decoys:         usize,
	/// An inverted decoy needs fewer edits than `T` (the query's typos make
	/// `T` at least two edits away) while scoring lower.
	fewer_edit_rival:      bool,
	query_is_exact:        bool,
	query_whitespace_only: bool,
	crlf:                  bool,
	bom:                   bool,
	crlf_query:            bool,
	patch_context:         bool,
	/// Which query line the hunk keeps as context.
	context_at:            usize,
	echo_removed:          bool,
	echo_context:          bool,
	/// The line hint names this near-miss decoy's first line.
	hint_on_decoy:         Option<usize>,
	/// `patch` anchor line index and text, and the end of its region.
	anchor:                Option<(usize, String)>,
	anchor_end:            usize,
	/// A twin of the anchor line and the end of its region.
	twin_anchor:           Option<(usize, usize)>,
	/// `patch` lead hunk: a unique fresh line edited first.
	lead:                  Option<(usize, String)>,
	/// `patch` line hint (0-based), never exactly on another copy of `T` and
	/// never only inside the twin anchor's block (unless it names a decoy).
	hint:                  Option<usize>,
}

impl Case {
	const fn ambiguous(&self) -> bool {
		self.copy_lines.len() > 1
	}

	/// Edits forced regardless of thresholds: the exact target text occurs
	/// once, or the query equals `T` modulo whitespace and nothing else shares a
	/// glyph with it.
	const fn must_edit(&self) -> bool {
		!self.ambiguous() && self.clearly_closest()
	}

	/// The query picks `T` over every other window without any scoring
	/// constant.
	const fn clearly_closest(&self) -> bool {
		self.query_is_exact || (self.query_whitespace_only && self.marker_decoys == 0)
	}
}

/// Byte-level occurrences of `needle`, overlapping ones included.
fn overlapping_occurrences(haystack: &str, needle: &str) -> usize {
	let mut count = 0;
	let mut from = 0;
	while let Some(offset) = haystack[from..].find(needle) {
		count += 1;
		let at = from + offset;
		from = at + haystack[at..].chars().next().map_or(1, char::len_utf8);
	}
	count
}

/// Swap one glyph of `line` for a different glyph of the same alphabet, so the
/// line keeps sharing no glyph with any other generated line.
fn swap_glyph(line: &str, glyphs: [char; 3], pos: u8, step: bool) -> String {
	let positions: Vec<(usize, char)> = line
		.char_indices()
		.filter(|(_, glyph)| glyphs.contains(glyph))
		.collect();
	let (at, current) = positions[usize::from(pos) % positions.len()];
	let index = glyphs
		.iter()
		.position(|glyph| *glyph == current)
		.expect("glyph from this alphabet");
	let replacement = glyphs[(index + 1 + usize::from(step)) % 3];
	let mut swapped = String::with_capacity(line.len() + 1);
	swapped.push_str(&line[..at]);
	swapped.push(replacement);
	swapped.push_str(&line[at + current.len_utf8()..]);
	swapped
}

fn without_whitespace(text: &str) -> String {
	text
		.chars()
		.filter(|glyph| !glyph.is_whitespace())
		.collect()
}

fn build_case(params: &Params) -> Result<Case, TestCaseError> {
	let mut next_alphabet = 0;
	let mut fresh_line = |spec: &LineSpec| {
		let glyphs = alphabet(next_alphabet);
		next_alphabet += 1;
		(spec.render(params.indent, glyphs), glyphs)
	};
	let k = params.target.len();
	// An inverted decoy needs a short marker line and a separate long line
	// that carries every query typo.
	let inverted = k >= 2
		&& params
			.decoys
			.iter()
			.any(|decoy| decoy.kind == DecoyKind::Inverted);
	// A periodic `T` repeats its first `period` lines; aperiodic when `period ==
	// k`.
	let period = if !inverted && k >= 2 && params.period % 2 == 1 {
		1 + usize::from(params.period / 2) % (k - 1)
	} else {
		k
	};
	let marker = usize::from(params.marker) % k;
	let typo_line = (marker + 1) % k;
	// Under an `@@` anchor, `T` sits indented beneath it.
	let (base_lines, base_glyphs): (Vec<String>, Vec<[char; 3]>) = params.target[..period]
		.iter()
		.enumerate()
		.map(|(index, spec)| {
			let level = if params.anchor {
				spec.level.max(1)
			} else {
				spec.level
			};
			let spec = if inverted && index == marker {
				LineSpec { level, first: vec![0, 1], second: None }
			} else if inverted && index == typo_line {
				let long: Vec<u8> = (0..12)
					.map(|at| spec.first[at % spec.first.len()])
					.collect();
				LineSpec { level, first: long.clone(), second: Some(long) }
			} else {
				LineSpec { level, ..spec.clone() }
			};
			fresh_line(&spec)
		})
		.unzip();
	let target_lines: Vec<String> = (0..k)
		.map(|index| base_lines[index % period].clone())
		.collect();
	let target_glyphs: Vec<[char; 3]> = (0..k).map(|index| base_glyphs[index % period]).collect();
	// A query typo swaps one glyph; on the long line of an inverted case, two
	// glyphs seven positions apart.
	let typo = |line: &str, glyphs: [char; 3], pos: u8, step: bool| {
		let once = swap_glyph(line, glyphs, pos, step);
		if inverted {
			swap_glyph(&once, glyphs, pos.wrapping_add(7), step)
		} else {
			once
		}
	};
	let typo_index = |line: u8| {
		if inverted {
			return Some(typo_line);
		}
		let index = usize::from(line) % k;
		if index != marker {
			Some(index)
		} else if k == 1 {
			None
		} else {
			Some((marker + 1) % k)
		}
	};
	// `T`'s typo line with only the query's typos, as an inverted decoy has it.
	let typoed = params
		.perturbs
		.iter()
		.fold(target_lines[typo_line].clone(), |line, perturb| match *perturb {
			Perturb::Typo { pos, step, .. } if inverted => {
				typo(&line, target_glyphs[typo_line], pos, step)
			},
			_ => line,
		});
	let decoy_lines = |decoy: &DecoySpec| match decoy.kind {
		DecoyKind::Inverted if inverted => {
			let mut lines = target_lines.clone();
			lines[typo_line].clone_from(&typoed);
			lines[marker] = swap_glyph(&lines[marker], target_glyphs[marker], decoy.pos, decoy.step);
			lines
		},
		DecoyKind::Marker | DecoyKind::Inverted => {
			let mut lines = target_lines.clone();
			lines[marker] = swap_glyph(&lines[marker], target_glyphs[marker], decoy.pos, decoy.step);
			lines
		},
		DecoyKind::Far => {
			let mut lines = target_lines.clone();
			for offset in 0..3 {
				lines[marker] = swap_glyph(
					&lines[marker],
					target_glyphs[marker],
					decoy.pos.wrapping_add(offset),
					decoy.step,
				);
			}
			lines
		},
		DecoyKind::Twin => target_lines.clone(),
		// One period, laid flush against `T` below.
		DecoyKind::Overlap => base_lines.clone(),
	};
	// In a periodic `T` a query typo can reproduce a marker decoy's swapped
	// line, so marker decoys there always keep a foreign gap line between
	// themselves and any copy of `T`. A twin before `T` keeps one too, so a
	// lead hunk may sit between the two copies.
	let default_gap = LineSpec { level: 0, first: vec![0, 1], second: None };
	let gap_of = |decoy: &DecoySpec| {
		decoy.gap.clone().or_else(|| {
			let near_miss =
				matches!(decoy.kind, DecoyKind::Marker | DecoyKind::Far | DecoyKind::Inverted);
			((near_miss && period < k) || (decoy.kind == DecoyKind::Twin && !decoy.after_target))
				.then(|| default_gap.clone())
		})
	};
	let flush = |decoy: &&DecoySpec| decoy.kind == DecoyKind::Overlap;

	let mut lines: Vec<String> = Vec::new();
	// Fresh filler and gap lines: unique, so a lead hunk may edit one.
	let mut fresh = Vec::new();
	// Line ranges of every decoy, and first lines of the near misses.
	let mut blocks = Vec::new();
	let mut near_misses = Vec::new();
	let near_miss = |decoy: &DecoySpec| {
		matches!(decoy.kind, DecoyKind::Marker | DecoyKind::Far | DecoyKind::Inverted)
	};
	for spec in &params.before {
		lines.push(fresh_line(spec).0);
		fresh.push(lines.len() - 1);
	}
	let header = params.anchor.then(|| {
		format!("# {}", fresh_line(&LineSpec { level: 0, first: vec![0, 1, 2, 0], second: None }).0)
	});
	let twin_line = header
		.as_ref()
		.filter(|_| params.twin_anchor)
		.map(|header| {
			lines.push(header.clone());
			lines.len() - 1
		});
	let (before_flush, before_spaced): (Vec<&DecoySpec>, Vec<&DecoySpec>) = params
		.decoys
		.iter()
		.filter(|decoy| !decoy.after_target)
		.partition(flush);
	for decoy in before_spaced {
		let start = lines.len();
		lines.extend(decoy_lines(decoy));
		blocks.push(start..lines.len());
		if near_miss(decoy) {
			near_misses.push(start);
		}
		if let Some(gap) = gap_of(decoy) {
			lines.push(fresh_line(&gap).0);
			fresh.push(lines.len() - 1);
		}
	}
	let anchor = header.map(|header| {
		lines.push(header.clone());
		(lines.len() - 1, header)
	});
	for decoy in before_flush {
		let start = lines.len();
		lines.extend(decoy_lines(decoy));
		blocks.push(start..lines.len());
		if near_miss(decoy) {
			near_misses.push(start);
		}
	}
	let target_line = lines.len();
	lines.extend(target_lines.iter().cloned());
	let (after_flush, after_spaced): (Vec<&DecoySpec>, Vec<&DecoySpec>) = params
		.decoys
		.iter()
		.filter(|decoy| decoy.after_target)
		.partition(flush);
	for decoy in after_flush {
		let start = lines.len();
		lines.extend(decoy_lines(decoy));
		blocks.push(start..lines.len());
		if near_miss(decoy) {
			near_misses.push(start);
		}
	}
	for decoy in after_spaced {
		if let Some(gap) = gap_of(decoy) {
			lines.push(fresh_line(&gap).0);
			fresh.push(lines.len() - 1);
		}
		let start = lines.len();
		lines.extend(decoy_lines(decoy));
		blocks.push(start..lines.len());
		if near_miss(decoy) {
			near_misses.push(start);
		}
	}
	for spec in &params.after {
		lines.push(fresh_line(spec).0);
		fresh.push(lines.len() - 1);
	}
	let copy_lines: Vec<usize> = (0..=lines.len() - k)
		.filter(|start| lines[*start..*start + k] == target_lines[..])
		.collect();
	// A heading's region is its Markdown section: up to the next heading of
	// the same level, or EOF. A heading with an empty section bounds nothing,
	// so its region runs to EOF.
	let region_end = |header: usize| {
		(header + 1..lines.len())
			.find(|index| lines[*index].starts_with("# "))
			.filter(|next| *next > header + 1)
			.unwrap_or(lines.len())
	};
	let anchor_end = anchor
		.as_ref()
		.map_or(lines.len(), |(line, _)| region_end(*line));
	let twin_anchor = twin_line.map(|line| (line, region_end(line)));
	// The lead edits a fresh line before `T`, or after every copy and decoy.
	// Its location cannot narrow the target hunk's candidate set.
	let last_block_end = blocks
		.iter()
		.map(|block| block.end)
		.chain([target_line + k])
		.max()
		.unwrap_or(0);
	let leads: Vec<usize> = fresh
		.iter()
		.copied()
		.filter(|line| *line < target_line || *line >= last_block_end)
		.collect();
	let lead = (params.lead_hunk && anchor.is_none() && !leads.is_empty()).then(|| {
		let line = leads[usize::from(params.lead_pick) % leads.len()];
		(line, lines[line].clone())
	});
	// A hint landing exactly on another copy names that copy, and one only
	// inside the twin anchor's block names that block; keep hints that point
	// at `T` or at no copy.
	let hint_on_decoy = near_misses
		.first()
		.copied()
		.filter(|_| params.hint_on_decoy && params.hint.is_some() && !params.anchor);
	let hint = params.hint.map(|offset| {
		if let Some(decoy) = hint_on_decoy {
			return decoy;
		}
		let line = (target_line as isize + isize::from(offset)).max(0) as usize;
		let names_copy = line != target_line && copy_lines.contains(&line);
		let in_real_block = anchor
			.as_ref()
			.is_some_and(|(header, _)| (*header..anchor_end).contains(&line));
		let names_twin =
			!in_real_block && twin_anchor.is_some_and(|(twin, end)| (twin..end).contains(&line));
		if names_copy || names_twin {
			target_line
		} else {
			line
		}
	});
	let mut content = lines.join("\n");
	if params.trailing_newline {
		content.push('\n');
	}
	let target_text = target_lines.join("\n");
	let target_start: usize = lines[..target_line].iter().map(|line| line.len() + 1).sum();
	let target_end = target_start + target_text.len();

	let mut query_lines = target_lines.clone();
	for perturb in &params.perturbs {
		match *perturb {
			Perturb::IndentShift { tab, width } => {
				let shift = if tab {
					"\t".to_owned()
				} else {
					" ".repeat(usize::from(width))
				};
				for line in &mut query_lines {
					line.insert_str(0, &shift);
				}
			},
			Perturb::TrailingWhitespace { line, tab } => {
				query_lines[usize::from(line) % k].push(if tab { '\t' } else { ' ' });
			},
			Perturb::DoubleSpace { line } => {
				let text = &mut query_lines[usize::from(line) % k];
				let lead = text.len() - text.trim_start().len();
				let separator = text[lead..].trim_end().find(' ');
				if let Some(offset) = separator {
					text.insert(lead + offset, ' ');
				}
			},
			Perturb::Typo { line, pos, step } => {
				let Some(index) = typo_index(line) else {
					continue;
				};
				query_lines[index] = typo(&query_lines[index], target_glyphs[index], pos, step);
			},
		}
	}
	let query = query_lines.join("\n");
	let query_is_exact = query == target_text;
	let query_whitespace_only =
		query_lines
			.iter()
			.zip(&target_lines)
			.all(|(query_line, target_line)| {
				without_whitespace(query_line) == without_whitespace(target_line)
			});

	let replacement = params
		.replacement
		.iter()
		.map(|line| {
			let mut text = params.indent.render(line.level);
			text.extend(
				line
					.digits
					.iter()
					.map(|digit| char::from(b'0' + digit % 10)),
			);
			text
		})
		.collect::<Vec<_>>()
		.join("\n");

	let marker_decoys = params
		.decoys
		.iter()
		.filter(|decoy| {
			matches!(decoy.kind, DecoyKind::Marker | DecoyKind::Far | DecoyKind::Inverted)
		})
		.count();
	let fewer_edit_rival = inverted
		&& params
			.decoys
			.iter()
			.any(|decoy| decoy.kind == DecoyKind::Inverted)
		&& levenshtein_distance(&target_lines[typo_line], &typoed) > 2 * INVERTED_DECOY_EDITS + 1;

	// Generator self-check: the query occurs verbatim (overlaps included) only
	// at the line-aligned copies of `T`, and never when perturbed, so the exact
	// path cannot pick another region.
	let occurrences = overlapping_occurrences(&content, &query);
	let expected = if query_is_exact { copy_lines.len() } else { 0 };
	if occurrences != expected || content[target_start..target_end] != target_text {
		return Err(TestCaseError::fail(format!(
			"generator invariant broken: query occurs {occurrences}x, expected {expected}x"
		)));
	}

	Ok(Case {
		content,
		target_start,
		target_end,
		target_line,
		query,
		replacement,
		threshold: THRESHOLDS[usize::from(params.threshold) % THRESHOLDS.len()],
		copy_lines,
		marker_decoys,
		fewer_edit_rival,
		query_is_exact,
		query_whitespace_only,
		crlf: params.crlf,
		bom: params.bom,
		crlf_query: params.crlf_query,
		patch_context: params.patch_context,
		context_at: usize::from(params.context_at) % k,
		echo_removed: params.echo_removed,
		echo_context: params.echo_context,
		hint_on_decoy,
		anchor,
		anchor_end,
		twin_anchor,
		lead,
		hint,
	})
}

/// The edit replaced exactly `T`: every byte before and after it survives, and
/// the replaced span holds `wanted` modulo re-indentation.
fn check_target_edit(case: &Case, output: &str, wanted: &str) -> Result<(), String> {
	check_edit(
		case,
		&case.content[..case.target_start],
		&case.content[case.target_end..],
		output,
		wanted,
	)
}

/// `output` is `prefix`, then `wanted` modulo re-indentation, then `suffix`.
fn check_edit(
	case: &Case,
	prefix: &str,
	suffix: &str,
	output: &str,
	wanted: &str,
) -> Result<(), String> {
	if output.len() < prefix.len() + suffix.len()
		|| !output.starts_with(prefix)
		|| !output.ends_with(suffix)
	{
		return Err(format!(
			"edit escaped target bytes {}..{} of {:?}:\n{output:?}",
			case.target_start, case.target_end, case.content
		));
	}
	let middle = &output[prefix.len()..output.len() - suffix.len()];
	let landed: Vec<&str> = middle.split('\n').map(str::trim).collect();
	let expected: Vec<&str> = wanted.split('\n').map(str::trim).collect();
	if landed == expected {
		Ok(())
	} else {
		Err(format!("target replaced by {middle:?}, want {wanted:?} modulo indentation"))
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observed {
	Refused,
	Unchanged,
	EditedTarget,
}

fn replace_text_outcome(case: &Case) -> Result<Observed, TestCaseError> {
	let observed = match replace_text(
		&case.content,
		&case.query,
		&case.replacement,
		true,
		false,
		Some(case.threshold),
	) {
		Err(_) => Observed::Refused,
		Ok(ReplaceOutcome::Missed(outcome)) => {
			if outcome.occurrences.is_some_and(|count| count > 1) {
				Observed::Refused
			} else {
				Observed::Unchanged
			}
		},
		Ok(ReplaceOutcome::Replaced(result)) => {
			prop_assert_eq!(result.count, 1);
			check_target_edit(case, &result.content, &case.replacement)
				.map_err(TestCaseError::fail)?;
			Observed::EditedTarget
		},
	};
	if case.ambiguous() {
		prop_assert_ne!(
			observed,
			Observed::EditedTarget,
			"edited although a second copy of the target makes it ambiguous"
		);
		if case.query_is_exact {
			prop_assert_eq!(observed, Observed::Refused, "exact repeated occurrences must be refused");
		}
	} else if case.must_edit() {
		prop_assert_eq!(observed, Observed::EditedTarget, "unique target was not edited");
	}
	Ok(observed)
}

/// Whether `seek_sequence` accepted a placement (`Some(true)`), reported an
/// ambiguity (`Some(false)`), or found nothing (`None`).
fn seek_sequence_outcome(case: &Case) -> Result<Option<bool>, TestCaseError> {
	let lines: Vec<&str> = case.content.split('\n').collect();
	let pattern: Vec<&str> = case.query.split('\n').collect();
	let found = seek_sequence(&lines, &pattern, 0, false, true);
	// The exact tier reports every copy, overlapping ones included.
	if case.query_is_exact {
		prop_assert_eq!(found.match_count, Some(case.copy_lines.len()));
		prop_assert_eq!(found.match_indices.as_ref(), Some(&case.copy_lines));
	}
	// `patch` accepts a placement only when it is unambiguous.
	let accepted = found.index.filter(|_| found.match_count.unwrap_or(1) <= 1);
	if case.ambiguous() {
		prop_assert_eq!(accepted, None, "accepted one of several copies of the target");
	} else if let Some(index) = accepted {
		prop_assert_eq!(index, case.target_line, "accepted placement is not the target");
	}
	if case.query_whitespace_only && !case.ambiguous() {
		prop_assert_eq!(
			accepted,
			Some(case.target_line),
			"whitespace-only query was not placed on the target"
		);
	}
	Ok(if accepted.is_some() {
		Some(true)
	} else {
		(found.index.is_some() || found.match_count.is_some_and(|count| count > 1)).then_some(false)
	})
}

/// What one generated `patch` run exercised, for the lane counters.
#[derive(Debug, Clone, Copy, Default)]
struct PatchRun {
	written:            bool,
	/// Several copies of `T` in the hunk's scope.
	ambiguous:          bool,
	anchored:           bool,
	/// A copy of `T` lies outside the anchor's block.
	copy_outside:       bool,
	/// A twin anchor line was told apart by the line hint.
	twin_resolved:      bool,
	/// Several copies in scope, one of them named exactly by the line hint.
	hint_resolved:      bool,
	/// The lead hunk sits strictly between copies of `T`.
	lead_between:       bool,
	/// The context line is not the hunk's first line.
	inner_context:      bool,
	/// The hunk re-adds its removed lines.
	echoed:             bool,
	/// The hint named a near-miss decoy that ranks as a lower candidate.
	hint_on_lower_rank: bool,
	/// The written hunk was sent again.
	resent:             bool,
}

/// Whether a search placed the pattern anywhere, uniquely or not.
fn is_placed(result: &SequenceSearchResult) -> bool {
	result.index.is_some() || result.match_count.is_some_and(|count| count > 0)
}

/// Run one `patch` call on `content`: (error, bytes on disk, writer calls).
fn run_patch(content: &str, diff: &str) -> (Option<String>, String, usize) {
	run_patch_at(PATCH_PATH, content, diff)
}

/// [`run_patch`] on a file at `path`, whose extension selects the syntax tree.
fn run_patch_at(path: &str, content: &str, diff: &str) -> (Option<String>, String, usize) {
	let workspace = Workspace::new(EditMode::Patch);
	workspace.write(path, content);
	let writer = DiskWriter::default();
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("tokio runtime");
	let error = runtime
		.block_on(workspace.apply_json(
			&json!({ "path": path, "edits": [{ "op": "update", "diff": diff }] }),
			&writer,
		))
		.err()
		.map(|error| error.to_string());
	let on_disk = workspace.read(path).expect("target file survives");
	let writes = writer.requests.lock().len();
	(error, on_disk, writes)
}

/// Full `patch` tool run with one hunk whose removed lines are the query
/// (one query line kept as context when `patch_context` is set, which routes
/// placement through the line-sequence ladder instead of the whole-text
/// matcher; the removed lines re-added when `echo_removed` is set),
/// optionally under an `@@` anchor, with a line hint, or after a unique lead
/// hunk. A kept context line must keep the file's bytes, and a written hunk
/// that carries a context line or an anchor writes nothing when sent again.
fn patch_outcome(case: &Case) -> Result<PatchRun, TestCaseError> {
	let query_lines: Vec<&str> = case.query.split('\n').collect();
	let context = (case.patch_context && query_lines.len() >= 2).then_some(case.context_at);
	let mut diff = String::new();
	diff.push_str("@@");
	if let Some(hint) = case.hint {
		let (line, count) = (hint + 1, query_lines.len());
		let _ = write!(diff, " -{line},{count} +{line},{count} @@");
	}
	if let Some((_, anchor)) = &case.anchor {
		diff.push(' ');
		diff.push_str(anchor);
	}
	for (index, line) in query_lines.iter().enumerate() {
		diff.push_str(if context == Some(index) { "\n " } else { "\n-" });
		diff.push_str(line);
	}
	// Re-adding the removed lines before a replacement keeps them, in the
	// hunk's spelling; without a replacement the hunk would be a no-op.
	let echo = case.echo_removed && context.is_some() && !case.replacement.is_empty();
	// A `+` line equal to the context line is added text, never the context.
	let echo_context = case.echo_context && !case.replacement.is_empty();
	let preceding = query_lines[context.unwrap_or(0)];
	let prefix = &preceding[..preceding.len() - preceding.trim_start().len()];
	let replacement_row = |line: &str| format!("{prefix}{}", line.trim_start());
	let mut added = Vec::new();
	if let Some(index) = context.filter(|_| echo_context) {
		let line = replacement_row(query_lines[index]);
		diff.push_str("\n+");
		diff.push_str(&line);
		added.push(line);
	}
	if echo {
		for (index, line) in query_lines.iter().enumerate() {
			if context != Some(index) {
				let line = replacement_row(line);
				diff.push_str("\n+");
				diff.push_str(&line);
				added.push(line);
			}
		}
	}
	if !case.replacement.is_empty() {
		for line in case.replacement.split('\n') {
			let line = replacement_row(line);
			diff.push_str("\n+");
			diff.push_str(&line);
			added.push(line);
		}
	}
	let lead_replacement = case.lead.as_ref().map(|(_, lead)| {
		let prefix = &lead[..lead.len() - lead.trim_start().len()];
		format!("{prefix}9")
	});
	let reverse = case
		.lead
		.as_ref()
		.map(|(_, lead)| format!("{diff}\n@@\n-{lead}\n+{}", lead_replacement.as_deref().unwrap()));
	if let Some((_, lead)) = &case.lead {
		diff = format!("@@\n-{lead}\n+{}\n{diff}", lead_replacement.as_deref().unwrap());
	}
	let file_context = context.map(|index| {
		case.content[case.target_start..case.target_end]
			.split('\n')
			.nth(index)
			.unwrap_or_default()
	});
	let wanted = file_context
		.into_iter()
		.chain(added.iter().map(String::as_str))
		.collect::<Vec<_>>()
		.join("\n");
	// Copies inside the resolved anchor section count independently of the
	// disjoint lead hunk. A twin anchor requires its own hint or unique lines.
	let mut scope = case.copy_lines.clone();
	let mut twin_resolved = false;
	let mut copy_outside = false;
	// An anchor that resolves nowhere stands aside only for a strict-tier
	// placement of the hunk's own lines, so a near match may then be refused.
	let anchor_failed = if let Some((line, _)) = &case.anchor {
		let block = *line + 1..case.anchor_end;
		copy_outside = case.copy_lines.iter().any(|start| !block.contains(start));
		let holds =
			|start: usize, end: usize| case.hint.is_some_and(|hint| (start..end).contains(&hint));
		let resolved = match case.twin_anchor {
			None => true,
			Some((twin, twin_end)) => {
				twin_resolved = match (holds(*line, case.anchor_end), holds(twin, twin_end)) {
					(true, false) => true,
					(true, true) => case.hint == Some(*line),
					_ => false,
				};
				twin_resolved
			},
		};
		if resolved {
			scope.retain(|start| block.contains(start));
		}
		!resolved
	} else {
		false
	};
	let lead_between = case.lead.as_ref().is_some_and(|(line, _)| {
		scope.iter().any(|start| start > line) && case.copy_lines.iter().any(|start| start < line)
	});
	let hint_resolved = scope.len() > 1 && case.hint == Some(case.target_line);
	// A hint naming a near miss the ladder ranks below `T`: hints break ties
	// only among equally ranked candidates, so the hunk is refused.
	let hint_on_lower_rank = case.hint_on_decoy.is_some_and(|decoy| {
		let lines: Vec<&str> = case.content.split('\n').collect();
		let found = seek_sequence(&lines, &query_lines, 0, false, true);
		found.match_count.is_some_and(|count| count > 1)
			&& found
				.match_indices
				.as_ref()
				.is_some_and(|indices| indices.contains(&decoy))
			&& found
				.top_indices
				.as_ref()
				.is_some_and(|top| !top.contains(&decoy))
	});
	let run = PatchRun {
		written: false,
		ambiguous: scope.len() > 1 && !hint_resolved,
		anchored: case.anchor.is_some(),
		copy_outside,
		twin_resolved,
		hint_resolved,
		lead_between,
		inner_context: context.is_some_and(|index| index > 0),
		echoed: echo || (echo_context && context.is_some()),
		hint_on_lower_rank,
		resent: false,
	};
	let (error, on_disk, writes) = run_patch(&case.content, &diff);
	if let Some(reverse) = reverse {
		let (other_error, other_disk, other_writes) = run_patch(&case.content, &reverse);
		prop_assert_eq!(
			error.is_none(),
			other_error.is_none(),
			"hunk order changed the outcome\n{}\n{}",
			diff,
			reverse
		);
		prop_assert_eq!(&on_disk, &other_disk, "hunk order changed the bytes");
		prop_assert_eq!(writes, other_writes, "hunk order changed writer requests");
	}
	let written = error.is_none();
	let mut resent = false;
	if written {
		prop_assert_eq!(writes, 1);
		let mut prefix = case.content[..case.target_start].to_owned();
		let mut suffix = case.content[case.target_end..].to_owned();
		if let Some((line, lead)) = &case.lead {
			let part = if *line < case.target_line {
				&mut prefix
			} else {
				&mut suffix
			};
			*part = part.replacen(lead.as_str(), lead_replacement.as_deref().unwrap(), 1);
		}
		if added.is_empty() && context.is_none() {
			// Deleting `T` leaves its lines empty (whole-text placement) or drops
			// them with one of the line breaks around them (line placement).
			let joined = [
				format!("{prefix}{suffix}"),
				format!("{}{suffix}", prefix.strip_suffix('\n').unwrap_or(&prefix)),
				format!("{prefix}{}", suffix.strip_prefix('\n').unwrap_or(&suffix)),
			];
			prop_assert!(joined.contains(&on_disk), "deletion escaped `T`: {on_disk:?}\n{diff}");
		} else {
			// Deleting a final unterminated `T` also drops the line break before
			// it: `patch` keeps a file without a trailing newline newline-free.
			let checked = if suffix.is_empty()
				&& !prefix.is_empty()
				&& !on_disk.ends_with('\n')
				&& on_disk.len() + 1 == prefix.len()
			{
				std::borrow::Cow::Owned(format!("{on_disk}\n"))
			} else {
				std::borrow::Cow::Borrowed(on_disk.as_str())
			};
			check_edit(case, &prefix, &suffix, &checked, &wanted)
				.map_err(|miss| TestCaseError::fail(format!("{miss}\n{diff}")))?;
			if let Some(file_context) = file_context {
				let middle = &checked[prefix.len()..checked.len() - suffix.len()];
				prop_assert_eq!(
					middle.split('\n').next(),
					Some(file_context),
					"kept context line lost the file's bytes\n{}",
					diff
				);
			}
		}
		// Sending the same hunk again changes nothing. Only a hunk whose new
		// side shows where it landed (a context line or an anchor) and that
		// never re-adds the lines it removes can be recognised as applied.
		if (context.is_some() || case.anchor.is_some())
			&& !echo
			&& !echo_context
			&& !added.is_empty()
			&& case.query_whitespace_only
			&& case.copy_lines.len() == 1
			&& case.lead.is_none()
		{
			// Only a resend whose old lines still place in the written file
			// tests the already-applied check; otherwise they are just missing.
			let written_lines = on_disk.split('\n').collect::<Vec<_>>();
			resent = is_placed(&seek_sequence(&written_lines, &query_lines, 0, false, true));
			let (again, after, rewrites) = run_patch(&on_disk, &diff);
			prop_assert!(again.is_some(), "a resent hunk applied again\n{diff}\n{after:?}");
			prop_assert_eq!(rewrites, 0);
			prop_assert_eq!(&after, &on_disk, "a resent hunk changed the file");
		}
	} else {
		prop_assert_eq!(writes, 0, "rejected edit reached the writer");
		prop_assert_eq!(&on_disk, &case.content, "rejected edit changed the file");
	}
	if run.ambiguous || run.hint_on_lower_rank {
		prop_assert!(!written, "wrote although another candidate is in scope\n{diff}");
	} else if case.clearly_closest() && (case.query_is_exact || !anchor_failed) {
		prop_assert!(written, "unique target was not written: {:?}\n{diff}", error);
	}
	Ok(PatchRun { written, resent, ..run })
}

/// Full `replace` tool run over BOM/CRLF bytes on disk. Returns whether the
/// file was written.
fn session_outcome(case: &Case) -> Result<bool, TestCaseError> {
	let mut workspace = Workspace::new(EditMode::Replace);
	workspace.config.fuzzy_threshold = case.threshold;
	let bom = if case.bom { "\u{feff}" } else { "" };
	let original = if case.crlf {
		format!("{bom}{}", case.content.replace('\n', "\r\n"))
	} else {
		format!("{bom}{}", case.content)
	};
	// A file without any line break has no CRLF style to preserve, so the
	// written file's style follows the original bytes, not the CRLF flag.
	let ending = if original.contains("\r\n") {
		"\r\n"
	} else {
		"\n"
	};
	workspace.write(PATH, &original);
	let query = if case.crlf_query {
		case.query.replace('\n', "\r\n")
	} else {
		case.query.clone()
	};
	let writer = DiskWriter::default();
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("tokio runtime");
	let error = runtime
		.block_on(workspace.apply_json(
			&json!({ "path": PATH, "old_string": query, "new_string": case.replacement }),
			&writer,
		))
		.err()
		.map(|error| error.to_string());
	let on_disk = workspace.read(PATH).expect("target file survives");
	let writes = writer.requests.lock().len();
	let written = error.is_none();
	if written {
		prop_assert_eq!(writes, 1);
		let Some(body) = on_disk.strip_prefix(bom) else {
			return Err(TestCaseError::fail("BOM dropped"));
		};
		prop_assert!(!body.starts_with('\u{feff}'), "BOM introduced");
		let lf = body.replace("\r\n", "\n");
		prop_assert_eq!(body, lf.replace('\n', ending), "line endings not restored uniformly");
		check_target_edit(case, &lf, &case.replacement).map_err(TestCaseError::fail)?;
	} else {
		prop_assert_eq!(writes, 0, "rejected edit reached the writer");
		prop_assert_eq!(&on_disk, &original, "rejected edit changed the file");
	}
	if case.ambiguous() {
		prop_assert!(!written, "wrote although a second copy of the target makes it ambiguous");
	} else if case.must_edit() {
		prop_assert!(written, "unique target was not written: {:?}", error);
	}
	let matcher_edits = replace_text_outcome(case)? == Observed::EditedTarget;
	prop_assert_eq!(written, matcher_edits, "tool and matcher disagree: {:?}", error);
	Ok(written)
}

/// Run `property` over a fixed-seed sample; failures are shrunk through the
/// generator choices, so the reported case is still a valid one.
fn run_generated(cases: u32, property: impl Fn(&Case) -> Result<(), TestCaseError>) {
	let mut config = ProptestConfig::with_cases(cases);
	config.failure_persistence = None;
	let mut runner =
		TestRunner::new_with_rng(config, TestRng::deterministic_rng(RngAlgorithm::ChaCha));
	if let Err(error) = runner.run(&params(), |choices| property(&build_case(&choices)?)) {
		panic!("{error}");
	}
}

#[test]
fn replace_text_edits_only_the_intended_target() {
	let lanes = [Cell::new(0usize), Cell::new(0), Cell::new(0)];
	let ambiguous_refused = Cell::new(0usize);
	let edited_among_near_misses = Cell::new(0usize);
	let withheld_from_fewer_edit_rival = Cell::new(0usize);
	run_generated(512, |case| {
		let observed = replace_text_outcome(case)?;
		let lane = &lanes[observed as usize];
		lane.set(lane.get() + 1);
		if case.ambiguous() && observed == Observed::Refused {
			ambiguous_refused.set(ambiguous_refused.get() + 1);
		}
		// Another window also cleared the similarity threshold.
		let rivals = find_match(&case.content, &case.query, &FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(case.threshold),
			excluded_ranges: &[],
		})
		.fuzzy_matches
		.is_some_and(|count| count > 1);
		// The edit (already checked to land exactly on `T`) was taken among
		// near misses.
		if observed == Observed::EditedTarget && rivals {
			edited_among_near_misses.set(edited_among_near_misses.get() + 1);
		}
		// A rival needing fewer edits than `T` cleared the threshold, and
		// nothing was edited.
		if case.fewer_edit_rival && rivals && observed != Observed::EditedTarget {
			withheld_from_fewer_edit_rival.set(withheld_from_fewer_edit_rival.get() + 1);
		}
		Ok(())
	});
	let [refused, unchanged, edited] = lanes.map(Cell::into_inner);
	let ambiguous_refused = ambiguous_refused.into_inner();
	let edited_among_near_misses = edited_among_near_misses.into_inner();
	let withheld = withheld_from_fewer_edit_rival.into_inner();
	assert!(
		refused > 0
			&& unchanged > 0
			&& edited > 0
			&& ambiguous_refused > 0
			&& edited_among_near_misses > 0
			&& withheld > 0,
		"sample must exercise every outcome: refused={refused} (ambiguous={ambiguous_refused}) \
		 unchanged={unchanged} edited={edited} (with rivals={edited_among_near_misses}) withheld \
		 from a fewer-edit rival={withheld}"
	);
}

#[test]
fn seek_sequence_accepts_only_the_intended_target() {
	let lanes = [Cell::new(0usize), Cell::new(0), Cell::new(0)];
	run_generated(512, |case| {
		let lane = &lanes[match seek_sequence_outcome(case)? {
			Some(true) => 0,
			Some(false) => 1,
			None => 2,
		}];
		lane.set(lane.get() + 1);
		Ok(())
	});
	let [accepted, ambiguous, missing] = lanes.map(Cell::into_inner);
	assert!(
		accepted > 0 && ambiguous > 0 && missing > 0,
		"sample must exercise every outcome: accepted={accepted} ambiguous={ambiguous} \
		 missing={missing}"
	);
}

#[test]
fn replace_tool_writes_only_the_intended_target() {
	let lanes = [Cell::new(0usize), Cell::new(0)];
	run_generated(64, |case| {
		let lane = &lanes[usize::from(session_outcome(case)?)];
		lane.set(lane.get() + 1);
		Ok(())
	});
	let [rejected, written] = lanes.map(Cell::into_inner);
	assert!(
		rejected > 0 && written > 0,
		"sample must exercise both outcomes: rejected={rejected} written={written}"
	);
}

/// Each lane names the regression it guards:
/// - copy outside the anchor's section: syntax-tree anchor scoping;
/// - twin anchor told apart by the hint: `pick_anchor`'s region rule;
/// - lead strictly between copies: a disjoint hunk cannot discard earlier
///   candidates (dies with cursor-based narrowing);
/// - context at an inner line, and removed lines re-added: context lines paired
///   by the hunk's structure (dies with `keep_context_bytes` as a no-op or with
///   text pairing);
/// - hint on a lower-ranked near miss: hints only break ties among equally
///   ranked candidates (dies with the pre-round-2 hint rule);
/// - resent hunk: already-applied detection.
#[test]
fn patch_tool_writes_only_the_intended_target() {
	let runs = std::cell::RefCell::new(Vec::new());
	run_generated(768, |case| {
		runs.borrow_mut().push(patch_outcome(case)?);
		Ok(())
	});
	let runs = runs.into_inner();
	let count = |keep: fn(&PatchRun) -> bool| runs.iter().filter(|run| keep(run)).count();
	let lanes = [
		("written", count(|run| run.written)),
		("rejected", count(|run| !run.written)),
		("ambiguous rejected", count(|run| run.ambiguous && !run.written)),
		("anchored written", count(|run| run.anchored && run.written)),
		("copy outside the section", count(|run| run.copy_outside && run.written)),
		("twin anchor told apart", count(|run| run.twin_resolved && run.written)),
		("hint resolved", count(|run| run.hint_resolved && run.written)),
		("lead between copies", count(|run| run.lead_between && !run.written)),
		("inner context", count(|run| run.inner_context && run.written)),
		("removed lines re-added", count(|run| run.echoed && run.written)),
		("hint on a lower rank", count(|run| run.hint_on_lower_rank)),
		("resent", count(|run| run.resent)),
	];
	println!("PATCH_LANES={lanes:?}");
	assert!(lanes.iter().all(|(_, count)| *count > 0), "sample must exercise every lane: {lanes:?}");
}

/// How a section header scopes an anchored hunk: bracketed `.txt` headers
/// and Python comments bound nothing (the region runs to EOF), Python
/// classes bound their body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SectionStyle {
	Text,
	Comment,
	Class,
}

/// Two distinct key lines a section may hold, far apart under every
/// similarity tier, so only exact copies are candidates.
const SECTION_KEYS: [&str; 2] = ["retries = 3", "timeout_seconds = 120"];

/// A file of sections, each a header, a unique filler line and some keys:
/// (path, lines, header lines, region of each header).
fn section_file(
	style: SectionStyle,
	sections: &[Vec<u8>],
) -> (&'static str, Vec<String>, Vec<usize>, Vec<std::ops::Range<usize>>) {
	let indent = if style == SectionStyle::Class {
		"    "
	} else {
		""
	};
	let mut lines = Vec::new();
	let mut headers = Vec::new();
	let mut ends = Vec::new();
	for (index, keys) in sections.iter().enumerate() {
		headers.push(lines.len());
		lines.push(match style {
			SectionStyle::Text => format!("[s{index}]"),
			SectionStyle::Comment => format!("# --- s{index} ---"),
			SectionStyle::Class => format!("class S{index}:"),
		});
		lines.push(format!("{indent}filler_{index} = 0"));
		lines.extend(
			keys
				.iter()
				.map(|key| format!("{indent}{}", SECTION_KEYS[usize::from(*key) % 2])),
		);
		ends.push(lines.len());
	}
	let regions = headers
		.iter()
		.zip(&ends)
		.map(|(header, end)| {
			header + 1..if style == SectionStyle::Class {
				*end
			} else {
				lines.len()
			}
		})
		.collect();
	let path = if style == SectionStyle::Text {
		"notes.txt"
	} else {
		"settings.py"
	};
	(path, lines, headers, regions)
}

/// Anchored hunks resolve jointly in either listing order. Unique changed
/// rows may exclude competing placements; identical old text with different
/// effects remains ambiguous when neither hunk has an independent binding.
#[test]
fn patch_anchored_hunks_resolve_order_free_conflicts() {
	let lanes = std::cell::RefCell::new(std::collections::HashMap::<&str, usize>::new());
	let strategy = (0u8..3, vec(vec(0u8..2, 0..3), 2..5), any::<u8>(), any::<u8>(), 0u8..3, 0u8..2);
	let mut config = ProptestConfig::with_cases(256);
	config.failure_persistence = None;
	let mut runner =
		TestRunner::new_with_rng(config, TestRng::deterministic_rng(RngAlgorithm::ChaCha));
	let result = runner.run(&strategy, |(style, sections, anchor, lead, lead_kind, key)| {
		let style =
			[SectionStyle::Text, SectionStyle::Comment, SectionStyle::Class][usize::from(style)];
		let (path, lines, headers, regions) = section_file(style, &sections);
		let indent = if style == SectionStyle::Class {
			"    "
		} else {
			""
		};
		let anchor = usize::from(anchor) % sections.len();
		let lead = usize::from(lead) % sections.len();
		let key_line = format!("{indent}{}", SECTION_KEYS[usize::from(key)]);
		let copies_in = |region: &std::ops::Range<usize>| {
			region
				.clone()
				.filter(|line| lines[*line] == key_line)
				.collect::<Vec<_>>()
		};
		let (first, mut lead_candidates) = if lead_kind == 0 {
			(
				format!("@@ {}\n-{key_line}\n+{indent}lead = 7", lines[headers[lead]]),
				copies_in(&regions[lead]),
			)
		} else {
			let filler = headers[lead] + 1;
			let header = if lead_kind == 1 {
				String::new()
			} else {
				format!(" {}", lines[headers[lead]])
			};
			(format!("@@{header}\n-{}\n+{indent}lead = 7", lines[filler]), vec![filler])
		};
		let second = format!("@@ {}\n-{key_line}\n+{indent}target = 9", lines[headers[anchor]]);
		let mut target_candidates = copies_in(&regions[anchor]);
		let both_ambiguous = lead_candidates.len() > 1 && target_candidates.len() > 1;
		let overlapping = lead_candidates
			.iter()
			.any(|row| target_candidates.contains(row));
		loop {
			let sizes = (lead_candidates.len(), target_candidates.len());
			if let [only] = lead_candidates.as_slice() {
				target_candidates.retain(|row| row != only);
			}
			if let [only] = target_candidates.as_slice() {
				lead_candidates.retain(|row| row != only);
			}
			if sizes == (lead_candidates.len(), target_candidates.len()) {
				break;
			}
		}
		let expected = match (lead_candidates.as_slice(), target_candidates.as_slice()) {
			([lead], [target]) => Some((*lead, *target)),
			_ => None,
		};
		let lane = match expected {
			Some(_) if lead_kind == 0 && overlapping => "consumed copy excluded",
			Some(_) => "written",
			None if both_ambiguous => "different effects refused",
			None if lead_candidates.len() == 1 && target_candidates.len() > 1 => {
				"two unconsumed refused"
			},
			None => "refused",
		};
		*lanes.borrow_mut().entry(lane).or_default() += 1;
		if style == SectionStyle::Class && expected.is_some() {
			*lanes.borrow_mut().entry("written in a block").or_default() += 1;
		}
		let content = lines.join("\n") + "\n";
		let wanted = expected.map(|(lead_line, target_line)| {
			let mut want = lines.clone();
			want[lead_line] = format!("{indent}lead = 7");
			want[target_line] = format!("{indent}target = 9");
			want.join("\n") + "\n"
		});
		for diff in [format!("{first}\n{second}"), format!("{second}\n{first}")] {
			let (error, on_disk, writes) = run_patch_at(path, &content, &diff);
			if let Some(wanted) = &wanted {
				prop_assert!(error.is_none(), "{error:?}\n{diff}\n{content}");
				prop_assert_eq!(&on_disk, wanted, "{}\n{}", diff, content);
			} else {
				prop_assert!(error.is_some(), "wrote {on_disk:?}\n{diff}\n{content}");
				prop_assert_eq!(writes, 0);
				prop_assert_eq!(&on_disk, &content);
			}
		}
		Ok(())
	});
	if let Err(error) = result {
		panic!("{error}");
	}
	let lanes = lanes.into_inner();
	for lane in [
		"consumed copy excluded",
		"written",
		"two unconsumed refused",
		"different effects refused",
		"written in a block",
	] {
		assert!(lanes.get(lane).is_some_and(|count| *count > 0), "lane {lane} never ran: {lanes:?}");
	}
}

/// Block shapes that end an anchor's block for a line-based guess but not
/// for the syntax tree, in a real file of each language.
#[derive(Debug, Clone, Copy)]
struct RegionShape {
	/// A comment at column 0 between the anchored function and its twin.
	comment_between: bool,
	/// A decorator or annotation with multi-line arguments above it.
	decorator:       bool,
	/// A multi-line literal holding closer- and heading-like lines first in
	/// its body.
	literal:         bool,
	/// A signature spread over two lines.
	long_signature:  bool,
	/// The body's `{` alone on the next line (brace languages), or a clause
	/// keyword at the function's indentation (Ruby).
	allman:          bool,
}

/// A file holding `f` and its twin `g` with the same target line, the
/// anchor line of `f`, the indented target, and `f`'s first body line.
struct RegionFile {
	path:       &'static str,
	content:    String,
	anchor:     String,
	target:     String,
	first_body: usize,
}

fn region_file(language: usize, shape: RegionShape) -> RegionFile {
	// (path, indent, statement end, comment, signature lines, body opener,
	// literal, closer, twin header)
	let (path, indent, end, comment, signature, opener, literal, closer, twin): (
		&str,
		&str,
		&str,
		&str,
		&[&str],
		&str,
		&str,
		&str,
		&str,
	) = match language {
		0 => (
			"f.py",
			"    ",
			"",
			"# helpers",
			if shape.long_signature {
				&["def f(", "    a,", "):"]
			} else {
				&["def f(a):"]
			},
			"",
			"    text = \"\"\"\n}\nend\n# Heading\n\"\"\"",
			"",
			"def g(a):",
		),
		1 => (
			"f.js",
			"  ",
			";",
			"// helpers",
			if shape.long_signature {
				&["function f(a,", "  b)"]
			} else {
				&["function f(a)"]
			},
			"{",
			"  const text = `\n}\n# Heading\n`;",
			"}",
			"function g(a) {",
		),
		2 => (
			"f.c",
			"    ",
			";",
			"#define HELPERS 1",
			if shape.long_signature {
				&["int f(int a,", "      int b)"]
			} else {
				&["int f(int a)"]
			},
			"{",
			"    /*\n}\n#endif\n    */",
			"}",
			"int g(int a) {",
		),
		3 => (
			"f.rb",
			"  ",
			"",
			"# helpers",
			&["def f(a)"],
			"",
			"  text = <<~EOS\n  end\n  # Heading\n  EOS",
			"end",
			"def g(a)",
		),
		_ => (
			"f.go",
			"\t",
			"",
			"// helpers",
			if shape.long_signature {
				&["func f(a int,", "\tb int) int"]
			} else {
				&["func f(a int) int"]
			},
			"{",
			"\ttext := `\n}\n# Heading\n`\n\t_ = text",
			"}",
			"func g(a int) int {",
		),
	};
	let target = format!("{indent}total = compute(1){end}");
	let ret = format!("{indent}return total{end}");
	let mut lines: Vec<String> = Vec::new();
	if shape.decorator {
		lines.extend(["@cached(", "    size=1,", ")"].map(str::to_owned));
	}
	let anchor_at = lines.len();
	lines.extend(signature.iter().map(|line| (*line).to_owned()));
	if !opener.is_empty() {
		if shape.allman {
			lines.push(opener.to_owned());
		} else {
			let last = lines.last_mut().expect("signature");
			last.push(' ');
			last.push_str(opener);
		}
	}
	let first_body = lines.len();
	if shape.literal {
		lines.extend(literal.split('\n').map(str::to_owned));
	}
	// Ruby's clause keyword sits at the method's indentation; the target
	// then lies inside the `rescue` clause.
	if shape.allman && language == 3 {
		lines.push("rescue StandardError".to_owned());
	}
	lines.push(target.clone());
	lines.push(ret.clone());
	if !closer.is_empty() {
		lines.push(closer.to_owned());
	}
	if shape.comment_between {
		lines.push(comment.to_owned());
	}
	lines.push(twin.to_owned());
	lines.push(target.clone());
	lines.push(ret);
	if !closer.is_empty() {
		lines.push(closer.to_owned());
	}
	RegionFile {
		path,
		anchor: lines[anchor_at].clone(),
		content: lines.join("\n") + "\n",
		target,
		first_body,
	}
}

/// In every generated shape and language, an anchored hunk edits only the
/// anchored function's copy of a line its twin also holds, and an anchored
/// insertion lands at the top of the anchored function's body.
#[test]
fn patch_regions_follow_generated_block_shapes() {
	for language in 0..5 {
		for bits in 0u8..32 {
			let shape = RegionShape {
				comment_between: bits & 1 != 0,
				decorator:       bits & 2 != 0,
				literal:         bits & 4 != 0,
				long_signature:  bits & 8 != 0,
				allman:          bits & 16 != 0,
			};
			// Each shape a language has once: Python alone has decorators,
			// Ruby no multi-line signature, and Python and Go no Allman form.
			if (shape.decorator && language != 0)
				|| (shape.long_signature && language == 3)
				|| (shape.allman && !(1..=3).contains(&language))
			{
				continue;
			}
			let file = region_file(language, shape);
			let lines: Vec<&str> = file.content.lines().collect();
			let changed = file.target.replace("compute(1)", "compute(2)");
			let edit = format!("@@ {}\n-{}\n+{changed}", file.anchor, file.target);
			let (error, written, _) = run_patch_at(file.path, &file.content, &edit);
			let first = lines
				.iter()
				.position(|line| *line == file.target)
				.expect("target");
			let mut want: Vec<&str> = lines.clone();
			want[first] = &changed;
			assert_eq!(
				written,
				want.join("\n") + "\n",
				"{shape:?} {}: {error:?}\n{}",
				file.path,
				file.content
			);

			let indent = &file.target[..file.target.len() - file.target.trim_start().len()];
			let inserted = format!("{indent}inserted();");
			let insert = format!("@@ {}\n+{inserted}", file.anchor);
			let (error, written, _) = run_patch_at(file.path, &file.content, &insert);
			let mut want: Vec<&str> = lines.clone();
			want.insert(file.first_body, &inserted);
			assert_eq!(
				written,
				want.join("\n") + "\n",
				"{shape:?} {}: {error:?}\n{}",
				file.path,
				file.content
			);
		}
	}
}

/// A newline-free file has no line-ending style to preserve, even when the
/// generator's CRLF flag is set: a multi-line replacement lands with LF.
#[test]
fn replace_tool_writes_lf_into_newline_free_crlf_case() {
	let params = Params {
		target:           vec![LineSpec { level: 0, first: vec![0, 1, 2], second: None }],
		period:           0,
		marker:           0,
		before:           Vec::new(),
		after:            Vec::new(),
		decoys:           Vec::new(),
		perturbs:         Vec::new(),
		replacement:      vec![ReplacementLine { level: 0, digits: vec![1] }, ReplacementLine {
			level:  0,
			digits: vec![2],
		}],
		indent:           IndentStyle::TwoSpaces,
		threshold:        0,
		trailing_newline: false,
		crlf:             true,
		bom:              false,
		crlf_query:       false,
		patch_context:    false,
		context_at:       0,
		echo_removed:     false,
		echo_context:     false,
		hint_on_decoy:    false,
		anchor:           false,
		twin_anchor:      false,
		lead_hunk:        false,
		lead_pick:        0,
		hint:             None,
	};
	let case = build_case(&params).expect("valid case");
	assert!(!case.content.contains('\n'), "case must be a single unterminated line");
	match session_outcome(&case) {
		Ok(written) => assert!(written, "exact unique target must be written"),
		Err(error) => panic!("{error}"),
	}
}
