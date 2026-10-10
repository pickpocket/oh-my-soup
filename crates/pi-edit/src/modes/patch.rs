//! `patch` mode: JSON `edits[]` of `{op, rename?, diff?}` hunks against one
//! path. Port of `packages/coding-agent/src/edit/modes/patch.ts`.

use std::{
	borrow::Cow,
	cell::{Cell, OnceCell, Ref, RefCell},
	collections::{HashMap, HashSet, VecDeque},
	fmt::Write,
	ops::Range,
	path::Path,
	sync::Arc,
};

use pi_ast::{
	SupportLang,
	block::{
		BlockIndex, Insertion, LexicalRole, LexicalView, ParsedChange, SeparatorProof,
		has_continuation_candidate,
	},
	language::QuotePolicy,
};

use crate::{
	diff_string::{
		BlockContextSource, DiffHunk, LineDiff, generate_diff_string, normalize_create_content,
		parse_diff_hunks,
	},
	engine::{
		EditMode, FileOp, FileOpIntent, HeaderKind, Inspection, ModeEngine, PreviewFile, Resolved,
		StagedFile,
	},
	error::EditError,
	files::{FileRead, FileSource, persist_new},
	fuzzy::{
		CONTEXT_FUZZY_THRESHOLD, ContextEvidence, ContextLineResult, ContextMatchStrategy,
		ContextOccurrence, FindMatchOptions, MAX_RECORDED_MATCHES, MatchOutcome,
		SequenceMatchStrategy, SequenceSearchResult, candidate_details, file_lines,
		find_anchor_evidence, find_closest_sequence_match, find_match, format_patch_occurrence_error,
		line_list, preview_windows, seek_sequence, seek_sequence_within, similarity,
		truncate_preview,
	},
	notebook::is_notebook_path,
	store::EditStore,
	stream_json::{ArgSnapshot, EditEntry},
	text::{
		adjust_indentation, convert_leading_tabs_to_spaces, count_leading_whitespace,
		get_leading_whitespace, js_trim, js_trim_end, js_trim_start, normalize_for_fuzzy,
		normalize_unicode,
	},
};

const AMBIGUITY_HINT_WINDOW: usize = 200;
const MATCH_PREVIEW_CONTEXT: usize = 2;

/// Patch operation selected by an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
	/// Create a complete file from `diff`.
	Create,
	/// Delete an existing file.
	Delete,
	/// Apply unified hunks to an existing file.
	Update,
}

impl Operation {
	fn parse(value: Option<&str>) -> Result<Self, EditError> {
		match value.unwrap_or("update") {
			"create" => Ok(Self::Create),
			"delete" => Ok(Self::Delete),
			"update" => Ok(Self::Update),
			other => Err(EditError::apply(format!("Invalid patch operation: {other}"))),
		}
	}
}

/// One normalized single-file patch request.
pub struct PatchInput<'a> {
	/// Authored source path.
	pub path:   &'a str,
	/// Requested file operation.
	pub op:     Operation,
	/// Optional update destination.
	pub rename: Option<&'a str>,
	/// Full create content or update hunks.
	pub diff:   Option<&'a str>,
}

/// JSON patch mode engine.
pub struct PatchEngine {
	/// Whether inexact hunk placement is allowed.
	pub allow_fuzzy:     bool,
	/// Minimum confidence for character-level fallback matching.
	pub fuzzy_threshold: f64,
}

#[derive(Debug, Clone)]
struct Replacement {
	start_index: usize,
	old_len:     usize,
	new_lines:   Vec<String>,
	new_ids:     Vec<usize>,
	origins:     Vec<RowOrigin>,
	/// The file lines the hunk was placed over, its context included.
	window:      Range<usize>,
	/// The 1-based number of the hunk this change block comes from.
	hunk:        usize,
	/// The hunk puts a context line right above the block's added lines.
	above:       bool,
	/// The hunk puts a context line right below the block's added lines.
	below:       bool,
	/// An insertion placed by its `@@` anchor, tied to the line above it.
	anchored:    bool,
}

impl Replacement {
	/// Insertions tied to the gap only by the line below them go after the
	/// rest at that gap.
	const fn below_only(&self) -> bool {
		self.below && !self.above && !self.anchored
	}
}

/// Source correspondence shared by stationary adjacency and historical
/// evidence.
#[derive(Debug, Clone, Copy)]
enum RowOrigin {
	Retained(usize),
	Moved(usize),
	Rewritten(usize),
	Inserted,
}

fn inserted_runs(origins: &[RowOrigin], offset: usize) -> Vec<Range<usize>> {
	let mut runs: Vec<Range<usize>> = Vec::new();
	for (row, origin) in origins.iter().enumerate() {
		if matches!(origin, RowOrigin::Inserted) {
			let row = offset + row;
			if let Some(last) = runs.last_mut().filter(|last| last.end == row) {
				last.end += 1;
			} else {
				runs.push(row..row + 1);
			}
		}
	}
	runs
}

/// Byte-identical source identity creates safety evidence, including a move;
/// only an authored trailing assertion permits the following insertion gap.
fn semantic_insertion_gaps(
	origins: &[RowOrigin],
	mut leading: Option<usize>,
	trailing_context: Option<usize>,
) -> Vec<(usize, Range<usize>)> {
	let mut gaps = Vec::new();
	let mut row = 0;
	while row < origins.len() {
		match origins[row] {
			RowOrigin::Retained(old) | RowOrigin::Moved(old) => leading = Some(old + 1),
			RowOrigin::Rewritten(old) => {
				if leading.is_some() {
					leading = Some(old + 1);
				}
			},
			RowOrigin::Inserted => {
				let begin = row;
				while row < origins.len() && matches!(origins[row], RowOrigin::Inserted) {
					row += 1;
				}
				if let Some(gap) = leading
					&& trailing_context.is_none_or(|context| context < row)
				{
					gaps.push((gap, begin..row));
				}
				continue;
			},
		}
		row += 1;
	}
	gaps
}

/// Original row IDs and writer sets captured before this update's splices.
type OriginSnapshot = HashMap<usize, (usize, Option<Arc<HashSet<usize>>>)>;

fn row_origins(old: &[&str], new: &[String], retained: &[(usize, usize)]) -> Vec<RowOrigin> {
	let mut origins = vec![RowOrigin::Inserted; new.len()];
	let mut stationary = vec![false; old.len()];
	for &(source, target) in retained {
		stationary[source] = true;
		origins[target] = RowOrigin::Retained(source);
	}
	let mut sources = HashMap::<&str, VecDeque<usize>>::new();
	for (source, &text) in old.iter().enumerate() {
		if !stationary[source] {
			sources.entry(text).or_default().push_back(source);
		}
	}
	let mut moved = vec![false; old.len()];
	for (target, text) in new.iter().enumerate() {
		if matches!(origins[target], RowOrigin::Inserted)
			&& let Some(run) = sources.get_mut(text.as_str())
			&& let Some(source) = run.pop_front()
		{
			moved[source] = true;
			origins[target] = RowOrigin::Moved(source);
		}
	}
	let mut from = (0, 0);
	for (end_old, end_new) in retained.iter().copied().chain([(old.len(), new.len())]) {
		let sources = (from.0..end_old)
			.filter(|&at| !moved[at])
			.collect::<Vec<_>>();
		let targets = (from.1..end_new)
			.filter(|&at| matches!(origins[at], RowOrigin::Inserted))
			.collect::<Vec<_>>();
		from = (end_old + 1, end_new + 1);
		if sources.len() == 1 && targets.len() == 1 {
			origins[targets[0]] = RowOrigin::Rewritten(sources[0]);
		} else if !sources.is_empty() && !targets.is_empty() {
			let removed = sources.iter().map(|&at| old[at]).collect::<Vec<_>>();
			let added = targets
				.iter()
				.map(|&at| new[at].clone())
				.collect::<Vec<_>>();
			for (offset, paired) in counterparts(&removed, &added, &[], false, |_| true)
				.into_iter()
				.enumerate()
			{
				if paired == Some(offset) {
					origins[targets[offset]] = RowOrigin::Rewritten(sources[offset]);
				}
			}
		}
	}
	origins
}

/// Empty text has no semantic rows; the shared matcher keeps its historical
/// view.
fn patch_rows(text: &str) -> impl Iterator<Item = &str> {
	file_lines(text).take(if text.is_empty() { 0 } else { usize::MAX })
}

/// Change blocks with more removed-by-added line pairs than this are not
/// paired to find the added lines they open or close with.
const MAX_EDGE_PAIRS: usize = 1 << 16;

/// The lines of a change block's added run that pair with none of its
/// removed lines, at its start and at its end: added text the block opens or
/// closes with.
fn unpaired_edges(removed: &[&str], added: &[String]) -> (usize, usize) {
	if removed.is_empty() || added.len() <= removed.len() {
		return (0, 0);
	}
	if removed.len().saturating_mul(added.len()) > MAX_EDGE_PAIRS {
		// Unknown pairing: retain both context ties on the replacement atom.
		return (0, 0);
	}
	let paired = counterparts(removed, added, &[], false, |_| true)
		.into_iter()
		.flatten()
		.collect::<Vec<_>>();
	match (paired.iter().min(), paired.iter().max()) {
		(Some(first), Some(last)) => (*first, added.len() - 1 - last),
		_ => (0, 0),
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HunkVariantKind {
	TrimCommon,
	DedupeShared,
	CollapseRepeated,
	SingleLine,
}

/// A reshaped hunk: the positions of the hunk's old and new lines it keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
struct View {
	old: Vec<usize>,
	new: Vec<usize>,
}

impl View {
	fn whole(hunk: &DiffHunk) -> Self {
		Self { old: (0..hunk.old_lines.len()).collect(), new: (0..hunk.new_lines.len()).collect() }
	}

	/// Whole-hunk start, including leading context a repaired view omitted.
	fn start_at(&self, at: usize) -> isize {
		at as isize - self.old.first().map_or(0, |first| *first as isize)
	}

	fn old_refs<'a>(&self, hunk: &'a DiffHunk) -> Vec<&'a str> {
		self
			.old
			.iter()
			.map(|index| hunk.old_lines[*index].as_str())
			.collect()
	}

	fn new_refs<'a>(&self, hunk: &'a DiffHunk) -> Vec<&'a str> {
		self
			.new
			.iter()
			.map(|index| hunk.new_lines[*index].as_str())
			.collect()
	}

	fn new_lines(&self, hunk: &DiffHunk) -> Vec<String> {
		self
			.new
			.iter()
			.map(|index| hunk.new_lines[*index].clone())
			.collect()
	}

	/// The hunk's context lines this view keeps, as (old, new) positions in
	/// the view.
	fn context(&self, hunk: &DiffHunk) -> Vec<(usize, usize)> {
		hunk
			.context_lines
			.iter()
			.filter_map(|(old, new)| {
				Some((
					self.old.iter().position(|index| index == old)?,
					self.new.iter().position(|index| index == new)?,
				))
			})
			.collect()
	}
}

#[derive(Debug, Clone)]
struct HunkVariant {
	view: View,
	kind: HunkVariantKind,
}

fn is_blank_line(line: &str) -> bool {
	js_trim(line).is_empty()
}

fn equal_trimmed(left: &[String], right: &[String]) -> bool {
	left.len() == right.len()
		&& left
			.iter()
			.zip(right)
			.all(|(a, b)| js_trim(a) == js_trim(b))
}

fn indent_char(lines: &[String]) -> char {
	lines
		.iter()
		.find_map(|line| get_leading_whitespace(line).chars().next())
		.unwrap_or(' ')
}

fn apply_indent_delta(lines: &[String], delta: isize, indent: char) -> Vec<String> {
	lines
		.iter()
		.map(|line| {
			if is_blank_line(line) {
				return line.clone();
			}
			if delta > 0 {
				return format!("{}{}", indent.to_string().repeat(delta as usize), line);
			}
			let remove = (-delta) as usize;
			let remove = remove.min(count_leading_whitespace(line));
			line[remove..].to_owned()
		})
		.collect()
}

fn adjust_lines_indentation(
	pattern: &[String],
	actual: &[String],
	new_lines: &[String],
) -> Vec<String> {
	if pattern.is_empty() || actual.is_empty() || new_lines.is_empty() || pattern == actual {
		return new_lines.to_vec();
	}
	if equal_trimmed(pattern, new_lines) {
		return new_lines.to_vec();
	}

	let pattern_tab_only = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains(' '));
	let actual_space_only = actual
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains('\t'));
	let pattern_space_only = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains('\t'));
	let actual_tab_only = actual
		.iter()
		.filter(|line| !is_blank_line(line))
		.all(|line| !get_leading_whitespace(line).contains(' '));
	let pattern_mixed = pattern.iter().any(|line| {
		let ws = get_leading_whitespace(line);
		ws.contains(' ') && ws.contains('\t')
	});
	let actual_mixed = actual.iter().any(|line| {
		let ws = get_leading_whitespace(line);
		ws.contains(' ') && ws.contains('\t')
	});
	if !pattern_mixed && !actual_mixed && pattern_tab_only && actual_space_only {
		let mut ratio = None;
		let mut consistent = true;
		for (old, found) in pattern.iter().zip(actual) {
			if is_blank_line(old) || is_blank_line(found) {
				continue;
			}
			let old_indent = count_leading_whitespace(old);
			let found_indent = count_leading_whitespace(found);
			if old_indent == 0 {
				continue;
			}
			if !found_indent.is_multiple_of(old_indent) {
				consistent = false;
				break;
			}
			let next = found_indent / old_indent;
			if ratio.is_some_and(|value| value != next) {
				consistent = false;
				break;
			}
			ratio = Some(next);
		}
		if consistent && ratio.is_some_and(|value| value > 0) {
			let ratio = ratio.unwrap();
			let valid = pattern.iter().zip(actual).all(|(old, found)| {
				is_blank_line(old)
					|| is_blank_line(found)
					|| get_leading_whitespace(old).is_empty()
					|| count_leading_whitespace(found) == count_leading_whitespace(old) * ratio
			});
			if valid {
				return convert_leading_tabs_to_spaces(&new_lines.join("\n"), ratio)
					.split('\n')
					.map(str::to_owned)
					.collect();
			}
		}
	}

	if !pattern_mixed && !actual_mixed && pattern_space_only && actual_tab_only {
		let mut samples = std::collections::BTreeMap::<usize, usize>::new();
		let mut consistent = true;
		for (old, found) in pattern.iter().zip(actual) {
			if is_blank_line(old) || is_blank_line(found) {
				continue;
			}
			let spaces = count_leading_whitespace(old);
			let tabs = count_leading_whitespace(found);
			if tabs == 0 {
				continue;
			}
			if samples
				.insert(tabs, spaces)
				.is_some_and(|prior| prior != spaces)
			{
				consistent = false;
				break;
			}
		}
		if consistent && !samples.is_empty() {
			let (width, offset) = if samples.len() == 1 {
				let (&tabs, &spaces) = samples.first_key_value().unwrap();
				(spaces.checked_div(tabs).filter(|_| spaces % tabs == 0), 0_isize)
			} else {
				let mut values = samples.iter();
				let (&tabs_a, &spaces_a) = values.next().unwrap();
				let (&tabs_b, &spaces_b) = values.next().unwrap();
				let tabs_delta = tabs_b as isize - tabs_a as isize;
				let spaces_delta = spaces_b as isize - spaces_a as isize;
				if tabs_delta != 0 && spaces_delta > 0 && spaces_delta % tabs_delta == 0 {
					let width = spaces_delta / tabs_delta;
					let offset = spaces_a as isize - tabs_a as isize * width;
					let valid = width > 0
						&& samples
							.iter()
							.all(|(&tabs, &spaces)| tabs as isize * width + offset == spaces as isize);
					(valid.then_some(width as usize), offset)
				} else {
					(None, 0)
				}
			};
			if let Some(width) = width.filter(|width| *width > 0) {
				return new_lines
					.iter()
					.map(|line| {
						if is_blank_line(line) {
							return line.clone();
						}
						let spaces = count_leading_whitespace(line);
						if spaces == 0 {
							return line.clone();
						}
						let adjusted = spaces as isize - offset;
						if adjusted < 0 {
							return line.clone();
						}
						let tabs = adjusted as usize / width;
						let remainder = adjusted as usize - tabs * width;
						format!("{}{}{}", "\t".repeat(tabs), " ".repeat(remainder), &line[spaces..])
					})
					.collect();
			}
		}
	}

	let mut deltas = pattern
		.iter()
		.zip(actual)
		.filter(|(a, b)| !is_blank_line(a) && !is_blank_line(b))
		.map(|(a, b)| count_leading_whitespace(b) as isize - count_leading_whitespace(a) as isize);
	let delta = deltas
		.next()
		.filter(|first| deltas.all(|value| value == *first));
	let pattern_min = pattern
		.iter()
		.filter(|line| !is_blank_line(line))
		.map(|line| count_leading_whitespace(line))
		.min()
		.unwrap_or(0);
	let mut by_content = std::collections::HashMap::<String, Vec<&String>>::new();
	for line in actual.iter().filter(|line| !is_blank_line(line)) {
		by_content
			.entry(js_trim(line).to_owned())
			.or_default()
			.push(line);
	}
	let mut used = std::collections::HashMap::<String, usize>::new();
	let indent = indent_char(actual);
	new_lines
		.iter()
		.enumerate()
		.map(|(line_index, line)| {
			if is_blank_line(line) {
				return line.clone();
			}
			let trimmed = js_trim(line).to_owned();
			if let Some(matches) = by_content.get(&trimmed) {
				if matches.len() == 1 {
					return (*matches[0]).clone();
				}
				if matches.iter().any(|candidate| candidate.as_str() == line) {
					return line.clone();
				}
				let index = used.entry(trimmed).or_default();
				if let Some(found) = matches.get(*index) {
					*index += 1;
					return (**found).clone();
				}
			}
			if pattern.len() == new_lines.len()
				&& let (Some(pattern_line), Some(actual_line)) =
					(pattern.get(line_index), actual.get(line_index))
				&& !is_blank_line(pattern_line)
				&& !is_blank_line(actual_line)
			{
				let local_delta = count_leading_whitespace(actual_line) as isize
					- count_leading_whitespace(pattern_line) as isize;
				if local_delta != 0
					&& count_leading_whitespace(line) == count_leading_whitespace(pattern_line)
				{
					return apply_indent_delta(std::slice::from_ref(line), local_delta, indent)
						.remove(0);
				}
			}
			if let Some(delta) = delta.filter(|value| *value != 0)
				&& count_leading_whitespace(line) == pattern_min
			{
				return apply_indent_delta(std::slice::from_ref(line), delta, indent).remove(0);
			}
			line.clone()
		})
		.collect()
}

/// Old and new lines of a hunk shared by both sides; only those may collapse.
fn shared_lines<'a>(hunk: &'a DiffHunk, view: &View) -> HashSet<&'a str> {
	let new_set = view
		.new
		.iter()
		.map(|index| hunk.new_lines[*index].as_str())
		.collect::<HashSet<_>>();
	view
		.old
		.iter()
		.map(|index| hunk.old_lines[*index].as_str())
		.filter(|line| new_set.contains(line))
		.collect()
}

#[allow(clippy::suspicious_operation_groupings, reason = "paired index bounds are intentional")]
fn trim_common_context(hunk: &DiffHunk, view: &View) -> Option<View> {
	let old = |index: usize| &hunk.old_lines[view.old[index]];
	let new = |index: usize| &hunk.new_lines[view.new[index]];
	let mut start = 0;
	let mut old_end = view.old.len();
	let mut new_end = view.new.len();
	while start < old_end && start < new_end && old(start) == new(start) {
		start += 1;
	}
	while old_end > start && new_end > start && old(old_end - 1) == new(new_end - 1) {
		old_end -= 1;
		new_end -= 1;
	}
	if start == 0 && old_end == view.old.len() && new_end == view.new.len() {
		return None;
	}
	let trimmed =
		View { old: view.old[start..old_end].to_vec(), new: view.new[start..new_end].to_vec() };
	(!trimmed.old.is_empty() || !trimmed.new.is_empty()).then_some(trimmed)
}

fn collapse_consecutive_shared(hunk: &DiffHunk, view: &View) -> Option<View> {
	let shared = shared_lines(hunk, view);
	let collapse = |lines: &[String], keep: &[usize]| {
		let mut output = Vec::new();
		let mut index = 0;
		while index < keep.len() {
			output.push(keep[index]);
			let text = lines[keep[index]].as_str();
			let mut next = index + 1;
			while next < keep.len() && lines[keep[next]] == text && shared.contains(text) {
				next += 1;
			}
			index = next;
		}
		output
	};
	let collapsed =
		View { old: collapse(&hunk.old_lines, &view.old), new: collapse(&hunk.new_lines, &view.new) };
	(collapsed != *view).then_some(collapsed)
}

fn collapse_repeated_blocks(hunk: &DiffHunk, view: &View) -> Option<View> {
	let shared = shared_lines(hunk, view);
	let collapse = |lines: &[String], keep: &[usize]| {
		let mut output = keep.to_vec();
		let mut index = 0;
		while index < output.len() {
			let text = |at: usize, output: &[usize]| lines[output[at]].as_str();
			let mut collapsed = false;
			if shared.contains(text(index, &output)) {
				for size in (2..=(output.len() - index) / 2).rev() {
					if (0..size).all(|offset| {
						text(index + offset, &output) == text(index + size + offset, &output)
							&& shared.contains(text(index + offset, &output))
					}) {
						output.drain(index + size..index + size * 2);
						collapsed = true;
						break;
					}
				}
			}
			if !collapsed {
				index += 1;
			}
		}
		output
	};
	let collapsed =
		View { old: collapse(&hunk.old_lines, &view.old), new: collapse(&hunk.new_lines, &view.new) };
	(collapsed != *view).then_some(collapsed)
}

fn reduce_single_line(hunk: &DiffHunk, view: &View) -> Option<View> {
	if view.old.is_empty() || view.old.len() != view.new.len() {
		return None;
	}
	let changed = (0..view.old.len())
		.filter(|index| hunk.old_lines[view.old[*index]] != hunk.new_lines[view.new[*index]])
		.collect::<Vec<_>>();
	(changed.len() == 1)
		.then(|| View { old: vec![view.old[changed[0]]], new: vec![view.new[changed[0]]] })
}

fn fallback_variants(hunk: &DiffHunk, aggressive: bool) -> Vec<HunkVariant> {
	let whole = View::whole(hunk);
	let mut variants = Vec::new();
	let trimmed = trim_common_context(hunk, &whole);
	if let Some(view) = &trimmed {
		variants.push(HunkVariant { view: view.clone(), kind: HunkVariantKind::TrimCommon });
	}
	let base = trimmed.unwrap_or(whole);
	let deduped = collapse_consecutive_shared(hunk, &base);
	if let Some(view) = &deduped {
		variants.push(HunkVariant { view: view.clone(), kind: HunkVariantKind::DedupeShared });
	}
	if let Some(view) = collapse_repeated_blocks(hunk, deduped.as_ref().unwrap_or(&base)) {
		variants.push(HunkVariant { view, kind: HunkVariantKind::CollapseRepeated });
	}
	if let Some(view) = reduce_single_line(hunk, &base) {
		variants.push(HunkVariant { view, kind: HunkVariantKind::SingleLine });
	}
	let mut seen = HashSet::new();
	variants.retain(|variant| {
		(aggressive
			|| !matches!(
				variant.kind,
				HunkVariantKind::CollapseRepeated | HunkVariantKind::SingleLine
			))
			&& seen.insert((variant.view.old_refs(hunk), variant.view.new_refs(hunk)))
	});
	variants
}

const fn sequence_strategy_label(strategy: SequenceMatchStrategy) -> &'static str {
	match strategy {
		SequenceMatchStrategy::Exact => "exact",
		SequenceMatchStrategy::TrimTrailing => "trim-trailing",
		SequenceMatchStrategy::Trim => "trim",
		SequenceMatchStrategy::CommentPrefix => "comment-prefix",
		SequenceMatchStrategy::Unicode => "unicode",
		SequenceMatchStrategy::Prefix => "prefix",
		SequenceMatchStrategy::Substring => "substring",
		SequenceMatchStrategy::Fuzzy => "fuzzy",
		SequenceMatchStrategy::FuzzyDominant => "fuzzy-dominant",
		SequenceMatchStrategy::Character => "character",
	}
}

/// Ladder rank of a placement's tier: lower is stricter.
const fn tier(strategy: Option<SequenceMatchStrategy>) -> u8 {
	match strategy {
		Some(SequenceMatchStrategy::Exact) => 0,
		Some(SequenceMatchStrategy::TrimTrailing) => 1,
		Some(SequenceMatchStrategy::Trim) => 2,
		Some(SequenceMatchStrategy::CommentPrefix) => 3,
		Some(SequenceMatchStrategy::Unicode) => 4,
		Some(SequenceMatchStrategy::Prefix) => 5,
		Some(SequenceMatchStrategy::Substring) => 6,
		Some(SequenceMatchStrategy::Fuzzy | SequenceMatchStrategy::FuzzyDominant) => 7,
		Some(SequenceMatchStrategy::Character) | None => 8,
	}
}

const fn context_strategy_label(strategy: ContextMatchStrategy) -> &'static str {
	match strategy {
		ContextMatchStrategy::Exact => "exact",
		ContextMatchStrategy::Trim => "trim",
		ContextMatchStrategy::Unicode => "unicode",
		ContextMatchStrategy::Prefix => "prefix",
		ContextMatchStrategy::Substring => "substring",
		ContextMatchStrategy::CaseFold => "case-fold",
		ContextMatchStrategy::Fuzzy => "fuzzy",
	}
}

fn sequence_preview(lines: &[&str], index: usize) -> String {
	preview_windows(lines, &[index], 1, MATCH_PREVIEW_CONTEXT).concat()
}

/// Previews of the first candidates, every displayed candidate row marked,
/// and how many were left out on a line of its own.
fn sequence_previews(
	lines: &[&str],
	indices: Option<&[usize]>,
	count: Option<usize>,
) -> Option<String> {
	let indices = indices.filter(|value| !value.is_empty())?;
	let shown = indices.len().min(MAX_RECORDED_MATCHES);
	let mut output = preview_windows(lines, indices, shown, MATCH_PREVIEW_CONTEXT).join("\n\n");
	if let Some(count) = count
		&& count > shown
	{
		let _ = write!(output, "\n(showing first {shown} of {count})");
	}
	Some(output)
}

/// Whether a search found several equally ranked placements.
fn is_ambiguous(result: &SequenceSearchResult) -> bool {
	result.match_count.is_some_and(|count| count > 1)
}

/// Whether a search located anything, uniquely or not.
fn is_hit(result: &SequenceSearchResult) -> bool {
	result.index.is_some() || is_ambiguous(result)
}

/// A hunk's own zero-based line hint, never a carried cursor or offset.
/// Placements certain without their own hint, including elimination, may
/// veto a conflicting hinted match but cannot select its placement.
#[derive(Debug, Clone, Copy, Default)]
struct Hints {
	raw: Option<usize>,
}

impl Hints {
	fn of(hunk: &DiffHunk) -> Self {
		Self {
			raw: hunk
				.old_start_line
				.or_else(|| hunk.new_start_line.filter(|_| hunk.old_lines.is_empty()))
				.and_then(|hint| (hint as usize).checked_sub(1)),
		}
	}

	/// Line hints only break ties among equally ranked candidates; they never
	/// place on their own, because model-written hunk line numbers are rarely
	/// right (Diff-XYZ, arXiv 2510.12487, §3.2). An exact hint wins; otherwise
	/// only one candidate within [`AMBIGUITY_HINT_WINDOW`] may be selected.
	fn pick(self, candidates: &[usize]) -> Option<usize> {
		let hint = self.raw?;
		if candidates.contains(&hint) {
			return Some(hint);
		}
		let near = |hint: usize| {
			let mut near = candidates
				.iter()
				.copied()
				.filter(|index| index.abs_diff(hint) <= AMBIGUITY_HINT_WINDOW);
			match (near.next(), near.next()) {
				(Some(only), None) => Some(only),
				_ => None,
			}
		};
		near(hint)
	}
}

/// Narrow an ambiguous placement with the line hints. Evidence ranks
/// lexicographically: tier, then score, then hint. A hint may only choose
/// among candidates equal on tier and score, so while lower-ranked
/// candidates remain undominated nothing a hint says settles the placement.
fn tie_break(mut result: SequenceSearchResult, hints: Hints) -> SequenceSearchResult {
	if !is_ambiguous(&result) {
		return result;
	}
	let candidates = result.match_indices.as_deref().unwrap_or_default();
	if result
		.top_indices
		.as_ref()
		.is_some_and(|top| top.len() < candidates.len())
	{
		return result;
	}
	if let Some(index) = hints.pick(candidates) {
		result.index = Some(index);
		result.match_count = Some(1);
		result.match_indices = Some(vec![index]);
		result.top_indices = None;
	}
	result
}

/// A hunk that contains its anchor line proves its own position: it starts
/// `k` lines above an anchor candidate when its `k`-th old line is the anchor
/// line. Only the strict tiers prove anything, and only the strictest proofs
/// count (Wu & Manber, TR 91-11, §3.3), so a near copy at one candidate never
/// beats an exact copy at another.
fn prove_by_anchor_line(
	lines: &[&str],
	pattern: &[&str],
	candidates: &[usize],
	changed: &[usize],
	consumed: &[Consumed],
) -> Option<(SequenceSearchResult, Option<ConsumedBest>)> {
	let pattern_normalized = pattern
		.iter()
		.map(|line| normalize_unicode(line))
		.collect::<Vec<_>>();
	let mut proven = Vec::new();
	for &candidate in candidates {
		let anchor_text = normalize_unicode(lines[candidate]);
		for (offset, _) in pattern_normalized
			.iter()
			.enumerate()
			.filter(|(_, line)| **line == anchor_text)
		{
			let Some(at) = candidate.checked_sub(offset) else {
				continue;
			};
			let found = seek_sequence_within(lines, pattern, at, at + 1, false, false);
			if found.index == Some(at) {
				proven.push((tier(found.strategy), at, found));
			}
		}
	}
	let best = proven.iter().map(|(rank, ..)| *rank).min()?;
	proven.sort_by_key(|(rank, at, _)| (*rank, *at));
	proven.dedup_by_key(|(_, at, _)| *at);
	let top = proven
		.iter()
		.filter(|(rank, ..)| *rank == best)
		.map(|(_, at, _)| *at)
		.collect::<Vec<_>>();
	let mut proven = proven.into_iter();
	let (_, _, first) = proven.next()?;
	let result = SequenceSearchResult {
		index: top.first().copied(),
		match_count: Some(top.len()),
		top_indices: None,
		match_indices: Some(top),
		..first
	};
	let (result, mut by) = exclude_consumed(result, changed, consumed);
	if let Some(by) = by.as_mut() {
		let first = changed.first().copied().unwrap_or_default();
		by.lower = proven
			.filter(|(rank, ..)| *rank != best)
			.map(|(_, at, _)| at)
			.filter(|at| consumer(*at, changed, consumed).is_none())
			.map(|at| at + first)
			.collect();
	}
	Some((result, by))
}

/// Place `pattern` under a resolved anchor. Candidates are every placement
/// strictly after the anchor (Codex parser.rs) and inside its region: an
/// anchor resets the scope, so the cursor never narrows them, and only what
/// earlier hunks replaced is excluded (see [`exclude_consumed`]). In a
/// region the syntax tree bounds, the usual ladder applies; in an uncertain
/// one, only a placement unique across the strict tiers is accepted.
fn place_in_anchor(
	lines: &[&str],
	pattern: &[&str],
	anchor: &Anchor,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	let start = anchor.line + 1;
	if anchor.certain {
		seek_sequence_within(lines, pattern, start, anchor.end, eof, allow_fuzzy)
	} else {
		seek_strict_union(lines, pattern, start, anchor.end, eof, allow_fuzzy)
	}
}

/// Lines an earlier hunk of the patch changed (removed or replaced, never
/// its context lines), and that hunk's 1-based number.
#[derive(Debug, Clone)]
struct Consumed {
	lines: Range<usize>,
	hunk:  usize,
}

/// The earlier hunk whose changed lines a placement at `at` would change
/// again (`changed`: the placed pattern's changed offsets), with the first
/// such line.
fn consumer(at: usize, changed: &[usize], consumed: &[Consumed]) -> Option<(usize, usize)> {
	changed.iter().find_map(|offset| {
		consumed
			.iter()
			.find(|earlier| earlier.lines.contains(&(at + offset)))
			.map(|earlier| (at + offset, earlier.hunk))
	})
}

/// Why no best-ranked placement remains: its first changed row, the row
/// overlapping an earlier hunk and that hunk, and the first changed row of
/// each lower-ranked placement that cannot inherit the consumed best.
#[derive(Debug, Clone)]
struct ConsumedBest {
	start: usize,
	line:  usize,
	hunk:  usize,
	lower: Vec<usize>,
}

/// Drop placements whose changed lines an earlier hunk of the same patch
/// already changed: each file line is changed at most once, so such a copy
/// is no candidate, while every other copy still is, and hunks may share
/// context lines. When every best-ranked placement was dropped, lower-ranked
/// ones never inherit them; while one survives, the survivors count as the
/// tier counts them. Returns why nothing remains, when nothing does.
fn exclude_consumed(
	result: SequenceSearchResult,
	changed: &[usize],
	consumed: &[Consumed],
) -> (SequenceSearchResult, Option<ConsumedBest>) {
	exclude_consumed_by(result, changed.first().copied().unwrap_or_default(), |at| {
		consumer(at, changed, consumed)
	})
}

fn exclude_consumed_by(
	mut result: SequenceSearchResult,
	first: usize,
	mut consume: impl FnMut(usize) -> Option<(usize, usize)>,
) -> (SequenceSearchResult, Option<ConsumedBest>) {
	let dropped = result
		.index
		.iter()
		.chain(result.top_indices.iter().flatten())
		.chain(result.match_indices.iter().flatten())
		.find_map(|at| consume(*at).map(|(line, hunk)| (*at + first, line, hunk)));
	let Some((start, line, hunk)) = dropped else {
		return (result, None);
	};
	let mut overlaps = |at: &usize| consume(*at).is_some();
	let mut indices = result
		.match_indices
		.take()
		.unwrap_or_else(|| result.index.into_iter().collect());
	let recorded = indices.len();
	indices.retain(|at| !overlaps(at));
	let mut count = result
		.match_count
		.unwrap_or(recorded)
		.saturating_sub(recorded - indices.len());
	let mut lower = Vec::new();
	let mut top = result.top_indices.take();
	if let Some(top) = top.as_mut() {
		top.retain(|at| !overlaps(at));
		if top.is_empty() {
			// Lower-ranked placements never inherit a consumed best one; while
			// a best one survives, they still count as the tier counts them.
			lower = std::mem::take(&mut indices)
				.into_iter()
				.map(|at| at + first)
				.collect();
			count = 0;
		}
	}
	if count == 0 || indices.is_empty() {
		let none = SequenceSearchResult {
			index: None,
			match_count: Some(0),
			match_indices: None,
			top_indices: None,
			strategy: None,
			..result
		};
		return (none, Some(ConsumedBest { start, line, hunk, lower }));
	}
	result.index = indices.first().copied();
	result.match_count = Some(count);
	result.top_indices = top.filter(|top| top.len() < indices.len());
	result.match_indices = Some(indices);
	(result, None)
}

/// Strict-tier rank of `actual` against `expected`: 0 exact, 1 trailing
/// whitespace, 2 surrounding whitespace, 3 Unicode punctuation.
fn strict_rank(actual: &str, expected: &str) -> Option<u8> {
	if actual == expected {
		Some(0)
	} else if js_trim_end(actual) == js_trim_end(expected) {
		Some(1)
	} else if js_trim(actual) == js_trim(expected) {
		Some(2)
	} else if normalize_unicode(actual) == normalize_unicode(expected) {
		Some(3)
	} else {
		None
	}
}

/// The loosest strict rank at which `pattern` matches `lines` at `at`.
fn window_rank(lines: &[&str], pattern: &[&str], at: usize) -> Option<u8> {
	pattern
		.iter()
		.enumerate()
		.try_fold(0, |worst, (offset, expected)| {
			strict_rank(lines[at + offset], expected).map(|rank| worst.max(rank))
		})
}

const STRICT_STRATEGIES: [(SequenceMatchStrategy, f64); 4] = [
	(SequenceMatchStrategy::Exact, 1.0),
	(SequenceMatchStrategy::TrimTrailing, 0.99),
	(SequenceMatchStrategy::Trim, 0.98),
	(SequenceMatchStrategy::Unicode, 0.97),
];

/// Placements of `pattern` starting in `[from, end)` where nothing bounds
/// the region: every strict-tier placement counts as a candidate, so a copy
/// that differs only in whitespace still keeps an exact one ambiguous, and
/// only when no strict placement exists may the loose tiers place it. A hint
/// may only choose among candidates of the same tier.
fn seek_strict_union(
	lines: &[&str],
	pattern: &[&str],
	from: usize,
	end: usize,
	eof: bool,
	allow_fuzzy: bool,
) -> SequenceSearchResult {
	let ladder = || seek_sequence_within(lines, pattern, from, end, eof, allow_fuzzy);
	if pattern.is_empty() || pattern.len() > lines.len() || end == 0 {
		return ladder();
	}
	let last_start = lines.len() - pattern.len();
	let max_start = last_start.min(end - 1);
	if from > max_start {
		return ladder();
	}
	let mut hits = Vec::new();
	if eof
		&& max_start == last_start
		&& let Some(rank) = window_rank(lines, pattern, last_start)
	{
		hits.push((last_start, rank));
	} else {
		hits.extend(
			(from..=max_start).filter_map(|at| window_rank(lines, pattern, at).map(|rank| (at, rank))),
		);
	}
	let Some(best) = hits.iter().map(|(_, rank)| *rank).min() else {
		return ladder();
	};
	let indices = hits.iter().map(|(at, _)| *at).collect::<Vec<_>>();
	let top = hits
		.iter()
		.filter(|(_, rank)| *rank == best)
		.map(|(at, _)| *at)
		.collect::<Vec<_>>();
	let (strategy, confidence) = STRICT_STRATEGIES[usize::from(best)];
	SequenceSearchResult {
		index: Some(top[0]),
		confidence,
		match_count: Some(indices.len()),
		top_indices: (top.len() < indices.len()).then_some(top),
		match_indices: Some(indices),
		strategy: Some(strategy),
	}
}

/// Evidence a reshaped hunk variant needs before it may edit: it drops
/// context, and more stripped context means more faulty patches (GNU
/// diffutils §10.3.3; `FixMorph`, ISSTA'21, §4.3). The variant must place
/// uniquely in the whole file at `found`, and keep a line that occurs exactly
/// once in the file (Heckel, CACM 21(4), §3: a line unique in both texts is
/// the same line).
fn variant_is_evidenced(lines: &[&str], variant: &[&str], found: usize, allow_fuzzy: bool) -> bool {
	let whole = seek_sequence(lines, variant, 0, false, allow_fuzzy);
	if whole.index != Some(found) || is_ambiguous(&whole) {
		return false;
	}
	variant.iter().enumerate().any(|(offset, line)| {
		let text = js_trim(line);
		!text.is_empty()
			&& lines
				.get(found + offset)
				.is_some_and(|actual| js_trim(actual) == text)
			&& lines
				.iter()
				.filter(|actual| js_trim(actual) == text)
				.count()
				== 1
	})
}

/// Context lines the variant dropped place the hunk somewhere else when some
/// of them occur in the file and none confirms the placement (Heckel, CACM
/// 21(4), §3): the variant would edit a region the hunk did not describe. A
/// dropped line confirms the placement when a copy of it lies on its own
/// side of the placed block, before it for leading context and after it for
/// trailing context, within as many lines as the variant dropped on that
/// side, plus one for a line unique in the file. One stale context line next
/// to confirming neighbours does not veto, and a copy inside the placed lines
/// confirms nothing.
fn dropped_context_elsewhere(lines: &[&str], hunk: &DiffHunk, view: &View, found: usize) -> bool {
	let (Some(&first_kept), Some(&last_kept)) = (view.old.first(), view.old.last()) else {
		return false;
	};
	let placed = found..found + view.old.len();
	let dropped_after = hunk.old_lines.len() - 1 - last_kept;
	// One line of slack on each side, for a line unique in the file: a stale
	// line between such context and the placement does not move it, while a
	// repeated line only confirms where the hunk puts it.
	let leading = |unique: bool| found.saturating_sub(first_kept + usize::from(unique))..found;
	let trailing = |unique: bool| placed.end..placed.end + dropped_after + usize::from(unique);
	let mut present = false;
	for &(old, _) in &hunk.context_lines {
		let line = hunk.old_lines[old].as_str();
		if view.old.contains(&old) || is_trivial_line(line) || (first_kept..=last_kept).contains(&old)
		{
			continue;
		}
		let text = js_trim(line);
		let copies = lines
			.iter()
			.enumerate()
			.filter(|(index, actual)| !placed.contains(index) && js_trim(actual) == text)
			.map(|(index, _)| index)
			.collect::<Vec<_>>();
		let unique = copies.len() == 1;
		let side = if old < first_kept {
			leading(unique)
		} else {
			trailing(unique)
		};
		if copies.iter().any(|index| side.contains(index)) {
			return false;
		}
		present |= !copies.is_empty();
	}
	present
}

/// GNU patch's "Reversed (or previously applied) patch detected": the
/// hunk's new side, holding something besides punctuation, sits in exactly
/// one of the windows where the hunk's old side could have been placed, line
/// for line equal up to whitespace. Those windows are the anchor's region
/// (the whole file without an anchor), the windows a hunk containing its
/// anchor line proves, and the same for the new side without its trailing
/// blank line, as the old side is retried. Without a certain anchor a lone
/// added line found elsewhere is no evidence, so the new side must carry a
/// context line.
fn already_applied(lines: &[&str], hunk: &DiffHunk, anchor: Option<&Anchor>) -> Option<usize> {
	if hunk.new_lines == hunk.old_lines || hunk.new_lines.iter().all(|line| is_trivial_line(line)) {
		return None;
	}
	if !anchor.is_some_and(|anchor| anchor.certain) && hunk.context_lines.is_empty() {
		return None;
	}
	let (from, end) =
		anchor.map_or((0, lines.len()), |anchor| (anchor.line + 1, anchor.end.min(lines.len())));
	let mut forms = vec![hunk.new_lines.as_slice()];
	if hunk.new_lines.len() > 1 && hunk.new_lines.last().is_some_and(|line| line.is_empty()) {
		forms.push(&hunk.new_lines[..hunk.new_lines.len() - 1]);
	}
	let expected = hunk
		.new_lines
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect::<Vec<_>>();
	// Windows a hunk containing its anchor line proves start `k` lines above
	// the anchor when its `k`-th new line is the anchor line.
	let proven = anchor.map_or_else(Vec::new, |anchor| {
		let text = normalize_for_fuzzy(lines[anchor.line]);
		expected
			.iter()
			.enumerate()
			.filter(|(_, line)| **line == text)
			.filter_map(|(offset, _)| anchor.line.checked_sub(offset))
			.collect::<Vec<_>>()
	});
	let low = proven.iter().copied().fold(from, usize::min);
	let high = lines
		.len()
		.min(end.max(anchor.map_or(0, |anchor| anchor.line + expected.len())));
	let actual = lines[low..high]
		.iter()
		.map(|line| normalize_for_fuzzy(line))
		.collect::<Vec<_>>();
	let mut found = Vec::new();
	for width in forms.iter().map(|form| form.len()) {
		let expected = &expected[..width];
		let starts = (from..(end + 1).saturating_sub(width)).chain(proven.iter().copied());
		for at in starts {
			if at + width <= high
				&& !found.contains(&at)
				&& actual[at - low..at - low + width] == *expected
			{
				found.push(at);
			}
		}
	}
	match found.as_slice() {
		[only] => Some(*only),
		_ => None,
	}
}

/// The region of a block beginning on an anchor line.
#[derive(Debug, Clone, Copy)]
struct Region {
	/// Exclusive end: one past the block's last line when `certain`, else EOF.
	end:           usize,
	/// The selected, parse-valid syntax construct spans multiple rows.
	/// Unknown grammars, single-row anchors and selected recovery-error
	/// subtrees remain uncertain; unrelated sibling errors do not matter.
	certain:       bool,
	column:        Option<usize>,
	envelope:      Option<usize>,
	domain:        bool,
	owned_end_gap: bool,
}

/// The file's lines, its original text and path for the syntax tree, parsed
/// at most once, and the region of every anchor line asked about.
struct Layout<'a> {
	lines:           &'a [&'a str],
	path:            &'a str,
	/// The file's content as read, the bytes the session's parse check reads,
	/// so both share one cached parse.
	code:            &'a str,
	index:           OnceCell<Option<BlockIndex<'a>>>,
	regions:         RefCell<HashMap<usize, HashMap<String, Region>>>,
	anchors:         OnceCell<AnchorRows<'a>>,
	matches:         RefCell<HashMap<String, ContextEvidence>>,
	suggestion_rows: RefCell<Option<HashSet<usize>>>,
	proof_errors:    RefCell<HashMap<usize, String>>,
}

#[derive(Default)]
struct AnchorRows<'a> {
	exact:   HashMap<&'a str, Vec<usize>>,
	trimmed: HashMap<&'a str, Vec<usize>>,
	unicode: HashMap<String, Vec<usize>>,
}

/// Syntax indexes are bounded by the parse-cache limit. Required ownership
/// evidence refuses when the supported-language index is unavailable.
const TREE_SOURCE_LIMIT: usize = 4 << 20;

impl<'a> Layout<'a> {
	fn new(lines: &'a [&'a str], path: &'a str, code: &'a str) -> Self {
		Self {
			lines,
			path,
			code,
			index: OnceCell::new(),
			regions: RefCell::default(),
			anchors: OnceCell::new(),
			matches: RefCell::default(),
			suggestion_rows: RefCell::default(),
			proof_errors: RefCell::default(),
		}
	}

	fn anchor_evidence(&self, part: &str) -> Ref<'_, ContextEvidence> {
		if self.matches.borrow().contains_key(part) {
			return Ref::map(self.matches.borrow(), |matches| &matches[part]);
		}
		let strict = strict_hits(self, part);
		let evidence = if strict.is_empty() {
			find_anchor_evidence(self.lines, part, true)
		} else {
			let occurrences = strict
				.iter()
				.map(|&(row, rank)| {
					let text = self.lines[row];
					ContextOccurrence {
						row,
						span: text.len() - js_trim_start(text).len()..js_trim_end(text).len(),
						whole_row: true,
						function_fallback: false,
						strategy: strict_strategy(rank),
						veto_only: false,
					}
				})
				.collect();
			ContextEvidence {
				result: ContextLineResult {
					index:         strict.first().map(|&(row, _)| row),
					confidence:    1.0,
					match_count:   Some(strict.len()),
					match_indices: Some(strict.iter().map(|&(row, _)| row).collect()),
					strategy:      strict
						.iter()
						.map(|&(_, rank)| rank)
						.min()
						.map(strict_strategy),
				},
				occurrences,
			}
		};
		self.matches.borrow_mut().insert(part.to_owned(), evidence);
		Ref::map(self.matches.borrow(), |matches| &matches[part])
	}

	/// The file's syntax tree, parsed on first use; `None` when the language
	/// is unknown or the file too large.
	fn index(&self) -> Option<&BlockIndex<'a>> {
		self
			.index
			.get_or_init(|| {
				(self.code.len() <= TREE_SOURCE_LIMIT)
					.then(|| BlockIndex::new(self.code, self.path).ok().flatten())
					.flatten()
			})
			.as_ref()
	}

	/// The region of the syntax block beginning on `line`: scoping a search
	/// to the enclosing function or block by syntax (`FixMorph`, ISSTA'21,
	/// §4.2; Coccinelle, `EuroSys`'08) lets non-unique lines become unique in a
	/// smaller part (git xdiff xpatience.c).
	fn region(&self, line: usize, anchor: &str) -> Region {
		if let Some(region) = self
			.regions
			.borrow()
			.get(&line)
			.and_then(|row| row.get(anchor))
		{
			return *region;
		}
		if let Some(rows) = self.suggestion_rows.borrow_mut().as_mut() {
			if !rows.contains(&line) && rows.len() >= SUGGESTION_SCAN_LINES * MAX_RECORDED_MATCHES {
				return Region {
					end:           self.lines.len(),
					certain:       false,
					column:        None,
					envelope:      None,
					domain:        false,
					owned_end_gap: false,
				};
			}
			rows.insert(line);
		}
		let matched = self.anchor_evidence(anchor);
		let occurrences = matched
			.occurrences
			.iter()
			.filter(|occurrence| occurrence.row == line)
			.collect::<Vec<_>>();
		let columns = occurrences
			.iter()
			.filter(|occurrence| !occurrence.veto_only)
			.map(|occurrence| occurrence.span.start)
			.collect::<Vec<_>>();
		let mut region = Region {
			end:           self.lines.len(),
			certain:       false,
			column:        columns.first().copied(),
			envelope:      None,
			domain:        false,
			owned_end_gap: false,
		};
		if let Some(index) = self.index() {
			let mut evidence = Vec::new();
			let mut rejected = false;
			let mut unproved_veto = false;
			for occurrence in occurrences {
				let column = occurrence.span.start;
				if index.unsupported_payload_anchor(tree_line(line), column) {
					rejected |= !occurrence.veto_only;
					continue;
				}
				let whole_header = occurrence.whole_row
					&& matches!(
						occurrence.strategy,
						ContextMatchStrategy::Exact
							| ContextMatchStrategy::Trim
							| ContextMatchStrategy::Unicode
					);
				match index.checked_scope_occurrence(
					tree_line(line),
					column,
					whole_header,
					!occurrence.veto_only,
				) {
					Ok(Some((proof, column))) if !occurrence.veto_only || !proof.host_domain => {
						if occurrence.whole_row && occurrence.strategy == ContextMatchStrategy::Fuzzy {
							match index.scope_header_code(tree_line(line), column, proof) {
								Ok(Some(code))
									if similarity(
										&normalize_for_fuzzy(&code),
										&normalize_for_fuzzy(anchor),
									) < CONTEXT_FUZZY_THRESHOLD =>
								{
									rejected = true;
									continue;
								},
								Err(error) => {
									self
										.proof_errors
										.borrow_mut()
										.insert(line, error.to_string());
									rejected = true;
									continue;
								},
								_ => {},
							}
						}
						evidence.push((proof, column, occurrence.veto_only));
					},
					Ok(Some(_)) => {},
					Ok(None)
						if !occurrence.veto_only
							&& occurrence.function_fallback
							&& occurrence.strategy == ContextMatchStrategy::Fuzzy =>
					{
						rejected = true;
					},
					Ok(None) => {},
					Err(_) if occurrence.veto_only => unproved_veto = true,
					Err(error) => {
						self
							.proof_errors
							.borrow_mut()
							.insert(line, error.to_string());
						rejected = true;
					},
				}
			}
			if unproved_veto {
				region.column = None;
			} else if let Some(&(first, column, _)) =
				evidence.iter().find(|(_, _, veto_only)| !veto_only)
			{
				if evidence
					.iter()
					.all(|(proof, ..)| proof.owner == first.owner)
				{
					region.column = Some(column);
					region.envelope = Some(first.range.end_line as usize);
					region.certain = evidence
						.iter()
						.filter(|(_, _, veto_only)| !veto_only)
						.all(|(proof, ..)| proof.certain && !proof.host_domain);
					region.domain = evidence
						.iter()
						.filter(|(_, _, veto_only)| !veto_only)
						.all(|(proof, ..)| proof.certain && proof.host_domain);
					region.owned_end_gap = evidence
						.iter()
						.filter(|(_, _, veto_only)| !veto_only)
						.all(|(proof, ..)| proof.certain && proof.owned_end_gap);
					if region.certain {
						region.end = first.range.end_line as usize;
					}
				} else {
					region.column = None;
				}
			} else if rejected || columns.len() > 1 {
				region.column = None;
			}
		} else if Syntax::for_path(self.path).language.is_some() {
			region.column = None;
		}
		self
			.regions
			.borrow_mut()
			.entry(line)
			.or_default()
			.insert(anchor.to_owned(), region);
		region
	}

	/// Where an anchored pure insertion goes (see
	/// [`BlockIndex::anchored_insertion`]): right below the anchor, the
	/// literal V4A position, unless the parse of the construct holding the
	/// anchor puts it at the top of the construct's body. A position the parse
	/// cannot settle is refused.
	fn insertion_line(&self, anchor: &Anchor, text: &str) -> Result<usize, EditError> {
		let row = anchor.line;
		let after = row + 1;
		let column = anchor.column.ok_or_else(|| {
			EditError::apply(format!(
				"The anchor at line {} in {} identifies different constructs; add a unique context \
				 line.",
				row + 1,
				self.path,
			))
		})?;
		let Some(index) = self.index() else {
			return Ok(after);
		};
		match index.anchored_gap(tree_line(row), column, text) {
			Ok(outcome) => insertion_result(outcome, self.path),
			Err(_) => Ok(after),
		}
	}
}

fn insertion_result(outcome: Insertion, path: &str) -> Result<usize, EditError> {
	match outcome {
		Insertion::At(line) => Ok(line as usize - 1),
		Insertion::DetachesAttribute { attribute, item } => Err(EditError::apply(format!(
			"Inserting the lines in {path} would detach '{attribute}' from '{item}'; add a context \
			 line from the intended position.",
			attribute = truncate_preview(&attribute),
			item = truncate_preview(&item),
		))),
		Insertion::EndsConstruct { start } => Err(EditError::apply(format!(
			"Inserting the lines in {path} would end the construct beginning '{start}' inside them; \
			 add a context line from the intended position.",
			start = truncate_preview(&start),
		))),
		Insertion::PushesOut { header, displaced, braces } => Err(EditError::apply(format!(
			"Inserting the lines in {path} would move '{displaced}' out of '{header}'; add {}a \
			 context line from the intended position.",
			if braces { "braces or " } else { "" },
			displaced = truncate_preview(&displaced),
			header = truncate_preview(&header),
		))),
		Insertion::NeitherParses { body, header } => Err(EditError::apply(format!(
			"Neither after the anchor nor at the top of the body of '{header}' (line {body}) do the \
			 inserted lines parse in {path} with '{header}' kept whole; add a context line from the \
			 intended position.",
			header = truncate_preview(&header),
		))),
		Insertion::ConstructHasErrors { body, header, error_line } => Err(EditError::apply(format!(
			"'{header}' in {path} holds a syntax error at line {error_line}, so the insertion could \
			 go after the anchor or at the top of the body (line {body}); add a context line from \
			 the intended position.",
			header = truncate_preview(&header),
		))),
	}
}

/// The 1-indexed syntax-tree line of 0-based `line`.
fn tree_line(line: usize) -> u32 {
	u32::try_from(line + 1).unwrap_or(u32::MAX)
}

/// A resolved `@@` anchor: its (innermost) line and the region its hunk may
/// be placed in.
#[derive(Debug, Clone)]
struct Anchor {
	line:          usize,
	/// Exclusive end of the region: the block's end, or EOF (or the enclosing
	/// anchor's end) when uncertain.
	end:           usize,
	certain:       bool,
	column:        Option<usize>,
	owned_end_gap: bool,
	/// Each uncertain ancestor keeps its own negative lookup origin.
	envelopes:     Vec<(usize, usize)>,
	/// Certified host bounds survive a missing native inner construct.
	domains:       Vec<(usize, usize, bool)>,
	/// Every certified enclosing construct constrains the complete footprint.
	bounds:        Vec<(usize, usize, bool)>,
	/// Anchor parts resolved through the prefix, substring or fuzzy tier:
	/// (part, line, strategy).
	inexact:       Vec<(String, usize, ContextMatchStrategy)>,
	/// Resolved anchor parts, outer to inner, with their matching tier.
	parts:         Vec<(usize, u8)>,
}

#[derive(Debug)]
enum AnchorOutcome {
	Found,
	/// A found ambiguous prefix cannot authorize an unprocessed suffix.
	Incomplete {
		part: String,
	},
	/// A part matched several lines that nothing distinguishes.
	Ambiguous {
		part:   String,
		result: ContextLineResult,
	},
	/// A nested part matched only outside the enclosing part's region.
	Outside {
		part:  String,
		outer: usize,
		end:   usize,
		hits:  Vec<usize>,
	},
	Missing,
}

/// An `@@` anchor, resolved as far as its parts allow.
#[derive(Debug)]
struct AnchorLookup {
	outcome:      AnchorOutcome,
	/// The anchor when found. When a nested part failed, the part enclosing
	/// it: its region still bounds the hunk, which never falls back to the
	/// whole file.
	scope:        Option<Anchor>,
	/// Lines the last part tried matched in scope (at the strict tiers when
	/// any): a hunk containing one of them proves its own position.
	proof:        Option<Vec<usize>>,
	/// Reuse the already-built outer text of a resolved space-split query.
	spaced_outer: Option<String>,
	/// Complete strict internal paths, bounded by proved native/domain
	/// ancestors. Their candidate union retains ancestor column and end-gap
	/// authority.
	strict_paths: Option<Vec<(usize, usize, bool)>>,
}

/// Lines matching an anchor part at the strict tiers, each with its tier
/// (0 exact, 1 trim, 2 unicode).
fn strict_hits(layout: &Layout<'_>, part: &str) -> Vec<(usize, u8)> {
	let rows = layout.anchors.get_or_init(|| {
		let mut rows = AnchorRows::default();
		for (row, line) in layout.lines.iter().enumerate() {
			rows.exact.entry(line).or_default().push(row);
			rows.trimmed.entry(js_trim(line)).or_default().push(row);
			if !line.is_ascii() {
				rows
					.unicode
					.entry(normalize_unicode(line))
					.or_default()
					.push(row);
			}
		}
		rows
	});
	let trimmed = js_trim(part);
	let unicode = if part.is_ascii() {
		Cow::Borrowed(trimmed)
	} else {
		Cow::Owned(normalize_unicode(part))
	};
	let mut hits = Vec::new();
	for (rows, rank) in [
		(rows.exact.get(part), 0),
		(rows.trimmed.get(trimmed), 1),
		(rows.trimmed.get(unicode.as_ref()), 2),
		(rows.unicode.get(unicode.as_ref()), 2),
	] {
		if let Some(rows) = rows {
			hits.extend(rows.iter().map(|row| (*row, rank)));
		}
	}
	hits.sort_unstable();
	hits.dedup_by_key(|hit| hit.0);
	hits
}

const fn strict_strategy(rank: u8) -> ContextMatchStrategy {
	match rank {
		0 => ContextMatchStrategy::Exact,
		1 => ContextMatchStrategy::Trim,
		_ => ContextMatchStrategy::Unicode,
	}
}

const fn context_tier(strategy: Option<ContextMatchStrategy>) -> u8 {
	match strategy {
		Some(ContextMatchStrategy::Exact) => 0,
		Some(ContextMatchStrategy::Trim) => 1,
		Some(ContextMatchStrategy::Unicode) => 2,
		Some(ContextMatchStrategy::Prefix) => 4,
		Some(ContextMatchStrategy::Substring) => 5,
		Some(ContextMatchStrategy::CaseFold) => 6,
		Some(ContextMatchStrategy::Fuzzy) => 7,
		None => 8,
	}
}

/// Choose among an anchor part's candidate lines.
///
/// - A hunk containing the anchor line at old-line offset `k` starts `k` lines
///   above its anchor, so a candidate `c` with `c − k` on a hint is the one.
/// - Otherwise a line hint names the hunk's first line, which lies in the
///   intended anchor's region, so candidates whose region holds a hint stay.
/// - The hint rule then decides, refusing ties.
fn pick_anchor(
	layout: &Layout<'_>,
	candidates: &[usize],
	hints: Hints,
	offsets: &[usize],
	part: &str,
) -> Option<usize> {
	if let [only] = candidates {
		return Some(*only);
	}
	let hint = hints.raw?;
	let starting = candidates
		.iter()
		.copied()
		.filter(|candidate| {
			offsets.iter().any(|offset| {
				candidate
					.checked_sub(*offset)
					.is_some_and(|start| start == hint)
			})
		})
		.collect::<Vec<_>>();
	if let [only] = starting.as_slice() {
		return Some(*only);
	}
	let containing = candidates
		.iter()
		.copied()
		.filter(|candidate| {
			let region = *candidate..layout.region(*candidate, part).end;
			region.contains(&hint)
		})
		.collect::<Vec<_>>();
	match containing.as_slice() {
		[only] => Some(*only),
		[] => hints.pick(candidates),
		several => hints.pick(several),
	}
}

/// Resolve anchor parts outer to inner. The first part is matched over the
/// whole file at its minimal tier. A nested part is matched inside the region
/// of the part before it, where exact, trim and unicode count as one strict
/// rank: non-unique lines can become unique in a smaller part (git xdiff
/// xpatience.c; Nugroho et al., arXiv 1902.02467, §3.2), but a looser tier
/// never stands in for a strict hit elsewhere. Loose hits rank by score, and
/// a hint may only choose among the best.
fn resolve_parts(
	layout: &Layout<'_>,
	parts: &[&str],
	hints: Hints,
	allow_fuzzy: bool,
	hunk_old: &[String],
	capture: bool,
	author_parts: bool,
) -> AnchorLookup {
	let lines = layout.lines;
	let mut scope: Option<Anchor> = None;
	let mut inexact = Vec::new();
	let mut proof = None;
	for (depth, part) in parts.iter().enumerate() {
		let within = |hit: usize| {
			scope
				.as_ref()
				.is_none_or(|outer| hit > outer.line && hit < outer.end)
		};
		let strict = strict_hits(layout, part);
		let in_scope = strict
			.iter()
			.copied()
			.filter(|(hit, _)| within(*hit))
			.collect::<Vec<_>>();
		proof = Some(in_scope.iter().map(|(hit, _)| *hit).collect::<Vec<_>>());
		let (hits, inside, strategy) = if strict.is_empty() {
			let loose = if allow_fuzzy {
				layout.anchor_evidence(part).result.clone()
			} else {
				ContextLineResult {
					index:         None,
					confidence:    0.0,
					match_count:   None,
					match_indices: None,
					strategy:      None,
				}
			};
			let hits = loose.match_indices.unwrap_or_default();
			let inside = hits
				.iter()
				.copied()
				.filter(|hit| within(*hit))
				.collect::<Vec<_>>();
			proof = Some(inside.clone());
			(hits, inside, loose.strategy)
		} else {
			let best = in_scope.iter().map(|(_, rank)| *rank).min();
			let inside = in_scope
				.iter()
				.filter(|(_, rank)| depth > 0 || Some(*rank) == best)
				.map(|(hit, _)| *hit)
				.collect::<Vec<_>>();
			(strict.iter().map(|(hit, _)| *hit).collect(), inside, best.map(strict_strategy))
		};
		if inside.is_empty() {
			let outcome = match &scope {
				Some(outer) if !hits.is_empty() => AnchorOutcome::Outside {
					part: js_trim(part).to_owned(),
					outer: outer.line,
					end: outer.end,
					hits,
				},
				_ => AnchorOutcome::Missing,
			};
			return AnchorLookup { outcome, scope, proof, spaced_outer: None, strict_paths: None };
		}
		let ambiguous = |inside: Vec<usize>| {
			if author_parts && depth + 1 < parts.len() {
				AnchorOutcome::Incomplete { part: js_trim(part).to_owned() }
			} else {
				AnchorOutcome::Ambiguous {
					part:   js_trim(part).to_owned(),
					result: ContextLineResult {
						index: inside.first().copied(),
						confidence: 1.0,
						match_count: Some(inside.len()),
						match_indices: Some(inside),
						strategy,
					},
				}
			}
		};
		// A numeric location cannot prove case-sensitive construct identity.
		if strategy == Some(ContextMatchStrategy::CaseFold) && inside.len() > 1 {
			return AnchorLookup {
				outcome: ambiguous(inside),
				scope,
				proof,
				spaced_outer: None,
				strict_paths: None,
			};
		}
		// A fuzzy anchor's hits differ in score: while a lower-scored hit
		// remains, no hint may settle on the best one (as for hunk lines).
		if strategy == Some(ContextMatchStrategy::Fuzzy) && inside.len() > 1 {
			let target = normalize_for_fuzzy(part);
			let scores = inside
				.iter()
				.map(|hit| similarity(&normalize_for_fuzzy(lines[*hit]), &target))
				.collect::<Vec<_>>();
			let best = scores.iter().copied().fold(0.0_f64, f64::max);
			if scores.iter().any(|score| *score < best) {
				return AnchorLookup {
					outcome: ambiguous(inside),
					scope,
					proof,
					spaced_outer: None,
					strict_paths: None,
				};
			}
		}
		let text = normalize_unicode(part);
		let offsets = hunk_old
			.iter()
			.enumerate()
			.filter(|(_, line)| normalize_unicode(line) == text)
			.map(|(offset, _)| offset)
			.collect::<Vec<_>>();
		let Some(line) = pick_anchor(layout, &inside, hints, &offsets, part) else {
			return AnchorLookup {
				outcome: ambiguous(inside),
				scope,
				proof,
				spaced_outer: None,
				strict_paths: None,
			};
		};
		if let Some(strategy) = strategy.filter(|strategy| {
			matches!(
				strategy,
				ContextMatchStrategy::Prefix
					| ContextMatchStrategy::Substring
					| ContextMatchStrategy::CaseFold
					| ContextMatchStrategy::Fuzzy
			)
		}) {
			inexact.push((js_trim(part).to_owned(), line, strategy));
		}
		let region = layout.region(line, part);
		let end = scope
			.as_ref()
			.map_or(region.end, |outer| region.end.min(outer.end));
		let owned_end_gap = region.owned_end_gap
			&& (region.certain || region.envelope == Some(region.end))
			&& region.end == end
			&& scope
				.as_ref()
				.is_none_or(|outer| end < outer.end || outer.owned_end_gap);
		let column = if scope.as_ref().is_some_and(|outer| outer.column.is_none()) {
			None
		} else {
			region.column
		};
		let (mut evidence, mut envelopes, mut domains, mut bounds) = scope.take().map_or_else(
			|| (Vec::new(), Vec::new(), Vec::new(), Vec::new()),
			|anchor| (anchor.parts, anchor.envelopes, anchor.domains, anchor.bounds),
		);
		if region.certain {
			bounds.push((line, region.end, region.owned_end_gap));
		}
		if region.domain
			&& let Some(end) = region.envelope
		{
			domains.push((line, end, region.owned_end_gap));
		}
		if !region.certain
			&& !region.domain
			&& let Some(end) = region.envelope
		{
			envelopes.push((line, end));
		}
		if capture {
			let rank = context_tier(strategy);
			evidence.push((line, if depth > 0 && rank <= 2 { 0 } else { rank }));
		}
		scope = Some(Anchor {
			line,
			end,
			certain: region.certain,
			column,
			owned_end_gap,
			envelopes,
			domains,
			bounds,
			inexact: inexact.clone(),
			parts: evidence,
		});
	}
	let outcome = if scope.is_some() {
		AnchorOutcome::Found
	} else {
		AnchorOutcome::Missing
	};
	AnchorLookup { outcome, scope, proof, spaced_outer: None, strict_paths: None }
}

/// Resolve an `@@` anchor, possibly nested. Whole-row evidence wins first;
/// an all-strict internal hierarchy then outranks a weaker whole-text match.
/// An unresolved strict hierarchy never promotes a looser interpretation.
fn find_hierarchical_context(
	layout: &Layout<'_>,
	context: &str,
	hints: Hints,
	allow_fuzzy: bool,
	hunk_old: &[String],
	capture: bool,
) -> AnchorLookup {
	let parts = context
		.split('\n')
		.filter(|part| !js_trim(part).is_empty())
		.collect::<Vec<_>>();
	if parts.len() > 1 {
		return resolve_parts(layout, &parts, hints, allow_fuzzy, hunk_old, capture, true);
	}
	let whole = resolve_parts(layout, &[context], hints, false, hunk_old, capture, false);
	if matches!(whole.outcome, AnchorOutcome::Found | AnchorOutcome::Ambiguous { .. }) {
		return whole;
	}
	let space_parts = context.split_whitespace().collect::<Vec<_>>();
	let has_signature = context
		.chars()
		.any(|ch| matches!(ch, '(' | ')' | '{' | '}' | '[' | ']'));
	let spaced = (!has_signature && space_parts.len() >= 2).then(|| {
		(space_parts[..space_parts.len() - 1].join(" "), space_parts[space_parts.len() - 1])
	});
	if let Some((outer, inner)) = spaced.as_ref() {
		// Qualify complete strict paths independently of the hint. An
		// ambiguous outer alone must not mask a missing inner part.
		let (mut parents, _) = anchor_successors(layout, outer, None, None, Hints::default(), false);
		for (row, end) in &mut parents {
			let region = layout.region(*row, outer);
			if region.domain {
				*end = (*end).min(region.envelope.unwrap_or(region.end));
			}
		}
		let (mut children, rank) =
			anchor_successors(layout, inner, Some(&parents), None, Hints::default(), false);
		for (row, end) in &mut children {
			let region = layout.region(*row, inner);
			if region.domain {
				*end = (*end).min(region.envelope.unwrap_or(region.end));
			}
		}
		if !children.is_empty() {
			let mut lookup =
				resolve_parts(layout, &[outer.as_str(), inner], hints, false, hunk_old, capture, false);
			if !(matches!(lookup.outcome, AnchorOutcome::Found)
				|| matches!(lookup.outcome, AnchorOutcome::Ambiguous { .. }) && lookup.scope.is_some())
			{
				let rows = children.iter().map(|&(row, _)| row).collect::<Vec<_>>();
				lookup.proof = Some(rows.clone());
				lookup.scope = None;
				lookup.outcome = AnchorOutcome::Ambiguous {
					part:   (*inner).to_owned(),
					result: ContextLineResult {
						index:         rows.first().copied(),
						confidence:    1.0,
						match_count:   Some(rows.len()),
						match_indices: Some(rows),
						strategy:      Some(strict_strategy(rank)),
					},
				};
			}
			if matches!(lookup.outcome, AnchorOutcome::Ambiguous { .. }) {
				let mut parent = 0;
				let mut parent_end = 0;
				let mut parent_owned_gap = false;
				lookup.strict_paths = Some(
					children
						.into_iter()
						.filter_map(|(row, end)| {
							while let Some(&(ancestor, bound)) =
								parents.get(parent).filter(|&&(ancestor, _)| ancestor < row)
							{
								let region = layout.region(ancestor, outer);
								if region.column.is_some() && bound >= parent_end {
									if bound > parent_end {
										parent_end = bound;
										parent_owned_gap = false;
									}
									parent_owned_gap |= region.owned_end_gap
										&& (bound == region.end
											|| region.domain && region.envelope == Some(bound));
								}
								parent += 1;
							}
							let end = end.min(parent_end);
							(row < end).then_some((row, end, end < parent_end || parent_owned_gap))
						})
						.collect(),
				);
			}
			if capture {
				lookup.spaced_outer = spaced.map(|(outer, _)| outer);
			}
			return lookup;
		}
	}
	let whole = if allow_fuzzy {
		resolve_parts(layout, &[context], hints, true, hunk_old, capture, false)
	} else {
		whole
	};
	if matches!(whole.outcome, AnchorOutcome::Found | AnchorOutcome::Ambiguous { .. }) {
		return whole;
	}
	if let Some((outer, inner)) = spaced {
		let mut lookup = resolve_parts(
			layout,
			&[outer.as_str(), inner],
			hints,
			allow_fuzzy,
			hunk_old,
			capture,
			false,
		);
		if matches!(lookup.outcome, AnchorOutcome::Found)
			|| space_parts.len() >= 3 && matches!(lookup.outcome, AnchorOutcome::Ambiguous { .. })
		{
			if capture {
				lookup.spaced_outer = Some(outer);
			}
			return lookup;
		}
	}
	whole
}

fn anchor_text<'a>(context: &'a str, lookup: &'a AnchorLookup) -> Vec<&'a str> {
	if let Some(outer) = lookup.spaced_outer.as_deref() {
		return vec![
			outer,
			context
				.split_whitespace()
				.last()
				.expect("resolved spaced anchor has an inner part"),
		];
	}
	let parts = context
		.split('\n')
		.filter(|part| !js_trim(part).is_empty())
		.collect::<Vec<_>>();
	if parts.len() > 1 {
		parts
	} else {
		vec![context]
	}
}

/// Reachable anchor rows and their clipped regions. Overlapping parent
/// regions are scanned as a union, not expanded into combinations of paths.
fn anchor_successors(
	layout: &Layout<'_>,
	part: &str,
	parents: Option<&[(usize, usize)]>,
	forced: Option<usize>,
	hints: Hints,
	allow_fuzzy: bool,
) -> (Vec<(usize, usize)>, u8) {
	let strict = strict_hits(layout, part);
	let (hits, rank, fuzzy) = if strict.is_empty() {
		let found = if allow_fuzzy {
			layout.anchor_evidence(part).result.clone()
		} else {
			ContextLineResult {
				index:         None,
				confidence:    0.0,
				match_count:   None,
				match_indices: None,
				strategy:      None,
			}
		};
		(
			found.match_indices.unwrap_or_default(),
			context_tier(found.strategy),
			found.strategy == Some(ContextMatchStrategy::Fuzzy),
		)
	} else {
		let best = strict.iter().map(|(_, rank)| *rank).min().unwrap();
		let hits = strict
			.into_iter()
			.filter(|(_, rank)| parents.is_some() || *rank == best)
			.map(|(row, _)| row)
			.collect();
		(hits, if parents.is_some() { 0 } else { best }, false)
	};
	let mut parent = 0;
	let mut end = 0;
	let mut reachable = hits
		.into_iter()
		.filter_map(|row| {
			if let Some(parents) = parents {
				while parent < parents.len() && parents[parent].0 < row {
					end = end.max(parents[parent].1);
					parent += 1;
				}
				if row >= end {
					return None;
				}
			} else {
				end = layout.lines.len();
			}
			Some((row, layout.region(row, part).end.min(end)))
		})
		.collect::<Vec<_>>();
	if fuzzy {
		let target = normalize_for_fuzzy(part);
		let mut best = 0.0;
		let mut kept = 0;
		for index in 0..reachable.len() {
			let edge = reachable[index];
			let score = similarity(&normalize_for_fuzzy(layout.lines[edge.0]), &target);
			if score > best {
				best = score;
				kept = 0;
			}
			if score == best {
				if kept != index {
					reachable[kept] = edge;
				}
				kept += 1;
			}
		}
		reachable.truncate(kept);
	}
	let chosen = forced.or_else(|| {
		hints.raw.filter(|_| reachable.len() > 1).and_then(|_| {
			pick_anchor(
				layout,
				&reachable.iter().map(|&(row, _)| row).collect::<Vec<_>>(),
				hints,
				&[],
				part,
			)
		})
	});
	if let Some(chosen) = chosen {
		reachable.retain(|&(row, _)| row == chosen);
	}
	(reachable, rank)
}

/// Where a hunk may be placed: inside an anchor's region (the anchor, or the
/// part enclosing a nested part that failed) or anywhere in the file, and
/// what proves a hunk that contains its anchor line.
#[derive(Clone, Copy, Default)]
struct Target<'a> {
	anchor: Option<&'a Anchor>,
	proof:  Option<&'a [usize]>,
}

/// Where one hunk lands after the trailing-blank retry and evidenced
/// variants, and the old and new lines it was placed with.
struct PreparedEffect {
	new_lines: Vec<String>,
	retained:  Vec<(usize, usize)>,
	changed:   Vec<usize>,
	origins:   Vec<RowOrigin>,
}

struct PlacedHunk {
	/// The placement after hint tie-breaking.
	result:          SequenceSearchResult,
	/// The hunk lines placed.
	view:            View,
	/// Old lines a reshaped variant dropped.
	ignored_context: Option<usize>,
	variant_used:    bool,
	/// The hunk's new lines already sit at this line and its old lines match
	/// nowhere.
	already_applied: Option<usize>,
	/// The old lines matched only after the trailing blank line was dropped.
	retried:         bool,
	/// Every placement left changes a line an earlier hunk changes.
	consumed_by:     Option<ConsumedBest>,
	/// Actual byte effects, prepared once after placement and reused for
	/// writing.
	effect:          Option<PreparedEffect>,
	lookup:          Option<AnchorLookup>,
}

impl PlacedHunk {
	fn unique_start(&self) -> Option<isize> {
		self
			.result
			.index
			.filter(|_| !is_ambiguous(&self.result))
			.map(|at| self.view.start_at(at))
	}

	/// A complete exact preimage can identify its own context header. It does
	/// not authorize reduced views, normalized placements or an outer escape.
	fn bind_context_anchor(&self, layout: &Layout<'_>, lookup: &mut AnchorLookup, hunk: &DiffHunk) {
		if self.result.strategy != Some(SequenceMatchStrategy::Exact)
			|| self.variant_used
			|| !self.view.old.iter().copied().eq(0..hunk.old_lines.len())
			|| !self.view.new.iter().copied().eq(0..hunk.new_lines.len())
			|| lookup
				.scope
				.as_ref()
				.is_some_and(|anchor| anchor.column.is_none())
		{
			return;
		}
		let Some(at) = self.result.index.filter(|_| !is_ambiguous(&self.result)) else {
			return;
		};
		if !hunk.old_lines.iter().enumerate().all(|(offset, line)| {
			layout
				.lines
				.get(at + offset)
				.is_some_and(|source| *source == line)
		}) {
			return;
		}
		let Some(part) = hunk
			.change_context
			.as_deref()
			.and_then(|context| context.lines().rev().find(|part| !js_trim(part).is_empty()))
		else {
			return;
		};
		let part = js_trim(part);
		let normalized_part = OnceCell::new();
		let mut context = hunk.context_lines.iter().filter(|(row, _)| {
			let line = js_trim(&hunk.old_lines[*row]);
			if line == part {
				return true;
			}
			if line.is_ascii() && part.is_ascii() {
				return false;
			}
			let part = if part.is_ascii() {
				part
			} else {
				normalized_part
					.get_or_init(|| normalize_unicode(part))
					.as_str()
			};
			if line.is_ascii() {
				line == part
			} else {
				normalize_unicode(line) == part
			}
		});
		let Some(&(offset, _)) = context.next() else {
			return;
		};
		if context.next().is_some() {
			return;
		}
		let row = at + offset;
		let region = layout.region(row, layout.lines[row]);
		if region.column.is_none() || !region.certain && !region.domain {
			return;
		}
		if !region.certain
			&& (lookup.scope.as_ref().is_some_and(|anchor| anchor.certain)
				|| matches!(&lookup.outcome, AnchorOutcome::Ambiguous { part, result }
				if result.match_indices.as_ref().is_some_and(|rows| rows.iter().any(|&row| layout.region(row, part).certain))))
		{
			return;
		}
		let mut anchor = lookup.scope.take().unwrap_or(Anchor {
			line:          row,
			end:           layout.lines.len(),
			certain:       false,
			column:        None,
			owned_end_gap: false,
			envelopes:     Vec::new(),
			domains:       Vec::new(),
			bounds:        Vec::new(),
			inexact:       Vec::new(),
			parts:         Vec::new(),
		});
		if matches!(lookup.outcome, AnchorOutcome::Found) {
			let previous = anchor.line;
			anchor.bounds.retain(|&(line, ..)| line != previous);
			anchor.domains.retain(|&(line, ..)| line != previous);
			anchor.envelopes.retain(|&(line, _)| line != previous);
			anchor.inexact.retain(|(_, line, _)| *line != previous);
		}
		let inherited_end = anchor
			.bounds
			.iter()
			.map(|&(_, end, _)| end)
			.min()
			.unwrap_or(layout.lines.len());
		anchor.line = row;
		anchor.end = region.end.min(inherited_end);
		anchor.certain = region.certain;
		anchor.column = region.column;
		anchor.owned_end_gap = region.owned_end_gap && anchor.end == region.end;
		if region.certain {
			anchor.bounds.push((row, region.end, region.owned_end_gap));
		}
		if region.domain
			&& let Some(end) = region.envelope
		{
			anchor.domains.push((row, end, region.owned_end_gap));
		}
		if !region.certain
			&& !region.domain
			&& let Some(end) = region.envelope
		{
			anchor.envelopes.push((row, end));
		}
		lookup.scope = Some(anchor);
		lookup.outcome = AnchorOutcome::Found;
		let proof = lookup.proof.get_or_insert_with(Vec::new);
		proof.clear();
		proof.push(row);
	}

	/// Ranking chooses a placement first; anchor evidence can veto it but
	/// must never rerun the search at a weaker tier.
	fn eligible(
		&mut self,
		layout: &Layout<'_>,
		lookup: &AnchorLookup,
		hunk: &DiffHunk,
		allow_fuzzy: bool,
	) -> bool {
		let Some(at) = self.result.index.filter(|_| !is_ambiguous(&self.result)) else {
			return true;
		};
		if lookup
			.scope
			.as_ref()
			.is_some_and(|anchor| anchor.column.is_none())
		{
			return false;
		}
		let view = &self.view;
		let effect = self
			.effect
			.get_or_insert_with(|| prepare_effect(layout.lines, hunk, view, at));
		let changed = &effect.changed;
		let mut gaps = Vec::new();
		let mut gap = at;
		let mut inserted = false;
		for origin in &effect.origins {
			match origin {
				RowOrigin::Inserted => {
					if !inserted {
						gaps.push(gap);
					}
					inserted = true;
				},
				RowOrigin::Retained(row) | RowOrigin::Moved(row) | RowOrigin::Rewritten(row) => {
					gap = at + row + 1;
					inserted = false;
				},
			}
		}
		let pattern = OnceCell::new();
		let alternative = |row: usize, end: usize| {
			seek_sequence_within(
				layout.lines,
				pattern.get_or_init(|| view.old_refs(hunk)),
				row + 1,
				end.saturating_sub(changed.last().copied().unwrap_or(0)),
				hunk.is_end_of_file,
				allow_fuzzy,
			)
			.index
			.is_some()
		};
		let escapes = |row: usize, end: usize| {
			(changed.iter().any(|offset| at + offset >= end) || gaps.iter().any(|gap| *gap >= end))
				&& alternative(row, end)
		};
		if lookup
			.scope
			.as_ref()
			.is_some_and(|anchor| anchor.envelopes.iter().any(|&(row, end)| escapes(row, end)))
		{
			return false;
		}
		let contained = |row: usize, end: usize, owned_end_gap: bool| {
			changed
				.iter()
				.all(|offset| row <= at + offset && at + offset < end)
				&& gaps.iter().all(|gap| {
					row < *gap
						&& (*gap < end
							|| *gap == end
								&& (owned_end_gap
									|| hunk.old_lines.is_empty()
										&& end == row + 1
										&& at == end
										&& lookup
											.scope
											.as_ref()
											.is_some_and(|anchor| anchor.certain && anchor.line == row)))
				})
		};
		if lookup.scope.as_ref().is_some_and(|anchor| {
			anchor
				.bounds
				.iter()
				.any(|&(row, end, owned_end_gap)| !contained(row, end, owned_end_gap))
		}) {
			return false;
		}
		if lookup.scope.as_ref().is_some_and(|anchor| {
			anchor
				.domains
				.iter()
				.any(|&(row, end, owned_end_gap)| !contained(row, end, owned_end_gap))
		}) {
			return false;
		}
		let AnchorOutcome::Ambiguous { part, result } = &lookup.outcome else {
			return true;
		};
		let candidates = result
			.match_indices
			.as_deref()
			.unwrap_or_default()
			.iter()
			.map(|&row| (row, layout.region(row, part)))
			.collect::<Vec<_>>();
		let native = candidates.iter().any(|(_, region)| region.certain);
		if let Some(paths) = lookup.strict_paths.as_deref() {
			let mut path = 0;
			return candidates.iter().any(|(row, region)| {
				while paths
					.get(path)
					.is_some_and(|&(candidate, ..)| candidate < *row)
				{
					path += 1;
				}
				let Some(&(candidate, end, parent_owned_gap)) = paths.get(path) else {
					return false;
				};
				candidate == *row
					&& (!native || region.certain)
					&& region.column.is_some()
					&& contained(
						*row,
						end,
						parent_owned_gap
							&& region.owned_end_gap
							&& (end == region.end || region.domain && region.envelope == Some(end)),
					)
			});
		}
		if !candidates
			.iter()
			.any(|(_, region)| region.certain || region.domain)
		{
			return candidates.iter().all(|(_, region)| region.column.is_some())
				&& (candidates.iter().any(|(row, region)| {
					region
						.envelope
						.is_some_and(|end| contained(*row, end, false))
				}) || !candidates
					.iter()
					.any(|(row, region)| region.envelope.is_some_and(|end| alternative(*row, end))));
		}
		candidates.iter().any(|(row, region)| {
			let bound = if region.domain {
				region.envelope.unwrap_or(region.end)
			} else {
				region.end
			};
			let end = lookup
				.scope
				.as_ref()
				.map_or(bound, |outer| bound.min(outer.end));
			let owned_end_gap = region.owned_end_gap
				&& bound == end
				&& lookup
					.scope
					.as_ref()
					.is_none_or(|outer| end < outer.end || outer.owned_end_gap);
			(region.certain || !native && region.domain)
				&& region.column.is_some()
				&& contained(*row, end, owned_end_gap)
		})
	}
}

/// The positions in `view`'s old lines that the hunk removes or replaces.
fn changed_offsets(hunk: &DiffHunk, view: &View) -> Vec<usize> {
	if view.old.len() == view.new.len()
		&& view
			.old
			.iter()
			.zip(&view.new)
			.all(|(old, new)| hunk.old_lines[*old] == hunk.new_lines[*new])
	{
		return Vec::new();
	}
	let context = view.context(hunk);
	(0..view.old.len())
		.filter(|offset| !context.iter().any(|(old, _)| old == offset))
		.collect()
}

/// Insertions do not consume their context, but must still retain its best
/// placement evidence across sequential edits.
fn evidence_offsets(hunk: &DiffHunk, view: &View) -> Vec<usize> {
	let changed = changed_offsets(hunk, view);
	if changed.is_empty() && hunk.old_lines != hunk.new_lines {
		(0..view.old.len()).collect()
	} else {
		changed
	}
}

/// Place independently in the anchor or whole file. Consumed exclusions
/// are used only when replaying a suggestion, never as order evidence.
fn place_hunk(
	lines: &[&str],
	hunk: &DiffHunk,
	target: Target<'_>,
	consumed: &[Consumed],
	hints: Hints,
	allow_fuzzy: bool,
) -> PlacedHunk {
	let eof = hunk.is_end_of_file;
	let place = |view: &View| {
		let refs = view.old_refs(hunk);
		let changed = changed_offsets(hunk, view);
		let proof = target
			.proof
			.and_then(|proof| prove_by_anchor_line(lines, &refs, proof, &changed, consumed));
		let (proof, mut consumed_by) = proof.map_or((None, None), |(result, by)| (Some(result), by));
		let placement = proof.unwrap_or_else(|| match target.anchor {
			Some(anchor) => {
				let (result, mut by) = exclude_consumed(
					place_in_anchor(lines, &refs, anchor, eof, allow_fuzzy),
					&changed,
					consumed,
				);
				// The ladder of a certain region stops at the first tier
				// that matches; looser strict-tier copies still exist.
				if let Some(best) = by
					.as_mut()
					.filter(|best| anchor.certain && best.lower.is_empty())
				{
					let union =
						seek_strict_union(lines, &refs, anchor.line + 1, anchor.end, eof, allow_fuzzy);
					let found = union
						.match_indices
						.unwrap_or_else(|| union.index.into_iter().collect());
					let first = changed.first().copied().unwrap_or_default();
					best.lower = found
						.into_iter()
						.filter(|at| consumer(*at, &changed, consumed).is_none())
						.map(|at| at + first)
						.collect();
				}
				consumed_by = by;
				result
			},
			None => seek_sequence(lines, &refs, 0, eof, allow_fuzzy),
		});
		(tie_break(placement, hints), consumed_by)
	};
	let mut view = View::whole(hunk);
	let (mut result, consumed_by) = place(&view);
	let placed_hunk = |result, view, retried| PlacedHunk {
		result,
		view,
		ignored_context: None,
		variant_used: false,
		already_applied: None,
		retried,
		consumed_by: None,
		effect: None,
		lookup: None,
	};
	// Lines an earlier hunk already changes are refused as such, before any
	// repair or resend check claims them.
	if let Some(by) = consumed_by.filter(|_| !is_hit(&result)) {
		let mut placed = placed_hunk(result, view, false);
		placed.consumed_by = Some(by);
		return placed;
	}
	// Drop a trailing blank old line the file may lack; an emptied pattern
	// would place anywhere, so a lone blank line is never dropped.
	let retried = if !is_hit(&result)
		&& view.old.len() > 1
		&& view
			.old
			.last()
			.is_some_and(|index| hunk.old_lines[*index].is_empty())
	{
		view.old.pop();
		if view
			.new
			.last()
			.is_some_and(|index| hunk.new_lines[*index].is_empty())
		{
			view.new.pop();
		}
		let consumed_by;
		(result, consumed_by) = place(&view);
		if let Some(by) = consumed_by.filter(|_| !is_hit(&result)) {
			let mut placed = placed_hunk(result, view, false);
			placed.consumed_by = Some(by);
			return placed;
		}
		is_hit(&result)
	} else {
		false
	};
	let mut placed = placed_hunk(result, view, retried);
	if is_hit(&placed.result) {
		return placed;
	}
	placed.already_applied = already_applied(lines, hunk, target.anchor);
	if placed.already_applied.is_some() {
		return placed;
	}
	// Reshaped variants only repair a hunk whose lines are absent, and only
	// with evidence; when the hunk occurs several times they would guess.
	let aggressive =
		hunk.change_context.is_some() || hunk.old_start_line.is_some() || hunk.is_end_of_file;
	let mut ambiguous_variant = None;
	for variant in fallback_variants(hunk, aggressive)
		.into_iter()
		.filter(|variant| !variant.view.old.is_empty())
	{
		let (candidate, consumed_by) = place(&variant.view);
		if let Some(by) = consumed_by {
			let mut placed = placed_hunk(candidate, variant.view, false);
			placed.consumed_by = Some(by);
			return placed;
		}
		if is_ambiguous(&candidate) {
			ambiguous_variant.get_or_insert((variant.view, candidate));
			continue;
		}
		if let Some(found) = candidate.index
			&& variant_is_evidenced(lines, &variant.view.old_refs(hunk), found, allow_fuzzy)
			&& !dropped_context_elsewhere(lines, hunk, &variant.view, found)
		{
			return PlacedHunk {
				result:          candidate,
				ignored_context: Some(hunk.old_lines.len().saturating_sub(variant.view.old.len())),
				view:            variant.view,
				variant_used:    true,
				already_applied: None,
				retried:         false,
				consumed_by:     None,
				effect:          None,
				lookup:          None,
			};
		}
	}
	// Report the ambiguity the reshaped hunk ran into rather than a missing
	// match.
	if let Some((view, candidate)) = ambiguous_variant {
		placed.view = view;
		placed.result = candidate;
		placed.variant_used = true;
	}
	placed
}
/// Suggestion replays one refusal may spend validating anchors.
const SUGGESTION_REPLAYS: usize = 16;

/// Everything needed to replay one hunk's placement, e.g. to validate a
/// suggested anchor exactly as the model would resend it.
struct HunkQuery<'a> {
	layout:      &'a Layout<'a>,
	hunk:        &'a DiffHunk,
	/// The hunk's `@@` header text when it resolved, so suggestions nest.
	context:     Option<&'a str>,
	/// Lines earlier hunks changed.
	consumed:    &'a [Consumed],
	hints:       Hints,
	allow_fuzzy: bool,
	/// Replays left; each runs the whole ladder, so the total is bounded.
	budget:      Cell<usize>,
}

impl HunkQuery<'_> {
	/// The unique placement the hunk's own lines get when resent with
	/// `@@ context`.
	fn locate(&self, context: &str) -> Option<usize> {
		let left = self.budget.get().checked_sub(1)?;
		self.budget.set(left);
		let lookup = find_hierarchical_context(
			self.layout,
			context,
			self.hints,
			self.allow_fuzzy,
			&self.hunk.old_lines,
			false,
		);
		if !matches!(lookup.outcome, AnchorOutcome::Found)
			|| lookup
				.scope
				.as_ref()
				.is_some_and(|scope| scope.column.is_none())
		{
			return None;
		}
		let target = Target { anchor: lookup.scope.as_ref(), proof: lookup.proof.as_deref() };
		let mut placed = place_hunk(
			self.layout.lines,
			self.hunk,
			target,
			self.consumed,
			self.hints,
			self.allow_fuzzy,
		);
		if !placed.eligible(self.layout, &lookup, self.hunk, self.allow_fuzzy) {
			return None;
		}
		placed
			.result
			.index
			.filter(|_| !is_ambiguous(&placed.result) && !placed.variant_used)
	}
}

/// A line worth anchoring on: not blank and not punctuation only.
fn is_trivial_line(line: &str) -> bool {
	!line.chars().any(char::is_alphanumeric)
}

/// Lines scanned upward from a candidate for a suggested anchor.
const SUGGESTION_SCAN_LINES: usize = 200;

/// The change context the hunk parser reads from the `@@` header lines the
/// model is told to send (`text` as the hunk's header, or nested below
/// `outer`), when they parse as an anchor ending in `text` and not as a line
/// hint or a top-of-file marker.
fn parsed_anchor(outer: Option<&str>, text: &str) -> Option<String> {
	if text.starts_with("@@") {
		return None;
	}
	let mut header = String::new();
	for part in outer.into_iter().flat_map(|outer| outer.split('\n')) {
		let _ = writeln!(header, "@@ {part}");
	}
	let _ = write!(header, "@@ {text}\n+x");
	let hunks = parse_diff_hunks(&header).ok()?;
	let [hunk] = hunks.as_slice() else {
		return None;
	};
	let context = hunk.change_context.clone()?;
	(hunk.old_start_line.is_none() && context.split('\n').next_back().map(js_trim) == Some(text))
		.then_some(context)
}

/// For a refused placement, the nearest line above `candidate` that is
/// unique in the file and, sent as the hunk's `@@` header (nested under the
/// current one, if any), places the hunk exactly at `candidate`, scanning up
/// to the header of the candidate's enclosing block (Heckel, CACM 21(4), §3;
/// histogram diff prefers the rarest line).
fn suggest_anchor<'a>(
	query: &HunkQuery<'a>,
	counts: &HashMap<&'a str, usize>,
	candidate: usize,
	candidates: &[usize],
) -> Option<&'a str> {
	let lines = query.layout.lines;
	let indent = count_leading_whitespace(lines[candidate]);
	let between = |from: usize, to: usize| {
		candidates.partition_point(|index| *index < to)
			- candidates.partition_point(|index| *index <= from)
	};
	for index in (candidate.saturating_sub(SUGGESTION_SCAN_LINES)..candidate).rev() {
		let line = lines[index];
		if is_blank_line(line) {
			continue;
		}
		let text = js_trim(line);
		if !is_trivial_line(text) && counts.get(text) == Some(&1) {
			let region = query.layout.region(index, text);
			if candidate < region.end
				&& between(index, region.end) == 1
				&& let Some(context) = parsed_anchor(query.context, text)
				&& query.locate(&context) == Some(candidate)
			{
				return Some(text);
			}
		}
		if count_leading_whitespace(line) < indent {
			return None;
		}
	}
	None
}

/// Suggested `@@` anchors for the first candidates, each validated by
/// replaying the hunk under it.
fn anchor_suggestions(query: &HunkQuery<'_>, candidates: &[usize]) -> String {
	let previous = query.layout.suggestion_rows.replace(Some(HashSet::new()));
	let mut counts = HashMap::new();
	for line in query.layout.lines {
		*counts.entry(js_trim(line)).or_insert(0usize) += 1;
	}
	let suggestions = candidates
		.iter()
		.take(MAX_RECORDED_MATCHES)
		.filter_map(|candidate| {
			suggest_anchor(query, &counts, *candidate, candidates)
				.map(|anchor| format!("`@@ {anchor}` for line {}", candidate + 1))
		})
		.collect::<Vec<_>>();
	query.layout.suggestion_rows.replace(previous);
	if suggestions.is_empty() {
		return String::new();
	}
	let form = if query.context.is_some() {
		"Add one as a nested @@ line below the current header"
	} else {
		"Send one as the hunk's @@ header"
	};
	format!(" Suggested anchors: {}. {form}.", suggestions.join("; "))
}

/// Candidate lines, previews and suggested `@@` anchors for an ambiguity
/// refusal (SWE-agent, `NeurIPS` 2024, §2; `OpenHands` lists every
/// occurrence's line).
fn ambiguity_details(
	lines: &[&str],
	candidates: &[usize],
	count: usize,
	query: Option<&HunkQuery<'_>>,
) -> String {
	let mut details = sequence_previews(lines, Some(candidates), Some(count))
		.map_or(String::new(), |value| format!("\n\n{value}"));
	let starts = candidates
		.iter()
		.map(|index| *index as u32 + 1)
		.collect::<Vec<_>>();
	if !starts.is_empty() {
		let _ = write!(details, "\n\nCandidates start at lines {}.", line_list(&starts));
	}
	let suggestions = query.map_or_else(String::new, |query| anchor_suggestions(query, candidates));
	if suggestions.is_empty() {
		details.push_str(" Add more context lines to make the target unique.");
	} else {
		details.push_str(&suggestions);
	}
	details
}

/// Context lines keep the file's bytes. Diff context is the text both sides
/// share (Hunt & `McIlroy`, CSTR #41), and an inexact placement only shows the
/// hunk's context resembles the file, so writing the hunk's spelling back
/// would change lines the hunk never meant to touch (GNU diffutils §10.3.3:
/// fuzz ignores context, it never rewrites it). Which lines are context is
/// the hunk's own structure (`context`: old and new positions), never a
/// text comparison; every other line is the re-indented added text.
fn keep_context_bytes(
	actual: &[String],
	mut adjusted: Vec<String>,
	context: &[(usize, usize)],
) -> Vec<String> {
	for &(old, new) in context {
		if let (Some(line), Some(slot)) = (actual.get(old), adjusted.get_mut(new)) {
			slot.clone_from(line);
		}
	}
	adjusted
}

/// Retain byte-identical rows inside each explicit-context-bounded change
/// block. These rows are not new context evidence: they only have no effect.
fn retained_rows(
	actual: &[impl AsRef<str>],
	new_lines: &[impl AsRef<str>],
	context: &[(usize, usize)],
) -> Vec<(usize, usize)> {
	let mut retained = context.to_vec();
	let mut from = (0, 0);
	for &(old_end, new_end) in context
		.iter()
		.chain(std::iter::once(&(actual.len(), new_lines.len())))
	{
		let (mut old, mut new) = from;
		let (mut old_stop, mut new_stop) = (old_end, new_end);
		while old < old_stop && new < new_stop {
			if actual[old].as_ref() != new_lines[new].as_ref() {
				break;
			}
			retained.push((old, new));
			old += 1;
			new += 1;
		}
		while old < old_stop && new < new_stop {
			if actual[old_stop - 1].as_ref() != new_lines[new_stop - 1].as_ref() {
				break;
			}
			old_stop -= 1;
			new_stop -= 1;
			retained.push((old_stop, new_stop));
		}
		if old_stop - old == new_stop - new {
			retained.extend(
				(old..old_stop)
					.zip(new..new_stop)
					.filter(|&(old, new)| actual[old].as_ref() == new_lines[new].as_ref()),
			);
		}
		from = (old_end + 1, new_end + 1);
	}
	retained.sort_unstable();
	retained
}

fn prepare_effect(lines: &[&str], hunk: &DiffHunk, view: &View, at: usize) -> PreparedEffect {
	let pattern = view
		.old
		.iter()
		.map(|&row| hunk.old_lines[row].clone())
		.collect::<Vec<_>>();
	let actual = &lines[at..at + pattern.len()];
	let context = view.context(hunk);
	let actual_owned = actual
		.iter()
		.map(|line| (*line).to_owned())
		.collect::<Vec<_>>();
	let new_lines = keep_context_bytes(
		&actual_owned,
		adjust_lines_indentation(&pattern, &actual_owned, &view.new_lines(hunk)),
		&context,
	);
	let retained = retained_rows(actual, &new_lines, &context);
	let mut unchanged = retained.iter().peekable();
	let changed = (0..actual.len())
		.filter(|row| {
			if unchanged.peek().is_some_and(|pair| pair.0 == *row) {
				unchanged.next();
				false
			} else {
				true
			}
		})
		.collect();
	let origins = row_origins(actual, &new_lines, &retained);
	PreparedEffect { new_lines, retained, changed, origins }
}

fn character_search(
	content: &str,
	old_text: &str,
	threshold: f64,
	allow_fuzzy: bool,
) -> MatchOutcome {
	let mut outcome = find_match(content, old_text, &FindMatchOptions {
		allow_fuzzy,
		threshold: Some(threshold),
		excluded_ranges: &[],
	});
	if outcome.matched.is_none() && allow_fuzzy {
		let relaxed = threshold.min(0.92);
		if relaxed < threshold {
			let next = find_match(content, old_text, &FindMatchOptions {
				allow_fuzzy,
				threshold: Some(relaxed),
				excluded_ranges: &[],
			});
			if next.matched.is_some() {
				outcome = next;
			}
		}
	}
	outcome
}

fn character_match(
	content: &str,
	path: &str,
	hunk: &DiffHunk,
	threshold: f64,
	allow_fuzzy: bool,
	record: Option<&mut Consumption>,
) -> Result<(String, Vec<String>), EditError> {
	let old_text = hunk.old_lines.join("\n");
	let outcome = character_search(content, &old_text, threshold, allow_fuzzy);
	if let Some(record) = record.as_ref() {
		record.check_character(path, &old_text, threshold, allow_fuzzy, &outcome)?;
	}
	let starts = |outcome: &MatchOutcome| {
		outcome
			.occurrence_lines
			.as_deref()
			.unwrap_or_default()
			.iter()
			.map(|line| *line as usize - 1)
			.collect::<Vec<_>>()
	};
	let suggestions = |outcome: &MatchOutcome| {
		let lines = patch_rows(content).collect::<Vec<_>>();
		let layout = Layout::new(&lines, path, content);
		let query = HunkQuery {
			layout: &layout,
			hunk,
			context: None,
			consumed: &[],
			hints: Hints::default(),
			allow_fuzzy,
			budget: Cell::new(SUGGESTION_REPLAYS),
		};
		anchor_suggestions(&query, &starts(outcome))
	};
	if outcome.occurrences.is_some_and(|count| count > 1) {
		return Err(EditError::apply(format!(
			"{}{}",
			format_patch_occurrence_error(path, &outcome),
			suggestions(&outcome)
		)));
	}
	// A fuzzy window standing clearly ahead of the rest is the match, as in
	// `replace` mode; only an undecided set of windows is refused.
	if outcome.matched.is_none() && outcome.fuzzy_matches.is_some_and(|count| count > 1) {
		return Err(EditError::apply(format!(
			"Found {} high-confidence matches in {path}. The text must be unique. Please provide \
			 more context to make it unique.{}{}",
			outcome.fuzzy_matches.unwrap_or(0),
			candidate_details(&outcome, "fuzzy"),
			suggestions(&outcome)
		)));
	}
	let Some(found) = outcome.matched else {
		if let Some(closest) = outcome.closest {
			return Err(EditError::apply(format!(
				"Could not find a close enough match in {path}. Closest match ({:.0}% similar) at \
				 line {}.",
				closest.confidence * 100.0,
				closest.start_line
			)));
		}
		return Err(EditError::apply(format!(
			"Failed to find expected lines in {path}:\n{old_text}"
		)));
	};
	let new_text = hunk.new_lines.join("\n");
	let adjusted = adjust_indentation(&old_text, &found.actual_text, &new_text);
	let first_row = found.start_line as usize - 1;
	let first_column = found.start_index
		- content[..found.start_index]
			.rfind('\n')
			.map_or(0, |at| at + 1);
	let end = found.start_index + found.actual_text.len();
	let row = first_row + found.actual_text.matches('\n').count();
	let row_start = content[..end].rfind('\n').map_or(0, |at| at + 1);
	let row_end = end + content[end..].find('\n').unwrap_or(content.len() - end);
	let suffix_separators = content[end..row_end]
		.char_indices()
		.filter_map(|(at, ch)| matches!(ch, ',' | ';').then_some((row, end - row_start + at)))
		.collect::<Vec<_>>();
	let structural = OnceCell::new();
	let mut match_end = found.start_index + found.actual_text.len();
	if let Some(&(row, column)) = suffix_separators.first() {
		let row_start = content[..match_end].rfind('\n').map_or(0, |at| at + 1);
		let at = row_start + column;
		let separator = content.as_bytes()[at] as char;
		if content[match_end..at].trim().is_empty()
			&& adjusted.trim_end().ends_with(separator)
			&& structural
				.get_or_init(|| {
					(content.len() <= TREE_SOURCE_LIMIT)
						.then(|| BlockIndex::new(content, path).ok().flatten())
						.flatten()
				})
				.as_ref()
				.is_some_and(|index| index.separator_at(row, column))
		{
			// The replacement explicitly supplies this separator. Consume
			// the original token once, then validate those exact bytes.
			match_end = at + 1;
		}
	}
	let deletes_rows = first_column == 0 && match_end == row_end && adjusted.is_empty();
	// Compare complete physical rows, including the portions outside a
	// character match. A copied substring is not proof that its row survived.
	let row_effect = OnceCell::new();
	let rows = || {
		row_effect.get_or_init(|| {
			let begin = found.start_index - first_column;
			let end = match_end
				+ content[match_end..]
					.find('\n')
					.unwrap_or(content.len() - match_end);
			let mut replacement =
				String::with_capacity(first_column + adjusted.len() + end - match_end);
			replacement.push_str(&content[begin..found.start_index]);
			replacement.push_str(&adjusted);
			replacement.push_str(&content[match_end..end]);
			if end == content.len() {
				preserve_final_newline(&mut replacement, content.ends_with('\n'));
			}
			let actual = if begin == content.len() && content.ends_with('\n') {
				Vec::new()
			} else if end < content.len() {
				content[begin..end].split('\n').collect::<Vec<_>>()
			} else {
				patch_rows(&content[begin..end]).collect::<Vec<_>>()
			};
			let output = if deletes_rows {
				Vec::new()
			} else if end < content.len() {
				replacement.split('\n').collect::<Vec<_>>()
			} else {
				patch_rows(&replacement).collect::<Vec<_>>()
			};
			(actual.len(), output.len(), retained_rows(&actual, &output, &[]))
		})
	};
	let result = OnceCell::new();
	let build_result = || {
		let mut result = String::with_capacity(content.len() + adjusted.len());
		result.push_str(&content[..found.start_index]);
		result.push_str(&adjusted);
		result.push_str(&content[match_end..]);
		result
	};
	let syntax = Syntax::for_path(path);
	let parsed = OnceCell::new();
	let get_parsed = || {
		parsed
			.get_or_init(|| {
				structural
					.get_or_init(|| {
						(content.len() <= TREE_SOURCE_LIMIT)
							.then(|| BlockIndex::new(content, path).ok().flatten())
							.flatten()
					})
					.as_ref()
					.and_then(|index| {
						index
							.parse_change(found.start_index..match_end, &adjusted)
							.ok()
					})
			})
			.as_ref()
	};
	let separator_proof = OnceCell::new();
	let validate = |separators: &[(usize, usize)]| {
		*separator_proof.get_or_init(|| {
			get_parsed()
				.map(|parsed| {
					let mut all = separators
						.iter()
						.map(|&(row, column)| {
							(row, column + if row == first_row { first_column } else { 0 })
						})
						.collect::<Vec<_>>();
					all.extend(suffix_separators.iter().copied());
					all.sort_unstable();
					all.dedup();
					let unchanged = rows()
						.2
						.iter()
						.map(|&(old, new)| (first_row + old, new))
						.collect::<Vec<_>>();
					let original = content[found.start_index..match_end]
						.split('\n')
						.collect::<Vec<_>>();
					let output = adjusted.split('\n').map(str::to_owned).collect::<Vec<_>>();
					let rewritten = counterparts(&original, &output, &[], false, |_| true)
						.into_iter()
						.enumerate()
						.filter_map(|(old, new)| new.map(|new| (first_row + old, new)))
						.collect::<Vec<_>>();
					parsed.preserves_separators(&all, &unchanged, &rewritten)
				})
				.or_else(|| {
					syntax.language.is_none().then(|| {
						let has_separators = !separators.is_empty() || !suffix_separators.is_empty();
						if (has_separators && adjusted.contains('\n'))
							|| !retains_lexical_roles(
								content,
								result.get_or_init(build_result),
								found.start_index..match_end,
								adjusted.len(),
								syntax,
							) {
							SeparatorProof::Rejected
						} else if has_separators {
							SeparatorProof::TrivialOnly
						} else {
							SeparatorProof::Preserved
						}
					})
				})
		})
	};
	if content[found.start_index..match_end] != old_text {
		let matched = content[found.start_index..match_end]
			.split('\n')
			.collect::<Vec<_>>();
		let pattern = hunk
			.old_lines
			.iter()
			.map(String::as_str)
			.collect::<Vec<_>>();
		guard_partial_lines(
			(path, get_parsed),
			&pattern,
			&matched,
			&[],
			&adjusted.split('\n').map(str::to_owned).collect::<Vec<_>>(),
			found.start_line as usize - 1,
			validate,
		)?;
	}
	// Physical prefix/suffix text must keep its lexical role independently
	// of row count, match tier or whether it contains punctuation.
	if (first_column > 0 || match_end < row_end)
		&& !matches!(validate(&[]), Some(SeparatorProof::Preserved))
		&& !(syntax.language.is_none() && matches!(validate(&[]), Some(SeparatorProof::TrivialOnly)))
	{
		return Err(EditError::apply(format!(
			"Refusing partial-line match in {path} at line {}: the replacement changes the file \
			 separator's structural role. Provide the complete line in the hunk.",
			first_row + 1,
		)));
	}
	let mut warnings = Vec::new();
	if outcome.dominant_fuzzy == Some(true) {
		warnings.push(format!(
			"Dominant fuzzy match selected in {path} near line {} ({:.0}% similar).",
			found.start_line,
			found.confidence * 100.0
		));
	}
	let mut result = parsed
		.into_inner()
		.flatten()
		.map(ParsedChange::into_source)
		.or_else(|| result.into_inner())
		.unwrap_or_else(build_result);
	if deletes_rows && result.as_bytes().get(found.start_index) == Some(&b'\n') {
		result.remove(found.start_index);
	}
	preserve_final_newline(&mut result, content.ends_with('\n'));
	let &(old_stop, new_stop, ref retained) = rows();
	let original = patch_rows(content)
		.skip(first_row)
		.take(old_stop)
		.collect::<Vec<_>>();
	let output = patch_rows(&result)
		.skip(first_row)
		.take(new_stop)
		.map(str::to_owned)
		.collect::<Vec<_>>();
	let origins = row_origins(&original, &output, retained)
		.into_iter()
		.map(|origin| match origin {
			RowOrigin::Retained(row) => RowOrigin::Retained(first_row + row),
			RowOrigin::Moved(row) => RowOrigin::Moved(first_row + row),
			RowOrigin::Rewritten(row) => RowOrigin::Rewritten(first_row + row),
			RowOrigin::Inserted => RowOrigin::Inserted,
		})
		.collect::<Vec<_>>();
	let gaps =
		semantic_insertion_gaps(&origins, None, hunk.context_lines.iter().map(|&(_, row)| row).max())
			.into_iter()
			.map(|(gap, rows)| (gap, first_row + rows.start..first_row + rows.end))
			.collect::<Vec<_>>();
	let logical = has_continuation_candidate(content) || has_continuation_candidate(&result);
	if !gaps.is_empty() || logical {
		let lines = patch_rows(content).collect::<Vec<_>>();
		let layout = Layout::new(&lines, path, content);
		let mut correspondence = (0..lines.len())
			.map(|old| {
				if old < first_row {
					Some(old)
				} else if old >= first_row + old_stop {
					Some(old - old_stop + new_stop)
				} else {
					None
				}
			})
			.collect::<Vec<_>>();
		let mut retained_rows = if logical {
			correspondence.clone()
		} else {
			Vec::new()
		};
		for (new, origin) in origins.iter().enumerate() {
			if let RowOrigin::Retained(old) | RowOrigin::Moved(old) | RowOrigin::Rewritten(old) =
				*origin
			{
				correspondence[old] = Some(first_row + new);
				if logical && matches!(origin, RowOrigin::Retained(_) | RowOrigin::Moved(_)) {
					retained_rows[old] = Some(first_row + new);
				}
			}
		}
		validate_composed_insertions(
			&layout,
			&result,
			&correspondence,
			&gaps,
			&inserted_runs(&origins, first_row),
			&retained_rows,
		)?;
	}
	if result != content
		&& let Some(record) = record
	{
		record.remember(content);
		let snapshot = record.origin_snapshot(origins.iter().copied());
		record.splice(first_row, old_stop, &origins, 1, &snapshot);
	}
	Ok((result, warnings))
}

/// A line's tokens: identifier and number runs, and each other
/// non-whitespace character, with their byte spans.
fn tokens(line: &str) -> Vec<(usize, usize)> {
	let mut spans = Vec::new();
	let mut word: Option<usize> = None;
	for (at, ch) in line.char_indices() {
		let wordy = ch.is_alphanumeric() || ch == '_';
		if let Some(start) = word.filter(|_| !wordy) {
			spans.push((start, at));
			word = None;
		}
		if wordy {
			word.get_or_insert(at);
		} else if !ch.is_whitespace() {
			spans.push((at, at + ch.len_utf8()));
		}
	}
	if let Some(start) = word {
		spans.push((start, line.len()));
	}
	spans
}

/// Token alignments past this many table cells are refused, not guessed.
const MAX_ALIGNMENT_CELLS: usize = 1 << 20;

/// A minimal-edit alignment of token sequences `a` and `b`: for each token
/// of `a`, the token of `b` it matches or is substituted by, if any. `None`
/// when the table would exceed [`MAX_ALIGNMENT_CELLS`].
fn align_tokens(
	a: &[String],
	b: &[String],
	same_kind: impl Fn(usize, usize) -> bool,
) -> Option<Vec<Option<usize>>> {
	let width = b.len() + 1;
	if (a.len() + 1).saturating_mul(width) > MAX_ALIGNMENT_CELLS {
		return None;
	}
	// Lexicographic cost: edit count first, token similarity second. Never
	// substitute punctuation for an identifier or number.
	let word = |s: &str| {
		s.chars()
			.next()
			.is_some_and(|ch| ch.is_alphanumeric() || ch == '_')
	};
	let mut work = MAX_ALIGNMENT_CELLS;
	let mut step = |left: &str, right: &str| {
		if left == right {
			return (0u32, 0u64);
		}
		if word(left) != word(right) {
			return (u32::MAX / 2, 0);
		}
		let cells = left.len().saturating_mul(right.len());
		let score = if cells <= work {
			work -= cells;
			similarity(left, right)
		} else {
			// Bounded similarity for long tokens: common prefix and suffix
			// samples. Exact equality above remains authoritative.
			let prefix = left
				.chars()
				.zip(right.chars())
				.take(64)
				.take_while(|(a, b)| a == b)
				.count();
			let suffix = left
				.chars()
				.rev()
				.zip(right.chars().rev())
				.take(64)
				.take_while(|(a, b)| a == b)
				.count();
			(prefix + suffix) as f64 / left.len().max(right.len()).max(128) as f64
		};
		(1, ((1.0 - score) * 1000.0).round() as u64)
	};
	let plus = |a: (u32, u64), b: (u32, u64)| (a.0 + b.0, a.1 + b.1);
	let mut cost = vec![(0u32, 0u64); (a.len() + 1) * width];
	let mut direction = vec![0u8; cost.len()];
	for (j, cell) in cost.iter_mut().take(width).enumerate() {
		*cell = (j as u32, 0);
	}
	for i in 1..=a.len() {
		cost[i * width] = (i as u32, 0);
		for j in 1..=b.len() {
			let substitution = if same_kind(i - 1, j - 1) {
				step(&a[i - 1], &b[j - 1])
			} else {
				(u32::MAX / 2, 0)
			};
			let diagonal = plus(cost[(i - 1) * width + j - 1], substitution);
			let up = plus(cost[(i - 1) * width + j], (1, 0));
			let left = plus(cost[i * width + j - 1], (1, 0));
			cost[i * width + j] = diagonal.min(up).min(left);
			direction[i * width + j] = if cost[i * width + j] == diagonal {
				0
			} else if cost[i * width + j] == up {
				1
			} else {
				2
			};
		}
	}
	let mut paired = vec![None; a.len()];
	let (mut i, mut j) = (a.len(), b.len());
	while i > 0 && j > 0 {
		if direction[i * width + j] == 0 {
			paired[i - 1] = Some(j - 1);
			i -= 1;
			j -= 1;
		} else if direction[i * width + j] == 1 {
			i -= 1;
		} else {
			j -= 1;
		}
	}
	Some(paired)
}

/// Products of a change block's sizes (characters plus lines) past which its
/// lines are paired by shared tokens instead of by similarity.
const MAX_PAIRING_CELLS: usize = 1 << 24;

/// A line's token keys: its tokens with Unicode punctuation folded.
fn token_keys(line: &str) -> Vec<String> {
	tokens(line)
		.into_iter()
		.map(|(from, to)| normalize_unicode(&line[from..to]))
		.collect()
}

/// For each removed line of a hunk view that `needed` asks about, the added
/// line that replaces it, within its change block (the removed and added
/// lines between two context lines): a one-to-one pairing taking the most
/// similar pairs first, nearer positions breaking ties, so a reordered block
/// pairs each line with its own rewrite. A block too large to compare line by
/// line pairs each line asked about with the added line sharing the most
/// tokens. A removed line without a counterpart is a pure deletion.
fn counterparts(
	old: &[&str],
	new: &[String],
	context: &[(usize, usize)],
	code_only: bool,
	needed: impl Fn(usize) -> bool,
) -> Vec<Option<usize>> {
	let mut paired = vec![None; old.len()];
	let mut edges = context.to_vec();
	edges.sort_unstable();
	let mut from = (0, 0);
	for (end_old, end_new) in edges.into_iter().chain([(old.len(), new.len())]) {
		let removed = from.0..end_old.max(from.0);
		let added = from.1..end_new.max(from.1);
		from = (end_old + 1, end_new + 1);
		if added.is_empty() || !removed.clone().any(&needed) {
			continue;
		}
		if removed.len().saturating_mul(added.len()) > MAX_EDGE_PAIRS {
			// Unknown pairing, independently of the character budget.
			continue;
		}
		let chars =
			|lines: &mut dyn Iterator<Item = &str>| lines.map(|line| line.len() + 1).sum::<usize>();
		let cells = chars(&mut old[removed.clone()].iter().copied())
			.saturating_mul(chars(&mut new[added.clone()].iter().map(String::as_str)));
		// Distance from the position the line holds in its block.
		let distance = |r: usize, a: usize| (r - removed.start).abs_diff(a - added.start);
		let mut pairs = Vec::with_capacity(removed.len() * added.len());
		if cells > MAX_PAIRING_CELLS {
			let keys = |line: &str| token_keys(line).into_iter().collect::<HashSet<_>>();
			let added_keys = new[added.clone()]
				.iter()
				.map(|line| keys(line))
				.collect::<Vec<_>>();
			for r in removed.clone() {
				let wanted = keys(old[r]);
				for (offset, line) in added_keys.iter().enumerate() {
					let shared = wanted.intersection(line).count();
					if shared > 0 {
						pairs.push((shared as f64, r, added.start + offset));
					}
				}
			}
		} else {
			let normalized = new[added.clone()]
				.iter()
				.map(|line| normalize_for_fuzzy(line))
				.collect::<Vec<_>>();
			for r in removed.clone() {
				if code_only && old[r].trim().is_empty() {
					continue;
				}
				let wanted = normalize_for_fuzzy(old[r]);
				for a in added.clone() {
					if !old[r].trim().is_empty() && new[a].trim().is_empty() {
						continue;
					}
					pairs.push((similarity(&wanted, &normalized[a - added.start]), r, a));
				}
			}
		}
		pairs.sort_by(|left, right| {
			right
				.0
				.total_cmp(&left.0)
				.then_with(|| distance(left.1, left.2).cmp(&distance(right.1, right.2)))
				.then_with(|| (left.1, left.2).cmp(&(right.1, right.2)))
		});
		let mut taken = HashSet::new();
		for (_, r, a) in pairs {
			if paired[r].is_none() && taken.insert(a) {
				paired[r] = Some(a);
			}
		}
	}
	paired
}

/// Language-resolved lexical rules, with dialect refinements in one place.
#[derive(Clone, Copy)]
struct Syntax {
	language:       Option<SupportLang>,
	markers:        &'static [&'static str],
	css:            bool,
	block_comments: bool,
	quoting:        QuotePolicy,
}

impl Syntax {
	fn for_path(path: &str) -> Self {
		let path = Path::new(path);
		let language = SupportLang::from_path(path);
		let markers = SupportLang::line_comments_for_path(path);
		let css = language == Some(SupportLang::Css)
			|| path
				.extension()
				.is_some_and(|ext| ext.eq_ignore_ascii_case("less"));
		let block_comments = markers.contains(&"//") || css;
		Self {
			language,
			markers,
			css,
			block_comments,
			quoting: SupportLang::quote_policy_for_path(path),
		}
	}

	fn apostrophe(self, tail: &str) -> bool {
		if !matches!(
			self.language,
			Some(SupportLang::Rust | SupportLang::Haskell | SupportLang::Ocaml)
		) {
			return true;
		}
		let mut chars = tail.chars();
		match chars.next() {
			Some('\\') => {
				chars.next();
				chars.next() == Some('\'')
			},
			Some(ch) if ch != '\'' => chars.next() == Some('\''),
			_ => false,
		}
	}
}
/// Literal/comment extents and cumulative code delimiter depths. Only
/// trivial code-edge proofs use these; grammar validation owns complex values.
struct Shape<'a> {
	comment:  usize,
	brackets: Vec<(usize, i32)>,
	non_code: Vec<(Range<usize>, u8)>,
	native:   Option<NativeShape<'a>>,
}

struct NativeShape<'a> {
	view:   LexicalView<'a>,
	origin: usize,
	indent: Option<(usize, usize)>,
}

impl NativeShape<'_> {
	fn byte(&self, at: usize) -> usize {
		self.origin
			+ self.indent.map_or(at, |(authored, physical)| {
				if at < authored {
					at.min(physical)
				} else {
					physical + at - authored
				}
			})
	}
}

/// Lexical state belongs to a change block, not to an individual row.
#[derive(Default)]
struct Lexical {
	quote:         Option<(u8, bool)>,
	escaped:       bool,
	block_comment: usize,
	url:           bool,
	field_start:   Option<bool>,
}

impl<'a> Shape<'a> {
	fn mark(&mut self, from: usize, to: usize, kind: u8) {
		if let Some((range, previous)) = self.non_code.last_mut()
			&& *previous == kind
			&& range.end == from
		{
			range.end = to;
		} else {
			self.non_code.push((from..to, kind));
		}
	}

	fn scan(line: &str, syntax: Syntax, state: &mut Lexical) -> Self {
		let mut shape =
			Self { comment: line.len(), brackets: Vec::new(), non_code: Vec::new(), native: None };
		let mut at = 0;
		let mut numeric = None;
		if matches!(syntax.quoting, QuotePolicy::Delimited(_)) {
			state.field_start.get_or_insert(true);
		}
		while at < line.len() {
			let tail = &line[at..];
			let ch = tail.chars().next().unwrap();
			let width = ch.len_utf8();
			if state.block_comment > 0 {
				let opens = matches!(
					syntax.language,
					Some(
						SupportLang::Rust | SupportLang::Swift | SupportLang::Kotlin | SupportLang::Scala
					)
				) && tail.starts_with("/*");
				let closes = tail.starts_with("*/");
				let end = at + if opens || closes { 2 } else { width };
				shape.mark(at, end, 2);
				if opens {
					state.block_comment += 1;
				}
				if closes {
					state.block_comment -= 1;
				}
				at = end;
				continue;
			}
			if state.url {
				shape.mark(at, at + width, 1);
				state.url = ch != ')';
				at += width;
				continue;
			}
			if let Some((quote, triple)) = state.quote {
				if matches!(syntax.quoting, QuotePolicy::DoubledQuote | QuotePolicy::Delimited(_))
					&& tail.starts_with("\"\"")
				{
					shape.mark(at, at + 2, 1);
					at += 2;
					continue;
				}
				let closes = !state.escaped
					&& if triple {
						tail
							.as_bytes()
							.get(..3)
							.is_some_and(|bytes| bytes.iter().all(|b| *b == quote))
					} else {
						ch as u32 == u32::from(quote)
					};
				let end = at + if closes && triple { 3 } else { width };
				shape.mark(
					at,
					end,
					if syntax.quoting == QuotePolicy::Unknown {
						3
					} else {
						1
					},
				);
				if closes {
					if let QuotePolicy::Delimited(delimiter) = syntax.quoting
						&& line
							.as_bytes()
							.get(end)
							.is_some_and(|byte| !matches!(*byte, b'\r' | b'\n') && *byte != delimiter)
					{
						shape.mark(end, line.len(), 3);
						break;
					}
					state.quote = None;
				}
				if state.escaped {
					state.escaped = false;
				} else if ch == '\\'
					&& matches!(syntax.quoting, QuotePolicy::Backslash | QuotePolicy::Unknown)
				{
					state.escaped = true;
				}
				at = end;
				continue;
			}
			if syntax
				.markers
				.iter()
				.any(|marker| SupportLang::line_comment_marker_at(syntax.language, marker, line, at))
			{
				shape.comment = at;
				shape.mark(at, line.len(), 2);
				break;
			}
			if syntax.block_comments && tail.starts_with("/*") {
				state.block_comment = 1;
				shape.mark(at, at + 2, 2);
				at += 2;
				continue;
			}
			if syntax.css
				&& tail
					.get(..4)
					.is_some_and(|prefix| prefix.eq_ignore_ascii_case("url("))
			{
				state.url = true;
				shape.mark(at, at + 4, 1);
				at += 4;
				continue;
			}
			if ch.is_ascii_digit() && numeric.is_none() {
				numeric = Some(tail.starts_with("0x") || tail.starts_with("0X"));
			} else if !ch.is_ascii_alphanumeric() && !matches!(ch, '_' | '.' | '\'') {
				numeric = None;
			}
			let numeric_separator = ch == '\''
				&& numeric.is_some_and(|hex| {
					let bytes = line.as_bytes();
					at.checked_sub(1)
						.and_then(|before| bytes.get(before).zip(bytes.get(at + 1)))
						.is_some_and(|(before, after)| {
							if hex && matches!(syntax.language, Some(SupportLang::C | SupportLang::Cpp)) {
								before.is_ascii_hexdigit() && after.is_ascii_hexdigit()
							} else {
								before.is_ascii_digit() && after.is_ascii_digit()
							}
						})
				});
			let quote = match syntax.quoting {
				QuotePolicy::PlainText => false,
				QuotePolicy::DoubledQuote | QuotePolicy::Delimited(_) => ch == '"',
				QuotePolicy::Backslash | QuotePolicy::Unknown => {
					matches!(ch, '"' | '`')
						|| (ch == '\'' && !numeric_separator && syntax.apostrophe(&line[at + 1..]))
				},
			};
			if quote {
				if state.field_start == Some(false)
					&& matches!(syntax.quoting, QuotePolicy::Delimited(_))
				{
					shape.mark(at, line.len(), 3);
					break;
				}
				if state.field_start.is_some() {
					state.field_start = Some(false);
				}
				let quote = ch as u8;
				let triple = syntax.language == Some(SupportLang::Python)
					&& tail
						.as_bytes()
						.get(..3)
						.is_some_and(|bytes| bytes.iter().all(|b| *b == quote));
				let end = at + if triple { 3 } else { 1 };
				state.quote = Some((quote, triple));
				shape.mark(
					at,
					end,
					if syntax.quoting == QuotePolicy::Unknown {
						3
					} else {
						1
					},
				);
				at = end;
				continue;
			}
			let change = match ch {
				'(' | '[' | '{' => 1,
				')' | ']' | '}' => -1,
				_ => 0,
			};
			if change != 0 {
				let depth = shape.brackets.last().map_or(0, |(_, depth)| *depth) + change;
				shape.brackets.push((at, depth));
			}
			if let QuotePolicy::Delimited(delimiter) = syntax.quoting {
				state.field_start =
					Some(ch as u32 == u32::from(delimiter) || matches!(ch, '\r' | '\n'));
			}
			at += width;
		}
		state.escaped = false;
		shape
	}

	fn parsed(
		line: &str,
		view: LexicalView<'a>,
		origin: usize,
		indent: Option<(usize, usize)>,
	) -> Self {
		let native = NativeShape { view, origin, indent };
		let roles = view.spans();
		let mut span = roles.partition_point(|(range, _)| range.end <= native.byte(0));
		let mut shape = Self {
			comment:  line.len(),
			brackets: Vec::new(),
			non_code: Vec::new(),
			native:   Some(native),
		};
		for (at, ch) in line.char_indices() {
			let position = shape.native.as_ref().expect("native shape").byte(at);
			while span < roles.len() && roles[span].0.end <= position {
				span += 1;
			}
			let role = roles
				.get(span)
				.filter(|(range, _)| range.contains(&position))
				.map_or(LexicalRole::Code, |(_, role)| *role);
			if role == LexicalRole::Code {
				let change = match ch {
					'(' | '[' | '{' => 1,
					')' | ']' | '}' => -1,
					_ => 0,
				};
				if change != 0 {
					let depth = shape.brackets.last().map_or(0, |(_, depth)| *depth) + change;
					shape.brackets.push((at, depth));
				}
			} else {
				// Categories only select code-depth/comment handling. All
				// correspondence below resolves the native descriptor view.
				shape.mark(at, at + ch.len_utf8(), if role == LexicalRole::Comment { 2 } else { 1 });
				if role == LexicalRole::Comment {
					shape.comment = shape.comment.min(at);
				}
			}
		}
		shape
	}

	fn kind_at(&self, at: usize) -> u8 {
		let next = self.non_code.partition_point(|(range, _)| range.end <= at);
		self
			.non_code
			.get(next)
			.filter(|(range, _)| range.contains(&at))
			.map_or(0, |(_, kind)| *kind)
	}

	/// The net bracket depth before byte `at`.
	fn depth_before(&self, at: usize) -> i32 {
		let end = self.brackets.partition_point(|(byte, _)| *byte < at);
		end.checked_sub(1).map_or(0, |index| self.brackets[index].1)
	}
}

/// Preserve non-whitespace lexical roles without inventing a grammar for text.
fn retains_lexical_roles(
	source: &str,
	result: &str,
	change: Range<usize>,
	replacement_len: usize,
	syntax: Syntax,
) -> bool {
	let roles = |text: &str| {
		let mut state = Lexical::default();
		let mut spans = Vec::new();
		let mut start = 0;
		let mut record_start = 0;
		for line in text.split_inclusive('\n') {
			for (range, role) in Shape::scan(line, syntax, &mut state).non_code {
				spans.push((start + range.start..start + range.end, role));
			}
			start += line.len();
			if state.quote.is_none() {
				record_start = start;
			}
		}
		if state.quote.is_some() && matches!(syntax.quoting, QuotePolicy::Delimited(_)) {
			for (range, role) in &mut spans {
				if range.end > record_start {
					*role = 3;
				}
			}
		}
		spans
	};
	fn kind(spans: &[(Range<usize>, u8)], cursor: &mut usize, at: usize) -> u8 {
		while spans.get(*cursor).is_some_and(|(range, _)| range.end <= at) {
			*cursor += 1;
		}
		spans
			.get(*cursor)
			.filter(|(range, _)| range.contains(&at))
			.map_or(0, |(_, role)| *role)
	}
	let before = roles(source);
	let after = roles(result);
	let (mut old, mut new) = (0, 0);
	for (range, mapped) in
		[(0..change.start, 0), (change.end..source.len(), change.start + replacement_len)]
	{
		for (offset, ch) in source[range.clone()].char_indices() {
			let before = kind(&before, &mut old, range.start + offset);
			let after = kind(&after, &mut new, mapped + offset);
			if before == 3
				|| after == 3
				|| before != after && (!ch.is_whitespace() || before == 1 || after == 1)
			{
				return false;
			}
		}
	}
	true
}

/// A line split into tokens, with their keys, its shape, and how many of its
/// tokens precede its line comment.
struct Tokenized<'a> {
	line:  &'a str,
	spans: Vec<(usize, usize)>,
	keys:  Vec<String>,
	shape: Shape<'a>,
	code:  usize,
}

impl<'a> Tokenized<'a> {
	fn new(line: &'a str, syntax: Syntax) -> Self {
		Self::scan(line, syntax, &mut Lexical::default())
	}

	fn scan(line: &'a str, syntax: Syntax, state: &mut Lexical) -> Self {
		Self::with_shape(line, Shape::scan(line, syntax, state))
	}

	fn with_shape(line: &'a str, shape: Shape<'a>) -> Self {
		let spans = tokens(line);
		let keys = spans
			.iter()
			.map(|(from, to)| normalize_unicode(&line[*from..*to]))
			.collect();
		let code = spans
			.iter()
			.take_while(|(from, _)| *from < shape.comment)
			.count();
		Self { line, spans, keys, shape, code }
	}

	const fn in_comment(&self, token: usize) -> bool {
		token >= self.code
	}

	fn kind(&self, token: usize) -> u8 {
		self
			.spans
			.get(token)
			.map_or(0, |(at, _)| self.shape.kind_at(*at))
	}

	fn same_kind(&self, token: usize, other: &Self, next: usize) -> bool {
		match (&self.shape.native, &other.shape.native) {
			(Some(left), Some(right)) => {
				let (from, end) = self.spans[token];
				let (to, stop) = other.spans[next];
				self.line[from..end].char_indices().all(|(at, _)| {
					left
						.view
						.same_provenance(left.byte(from + at), right.view, right.byte(to))
				}) && other.line[to..stop].char_indices().all(|(at, _)| {
					right
						.view
						.same_provenance(right.byte(to + at), left.view, left.byte(from))
				})
			},
			(None, None) => self.kind(token) == other.kind(next),
			_ => false,
		}
	}

	fn same_spelling_role(&self, token: usize, other: &Self, next: usize) -> bool {
		match (&self.shape.native, &other.shape.native) {
			(Some(left), Some(right)) => {
				let (from, end) = self.spans[token];
				let (to, stop) = other.spans[next];
				self.line[from..end].char_indices().all(|(at, _)| {
					left
						.view
						.same_spelling_role(left.byte(from + at), right.view, right.byte(to))
				}) && other.line[to..stop].char_indices().all(|(at, _)| {
					right
						.view
						.same_spelling_role(right.byte(to + at), left.view, left.byte(from))
				})
			},
			(None, None) => self.kind(token) == other.kind(next),
			_ => false,
		}
	}

	fn preserves_run(&self, from: usize, len: usize, other: &Self, to: usize) -> bool {
		match (&self.shape.native, &other.shape.native) {
			(Some(left), Some(right)) => left.view.preserves_run(
				left.byte(self.spans[from].0)..left.byte(self.spans[from + len - 1].1),
				right.view,
				right.byte(other.spans[to].0)..right.byte(other.spans[to + len - 1].1),
			),
			(None, None) => true,
			_ => false,
		}
	}

	fn depth_before(&self, token: usize) -> i32 {
		let at = self
			.spans
			.get(token)
			.map_or(self.line.len(), |(from, _)| *from);
		self.shape.depth_before(at)
	}
}

/// What a line assigns, binds or calls: its tokens before the first `=`,
/// `:` or `(`, or else its first token.
fn line_head(keys: &[String]) -> &[String] {
	match keys
		.iter()
		.position(|key| matches!(key.as_str(), "=" | ":" | "("))
	{
		Some(end) if end > 0 => &keys[..end],
		_ => &keys[..keys.len().min(1)],
	}
}

/// Why a counterpart loses part of its file line.
enum Loss {
	TooLong,
	/// The file line starts or ends (`edge`) with `quote`, which the
	/// counterpart carries elsewhere (`kept_at_edge`: at that same edge of
	/// its own, yet not as the file line's).
	Edge {
		first:        usize,
		last:         usize,
		edge:         &'static str,
		kept_at_edge: bool,
	},
	Dropped {
		first: usize,
		last:  usize,
	},
}

/// Every inexact strategy matches a removed line against a whole file line,
/// but the removed line may hold only part of it, or a different token. Each
/// removed line is aligned token by token with its file line, and with each
/// added line that replaces it (its counterparts in the change block): the
/// most similar one, and, when that one assigns, binds or calls something
/// else, every one with the removed line's head (see [`line_head`]). A file
/// token the removed line lacks must reappear in every counterpart where it
/// stood: lost leading tokens at the start of the counterpart, lost trailing
/// ones at its end (or right before its line comment), at the file line's
/// bracket depth and inside a comment only where the file has it there;
/// inner ones between their aligned neighbours. Only tokens the removed line
/// and its counterpart share pin these positions. A file token the removed
/// line spells differently is kept only when the counterpart neither keeps
/// that spelling where it stood nor carries it as often elsewhere. Otherwise
/// the replacement would silently drop file text, so the hunk is refused.
/// Context lines keep the file's bytes and lose nothing, nor do they
/// reproduce anything.
fn guard_partial_lines<'a>(
	file: (&str, impl Fn() -> Option<&'a ParsedChange<'a>>),
	pattern: &[&str],
	matched: &[&str],
	context: &[(usize, usize)],
	new_lines: &[String],
	start: usize,
	structural: impl Fn(&[(usize, usize)]) -> Option<SeparatorProof>,
) -> Result<(), EditError> {
	let (path, parsed_change) = file;
	// Lines whose token keys equal the file line's lose nothing; folding
	// quotes as fuzzy matching does would hide a respelled backtick.
	let needed = |offset: usize| {
		!context.iter().any(|(old, _)| *old == offset)
			&& token_keys(matched[offset]) != token_keys(pattern[offset])
	};
	let syntax = Syntax::for_path(path);
	if !(0..pattern.len()).any(needed) {
		return Ok(());
	}
	let role_failure = || {
		EditError::apply(format!(
			"Refusing partial-line match in {path} at line {}: cannot prove the file text's lexical \
			 roles. Provide the complete line in the hunk.",
			start + 1
		))
	};
	let prepared = if syntax.language.is_some() {
		Some(parsed_change().ok_or_else(role_failure)?)
	} else {
		None
	};
	let removed = if let Some(parsed) = prepared {
		parsed.original_roles().ok_or_else(role_failure)?;
		parsed.roles().ok_or_else(role_failure)?;
		let mut text = String::with_capacity(parsed.original_fragment().len());
		let mut kept = context.iter().peekable();
		for (row, line) in pattern.iter().enumerate() {
			if row > 0 {
				text.push('\n');
			}
			if kept.peek().is_some_and(|(old, _)| *old == row) {
				kept.next();
				text.push_str(matched[row]);
			} else {
				let prefix = matched[row].len() - matched[row].trim_start().len();
				text.push_str(&matched[row][..prefix]);
				text.push_str(line.trim_start());
			}
		}
		if parsed.original_fragment().ends_with('\n') && !text.ends_with('\n') {
			text.push('\n');
		}
		let removed = parsed.with_replacement(&text).map_err(|_| role_failure())?;
		removed.roles().ok_or_else(role_failure)?;
		Some(removed)
	} else {
		None
	};
	let separator_proof = OnceCell::new();
	// Pair against code, never a comment-only line quoting old code.
	let mut old_state = Lexical::default();
	let mut file_state = Lexical::default();
	let mut new_state = Lexical::default();
	let mut removed_at = prepared.map_or(0, ParsedChange::start_byte);
	let mut kept = context.iter().peekable();
	let old_tokens = pattern
		.iter()
		.enumerate()
		.map(|(row, line)| {
			let line = if kept.peek().is_some_and(|(old, _)| *old == row) {
				kept.next();
				matched[row]
			} else {
				*line
			};
			if let Some(parsed) = removed.as_ref() {
				let origin = removed_at;
				let physical_prefix = matched[row].len() - matched[row].trim_start().len();
				let prefix = line.len() - line.trim_start().len();
				removed_at += physical_prefix + line.trim_start().len() + 1;
				Tokenized::with_shape(
					line,
					Shape::parsed(
						line,
						parsed.roles().expect("checked roles"),
						origin,
						Some((prefix, physical_prefix)),
					),
				)
			} else {
				Tokenized::scan(line, syntax, &mut old_state)
			}
		})
		.collect::<Vec<_>>();
	let file_tokens = matched
		.iter()
		.enumerate()
		.map(|(row, line)| {
			if let Some(parsed) = prepared {
				let origin = if row == 0 {
					parsed.start_byte()
				} else {
					parsed
						.original()
						.row_start(start + row)
						.expect("matched row")
				};
				Tokenized::with_shape(
					line,
					Shape::parsed(line, parsed.original_roles().expect("checked roles"), origin, None),
				)
			} else {
				Tokenized::scan(line, syntax, &mut file_state)
			}
		})
		.collect::<Vec<_>>();
	let mut added_at = prepared.map_or(0, ParsedChange::start_byte);
	let new_tokens = new_lines
		.iter()
		.map(|line| {
			if let Some(parsed) = prepared {
				let origin = added_at;
				added_at += line.len() + 1;
				Tokenized::with_shape(
					line,
					Shape::parsed(line, parsed.roles().expect("checked roles"), origin, None),
				)
			} else {
				Tokenized::scan(line, syntax, &mut new_state)
			}
		})
		.collect::<Vec<_>>();
	let old_code = old_tokens
		.iter()
		.map(|line| {
			if (0..line.code).all(|at| line.kind(at) == 2) {
				""
			} else {
				&line.line[..line.shape.comment]
			}
		})
		.collect::<Vec<_>>();
	let new_code = new_tokens
		.iter()
		.map(|line| {
			if (0..line.code).all(|at| line.kind(at) == 2) {
				String::new()
			} else {
				line.line[..line.shape.comment].to_owned()
			}
		})
		.collect::<Vec<_>>();
	let mut paired = counterparts(&old_code, &new_code, context, true, needed);
	if old_code
		.iter()
		.enumerate()
		.any(|(at, code)| needed(at) && code.trim().is_empty())
	{
		let comments = counterparts(pattern, new_lines, context, false, needed);
		for (at, _) in old_code
			.iter()
			.enumerate()
			.filter(|(at, code)| needed(*at) && code.trim().is_empty())
		{
			paired[at] = comments[at];
		}
	}
	let mut edges = context.to_vec();
	edges.sort_unstable();
	for offset in 0..pattern.len().min(matched.len()) {
		if !needed(offset) {
			continue;
		}
		let file = &file_tokens[offset];
		let removed = &old_tokens[offset];
		// The added lines of this line's change block.
		let block = edges
			.iter()
			.rev()
			.find(|(old, _)| *old < offset)
			.map_or(0, |(_, new)| new + 1)
			..edges
				.iter()
				.find(|(old, _)| *old > offset)
				.map_or(new_lines.len(), |(_, new)| *new);
		// When the most similar added line is a sibling (its head differs
		// from the removed line's), every added line with the removed line's
		// head is a rewrite of it too.
		let head = line_head(&removed.keys);
		let starts_like = |at: &usize| line_head(&token_keys(&new_code[*at])) == head;
		let mut rewrites = paired[offset].into_iter().collect::<Vec<_>>();
		let old_start = edges
			.iter()
			.rev()
			.find(|(old, _)| *old < offset)
			.map_or(0, |(old, _)| old + 1);
		let old_end = edges
			.iter()
			.find(|(old, _)| *old > offset)
			.map_or(pattern.len(), |(old, _)| *old);
		let bounded = (old_end - old_start).saturating_mul(block.len()) <= MAX_EDGE_PAIRS;
		if bounded && !head.is_empty() && !paired[offset].as_ref().is_some_and(starts_like) {
			rewrites.extend(
				block
					.clone()
					.filter(|at| Some(*at) != paired[offset] && starts_like(at)),
			);
		}
		if rewrites.is_empty() {
			rewrites.push(usize::MAX);
		}
		let line = start + offset + 1;
		for at in rewrites {
			let empty = Tokenized::new("", syntax);
			let added = new_tokens.get(at).unwrap_or(&empty);
			// Only a small, literal-free code alphabet can prove an edge
			// without a grammar. Bracket/brace forms may themselves be
			// literals, so complex values require the structural proof.
			let simple = new_tokens[block.clone()].iter().all(|tokens| {
				(0..tokens.keys.len()).all(|at| {
					if tokens.kind(at) == 2 {
						return tokens.in_comment(at)
							&& syntax
								.language
								.is_none_or(|language| language == SupportLang::Ini);
					}
					tokens.kind(at) == 0
						&& (tokens.keys[at]
							.chars()
							.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
							|| matches!(
								tokens.keys[at].as_str(),
								"=" | ":" | "." | "+" | "-" | "*" | "&" | "|" | "(" | ")" | "," | ";"
							))
				})
			});
			let proof = || {
				*separator_proof.get_or_init(|| {
					let mut separators = Vec::new();
					for (row, (file, old)) in file_tokens.iter().zip(&old_tokens).enumerate() {
						let Some(aligned) =
							align_tokens(&file.keys, &old.keys, |a, b| file.same_kind(a, old, b))
						else {
							continue;
						};
						for (token, matched) in aligned.iter().enumerate() {
							if matched.is_none()
								&& file.kind(token) == 0
								&& matches!(file.keys[token].as_str(), "," | ";")
							{
								separators.push((start + row, file.spans[token].0));
							}
						}
					}
					structural(&separators)
				})
			};
			let Some(loss) = lost_text(file, removed, added, simple, proof) else {
				continue;
			};
			let (first, last) = match loss {
				Loss::TooLong => {
					return Err(EditError::apply(format!(
						"Refusing inexact match in {path} at line {line}: the line is too long to \
						 compare token by token; copy line {line} exactly as it appears in the file \
						 into the hunk."
					)));
				},
				Loss::Edge { first, last, .. } | Loss::Dropped { first, last } => (first, last),
			};
			let quote = truncate_preview(&file.line[file.spans[first].0..file.spans[last].1]);
			return Err(EditError::apply(match loss {
				Loss::Edge { edge, kept_at_edge: false, .. } => format!(
					"Refusing partial-line match in {path} at line {line}: the file line {edge} with \
					 {quote:?}, but the line replacing it does not; copy line {line} exactly as it \
					 appears in the file into the hunk."
				),
				Loss::Edge { edge, .. } => format!(
					"Refusing partial-line match in {path} at line {line}: the file line {edge} with \
					 {quote:?}; the line replacing it keeps {quote:?}, but not as the file line's own \
					 {}. Copy line {line} exactly as it appears in the file into the hunk.",
					if edge == "ends" { "end" } else { "start" }
				),
				_ => format!(
					"Refusing partial-line match in {path} at line {line}: the file line also contains \
					 {quote:?}, which the replacement would silently drop. Provide the complete line \
					 in the hunk."
				),
			}));
		}
	}
	Ok(())
}

/// The file text a counterpart (`added`) of `removed` loses from `file`, if
/// any (see [`guard_partial_lines`]).
fn lost_text(
	file: &Tokenized<'_>,
	removed: &Tokenized<'_>,
	added: &Tokenized<'_>,
	simple: bool,
	separator_proof: impl Fn() -> Option<SeparatorProof>,
) -> Option<Loss> {
	// Neither comments nor literals may capture an anchor for omitted code,
	// even when their spelling happens to match the file's punctuation.
	// OLD is an authored partial recipe: omitted separators can change its
	// native child fields. Omitted FILE runs still need strict provenance below.
	let align = |a: &Tokenized<'_>, b: &Tokenized<'_>| {
		let mut code =
			align_tokens(&a.keys[..a.code], &b.keys[..b.code], |i, j| a.same_spelling_role(i, b, j))?;
		let comments = align_tokens(&a.keys[a.code..], &b.keys[b.code..], |i, j| {
			a.same_spelling_role(a.code + i, b, b.code + j)
		})?;
		code.extend(comments.into_iter().map(|at| at.map(|at| at + b.code)));
		Some(code)
	};
	let (Some(file_to_removed), Some(removed_to_added)) =
		(align(file, removed), align(removed, added))
	else {
		return Some(Loss::TooLong);
	};
	// Removed tokens the counterpart keeps verbatim; substituted ones pin no
	// position.
	let anchor = |k: usize| removed_to_added[k].filter(|at| added.keys[*at] == removed.keys[k]);
	// Where removed token `j` sits in the added line: its own position, or
	// the gap between the nearest anchored neighbours.
	let added_before = |j: usize| (0..=j).rev().find_map(anchor).map_or(0, |at| at + 1);
	let added_after = |j: usize| {
		(j..removed.keys.len())
			.find_map(anchor)
			.unwrap_or(added.keys.len())
	};
	// A role-invalid copy still keeps the spelling: it cannot authorize
	// omission of the actual source token by masquerading as a substitution.
	let count = |tokens: &Tokenized<'_>,
	             key: &String,
	             model: &Tokenized<'_>,
	             token: usize,
	             range: std::ops::Range<usize>| {
		range
			.filter(|at| tokens.keys[*at] == *key && model.same_spelling_role(token, tokens, *at))
			.count()
	};
	// The run file[index..] placed at `from` in the counterpart keeps the
	// file's tokens, their comment-ness and the depth before them.
	let fits = |index: usize, len: usize, from: usize| {
		added.keys.get(from..from + len) == Some(&file.keys[index..index + len])
			&& (0..len).all(|k| file.same_kind(index + k, added, from + k))
			&& file.preserves_run(index, len, added, from)
			&& file.depth_before(index) == added.depth_before(from)
	};
	let mut lost = vec![false; file.keys.len()];
	let mut misplaced = None;
	let mut index = 0;
	while index < file.keys.len() {
		let (alignment_range, removed_range) = if file.in_comment(index) {
			(added.code..added.keys.len(), removed.code..removed.keys.len())
		} else {
			(0..added.code, 0..removed.code)
		};
		if let Some(j) = file_to_removed[index] {
			// A substituted token survives only when the added line changes
			// the removed line's spelling of it as well, rather than keeping
			// or moving it.
			let spelling = &removed.keys[j];
			lost[index] = file.keys[index] != *spelling
				&& (anchor(j).is_some()
					|| count(added, spelling, removed, j, alignment_range)
						>= count(removed, spelling, removed, j, removed_range));
			index += 1;
			continue;
		}
		let end = (index..file.keys.len())
			.find(|at| {
				file_to_removed[*at].is_some() || file.in_comment(*at) != file.in_comment(index)
			})
			.unwrap_or(file.keys.len());
		let left = file_to_removed[..index]
			.iter()
			.enumerate()
			.rev()
			.filter(|(at, _)| file.in_comment(*at) == file.in_comment(index))
			.find_map(|(_, j)| *j);
		let right = file_to_removed[end..]
			.iter()
			.enumerate()
			.filter(|(at, _)| file.in_comment(end + at) == file.in_comment(index))
			.find_map(|(_, j)| *j);
		let run = &file.keys[index..end];
		let len = run.len();
		// A run at an edge of the line must stay at that edge of the added
		// line (a trailing one may precede only its line comment); an inner
		// one between its aligned neighbours.
		let kept = match (left, right) {
			(None, None) => {
				let (from, to) = if file.in_comment(index) {
					(added.code, added.keys.len())
				} else {
					(0, added.code)
				};
				to - from == len && fits(index, len, from)
			},
			(Some(left), None) => [added.keys.len(), added.code].iter().any(|end| {
				*end >= len && *end - len >= added_before(left) && fits(index, len, *end - len)
			}),
			(None, Some(right)) => {
				let from = if file.in_comment(index) {
					added.code
				} else {
					0
				};
				from + len <= added_after(right) && fits(index, len, from)
			},
			(Some(left), Some(right)) => {
				let from = added_before(left);
				let to = added_after(right).max(from);
				(from..=to.saturating_sub(len)).any(|at| at + len <= to && fits(index, len, at))
			},
		};
		let separator_run = (index..end).all(|at| file.kind(at) == 0)
			&& run.iter().all(|token| matches!(token.as_str(), "," | ";"));
		let kept = if separator_run {
			match separator_proof() {
				Some(SeparatorProof::Preserved) => true,
				Some(SeparatorProof::Rejected) => false,
				Some(SeparatorProof::TrivialOnly) | None => kept && simple,
			}
		} else {
			kept
		};
		for flag in &mut lost[index..end] {
			*flag = !kept;
		}
		if !kept && misplaced.is_none() {
			let at_edge = match (left, right) {
				(Some(_), None) => {
					Some(("ends", added.keys.ends_with(run) || added.keys[..added.code].ends_with(run)))
				},
				(None, Some(_)) => Some(("starts", added.keys.starts_with(run))),
				_ => None,
			};
			let elsewhere = added.keys.windows(len).any(|window| window == run);
			misplaced = at_edge
				.filter(|_| elsewhere)
				.map(|(edge, kept_at_edge)| (index, edge, kept_at_edge));
		}
		index = end;
	}
	let first = lost.iter().position(|flag| *flag)?;
	let last = (first..lost.len())
		.take_while(|at| lost[*at])
		.last()
		.unwrap_or(first);
	Some(match misplaced.filter(|(at, ..)| *at == first) {
		Some((_, edge, kept_at_edge)) => Loss::Edge { first, last, edge, kept_at_edge },
		None => Loss::Dropped { first, last },
	})
}

/// The refusal for an `@@` anchor that did not resolve, once the hunk's own
/// lines could not stand in for it.
fn anchor_failure(lines: &[&str], outcome: &AnchorOutcome, context: &str, path: &str) -> EditError {
	match outcome {
		AnchorOutcome::Incomplete { part } => EditError::apply(format!(
			"Cannot prove the complete nested anchor in {path}: '{part}' is ambiguous before \
			 remaining anchor parts. Add a unique outer anchor or an explicit location with \
			 supporting context."
		)),
		AnchorOutcome::Ambiguous { part, result } => {
			let count = result.match_count.unwrap_or(0);
			let strategy = result
				.strategy
				.map(context_strategy_label)
				.map_or(String::new(), |value| format!(" Matching strategy: {value}."));
			let details = ambiguity_details(
				lines,
				result.match_indices.as_deref().unwrap_or_default(),
				count,
				None,
			);
			EditError::apply(format!(
				"Found {count} matches for context '{part}' in {path}.{strategy} Add more surrounding \
				 context or additional @@ anchors to make it unique.{details}"
			))
		},
		AnchorOutcome::Outside { part, outer, end, hits } => {
			let found_at = hits.iter().map(|hit| *hit as u32 + 1).collect::<Vec<_>>();
			EditError::apply(format!(
				"Failed to find context '{part}' under anchor '{}' (lines {}–{end}) in {path}: its \
				 matches start at lines {}, all outside that block. Anchor on a line inside the \
				 block, or drop the outer @@ line.",
				js_trim(lines[*outer]),
				outer + 1,
				line_list(&found_at)
			))
		},
		AnchorOutcome::Found | AnchorOutcome::Missing => EditError::apply(format!(
			"Failed to find context '{}' in {path}",
			context.replace('\n', " > ")
		)),
	}
}

/// The strict-body fallback is shared by actual placement and counterfactual
/// vetoes: an alternate which cannot be applied must not contradict a target.
fn failed_anchor_admissible(
	lookup: &AnchorLookup,
	hunk: &DiffHunk,
	result: &SequenceSearchResult,
) -> bool {
	matches!(lookup.outcome, AnchorOutcome::Found)
		|| (!matches!(
			lookup.outcome,
			AnchorOutcome::Incomplete { .. } | AnchorOutcome::Outside { .. }
		) && result.index.is_some()
			&& !is_ambiguous(result)
			&& !matches!(&lookup.outcome, AnchorOutcome::Ambiguous { result, .. }
				if result.strategy == Some(ContextMatchStrategy::CaseFold)
					|| result.strategy == Some(ContextMatchStrategy::Fuzzy) && !hunk.has_context_lines)
			&& tier(result.strategy) <= tier(Some(SequenceMatchStrategy::Unicode)))
}

/// Resolve the actual pure-insertion gap, not the empty-pattern placeholder.
/// Failed anchor or numeric counterfactuals have no candidate gap.
fn insertion_start(
	layout: &Layout<'_>,
	hunk: &DiffHunk,
	lookup: Option<&AnchorLookup>,
	hints: Hints,
) -> Result<Option<usize>, EditError> {
	if let Some(lookup) = lookup {
		if !matches!(lookup.outcome, AnchorOutcome::Found) {
			return Ok(None);
		}
		if let Some(anchor) = &lookup.scope {
			return layout
				.insertion_line(anchor, &hunk.new_lines.join("\n"))
				.map(Some);
		}
	}
	if layout.code.is_empty() {
		return Ok(Some(0));
	}
	// Explicit file boundaries are semantic evidence, not numeric ties.
	if hunk.is_start_of_file {
		return Ok(Some(0));
	}
	if hunk.is_end_of_file {
		return Ok(Some(layout.lines.len()));
	}
	Ok(match hints.raw {
		Some(at) => (at <= layout.lines.len()).then_some(at),
		None => Some(layout.lines.len()),
	})
}

/// Resolve against the same immutable text. A fixed hunk removes only
/// changed-row overlaps, never context or a lower-ranked alternative.
fn resolve_hunks(
	layout: &Layout<'_>,
	hunks: &[DiffHunk],
	allow_fuzzy: bool,
	record: Option<&Consumption>,
) -> Result<Vec<PlacedHunk>, EditError> {
	let locate = |position: usize, hunk: &DiffHunk, hints: Hints, incomplete: Option<&mut bool>| {
		let guard = record.filter(|record| hunk.old_lines.is_empty() && !record.history.is_empty());
		let lookup = hunk.change_context.as_deref().map(|context| {
			find_hierarchical_context(
				layout,
				context,
				hints,
				allow_fuzzy,
				&hunk.old_lines,
				guard.is_some(),
			)
		});
		if let Some(incomplete) = incomplete {
			*incomplete = lookup
				.as_ref()
				.is_some_and(|lookup| matches!(lookup.outcome, AnchorOutcome::Incomplete { .. }));
		}
		if let Some((lookup, context)) = lookup.as_ref().zip(hunk.change_context.as_deref())
			&& matches!(
				lookup.outcome,
				AnchorOutcome::Outside { .. } | AnchorOutcome::Incomplete { .. }
			) {
			return Err(anchor_failure(layout.lines, &lookup.outcome, context, layout.path));
		}
		if let Some(record) = guard {
			record.constrain_anchor(layout, hunk, position, lookup.as_ref(), allow_fuzzy)?;
		}
		let target = lookup
			.as_ref()
			.map_or_else(Target::default, |lookup| Target {
				anchor: lookup.scope.as_ref(),
				proof:  lookup.proof.as_deref(),
			});
		let mut placed = place_hunk(layout.lines, hunk, target, &[], hints, allow_fuzzy);
		if hunk.old_lines.is_empty() {
			placed.result.index = insertion_start(layout, hunk, lookup.as_ref(), hints)?;
			placed.result.match_count = if placed.result.index.is_some() {
				Some(1)
			} else {
				lookup.as_ref().and_then(|lookup| match &lookup.outcome {
					AnchorOutcome::Ambiguous { result, .. } => result.match_count,
					_ => None,
				})
			};
			placed.result.match_indices = None;
			placed.result.top_indices = None;
		}
		placed.lookup = lookup;
		Ok::<_, EditError>(placed)
	};
	// Only multiple numerically hinted hunks can contradict one another:
	// a hint-selected placement cannot also be its own offset evidence.
	let check_offsets = hunks
		.iter()
		.filter(|hunk| Hints::of(hunk).raw.is_some())
		.take(2)
		.count()
		== 2;
	let mut hint_evidence = Vec::new();
	let mut placed = Vec::with_capacity(hunks.len());
	// Unanchored full patterns have hint-insensitive rankings. Only their
	// tie selection changes in the offset counterfactual.
	let mut ranked = vec![None; hunks.len()];
	for (position, hunk) in hunks.iter().enumerate() {
		let hints = Hints::of(hunk);
		if check_offsets && let Some(raw) = hints.raw {
			// Invalid counterfactuals are not placement evidence. The actual
			// own-hint lookup still returns its error rather than hiding it.
			let mut incomplete = false;
			let without = locate(position, hunk, Hints::default(), Some(&mut incomplete)).ok();
			if hunk.change_context.is_none()
				&& !hunk.old_lines.is_empty()
				&& let Some(without) = without.as_ref().filter(|without| !without.variant_used)
			{
				ranked[position] = Some(without.result.clone());
			}
			let without_start = without.as_ref().and_then(PlacedHunk::unique_start);
			// Unique unanchored full patterns and explicit file boundaries
			// cannot be changed by a hint. Anchored queries must run both
			// pipelines: a hint can resolve an earlier hierarchy alternative.
			let independent = if hunk.old_lines.is_empty() {
				hunk.change_context.is_none() && (hunk.is_start_of_file || hunk.is_end_of_file)
			} else {
				hunk.change_context.is_none()
					&& without
						.as_ref()
						.is_some_and(|without| !without.variant_used)
			};
			if without_start.is_some() && independent {
				hint_evidence.push((position, raw, None, false, false));
				placed.push(without.unwrap());
				continue;
			}
			let current = locate(position, hunk, hints, None)?;
			let selected = current
				.unique_start()
				.filter(|start| Some(*start) != without_start);
			let ambiguous = incomplete
				|| without
					.as_ref()
					.is_some_and(|without| is_ambiguous(&without.result));
			hint_evidence.push((position, raw, selected, ambiguous, incomplete));
			placed.push(current);
			continue;
		}
		placed.push(locate(position, hunk, hints, None)?);
	}
	if let Some(record) = record {
		for (position, current) in placed.iter_mut().enumerate() {
			record.constrain(layout, &hunks[position], position, current, allow_fuzzy)?;
		}
	}
	let mut fixed = vec![false; hunks.len()];
	let mut used = Vec::new();
	loop {
		let mut progress = false;
		for position in 0..hunks.len() {
			if hunks[position].old_lines.is_empty()
				|| fixed[position]
				|| !is_hit(&placed[position].result)
			{
				continue;
			}
			let hunk = &hunks[position];
			let view = &placed[position].view;
			let unchanged =
				hunk.old_lines.len() == hunk.new_lines.len() && hunk.old_lines == hunk.new_lines;
			let mut effects = HashMap::new();
			if !used.is_empty() && !unchanged {
				let first = changed_offsets(hunk, view)
					.first()
					.copied()
					.unwrap_or_default();
				let (result, by) = exclude_consumed_by(placed[position].result.clone(), first, |at| {
					let effect = effects
						.entry(at)
						.or_insert_with(|| prepare_effect(layout.lines, hunk, view, at));
					consumer(at, &effect.changed, &used)
				});
				placed[position].result = result;
				placed[position].consumed_by = by;
			}
			if placed[position].result.index.is_some() && !is_ambiguous(&placed[position].result) {
				fixed[position] = true;
				let at = placed[position].result.index.unwrap();
				if placed[position].variant_used
					&& (!variant_is_evidenced(
						layout.lines,
						&placed[position].view.old_refs(hunk),
						at,
						allow_fuzzy,
					) || dropped_context_elsewhere(layout.lines, hunk, &placed[position].view, at))
				{
					return Err(EditError::apply(format!(
						"Hunk #{} in {} has no independent evidence for its repaired context at line \
						 {}; copy the intended lines exactly or add context.",
						position + 1,
						layout.path,
						at + 1,
					)));
				}
				if !unchanged {
					let effect = effects.remove(&at).unwrap_or_else(|| {
						prepare_effect(layout.lines, hunk, &placed[position].view, at)
					});
					used.extend(
						effect
							.changed
							.iter()
							.map(|&row| Consumed { lines: at + row..at + row + 1, hunk: position + 1 }),
					);
					placed[position].effect = Some(effect);
				}
				progress = true;
			}
		}
		if progress {
			continue;
		}
		// Equal-effect hunks may fill a complete set of equal candidates.
		// Noninterchangeable hunks never gain placement evidence from order.
		for position in 0..hunks.len() {
			if hunks[position].old_lines.is_empty()
				|| fixed[position]
				|| !is_ambiguous(&placed[position].result)
			{
				continue;
			}
			let hunk = &hunks[position];
			let mut group = (position..hunks.len())
				.filter(|&other| {
					!fixed[other]
						&& hunks[other].old_lines == hunk.old_lines
						&& hunks[other].new_lines == hunk.new_lines
						&& hunks[other].context_lines == hunk.context_lines
						&& hunks[other].change_context == hunk.change_context
						&& placed[other].view == placed[position].view
						&& placed[other].result.match_indices == placed[position].result.match_indices
						&& placed[other].result.top_indices == placed[position].result.top_indices
				})
				.collect::<Vec<_>>();
			let indices = placed[position]
				.result
				.match_indices
				.as_deref()
				.unwrap_or_default();
			if group.len() < 2
				|| group.len() != indices.len()
				|| placed[position]
					.result
					.top_indices
					.as_ref()
					.is_some_and(|top| top.len() != indices.len())
			{
				continue;
			}
			// Equal effects permit arbitrary pairing for bytes, but not for
			// offset evidence. Canonical hint order keeps that pairing stable.
			group.sort_unstable_by_key(|&other| Hints::of(&hunks[other]).raw);
			let assignments = group
				.into_iter()
				.zip(indices.iter().copied())
				.collect::<Vec<_>>();
			for (other, at) in assignments {
				if placed[other].variant_used
					&& (!variant_is_evidenced(
						layout.lines,
						&placed[other].view.old_refs(&hunks[other]),
						at,
						allow_fuzzy,
					) || dropped_context_elsewhere(
						layout.lines,
						&hunks[other],
						&placed[other].view,
						at,
					)) {
					return Err(EditError::apply(format!(
						"Hunk #{} in {} has no independent evidence for its repaired context at line \
						 {}; copy the intended lines exactly or add context.",
						other + 1,
						layout.path,
						at + 1,
					)));
				}
				let result = &mut placed[other].result;
				result.index = Some(at);
				result.match_count = Some(1);
				result.match_indices = Some(vec![at]);
				result.top_indices = None;
				fixed[other] = true;
				if hunks[other].old_lines != hunks[other].new_lines {
					let effect = prepare_effect(layout.lines, &hunks[other], &placed[other].view, at);
					used.extend(
						effect
							.changed
							.iter()
							.map(|&row| Consumed { lines: at + row..at + row + 1, hunk: other + 1 }),
					);
					placed[other].effect = Some(effect);
				}
			}
			progress = true;
		}
		if !progress {
			break;
		}
	}
	let mut offsets = Vec::new();
	for &(position, raw, selected, _, incomplete) in &hint_evidence {
		if incomplete {
			continue;
		}
		if let Some(start) = placed[position].unique_start()
			&& Some(start) != selected
		{
			let offset = start - raw as isize;
			if offset != 0 {
				offsets.push(offset);
			}
		}
	}
	offsets.sort_unstable();
	offsets.dedup();
	// Every certain non-hint-selected placement contributes, including those
	// made unique by elimination. Offsets only veto; they never place a hunk.
	for (position, raw, selected, ambiguous, _) in hint_evidence {
		let own = placed[position].unique_start();
		let by_hint = selected.is_some() && selected == own;
		if !(by_hint || selected.is_none() && own.is_none() && ambiguous) {
			continue;
		}
		let hunk = &hunks[position];
		for &offset in &offsets {
			let Some(shifted) = raw.checked_add_signed(offset) else {
				continue;
			};
			// A failed counterfactual selects no valid alternative; it
			// cannot veto the actual, independently checked placement.
			let (alternative, other) = if let Some(ranked) = &ranked[position] {
				let result = tie_break(ranked.clone(), Hints { raw: Some(shifted) });
				let start = result
					.index
					.filter(|_| !is_ambiguous(&result))
					.map(|at| placed[position].view.start_at(at));
				(result, start)
			} else {
				let Ok(mut alternative) = locate(position, hunk, Hints { raw: Some(shifted) }, None)
				else {
					continue;
				};
				if let Some(lookup) = alternative.lookup.take()
					&& (!failed_anchor_admissible(&lookup, hunk, &alternative.result)
						|| !alternative.eligible(layout, &lookup, hunk, allow_fuzzy))
				{
					continue;
				}
				let start = alternative.unique_start();
				(alternative.result, start)
			};
			if let Some(other) = other
				&& Some(other) != own
			{
				let number = position + 1;
				let path = layout.path;
				let other_at = alternative.index.unwrap();
				let message = if let Some(at) = placed[position].result.index.filter(|_| by_hint) {
					format!(
						"Conflicting line hints for hunk #{number} in {path}: its matches start at \
						 lines {}, {}. Drop stale line numbers or add surrounding context to make its \
						 target unique.",
						at.min(other_at) + 1,
						at.max(other_at) + 1,
					)
				} else {
					format!(
						"Conflicting line hints for hunk #{number} in {path}: its raw hint {} selects \
						 no unique match, but the content-derived hint {} selects a match at line {}. \
						 Drop stale line numbers or add surrounding context to make its target unique.",
						raw + 1,
						shifted + 1,
						other_at + 1,
					)
				};
				return Err(EditError::apply(message));
			}
		}
	}
	Ok(placed)
}

fn compute_replacements(
	content: &str,
	lines: &[&str],
	path: &str,
	hunks: &[DiffHunk],
	allow_fuzzy: bool,
	record: Option<&Consumption>,
) -> Result<(Vec<Replacement>, Vec<String>), EditError> {
	let layout = Layout::new(lines, path, content);
	let mut replacements = Vec::new();
	let mut warnings = Vec::new();
	let consumed: Vec<Consumed> = Vec::new();
	let mut context_rows = Vec::new();
	let mut context_gaps = Vec::new();
	let mut next_id = lines.len();
	let mut obligations = Vec::new();
	let mut insertion_obligations = Vec::new();
	let mut rewritten = HashMap::new();
	let placements = resolve_hunks(&layout, hunks, allow_fuzzy, record)?;
	for (position, (hunk, mut placed)) in hunks.iter().zip(placements).enumerate() {
		let number = position + 1;
		if hunk.old_start_line == Some(0) || hunk.new_start_line == Some(0) {
			return Err(EditError::apply(format!(
				"Line hint 0 is out of range for {path} (line numbers start at 1)"
			)));
		}
		let line_hint = hunk.old_start_line;
		let raw_hint = line_hint.map(|hint| hint as usize - 1);
		let hints = Hints::of(hunk);
		let mut lookup = placed.lookup.take();
		if let Some(lookup) = lookup.as_mut() {
			placed.bind_context_anchor(&layout, lookup, hunk);
		}
		if let Some(lookup) = lookup.as_ref()
			&& !placed.eligible(&layout, lookup, hunk, allow_fuzzy)
		{
			if let Some(error) = lookup
				.scope
				.as_ref()
				.and_then(|scope| layout.proof_errors.borrow().get(&scope.line).cloned())
			{
				return Err(EditError::apply(format!("Hunk #{number} in {path}: {error}")));
			}
			return Err(EditError::apply(format!(
				"Hunk #{number}'s placement in {path} cannot preserve the construct identified by its \
				 anchor. Add a unique context line inside the intended construct."
			)));
		}
		let failure = lookup
			.as_ref()
			.zip(hunk.change_context.as_deref())
			.filter(|(lookup, _)| !matches!(lookup.outcome, AnchorOutcome::Found));
		let anchor = lookup
			.as_ref()
			.filter(|lookup| matches!(lookup.outcome, AnchorOutcome::Found))
			.and_then(|lookup| lookup.scope.as_ref());
		for (part, line, strategy) in anchor.iter().flat_map(|anchor| &anchor.inexact) {
			warnings.push(format!(
				"Anchor '{part}' in {path} matched line {} ({:?}) via the {} strategy. Re-read the \
				 file if this is not the intended block.",
				line + 1,
				js_trim(lines[*line]),
				context_strategy_label(*strategy)
			));
		}

		if hunk.old_lines.is_empty() {
			if let Some((lookup, context)) = failure {
				return Err(anchor_failure(lines, &lookup.outcome, context, path));
			}
			let insertion = placed.result.index.ok_or_else(|| {
				let hint = hunk
					.old_start_line
					.or(hunk.new_start_line)
					.unwrap_or_default();
				EditError::apply(format!(
					"Line hint {hint} is out of range for insertion in {path} (file has {} lines)",
					lines.len()
				))
			})?;
			if let Some(anchor) = anchor {
				context_rows.push((anchor.line, number));
				if let Some(above) = insertion.checked_sub(1) {
					context_rows.push((above, number));
				}
			}
			let new_ids = (next_id..next_id + hunk.new_lines.len()).collect::<Vec<_>>();
			next_id += new_ids.len();
			if (anchor.is_some() || insertion == 0) && !new_ids.is_empty() {
				insertion_obligations.push((insertion, new_ids.clone()));
			}
			let mut expected = new_ids.clone();
			if anchor.is_some() && insertion > 0 {
				expected.insert(0, insertion - 1);
			}
			obligations.push((number, expected));
			// Zero rows have one real boundary, even when a numeric header names
			// it. This supplies append-side evidence, not a fabricated context
			// row.
			let empty_boundary =
				lines.is_empty() && insertion == 0 && hints.raw == Some(0) && !hunk.is_start_of_file;
			replacements.push(Replacement {
				start_index: insertion,
				old_len: 0,
				new_lines: hunk.new_lines.clone(),
				new_ids,
				origins: vec![RowOrigin::Inserted; hunk.new_lines.len()],
				window: insertion..insertion,
				hunk: number,
				above: anchor.is_some() || hunk.is_start_of_file,
				below: anchor.is_none()
					&& (hunk.is_end_of_file
						|| empty_boundary
						|| (hunk.old_start_line.is_none() && hunk.new_start_line.is_none())),
				anchored: anchor.is_some(),
			});
			continue;
		}

		let target = lookup
			.as_ref()
			.map_or_else(Target::default, |lookup| Target {
				anchor: lookup.scope.as_ref(),
				proof:  lookup.proof.as_deref(),
			});
		let PlacedHunk {
			result,
			view,
			ignored_context,
			variant_used,
			already_applied: applied,
			retried,
			consumed_by,
			effect,
			lookup: _,
		} = placed;
		if let Some(ConsumedBest { start, line, hunk: earlier, lower }) = consumed_by {
			if lower.is_empty() {
				return Err(EditError::apply(format!(
					"Hunk #{number} has no unconsumed best-ranked placement in {path}: its edit \
					 beginning at line {} would change line {}, which hunk #{earlier} already changes. \
					 Merge the hunks or add context to distinguish their targets.",
					start + 1,
					line + 1,
				)));
			}
			let others = lower.iter().map(|at| *at as u32 + 1).collect::<Vec<_>>();
			let lines_word = if others.len() == 1 { "line" } else { "lines" };
			return Err(EditError::apply(format!(
				"Hunk #{number}'s best-ranked edit beginning at line {} in {path} would change line \
				 {}, which hunk #{earlier} already changes; the edits beginning at {lines_word} {} \
				 match more loosely and cannot inherit it. Copy the intended lines exactly into the \
				 hunk, or add context.",
				start + 1,
				line + 1,
				line_list(&others)
			)));
		}
		if let Some(line) = applied {
			return Err(EditError::apply(format!(
				"Hunk #{number} appears already applied at line {} in {path}: its new lines are there \
				 and its old lines match nowhere else. Re-read the file before editing it again.",
				line + 1
			)));
		}
		// A placement at a loose tier is no evidence against an exact copy of
		// the hunk's result in scope.
		let loose = result.index.filter(|_| {
			!is_ambiguous(&result)
				&& tier(result.strategy) >= tier(Some(SequenceMatchStrategy::Prefix))
		});
		if let Some(found) = loose
			&& let Some(line) = already_applied(lines, hunk, target.anchor)
				.filter(|line| *line + hunk.new_lines.len() <= found || *line >= found + view.old.len())
		{
			return Err(EditError::apply(format!(
				"Hunk #{number}'s old lines matched {path} only loosely, at line {} via the {} \
				 strategy, and its new lines already sit at line {}. If line {} is the target, copy \
				 it exactly into the hunk; otherwise re-read the file before editing it again.",
				found + 1,
				result.strategy.map_or("fuzzy", sequence_strategy_label),
				line + 1,
				found + 1
			)));
		}
		// A placement found only without the trailing blank line is as loose.
		if let Some(found) = result.index.filter(|_| retried && !is_ambiguous(&result))
			&& let Some(line) = already_applied(lines, hunk, target.anchor)
				.filter(|line| *line + hunk.new_lines.len() <= found || *line >= found + view.old.len())
		{
			return Err(EditError::apply(format!(
				"Hunk #{number}'s old lines matched {path} at line {} only after dropping its \
				 trailing blank line, and its new lines already sit at line {}; if line {} is the \
				 target, drop the blank context line.",
				found + 1,
				line + 1,
				found + 1
			)));
		}
		// A failed anchor stands aside only for a unique placement of the
		// hunk's own lines at a strict tier, inside the enclosing part's region
		// when nested: a near match elsewhere is a guess the anchor never made.
		if let Some((lookup, context)) = failure
			&& !failed_anchor_admissible(lookup, hunk, &result)
		{
			return Err(anchor_failure(lines, &lookup.outcome, context, path));
		}
		let bare_hunk = hunk.change_context.is_none()
			&& !hunk.has_context_lines
			&& !hunk.is_end_of_file
			&& line_hint.is_none();
		let anchor_scope = target.anchor.map_or(String::new(), |anchor| {
			format!(
				" under anchor '{}' (lines {}–{})",
				js_trim(lines[anchor.line]),
				anchor.line + 1,
				anchor.end
			)
		});
		let refs = view.old_refs(hunk);
		if let Some(count) = result.match_count.filter(|count| *count > 1) {
			let candidates = result.match_indices.as_deref().unwrap_or_default();
			if variant_used {
				// Replaying suggestions cannot help: the full hunk matches
				// nowhere under any anchor. Name what did not match instead.
				let unmatched = hunk
					.context_lines
					.iter()
					.map(|(old, _)| js_trim(&hunk.old_lines[*old]))
					.filter(|text| !text.is_empty() && !lines.iter().any(|line| js_trim(line) == *text))
					.map(|text| format!("'{text}'"))
					.collect::<Vec<_>>();
				let named = if unmatched.is_empty() {
					String::new()
				} else {
					format!(
						" The hunk's context {} matches nowhere in the file; without it, the remaining \
						 lines match {count} places.",
						unmatched.join(", ")
					)
				};
				let details = ambiguity_details(lines, candidates, count, None);
				return Err(EditError::apply(format!(
					"Found {count} matches for the text in {path}{anchor_scope}.{named}{details}"
				)));
			}
			let query = HunkQuery {
				layout: &layout,
				hunk,
				context: hunk.change_context.as_deref().filter(|_| anchor.is_some()),
				consumed: &consumed,
				hints,
				allow_fuzzy,
				budget: Cell::new(SUGGESTION_REPLAYS),
			};
			let details = ambiguity_details(lines, candidates, count, Some(&query));
			if bare_hunk {
				return Err(EditError::apply(format!(
					"Found {count} occurrences in {path}. Add more context lines to \
					 disambiguate.{details}"
				)));
			}
			let strategy = result
				.strategy
				.map(sequence_strategy_label)
				.map_or(String::new(), |value| format!(" Matching strategy: {value}."));
			let advice = if anchor.is_some() {
				"Add a nested @@ anchor or more context lines to make it unique."
			} else {
				"Add more surrounding context or additional @@ anchors to make it unique."
			};
			return Err(EditError::apply(format!(
				"Found {count} matches for the text in {path}{anchor_scope}.{strategy} \
				 {advice}{details}"
			)));
		}
		let Some(found) = result.index else {
			let mut scope = if target.anchor.is_some() {
				format!("\n\nSearched only{anchor_scope}.")
			} else {
				String::new()
			};
			// Candidates lie below the anchor; say so when the lines sit above it.
			if let Some(anchor) = anchor {
				let above = seek_sequence_within(lines, &refs, 0, anchor.line, false, allow_fuzzy);
				if let Some(line) = above.index.filter(|_| !is_ambiguous(&above)) {
					let _ = write!(
						scope,
						" The changed lines were found at line {}, above the anchor; the @@ line must \
						 be above the lines you change, or be one of the hunk's context lines.",
						line + 1
					);
				}
			}
			let (closest, confidence, _) =
				find_closest_sequence_match(lines, &refs, None, hunk.is_end_of_file);
			if let Some(closest) = closest.filter(|_| confidence > 0.0) {
				return Err(EditError::apply(format!(
					"Failed to find expected lines in {path}:\n{}\n\nClosest match ({:.0}% similar) \
					 near line {}:\n{}{scope}",
					hunk.old_lines.join("\n"),
					confidence * 100.0,
					closest + 1,
					sequence_preview(lines, closest)
				)));
			}
			return Err(EditError::apply(format!(
				"Failed to find expected lines in {path}:\n{}{scope}",
				hunk.old_lines.join("\n")
			)));
		};
		if let Some(strategy) = result.strategy {
			if strategy == SequenceMatchStrategy::FuzzyDominant {
				warnings.push(format!(
					"Dominant fuzzy match selected in {path} near line {} ({:.0}% similar).",
					found + 1,
					result.confidence * 100.0
				));
			} else if matches!(
				strategy,
				SequenceMatchStrategy::CommentPrefix
					| SequenceMatchStrategy::Prefix
					| SequenceMatchStrategy::Substring
					| SequenceMatchStrategy::Fuzzy
					| SequenceMatchStrategy::Character
			) {
				warnings.push(format!(
					"Inexact match in {path} near line {}: matched via {} strategy ({:.0}% similar). \
					 Re-read the file if the result is not what you intended.",
					found + 1,
					sequence_strategy_label(strategy),
					result.confidence * 100.0
				));
			}
		}
		if let Some(ignored) = ignored_context {
			warnings.push(format!(
				"Hunk #{number} applied at line {} in {path} with {ignored} of its lines ignored; the \
				 remaining lines matched uniquely. Re-read the file if the result is not what you \
				 intended.",
				found + 1
			));
		}
		if let Some(raw) = raw_hint {
			// GNU patch reports "Hunk #N succeeded at M (offset k lines)",
			// measured from where the whole hunk starts, against its own line
			// number: a variant that kept only later lines starts above them.
			let offset = view.start_at(found) - raw as isize;
			if offset.abs() > 3 {
				warnings.push(format!(
					"Hunk #{number} applied at line {} in {path}, offset {offset} lines from its line \
					 hint.",
					found + 1
				));
			}
		}
		let context = view.context(hunk);
		context_rows.extend(context.iter().map(|&(row, _)| (found + row, number)));
		context_gaps.extend(
			context
				.windows(2)
				.filter_map(|pair| (pair[1].0 == pair[0].0 + 1).then_some((found + pair[1].0, number))),
		);
		if hunk.old_lines == hunk.new_lines {
			obligations.push((number, (found..found + refs.len()).collect()));
			continue;
		}
		let PreparedEffect { new_lines, retained, changed, origins } =
			effect.unwrap_or_else(|| prepare_effect(lines, hunk, &view, found));
		if changed.is_empty() && new_lines.len() == refs.len() {
			obligations.push((number, (found..found + refs.len()).collect()));
			continue;
		}
		let mut new_ids = (next_id..next_id + new_lines.len()).collect::<Vec<_>>();
		next_id += new_ids.len();
		let origins = origins
			.into_iter()
			.enumerate()
			.map(|(new, origin)| match origin {
				RowOrigin::Retained(old) => {
					new_ids[new] = found + old;
					RowOrigin::Retained(found + old)
				},
				RowOrigin::Moved(old) => {
					new_ids[new] = found + old;
					RowOrigin::Moved(found + old)
				},
				RowOrigin::Rewritten(old) => {
					rewritten.insert(found + old, new_ids[new]);
					RowOrigin::Rewritten(found + old)
				},
				RowOrigin::Inserted => RowOrigin::Inserted,
			})
			.collect::<Vec<_>>();
		insertion_obligations.extend(
			semantic_insertion_gaps(
				&origins,
				anchor.filter(|anchor| anchor.line < found).map(|_| found),
				context.iter().map(|&(_, row)| row).max(),
			)
			.into_iter()
			.map(|(gap, rows)| (gap, new_ids[rows].to_vec())),
		);
		obligations.push((number, new_ids.clone()));
		let matched = &lines[found..found + refs.len()];
		if matches!(
			result.strategy,
			Some(
				SequenceMatchStrategy::CommentPrefix
					| SequenceMatchStrategy::Unicode
					| SequenceMatchStrategy::Prefix
					| SequenceMatchStrategy::Substring
					| SequenceMatchStrategy::Fuzzy
					| SequenceMatchStrategy::FuzzyDominant
					| SequenceMatchStrategy::Character
			)
		) {
			let parsed = OnceCell::new();
			let get_parsed = || {
				parsed
					.get_or_init(|| {
						layout.index().and_then(|index| {
							let begin = index.row_start(found)?;
							let end = index.row_start(found + refs.len()).unwrap_or(content.len());
							let mut replacement = new_lines.join("\n");
							if !new_lines.is_empty() && content[..end].ends_with('\n') {
								replacement.push('\n');
							}
							index.parse_change(begin..end, &replacement).ok()
						})
					})
					.as_ref()
			};
			guard_partial_lines(
				(path, get_parsed),
				&refs,
				matched,
				&context,
				&new_lines,
				found,
				|separators| {
					get_parsed().map(|parsed| {
						let unchanged = retained
							.iter()
							.map(|&(old, new)| (found + old, new))
							.collect::<Vec<_>>();
						let rewritten = counterparts(matched, &new_lines, &context, false, |_| true)
							.into_iter()
							.enumerate()
							.filter_map(|(old, new)| new.map(|new| (found + old, new)))
							.collect::<Vec<_>>();
						parsed.preserves_separators(separators, &unchanged, &rewritten)
					})
				},
			)?;
		}
		// Each change block (the removed and added lines between two context
		// lines) is spliced on its own, so context lines stay the file's and
		// adjacent hunks may share them. Added lines a block opens or closes
		// with next to a context line are insertions tied to that line.
		let context = retained;
		let window = found..found + refs.len();
		let mut from = (0, 0);
		let mut above = false;
		let edges = context
			.iter()
			.map(|edge| (*edge, true))
			.chain([((refs.len(), new_lines.len()), false)]);
		for ((end_old, end_new), below) in edges {
			let removed = from.0..end_old.max(from.0);
			let added = from.1..end_new.max(from.1);
			from = (end_old + 1, end_new + 1);
			let block_above = above;
			above = true;
			if removed.is_empty() && added.is_empty() {
				continue;
			}
			let mut atom = |start: usize,
			                old_len: usize,
			                added: Range<usize>,
			                above: bool,
			                below: bool|
			 -> Result<(), EditError> {
				replacements.push(Replacement {
					start_index: found + start,
					old_len,
					new_lines: new_lines[added.clone()].to_vec(),
					new_ids: new_ids[added.clone()].to_vec(),
					origins: origins[added].to_vec(),
					window: window.clone(),
					hunk: number,
					above,
					below,
					anchored: false,
				});
				Ok(())
			};
			if removed.is_empty() {
				atom(removed.start, 0, added, block_above, below)?;
				continue;
			}
			let (lead, trail) = if block_above || below {
				unpaired_edges(&refs[removed.clone()], &new_lines[added.clone()])
			} else {
				(0, 0)
			};
			let lead = if block_above { lead } else { 0 };
			let trail = if below {
				trail.min(added.len() - lead)
			} else {
				0
			};
			let middle = added.start + lead..added.end - trail;
			if lead > 0 {
				atom(removed.start, 0, added.start..middle.start, true, false)?;
			}
			atom(
				removed.start,
				removed.len(),
				middle.clone(),
				block_above && lead == 0,
				below && trail == 0,
			)?;
			if trail > 0 {
				atom(removed.end, 0, middle.end..added.end, false, true)?;
			}
		}
	}
	// Every edge is indexed, including pure deletions. A replacement's
	// adjacency conflicts with every other hunk's insertion. Pure
	// insertions instead reserve their above/below side.
	let conflict = |gap: usize, left: &Replacement, right: &Replacement| {
		EditError::apply(format!(
			"Overlapping hunks detected in {path}: hunks #{} and #{} compete for the gap at line {}. \
			 Merge them into one hunk or give each insertion its own context line.",
			left.hunk.min(right.hunk),
			left.hunk.max(right.hunk),
			gap + 1
		))
	};
	context_rows.sort_unstable();
	for atom in &replacements {
		if atom.old_len == 0
			&& context_gaps
				.iter()
				.any(|&(gap, hunk)| gap == atom.start_index && hunk != atom.hunk)
		{
			return Err(EditError::apply(format!(
				"Hunk #{} inserts between consecutive context rows in {path} at line {}; merge the \
				 hunks.",
				atom.hunk,
				atom.start_index + 1
			)));
		}
	}
	for atom in &replacements {
		if atom.old_len <= atom.new_lines.len() {
			continue;
		}
		let start = context_rows.partition_point(|(row, _)| *row < atom.start_index);
		let paired = (!atom.new_lines.is_empty()).then(|| {
			counterparts(
				&lines[atom.start_index..atom.start_index + atom.old_len],
				&atom.new_lines,
				&[],
				false,
				|_| true,
			)
		});
		if let Some(&(row, other)) = context_rows[start..]
			.iter()
			.take_while(|(row, _)| *row < atom.start_index + atom.old_len)
			.find(|(row, hunk)| {
				*hunk != atom.hunk
					&& !rewritten.contains_key(row)
					&& paired
						.as_ref()
						.is_none_or(|paired| paired[*row - atom.start_index].is_none())
			}) {
			return Err(EditError::apply(format!(
				"Overlapping hunks detected in {path}: hunk #{} deletes line {}, which hunk #{} uses \
				 as context. Merge the hunks or keep that context line.",
				atom.hunk,
				row + 1,
				other
			)));
		}
	}
	let mut gaps = Vec::with_capacity(replacements.len() * 2);
	for (at, atom) in replacements.iter().enumerate() {
		if atom.old_len == 0 || atom.above {
			gaps.push((atom.start_index, at));
		}
		if atom.old_len > 0 && atom.below {
			gaps.push((atom.start_index + atom.old_len, at));
		}
	}
	gaps.sort_unstable();
	let mut start = 0;
	while start < gaps.len() {
		let gap = gaps[start].0;
		let end = start + gaps[start..].partition_point(|(at, _)| *at == gap);
		let mut sides: [Option<usize>; 2] = [None, None];
		let mut untied: Option<usize> = None;
		let mut edge: Option<usize> = None;
		let mut insertion: Option<usize> = None;
		for &(_, at) in &gaps[start..end] {
			let atom = &replacements[at];
			if atom.old_len > 0 {
				if let Some(other) = insertion
					&& replacements[other].hunk != atom.hunk
				{
					return Err(conflict(gap, atom, &replacements[other]));
				}
				edge = Some(at);
				continue;
			}
			if let Some(other) = edge
				&& replacements[other].hunk != atom.hunk
			{
				return Err(conflict(gap, atom, &replacements[other]));
			}
			insertion = Some(at);
			if !atom.above && !atom.below {
				if let Some(other) = untied {
					return Err(conflict(gap, atom, &replacements[other]));
				}
				untied = Some(at);
			}
			for (side, tied) in [atom.above, atom.below].into_iter().enumerate() {
				if tied {
					if let Some(other) = sides[side]
						&& replacements[other].hunk != atom.hunk
					{
						return Err(conflict(gap, atom, &replacements[other]));
					}
					sides[side] = Some(at);
				}
			}
		}
		if let Some(at) = untied {
			match sides {
				[Some(_), None] => replacements[at].below = true,
				[None, Some(_)] => replacements[at].above = true,
				_ => {
					return Err(EditError::apply(format!(
						"Hunk #{} has no unambiguous context tie for the gap at line {} in {path}; add \
						 a context line from the intended position.",
						replacements[at].hunk,
						gap + 1
					)));
				},
			}
		}
		start = end;
	}
	replacements.sort_by_key(|atom| {
		(atom.start_index, atom.old_len > 0, atom.below_only(), atom.window.start)
	});
	for pair in replacements.windows(2) {
		let [left, right] = pair else { unreachable!() };
		if right.start_index < left.start_index + left.old_len {
			let range = |replacement: &Replacement| {
				if replacement.old_len == 0 {
					format!("{} (insertion)", replacement.start_index + 1)
				} else {
					format!(
						"{}-{}",
						replacement.start_index + 1,
						replacement.start_index + replacement.old_len
					)
				}
			};
			return Err(EditError::apply(format!(
				"Overlapping hunks detected in {path} at lines {} and {}. Split hunks or add more \
				 context to avoid overlap.",
				range(left),
				range(right)
			)));
		}
	}
	// Simulate the final splice with row identities, not byte searches:
	// equal text elsewhere must never satisfy a displaced context row.
	let mut identities = Vec::with_capacity(next_id);
	let mut cursor = 0;
	for atom in &replacements {
		identities.extend(cursor..atom.start_index);
		identities.extend_from_slice(&atom.new_ids);
		cursor = atom.start_index + atom.old_len;
	}
	identities.extend(cursor..lines.len());
	let positions = identities
		.iter()
		.enumerate()
		.map(|(at, &id)| (id, at))
		.collect::<HashMap<_, _>>();
	for (hunk, expected) in obligations {
		let mut previous = None;
		for id in expected {
			let id = rewritten.get(&id).copied().unwrap_or(id);
			let at = positions.get(&id).copied();
			if at.is_none() || previous.is_some_and(|previous| at != Some(previous + 1)) {
				return Err(EditError::apply(format!(
					"Hunk #{hunk}'s result adjacency in {path} conflicts with another hunk; merge the \
					 hunks so context and added lines remain contiguous.",
				)));
			}
			previous = at;
		}
	}
	let terminal_newline = content.ends_with('\n');
	let logical = has_continuation_candidate(content)
		|| replacements.iter().any(|atom| {
			atom.new_lines.iter().zip(&atom.new_ids).any(|(line, id)| {
				(terminal_newline || positions[id] + 1 < identities.len())
					&& line.trim_end_matches([' ', '\t', '\r']).ends_with('\\')
			})
		});
	if !insertion_obligations.is_empty() || logical {
		let mut rows = Vec::with_capacity(identities.len());
		let mut cursor = 0;
		for atom in &replacements {
			rows.extend_from_slice(&lines[cursor..atom.start_index]);
			rows.extend(atom.new_lines.iter().map(String::as_str));
			cursor = atom.start_index + atom.old_len;
		}
		rows.extend_from_slice(&lines[cursor..]);
		let mut source = rows.join("\n");
		if terminal_newline {
			source.push('\n');
		}
		let correspondence = (0..lines.len())
			.map(|row| positions.get(rewritten.get(&row).unwrap_or(&row)).copied())
			.collect::<Vec<_>>();
		let retained_rows = if logical {
			let authored = replacements
				.iter()
				.flat_map(|atom| atom.new_ids.iter().zip(&atom.origins))
				.filter_map(|(&id, origin)| {
					(!matches!(origin, RowOrigin::Retained(_) | RowOrigin::Moved(_))).then_some(id)
				})
				.collect::<HashSet<_>>();
			(0..lines.len())
				.map(|row| {
					(!authored.contains(&row))
						.then(|| positions.get(&row).copied())
						.flatten()
				})
				.collect::<Vec<_>>()
		} else {
			Vec::new()
		};
		let gaps = insertion_obligations
			.into_iter()
			.map(|(gap, ids)| {
				let begin = positions[&ids[0]];
				let end = positions[ids.last().unwrap()] + 1;
				(gap, begin..end)
			})
			.collect::<Vec<_>>();
		let inserted_ids = replacements
			.iter()
			.flat_map(|atom| atom.new_ids.iter().zip(&atom.origins))
			.filter_map(|(&id, origin)| matches!(origin, RowOrigin::Inserted).then_some(id))
			.collect::<HashSet<_>>();
		let composed_origins = identities
			.iter()
			.map(|&id| {
				if inserted_ids.contains(&id) {
					RowOrigin::Inserted
				} else {
					RowOrigin::Retained(id)
				}
			})
			.collect::<Vec<_>>();
		validate_composed_insertions(
			&layout,
			&source,
			&correspondence,
			&gaps,
			&inserted_runs(&composed_origins, 0),
			&retained_rows,
		)?;
	}
	Ok((replacements, warnings))
}

/// One ownership pipeline for semantic insertion runs on both patch routes.
/// A trailing assertion is omitted from `gaps`; retained pivots are not
/// assertions.
fn validate_composed_insertions(
	layout: &Layout<'_>,
	source: &str,
	correspondence: &[Option<usize>],
	gaps: &[(usize, Range<usize>)],
	inserted: &[Range<usize>],
	retained_rows: &[Option<usize>],
) -> Result<(), EditError> {
	if gaps.is_empty()
		&& (!retained_rows.iter().any(Option::is_some)
			|| !(has_continuation_candidate(layout.code) || has_continuation_candidate(source)))
		|| Syntax::for_path(layout.path).language.is_none()
		|| layout.code.is_empty()
	{
		return Ok(());
	}
	let refusal = |reason: &str| {
		EditError::apply(format!(
			"The composed insertions in {} cannot prove documentation or displaced-row ownership: \
			 {reason}. Add explicit trailing context or merge the hunks.",
			layout.path,
		))
	};
	let Some(index) = layout.index() else {
		return Err(refusal(
			"the supported syntax index is unavailable for the retained logical successor",
		));
	};
	if source.len() > TREE_SOURCE_LIMIT {
		return Err(refusal("the composed supported syntax index is unavailable"));
	}
	let old_starts = std::iter::once(0)
		.chain(layout.code.match_indices('\n').map(|(at, _)| at + 1))
		.collect::<Vec<_>>();
	let starts = std::iter::once(0)
		.chain(source.match_indices('\n').map(|(at, _)| at + 1))
		.collect::<Vec<_>>();
	let mapping = correspondence
		.iter()
		.enumerate()
		.map(|(row, new)| (old_starts[row], new.and_then(|at| starts.get(at)).copied()))
		.chain([(layout.code.len(), Some(source.len()))])
		.collect::<Vec<_>>();
	let mut retained = retained_rows
		.iter()
		.enumerate()
		.filter_map(|(row, mapped)| {
			let mapped = (*mapped)?;
			Some((
				old_starts[row]
					..old_starts
						.get(row + 1)
						.copied()
						.unwrap_or(layout.code.len()),
				*starts.get(mapped)?..starts.get(mapped + 1).copied().unwrap_or(source.len()),
			))
		})
		.collect::<Vec<_>>();
	retained.sort_unstable_by_key(|(_, range)| range.start);
	let gaps = gaps
		.iter()
		.map(|(gap, rows)| {
			(*gap, starts[rows.start]..starts.get(rows.end).copied().unwrap_or(source.len()))
		})
		.collect::<Vec<_>>();
	let inserted = inserted
		.iter()
		.map(|rows| starts[rows.start]..starts.get(rows.end).copied().unwrap_or(source.len()))
		.collect::<Vec<_>>();
	if let Some(outcome) = index
		.fixed_insertions(source, &mapping, &gaps, &inserted, &retained)
		.map_err(|error| refusal(&error.to_string()))?
	{
		insertion_result(outcome, layout.path)?;
	}
	Ok(())
}

/// Immutable evidence and row identities for each sequential edit.
struct Evidence {
	text: String,
	rows: Vec<usize>,
	hunk: usize,
}

struct Consumption {
	rows:        Vec<usize>,
	next_row:    usize,
	history:     Vec<Evidence>,
	changed_by:  HashMap<usize, usize>,
	writers:     HashMap<usize, Arc<HashSet<usize>>>,
	hunk_offset: usize,
}

/// The best identities and their writers, computed once for a snapshot
/// and hunk rather than once for every ambiguous current placement.
struct EvidencePolicy {
	surviving: HashSet<Vec<usize>>,
	touching:  HashSet<usize>,
	/// Unchanged rows from partially consumed best placements.
	stable:    HashSet<usize>,
	tier:      u8,
}

impl Consumption {
	fn new(original: &str) -> Self {
		let count = patch_rows(original).count();
		Self {
			rows:        (0..count).collect(),
			next_row:    count,
			history:     Vec::new(),
			changed_by:  HashMap::new(),
			writers:     HashMap::new(),
			hunk_offset: 0,
		}
	}

	fn remember(&mut self, text: &str) {
		self.history.push(Evidence {
			text: text.to_owned(),
			rows: self.rows.clone(),
			hunk: self.hunk_offset + 1,
		});
	}

	fn reset(&mut self, text: &str) {
		self.history.clear();
		self.changed_by.clear();
		self.writers.clear();
		self.rows = (0..patch_rows(text).count()).collect();
		self.next_row = self.rows.len();
	}

	fn origin_snapshot(&self, origins: impl Iterator<Item = RowOrigin>) -> OriginSnapshot {
		let mut snapshot = HashMap::new();
		for origin in origins {
			if let RowOrigin::Retained(row) | RowOrigin::Moved(row) | RowOrigin::Rewritten(row) =
				origin
			{
				snapshot.entry(row).or_insert_with(|| {
					let id = self.rows[row];
					(id, self.writers.get(&id).cloned())
				});
			}
		}
		snapshot
	}

	fn splice(
		&mut self,
		at: usize,
		removed: usize,
		origins: &[RowOrigin],
		hunk: usize,
		snapshot: &OriginSnapshot,
	) {
		let writer = self.hunk_offset + hunk;
		let retained = origins
			.iter()
			.filter_map(|origin| match origin {
				RowOrigin::Retained(row) => Some(snapshot[row].0),
				_ => None,
			})
			.collect::<HashSet<_>>();
		for &id in &self.rows[at..at + removed] {
			if !retained.contains(&id) {
				self.changed_by.insert(id, writer);
			}
			self.writers.remove(&id);
		}
		let mut ids = Vec::with_capacity(origins.len());
		for origin in origins {
			if let RowOrigin::Retained(row) = origin {
				let (id, lineage) = &snapshot[row];
				ids.push(*id);
				if let Some(lineage) = lineage {
					self.writers.insert(*id, Arc::clone(lineage));
				}
				continue;
			}
			let id = self.next_row;
			self.next_row += 1;
			let mut lineage = match origin {
				RowOrigin::Moved(row) | RowOrigin::Rewritten(row) => snapshot[row].1.clone(),
				_ => None,
			}
			.unwrap_or_else(|| Arc::new(HashSet::new()));
			Arc::make_mut(&mut lineage).insert(writer);
			self.writers.insert(id, lineage);
			ids.push(id);
		}
		self.rows.splice(at..at + removed, ids);
	}

	fn resize(&mut self, count: usize, hunk: usize) {
		let at = count.min(self.rows.len());
		let removed = self.rows.len() - at;
		let origins = vec![RowOrigin::Inserted; count - at];
		self.splice(at, removed, &origins, hunk, &HashMap::new());
	}

	fn evidence_policy(
		&self,
		evidence: &Evidence,
		best: impl Iterator<Item = usize> + Clone,
		offsets: &[usize],
		tier: u8,
	) -> EvidencePolicy {
		let surviving = best
			.clone()
			.filter_map(|start| {
				let ids = offsets
					.iter()
					.map(|&row| evidence.rows.get(start + row).copied())
					.collect::<Option<Vec<_>>>()?;
				// Removed identities are never reused within this history.
				ids.iter()
					.all(|id| !self.changed_by.contains_key(id))
					.then_some(ids)
			})
			.collect::<HashSet<_>>();
		let mut touching = HashSet::new();
		let mut stable = HashSet::new();
		if surviving.is_empty() {
			for start in best {
				for &row in offsets {
					if let Some(id) = evidence.rows.get(start + row) {
						if let Some(writer) = self.changed_by.get(id) {
							touching.insert(*writer);
						} else {
							stable.insert(*id);
						}
					}
				}
			}
		}
		EvidencePolicy { surviving, touching, stable, tier }
	}

	/// Unchanged best evidence wins. Otherwise an equally strict placement
	/// may edit written output, but never inherit an untouched loose copy.
	fn permits(&self, policy: &EvidencePolicy, ids: &[usize], current_tier: u8) -> bool {
		if current_tier > policy.tier {
			return false;
		}
		if !policy.surviving.is_empty() {
			return policy.surviving.contains(ids);
		}
		let mut written = false;
		!ids.is_empty()
			&& ids.iter().all(|id| {
				if policy.stable.contains(id) {
					return true;
				}
				let local = self
					.writers
					.get(id)
					.is_some_and(|writers| !writers.is_disjoint(&policy.touching));
				written |= local;
				local
			})
			&& written
	}

	fn check_character(
		&self,
		path: &str,
		old_text: &str,
		threshold: f64,
		allow_fuzzy: bool,
		current: &MatchOutcome,
	) -> Result<(), EditError> {
		let mut searches = HashMap::new();
		for evidence in &self.history {
			let old = searches
				.entry(evidence.text.as_str())
				.or_insert_with(|| character_search(&evidence.text, old_text, threshold, allow_fuzzy));
			let best = old.occurrence_lines.as_ref().map_or_else(
				|| {
					old.matched
						.as_ref()
						.map_or_else(Vec::new, |found| vec![found.start_line as usize - 1])
				},
				|rows| rows.iter().map(|row| *row as usize - 1).collect::<Vec<_>>(),
			);
			if best.is_empty() {
				continue;
			}
			let old_exact = old.occurrences.is_some()
				|| old
					.matched
					.as_ref()
					.is_some_and(|found| found.actual_text == old_text);
			let old_count = old.matched.as_ref().map_or_else(
				|| patch_rows(old_text).count(),
				|found| patch_rows(&found.actual_text).count(),
			);
			let Some(found) = current.matched.as_ref() else {
				continue;
			};
			let start = found.start_line as usize - 1;
			let end = (start + patch_rows(&found.actual_text).count()).min(self.rows.len());
			// A single historical row has exactly the same policy without
			// allocating surviving/touching/stable sets.
			if best.len() == 1 && old_count == 1 && end == start + 1 {
				let old_id = evidence.rows[best[0]];
				let id = self.rows[start];
				let strict_enough = !old_exact || found.actual_text == old_text;
				let permitted = self.changed_by.get(&old_id).map_or(id == old_id, |writer| {
					self
						.writers
						.get(&id)
						.is_some_and(|lineage| lineage.contains(writer))
				});
				if !strict_enough || !permitted {
					return Err(consumed_error(path, self.hunk_offset + 1, best[0], evidence.hunk));
				}
				continue;
			}
			let policy = self.evidence_policy(
				evidence,
				best.iter().copied(),
				&(0..old_count).collect::<Vec<_>>(),
				if old_exact { 0 } else { 7 },
			);
			if !self.permits(
				&policy,
				&self.rows[start..end],
				if found.actual_text == old_text { 0 } else { 7 },
			) {
				return Err(consumed_error(path, self.hunk_offset + 1, best[0], evidence.hunk));
			}
		}
		Ok(())
	}

	fn constrain_anchor(
		&self,
		current_layout: &Layout<'_>,
		hunk: &DiffHunk,
		position: usize,
		current: Option<&AnchorLookup>,
		allow_fuzzy: bool,
	) -> Result<(), EditError> {
		let Some(context) = hunk.change_context.as_deref() else {
			return Ok(());
		};
		let Some(current) = current.filter(|lookup| matches!(lookup.outcome, AnchorOutcome::Found))
		else {
			return Ok(());
		};
		let Some(anchor) = current.scope.as_ref() else {
			return Ok(());
		};
		let current_parts = anchor_text(context, current);
		for evidence in &self.history {
			let lines = patch_rows(&evidence.text).collect::<Vec<_>>();
			let layout = Layout::new(&lines, current_layout.path, &evidence.text);
			let raw = Hints::of(hunk).raw;
			let mapped = raw
				.and_then(|row| self.rows.get(row))
				.and_then(|id| evidence.rows.iter().position(|old_id| old_id == id));
			let old = find_hierarchical_context(
				&layout,
				context,
				Hints { raw: mapped },
				allow_fuzzy,
				&[],
				true,
			);
			let use_current = matches!(old.outcome, AnchorOutcome::Missing) && old.scope.is_none();
			let old_parts = (!use_current).then(|| anchor_text(context, &old));
			let parts = old_parts.as_deref().unwrap_or(current_parts.as_slice());
			let prefix = old
				.scope
				.as_ref()
				.map_or(&[][..], |scope| scope.parts.as_slice());
			let mut parents = None;
			for (depth, part) in parts.iter().enumerate() {
				let current_part = depth.min(anchor.parts.len() - 1);
				// An explicit current hint can name a newly born row. Its
				// surviving anchor ancestor still maps the intended region.
				let hinted = mapped.or_else(|| {
					raw.and_then(|_| {
						self
							.rows
							.get(anchor.parts[current_part].0)
							.and_then(|id| evidence.rows.iter().position(|old_id| old_id == id))
					})
				});
				let forced = prefix.get(depth).map(|&(row, _)| row);
				let (best, rank) = anchor_successors(
					&layout,
					part,
					parents.as_deref(),
					forced,
					Hints { raw: hinted },
					allow_fuzzy,
				);
				let range = if parts.len() == 1 {
					0..anchor.parts.len()
				} else {
					current_part..current_part + 1
				};
				let policy =
					self.evidence_policy(evidence, best.iter().map(|&(row, _)| row), &[0], rank);
				for index in range {
					let (row, current_rank) = anchor.parts[index];
					if best.is_empty() {
						if current_rank > rank {
							return Err(EditError::apply(format!(
								"Hunk #{}'s insertion in {} cannot inherit weaker anchor evidence from an \
								 earlier edit; add context from the intended position.",
								position + self.hunk_offset + 1,
								current_layout.path,
							)));
						}
					} else if self
						.rows
						.get(row)
						.is_none_or(|id| !self.permits(&policy, std::slice::from_ref(id), current_rank))
					{
						return Err(consumed_error(
							current_layout.path,
							position + self.hunk_offset + 1,
							best[0].0,
							evidence.hunk,
						));
					}
				}
				parents = Some(best);
			}
		}
		Ok(())
	}

	fn constrain(
		&self,
		current_layout: &Layout<'_>,
		hunk: &DiffHunk,
		position: usize,
		current: &mut PlacedHunk,
		allow_fuzzy: bool,
	) -> Result<(), EditError> {
		if hunk.old_lines.is_empty() {
			return Ok(());
		}
		let path = current_layout.path;
		for evidence in &self.history {
			let lines = patch_rows(&evidence.text).collect::<Vec<_>>();
			let layout = Layout::new(&lines, path, &evidence.text);
			// A sequential hint names current text, not the pre-edit row number.
			// Map its identity back; a newly inserted hinted row has no old hint.
			let hints = Hints {
				raw: Hints::of(hunk)
					.raw
					.and_then(|row| self.rows.get(row))
					.and_then(|id| evidence.rows.iter().position(|old_id| old_id == id)),
			};
			let lookup = hunk.change_context.as_deref().map(|context| {
				find_hierarchical_context(&layout, context, hints, allow_fuzzy, &hunk.old_lines, false)
			});
			let target = lookup
				.as_ref()
				.map_or_else(Target::default, |lookup| Target {
					anchor: lookup.scope.as_ref(),
					proof:  lookup.proof.as_deref(),
				});
			let old = place_hunk(&lines, hunk, target, &[], hints, allow_fuzzy);
			let best = old
				.result
				.top_indices
				.as_ref()
				.or(old.result.match_indices.as_ref())
				.cloned()
				.unwrap_or_else(|| old.result.index.into_iter().collect());
			if best.is_empty() {
				continue;
			}
			let old_offsets = evidence_offsets(hunk, &old.view);
			let offsets = evidence_offsets(hunk, &current.view);
			let candidates = current
				.result
				.match_indices
				.clone()
				.unwrap_or_else(|| current.result.index.into_iter().collect());
			let policy = self.evidence_policy(
				evidence,
				best.iter().copied(),
				&old_offsets,
				tier(old.result.strategy),
			);
			let mut ids = Vec::with_capacity(offsets.len());
			let kept = candidates
				.iter()
				.copied()
				.filter(|&at| {
					ids.clear();
					ids.extend(
						offsets
							.iter()
							.filter_map(|&row| self.rows.get(at + row))
							.copied(),
					);
					self.permits(&policy, &ids, tier(current.result.strategy))
				})
				.collect::<Vec<_>>();
			if !candidates.is_empty() && kept.is_empty() {
				return Err(consumed_error(
					path,
					position + self.hunk_offset + 1,
					best[0],
					evidence.hunk,
				));
			}
			current.result.index = kept.first().copied();
			current.result.match_count = Some(kept.len());
			if let Some(top) = current.result.top_indices.as_mut() {
				let kept_set = kept.iter().copied().collect::<HashSet<_>>();
				top.retain(|at| kept_set.contains(at));
				if top.is_empty() {
					return Err(consumed_error(
						path,
						position + self.hunk_offset + 1,
						best[0],
						evidence.hunk,
					));
				}
			}
			current.result.match_indices = Some(kept);
		}
		Ok(())
	}
}

fn consumed_error(path: &str, hunk: usize, line: usize, previous: usize) -> EditError {
	EditError::apply(format!(
		"Hunk #{hunk}'s best evidence in {path}, original line {}, was changed by hunk #{previous}; \
		 this placement neither retains an unchanged best match nor edits equally strict written \
		 output. Copy the intended line exactly into the hunk, or add context lines.",
		line + 1,
	))
}

fn preserve_final_newline(text: &mut String, had_newline: bool) {
	if had_newline && !text.is_empty() && !text.ends_with('\n') {
		text.push('\n');
	} else if !had_newline {
		text.truncate(text.trim_end_matches('\n').len());
	}
}

fn apply_hunks(
	content: &str,
	path: &str,
	hunks: &[DiffHunk],
	threshold: f64,
	allow_fuzzy: bool,
	mut record: Option<&mut Consumption>,
) -> Result<(String, Vec<String>), EditError> {
	let had_newline = content.ends_with('\n');
	if hunks.len() == 1 {
		let hunk = &hunks[0];
		if hunk.change_context.is_none()
			&& !hunk.has_context_lines
			&& !hunk.old_lines.is_empty()
			&& hunk.old_start_line.is_none()
			&& !hunk.is_end_of_file
		{
			return character_match(content, path, hunk, threshold, allow_fuzzy, record);
		}
	}
	let lines = patch_rows(content).collect::<Vec<_>>();
	let (replacements, warnings) =
		compute_replacements(content, &lines, path, hunks, allow_fuzzy, record.as_deref())?;
	if !replacements.is_empty()
		&& let Some(record) = record.as_mut()
	{
		record.remember(content);
	}
	let snapshot = record.as_ref().map_or_else(HashMap::new, |record| {
		record.origin_snapshot(
			replacements
				.iter()
				.flat_map(|atom| atom.origins.iter().copied()),
		)
	});
	let mut result = lines.into_iter().map(str::to_owned).collect::<Vec<_>>();
	for replacement in replacements.iter().rev() {
		if let Some(record) = record.as_mut() {
			record.splice(
				replacement.start_index,
				replacement.old_len,
				&replacement.origins,
				replacement.hunk,
				&snapshot,
			);
		}
		result.splice(
			replacement.start_index..replacement.start_index + replacement.old_len,
			replacement.new_lines.clone(),
		);
	}
	if had_newline && !result.is_empty() {
		result.push(String::new());
	}
	let mut next = result.join("\n");
	preserve_final_newline(&mut next, had_newline);
	if let Some(record) = record {
		record.resize(
			patch_rows(&next).count(),
			replacements
				.last()
				.map_or(1, |replacement| replacement.hunk),
		);
	}
	Ok((next, warnings))
}

fn validate_rename(
	input: &PatchInput<'_>,
	source: &Resolved,
	files: &mut dyn FileSource,
) -> Result<Option<Resolved>, EditError> {
	let Some(rename) = input.rename else {
		return Ok(None);
	};
	let destination = files.resolve(rename, false)?;
	if destination.absolute == source.absolute {
		return Err(EditError::apply("rename path is the same as source path"));
	}
	if files.exists(&destination.absolute) {
		return Err(EditError::apply(format!(
			"Cannot rename {} to {rename}: destination already exists.",
			input.path
		)));
	}
	Ok(Some(destination))
}

const fn engine_op(op: Operation) -> FileOp {
	match op {
		Operation::Create => FileOp::Create,
		Operation::Delete => FileOp::Delete,
		Operation::Update => FileOp::Update,
	}
}

fn stage_from_parts(
	input: &PatchInput<'_>,
	resolved: Resolved,
	read: Option<Arc<FileRead>>,
	after: Option<String>,
	warnings: Vec<String>,
	move_to: Option<Resolved>,
	use_new_encoding: bool,
) -> Result<StagedFile, EditError> {
	let before = read
		.as_ref()
		.map_or_else(String::new, |value| value.text.clone());
	let comparison_after = after.as_deref().unwrap_or("");
	let source_path = move_to
		.as_ref()
		.map_or(input.path, |value| value.display.as_str());
	// Both renderings come from one Myers run over the same line tokens.
	let source =
		BlockContextSource { path: Some(source_path), lang: None, streaming: false };
	let line_diff = LineDiff::new(&before, comparison_after);
	let unified = line_diff.unified(None, &source);
	let preview = line_diff.numbered(None, &source);
	let op = engine_op(input.op);
	let persisted = match after.as_deref() {
		Some(text) if use_new_encoding || read.is_none() => Some(persist_new(&resolved, text)?),
		Some(text) => Some(read.as_ref().unwrap().persist(text)?),
		None => None,
	};
	let mut staged = StagedFile::new(resolved.display.clone(), resolved.absolute, op);
	staged.move_to = move_to;
	staged.existed = read.is_some();
	staged.before_raw = read.as_ref().map(|value| value.raw.clone());
	staged.before = before;
	staged.after = after.unwrap_or_else(|| staged.before.clone());
	staged.persisted = persisted;
	staged.diff = unified.diff;
	staged.preview_diff = Some(preview.diff);
	staged.first_changed_line = unified.first_changed_line;
	staged.header = HeaderKind::Path;
	staged.warnings = warnings;
	Ok(staged)
}

/// One patch entry resolved and applied in memory, before it is staged or
/// previewed.
struct AppliedEntry {
	resolved:         Resolved,
	read:             Option<Arc<FileRead>>,
	after:            Option<String>,
	warnings:         Vec<String>,
	move_to:          Option<Resolved>,
	use_new_encoding: bool,
	/// The target exists but could not be decoded; a delete needs no text.
	undecodable:      bool,
}

fn apply_entry(
	input: &PatchInput<'_>,
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
	allow_create_overwrite: bool,
) -> Result<AppliedEntry, EditError> {
	let must_exist = input.op != Operation::Create;
	let resolved = files.resolve(input.path, must_exist)?;
	let move_to = validate_rename(input, &resolved, files)?;
	match input.op {
		Operation::Create => {
			let diff = input
				.diff
				.ok_or_else(|| EditError::apply("Create operation requires diff (file content)"))?;
			// Existence must not decode, but the generated-file guard must
			// still run: an undecodable file still exists, and a generated
			// one still rejects on overwrite. try_read runs the guard before
			// decoding, so only the undecodable-target error means it passed.
			match files.try_read(&resolved) {
				Ok(read) => {
					if read.is_some() && !allow_create_overwrite {
						return Err(EditError::apply(format!(
							"Cannot create {}: file already exists. Use *** Update File to modify it in \
							 place.",
							input.path
						)));
					}
				},
				Err(err) if err.is_invalid_utf8() => {
					if !allow_create_overwrite {
						return Err(EditError::apply(format!(
							"Cannot create {}: file already exists. Use *** Update File to modify it in \
							 place.",
							input.path
						)));
					}
				},
				Err(err) => return Err(err),
			}
			let normalized = normalize_create_content(diff);
			let content = if normalized.ends_with('\n') {
				normalized
			} else {
				format!("{normalized}\n")
			};
			Ok(AppliedEntry {
				resolved,
				read: None,
				after: Some(content),
				warnings: Vec::new(),
				move_to: None,
				use_new_encoding: true,
				undecodable: false,
			})
		},
		Operation::Delete => {
			match files.try_read(&resolved) {
				Ok(Some(read)) => Ok(AppliedEntry {
					resolved:         read.resolved.clone(),
					read:             Some(read),
					after:            None,
					warnings:         Vec::new(),
					move_to:          None,
					use_new_encoding: false,
					undecodable:      false,
				}),
				Ok(None) => Err(EditError::apply(format!("File not found: {}", resolved.display))),
				// Deleting needs existence, not text: the failed read already
				// proved the file exists.
				Err(err) if err.is_invalid_utf8() => Ok(AppliedEntry {
					resolved,
					read: None,
					after: None,
					warnings: Vec::new(),
					move_to: None,
					use_new_encoding: false,
					undecodable: true,
				}),
				Err(err) => Err(err),
			}
		},
		Operation::Update => {
			let diff = input
				.diff
				.ok_or_else(|| EditError::apply("Update operation requires diff (hunks)"))?;
			let read = files.read(input.path)?;
			let hunks = parse_diff_hunks(diff)?;
			if hunks.is_empty() {
				return Err(EditError::apply("Diff contains no hunks"));
			}
			let (after, warnings) =
				apply_hunks(&read.text, input.path, &hunks, threshold, allow_fuzzy, None)?;
			Ok(AppliedEntry {
				resolved: read.resolved.clone(),
				read: Some(read),
				after: Some(after),
				warnings,
				move_to,
				use_new_encoding: false,
				undecodable: false,
			})
		},
	}
}

/// Stage one patch entry without writing to disk.
pub fn stage_patch(
	input: PatchInput<'_>,
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
	allow_create_overwrite: bool,
) -> Result<StagedFile, EditError> {
	let entry = apply_entry(&input, files, allow_fuzzy, threshold, allow_create_overwrite)?;
	let mut staged = stage_from_parts(
		&input,
		entry.resolved,
		entry.read,
		entry.after,
		entry.warnings,
		entry.move_to,
		entry.use_new_encoding,
	)?;
	staged.existed |= entry.undecodable;
	Ok(staged)
}

/// Preview one patch entry, returning its error as model-facing text.
/// `streaming` skips block context while arguments are still arriving.
pub fn preview_patch(
	input: PatchInput<'_>,
	files: &mut dyn FileSource,
	allow_fuzzy: bool,
	threshold: f64,
	allow_create_overwrite: bool,
	streaming: bool,
) -> PreviewFile {
	let display = input.path.to_owned();
	let rename = input.rename.map(str::to_owned);
	match apply_entry(&input, files, allow_fuzzy, threshold, allow_create_overwrite)
		.and_then(|entry| preview_entry(&input, entry, streaming))
	{
		Ok(preview) => preview,
		Err(error) => {
			PreviewFile { display, error: Some(error.to_string()), rename, ..PreviewFile::default() }
		},
	}
}

/// The part of [`stage_from_parts`] a preview shows: the numbered diff, plus
/// the persist step only where it can fail (notebook re-serialization).
fn preview_entry(
	input: &PatchInput<'_>,
	entry: AppliedEntry,
	streaming: bool,
) -> Result<PreviewFile, EditError> {
	if let Some(text) = entry.after.as_deref() {
		match &entry.read {
			Some(read) if !entry.use_new_encoding => {
				if read.is_notebook {
					read.persist(text)?;
				}
			},
			_ => {
				if is_notebook_path(&entry.resolved.absolute) {
					persist_new(&entry.resolved, text)?;
				}
			},
		}
	}
	let before = entry.read.as_ref().map_or("", |read| read.text.as_str());
	let source_path = entry
		.move_to
		.as_ref()
		.map_or(input.path, |value| value.display.as_str());
	let diff = generate_diff_string(
		before,
		entry.after.as_deref().unwrap_or(""),
		None,
		&BlockContextSource { path: Some(source_path), lang: None, streaming },
	);
	Ok(PreviewFile {
		display:            entry.resolved.display,
		diff:               Some(diff.diff),
		first_changed_line: diff.first_changed_line,
		error:              None,
		op:                 Some(engine_op(input.op)),
		rename:             entry.move_to.map(|value| value.display),
	})
}

fn entry_input<'a>(path: &'a str, entry: &'a EditEntry) -> Result<PatchInput<'a>, EditError> {
	Ok(PatchInput {
		path,
		op: Operation::parse(entry.op.as_deref())?,
		rename: entry.rename.as_deref(),
		diff: entry.diff.as_deref(),
	})
}

impl ModeEngine for PatchEngine {
	fn mode(&self) -> EditMode {
		EditMode::Patch
	}

	fn preview(
		&self,
		args: &ArgSnapshot,
		streaming: bool,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Vec<PreviewFile> {
		let Some(path) = args.path.as_deref() else {
			return Vec::new();
		};
		let Some(entry) = args.edits.iter().find(|entry| !streaming || entry.closed) else {
			return Vec::new();
		};
		match entry_input(path, entry) {
			Ok(input) => {
				vec![preview_patch(
					input,
					files,
					self.allow_fuzzy,
					self.fuzzy_threshold,
					true,
					streaming,
				)]
			},
			Err(error) => vec![PreviewFile {
				display: path.to_owned(),
				error: Some(error.to_string()),
				..PreviewFile::default()
			}],
		}
	}

	fn stage(
		&self,
		args: &ArgSnapshot,
		files: &mut dyn FileSource,
		_store: &EditStore,
	) -> Result<Vec<StagedFile>, EditError> {
		let path = args
			.path
			.as_deref()
			.ok_or_else(|| EditError::parse("Patch path is required"))?;
		let entries = args
			.edits
			.iter()
			.filter(|entry| entry.closed || args.complete)
			.collect::<Vec<_>>();
		if entries.is_empty() {
			return Err(EditError::apply("No files were modified."));
		}
		if entries.len() == 1 {
			return Ok(vec![stage_patch(
				entry_input(path, entries[0])?,
				files,
				self.allow_fuzzy,
				self.fuzzy_threshold,
				true,
			)?]);
		}

		let first = entry_input(path, entries[0])?;
		let initial_resolved = files.resolve(path, first.op != Operation::Create)?;
		// After a create or delete, later updates use replacement text or fail
		// the existence check; only an initial update needs the original text.
		let needs_content = first.op == Operation::Update;
		let (initial, initially_existed) = match files.try_read(&initial_resolved) {
			Ok(initial) => {
				let existed = initial.is_some();
				(initial, existed)
			},
			Err(err) if err.is_invalid_utf8() && !needs_content => (None, true),
			Err(err) => return Err(err),
		};
		let initial_before = initial
			.as_ref()
			.map_or_else(String::new, |read| read.text.clone());
		let original = initial.as_ref().map_or("", |read| read.text.as_str());
		let mut consumption = Consumption::new(original);
		let mut current = initial_before;
		let mut exists = initially_existed;
		let mut final_op = FileOp::Update;
		let mut warnings = Vec::new();
		let mut move_to = None;
		let mut use_new_encoding = false;
		for entry in entries {
			let input = entry_input(path, entry)?;
			if let Some(rename) = input.rename {
				let destination = files.resolve(rename, false)?;
				if destination.absolute == initial_resolved.absolute {
					return Err(EditError::apply("rename path is the same as source path"));
				}
				if files.exists(&destination.absolute) {
					return Err(EditError::apply(format!(
						"Cannot rename {path} to {rename}: destination already exists."
					)));
				}
				if input.op == Operation::Update {
					move_to = Some(destination);
				}
			}
			match input.op {
				Operation::Create => {
					let diff = input.diff.ok_or_else(|| {
						EditError::apply("Create operation requires diff (file content)")
					})?;
					let normalized = normalize_create_content(diff);
					current = if normalized.ends_with('\n') {
						normalized
					} else {
						format!("{normalized}\n")
					};
					consumption.reset(&current);
					exists = true;
					final_op = FileOp::Create;
					use_new_encoding = true;
				},
				Operation::Delete => {
					if !exists {
						return Err(EditError::apply(format!("File not found: {path}")));
					}
					exists = false;
					final_op = FileOp::Delete;
					consumption.rows.clear();
					consumption.history.clear();
				},
				Operation::Update => {
					if !exists {
						return Err(EditError::apply(format!("File not found: {path}")));
					}
					let diff = input
						.diff
						.ok_or_else(|| EditError::apply("Update operation requires diff (hunks)"))?;
					let hunks = parse_diff_hunks(diff)?;
					if hunks.is_empty() {
						return Err(EditError::apply("Diff contains no hunks"));
					}
					let (next, mut next_warnings) = apply_hunks(
						&current,
						path,
						&hunks,
						self.fuzzy_threshold,
						self.allow_fuzzy,
						Some(&mut consumption),
					)?;
					current = next;
					consumption.hunk_offset += hunks.len();
					warnings.append(&mut next_warnings);
					final_op = FileOp::Update;
				},
			}
		}
		let synthetic = PatchInput {
			path,
			op: match final_op {
				FileOp::Create => Operation::Create,
				FileOp::Delete => Operation::Delete,
				_ => Operation::Update,
			},
			rename: None,
			diff: None,
		};
		let after = exists.then_some(current);
		Ok(vec![{
			let mut staged = stage_from_parts(
				&synthetic,
				initial_resolved,
				initial,
				after,
				warnings,
				move_to,
				use_new_encoding,
			)?;
			if !needs_content && initially_existed {
				// Existence-only sequence on an unreadable file stages without
				// content, but the target did exist.
				staged.existed = true;
			}
			staged
		}])
	}

	fn inspect(&self, args: &ArgSnapshot) -> Inspection {
		let Some(path) = args.path.as_ref().filter(|path| !path.is_empty()) else {
			return Inspection::default();
		};
		let mut digest = None::<String>;
		let mut file_ops = Vec::new();
		for entry in &args.edits {
			if let Some(diff) = &entry.diff {
				// Create bodies may omit `+` prefixes; their digest is then the
				// whole text.
				let added = super::added_lines(diff.split('\n')).unwrap_or_else(|| {
					if entry.op.as_deref() == Some("create") {
						diff.clone()
					} else {
						String::new()
					}
				});
				match &mut digest {
					Some(current) => {
						current.push('\n');
						current.push_str(&added);
					},
					None => digest = Some(added),
				}
			}
			if entry.op.as_deref() == Some("delete") {
				file_ops.push(FileOpIntent::Delete { path: path.clone() });
			}
			if let Some(rename) = &entry.rename
				&& entry.op.as_deref().is_none_or(|op| op == "update")
			{
				file_ops.push(FileOpIntent::Move { from: path.clone(), to: rename.clone() });
			}
		}
		Inspection {
			paths: vec![path.clone()],
			entries: digest.map_or_default(|value| vec![(path.clone(), value)]),
			file_ops,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn inspect_digest_strips_create_prefixes() {
		let inspect = |diff: &str| {
			let args = ArgSnapshot {
				path: Some("a.txt".into()),
				edits: vec![EditEntry {
					op: Some("create".into()),
					diff: Some(diff.into()),
					..EditEntry::default()
				}],
				..ArgSnapshot::default()
			};
			PatchEngine { allow_fuzzy: false, fuzzy_threshold: 0.95 }
				.inspect(&args)
				.entries
		};
		assert_eq!(inspect("+one\n+two"), vec![("a.txt".to_owned(), "one\ntwo".to_owned())]);
		assert_eq!(inspect("one\ntwo"), vec![("a.txt".to_owned(), "one\ntwo".to_owned())]);
	}

	#[test]
	fn trailing_newline_policy_is_preserved() {
		let hunk = DiffHunk {
			change_context:    None,
			old_start_line:    None,
			new_start_line:    None,
			has_context_lines: false,
			context_lines:     Vec::new(),
			old_lines:         vec!["one".into()],
			new_lines:         vec!["two".into()],
			is_end_of_file:    false,
			is_start_of_file:  false,
		};
		assert_eq!(
			apply_hunks("one\n", "a.txt", std::slice::from_ref(&hunk), 0.95, true, None)
				.unwrap()
				.0,
			"two\n"
		);
		assert_eq!(
			apply_hunks("one", "a.txt", &[hunk], 0.95, true, None)
				.unwrap()
				.0,
			"two"
		);
	}
}
