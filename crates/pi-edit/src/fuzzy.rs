//! Text/sequence matching primitives shared by `replace`, `patch`, and
//! `sloppy`: Levenshtein similarity, whole-block fuzzy search,
//! line-sequence placement, and context-line placement.

use std::{fmt::Write, ops::Range};

use crate::{
	error::EditError,
	text::{
		adjust_indentation, count_leading_whitespace, fuzzy_character, is_non_empty_line, js_trim,
		js_trim_end, js_trim_start, normalize_for_fuzzy, normalize_to_lf, normalize_unicode,
		utf16_len,
	},
};

/// Default similarity threshold for fuzzy matching.
pub const DEFAULT_FUZZY_THRESHOLD: f64 = 0.95;
/// Threshold for sequence-based fuzzy matching.
pub const SEQUENCE_FUZZY_THRESHOLD: f64 = 0.92;
/// Fallback threshold for line-based matching without indentation depth.
pub const FALLBACK_THRESHOLD: f64 = 0.8;
/// Threshold for context-line fuzzy matching.
pub const CONTEXT_FUZZY_THRESHOLD: f64 = 0.8;
/// Minimum normalized pattern length for partial matching.
pub const PARTIAL_MATCH_MIN_LENGTH: usize = 6;
/// Minimum pattern-to-line ratio for ambiguous substring matching.
pub const PARTIAL_MATCH_MIN_RATIO: f64 = 0.3;
/// Number of surrounding lines in occurrence previews.
pub const OCCURRENCE_PREVIEW_CONTEXT: usize = 5;
/// Maximum displayed line length in occurrence previews.
pub const OCCURRENCE_PREVIEW_MAX_LEN: usize = 80;
/// Occurrence previews and indices recorded before truncation.
pub const MAX_RECORDED_MATCHES: usize = 5;
/// A fuzzy hit at or above this confidence can dominate weaker siblings.
pub const DOMINANT_FUZZY_MIN_CONFIDENCE: f64 = 0.97;
/// Minimum confidence gap for a dominant fuzzy hit.
pub const DOMINANT_FUZZY_DELTA: f64 = 0.08;
/// Threshold for the final character-level sequence fallback.
pub const CHARACTER_MATCH_THRESHOLD: f64 = 0.92;

/// A located block of text.
#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyMatch {
	pub actual_text: String,
	/// Byte offset of the match start in the searched content.
	pub start_index: usize,
	/// 1-indexed line of the match start.
	pub start_line:  u32,
	pub confidence:  f64,
}

/// Outcome of [`find_match`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchOutcome {
	pub matched:             Option<FuzzyMatch>,
	pub closest:             Option<FuzzyMatch>,
	pub occurrences:         Option<usize>,
	/// 1-indexed start line of every ambiguous candidate: each exact
	/// occurrence, or each above-threshold fuzzy window.
	pub occurrence_lines:    Option<Vec<u32>>,
	/// Previews of the first [`MAX_RECORDED_MATCHES`] candidates.
	pub occurrence_previews: Option<Vec<String>>,
	/// Some exact occurrences share bytes, so a non-overlapping
	/// `replace_all` would replace fewer than `occurrences`.
	pub overlapping:         bool,
	pub fuzzy_matches:       Option<usize>,
	pub dominant_fuzzy:      Option<bool>,
}

/// A byte range excluded from matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExcludedRange {
	pub start_index: usize,
	pub end_index:   usize,
}

/// Knobs for [`find_match`].
#[derive(Debug, Clone, Default)]
pub struct FindMatchOptions<'a> {
	pub allow_fuzzy:     bool,
	/// Defaults to [`DEFAULT_FUZZY_THRESHOLD`].
	pub threshold:       Option<f64>,
	pub excluded_ranges: &'a [ExcludedRange],
}

/// Strategy which located a line sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceMatchStrategy {
	Exact,
	TrimTrailing,
	Trim,
	CommentPrefix,
	Unicode,
	Prefix,
	Substring,
	Fuzzy,
	FuzzyDominant,
	Character,
}

/// Result of a line-sequence search.
#[derive(Debug, Clone, PartialEq)]
pub struct SequenceSearchResult {
	pub index:         Option<usize>,
	pub confidence:    f64,
	/// Placements found by the accepting pass. More than one means `index` is
	/// only the first of several equally ranked candidates.
	pub match_count:   Option<usize>,
	/// Every placement counted in `match_count`, ascending.
	pub match_indices: Option<Vec<usize>>,
	/// Placements sharing the best rank, when the tier ranks its hits (the
	/// fuzzy tier scores them); a line hint may choose only among these.
	/// `None` means every placement in `match_indices` ranks equally.
	pub top_indices:   Option<Vec<usize>>,
	pub strategy:      Option<SequenceMatchStrategy>,
}

/// Strategy which located a context line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMatchStrategy {
	Exact,
	Trim,
	Unicode,
	Prefix,
	Substring,
	CaseFold,
	Fuzzy,
}

/// Result of a context-line search.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextLineResult {
	pub index:         Option<usize>,
	pub confidence:    f64,
	pub match_count:   Option<usize>,
	pub match_indices: Option<Vec<usize>>,
	pub strategy:      Option<ContextMatchStrategy>,
}

/// Positional evidence belongs to an actual FILE occurrence, including a
/// transformed function-name fallback. Whole-row fuzzy evidence is distinct.
#[derive(Debug)]
pub(crate) struct ContextOccurrence {
	pub row:               usize,
	pub span:              Range<usize>,
	pub whole_row:         bool,
	pub function_fallback: bool,
	pub strategy:          ContextMatchStrategy,
	/// A weaker same-row occurrence may veto ownership, never select it.
	pub veto_only:         bool,
}

#[derive(Debug)]
pub(crate) struct ContextEvidence {
	pub result:      ContextLineResult,
	pub occurrences: Vec<ContextOccurrence>,
}

pub(crate) fn anchor_case_eq(left: &str, right: &str) -> bool {
	fn normalized(text: &str) -> impl Iterator<Item = char> + '_ {
		let mut spaced = false;
		js_trim(text).chars().filter_map(move |ch| {
			if matches!(ch, ' ' | '\t') {
				let duplicate = spaced;
				spaced = true;
				(!duplicate).then_some(' ')
			} else {
				spaced = false;
				Some(ch.to_ascii_lowercase())
			}
		})
	}
	normalized(left).eq(normalized(right))
}

fn context_occurrences(
	lines: &[&str],
	context: &str,
	result: &ContextLineResult,
	function_fallback: bool,
) -> Vec<ContextOccurrence> {
	let Some(strategy) = result.strategy else {
		return Vec::new();
	};
	let target = normalize_for_fuzzy(context);
	let mut occurrences = Vec::new();
	for &row in result.match_indices.as_deref().unwrap_or_default() {
		let line = lines[row];
		let leading = line.len() - js_trim_start(line).len();
		let partial =
			matches!(strategy, ContextMatchStrategy::Prefix | ContextMatchStrategy::Substring);
		if !partial {
			occurrences.push(ContextOccurrence {
				row,
				span: leading..js_trim_end(line).len(),
				whole_row: true,
				function_fallback,
				strategy,
				veto_only: false,
			});
			continue;
		}
		// Project the matcher's alphabet back to source bytes. Space folding
		// retains the complete source run; no normalized scalar is an offset.
		let mut normalized = String::with_capacity(line.len());
		let mut offsets: Vec<(usize, Range<usize>)> = Vec::new();
		for (at, ch) in js_trim(line).char_indices() {
			let mapped = fuzzy_character(ch);
			let source = leading + at..leading + at + ch.len_utf8();
			if mapped == ' ' && normalized.ends_with(' ') {
				if let Some((_, last)) = offsets.last_mut() {
					last.end = source.end;
				}
				continue;
			}
			offsets.push((normalized.len(), source));
			normalized.push(mapped);
		}
		for (at, _) in normalized.match_indices(&target) {
			let veto_only = strategy == ContextMatchStrategy::Prefix && at != 0;
			let begin = offsets.binary_search_by_key(&at, |(at, _)| *at).ok();
			let end = offsets.partition_point(|(offset, _)| *offset < at + target.len());
			if let Some(begin) = begin.filter(|begin| *begin < end) {
				occurrences.push(ContextOccurrence {
					row,
					span: offsets[begin].1.start..offsets[end - 1].1.end,
					whole_row: false,
					function_fallback,
					strategy: if veto_only {
						ContextMatchStrategy::Substring
					} else {
						strategy
					},
					veto_only,
				});
			}
		}
	}
	occurrences
}

/// One anchor ladder: literal tiers precede whole-row case-fold evidence,
/// and each compatibility fallback carries its actual source occurrence.
pub(crate) fn find_anchor_evidence(
	lines: &[&str],
	context: &str,
	allow_fuzzy: bool,
) -> ContextEvidence {
	context_ladder(lines, context, 0, allow_fuzzy, false, false)
}

/// Every index in `start..=end_inclusive` accepted by `predicate`, ascending.
fn collect_indexed_matches(
	start: usize,
	end_inclusive: usize,
	mut predicate: impl FnMut(usize) -> bool,
) -> Vec<usize> {
	if start > end_inclusive {
		return Vec::new();
	}
	(start..=end_inclusive)
		.filter(|index| predicate(*index))
		.collect()
}

/// The accepting pass reports every placement it found at its own
/// normalization level, so callers can tell a unique hit from the first of
/// several equally ranked ones.
fn sequence_result(
	matches: Vec<usize>,
	confidence: f64,
	strategy: SequenceMatchStrategy,
) -> Option<SequenceSearchResult> {
	Some(SequenceSearchResult {
		index: Some(*matches.first()?),
		confidence,
		match_count: Some(matches.len()),
		match_indices: Some(matches),
		top_indices: None,
		strategy: Some(strategy),
	})
}

fn context_result(
	matches: Vec<usize>,
	confidence: f64,
	strategy: ContextMatchStrategy,
) -> Option<ContextLineResult> {
	Some(ContextLineResult {
		index: Some(*matches.first()?),
		confidence,
		match_count: Some(matches.len()),
		match_indices: Some(matches),
		strategy: Some(strategy),
	})
}

const fn no_sequence_match(confidence: f64, match_count: Option<usize>) -> SequenceSearchResult {
	SequenceSearchResult {
		index: None,
		confidence,
		match_count,
		match_indices: None,
		top_indices: None,
		strategy: None,
	}
}

const fn no_context_match(confidence: f64) -> ContextLineResult {
	ContextLineResult {
		index: None,
		confidence,
		match_count: None,
		match_indices: None,
		strategy: None,
	}
}

#[allow(clippy::suspicious_operation_groupings, reason = "paired index bounds are intentional")]
fn levenshtein_chars(a: &[char], b: &[char]) -> usize {
	if a == b {
		return 0;
	}
	let mut start = 0;
	let shared_limit = a.len().min(b.len());
	while start < shared_limit && a[start] == b[start] {
		start += 1;
	}
	let mut a_end = a.len();
	let mut b_end = b.len();
	while a_end > start && b_end > start && a[a_end - 1] == b[b_end - 1] {
		a_end -= 1;
		b_end -= 1;
	}
	let mut longer = &a[start..a_end];
	let mut shorter = &b[start..b_end];
	if longer.is_empty() {
		return shorter.len();
	}
	if shorter.is_empty() {
		return longer.len();
	}
	if shorter.len() > longer.len() {
		std::mem::swap(&mut longer, &mut shorter);
	}

	let mut row: Vec<usize> = (0..=shorter.len()).collect();
	for (line, &a_char) in longer.iter().enumerate() {
		let mut diagonal = row[0];
		row[0] = line + 1;
		for (column, &b_char) in shorter.iter().enumerate() {
			let cell = column + 1;
			let above = row[cell];
			row[cell] = if a_char == b_char {
				diagonal
			} else {
				(above + 1).min(row[cell - 1] + 1).min(diagonal + 1)
			};
			diagonal = above;
		}
	}
	row[shorter.len()]
}

/// Levenshtein edit distance over Unicode scalar values.
///
/// The TypeScript source used UTF-16 code units. Rust deliberately uses
/// Unicode scalar values, so astral characters count as one element.
pub fn levenshtein_distance(a: &str, b: &str) -> usize {
	let a_chars: Vec<char> = a.chars().collect();
	let b_chars: Vec<char> = b.chars().collect();
	levenshtein_chars(&a_chars, &b_chars)
}

/// Similarity in `[0, 1]`: `1 - distance / max_len`.
pub fn similarity(a: &str, b: &str) -> f64 {
	let a_chars: Vec<char> = a.chars().collect();
	let b_chars: Vec<char> = b.chars().collect();
	let max_len = a_chars.len().max(b_chars.len());
	if max_len == 0 {
		return 1.0;
	}
	1.0 - levenshtein_chars(&a_chars, &b_chars) as f64 / max_len as f64
}

/// `line` cut to [`OCCURRENCE_PREVIEW_MAX_LEN`] UTF-16 units, marked `…`
/// when cut.
pub(crate) fn truncate_preview(line: &str) -> String {
	if utf16_len(line) <= OCCURRENCE_PREVIEW_MAX_LEN {
		return line.to_owned();
	}
	let mut units = 0;
	let mut text = String::new();
	for ch in line.chars() {
		let width = ch.len_utf16();
		if units + width > OCCURRENCE_PREVIEW_MAX_LEN - 1 {
			break;
		}
		text.push(ch);
		units += width;
	}
	text.push('…');
	text
}

/// Addressable rows of LF-normalized file text. A final newline terminates
/// the last row; empty text still has the one empty row line placement sees.
pub(crate) fn file_lines(content: &str) -> std::str::Split<'_, char> {
	content.strip_suffix('\n').unwrap_or(content).split('\n')
}

/// Numbered previews of candidate placements (0-based start rows into the
/// file's real `lines`): `context` rows on either side of the first `shown`
/// candidates, windows that overlap or touch merged into one block so no row
/// prints twice, every displayed candidate row marked `>`, and line numbers
/// right-aligned.
pub(crate) fn preview_windows(
	lines: &[&str],
	candidates: &[usize],
	shown: usize,
	context: usize,
) -> Vec<String> {
	let mut starts = candidates
		.iter()
		.copied()
		.filter(|row| *row < lines.len())
		.collect::<Vec<_>>();
	starts.sort_unstable();
	starts.dedup();
	let mut blocks: Vec<(usize, usize)> = Vec::new();
	for &row in starts.iter().take(shown) {
		let start = row.saturating_sub(context);
		let end = lines.len().min(row + context + 1);
		match blocks.last_mut() {
			Some((_, last_end)) if start <= *last_end => *last_end = (*last_end).max(end),
			_ => blocks.push((start, end)),
		}
	}
	let width = blocks.last().map_or(1, |(_, end)| end.to_string().len());
	blocks
		.into_iter()
		.map(|(start, end)| {
			(start..end)
				.map(|row| {
					let mark = if starts.binary_search(&row).is_ok() {
						'>'
					} else {
						' '
					};
					format!("{mark}  {:>width$} | {}", row + 1, truncate_preview(lines[row]))
				})
				.collect::<Vec<_>>()
				.join("\n")
		})
		.collect()
}

fn overlaps_excluded(start: usize, end: usize, ranges: &[ExcludedRange]) -> bool {
	ranges
		.iter()
		.any(|range| start < range.end_index && end > range.start_index)
}

/// Every exact placement of `target`, including overlapping ones: two
/// placements that share bytes are still two distinct candidate edits, so
/// uniqueness must count both (`"aa"` occurs three times in `"aaaa"`; Wu &
/// Manber, TR 91-11, §1 defines an occurrence as every start position).
///
/// Knuth–Morris–Pratt over bytes keeps this linear for periodic text; a
/// match of valid UTF-8 inside valid UTF-8 always starts on a char boundary.
fn find_exact_match_outcome(
	content: &str,
	target: &str,
	excluded_ranges: &[ExcludedRange],
) -> Option<MatchOutcome> {
	let needle = target.as_bytes();
	let mut failure = vec![0usize; needle.len()];
	let mut matched = 0;
	for index in 1..needle.len() {
		while matched > 0 && needle[index] != needle[matched] {
			matched = failure[matched - 1];
		}
		if needle[index] == needle[matched] {
			matched += 1;
		}
		failure[index] = matched;
	}
	let target_newlines = line_breaks(needle);
	// (byte start, 1-indexed start line) of every accepted placement.
	let mut placements: Vec<(usize, u32)> = Vec::new();
	let mut overlapping = false;
	let mut newlines = 0;
	matched = 0;
	for (index, &byte) in content.as_bytes().iter().enumerate() {
		newlines += usize::from(byte == b'\n');
		while matched > 0 && byte != needle[matched] {
			matched = failure[matched - 1];
		}
		if byte == needle[matched] {
			matched += 1;
		}
		if matched < needle.len() {
			continue;
		}
		matched = failure[matched - 1];
		let start = index + 1 - needle.len();
		if overlaps_excluded(start, index + 1, excluded_ranges) {
			continue;
		}
		overlapping |= placements
			.last()
			.is_some_and(|(previous, _)| start < previous + needle.len());
		placements.push((start, (newlines - target_newlines + 1) as u32));
	}
	let &(first_index, start_line) = placements.first()?;
	if placements.len() > 1 {
		let occurrence_lines: Vec<u32> = placements.iter().map(|(_, line)| *line).collect();
		// Overlapping placements can share a line: preview each line once.
		let mut distinct = occurrence_lines.clone();
		distinct.dedup();
		let starts = distinct
			.iter()
			.map(|line| *line as usize - 1)
			.collect::<Vec<_>>();
		let occurrence_previews = preview_windows(
			&file_lines(content).collect::<Vec<_>>(),
			&starts,
			MAX_RECORDED_MATCHES,
			OCCURRENCE_PREVIEW_CONTEXT,
		);
		return Some(MatchOutcome {
			occurrences: Some(placements.len()),
			occurrence_lines: Some(occurrence_lines),
			occurrence_previews: Some(occurrence_previews),
			overlapping,
			..MatchOutcome::default()
		});
	}
	Some(MatchOutcome {
		matched: Some(FuzzyMatch {
			actual_text: target.to_owned(),
			start_index: first_index,
			start_line,
			confidence: 1.0,
		}),
		..MatchOutcome::default()
	})
}

/// Line breaks in `bytes`.
fn line_breaks(bytes: &[u8]) -> usize {
	bytes.split(|byte| *byte == b'\n').count() - 1
}

fn relative_indent_depths(lines: &[&str]) -> Vec<usize> {
	let indents: Vec<usize> = lines
		.iter()
		.map(|line| count_leading_whitespace(line))
		.collect();
	let non_empty_indents: Vec<usize> = lines
		.iter()
		.zip(&indents)
		.filter_map(|(line, indent)| is_non_empty_line(line).then_some(*indent))
		.collect();
	let min_indent = non_empty_indents.iter().copied().min().unwrap_or(0);
	let indent_unit = non_empty_indents
		.iter()
		.filter_map(|indent| indent.checked_sub(min_indent))
		.filter(|step| *step > 0)
		.min()
		.unwrap_or(1);
	lines
		.iter()
		.zip(indents)
		.map(|(line, indent)| {
			if !is_non_empty_line(line) || indent_unit == 0 {
				0
			} else {
				((indent - min_indent) as f64 / indent_unit as f64).round() as usize
			}
		})
		.collect()
}

fn normalize_lines(lines: &[&str], include_depth: bool) -> Vec<String> {
	let depths = include_depth.then(|| relative_indent_depths(lines));
	lines
		.iter()
		.enumerate()
		.map(|(index, line)| {
			let trimmed = js_trim(line);
			let prefix = depths
				.as_ref()
				.map_or_else(|| "|".to_owned(), |values| format!("{}|", values[index]));
			if trimmed.is_empty() {
				prefix
			} else {
				prefix + &normalize_for_fuzzy(trimmed)
			}
		})
		.collect()
}

fn line_offsets(lines: &[&str]) -> Vec<usize> {
	let mut offsets = Vec::with_capacity(lines.len());
	let mut offset = 0;
	for (index, line) in lines.iter().enumerate() {
		offsets.push(offset);
		offset += line.len() + usize::from(index + 1 < lines.len());
	}
	offsets
}

/// A window at or above the similarity threshold.
#[derive(Debug)]
struct FuzzyCandidate {
	/// 0-based start line.
	start:   usize,
	/// Character edits between the target and the window, summed over lines
	/// in the normalized scoring space.
	errors:  usize,
	matched: FuzzyMatch,
}

#[derive(Debug)]
struct BestFuzzyMatch {
	best:            Option<FuzzyMatch>,
	above_threshold: Vec<FuzzyCandidate>,
}

fn best_fuzzy_match_core(
	content_lines: &[&str],
	target_lines: &[&str],
	offsets: &[usize],
	threshold: f64,
	include_depth: bool,
	excluded_ranges: &[ExcludedRange],
) -> BestFuzzyMatch {
	let target_normalized: Vec<Vec<char>> = normalize_lines(target_lines, include_depth)
		.iter()
		.map(|line| line.chars().collect())
		.collect();
	let mut best = None;
	let mut best_score = -1.0;
	let mut above_threshold = Vec::new();
	for start in 0..=content_lines.len() - target_lines.len() {
		let start_index = offsets[start];
		let end_line = start + target_lines.len() - 1;
		let end_index = (offsets[end_line] + content_lines[end_line].len()).max(start_index + 1);
		if overlaps_excluded(start_index, end_index, excluded_ranges) {
			continue;
		}
		let window = &content_lines[start..start + target_lines.len()];
		let mut errors = 0;
		let mut total = 0.0;
		for (target, actual) in target_normalized
			.iter()
			.zip(normalize_lines(window, include_depth))
		{
			let actual: Vec<char> = actual.chars().collect();
			let max_len = target.len().max(actual.len());
			let distance = levenshtein_chars(target, &actual);
			errors += distance;
			total += if max_len == 0 {
				1.0
			} else {
				1.0 - distance as f64 / max_len as f64
			};
		}
		let score = total / target_lines.len() as f64;
		let candidate = || FuzzyMatch {
			actual_text: window.join("\n"),
			start_index,
			start_line: start as u32 + 1,
			confidence: score,
		};
		if score >= threshold {
			above_threshold.push(FuzzyCandidate { start, errors, matched: candidate() });
		}
		if score > best_score {
			best_score = score;
			best = Some(candidate());
		}
	}
	BestFuzzyMatch { best, above_threshold }
}

fn best_fuzzy_match(
	content: &str,
	target: &str,
	threshold: f64,
	excluded_ranges: &[ExcludedRange],
) -> BestFuzzyMatch {
	let content_lines: Vec<&str> = content.split('\n').collect();
	let target_lines: Vec<&str> = target.split('\n').collect();
	if target.is_empty() || target_lines.len() > content_lines.len() {
		return BestFuzzyMatch { best: None, above_threshold: Vec::new() };
	}
	let offsets = line_offsets(&content_lines);
	let mut result = best_fuzzy_match_core(
		&content_lines,
		&target_lines,
		&offsets,
		threshold,
		true,
		excluded_ranges,
	);
	if result
		.best
		.as_ref()
		.is_some_and(|best| best.confidence < threshold && best.confidence >= FALLBACK_THRESHOLD)
	{
		let without_depth = best_fuzzy_match_core(
			&content_lines,
			&target_lines,
			&offsets,
			threshold,
			false,
			excluded_ranges,
		);
		if without_depth.best.as_ref().is_some_and(|candidate| {
			result
				.best
				.as_ref()
				.is_none_or(|best| candidate.confidence > best.confidence)
		}) {
			result = without_depth;
		}
	}
	result
}

/// Locate `target` in `content`: exact first, then fuzzy when allowed.
/// Excluded ranges are invisible to both passes.
pub fn find_match(content: &str, target: &str, options: &FindMatchOptions<'_>) -> MatchOutcome {
	find_ranked_match(content, target, options, true).0
}

/// [`find_match`], plus the 0-based start line and score of every
/// above-threshold fuzzy window, so a caller can tell the best-ranked windows
/// from the rest. Without `exact`, only whole-line windows are considered:
/// a byte-level hit inside a line never becomes a line placement.
fn find_ranked_match(
	content: &str,
	target: &str,
	options: &FindMatchOptions<'_>,
	exact: bool,
) -> (MatchOutcome, Vec<(usize, f64)>) {
	if target.is_empty() {
		return (MatchOutcome::default(), Vec::new());
	}
	if exact && let Some(found) = find_exact_match_outcome(content, target, options.excluded_ranges)
	{
		return (found, Vec::new());
	}
	let threshold = options.threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
	let result = best_fuzzy_match(content, target, threshold, options.excluded_ranges);
	let Some(best) = result.best else {
		return (MatchOutcome::default(), Vec::new());
	};
	let ranks = result
		.above_threshold
		.iter()
		.map(|candidate| (candidate.start, candidate.matched.confidence))
		.collect();
	let above_threshold_count = result.above_threshold.len();
	if options.allow_fuzzy && best.confidence >= threshold && above_threshold_count == 1 {
		return (
			MatchOutcome {
				matched: Some(best.clone()),
				closest: Some(best),
				..MatchOutcome::default()
			},
			ranks,
		);
	}
	let (occurrence_lines, occurrence_previews) = if above_threshold_count > 1 {
		let starts = result
			.above_threshold
			.iter()
			.map(|candidate| candidate.start)
			.collect::<Vec<_>>();
		(
			Some(
				result
					.above_threshold
					.iter()
					.map(|candidate| candidate.start as u32 + 1)
					.collect(),
			),
			Some(preview_windows(
				&file_lines(content).collect::<Vec<_>>(),
				&starts,
				MAX_RECORDED_MATCHES,
				OCCURRENCE_PREVIEW_CONTEXT,
			)),
		)
	} else {
		(None, None)
	};
	// Several windows clear the threshold. Only the best-scoring one may be
	// taken, and only when it clearly leads: either by the similarity gap, or
	// as the sole window within 2·e*+1 character edits, e* being the fewest
	// any window needs. The band adapts Wu & Manber's error schedule (TR
	// 91-11, §3.3), used there for search cost; exact ties always stay
	// ambiguous (Ratcliff & Metzener, DDJ 1988: weigh how closely grouped the
	// candidates are).
	let mut ranked = result.above_threshold.iter().collect::<Vec<_>>();
	ranked.sort_by(|a, b| b.matched.confidence.total_cmp(&a.matched.confidence));
	let fewest = ranked
		.iter()
		.map(|candidate| candidate.errors)
		.min()
		.unwrap_or(0);
	let standout = match ranked.as_slice() {
		[first, second, ..]
			if options.allow_fuzzy && first.matched.confidence > second.matched.confidence =>
		{
			let gap = first.matched.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE
				&& first.matched.confidence - second.matched.confidence >= DOMINANT_FUZZY_DELTA;
			let band = ranked
				.iter()
				.filter(|candidate| candidate.errors <= 2 * fewest + 1)
				.count() == 1
				&& first.errors == fewest;
			(gap || band).then(|| first.matched.clone())
		},
		_ => None,
	};
	(
		MatchOutcome {
			dominant_fuzzy: standout.is_some().then_some(true),
			matched: standout,
			closest: Some(best),
			fuzzy_matches: Some(above_threshold_count),
			occurrence_lines,
			occurrence_previews,
			..MatchOutcome::default()
		},
		ranks,
	)
}

fn matches_at<T>(
	lines: &[T],
	pattern: &[T],
	index: usize,
	mut compare: impl FnMut(&T, &T) -> bool,
) -> bool {
	pattern
		.iter()
		.enumerate()
		.all(|(offset, expected)| compare(&lines[index + offset], expected))
}

fn fuzzy_score_at(lines: &[String], pattern: &[String], index: usize, min_score: f64) -> f64 {
	let count = pattern.len();
	let mut total = 0.0;
	for (offset, pat) in pattern.iter().enumerate() {
		let line = &lines[index + offset];
		if line == pat {
			total += 1.0;
			continue;
		}
		let remaining = count - offset - 1;
		let line_len = line.chars().count();
		let pat_len = pat.chars().count();
		let max_len = line_len.max(pat_len);
		let upper_bound = if max_len == 0 {
			1.0
		} else {
			1.0 - line_len.abs_diff(pat_len) as f64 / max_len as f64
		};
		if (total + upper_bound + remaining as f64) / (count as f64) < min_score {
			return total / count as f64;
		}
		if upper_bound > 0.0 {
			total += similarity(line, pat);
		}
		if (total + remaining as f64) / (count as f64) < min_score {
			return total / count as f64;
		}
	}
	total / count as f64
}

fn norm_starts_with(line: &str, pattern: &str) -> bool {
	if pattern.is_empty() {
		line.is_empty()
	} else {
		line.starts_with(pattern)
	}
}

fn norm_includes(line: &str, pattern: &str) -> bool {
	let pattern_len = pattern.chars().count();
	let line_len = line.chars().count();
	if pattern.is_empty() {
		return line.is_empty();
	}
	pattern_len >= PARTIAL_MATCH_MIN_LENGTH
		&& line.contains(pattern)
		&& pattern_len as f64 / line_len.max(1) as f64 >= PARTIAL_MATCH_MIN_RATIO
}

fn strip_comment_prefix(line: &str) -> &str {
	let trimmed = js_trim_start(line);
	let without = if let Some(rest) = trimmed.strip_prefix("/*") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("*/") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("//") {
		rest
	} else if let Some(rest) = trimmed.strip_prefix('*') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix('#') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix(';') {
		rest
	} else if let Some(rest) = trimmed.strip_prefix("/ ") {
		rest
	} else {
		trimmed
	};
	js_trim_start(without)
}

fn run_sequence_passes(
	lines: &[&str],
	pattern: &[&str],
	from: usize,
	to: usize,
	allow_fuzzy: bool,
	lines_normalized: &[String],
	pattern_normalized: &[String],
) -> Option<SequenceSearchResult> {
	let exact =
		collect_indexed_matches(from, to, |index| matches_at(lines, pattern, index, |a, b| a == b));
	if let Some(result) = sequence_result(exact, 1.0, SequenceMatchStrategy::Exact) {
		return Some(result);
	}
	let trailing = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| js_trim_end(a) == js_trim_end(b))
	});
	if let Some(result) = sequence_result(trailing, 0.99, SequenceMatchStrategy::TrimTrailing) {
		return Some(result);
	}
	let trimmed = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| js_trim(a) == js_trim(b))
	});
	if let Some(result) = sequence_result(trimmed, 0.98, SequenceMatchStrategy::Trim) {
		return Some(result);
	}
	let comments = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| strip_comment_prefix(a) == strip_comment_prefix(b))
	});
	if let Some(result) = sequence_result(comments, 0.975, SequenceMatchStrategy::CommentPrefix) {
		return Some(result);
	}
	let unicode = collect_indexed_matches(from, to, |index| {
		matches_at(lines, pattern, index, |a, b| normalize_unicode(a) == normalize_unicode(b))
	});
	if let Some(result) = sequence_result(unicode, 0.97, SequenceMatchStrategy::Unicode) {
		return Some(result);
	}
	if !allow_fuzzy {
		return None;
	}
	let prefix = collect_indexed_matches(from, to, |index| {
		matches_at(lines_normalized, pattern_normalized, index, |a, b| norm_starts_with(a, b))
	});
	if let Some(result) = sequence_result(prefix, 0.965, SequenceMatchStrategy::Prefix) {
		return Some(result);
	}
	let substring = collect_indexed_matches(from, to, |index| {
		matches_at(lines_normalized, pattern_normalized, index, |a, b| norm_includes(a, b))
	});
	sequence_result(substring, 0.94, SequenceMatchStrategy::Substring)
}

/// Locate `pattern` lines through the exact-to-character fallback ladder.
pub fn seek_sequence(
	lines: &[&str],
	pattern: &[&str],
	start: usize,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	seek_sequence_within(lines, pattern, start, lines.len(), eof, allow_fuzzy)
}

/// [`seek_sequence`] restricted to placements starting in `[start, end)`.
///
/// A scope such as an `@@` anchor's block is searched on its own, so a
/// stricter-tier hit outside the scope cannot hide the scope's candidates.
/// Every reported placement `index` satisfies `start <= index < end` and
/// `index + pattern.len() <= lines.len()`; when no placement can start in
/// the scope, no tier reports one. An empty pattern places at `start` when
/// `start <= end`.
pub fn seek_sequence_within(
	lines: &[&str],
	pattern: &[&str],
	start: usize,
	end: usize,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	if pattern.is_empty() {
		if start > end {
			return no_sequence_match(0.0, None);
		}
		return SequenceSearchResult {
			index:         Some(start),
			confidence:    1.0,
			match_count:   None,
			match_indices: None,
			top_indices:   None,
			strategy:      Some(SequenceMatchStrategy::Exact),
		};
	}
	if pattern.len() > lines.len() || end == 0 {
		return no_sequence_match(0.0, None);
	}
	let last_start = lines.len() - pattern.len();
	let max_start = last_start.min(end - 1);
	if start > max_start {
		return no_sequence_match(0.0, None);
	}
	// End-of-file placement only means something when the scope reaches it.
	let eof = eof && max_start == last_start;
	// Only the lines a placement in scope can cover are examined.
	let mut result = seek_in_scope(
		&lines[start..max_start + pattern.len()],
		pattern,
		max_start - start,
		eof,
		allow_fuzzy,
	);
	let shift = |indices: &mut Option<Vec<usize>>| {
		for index in indices.iter_mut().flatten() {
			*index += start;
		}
	};
	result.index = result.index.map(|index| index + start);
	shift(&mut result.match_indices);
	shift(&mut result.top_indices);
	result
}

/// Keep only locally best windows: a window is dropped when it overlaps a
/// kept, strictly better one, so it is the same alignment shifted, not
/// another occurrence (Navarro, ACM CSUR 33(1), 2001; Ukkonen 1993, "locally
/// best approximate occurrences"). Greedy in score order, so a dropped window
/// never suppresses anything, and equal scores never suppress each other.
/// Returns the survivors by index, in O(k log k).
fn locally_best(mut scored: Vec<(usize, f64)>, width: usize) -> Vec<(usize, f64)> {
	scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
	// Kept windows scoring strictly above the current score group.
	let mut stronger = std::collections::BTreeSet::new();
	let mut group = Vec::new();
	let mut kept = Vec::new();
	let mut current = None;
	for (index, score) in scored {
		if current != Some(score) {
			stronger.extend(std::mem::take(&mut group));
			current = Some(score);
		}
		let reach = index.saturating_sub(width - 1)..=index + (width - 1);
		if stronger.range(reach).next().is_none() {
			group.push(index);
			kept.push((index, score));
		}
	}
	kept.sort_by_key(|(index, _)| *index);
	kept
}

/// The ladder over a scope whose first line is placement 0 and whose last
/// possible placement is `max_start`.
fn seek_in_scope(
	lines: &[&str],
	pattern: &[&str],
	max_start: usize,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	let search_start = if eof { max_start } else { 0 };
	let normalize = |items: &[&str]| -> Vec<String> {
		if allow_fuzzy {
			items.iter().map(|line| normalize_for_fuzzy(line)).collect()
		} else {
			Vec::new()
		}
	};
	let lines_normalized = normalize(lines);
	let pattern_normalized = normalize(pattern);
	if let Some(result) = run_sequence_passes(
		lines,
		pattern,
		search_start,
		max_start,
		allow_fuzzy,
		&lines_normalized,
		&pattern_normalized,
	) {
		return result;
	}
	if search_start > 0
		&& let Some(result) = run_sequence_passes(
			lines,
			pattern,
			0,
			max_start,
			allow_fuzzy,
			&lines_normalized,
			&pattern_normalized,
		) {
		return result;
	}
	if !allow_fuzzy {
		return no_sequence_match(0.0, None);
	}

	// Windows at or above the threshold, eof-first when anchored at EOF.
	let scored: Vec<(usize, f64)> = (search_start..=max_start)
		.chain(0..search_start)
		.filter_map(|index| {
			let score =
				fuzzy_score_at(&lines_normalized, &pattern_normalized, index, SEQUENCE_FUZZY_THRESHOLD);
			(score >= SEQUENCE_FUZZY_THRESHOLD).then_some((index, score))
		})
		.collect();
	let survivors = locally_best(scored, pattern.len());
	if !survivors.is_empty() {
		let best_score = survivors
			.iter()
			.map(|(_, score)| *score)
			.fold(0.0_f64, f64::max);
		let top: Vec<usize> = survivors
			.iter()
			.filter(|(_, score)| *score == best_score)
			.map(|(index, _)| *index)
			.collect();
		let second_best_score = survivors
			.iter()
			.map(|(_, score)| *score)
			.filter(|score| *score < best_score)
			.fold(0.0_f64, f64::max);
		let index = top[0];
		let dominant = survivors.len() > 1
			&& top.len() == 1
			&& best_score >= DOMINANT_FUZZY_MIN_CONFIDENCE
			&& best_score - second_best_score >= DOMINANT_FUZZY_DELTA;
		let indices: Vec<usize> = if dominant {
			vec![index]
		} else {
			survivors.iter().map(|(index, _)| *index).collect()
		};
		return SequenceSearchResult {
			index:         Some(index),
			confidence:    best_score,
			match_count:   Some(indices.len()),
			match_indices: Some(indices),
			top_indices:   Some(if dominant { vec![index] } else { top }),
			strategy:      Some(if dominant {
				SequenceMatchStrategy::FuzzyDominant
			} else {
				SequenceMatchStrategy::Fuzzy
			}),
		};
	}

	let pattern_text = pattern.join("\n");
	let content_text = lines.join("\n");
	// Whole-line windows only: a byte-level hit inside a line is no placement
	// of the pattern's lines.
	let (outcome, ranks) = find_ranked_match(
		&content_text,
		&pattern_text,
		&FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(CHARACTER_MATCH_THRESHOLD),
			excluded_ranges: &[],
		},
		false,
	);
	let line_of = |byte: usize| content_text[..byte].bytes().filter(|b| *b == b'\n').count();
	// `find_match` only returns a match that is unique or dominant.
	if let Some(matched) = outcome.matched.as_ref()
		&& line_of(matched.start_index) <= max_start
	{
		let line_index = line_of(matched.start_index);
		return SequenceSearchResult {
			index:         Some(line_index),
			confidence:    matched.confidence,
			match_count:   Some(1),
			match_indices: Some(vec![line_index]),
			top_indices:   None,
			strategy:      Some(SequenceMatchStrategy::Character),
		};
	}
	let Some(count) = outcome
		.occurrences
		.or(outcome.fuzzy_matches)
		.filter(|count| *count > 1)
	else {
		return no_sequence_match(0.0, None);
	};
	let mut indices: Vec<usize> = outcome
		.occurrence_lines
		.unwrap_or_default()
		.iter()
		.map(|line| *line as usize - 1)
		.filter(|index| *index <= max_start)
		.collect();
	indices.dedup();
	// Fuzzy windows rank by score; a line hint may only choose among the best.
	let best = ranks
		.iter()
		.map(|(_, score)| *score)
		.fold(0.0_f64, f64::max);
	let top = (!ranks.is_empty()).then(|| {
		ranks
			.iter()
			.filter(|(_, score)| *score == best)
			.map(|(index, _)| *index)
			.collect()
	});
	SequenceSearchResult {
		match_indices: Some(indices),
		top_indices: top,
		strategy: Some(SequenceMatchStrategy::Character),
		..no_sequence_match(best, Some(count))
	}
}

/// Best-scoring placement of `pattern` regardless of threshold.
pub fn find_closest_sequence_match(
	lines: &[&str],
	pattern: &[&str],
	start: Option<usize>,
	eof: bool,
) -> (Option<usize>, f64, SequenceMatchStrategy) {
	let start = start.unwrap_or(0);
	if pattern.is_empty() {
		return (Some(start), 1.0, SequenceMatchStrategy::Exact);
	}
	if pattern.len() > lines.len() {
		return (None, 0.0, SequenceMatchStrategy::Fuzzy);
	}
	let max_start = lines.len() - pattern.len();
	let search_start = if eof { max_start } else { start };
	let lines_normalized: Vec<String> = lines.iter().map(|line| normalize_for_fuzzy(line)).collect();
	let pattern_normalized: Vec<String> = pattern
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect();
	let mut best_index = None;
	let mut best_score = 0.0;
	if search_start <= max_start {
		for index in search_start..=max_start {
			let score = fuzzy_score_at(&lines_normalized, &pattern_normalized, index, best_score);
			if score > best_score {
				best_score = score;
				best_index = Some(index);
			}
		}
	}
	if eof && search_start > start {
		for index in start..search_start {
			let score = fuzzy_score_at(&lines_normalized, &pattern_normalized, index, best_score);
			if score > best_score {
				best_score = score;
				best_index = Some(index);
			}
		}
	}
	(best_index, best_score, SequenceMatchStrategy::Fuzzy)
}

/// The accepting tier produces the source occurrence, not just a row.
fn context_ladder(
	lines: &[&str],
	context: &str,
	start_from: usize,
	allow_fuzzy: bool,
	skip_function_fallback: bool,
	function_fallback: bool,
) -> ContextEvidence {
	let evidence = |result: ContextLineResult| ContextEvidence {
		occurrences: context_occurrences(lines, context, &result, function_fallback),
		result,
	};
	if lines.is_empty() || start_from >= lines.len() {
		return evidence(no_context_match(0.0));
	}
	let end = lines.len() - 1;
	let trimmed_context = js_trim(context);
	let exact = collect_indexed_matches(start_from, end, |index| lines[index] == context);
	if let Some(result) = context_result(exact, 1.0, ContextMatchStrategy::Exact) {
		return evidence(result);
	}
	let trimmed =
		collect_indexed_matches(start_from, end, |index| js_trim(lines[index]) == trimmed_context);
	if let Some(result) = context_result(trimmed, 0.99, ContextMatchStrategy::Trim) {
		return evidence(result);
	}
	let normalized_context = normalize_unicode(context);
	let unicode = collect_indexed_matches(start_from, end, |index| {
		normalize_unicode(lines[index]) == normalized_context
	});
	if let Some(result) = context_result(unicode, 0.98, ContextMatchStrategy::Unicode) {
		return evidence(result);
	}
	if !allow_fuzzy {
		return evidence(no_context_match(0.0));
	}
	let context_normalized = normalize_for_fuzzy(context);
	if !context_normalized.is_empty() {
		let prefix = collect_indexed_matches(start_from, end, |index| {
			normalize_for_fuzzy(lines[index]).starts_with(&context_normalized)
		});
		if let Some(result) = context_result(prefix, 0.96, ContextMatchStrategy::Prefix) {
			return evidence(result);
		}
	}
	if context_normalized.chars().count() >= PARTIAL_MATCH_MIN_LENGTH {
		let context_len = context_normalized.chars().count();
		let all_substrings: Vec<(usize, f64)> = (start_from..lines.len())
			.filter_map(|index| {
				let normalized = normalize_for_fuzzy(lines[index]);
				normalized
					.contains(&context_normalized)
					.then(|| (index, context_len as f64 / normalized.chars().count().max(1) as f64))
			})
			.collect();
		let all_indices: Vec<usize> = all_substrings.iter().map(|(index, _)| *index).collect();
		let qualifying: Vec<usize> = all_substrings
			.iter()
			.filter_map(|(index, ratio)| (*ratio >= PARTIAL_MATCH_MIN_RATIO).then_some(*index))
			.collect();
		// Lines where the context is a substantial part count first; only when
		// none qualifies do the weaker containments stand as candidates.
		let candidates = if all_indices.len() == 1 || qualifying.is_empty() {
			all_indices
		} else {
			qualifying
		};
		if let Some(&first) = candidates.first() {
			return evidence(ContextLineResult {
				index:         Some(first),
				confidence:    0.94,
				match_count:   Some(candidates.len()),
				match_indices: Some(candidates),
				strategy:      Some(ContextMatchStrategy::Substring),
			});
		}
	}
	let case_rows = lines
		.iter()
		.enumerate()
		.skip(start_from)
		.filter_map(|(row, line)| anchor_case_eq(line, context).then_some(row))
		.collect::<Vec<_>>();
	if let Some(result) = context_result(case_rows, 1.0, ContextMatchStrategy::CaseFold) {
		return evidence(result);
	}

	let mut best_index = None;
	let mut best_score = 0.0;
	let mut fuzzy_matches = Vec::new();
	for (index, &line) in lines.iter().enumerate().skip(start_from) {
		let score = similarity(&normalize_for_fuzzy(line), &context_normalized);
		if score >= CONTEXT_FUZZY_THRESHOLD {
			fuzzy_matches.push(index);
		}
		if score > best_score {
			best_score = score;
			best_index = Some(index);
		}
	}
	if let Some(index) = best_index.filter(|_| best_score >= CONTEXT_FUZZY_THRESHOLD) {
		return evidence(ContextLineResult {
			index:         Some(index),
			confidence:    best_score,
			match_count:   Some(fuzzy_matches.len()),
			match_indices: Some(fuzzy_matches),
			strategy:      Some(ContextMatchStrategy::Fuzzy),
		});
	}
	if !skip_function_fallback && let Some(base) = trimmed_context.strip_suffix("()") {
		let with_paren = format!("{base}(");
		let found = context_ladder(lines, &with_paren, start_from, allow_fuzzy, true, true);
		if found.result.index.is_some() {
			return found;
		}
		return context_ladder(lines, base, start_from, allow_fuzzy, true, true);
	}
	evidence(no_context_match(best_score))
}

/// Non-authorizing row-result adapter for public matcher callers.
pub fn find_context_line(
	lines: &[&str],
	context: &str,
	start_from: usize,
	allow_fuzzy: bool,
	skip_function_fallback: bool,
) -> ContextLineResult {
	context_ladder(lines, context, start_from, allow_fuzzy, skip_function_fallback, false).result
}

fn first_different_line<'a>(old_lines: &'a [&str], new_lines: &'a [&str]) -> (&'a str, &'a str) {
	for index in 0..old_lines.len().max(new_lines.len()) {
		let old = old_lines.get(index).copied().unwrap_or("");
		let new = new_lines.get(index).copied().unwrap_or("");
		if old != new {
			return (old, new);
		}
	}
	(old_lines.first().copied().unwrap_or(""), new_lines.first().copied().unwrap_or(""))
}

/// Format `EditMatchError.formatMessage` byte-for-byte.
pub fn format_match_error(
	path: &str,
	search_text: &str,
	outcome: &MatchOutcome,
	allow_fuzzy: bool,
	threshold: f64,
) -> String {
	let fuzzy_matches = outcome.fuzzy_matches;
	let Some(closest) = outcome.closest.as_ref() else {
		return if allow_fuzzy {
			format!("Could not find a close enough match in {path}.")
		} else {
			format!(
				"Could not find the exact text in {path}. The old text must match exactly including \
				 all whitespace and newlines."
			)
		};
	};
	let similarity_percent = (closest.confidence * 100.0).round() as i64;
	let threshold_percent = (threshold * 100.0).round() as i64;
	let search_lines: Vec<&str> = search_text.split('\n').collect();
	let actual_lines: Vec<&str> = closest.actual_text.split('\n').collect();
	let (old_line, new_line) = first_different_line(&search_lines, &actual_lines);
	let hint = if allow_fuzzy {
		if fuzzy_matches.is_some_and(|count| count > 1) {
			format!(
				"Found {} high-confidence matches. Provide more context to make it unique.{}",
				fuzzy_matches.unwrap_or(0),
				candidate_details(outcome, "fuzzy")
			)
		} else {
			format!("Closest match was below the {threshold_percent}% similarity threshold.")
		}
	} else {
		"Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence \
		 matches."
			.to_owned()
	};
	let heading = if allow_fuzzy {
		format!("Could not find a close enough match in {path}.")
	} else {
		format!("Could not find the exact text in {path}.")
	};
	format!(
		"{heading}\n\nClosest match ({similarity_percent}% similar) at line {}:\n  - {old_line}\n  \
		 + {new_line}\n{hint}",
		closest.start_line
	)
}

/// Every candidate's start line and preview and the tier that matched them,
/// so the model can disambiguate without re-reading (`OpenHands` lists every
/// occurrence's line; SWE-agent, `NeurIPS` 2024, §2).
pub(crate) fn candidate_details(outcome: &MatchOutcome, tier: &str) -> String {
	let mut details = String::new();
	if let Some(previews) = outcome
		.occurrence_previews
		.as_ref()
		.filter(|items| !items.is_empty())
	{
		details.push_str("\n\n");
		details.push_str(&previews.join("\n\n"));
		details.push_str("\n\n");
	} else {
		details.push(' ');
	}
	if let Some(lines) = outcome
		.occurrence_lines
		.as_ref()
		.filter(|lines| !lines.is_empty())
	{
		let _ = write!(details, "Candidates ({tier} match) start at lines {}.", line_list(lines));
	}
	if outcome.overlapping {
		details.push_str(
			" Some occurrences overlap, so replace_all would replace fewer of them than listed.",
		);
	}
	details
}

/// Candidate lines listed in full before the rest are only counted.
const LISTED_LINES: usize = 20;

/// `1, 4 and 9`, collapsing repeats from placements that share a line, and
/// counting the rest past [`LISTED_LINES`].
pub(crate) fn line_list(lines: &[u32]) -> String {
	let mut unique = lines.to_vec();
	unique.dedup();
	if unique.len() > LISTED_LINES {
		let shown = unique[..LISTED_LINES]
			.iter()
			.map(u32::to_string)
			.collect::<Vec<_>>()
			.join(", ");
		return format!("{shown} … and {} more", unique.len() - LISTED_LINES);
	}
	match unique.split_last() {
		Some((last, rest)) if !rest.is_empty() => format!(
			"{} and {last}",
			rest
				.iter()
				.map(u32::to_string)
				.collect::<Vec<_>>()
				.join(", ")
		),
		Some((last, _)) => last.to_string(),
		None => String::new(),
	}
}

fn occurrence_error(location: &str, outcome: &MatchOutcome, replace_all_note: bool) -> String {
	let occurrences = outcome.occurrences.unwrap_or(0);
	let previews = outcome
		.occurrence_previews
		.as_ref()
		.map_or_else(String::new, |items| items.join("\n\n"));
	// Previews show each candidate line once, so the cap counts lines.
	let mut distinct = outcome.occurrence_lines.clone().unwrap_or_default();
	distinct.dedup();
	let more = if distinct.len() > MAX_RECORDED_MATCHES {
		format!(" (showing first {MAX_RECORDED_MATCHES} of {})", distinct.len())
	} else {
		String::new()
	};
	let lines = outcome
		.occurrence_lines
		.as_deref()
		.map_or_else(String::new, |lines| {
			format!(" Occurrences start at lines {}.", line_list(lines))
		});
	let overlap = if outcome.overlapping && replace_all_note {
		" Some occurrences overlap, so replace_all would replace fewer of them than listed."
	} else {
		""
	};
	format!(
		"Found {occurrences} occurrences{location}{more}:\n\n{previews}\n\nAdd more context lines \
		 to disambiguate.{lines}{overlap}"
	)
}

/// Format the ambiguous-exact-text refusal for `path`.
pub fn format_occurrence_error(path: &str, outcome: &MatchOutcome) -> String {
	occurrence_error(&format!(" in {path}"), outcome, true)
}

/// [`format_occurrence_error`] for modes without `replace_all`.
pub fn format_patch_occurrence_error(path: &str, outcome: &MatchOutcome) -> String {
	occurrence_error(&format!(" in {path}"), outcome, false)
}

/// Result of [`replace_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceResult {
	pub content: String,
	pub count:   usize,
}

/// Find and replace text using the same exact/fuzzy behavior as `replaceText`.
pub fn replace_text(
	content: &str,
	old_text: &str,
	new_text: &str,
	fuzzy: bool,
	all: bool,
	threshold: Option<f64>,
) -> Result<ReplaceResult, EditError> {
	if old_text.is_empty() {
		return Err(EditError::apply("oldText must not be empty."));
	}
	let threshold = threshold.unwrap_or(DEFAULT_FUZZY_THRESHOLD);
	let normalized_content = normalize_to_lf(content).into_owned();
	let normalized_old = normalize_to_lf(old_text);
	let normalized_new = normalize_to_lf(new_text);
	if all {
		let exact_count = normalized_content
			.match_indices(normalized_old.as_ref())
			.count();
		if exact_count > 0 {
			return Ok(ReplaceResult {
				content: normalized_content.replace(normalized_old.as_ref(), normalized_new.as_ref()),
				count:   exact_count,
			});
		}
		// Without exact hits, `replace_all` edits at most one fuzzy window:
		// several candidates are refused rather than each rewritten.
		let outcome = find_match(&normalized_content, normalized_old.as_ref(), &FindMatchOptions {
			allow_fuzzy:     fuzzy,
			threshold:       Some(threshold),
			excluded_ranges: &[],
		});
		if fuzzy && outcome.fuzzy_matches.is_some_and(|count| count > 1) {
			return Err(EditError::apply(format!(
				"Found {} high-confidence matches and no exact occurrence; replace_all does not apply \
				 several fuzzy edits.{}",
				outcome.fuzzy_matches.unwrap_or(0),
				candidate_details(&outcome, "fuzzy")
			)));
		}
		let Some(matched) = outcome.matched else {
			return Ok(ReplaceResult { content: normalized_content, count: 0 });
		};
		let adjusted =
			adjust_indentation(normalized_old.as_ref(), &matched.actual_text, normalized_new.as_ref());
		if adjusted == matched.actual_text {
			return Ok(ReplaceResult { content: normalized_content, count: 0 });
		}
		let end = matched.start_index + matched.actual_text.len();
		let mut output = String::with_capacity(normalized_content.len() + adjusted.len());
		output.push_str(&normalized_content[..matched.start_index]);
		output.push_str(&adjusted);
		output.push_str(&normalized_content[end..]);
		return Ok(ReplaceResult { content: output, count: 1 });
	}

	let outcome = find_match(&normalized_content, normalized_old.as_ref(), &FindMatchOptions {
		allow_fuzzy:     fuzzy,
		threshold:       Some(threshold),
		excluded_ranges: &[],
	});
	if outcome.occurrences.is_some_and(|count| count > 1) {
		return Err(EditError::apply(occurrence_error("", &outcome, true)));
	}
	let Some(matched) = outcome.matched else {
		return Ok(ReplaceResult { content: normalized_content, count: 0 });
	};
	let adjusted =
		adjust_indentation(normalized_old.as_ref(), &matched.actual_text, normalized_new.as_ref());
	let mut output =
		String::with_capacity(normalized_content.len() - matched.actual_text.len() + adjusted.len());
	output.push_str(&normalized_content[..matched.start_index]);
	output.push_str(&adjusted);
	output.push_str(&normalized_content[matched.start_index + matched.actual_text.len()..]);
	Ok(ReplaceResult { content: output, count: 1 })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn options(allow_fuzzy: bool) -> FindMatchOptions<'static> {
		FindMatchOptions { allow_fuzzy, threshold: None, excluded_ranges: &[] }
	}

	/// Candidate previews never show a row past the last line, print each row
	/// once where windows overlap or touch, and mark candidate rows.
	#[test]
	fn previews_merge_windows_and_stop_at_the_last_line() {
		let lines = file_lines("x = 1\ny = 2\nx = 1\n").collect::<Vec<_>>();
		assert_eq!(preview_windows(&lines, &[2, 0], 5, 2), [
			">  1 | x = 1\n   2 | y = 2\n>  3 | x = 1"
		]);
		let lines = file_lines("a\nb\nc\nd\ne\nf\ng\n\n").collect::<Vec<_>>();
		assert_eq!(preview_windows(&lines, &[0, 3], 5, 1), [
			">  1 | a\n   2 | b\n   3 | c\n>  4 | d\n   5 | e"
		]);
		assert_eq!(preview_windows(&lines, &[0, 6], 5, 1), [
			">  1 | a\n   2 | b",
			"   6 | f\n>  7 | g\n   8 | "
		]);
	}

	#[test]
	fn exact_match_and_multiple_occurrences() {
		let found = find_match("line1\nline2\nline3", "line2", &options(false));
		assert_eq!(found.matched.as_ref().map(|matched| matched.start_line), Some(2));
		assert_eq!(found.matched.as_ref().map(|matched| matched.confidence), Some(1.0));

		let multiple = find_match("foo\nbar\nfoo\n", "foo", &options(false));
		assert!(multiple.matched.is_none());
		assert_eq!(multiple.occurrences, Some(2));
		assert_eq!(multiple.occurrence_lines, Some(vec![1, 3]));
		// Windows that overlap merge into one block, each row printed once,
		// with both candidate rows marked and no row past the last line.
		assert_eq!(
			multiple.occurrence_previews,
			Some(vec![">  1 | foo\n   2 | bar\n>  3 | foo".to_owned()])
		);
	}

	#[test]
	fn tab_space_and_internal_whitespace_normalization() {
		for (content, target) in [
			("\tfoo\n\t\tbar\n\tbaz", "  foo\n    bar\n  baz"),
			("  foo\n    bar\n  baz", "\tfoo\n\t\tbar\n\tbaz"),
			("   foo\n      bar\n   baz", "  foo\n    bar\n  baz"),
			("foo   bar    baz", "foo bar baz"),
		] {
			let outcome = find_match(content, target, &options(true));
			assert!(outcome.matched.is_some(), "failed to match {target:?}");
			assert!(outcome.matched.unwrap().confidence >= DEFAULT_FUZZY_THRESHOLD);
		}
	}

	#[test]
	fn fallback_ignores_inconsistent_indentation() {
		let outcome = find_match(
			"\t\t\tline1\n\t\t\tline2\n\t\tline3\n\t\t\tline4",
			"      line1\n      line2\n      line3\n      line4",
			&options(true),
		);
		assert!(outcome.matched.is_some());

		let varied =
			find_match("  a\n    b\n   c\n    d", "  a\n    b\n    c\n    d", &options(true));
		assert!(varied.matched.is_some());
	}

	#[test]
	fn single_line_trailing_space_and_empty_line_cases() {
		let single =
			find_match("prefix\n\t\t\t\"value\",\nsuffix", "          \"value\",", &options(true));
		assert!(single.matched.is_some());
		let trailing = find_match("line1  \nline2\t", "line1\nline2", &options(true));
		assert!(trailing.matched.is_some());
		let empty_line = find_match("line1\n\nline3", "line1\n\nline3", &options(false));
		assert_eq!(
			empty_line
				.matched
				.as_ref()
				.map(|matched| matched.confidence),
			Some(1.0)
		);
		assert_eq!(find_match("some content", "", &options(true)), MatchOutcome::default());
		assert!(
			find_match("short", "this is much longer than the content", &options(true))
				.matched
				.is_none()
		);
	}

	#[test]
	fn threshold_and_dominant_fuzzy_match() {
		let strict = FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.99),
			excluded_ranges: &[],
		};
		assert!(
			find_match("function foo() {}", "function bar() {}", &strict)
				.matched
				.is_none()
		);
		let lenient = FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.7),
			excluded_ranges: &[],
		};
		assert!(
			find_match("function foo() {}", "function bar() {}", &lenient)
				.matched
				.is_some()
		);

		let target = "a".repeat(50);
		let content = format!("{}b\n{}cccccc", "a".repeat(49), "a".repeat(44));
		let dominant = find_match(&content, &target, &FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.8),
			excluded_ranges: &[],
		});
		assert_eq!(dominant.dominant_fuzzy, Some(true));
		assert_eq!(dominant.fuzzy_matches, Some(2));
	}

	#[test]
	fn excluded_ranges_hide_exact_and_fuzzy_candidates() {
		let range = ExcludedRange { start_index: 0, end_index: 3 };
		let exact = find_match("foo\nfoo", "foo", &FindMatchOptions {
			allow_fuzzy:     false,
			threshold:       None,
			excluded_ranges: &[range],
		});
		assert_eq!(exact.matched.as_ref().map(|matched| matched.start_index), Some(4));

		let fuzzy = find_match("food\nfool", "foox", &FindMatchOptions {
			allow_fuzzy:     true,
			threshold:       Some(0.7),
			excluded_ranges: &[ExcludedRange { start_index: 0, end_index: 4 }],
		});
		assert_eq!(fuzzy.matched.as_ref().map(|matched| matched.start_line), Some(2));
	}

	#[test]
	fn sequence_matching_ladder() {
		assert_eq!(
			seek_sequence(&["foo", "bar", "baz"], &["bar", "baz"], 0, false, true).index,
			Some(1)
		);
		assert_eq!(
			seek_sequence(&["foo   ", "bar\t\t"], &["foo", "bar"], 0, false, true).strategy,
			Some(SequenceMatchStrategy::TrimTrailing)
		);
		assert_eq!(
			seek_sequence(&["    foo   ", "   bar\t"], &["foo", "bar"], 0, false, true).strategy,
			Some(SequenceMatchStrategy::Trim)
		);
		assert_eq!(
			seek_sequence(&["a", "b", "c", "d", "e"], &["d", "e"], 0, true, true).index,
			Some(3)
		);
		assert_eq!(
			seek_sequence(
				&["import asyncio  # local import – avoids top‑level dep"],
				&["import asyncio  # local import - avoids top-level dep"],
				0,
				false,
				true
			)
			.strategy,
			Some(SequenceMatchStrategy::Unicode)
		);
		assert_eq!(seek_sequence(&["foo", "bar"], &[], 1, false, true).index, Some(1));
		assert_eq!(seek_sequence(&["foo", "bar"], &[], 5, false, true).index, None);
		assert_eq!(seek_sequence(&["one"], &["too", "many"], 0, false, true).index, None);
		let minor = seek_sequence(
			&["function greet() {", "  console.log(\"Hello!\");", "}"],
			&["function greet() {", "  console.log(\"Hello!\")  ", "}"],
			0,
			false,
			true,
		);
		assert_eq!(minor.index, Some(0));
		assert!(minor.confidence >= SEQUENCE_FUZZY_THRESHOLD);
	}

	#[test]
	fn sequence_fuzzy_and_character_fallback() {
		let lines = [
			"function calculateTotal(items) {",
			"  let sum = 0;",
			"  for (const item of items) {",
			"    sum += item.price * item.quantity;",
			"  }",
			"  return sum;",
			"}",
		];
		let result = seek_sequence(
			&lines,
			&["  for (const item of items)  {", "    sum += item.price*item.quantity;"],
			0,
			false,
			true,
		);
		assert_eq!(result.index, Some(2));
		assert!(result.confidence > 0.9);
	}

	#[test]
	fn context_matching_ladder() {
		assert_eq!(
			find_context_line(&["function foo() {"], "function foo() {", 0, true, false).strategy,
			Some(ContextMatchStrategy::Exact)
		);
		assert_eq!(
			find_context_line(&["  function foo()  {"], "function foo() {", 0, true, false).strategy,
			Some(ContextMatchStrategy::Prefix)
		);
		assert_eq!(
			find_context_line(
				&["const msg = \"Hello – World\";"],
				"const msg = \"Hello - World\";",
				0,
				true,
				false
			)
			.index,
			Some(0)
		);
		assert_eq!(
			find_context_line(
				&["function calculateTotalWithTax(items, taxRate) {"],
				"function calculateTotalWithTax(items",
				0,
				true,
				false
			)
			.strategy,
			Some(ContextMatchStrategy::Prefix)
		);
		assert_eq!(
			find_context_line(&["// comment: calculateTotal here"], "calculateTotal", 0, true, false)
				.strategy,
			Some(ContextMatchStrategy::Substring)
		);
		let fuzzy = find_context_line(
			&["functoin calclateTotal(itms) {"],
			"function calculateTotal(items) {",
			0,
			true,
			false,
		);
		assert_eq!(fuzzy.strategy, Some(ContextMatchStrategy::Fuzzy));
		assert!(fuzzy.confidence > 0.8);
	}

	#[test]
	fn match_error_matches_typescript_formatter() {
		let closest = MatchOutcome {
			closest: Some(FuzzyMatch {
				actual_text: "alpha\ngamma".to_owned(),
				start_index: 10,
				start_line:  4,
				confidence:  0.874,
			}),
			..MatchOutcome::default()
		};
		let missing = MatchOutcome::default();
		assert_eq!(
			format_match_error("src/a.ts", "alpha\nbeta", &closest, true, 0.95),
			"Could not find a close enough match in src/a.ts.\n\nClosest match (87% similar) at line \
			 4:\n  - beta\n  + gamma\nClosest match was below the 95% similarity threshold."
		);
		assert_eq!(
			format_match_error("src/a.ts", "x", &missing, false, 0.95),
			"Could not find the exact text in src/a.ts. The old text must match exactly including \
			 all whitespace and newlines."
		);
		assert_eq!(
			format_match_error("src/a.ts", "alpha\nbeta", &closest, false, 0.95),
			"Could not find the exact text in src/a.ts.\n\nClosest match (87% similar) at line 4:\n  \
			 - beta\n  + gamma\nFuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to \
			 accept high-confidence matches."
		);
		assert_eq!(
			format_match_error("src/a.ts", "x", &missing, true, 0.95),
			"Could not find a close enough match in src/a.ts."
		);
	}

	#[test]
	fn replace_text_adjusts_indentation() {
		let result =
			replace_text("    foo\n    bar", "foo\nbar", "foo\nbaz\nbar", true, false, None).unwrap();
		assert_eq!(result, ReplaceResult {
			content: "    foo\n    baz\n    bar".to_owned(),
			count:   1,
		});

		let deindented = replace_text(
			"    foo\n    bar",
			"        foo\n        bar",
			"        foo\n        baz",
			true,
			false,
			Some(0.9),
		)
		.unwrap();
		assert_eq!(deindented.content, "    foo\n    baz");
	}

	#[test]
	fn replace_text_all_exact_and_fuzzy() {
		assert_eq!(
			replace_text("foo foo", "foo", "bar", false, true, None).unwrap(),
			ReplaceResult { content: "bar bar".to_owned(), count: 2 }
		);
		let old = "a".repeat(50);
		let first = format!("{}b", "a".repeat(49));
		let second = format!("{}cccccc", "a".repeat(44));
		let new = format!("{old}\nexpanded");
		// Two fuzzy windows and no exact occurrence: nothing is rewritten, and
		// the refusal names both windows.
		let error = replace_text(&format!("{first}\n{second}"), &old, &new, true, true, Some(0.8))
			.unwrap_err()
			.to_string();
		assert!(error.contains("start at lines 1 and 2"), "{error}");
	}

	#[test]
	fn replace_text_reports_ambiguity_and_normalizes_line_endings() {
		let error = replace_text("foo\nbar\nfoo", "foo", "x", false, false, None).unwrap_err();
		assert!(error.to_string().starts_with("Found 2 occurrences:"));
		assert_eq!(
			replace_text("a\r\nb", "a\r\nb", "c\r\nd", false, false, None).unwrap(),
			ReplaceResult { content: "c\nd".to_owned(), count: 1 }
		);
		assert_eq!(replace_text("abc", "missing", "x", false, false, None).unwrap(), ReplaceResult {
			content: "abc".to_owned(),
			count:   0,
		});
	}

	#[test]
	fn empty_old_text_is_an_apply_error() {
		assert_eq!(
			replace_text("x", "", "y", false, false, None)
				.unwrap_err()
				.to_string(),
			"oldText must not be empty."
		);
	}
}
