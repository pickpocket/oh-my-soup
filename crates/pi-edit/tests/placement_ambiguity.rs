//! Placement uniqueness: an edit whose target text has more than one equally
//! ranked placement must be refused with zero writes, never applied to
//! whichever placement a scan happens to reach first; a target that is unique
//! within its anchor's block must still apply.

mod common;

use std::{
	fmt::Write as _,
	time::{Duration, Instant},
};

use common::{DiskWriter, Workspace};
use pi_edit::{
	EditMode,
	diff_string::parse_diff_hunks,
	fuzzy::{ReplaceOutcome, ReplaceResult, format_occurrence_error, replace_text, seek_sequence, seek_sequence_within},
};
use serde_json::{Value, json};

const PATH: &str = "target.txt";

fn replaced(result: ReplaceOutcome) -> ReplaceResult {
	match result {
		ReplaceOutcome::Replaced(result) => result,
		ReplaceOutcome::Missed(outcome) => panic!("expected replacement, missed: {outcome:?}"),
	}
}

fn replace_miss(result: ReplaceOutcome) -> String {
	match result {
		ReplaceOutcome::Missed(outcome) => format_occurrence_error("", &outcome),
		ReplaceOutcome::Replaced(result) => panic!("expected missed replacement: {result:?}"),
	}
}

/// Asserts a refused call left the file byte-identical and never reached the
/// writer, and returns the error text.
fn assert_refused(
	workspace: &Workspace,
	writer: &DiskWriter,
	original: &str,
	result: pi_edit::EditResult<pi_edit::ApplyOutcome>,
) -> String {
	assert_refused_at(workspace, writer, PATH, original, result)
}

fn assert_refused_at(
	workspace: &Workspace,
	writer: &DiskWriter,
	path: &str,
	original: &str,
	result: pi_edit::EditResult<pi_edit::ApplyOutcome>,
) -> String {
	let error = result
		.expect_err("ambiguous placement must be refused")
		.to_string();
	assert_eq!(writer.requests.lock().len(), 0, "refused edit reached the writer: {error}");
	assert_eq!(workspace.read(path).as_deref(), Some(original), "refused edit changed the file");
	error
}

/// Runs one JSON tool call that must be refused.
async fn refused(mode: EditMode, original: &str, args: Value) -> String {
	let workspace = Workspace::new(mode);
	workspace.write(PATH, original);
	let writer = DiskWriter::default();
	let result = workspace.apply_json(&args, &writer).await;
	assert_refused(&workspace, &writer, original, result)
}

/// Runs one patch call on `path` (its extension selects the syntax tree)
/// that must be refused.
async fn refused_in(path: &str, original: &str, diff: &str) -> String {
	let workspace = Workspace::new(EditMode::Patch);
	workspace.write(path, original);
	let writer = DiskWriter::default();
	let result = workspace.apply_json(&patch_in(path, diff), &writer).await;
	assert_refused_at(&workspace, &writer, path, original, result)
}

/// Runs one successful call and returns the written file and warnings.
async fn applied_with(mode: EditMode, original: &str, args: Value) -> (String, Vec<String>) {
	applied_at(mode, PATH, original, args).await
}

async fn applied_at(
	mode: EditMode,
	path: &str,
	original: &str,
	args: Value,
) -> (String, Vec<String>) {
	let workspace = Workspace::new(mode);
	workspace.write(path, original);
	let outcome = workspace
		.apply_json(&args, &DiskWriter::default())
		.await
		.unwrap_or_else(|error| panic!("edit refused: {error}"));
	let warnings = outcome
		.files
		.first()
		.map(|file| file.warnings.clone())
		.unwrap_or_default();
	(workspace.read(path).expect("file survives"), warnings)
}

/// Runs one successful patch call and returns the written file and warnings.
async fn applied(original: &str, diff: &str) -> (String, Vec<String>) {
	applied_with(EditMode::Patch, original, patch(diff)).await
}

/// Runs one successful patch call on `path` and returns the written file.
async fn applied_in(path: &str, original: &str, diff: &str) -> String {
	applied_at(EditMode::Patch, path, original, patch_in(path, diff))
		.await
		.0
}

/// Runs two hunks on `path` in both orders, asserts both end alike (the
/// same bytes, or a refusal with zero writes), and returns the first
/// order's written file or refusal.
async fn both_orders(
	path: &str,
	original: &str,
	first: &str,
	second: &str,
) -> Result<String, String> {
	hunk_orders(path, original, [format!("{first}\n{second}"), format!("{second}\n{first}")]).await
}

async fn three_orders(path: &str, original: &str, hunks: [&str; 3]) -> Result<String, String> {
	hunk_orders(
		path,
		original,
		[[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
			.map(|order| order.map(|index| hunks[index]).join("\n")),
	)
	.await
}

async fn hunk_orders(
	path: &str,
	original: &str,
	orders: impl IntoIterator<Item = String>,
) -> Result<String, String> {
	let mut forward = None;
	for diff in orders {
		let workspace = Workspace::new(EditMode::Patch);
		workspace.write(path, original);
		let writer = DiskWriter::default();
		let result = workspace.apply_json(&patch_in(path, &diff), &writer).await;
		let outcome = if result.is_ok() {
			Ok(workspace.read(path).expect("file survives"))
		} else {
			Err(assert_refused_at(&workspace, &writer, path, original, result))
		};
		if let Some(first) = &forward {
			match (first, &outcome) {
				(Ok(one), Ok(other)) => assert_eq!(one, other, "{diff}"),
				(Err(_), Err(_)) => {},
				_ => panic!("hunk order changed the outcome: {first:?} vs {outcome:?}"),
			}
		} else {
			forward = Some(outcome);
		}
	}
	forward.expect("at least one order")
}

fn patch(diff: &str) -> Value {
	patch_in(PATH, diff)
}

fn patch_in(path: &str, diff: &str) -> Value {
	json!({ "path": path, "edits": [{ "op": "update", "diff": diff }] })
}

/// The 1-based candidate lines a refusal lists.
fn listed_lines(error: &str) -> Vec<u32> {
	let (_, rest) = error
		.split_once("start at lines ")
		.expect("refusal lists candidate lines");
	let list = rest.split('.').next().unwrap_or_default();
	list
		.split([',', ' '])
		.filter_map(|item| item.parse().ok())
		.collect()
}

/// The `@@` anchors a refusal suggests.
fn suggested_anchors(error: &str) -> Vec<String> {
	error
		.split("`@@ ")
		.skip(1)
		.filter_map(|item| item.split_once('`').map(|(anchor, _)| anchor.to_owned()))
		.collect()
}

// ---------------------------------------------------------------- replace

/// Overlapping placements are distinct targets: `foo();\nfoo();` sits at line
/// 1 and at line 2 of three identical lines.
#[test]
fn replace_text_counts_overlapping_placements_as_ambiguous() {
	let error = replace_miss(replace_text(
		"foo();\nfoo();\nfoo();\n",
		"foo();\nfoo();",
		"bar();\nfoo();",
		true,
		false,
		None,
	).expect("ambiguous outcome"));
	assert!(error.starts_with("Found 2 occurrences"), "{error}");

	let error = replace_miss(replace_text("aaaa", "aa", "b", false, false, None)
		.expect("ambiguous outcome"));
	assert!(error.starts_with("Found 3 occurrences"), "{error}");

	// `replace_all` keeps its non-overlapping left-to-right semantics.
	let all = replaced(replace_text("aaaa", "aa", "b", false, true, None).expect("replace all"));
	assert_eq!((all.content.as_str(), all.count), ("bb", 2));
}

/// Overlapping occurrences are listed and flagged, so switching to the
/// non-overlapping `replace_all` is not mistaken for the same edit count.
#[tokio::test]
async fn replace_tool_flags_overlapping_occurrences() {
	let error = refused(
		EditMode::Replace,
		"foo();\nfoo();\nfoo();\n",
		json!({ "path": PATH, "old_string": "foo();\nfoo();", "new_string": "bar();" }),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 2], "{error}");
	assert!(error.contains("overlap"), "{error}");
}

/// Counting every overlapping placement stays linear on periodic text.
#[test]
fn replace_text_counts_periodic_placements_in_linear_time() {
	let content = "a".repeat(1_000_000);
	let target = "a".repeat(10_000);
	let started = Instant::now();
	let error = replace_miss(replace_text(&content, &target, "b", false, false, None)
		.expect("ambiguous outcome"));
	assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
	assert!(error.starts_with("Found 990001 occurrences"), "{error}");
}

/// A refusal over thousands of candidates keeps the exact count but lists
/// only a bounded number of lines.
#[test]
fn replace_text_refusal_bounds_its_candidate_list() {
	let error = replace_miss(replace_text(&"x\n".repeat(20_000), "x", "y", false, false, None)
		.expect("ambiguous outcome"));
	assert!(error.starts_with("Found 20000 occurrences"), "{error}");
	assert!(error.len() < 4_000, "refusal is {} bytes", error.len());
}

/// `replace_all` with no exact hit never rewrites several fuzzy windows.
#[tokio::test]
async fn replace_all_refuses_several_fuzzy_candidates() {
	let error = refused(
		EditMode::Replace,
		"let total = compute(a, b);\nx\nlet total = compute( a,b);\n",
		json!({
			"path": PATH,
			"old_string": "let total = compute(a,b);",
			"new_string": "let total = compute(b, a);",
			"replace_all": true,
		}),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 3], "{error}");
}

/// A fuzzy window that differs from `old_string` only by whitespace stands
/// alone when every other window needs clearly more edits; windows that
/// are equally close stay ambiguous.
#[tokio::test]
async fn replace_accepts_a_fuzzy_window_well_ahead_of_the_rest() {
	let original = "let totalValue = computeTotal(items, rate);\nx\nlet totalValue = \
	                computeTotal(itemz, rates);\n";
	let (written, _) = applied_with(
		EditMode::Replace,
		original,
		json!({
			"path": PATH,
			"old_string": "let totalValue  = computeTotal(items,  rate);",
			"new_string": "let totalValue = computeTotal(items, rate) + 1;",
		}),
	)
	.await;
	assert_eq!(
		written,
		"let totalValue = computeTotal(items, rate) + 1;\nx\nlet totalValue = computeTotal(itemz, \
		 rates);\n"
	);

	let error = refused(
		EditMode::Replace,
		"let totalValue = computeTotal(items, rate);\nx\nlet totalValue = computeTotal(items, rate) \
		 ;\n",
		json!({
			"path": PATH,
			"old_string": "let totalValue  = computeTotal(items,  rate) ;;",
			"new_string": "y",
		}),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 3], "{error}");
}

/// The fewest-edits window is not taken when another window scores higher:
/// only the best-scoring window may stand alone.
#[test]
fn replace_text_never_takes_a_lower_scoring_fuzzy_window() {
	let content = "switch (mode) {\n  case 'red':\n    return paint(canvas, palette.primary, \
	               options.opacity, options.blend);\n  case 'rex':\n    return paint(canvas, \
	               palette.primary, options.opacity, options.blendMode);\n}\n";
	let old = "  case 'red':\n    return paint(canvas, palette.primary, options.opacity, \
	           options.blendMode);";
	let new = "  case 'red':\n    return paint(canvas, palette.primary, options.opacity, \
	           options.blendMode ?? 'normal');";
	let outcome = replace_text(content, old, new, true, false, None).expect("match outcome");
	assert!(
		matches!(outcome, ReplaceOutcome::Missed(_)),
	);
}

/// A best window well clear of the runner-up by similarity is accepted even
/// when the error-count band holds both.
#[test]
fn replace_text_accepts_a_best_window_by_the_similarity_gap() {
	let content = "let a = 1;\nconst message = format(template, first, second, third, fourth, \
	               fifty, sixty);\nlet xy = 9;\nconst message = format(template, first, second, \
	               third, fourth, fifth, sixth);\n";
	let old =
		"let a = 1;\nconst message = format(template, first, second, third, fourth, fifth, sixth);";
	let result = replaced(replace_text(content, old, "let a = 2;", true, false, Some(0.85))
		.expect("unique"));
	assert_eq!(
		result.content,
		"let a = 2;\nlet xy = 9;\nconst message = format(template, first, second, third, fourth, \
		 fifth, sixth);\n"
	);
}

// ------------------------------------------------------------ seek_sequence

/// The exact pass reports how many identical placements it saw, so a caller
/// cannot mistake the first of two twins for a unique hit.
#[test]
fn seek_sequence_reports_identical_placements() {
	let lines = ["alpha", "beta", "gamma", "alpha", "beta", ""];
	let found = seek_sequence(&lines, &["alpha", "beta"], 0, false, true);
	assert_eq!(found.match_count, Some(2));
	assert_eq!(found.match_indices, Some(vec![0, 3]));

	// Starting past the first twin leaves a single placement.
	let after = seek_sequence(&lines, &["alpha", "beta"], 1, false, true);
	assert_eq!((after.index, after.match_count), (Some(3), Some(1)));
}

/// An end-of-file hunk inside a scope that stops before EOF is not pinned
/// to the scope's last line.
#[test]
fn seek_sequence_within_ignores_eof_when_the_scope_stops_early() {
	let lines = ["class A:", "    x = 1", "    x = 1", "class B:", "    y = 2"];
	let found = seek_sequence_within(&lines, &["    x = 1"], 1, 3, true, true);
	assert_eq!(found.match_count, Some(2));
}

// --------------------------------------------------------- patch: no anchor

#[tokio::test]
async fn patch_tool_refuses_overlapping_placements_of_a_bare_hunk() {
	let error = refused(
		EditMode::Patch,
		"foo();\nfoo();\nfoo();\n",
		patch("@@\n-foo();\n-foo();\n+bar();\n+foo();"),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 2], "{error}");
}

/// Twin blocks: the refusal names every candidate, and with no more
/// candidates than previews it previews them all.
#[tokio::test]
async fn patch_twin_blocks_are_refused_with_every_candidate() {
	let original = "if ok {\n    run();\n}\n\nif ok {\n    run();\n}\n";
	let error =
		refused(EditMode::Patch, original, patch("@@\n if ok {\n-    run();\n+    stop();")).await;
	assert_eq!(listed_lines(&error), [1, 5], "{error}");
	assert!(!error.contains("showing first"), "{error}");
	// The windows around both candidates share their middle rows, which
	// print once.
	assert_eq!(error.matches("3 | }").count(), 1, "{error}");
	assert_eq!(error.matches("4 | \n").count(), 1, "{error}");
}

/// More candidates than previews: all are listed, five are previewed.
#[tokio::test]
async fn patch_refusal_lists_every_candidate_beyond_the_previews() {
	let original = "if ok {\n    run();\n}\n".repeat(7);
	let error =
		refused(EditMode::Patch, &original, patch("@@\n if ok {\n-    run();\n+    stop();")).await;
	assert_eq!(listed_lines(&error), [1, 4, 7, 10, 13, 16, 19], "{error}");
	assert!(error.contains("showing first 5 of 7"), "{error}");
	// Every displayed candidate row is marked, and the count stands apart
	// from the file's rows.
	let rows = error
		.lines()
		.filter(|line| line.contains(" | if ok {"))
		.collect::<Vec<_>>();
	assert!(!rows.is_empty() && rows.iter().all(|row| row.starts_with('>')), "{error}");
	assert!(
		error
			.lines()
			.all(|line| !line.contains(" | ") || !line.contains("showing")),
		"{error}"
	);
}

/// Placements that are equal only after whitespace normalization rank
/// equally too, at the prefix and at the fuzzy level.
#[tokio::test]
async fn patch_tool_refuses_normalized_twins() {
	let error =
		refused(EditMode::Patch, "foo  bar\nx\nz\nfoo   bar\nx\n", patch("@@\n foo bar\n-x\n+y"))
			.await;
	assert_eq!(listed_lines(&error), [1, 4], "{error}");

	let error = refused(
		EditMode::Patch,
		"let total = compute(a, b);\nreturn total;\nmid\nlet total = compute(a, b);\nreturn total;\n",
		patch("@@\n let total = compute(a,b);\n-return total;\n+return total + 1;"),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 4], "{error}");
}

/// A hunk whose lines occur verbatim twice must not fall back to a reshaped
/// variant (here: its duplicated `q` collapsed) that matches a third region.
#[tokio::test]
async fn patch_tool_does_not_repair_an_ambiguous_hunk_into_another_region() {
	let error = refused(
		EditMode::Patch,
		"p\nq\nq\nr\nz\np\nq\nq\nr\nz\np\nq\nr\n",
		patch("@@\n p\n q\n q\n-r\n+R"),
	)
	.await;
	assert_eq!(listed_lines(&error), [1, 6], "{error}");
}

/// A disjoint earlier hunk cannot discard any copy of another hunk's target.
#[tokio::test]
async fn patch_disjoint_hunk_keeps_every_placement_in_scope() {
	let error = both_orders(PATH, "head\nk\nv\nk\nv\nk\nv\n", "@@\n head\n-k\n+K", "@@\n k\n-v\n+V")
		.await
		.expect_err("three placements");
	assert_eq!(listed_lines(&error), [2, 4, 6], "{error}");
}

/// Every hunk searches the same immutable file, independently of listing order.
#[tokio::test]
async fn patch_disjoint_hunks_count_the_whole_file() {
	let error = both_orders(PATH, "k\nv\nk\nv\nz\nw\n", "@@\n z\n-w\n+W", "@@\n k\n-v\n+V")
		.await
		.expect_err("two placements");
	assert_eq!(listed_lines(&error), [1, 3], "{error}");
	let written = both_orders(PATH, "a\nb\nz\nw\n", "@@\n z\n-w\n+W", "@@\n a\n-b\n+B")
		.await
		.expect("unique disjoint targets");
	assert_eq!(written, "a\nB\nz\nW\n");
}

/// Equal-effect hunks may cover all equivalent placements without assigning
/// different effects to copies by their listing order.
#[tokio::test]
async fn patch_equal_effect_hunks_cover_equivalent_placements() {
	let hunk = "@@\n if ok:\n-    run()\n+    stop()";
	let written = both_orders(PATH, "if ok:\n    run()\nx\nif ok:\n    run()\n", hunk, hunk)
		.await
		.expect("both copies receive the same effect");
	assert_eq!(written, "if ok:\n    stop()\nx\nif ok:\n    stop()\n");
}

/// Context lines keep the file's bytes when the hunk only resembles them;
/// only the removed line is rewritten.
#[tokio::test]
async fn patch_inexact_placement_keeps_file_context_lines() {
	let original = "header\nlet alpha_value = compute_something(1);\nlet beta_value = \
	                compute_something(2);\nlet gamma_value = compute_something(3);\nfooter\n";
	let (written, _) = applied(
		original,
		"@@\n let alpha_value = compute_somthing(1);\n-let beta_value = compute_something(2);\n+let \
		 beta_value = compute_something(20);\n let gamma_value = compute_somthing(3);",
	)
	.await;
	assert_eq!(written, original.replace("something(2)", "something(20)"));
}

// ---------------------------------------------------------- patch: hints

/// The hunk's line hint selects among every repeated placement, not only
/// among the first few recorded ones.
#[tokio::test]
async fn patch_line_hint_selects_a_late_repeated_block() {
	let original = (0..8)
		.map(|index| format!("section {index}\nkey\nvalue\n"))
		.collect::<Vec<_>>()
		.concat();
	let (written, _) = applied(&original, "@@ -20,2 +20,2 @@\n key\n-value\n+VALUE").await;
	assert_eq!(written, original.replacen("section 6\nkey\nvalue", "section 6\nkey\nVALUE", 1));
}

/// A hint that lands on no candidate breaks no tie when several candidates
/// sit near it: line hints are tie-breakers, never placement on their own.
#[tokio::test]
async fn patch_line_hint_between_twins_is_refused() {
	let mut body: Vec<String> = (0..40).map(|index| format!("filler {index}")).collect();
	body[2] = "dup a".into();
	body[3] = "dup b".into();
	body[29] = "dup a".into();
	body[30] = "dup b".into();
	let original = body.join("\n") + "\n";
	let error =
		refused(EditMode::Patch, &original, patch("@@ -4,2 +4,2 @@\n dup a\n-dup b\n+DUP B")).await;
	assert_eq!(listed_lines(&error), [3, 30], "{error}");
}

/// A hint does not move the search start: a context-free hunk hinted
/// between two copies is refused.
#[tokio::test]
async fn patch_hint_does_not_skip_earlier_copies() {
	let error =
		refused(EditMode::Patch, "x = 1\na\nb\nc\nx = 1\n", patch("@@ -2,1 +2,1 @@\n-x = 1\n+x = 2"))
			.await;
	assert_eq!(listed_lines(&error), [1, 5], "{error}");
}

fn numbered_lines(overrides: &[(usize, &str)]) -> String {
	let mut body: Vec<String> = (1..=50).map(|line| format!("line {line}")).collect();
	for (line, text) in overrides {
		(*text).clone_into(&mut body[line - 1]);
	}
	body.join("\n") + "\n"
}

/// A content-derived hint contradiction vetoes a twin; it never places it.
#[tokio::test]
async fn patch_other_hunk_offset_cannot_resolve_a_stale_hint() {
	let body = numbered_lines(&[
		(10, "unique ten"),
		(20, "twin a"),
		(21, "twin b"),
		(40, "twin a"),
		(41, "twin b"),
	]);
	let original = format!("added 1\nadded 2\nadded 3\n{body}");
	both_orders(
		PATH,
		&original,
		"@@ -10,1 +10,1 @@\n-unique ten\n+UNIQUE TEN",
		"@@ -40,2 +40,2 @@\n twin a\n-twin b\n+TWIN B",
	)
	.await
	.expect_err("a shifted hint must not resolve an unbound raw hint");
}

const HINT_FILE: &[(usize, &str)] = &[
	(10, "unique line number ten here"),
	(20, "dup a"),
	(21, "dup b"),
	(40, "dup a"),
	(41, "dup b"),
];

/// Independent content evidence must veto conflicting exact numeric hints.
#[tokio::test]
async fn patch_stale_hint_offset_vetoes_conflicting_raw_hint() {
	let original = numbered_lines(HINT_FILE);
	let error = both_orders(
		PATH,
		&original,
		"@@ -29,2 +29,2 @@\n line 9\n-unique line number ten here\n+UNIQUE TEN",
		"@@ -40,2 +40,2 @@\n dup a\n-dup b\n+DUP B",
	)
	.await
	.expect_err("own and independently shifted hints select different twins");
	assert!(error.contains("20") && error.contains("40"), "{error}");
}

/// Agreement with independently proven offsets leaves the raw hint usable.
#[tokio::test]
async fn patch_agreeing_raw_and_content_derived_hints_apply() {
	let original = numbered_lines(HINT_FILE);
	let written = both_orders(
		PATH,
		&original,
		"@@ -9,2 +9,2 @@\n line 9\n-unique line number ten here\n+UNIQUE TEN",
		"@@ -40,2 +40,2 @@\n dup a\n-dup b\n+DUP B",
	)
	.await
	.expect("both hints select the same twin");
	assert_eq!(
		written,
		original
			.replace("unique line number ten here", "UNIQUE TEN")
			.replacen("dup a\ndup b\nline 42", "dup a\nDUP B\nline 42", 1)
	);

	// A nonzero displacement may still select the same uniquely nearby twin.
	let mut original =
		numbered_lines(&[(10, "unique line number ten here"), (20, "dup a"), (21, "dup b")]);
	for line in 51..440 {
		writeln!(original, "line {line}").unwrap();
	}
	original.push_str("dup a\ndup b\n");
	let written = both_orders(
		PATH,
		&original,
		"@@ -29,2 +29,2 @@\n line 9\n-unique line number ten here\n+UNIQUE TEN",
		"@@ -440,2 +440,2 @@\n dup a\n-dup b\n+DUP B",
	)
	.await
	.expect("raw and shifted hints agree on the distant twin");
	let (head, _) = original.rsplit_once("dup b\n").unwrap();
	assert_eq!(
		written,
		format!("{}DUP B\n", head.replace("unique line number ten here", "UNIQUE TEN"))
	);
}

/// Every independent displacement counts, not just the last listed hunk's.
#[tokio::test]
async fn patch_all_independent_offsets_veto_conflicting_hints() {
	let original = numbered_lines(HINT_FILE);
	three_orders(PATH, &original, [
		"@@ -29,2 +29,2 @@\n line 9\n-unique line number ten here\n+UNIQUE TEN",
		"@@ -29,2 +29,2 @@\n line 29\n-line 30\n+LINE THIRTY",
		"@@ -40,2 +40,2 @@\n dup a\n-dup b\n+DUP B",
	])
	.await
	.expect_err("one contradictory offset vetoes the twin in all six orders");
}

/// Elimination-derived offsets participate in the same symmetric veto as
/// content-unique offsets, including interchangeable equal-effect groups.
#[tokio::test]
async fn patch_elimination_displacements_veto_conflicting_hints() {
	let mut original = numbered_lines(&[(10, "dup a"), (20, "dup a"), (30, "dup b")]);
	for row in 51..=120 {
		if row == 110 {
			original.push_str("dup b\n");
		} else {
			writeln!(original, "line {row}").unwrap();
		}
	}
	let last = "@@ -110,1 +110,1 @@\n-dup b\n+B_LAST";
	for (label, first, replacement, expected) in [
		(
			"content-unique first hunk",
			"@@\n line 9\n-dup a\n+A_FIRST",
			"A_SECOND",
			original
				.replacen("dup a\n", "A_FIRST\n", 1)
				.replacen("dup a\n", "A_SECOND\n", 1),
		),
		(
			"equal-effect candidate pairing",
			"@@ -30,1 +30,1 @@\n-dup a\n+A",
			"A",
			original.replace("dup a\n", "A\n"),
		),
	] {
		let stale = format!("@@ -100,1 +100,1 @@\n-dup a\n+{replacement}");
		let error = three_orders(PATH, &original, [first, &stale, last])
			.await
			.expect_err("elimination-derived displacement conflicts in all six orders");
		assert!(error.contains("30") && error.contains("110"), "{label}: {error}");
		let agreeing = format!("@@ -20,1 +20,1 @@\n-dup a\n+{replacement}");
		let written = three_orders(PATH, &original, [first, &agreeing, last])
			.await
			.unwrap_or_else(|error| panic!("agreeing {label} hints refused: {error}"));
		assert_eq!(written, expected.replace("dup b\nline 111\n", "B_LAST\nline 111\n"), "{label}");
	}
}

/// Numeric hints unused by a resolved insertion anchor still contribute
/// displacement evidence against a different hunk's hinted twin.
#[tokio::test]
async fn patch_anchored_insertion_displacements_veto_conflicting_hints() {
	let mut original = String::new();
	for row in 1..=120 {
		match row {
			10 => original.push_str("unique ten\n"),
			21 | 110 => original.push_str("dup b\n"),
			_ => writeln!(original, "line {row}").unwrap(),
		}
	}
	let last = "@@ -110,1 +110,1 @@\n-dup b\n+B_LAST";
	let error = both_orders(PATH, &original, "@@ -100,0 +100,1 @@ unique ten\n+NEW", last)
		.await
		.expect_err("the anchor's insertion gap contradicts the other hint in both orders");
	assert!(error.contains("21") && error.contains("110"), "{error}");
	let written = both_orders(PATH, &original, "@@ -11,0 +11,1 @@ unique ten\n+NEW", last)
		.await
		.expect("agreeing insertion and replacement hints");
	assert_eq!(
		written,
		original
			.replace("unique ten\n", "unique ten\nNEW\n")
			.replace("dup b\nline 111\n", "B_LAST\nline 111\n")
	);
}

/// Exact internal hierarchy evidence outranks a whole-text prefix distractor.
/// An own hint may resolve the hierarchy, but a zero-offset neighbor must
/// not change the insertion's selected owner.
#[tokio::test]
async fn patch_insertion_uses_its_own_complete_anchor_pipeline() {
	let original = "namespace root child:\n  marker\n  value\nnamespace root child:\n  marker\n  \
	                value\nnamespace root child: markerz\ntail:\n  unique ten\n";
	let insertion = "@@ -3,0 +3,1 @@ namespace root child: marker\n+  NEW";
	let expected = original.replacen("  marker\n", "  marker\n  NEW\n", 1);
	assert_eq!(applied_in("t.yml", original, insertion).await, expected);
	let paired =
		both_orders("t.yml", original, insertion, "@@ -9,1 +9,1 @@\n-  unique ten\n+  UNIQUE TEN")
			.await
			.expect("the exact own-hint hierarchy chooses the same first owner in both orders");
	assert_eq!(paired, expected.replace("  unique ten\n", "  UNIQUE TEN\n"));
}

/// A multiline signature inserts at the body's safe gap, not immediately
/// after the anchor row, so that actual gap supplies the displacement.
#[tokio::test]
async fn patch_insertion_displacements_use_the_final_body_gap() {
	let mut original = String::new();
	for row in 1..=120 {
		match row {
			10 => original.push_str("int sample(\n"),
			11 => original.push_str("    int input\n"),
			12 => original.push_str(")\n"),
			13 => original.push_str("{\n"),
			14 => original.push_str("    return input;\n"),
			15 => original.push_str("}\n"),
			24 | 110 => original.push_str("int b;\n"),
			_ => writeln!(original, "int filler_{row};").unwrap(),
		}
	}
	let last = "@@ -110,1 +110,1 @@\n-int b;\n+int B_LAST;";
	let error =
		both_orders("body.c", &original, "@@ -100,0 +100,1 @@ int sample(\n+    audit();", last)
			.await
			.expect_err("the actual body gap contradicts the other hint in both orders");
	assert!(error.contains("24") && error.contains("110"), "{error}");
	let written =
		both_orders("body.c", &original, "@@ -14,0 +14,1 @@ int sample(\n+    audit();", last)
			.await
			.expect("agreeing body-gap and replacement hints");
	assert_eq!(
		written,
		original
			.replace("    return input;\n", "    audit();\n    return input;\n")
			.replace("int b;\nint filler_111;\n", "int B_LAST;\nint filler_111;\n")
	);
}

/// An explicit EOF marker chooses the canonical boundary independently of
/// its numeric hint, including when that hint lies past the file.
#[tokio::test]
async fn patch_eof_insertion_displacements_veto_conflicting_hints() {
	let mut original = String::new();
	for row in 1..=120 {
		match row {
			11 | 110 => original.push_str("dup b\n"),
			_ => writeln!(original, "line {row}").unwrap(),
		}
	}
	let last = "@@ -110,1 +110,1 @@\n-dup b\n+B_LAST";
	let error = both_orders(PATH, &original, "@@ -220,0 +220,1 @@\n+NEW EOF\n*** End of File", last)
		.await
		.expect_err("the explicit EOF gap contradicts the other hint in both orders");
	let mut has_first = false;
	let mut has_last = false;
	for number in error.split(|ch: char| !ch.is_ascii_digit()) {
		has_first |= number == "11";
		has_last |= number == "110";
	}
	assert!(has_first && has_last, "{error}");
	let written =
		both_orders(PATH, &original, "@@ -121,0 +121,1 @@\n+NEW EOF\n*** End of File", last)
			.await
			.expect("agreeing EOF-boundary and replacement hints");
	assert_eq!(
		written,
		format!("{}NEW EOF\n", original.replace("dup b\nline 111\n", "B_LAST\nline 111\n"))
	);
}

/// Unhinted unique and fuzzy neighbors cannot contradict a raw hint.
#[tokio::test]
async fn patch_raw_hint_survives_unhinted_unique_and_fuzzy_neighbors() {
	let original = numbered_lines(HINT_FILE);
	let target = "@@ -40,2 +40,2 @@\n dup a\n-dup b\n+DUP B";
	let written = three_orders(PATH, &original, [
		"@@\n line 9\n-unique line number ten here\n+UNIQUE TEN",
		"@@\n line 15\n-line 16\n+LINE 16",
		target,
	])
	.await
	.expect("three independent targets");
	let expected = original
		.replace("unique line number ten here", "UNIQUE TEN")
		.replace("line 16\n", "LINE 16\n")
		.replacen("dup a\ndup b\nline 42", "dup a\nDUP B\nline 42", 1);
	assert_eq!(written, expected);
	let written = both_orders(
		PATH,
		&original,
		"@@\n line 9\n-unique line number ten hera\n+UNIQUE TEN",
		target,
	)
	.await
	.expect("fuzzy neighbor leaves the raw hint intact");
	assert_eq!(
		written,
		original
			.replace("unique line number ten here", "UNIQUE TEN")
			.replacen("dup a\ndup b\nline 42", "dup a\nDUP B\nline 42", 1)
	);
}

/// A distant hunk's offset is not evidence for either nearby twin.
#[tokio::test]
async fn patch_distant_hint_offset_cannot_resolve_ambiguous_twins() {
	let original = numbered_lines(&[
		(10, "unique ten"),
		(20, "dup a"),
		(30, "dup a"),
		(40, "dup z"),
		(45, "dup z"),
	]);
	three_orders(PATH, &original, [
		"@@ -7,1 +7,1 @@\n-unique ten\n+UNIQUE TEN",
		"@@ -30,1 +30,1 @@\n-dup a\n+DUP A",
		"@@ -42,1 +42,1 @@\n-dup z\n+DUP Z",
	])
	.await
	.expect_err("a shifted hint must not resolve the unbound twin");
}

/// An explicit top boundary is independent of other hunks' numeric hints.
#[tokio::test]
async fn patch_top_insertion_is_independent_of_numeric_hints() {
	let original = "import os\ndef a():\n    pass\ndef b():\n    pass\ndef main():\n    x = 1\n    \
	                print(x)\n    return x\n";
	let written = both_orders(
		PATH,
		original,
		"@@ -2,3 +2,3 @@\n     x = 1\n-    print(x)\n+    print(x, flush=True)\n     return x",
		"@@ top of file\n+import sys",
	)
	.await
	.expect("explicit top insertion");
	assert_eq!(
		written,
		format!("import sys\n{}", original.replace("print(x)", "print(x, flush=True)"))
	);
}

/// A hint only chooses among the best fuzzy windows: a window overlapping a
/// better one is the same alignment shifted, not another candidate.
#[tokio::test]
async fn patch_hint_never_picks_a_worse_overlapping_fuzzy_window() {
	let original = "header\nlet result_value = compute_something(1);\nlet result_value = \
	                compute_something(2);\nlet result_value = compute_something(3);\nlet \
	                result_value = compute_something(4);\nfooter\n";
	let (written, _) = applied(
		original,
		"@@ -3,3 +3,3 @@\n let result_value = compute_somthing(1);\n-let result_value = \
		 compute_somthing(2);\n+let result_value = compute_something(20);\n let result_value = \
		 compute_somthing(3);",
	)
	.await;
	assert_eq!(written, original.replace("something(2)", "something(20)"));
}

// --------------------------------------------------------- patch: anchors

const TWO_CLASSES: &str = "class A:\n    def f(self):\n        return 1\nclass B:\n    def \
                           f(self):\n        log()\n        return 1\n";

/// An `@@` anchor scopes the hunk to the anchor's block: the same line
/// under another anchor is out of reach, even when the hunk's context only
/// exists there.
#[tokio::test]
async fn patch_anchor_scopes_placement_to_its_block() {
	let written =
		applied_in("t.py", TWO_CLASSES, "@@ class A:\n-        return 1\n+        return 2").await;
	assert_eq!(written, TWO_CLASSES.replacen("return 1", "return 2", 1));

	let written =
		applied_in("t.py", TWO_CLASSES, "@@ class B:\n-        return 1\n+        return 2").await;
	assert_eq!(
		written,
		"class A:\n    def f(self):\n        return 1\nclass B:\n    def f(self):\n        \
		 log()\n        return 2\n"
	);

	refused_in(
		"t.py",
		TWO_CLASSES,
		"@@ class A:\n         log()\n-        return 1\n+        return 2",
	)
	.await;
}

/// Two placements inside one anchor's block are refused with a nested
/// anchor per candidate; resending with a suggestion edits only that one.
#[tokio::test]
async fn patch_ambiguity_under_anchor_suggests_nested_anchors_that_work() {
	let original =
		"def outer():\n    def first():\n        x = 1\n    def second():\n        x = 1\n";
	let error =
		refused_in("t.py", original, "@@ def outer():\n-        x = 1\n+        x = 2").await;
	assert_eq!(listed_lines(&error), [3, 5], "{error}");
	let anchors = suggested_anchors(&error);
	assert_eq!(anchors.len(), 2, "{error}");
	let written = applied_in(
		"t.py",
		original,
		&format!("@@ def outer():\n@@ {}\n-        x = 1\n+        x = 2", anchors[1]),
	)
	.await;
	assert_eq!(
		written,
		"def outer():\n    def first():\n        x = 1\n    def second():\n        x = 2\n"
	);
}

/// A refused bare hunk also gets suggested anchors, and each one, sent as
/// the hunk's header, edits exactly its candidate.
#[tokio::test]
async fn patch_bare_hunk_refusal_suggests_working_anchors() {
	let original = "def a():\n    x = 1\ndef b():\n    x = 1\n";
	let error = refused_in("t.py", original, "-    x = 1\n+    x = 2").await;
	let anchors = suggested_anchors(&error);
	assert_eq!(anchors, ["def a():", "def b():"], "{error}");
	let written =
		applied_in("t.py", original, &format!("@@ {}\n-    x = 1\n+    x = 2", anchors[1])).await;
	assert_eq!(written, "def a():\n    x = 1\ndef b():\n    x = 2\n");
}

/// Anchors resolve independently of another hunk's position.
#[tokio::test]
async fn patch_anchor_resolution_is_independent_of_other_hunks() {
	let original =
		"class K:\n    def f(self):\n        a = 1\n        x = 0\n    def g(self):\n        x = 0\n";
	let written = both_orders(
		"t.py",
		original,
		"@@\n-        a = 1\n+        a = 2",
		"@@ def f(self):\n-        x = 0\n+        x = 9",
	)
	.await
	.expect("distinct changes in one method");
	assert_eq!(
		written,
		"class K:\n    def f(self):\n        a = 2\n        x = 9\n    def g(self):\n        x = 0\n"
	);

	let original = "def a():\n    x = 1\n\ndef b():\n    x = 1\n\ndef c():\n    x = 1\n";
	let written = both_orders(
		"t.py",
		original,
		"@@ def b():\n-    x = 1\n+    x = 2",
		"@@ def a():\n-    x = 1\n+    x = 3",
	)
	.await
	.expect("separate method anchors");
	assert_eq!(written, "def a():\n    x = 3\n\ndef b():\n    x = 2\n\ndef c():\n    x = 1\n");

	let original = "def handler(event):\n    if event.ok:\n        log(ok)\n    save(event)\n    \
	                if event.ok:\n        log(ok)\n    return event\n";
	let written = both_orders("t.py", original,
		"@@ def handler(event):\n def handler(event):\n     if event.ok:\n-        log(ok)\n+        log(first)",
		"@@ def handler(event):\n     if event.ok:\n-        log(ok)\n+        log(second)")
		.await.expect("unique first effect excludes only its changed row");
	assert_eq!(
		written,
		"def handler(event):\n    if event.ok:\n        log(first)\n    save(event)\n    if \
		 event.ok:\n        log(second)\n    return event\n"
	);
}

/// A shifted hint whose nested anchor lies outside its selected parent is
/// no valid alternative, but the same failure on the actual hint refuses.
#[tokio::test]
async fn patch_unusable_shifted_anchor_cannot_veto_valid_placement() {
	let original = "# one\n# two\n# three\ndef outer():\n    marker = 1\n    x = 1\n\ndef \
	                outer():\n    x = 1\n\n# tail\nunique_value = 1\n";
	let unique = "@@ -9,1 +9,1 @@\n-unique_value = 1\n+unique_value = 2";
	let written = both_orders(
		"t.py",
		original,
		unique,
		"@@ -6,1 +6,1 @@ def outer():\n@@ marker = 1\n-    x = 1\n+    x = 2",
	)
	.await
	.expect("the shifted outside-anchor lookup cannot veto the valid first method");
	assert_eq!(
		written,
		original
			.replacen("    x = 1\n", "    x = 2\n", 1)
			.replace("unique_value = 1\n", "unique_value = 2\n")
	);
	let error = both_orders(
		"t.py",
		original,
		unique,
		"@@ -9,1 +9,1 @@ def outer():\n@@ marker = 1\n-    x = 1\n+    x = 2",
	)
	.await
	.expect_err("an actual outside-anchor lookup still refuses in both orders");
	assert!(error.contains("outside"), "{error}");
}

/// A nested anchor found only outside its outer anchor's block refuses,
/// naming where it was found; it never falls back to a looser match inside.
#[tokio::test]
async fn patch_nested_anchor_outside_its_block_is_refused() {
	let error = refused_in(
		"t.py",
		"def outer():\n    marker = 1\n    x = 1\ndef other():\n    x = 1\n",
		"@@ marker = 1\n@@ def outer():\n-    x = 1\n+    x = 2",
	)
	.await;
	assert_eq!(listed_lines(&error), [1], "{error}");

	let error = refused_in(
		"t.py",
		"class A:\n    def f(self):\n        return 1\nclass B:\n    def g(self):\n        return \
		 1\n",
		"@@ class A:\n@@ def g(self):\n-        return 1\n+        return 2",
	)
	.await;
	assert_eq!(listed_lines(&error), [5], "{error}");
}

/// The whole anchor line matched exactly wins over a space-split
/// hierarchy; a Markdown heading's region is its section.
#[tokio::test]
async fn patch_whole_heading_anchor_scopes_its_section() {
	let original = "# Tool\n## Install Instructions\nRun: make install\n## Upgrade \
	                Instructions\nRun: make install\n";
	let written = applied_in(
		"t.md",
		original,
		"@@ ## Install Instructions\n-Run: make install\n+Run: make install PREFIX=/usr",
	)
	.await;
	assert_eq!(written, original.replacen("make install", "make install PREFIX=/usr", 1));
}

/// Anchors precede their hunks: a repeated anchor after the hunk's expected
/// line is not a candidate.
#[tokio::test]
async fn patch_anchor_after_the_hint_is_not_a_candidate() {
	let mut lines = vec!["def run():".to_owned()];
	lines.extend((0..239).map(|index| format!("    a{index} = {index}")));
	lines.push("    y = 0".to_owned());
	lines.extend((0..58).map(|index| format!("    b{index} = {index}")));
	lines.push("def run():".to_owned());
	lines.push("    y = 0".to_owned());
	let original = lines.join("\n") + "\n";
	let (written, _) =
		applied(&original, "@@ -241,1 +241,1 @@ def run():\n-    y = 0\n+    y = 1").await;
	let written: Vec<&str> = written.lines().collect();
	assert_eq!((written[240], written[300]), ("    y = 1", "    y = 0"));
}

/// A column-0 directive inside a function does not end its region, so a
/// second copy later in the same function is counted.
#[tokio::test]
async fn patch_anchor_region_does_not_stop_at_a_directive() {
	refused_in(
		"t.c",
		"int setup(void) {\n    int rc = open_db();\n    if (rc != 0)\n        return rc;\n#ifdef \
		 CACHE\n    rc = open_cache();\n    if (rc != 0)\n        return rc;\n#endif\n    return \
		 0;\n}\n",
		"@@ int setup(void) {\n     if (rc != 0)\n-        return rc;\n+        return -rc;",
	)
	.await;
}

/// End-of-file hunks under an anchor whose block stops before EOF are not
/// pinned to the block's last line, in patch and `apply_patch` form.
#[tokio::test]
async fn patch_scoped_end_of_file_hunk_is_still_counted() {
	let original = "class A:\n    x = 1\n    x = 1\nclass B:\n    y = 2\n";
	refused_in("t.py", original, "@@ class A:\n-    x = 1\n+    x = 9\n*** End of File").await;

	let workspace = Workspace::new(EditMode::ApplyPatch);
	workspace.write("t.py", original);
	let writer = DiskWriter::default();
	let result = workspace
		.apply_raw(
			"*** Begin Patch\n*** Update File: t.py\n@@ class A:\n-    x = 1\n+    x = 9\n*** End of \
			 File\n*** End Patch\n",
			&writer,
		)
		.await;
	assert_refused_at(&workspace, &writer, "t.py", original, result);
}

/// An anchored pure insertion lands at the top of the anchor's body.
#[tokio::test]
async fn patch_anchored_insertion_lands_after_the_anchor() {
	let written = applied_in(
		"t.js",
		"function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}\n",
		"@@ function bar() {\n+  console.log('x');",
	)
	.await;
	assert_eq!(
		written,
		"function foo() {\n  return 1;\n}\nfunction bar() {\n  console.log('x');\n  return 2;\n}\n"
	);
}

/// Block shapes whose target is unique inside the anchor's true region:
/// multi-line signatures, Allman braces, flat `[section]` anchors, markup
/// closers, and hunks that contain the anchor line itself.
#[tokio::test]
async fn patch_anchor_regions_follow_common_block_shapes() {
	let cases: [(&str, &str, &str, &str); 8] = [
		(
			"t.rs",
			"fn f(\n\ta: u32,\n) -> u32 {\n\ta + 1\n}\nfn g() -> u32 {\n\ta + 1\n}\n",
			"@@ fn f(\n-\ta + 1\n+\ta + 2",
			"fn f(\n\ta: u32,\n) -> u32 {\n\ta + 2\n}\nfn g() -> u32 {\n\ta + 1\n}\n",
		),
		(
			"t.py",
			"def f(\n    a,\n):\n    return a\ndef g():\n    return a\n",
			"@@ def f(\n-    return a\n+    return a + 1",
			"def f(\n    a,\n):\n    return a + 1\ndef g():\n    return a\n",
		),
		(
			"t.cs",
			"class A\n{\n    void F()\n    {\n        x = 1;\n    }\n    void G()\n    {\n        x = \
			 1;\n    }\n}\n",
			"@@ void F()\n-        x = 1;\n+        x = 2;",
			"class A\n{\n    void F()\n    {\n        x = 2;\n    }\n    void G()\n    {\n        x = \
			 1;\n    }\n}\n",
		),
		(
			"t.toml",
			"[dependencies]\nserde = 1.0\n[dev-dependencies]\nserde = 1.0\n",
			"@@ [dependencies]\n-serde = 1.0\n+serde = 2.0",
			"[dependencies]\nserde = 2.0\n[dev-dependencies]\nserde = 1.0\n",
		),
		(
			"t.html",
			"<nav>\n  <a>x</a>\n</nav>\n<main>\n</nav>\n",
			"@@ <nav>\n+  <a>new</a>\n </nav>",
			"<nav>\n  <a>x</a>\n  <a>new</a>\n</nav>\n<main>\n</nav>\n",
		),
		(
			"t.rs",
			"fn a() {\n    if x {\n        y();\n    } // done\n    if z {\n        y();\n    }\n}\n",
			"@@     if x {\n-        y();\n+        z();",
			"fn a() {\n    if x {\n        z();\n    } // done\n    if z {\n        y();\n    }\n}\n",
		),
		(
			"t.java",
			"class A {\n    @Override\n    public String toString() {\n        return name;\n    \
			 }\n\n    public String getName() {\n        return name;\n    }\n}\n",
			"@@ public String toString() {\n     @Override\n     public String toString() {\n-        \
			 return name;\n+        return prefix + name;",
			"class A {\n    @Override\n    public String toString() {\n        return prefix + \
			 name;\n    }\n\n    public String getName() {\n        return name;\n    }\n}\n",
		),
		(
			"t.rs",
			"fn main() {\n    let a = 1;\n    log(\"unique marker\");\n    let a = 1;\n}\n",
			"@@     log(\"unique marker\");\n-    let a = 1;\n+    let a = 2;\n     log(\"unique \
			 marker\");",
			"fn main() {\n    let a = 2;\n    log(\"unique marker\");\n    let a = 1;\n}\n",
		),
	];
	for (path, original, diff, expected) in cases {
		let written = applied_in(path, original, diff).await;
		assert_eq!(written, expected, "diff {diff:?}");
	}
}

/// A missing anchor falls back to the hunk's own lines exactly as without
/// it, line hint included.
#[tokio::test]
async fn patch_missing_anchor_falls_back_to_the_hinted_copy() {
	let (written, _) = applied(
		"x\nfoo\nbar\ny\nz\nfoo\nbar\n",
		"@@ -2,2 +2,2 @@ missing_anchor_text\n foo\n-bar\n+BAR",
	)
	.await;
	assert_eq!(written, "x\nfoo\nBAR\ny\nz\nfoo\nbar\n");
}

// ------------------------------------------------------- patch: variants

/// A hunk whose context is stale may drop it only when its remaining lines
/// are file-unique; the application is reported.
#[tokio::test]
async fn patch_stale_context_needs_a_file_unique_line() {
	let original = "function a() {\n  count += 1;\n  return count;\n}\nfunction b() {\n  count += \
	                1;\n  return total;\n}\n";
	refused(
		EditMode::Patch,
		original,
		patch("@@\n   let stale = 0;\n-  count += 1;\n+  count += 2;"),
	)
	.await;

	let (written, warnings) =
		applied(original, "@@\n   let stale = 0;\n-  return total;\n+  return total + 1;").await;
	assert_eq!(written, original.replace("return total;", "return total + 1;"));
	assert_eq!(warnings.len(), 1, "{warnings:?}");
	assert!(
		warnings[0].contains("line 7") && warnings[0].contains("1 of its lines ignored"),
		"{warnings:?}"
	);
}

/// A reshaped variant never edits a block its dropped context places
/// elsewhere, and a hunk resent after it was applied is refused rather than
/// repaired onto the other copy of its removed line.
#[tokio::test]
async fn patch_variant_never_moves_a_hunk_its_context_places_elsewhere() {
	refused(
		EditMode::Patch,
		"def load_users():\n    retries = 3\n    return fetch()\ndef save_orders():\n    retries = \
		 compute_retry_budget(config)\n    return store()\n",
		patch(
			"@@\n def save_orders():\n-    retries = 3\n+    retries = compute_retry_budget(config)",
		),
	)
	.await;

	refused(
		EditMode::Patch,
		"def load_users():\n    retries = 3\n    return fetch()\ndef save_orders():\n    retries = \
		 compute_retry_budget(config)\n    return store()\n",
		patch("@@\n def save_orders():\n-    retries = 3\n+    retries = 4"),
	)
	.await;
}

/// A refusal after a context-dropping variant ran into several copies
/// returns promptly, without replaying suggestions that cannot validate, and
/// lists the copies.
#[tokio::test]
async fn patch_variant_ambiguity_refuses_promptly() {
	let mut lines: Vec<String> = (1..=5_000)
		.map(|index| format!("entry {index} = value {index}"))
		.collect();
	for at in [100, 400] {
		lines[at] = "alpha = 1".into();
		lines[at + 1] = "beta = 2".into();
	}
	let original = lines.join("\n") + "\n";
	let started = Instant::now();
	let error = refused(
		EditMode::Patch,
		&original,
		patch("@@\n stale context line\n-alpha = 1\n+alpha = 10\n beta = 2"),
	)
	.await;
	assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
	assert_eq!(listed_lines(&error), [101, 401], "{error}");
	assert!(error.contains("stale context line"), "{error}");
}

// --------------------------------------------------- patch: search bounds

/// No tier reports a placement outside `[start, end)`: a scope entirely
/// behind its start finds nothing, even for a whitespace-only line the
/// character fallback would otherwise match against empty text, and an
/// empty pattern past the scope has no placement.
#[test]
fn seek_sequence_within_never_places_outside_its_scope() {
	let lines = ["def a():", "    x = 1", "", "def b():", "    y = 2", "    z = 3"];
	assert_eq!(seek_sequence_within(&lines, &["    "], 5, 3, false, true).index, None);
	let lines = ["def a():", "    x = 1", "def b():", "    y = 2", "    z = 3"];
	assert_eq!(seek_sequence_within(&lines, &[], 4, 2, false, true).index, None);
}

/// An anchored blank-row edit stays in scope regardless of hunk order;
/// missing blank context never turns into an arbitrary insertion point.
#[tokio::test]
async fn patch_anchored_blank_row_stays_in_its_region() {
	let written = both_orders(
		PATH,
		"def a():\n    x = 1\n\ndef b():\n    y = 2\n    z = 3\n",
		"@@ def b():\n-    y = 2\n+    y = 20",
		"@@ def a():\n-    \n+    return x",
	)
	.await
	.expect("the existing blank row is unique in scope");
	assert_eq!(written, "def a():\n    x = 1\n    return x\ndef b():\n    y = 20\n    z = 3\n");
	both_orders(
		PATH,
		"def a():\n    x = 1\ndef b():\n    y = 2\n    z = 3\n",
		"@@ def b():\n-    y = 2\n+    y = 20",
		"@@ def a():\n \n+    return x",
	)
	.await
	.expect_err("blank context is missing");
	for diff in ["@@\n \n+x", "@@ -2,1 +2,2 @@\n \n+x"] {
		refused(EditMode::Patch, "a\nb\n", patch(diff)).await;
	}
}

/// A hunk that can only sit past the last line is refused, not applied out
/// of range.
#[tokio::test]
async fn patch_hunk_past_the_end_is_refused() {
	both_orders(PATH, "a\nb\n", "@@\n-b\n+B", "@@\n-  \n+x")
		.await
		.expect_err("no row exists past EOF");
}

// ------------------------------------------------ patch: context structure

/// Which lines are context comes from the hunk's own ` ` lines, never from
/// text equality: a removed line equal to a context line is the one removed,
/// and only context lines keep the file's bytes.
#[tokio::test]
async fn patch_context_lines_follow_the_hunk_structure() {
	let (written, _) = applied(
		"def main():\n\tsetup()\n    setup()\n    run()\n",
		"@@\n def main():\n-    setup()\n     setup()\n     run()",
	)
	.await;
	assert_eq!(written, "def main():\n    setup()\n    run()\n");

	let (written, _) = applied(
		"msg = \"a\"\nprint(“done”)\nprint(\"done\")\n",
		"@@\n msg = \"a\"\n-print(\"done\")\n print(\"done\")",
	)
	.await;
	assert_eq!(written, "msg = \"a\"\nprint(\"done\")\n");

	let (written, _) = applied(
		"header\nlet alpha_value = compute_something(1);\nlet beta_value = \
		 compute_something(2);\nlet gamma_value = compute_something(3);\nfooter\n",
		"@@\n-let alpha_value = compute_something(1);\n-let beta_value = compute_something(2);\n \
		 let gamma_value = compute_somthing(3);\n+let alpha_value = compute_something(1);\n+let \
		 beta_value = compute_something(2);",
	)
	.await;
	assert_eq!(
		written,
		"header\nlet gamma_value = compute_something(3);\nlet alpha_value = \
		 compute_something(1);\nlet beta_value = compute_something(2);\nfooter\n"
	);
}

// ----------------------------------------------------- patch: evidence rank

/// A line hint breaks ties only among candidates equal on tier and score:
/// while a lower-ranked candidate stays undominated, no hint places the
/// hunk, not even one naming a candidate exactly.
#[tokio::test]
async fn patch_hint_never_settles_candidates_of_different_rank() {
	let original = "header\nlet result_value = compute_something(1);\nlet result_value = \
	                compute_something(2);\nlet result_value = compute_something(3);\nmiddle\nlet \
	                result_value = compute_something(1);\nlet result_value = \
	                compute_something(2);\nlet result_value = compute_something(33);\nfooter\n";
	let error = refused(
		EditMode::Patch,
		original,
		patch(
			"@@ -6,3 +6,3 @@\n let result_value = compute_somthing(1);\n-let result_value = \
			 compute_somthing(2);\n+let result_value = compute_something(20);\n let result_value = \
			 compute_somthing(3);",
		),
	)
	.await;
	assert_eq!(listed_lines(&error), [2, 6], "{error}");

	refused(
		EditMode::Patch,
		"header\nlet total = compute_sum(alpha, beta, gamma);\nmiddle\nlet total = \
		 compute_sum(alpha, beta, gamme);\nfooter\n",
		patch("@@ -2,1 +2,1 @@\n-let total = compute_sum(alpha, beta, gammex);\n+let total = 0;"),
	)
	.await;

	refused(
		EditMode::Patch,
		"let total = compute_total(items, rate);\nreturn total;\nlet total = compute_total(itemz, \
		 rates);\nreturn total;\n",
		patch(
			"@@ -3,2 +3,2 @@\n let total = compute_total(itens, rate);\n-return total;\n+return \
			 total + 1;",
		),
	)
	.await;
}

/// A unique member hint may bind one effect, leaving the other copy for
/// an otherwise ambiguous effect; no listing-order assignment is needed.
#[tokio::test]
async fn patch_member_hint_binds_different_effects_order_free() {
	let written = both_orders(
		PATH,
		"if ok:\n    run()\nx\nif ok:\n    run()\n",
		"@@\n if ok:\n-    run()\n+    stop()",
		"@@ -1,2 +1,2 @@\n if ok:\n-    run()\n+    start()",
	)
	.await
	.expect("one own hint distinguishes the two effects");
	assert_eq!(written, "if ok:\n    start()\nx\nif ok:\n    stop()\n");
}

/// Overlap suppression drops only windows overlapping a surviving better
/// window: two windows sharing no line both stay candidates, so neither is
/// taken without a clear lead.
#[test]
fn seek_sequence_keeps_windows_that_overlap_no_survivor() {
	let lines = [
		"header",
		"let result_value = compute_something(7);",
		"let result_value = compute_something(8);",
		"let result_value = compute_something(9);",
		"let result_value = compute_something(10);",
		"let result_value = compute_something(11);",
		"let result_value = compute_something(12);",
		"footer",
	];
	let found = seek_sequence(
		&lines,
		&[
			"let result_value = compute_somthing(10);",
			"let result_value = compute_somthing(11);",
			"let result_value = compute_somthing(12);",
		],
		0,
		false,
		true,
	);
	assert_eq!(found.match_indices, Some(vec![1, 4]));
}

/// Suppressing overlapping fuzzy windows stays far from quadratic when
/// thousands of windows score alike.
#[test]
fn seek_sequence_scores_many_fuzzy_windows_quickly() {
	let lines = vec!["let value = compute(1);"; 60_000];
	let started = Instant::now();
	let found = seek_sequence(&lines, &["let value = compute(2);"], 0, false, true);
	assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
	assert_eq!(found.match_count, Some(60_000));
}

// ------------------------------------------ patch: anchors and their regions

/// One anchored patch over a real file whose extension selects the syntax
/// tree: `Some(bytes)` must be written, `None` refused with zero writes.
type RegionCase = (&'static str, &'static str, &'static str, Option<&'static str>);

async fn check_region_cases(cases: &[RegionCase]) {
	for (path, original, diff, want) in cases {
		match want {
			Some(expected) => {
				let written = applied_in(path, original, diff).await;
				assert_eq!(written, *expected, "{path}: {diff:?}");
			},
			None => {
				refused_in(path, original, diff).await;
			},
		}
	}
}

/// Twin anchors are told apart by the hunk: a hunk containing the anchor
/// line at offset `k` starts `k` lines above its anchor, a line hint lies in
/// the intended anchor's block, and the proof by the anchor line counts only
/// at a strict tier, never by resembling another twin.
#[tokio::test]
async fn patch_twin_anchors_follow_the_hunk() {
	check_region_cases(&[
		(
			"t.py",
			"class A:\n    @property\n    def name(self): return 1\nclass B:\n    @property\n    def \
			 name(self): return 1\n",
			"@@ -5,2 +5,2 @@ def name(self): return 1\n     @property\n-    def name(self): return \
			 1\n+    def name(self): return 2",
			Some(
				"class A:\n    @property\n    def name(self): return 1\nclass B:\n    @property\n    \
				 def name(self): return 2\n",
			),
		),
		(
			"t.py",
			"class A:\n    def run(self):\n        x = 1\nclass B:\n    def run(self):\n        x = \
			 1\n",
			"@@ -4,1 +4,1 @@ def run(self):\n-        x = 1\n+        x = 2",
			None,
		),
		(
			"t.js",
			"function process() {\n    return 1;\n}\n\nfunction process() {\n    return \
			 2;\n}\n\nfunction process() {\n    return 3;\n}\n",
			"@@ -9,3 +9,3 @@ function process() {\n function process() {\n-    return 2;\n+    \
			 return 200;\n }",
			Some(
				"function process() {\n    return 1;\n}\n\nfunction process() {\n    return \
				 200;\n}\n\nfunction process() {\n    return 3;\n}\n",
			),
		),
		(
			"t.py",
			"def helper():\n    return 0\n\nclass A:\n    def helper():\n        return 1\n",
			"@@ def helper():\n     def helper():\n-        return 1\n+        return 2",
			Some("def helper():\n    return 0\n\nclass A:\n    def helper():\n        return 2\n"),
		),
	])
	.await;
}

/// Nested anchor parts are resolved inside the outer block, at any strict
/// tier and with the model's whitespace, and a nested part that fails never
/// lets the hunk leave the outer block.
#[tokio::test]
async fn patch_nested_anchors_stay_inside_the_outer_block() {
	check_region_cases(&[
		(
			"t.py",
			"class A:\n    def f(self):\n        if ok:\n            return 1\n        if \
			 ok:\n            return 2\nclass C:\n    def g(self):\n        if ok:\n            x = 1\n",
			"@@ class A:\n@@ if ok:\n-            x = 1\n+            x = 9",
			None,
		),
		(
			"t.py",
			"def helper():\n    return 0\n\nclass A:\n    def helper():\n        return 1\n",
			"@@ class A:\n@@ def helper():\n-        return 1\n+        return 2",
			Some("def helper():\n    return 0\n\nclass A:\n    def helper():\n        return 2\n"),
		),
		(
			"t.c",
			"int setup(void) {\n    int rc = open_db();\n#ifdef CACHE\n    if (cache) {\n        rc = \
			 open_cache();\n    }\n#endif\n    return rc;\n}\n",
			"@@ int setup(void) {\n@@ if (cache) {\n-        rc = open_cache();\n+        rc = \
			 open_cache(1);",
			Some(
				"int setup(void) {\n    int rc = open_db();\n#ifdef CACHE\n    if (cache) {\n        rc \
				 = open_cache(1);\n    }\n#endif\n    return rc;\n}\n",
			),
		),
		(
			"p.py",
			"class Parser:\n    @staticmethod\n    def parse(text):\n        return text.split()\n\n# \
			 Module-level shortcut\n\ndef parse(text):\n    return text.split()\n",
			"@@ class Parser:\n@@ def parse(text):\n-        return text.split()\n+        return \
			 text.split(\",\")",
			Some(
				"class Parser:\n    @staticmethod\n    def parse(text):\n        return \
				 text.split(\",\")\n\n# Module-level shortcut\n\ndef parse(text):\n    return \
				 text.split()\n",
			),
		),
	])
	.await;
	let original = "class A:\n    def f(self):\n        if ok:\n            x = 1\n        if \
	                ok:\n            y = 2\nclass C:\n    def g(self):\n        if ok:\n            \
	                x = 1\n";
	let written = both_orders(
		"t.py",
		original,
		"@@\n-            y = 2\n+            y = 3",
		"@@ class A:\n@@ if ok:\n-            x = 1\n+            x = 9",
	)
	.await
	.expect("outer block excludes class C");
	assert_eq!(
		written,
		original
			.replace("            y = 2", "            y = 3")
			.replacen("            x = 1", "            x = 9", 1)
	);
}

/// An anchor's region is the syntax block that begins on it: literals,
/// comments, preprocessor lines, decorators, multi-line signatures, Allman
/// braces and clause keywords never end it early, and a comment or other
/// single-line anchor (or a file without a grammar) bounds nothing, so the
/// hunk must be unique after it at the strict tiers.
#[tokio::test]
async fn patch_anchor_regions_follow_the_syntax_tree() {
	let go = "func TestDecode(t *testing.T) {\n\terr := setup()\n\trequire.NoError(t, err)\n\traw \
	          := `\n{\n  \"name\": \"x\"\n}\n`\n\terr = decode(raw)\n\trequire.NoError(t, err)\n}\n";
	let go_unique = "func TestDecode(t *testing.T) {\n\terr := setup()\n\trequire.NoError(t, \
	                 err)\n\traw := `\n{\n  \"name\": \"x\"\n}\n`\n\terr = \
	                 decodeStrict(raw)\n\trequire.NoError(t, err)\n}\n";
	check_region_cases(&[
		// Literals.
		(
			"t.py",
			"def build():\n    emit(header)\n    sql = \"\"\"\nSELECT 1\n\"\"\"\n    emit(header)\n",
			"@@ def build():\n-    emit(header)\n+    emit(footer)",
			None,
		),
		(
			"t.py",
			"def test_render():\n    expected = \"\"\"\n<h1>Hi</h1>\n\"\"\"\n    assert render() == \
			 expected\n",
			"@@ def test_render():\n-    assert render() == expected\n+    assert render().strip() == \
			 expected.strip()",
			Some(
				"def test_render():\n    expected = \"\"\"\n<h1>Hi</h1>\n\"\"\"\n    assert \
				 render().strip() == expected.strip()\n",
			),
		),
		("d_test.go", go, "@@ func TestDecode(t *testing.T) {\n-\trequire.NoError(t, err)\n+\trequire.NoError(t, err, \"decode\")", None),
		("d_test.go", go, "@@ func TestDecode(t *testing.T) {\n-\terr = decode(raw)\n+\terr = decodeStrict(raw)", Some(go_unique)),
		(
			"u.c",
			"void uart_init(void) {\n    UCSR0B = (1<<RXEN0)|(1<<TXEN0);\n    count = 0;\n}\nvoid \
			 timer_init(void) {\n    count = 0;\n}\n",
			"@@ void uart_init(void) {\n-    count = 0;\n+    count = 1;",
			Some(
				"void uart_init(void) {\n    UCSR0B = (1<<RXEN0)|(1<<TXEN0);\n    count = 1;\n}\nvoid \
				 timer_init(void) {\n    count = 0;\n}\n",
			),
		),
		(
			"u.c",
			"void uart_init(void) {\n    UCSR0B = (1<<RXEN0)|(1<<TXEN0);\n    count = 0;  \n}\nvoid \
			 timer_init(void) {\n    count = 0;\n}\n",
			"@@ void uart_init(void) {\n-    count = 0;\n+    count = 1;",
			Some(
				"void uart_init(void) {\n    UCSR0B = (1<<RXEN0)|(1<<TXEN0);\n    count = 1;\n}\nvoid \
				 timer_init(void) {\n    count = 0;\n}\n",
			),
		),
		(
			"t.c",
			"int f(void) {\n    int mask = (1<<SHIFT);\n    return mask;\n}\nint g(void) {\n    return \
			 mask;\n}\n",
			"@@ int f(void) {\n-    return mask;\n+    return mask + 1;",
			Some(
				"int f(void) {\n    int mask = (1<<SHIFT);\n    return mask + 1;\n}\nint g(void) {\n    \
				 return mask;\n}\n",
			),
		),
		(
			"t.cpp",
			"void f() {\n    std::cout<<\"x\";\n    log();\n}\nvoid g() {\n    log();\n}\n",
			"@@ void f() {\n-    log();\n+    log(1);",
			Some("void f() {\n    std::cout<<\"x\";\n    log(1);\n}\nvoid g() {\n    log();\n}\n"),
		),
		// Markdown sections, with fences and stray triple quotes inside.
		(
			"t.md",
			"## Install\n\n```sh\npip install tool\n# or, on macOS\npip install tool\n```\n",
			"@@ ## Install\n-pip install tool\n+pip install tool==2.0",
			None,
		),
		(
			"t.md",
			"# Tool\n\n## Installation\n\n```bash\n# Clone the repository\ngit clone \
			 https://example.com/tool.git\ncd tool\n```\n\n## Usage\n",
			"@@ ## Installation\n-cd tool\n+cd tool && make install",
			Some(
				"# Tool\n\n## Installation\n\n```bash\n# Clone the repository\ngit clone \
				 https://example.com/tool.git\ncd tool && make install\n```\n\n## Usage\n",
			),
		),
		(
			"guide.md",
			"# Guide\n\nWrap docstrings in `\"\"\"`.\n\n## Install\n\npip install tool\n\n## \
			 Upgrade\n\npip install tool\n",
			"@@ ## Install\n-pip install tool\n+pip install tool==2.0",
			Some(
				"# Guide\n\nWrap docstrings in `\"\"\"`.\n\n## Install\n\npip install tool==2.0\n\n## \
				 Upgrade\n\npip install tool\n",
			),
		),
		// Comments: a comment anchor bounds nothing, and a comment between
		// functions ends nothing.
		(
			"deploy.sh",
			"# Deploy\nrsync -av build/ server:/srv/app2/\n# then the main app\nrsync -av build/ \
			 server:/srv/app/\n",
			"@@ # Deploy\n-rsync -av build/ server:/srv/app/\n+rsync -avz build/ server:/srv/app/",
			Some(
				"# Deploy\nrsync -av build/ server:/srv/app2/\n# then the main app\nrsync -avz build/ \
				 server:/srv/app/\n",
			),
		),
		(
			"settings.py",
			"# Settings\nDEBUG = False\n# Limits\nTIMEOUT = 30\n",
			"@@ # Settings\n-TIMEOUT = 30\n+TIMEOUT = 60",
			Some("# Settings\nDEBUG = False\n# Limits\nTIMEOUT = 60\n"),
		),
		(
			"p.py",
			"def load():\n    retries = 3\n    return fetch(retries)\n\n# Persistence\n\ndef save():\n    \
			 retries = 3\n    return store(retries)\n",
			"@@ def load():\n-    retries = 3\n+    retries = 5",
			Some(
				"def load():\n    retries = 5\n    return fetch(retries)\n\n# Persistence\n\ndef \
				 save():\n    retries = 3\n    return store(retries)\n",
			),
		),
		(
			"p.py",
			"def load():\n    retries = 10\n    return fetch(retries)\n\n# Persistence\n\ndef save():\n    \
			 retries = 3\n    return store(retries)\n",
			"@@ def load():\n-    retries = 3\n+    retries = 10",
			None,
		),
		(
			"ci.yml",
			"jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: \
			 actions/checkout@v4\n  # Release job\n  release:\n    runs-on: ubuntu-latest\n    \
			 steps:\n      - uses: actions/checkout@v4\n",
			"@@ build:\n-    runs-on: ubuntu-latest\n+    runs-on: ubuntu-24.04",
			Some(
				"jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: \
				 actions/checkout@v4\n  # Release job\n  release:\n    runs-on: ubuntu-latest\n    \
				 steps:\n      - uses: actions/checkout@v4\n",
			),
		),
		// Decorators, multi-line signatures, Allman braces, clause keywords.
		(
			"t.py",
			"@app.route(\"/a\")\ndef a():\n    return render()\n\n@app.route(\"/b\")\ndef b():\n    \
			 return render()\n",
			"@@ @app.route(\"/a\")\n-    return render()\n+    return render(x)",
			Some(
				"@app.route(\"/a\")\ndef a():\n    return render(x)\n\n@app.route(\"/b\")\ndef b():\n    \
				 return render()\n",
			),
		),
		(
			"r.py",
			"@app.route(\n    \"/a\",\n    methods=[\"GET\"],\n)\ndef a():\n    return render()\n",
			"@@ @app.route(\n-    return render()\n+    return render(x)",
			Some("@app.route(\n    \"/a\",\n    methods=[\"GET\"],\n)\ndef a():\n    return render(x)\n"),
		),
		(
			"s.c",
			"static int setup(struct device *dev,\n\t\t unsigned long flags)\n{\n\treturn 0;\n}\n",
			"@@ static int setup(struct device *dev,\n-\treturn 0;\n+\treturn -ENODEV;",
			Some("static int setup(struct device *dev,\n\t\t unsigned long flags)\n{\n\treturn -ENODEV;\n}\n"),
		),
		(
			"S.cs",
			"    public void Configure(IApplicationBuilder app,\n        IWebHostEnvironment env)\n    \
			 {\n        app.UseRouting();\n    }\n",
			"@@ public void Configure(IApplicationBuilder app,\n-        app.UseRouting();\n+        \
			 app.UseRouting(options);",
			Some(
				"    public void Configure(IApplicationBuilder app,\n        IWebHostEnvironment env)\n    \
				 {\n        app.UseRouting(options);\n    }\n",
			),
		),
		(
			"f.cpp",
			"Foo::Foo(int a)\n    : a_(a)\n{\n    init();\n}\n",
			"@@ Foo::Foo(int a)\n-    init();\n+    init(a);",
			Some("Foo::Foo(int a)\n    : a_(a)\n{\n    init(a);\n}\n"),
		),
		(
			"f.rb",
			"def fetch\n  get(url)\nrescue Timeout::Error\n  retry\nend\n",
			"@@ def fetch\n-  retry\n+  retry if attempts < 3",
			Some("def fetch\n  get(url)\nrescue Timeout::Error\n  retry if attempts < 3\nend\n"),
		),
		// Inside a bounded block the ladder decides: the exact copy is the
		// placement. Without a grammar nothing bounds the anchor, so a copy
		// that differs only in whitespace keeps an exact one ambiguous.
		(
			"t.js",
			"function setup() {\n  if (rc) {\n    return rc;   \n  }\n// fallback\n  if (rc) {\n    \
			 return rc;\n  }\n}\n",
			"@@ function setup() {\n   if (rc) {\n-    return rc;\n+    return 0;",
			Some(
				"function setup() {\n  if (rc) {\n    return rc;   \n  }\n// fallback\n  if (rc) {\n    \
				 return 0;\n  }\n}\n",
			),
		),
		("t.txt", "head\n  x = 1  \nmid\n  x = 1\n", "@@ head\n-  x = 1\n+  x = 2", None),
		("t.txt", "head\nmid\n  x = 1\n", "@@ head\n-  x = 1\n+  x = 2", Some("head\nmid\n  x = 2\n")),
		// Only a block holding a body or entries bounds the hunk: a setext
		// heading, a multi-line attribute or call, or a statement inside a
		// function scopes nothing, so the hunk must be unique to EOF.
		(
			"g.md",
			"Intro\n\nInstall\n=======\n\nrun it\n",
			"@@ Install\n-run it\n+run it now",
			Some("Intro\n\nInstall\n=======\n\nrun it now\n"),
		),
		(
			"s.rs",
			"#[derive(\n    Debug,\n)]\nstruct Foo {\n    a: i32,\n}\n",
			"@@ #[derive(\n-    a: i32,\n+    a: i64,",
			Some("#[derive(\n    Debug,\n)]\nstruct Foo {\n    a: i64,\n}\n"),
		),
		(
			"cli.py",
			"def main():\n    parser = argparse.ArgumentParser(\n        description=\"tool\",\n    )\n    \
			 parser.add_argument(\"--verbose\")\n    return parser\n",
			"@@ parser = argparse.ArgumentParser(\n-    return parser\n+    return parser.parse_args()",
			Some(
				"def main():\n    parser = argparse.ArgumentParser(\n        description=\"tool\",\n    )\n    \
				 parser.add_argument(\"--verbose\")\n    return parser.parse_args()\n",
			),
		),
		// A Rust inner attribute bounds nothing: the hunk is placed in the
		// whole file below it, not in the next item.
		(
			"main.rs",
			"#![allow(dead_code)]\nfn helper() -> u32 {\n    compute_total(&items, 1)\n}\nfn main() {\n    \
			 compute_total(&items, 2)\n}\n",
			"@@ #![allow(dead_code)]\n-    compute_total(&items, 2)\n+    compute_total(&items, 3)",
			Some(
				"#![allow(dead_code)]\nfn helper() -> u32 {\n    compute_total(&items, 1)\n}\nfn main() {\n    \
				 compute_total(&items, 3)\n}\n",
			),
		),
		// A Go struct type and a YAML list item holding a mapping bound their
		// fields and entries.
		(
			"m.go",
			"package m\n\ntype A struct {\n\tName string\n}\n\ntype B struct {\n\tName string\n}\n",
			"@@ type A struct {\n-\tName string\n+\tName string `json:\"name\"`",
			Some(
				"package m\n\ntype A struct {\n\tName string `json:\"name\"`\n}\n\ntype B struct {\n\tName \
				 string\n}\n",
			),
		),
		(
			"ci.yml",
			"steps:\n  - name: Cache\n    with:\n      path: ~/.cache\n  - name: Upload\n    with:\n      \
			 path: ~/.cache\n",
			"@@   - name: Cache\n-      path: ~/.cache\n+      path: ~/.cache/pip",
			Some(
				"steps:\n  - name: Cache\n    with:\n      path: ~/.cache/pip\n  - name: Upload\n    with:\n      \
				 path: ~/.cache\n",
			),
		),
		// A block's last line closing what its first line opens bounds it:
		// markup end tags, `end` and `}` of control blocks, callbacks closing
		// a call. An attribute line takes the region of its item.
		(
			"pom.xml",
			"<project>\n  <dependencies>\n    <version>1.0</version>\n  </dependencies>\n  <plugins>\n    \
			 <version>1.0</version>\n  </plugins>\n</project>\n",
			"@@   <dependencies>\n-    <version>1.0</version>\n+    <version>2.0</version>",
			Some(
				"<project>\n  <dependencies>\n    <version>2.0</version>\n  </dependencies>\n  <plugins>\n    \
				 <version>1.0</version>\n  </plugins>\n</project>\n",
			),
		),
		(
			"lib.rs",
			"#[cfg(test)]\nmod tests {\n    fn a() {\n        assert!(check());\n    }\n}\n\nmod bench {\n    \
			 fn b() {\n        assert!(check());\n    }\n}\n",
			"@@ #[cfg(test)]\n-        assert!(check());\n+        assert!(check(), \"a\");",
			Some(
				"#[cfg(test)]\nmod tests {\n    fn a() {\n        assert!(check(), \"a\");\n    }\n}\n\nmod \
				 bench {\n    fn b() {\n        assert!(check());\n    }\n}\n",
			),
		),
		(
			"p.ts",
			"class Panel {\n  @Input()\n  open(): void {\n    this.visible = true;\n  }\n\n  close(): void \
			 {\n    this.visible = true;\n  }\n}\n",
			"@@ @Input()\n-    this.visible = true;\n+    this.visible = !this.locked;",
			Some(
				"class Panel {\n  @Input()\n  open(): void {\n    this.visible = !this.locked;\n  }\n\n  \
				 close(): void {\n    this.visible = true;\n  }\n}\n",
			),
		),
		(
			"f.rb",
			"def run\n  if ready\n    notify(x)\n  end\n  if done\n    notify(x)\n  end\nend\n",
			"@@ if ready\n-    notify(x)\n+    notify(y)",
			Some("def run\n  if ready\n    notify(y)\n  end\n  if done\n    notify(x)\n  end\nend\n"),
		),
		(
			"f.kt",
			"fun run() {\n    if (ready) {\n        notify(x)\n    }\n    if (done) {\n        notify(x)\n    \
			 }\n}\n",
			"@@ if (ready) {\n-        notify(x)\n+        notify(y)",
			Some(
				"fun run() {\n    if (ready) {\n        notify(y)\n    }\n    if (done) {\n        notify(x)\n    \
				 }\n}\n",
			),
		),
		(
			"f.swift",
			"func run() {\n    if ready {\n        notify(x)\n    }\n    if done {\n        notify(x)\n    \
			 }\n}\n",
			"@@ if ready {\n-        notify(x)\n+        notify(y)",
			Some(
				"func run() {\n    if ready {\n        notify(y)\n    }\n    if done {\n        notify(x)\n    \
				 }\n}\n",
			),
		),
		(
			"App.jsx",
			"function App() {\n  useEffect(() => {\n    subscribe(id);\n  }, [id]);\n  useLayoutEffect(() => \
			 {\n    subscribe(id);\n  }, [id]);\n}\n",
			"@@ useEffect(() => {\n-    subscribe(id);\n+    subscribe(id, true);",
			Some(
				"function App() {\n  useEffect(() => {\n    subscribe(id, true);\n  }, [id]);\n  \
				 useLayoutEffect(() => {\n    subscribe(id);\n  }, [id]);\n}\n",
			),
		),
		(
			"W.java",
			"class W {\n    void run() {\n        executor.submit(() -> {\n            process(item);\n        \
			 });\n        executor.execute(() -> {\n            process(item);\n        });\n    }\n}\n",
			"@@ executor.submit(() -> {\n-            process(item);\n+            process(item, true);",
			Some(
				"class W {\n    void run() {\n        executor.submit(() -> {\n            process(item, \
				 true);\n        });\n        executor.execute(() -> {\n            process(item);\n        \
				 });\n    }\n}\n",
			),
		),
		(
			"build.gradle.kts",
			"dependencies {\n    implementation(\"a:b:1\")\n}\ntasks.register(\"copy\") {\n    \
			 implementation(\"a:b:1\")\n}\n",
			"@@ dependencies {\n-    implementation(\"a:b:1\")\n+    implementation(\"a:b:2\")",
			Some(
				"dependencies {\n    implementation(\"a:b:2\")\n}\ntasks.register(\"copy\") {\n    \
				 implementation(\"a:b:1\")\n}\n",
			),
		),
		// A `)`-closed statement bounds nothing, so the twin is in scope.
		(
			"s.sql",
			"CREATE TABLE users (\n    id INT,\n    name TEXT\n);\nCREATE TABLE teams (\n    id INT,\n    \
			 name TEXT\n);\n",
			"@@ CREATE TABLE users (\n-    name TEXT\n+    name VARCHAR(64)",
			None,
		),
		// An attribute line bounds only its item: a `}`-closed decorator or
		// annotation, and one that is not the item's first.
		(
			"cats.controller.ts",
			"export class CatsController {\n  @ApiOkResponse({\n    description: 'The found records',\n  \
			 })\n  findAll() {\n    return this.cats.list();\n  }\n}\n",
			"@@ @ApiOkResponse({\n-    return this.cats.list();\n+    return this.cats.list(10);",
			Some(
				"export class CatsController {\n  @ApiOkResponse({\n    description: 'The found \
				 records',\n  })\n  findAll() {\n    return this.cats.list(10);\n  }\n}\n",
			),
		),
		(
			"Animal.java",
			"@JsonTypeInfo(use = JsonTypeInfo.Id.NAME)\n@JsonSubTypes({\n    @JsonSubTypes.Type(value = \
			 Cat.class, name = \"cat\"),\n})\npublic abstract class Animal {\n    public abstract String \
			 sound();\n}\n",
			"@@ @JsonSubTypes({\n-    public abstract String sound();\n+    public abstract String \
			 sound(int volume);",
			Some(
				"@JsonTypeInfo(use = JsonTypeInfo.Id.NAME)\n@JsonSubTypes({\n    @JsonSubTypes.Type(value \
				 = Cat.class, name = \"cat\"),\n})\npublic abstract class Animal {\n    public abstract \
				 String sound(int volume);\n}\n",
			),
		),
		(
			"CalcTest.java",
			"class CalcTest {\n    @Test\n    @DisplayName(\"adds\")\n    void adds() {\n        \
			 assertEquals(3, calc(1, 2));\n    }\n\n    @Test\n    @DisplayName(\"adds again\")\n    void \
			 addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n",
			"@@ @DisplayName(\"adds\")\n-        assertEquals(3, calc(1, 2));\n+        assertEquals(3, \
			 calc(2, 1));",
			Some(
				"class CalcTest {\n    @Test\n    @DisplayName(\"adds\")\n    void adds() {\n        \
				 assertEquals(3, calc(2, 1));\n    }\n\n    @Test\n    @DisplayName(\"adds again\")\n    \
				 void addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n",
			),
		),
		(
			"CalcTests.cs",
			"public class CalcTests\n{\n    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int a, \
			 int b)\n    {\n        Assert.Equal(3, Calc.Add(a, b));\n    }\n\n    [Theory]\n    \
			 [InlineData(2, 1)]\n    public void AddsReversed(int a, int b)\n    {\n        \
			 Assert.Equal(3, Calc.Add(a, b));\n    }\n}\n",
			"@@ [InlineData(1, 2)]\n-        Assert.Equal(3, Calc.Add(a, b));\n+        Assert.Equal(3, \
			 Calc.Add(b, a));",
			Some(
				"public class CalcTests\n{\n    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int \
				 a, int b)\n    {\n        Assert.Equal(3, Calc.Add(b, a));\n    }\n\n    [Theory]\n    \
				 [InlineData(2, 1)]\n    public void AddsReversed(int a, int b)\n    {\n        \
				 Assert.Equal(3, Calc.Add(a, b));\n    }\n}\n",
			),
		),
		// A start tag over several lines, a node closing on its last line
		// inside a modifier chain, and a keyword closing a construct that
		// opens with a header.
		(
			"beans.xml",
			"<beans>\n    <bean id=\"primary\"\n          class=\"com.example.Pool\">\n        <property \
			 name=\"size\" value=\"10\"/>\n    </bean>\n    <bean id=\"replica\"\n          \
			 class=\"com.example.Pool\">\n        <property name=\"size\" value=\"10\"/>\n    \
			 </bean>\n</beans>\n",
			"@@ <bean id=\"primary\"\n-        <property name=\"size\" value=\"10\"/>\n+        <property \
			 name=\"size\" value=\"20\"/>",
			Some(
				"<beans>\n    <bean id=\"primary\"\n          class=\"com.example.Pool\">\n        <property \
				 name=\"size\" value=\"20\"/>\n    </bean>\n    <bean id=\"replica\"\n          \
				 class=\"com.example.Pool\">\n        <property name=\"size\" value=\"10\"/>\n    \
				 </bean>\n</beans>\n",
			),
		),
		(
			"ContentView.swift",
			"struct ContentView: View {\n    var body: some View {\n        VStack {\n            \
			 Text(\"Title\")\n                .font(.headline)\n        }\n        .padding()\n        \
			 HStack {\n            Text(\"Title\")\n                .font(.headline)\n        }\n        \
			 .padding()\n    }\n}\n",
			"@@ VStack {\n-                .font(.headline)\n+                .font(.title)",
			Some(
				"struct ContentView: View {\n    var body: some View {\n        VStack {\n            \
				 Text(\"Title\")\n                .font(.title)\n        }\n        .padding()\n        \
				 HStack {\n            Text(\"Title\")\n                .font(.headline)\n        }\n        \
				 .padding()\n    }\n}\n",
			),
		),
		(
			"top.v",
			"module a (input x, output y);\n  assign y = x;\nendmodule\n\nmodule b (input x, output \
			 y);\n  assign y = x;\nendmodule\n",
			"@@ module a (input x, output y);\n-  assign y = x;\n+  assign y = ~x;",
			Some(
				"module a (input x, output y);\n  assign y = ~x;\nendmodule\n\nmodule b (input x, output \
				 y);\n  assign y = x;\nendmodule\n",
			),
		),
		// Closers of openers that are not on the anchor's line, and an
		// attributed item that is no block, bound nothing; comments between
		// an attribute and its item are skipped.
		(
			"routes.js",
			"app.get('/x',\n  auth,\n  (req, res) => {\n    res.send(1);\n  });\napp.get('/y', (req, \
			 res) => {\n    res.send(1);\n});\n",
			"@@ app.get('/x',\n-    res.send(1);\n+    res.send(2);",
			None,
		),
		(
			"f.rb",
			"result = [1,\n  2].map do |x|\n  x * 2\nend\nother = [3, 4].map do |x|\n  x * 2\nend\n",
			"@@ result = [1,\n-  x * 2\n+  x * 3",
			None,
		),
		(
			"t.rs",
			"#[rustfmt::skip]\nconst A: [u8; 2] = [\n    1,\n    2,\n];\nconst B: [u8; 2] = [\n    1,\n    \
			 2,\n];\n",
			"@@ #[rustfmt::skip]\n-    2,\n+    3,",
			None,
		),
		(
			"lib.rs",
			"#[cfg(test)]\n// unit tests\nmod tests {\n    fn a() {\n        assert!(check());\n    \
			 }\n}\n\nmod bench {\n    fn b() {\n        assert!(check());\n    }\n}\n",
			"@@ #[cfg(test)]\n-        assert!(check());\n+        assert!(check(), \"a\");",
			Some(
				"#[cfg(test)]\n// unit tests\nmod tests {\n    fn a() {\n        assert!(check(), \
				 \"a\");\n    }\n}\n\nmod bench {\n    fn b() {\n        assert!(check());\n    }\n}\n",
			),
		),
		// A call closing with a function literal holds that literal's body.
		(
			"a.test.js",
			"it('adds', () => {\n  const result = calc(1, 2);\n  expect(result).toBe(3);\n});\nit('adds \
			 again', () => {\n  const result = calc(1, 2);\n  expect(result).toBe(3);\n});\n",
			"@@ it('adds', () => {\n-  const result = calc(1, 2);\n+  const result = calc(2, 1);",
			Some(
				"it('adds', () => {\n  const result = calc(2, 1);\n  expect(result).toBe(3);\n});\nit('adds \
				 again', () => {\n  const result = calc(1, 2);\n  expect(result).toBe(3);\n});\n",
			),
		),
		// A promise chain's first callback bounds nothing: its last line opens the next one.
		(
			"s.js",
			"db.save(user).then(() => {\n  res.sendStatus(200);\n}).catch(() => {\n  res.sendStatus(500);\n});\n",
			"@@ db.save(user).then(() => {\n-  res.sendStatus(500);\n+  res.sendStatus(503);",
			Some("db.save(user).then(() => {\n  res.sendStatus(200);\n}).catch(() => {\n  res.sendStatus(503);\n});\n"),
		),
		(
			"p.js",
			"fetch(url).then((res) => {\n  render(res);\n}).catch((err) => {\n  console.error(err);\n});\n",
			"@@ fetch(url).then((res) => {\n-  console.error(err);\n+  report(err);",
			Some("fetch(url).then((res) => {\n  render(res);\n}).catch((err) => {\n  report(err);\n});\n"),
		),
		// A declaration's own header line under its attributes bounds that declaration, also when it
		// starts with a keyword; so does a PHP attribute group past the first.
		(
			"CalcTest.java",
			"class CalcTest {\n    @Test\n    @DisplayName(\"adds\")\n    void adds() {\n        assertEquals(3, calc(1, 2));\n    }\n\n    @Test\n    @DisplayName(\"adds again\")\n    void addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n",
			"@@ void adds() {\n-        assertEquals(3, calc(1, 2));\n+        assertEquals(3, calc(2, 1));",
			Some("class CalcTest {\n    @Test\n    @DisplayName(\"adds\")\n    void adds() {\n        assertEquals(3, calc(2, 1));\n    }\n\n    @Test\n    @DisplayName(\"adds again\")\n    void addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n"),
		),
		(
			"CalcTest.java",
			"class CalcTest {\n    @Test\n    public void adds() {\n        assertEquals(3, calc(1, 2));\n    }\n\n    @Test\n    public void addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n",
			"@@ public void adds() {\n-        assertEquals(3, calc(1, 2));\n+        assertEquals(3, calc(2, 1));",
			Some("class CalcTest {\n    @Test\n    public void adds() {\n        assertEquals(3, calc(2, 1));\n    }\n\n    @Test\n    public void addsAgain() {\n        assertEquals(3, calc(1, 2));\n    }\n}\n"),
		),
		(
			"CalcTests.cs",
			"public class CalcTests\n{\n    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(3, Calc.Add(a, b));\n    }\n\n    [Theory]\n    [InlineData(2, 1)]\n    public void AddsReversed(int a, int b)\n    {\n        Assert.Equal(3, Calc.Add(a, b));\n    }\n}\n",
			"@@ public void Adds(int a, int b)\n-        Assert.Equal(3, Calc.Add(a, b));\n+        Assert.Equal(3, Calc.Add(b, a));",
			Some("public class CalcTests\n{\n    [Theory]\n    [InlineData(1, 2)]\n    public void Adds(int a, int b)\n    {\n        Assert.Equal(3, Calc.Add(b, a));\n    }\n\n    [Theory]\n    [InlineData(2, 1)]\n    public void AddsReversed(int a, int b)\n    {\n        Assert.Equal(3, Calc.Add(a, b));\n    }\n}\n"),
		),
		(
			"C.php",
			"<?php\nclass C\n{\n    #[Route('/a')]\n    #[Cache(maxage: 60)]\n    public function a(): Response\n    {\n        return $this->render('x.html.twig');\n    }\n\n    #[Route('/b')]\n    #[Cache(maxage: 120)]\n    public function b(): Response\n    {\n        return $this->render('x.html.twig');\n    }\n}\n",
			"@@ #[Cache(maxage: 60)]\n-        return $this->render('x.html.twig');\n+        return $this->render('y.html.twig');",
			Some("<?php\nclass C\n{\n    #[Route('/a')]\n    #[Cache(maxage: 60)]\n    public function a(): Response\n    {\n        return $this->render('y.html.twig');\n    }\n\n    #[Route('/b')]\n    #[Cache(maxage: 120)]\n    public function b(): Response\n    {\n        return $this->render('x.html.twig');\n    }\n}\n"),
		),
		// A start tag over several lines bounds its element.
		(
			"x.html",
			"<script id=\"a\"\n        type=\"module\">\n  init();\n</script>\n<script id=\"b\"\n        type=\"module\">\n  init();\n</script>\n",
			"@@ <script id=\"a\"\n-  init();\n+  init(1);",
			Some("<script id=\"a\"\n        type=\"module\">\n  init(1);\n</script>\n<script id=\"b\"\n        type=\"module\">\n  init();\n</script>\n"),
		),
	])
	.await;
	let error = refused_in(
		"n.py",
		"def f():\n    marker = 1\n    x = 1\n\ndef g():\n    x = 1\n",
		"@@ marker = 1\n-    x = 1\n+    x = 2",
	)
	.await;
	assert_eq!(listed_lines(&error), [3, 6]);
}

/// An anchored insertion goes right below the anchor, the literal V4A
/// position, unless that breaks a clean parse while the top of the
/// construct's body does not: below a signature over several lines, an
/// Allman brace or an attribute. Wherever it goes, the construct whose
/// header holds the anchor stays whole and keeps its attributes. When that
/// construct has syntax errors of its own, only a clean line right below
/// the anchor is taken; any other choice is refused.
#[tokio::test]
async fn patch_anchored_insertion_lands_inside_the_block() {
	check_region_cases(&[
		(
			"t.cs",
			"class A\n{\n    void F()\n    {\n        x = 1;\n    }\n}\n",
			"@@ void F()\n+        y = 0;",
			Some("class A\n{\n    void F()\n    {\n        y = 0;\n        x = 1;\n    }\n}\n"),
		),
		(
			"t.py",
			"def f(\n    a,\n):\n    return a\n",
			"@@ def f(\n+    print(a)",
			Some("def f(\n    a,\n):\n    print(a)\n    return a\n"),
		),
		(
			"b.jsx",
			"function Button({\n  label,\n  onClick,\n}) {\n  return <button \
			 onClick={onClick}>{label}</button>;\n}\n",
			"@@ function Button({\n+  const [open, setOpen] = useState(false);",
			Some(
				"function Button({\n  label,\n  onClick,\n}) {\n  const [open, setOpen] = \
				 useState(false);\n  return <button onClick={onClick}>{label}</button>;\n}\n",
			),
		),
		(
			"l.py",
			"def long_function_name(\n        var_one, var_two,\n        var_four):\n    \
			 print(var_one)\n",
			"@@ def long_function_name(\n+    log(\"start\")",
			Some(
				"def long_function_name(\n        var_one, var_two,\n        var_four):\n    \
				 log(\"start\")\n    print(var_one)\n",
			),
		),
		(
			"A.java",
			"    public int add(int a,\n                   int b) {\n        return a + b;\n    }\n",
			"@@ public int add(int a,\n+        log(\"add\");",
			Some(
				"    public int add(int a,\n                   int b) {\n        log(\"add\");\n        \
				 return a + b;\n    }\n",
			),
		),
		("t.txt", "head\nbody\n", "@@ head\n+new", Some("head\nnew\nbody\n")),
		// Signature lines below an attribute or annotation, attribute anchors,
		// wrapped constructs and accessor bodies.
		(
			"C.cs",
			"class C\n{\n    [Fact]\n    public void Test()\n    {\n        Run();\n    }\n}\n",
			"@@ public void Test()\n+        Setup();",
			Some(
				"class C\n{\n    [Fact]\n    public void Test()\n    {\n        Setup();\n        \
				 Run();\n    }\n}\n",
			),
		),
		(
			"A.java",
			"class A {\n    @Override\n    public void configure(\n            HttpSecurity http) \
			 {\n        http.csrf();\n    }\n}\n",
			"@@ public void configure(\n+        log();",
			Some(
				"class A {\n    @Override\n    public void configure(\n            HttpSecurity http) \
				 {\n        log();\n        http.csrf();\n    }\n}\n",
			),
		),
		(
			"s.rs",
			"#[derive(Debug)]\nstruct Foo {\n    a: i32,\n}\n",
			"@@ #[derive(Debug)]\n+    b: i32,",
			Some("#[derive(Debug)]\nstruct Foo {\n    b: i32,\n    a: i32,\n}\n"),
		),
		(
			"P.cs",
			"class C\n{\n    public int Count\n    {\n        get { return 1; }\n    }\n}\n",
			"@@ public int Count\n+        set { }",
			Some("class C\n{\n    public int Count\n    {\n        set { }\n        get { return 1; }\n    }\n}\n"),
		),
		(
			"t.html",
			"<div\n  class=\"a\"\n>\n  <p>x</p>\n</div>\n",
			"@@ <div\n+  <p>new</p>",
			Some("<div\n  class=\"a\"\n>\n  <p>new</p>\n  <p>x</p>\n</div>\n"),
		),
		// Lines inside a body are in no header: the insertion goes right
		// below them, never into a later sibling's body.
		(
			"t.py",
			"class Config:\n    debug = False\n\n    def load(self):\n        pass\n",
			"@@ debug = False\n+    verbose = True",
			Some("class Config:\n    debug = False\n    verbose = True\n\n    def load(self):\n        pass\n"),
		),
		(
			"A.java",
			"class A {\n    private int count;\n\n    void run() {\n        go();\n    }\n}\n",
			"@@ private int count;\n+    private int total;",
			Some(
				"class A {\n    private int count;\n    private int total;\n\n    void run() {\n        \
				 go();\n    }\n}\n",
			),
		),
		(
			"foo.h",
			"#ifndef FOO_H\n#define FOO_H\n\n#include <stddef.h>\n\nstruct foo {\n    int a;\n};\n\n#endif\n",
			"@@ #define FOO_H\n+#include <stdint.h>",
			Some(
				"#ifndef FOO_H\n#define FOO_H\n#include <stdint.h>\n\n#include <stddef.h>\n\nstruct foo \
				 {\n    int a;\n};\n\n#endif\n",
			),
		),
		(
			"t.py",
			"def outer():\n    setup()\n    def inner():\n        pass\n    return inner\n",
			"@@ setup()\n+    configure()",
			Some("def outer():\n    setup()\n    configure()\n    def inner():\n        pass\n    return inner\n"),
		),
		// An argument line of a call is in no header, even when a callback
		// closes the call.
		(
			"s.js",
			"app.get('/x',\n  auth,\n  (req, res) => {\n    res.send();\n  });\n",
			"@@ auth,\n+  audit,",
			Some("app.get('/x',\n  auth,\n  audit,\n  (req, res) => {\n    res.send();\n  });\n"),
		),
		(
			"s.rs",
			"fn f() {\n    foo(\n        a,\n        |x| {\n            go(x);\n        },\n    );\n}\n",
			"@@ a,\n+        b,",
			Some("fn f() {\n    foo(\n        a,\n        b,\n        |x| {\n            go(x);\n        },\n    );\n}\n"),
		),
		// Function literals, Kotlin bodies, empty Markdown sections.
		(
			"b.jsx",
			"const Button = ({ label }) => {\n  return <b>{label}</b>;\n};\n",
			"@@ const Button = ({ label }) => {\n+  const [open, setOpen] = useState(false);",
			Some(
				"const Button = ({ label }) => {\n  const [open, setOpen] = useState(false);\n  return \
				 <b>{label}</b>;\n};\n",
			),
		),
		(
			"k.kt",
			"fun greet(name: String) {\n    println(name)\n}\n",
			"@@ fun greet(name: String) {\n+    log()",
			Some("fun greet(name: String) {\n    log()\n    println(name)\n}\n"),
		),
		(
			"d.md",
			"## Usage\n\n## License\n\nMIT\n",
			"@@ ## Usage\n+Run `tool --help`.",
			Some("## Usage\nRun `tool --help`.\n\n## License\n\nMIT\n"),
		),
		// Parameter, list, attribute and argument lines, entries and clauses:
		// right below the anchor parses, so the insertion goes there.
		(
			"u.py",
			"def create(\n    name,\n    email,\n):\n    save(name, email)\n",
			"@@     email,\n+    phone,",
			Some("def create(\n    name,\n    email,\n    phone,\n):\n    save(name, email)\n"),
		),
		(
			"u.js",
			"function create(\n  name,\n  email,\n) {\n  save(name, email);\n}\n",
			"@@   email,\n+  phone,",
			Some("function create(\n  name,\n  email,\n  phone,\n) {\n  save(name, email);\n}\n"),
		),
		(
			"l.py",
			"for name in [\n    \"alpha\",\n    \"beta\",\n]:\n    process(name)\n",
			"@@     \"beta\",\n+    \"gamma\",",
			Some("for name in [\n    \"alpha\",\n    \"beta\",\n    \"gamma\",\n]:\n    process(name)\n"),
		),
		(
			"c.py",
			"CHOICES = [\n    Color.RED,\n    Color.GREEN,\n]\n",
			"@@     Color.GREEN,\n+    Color.BLUE,",
			Some("CHOICES = [\n    Color.RED,\n    Color.GREEN,\n    Color.BLUE,\n]\n"),
		),
		(
			"t.html",
			"<div\n  class=\"a\"\n  id=\"b\"\n>\n  <p>x</p>\n</div>\n",
			"@@   class=\"a\"\n+  title=\"t\"",
			Some("<div\n  class=\"a\"\n  title=\"t\"\n  id=\"b\"\n>\n  <p>x</p>\n</div>\n"),
		),
		(
			"b.jsx",
			"function A() {\n  return (\n    <Button\n      label=\"Save\"\n      onClick={save}\n    />\n  \
			 );\n}\n",
			"@@       label=\"Save\"\n+      disabled={busy}",
			Some(
				"function A() {\n  return (\n    <Button\n      label=\"Save\"\n      disabled={busy}\n      \
				 onClick={save}\n    />\n  );\n}\n",
			),
		),
		(
			"package.json",
			"{\n  \"name\": \"x\",\n  \"dependencies\": {\n    \"a\": \"1\"\n  }\n}\n",
			"@@   \"dependencies\": {\n+    \"b\": \"2\",",
			Some("{\n  \"name\": \"x\",\n  \"dependencies\": {\n    \"b\": \"2\",\n    \"a\": \"1\"\n  }\n}\n"),
		),
		(
			"main.go",
			"package main\n\nimport (\n\t\"fmt\"\n)\n\nfunc main() {\n\tfmt.Println()\n}\n",
			"@@ import (\n+\t\"os\"",
			Some("package main\n\nimport (\n\t\"os\"\n\t\"fmt\"\n)\n\nfunc main() {\n\tfmt.Println()\n}\n"),
		),
		(
			"ci.yml",
			"jobs:\n  test:\n    run: |\n      npm ci\n      npm test\n",
			"@@     run: |\n+      npm run lint",
			Some("jobs:\n  test:\n    run: |\n      npm run lint\n      npm ci\n      npm test\n"),
		),
		(
			"build.gradle.kts",
			"dependencies {\n    implementation(\"a:b:1\")\n}\n",
			"@@ dependencies {\n+    implementation(\"c:d:2\")",
			Some("dependencies {\n    implementation(\"c:d:2\")\n    implementation(\"a:b:1\")\n}\n"),
		),
		(
			"pom.xml",
			"<project>\n  <dependencies>\n    <dependency>a</dependency>\n  </dependencies>\n</project>\n",
			"@@   <dependencies>\n+    <dependency>b</dependency>",
			Some(
				"<project>\n  <dependencies>\n    <dependency>b</dependency>\n    \
				 <dependency>a</dependency>\n  </dependencies>\n</project>\n",
			),
		),
		(
			"s.js",
			"switch (op) {\n  case 'retry':\n    do {\n      attempt();\n    } while (failed());\n    \
			 break;\n}\n",
			"@@   case 'retry':\n+    log('retry');",
			Some(
				"switch (op) {\n  case 'retry':\n    log('retry');\n    do {\n      attempt();\n    } while \
				 (failed());\n    break;\n}\n",
			),
		),
		(
			"cfg.js",
			"module.exports = {\n  plugins: [\n    \"a\",\n  ],\n};\n",
			"@@ plugins: [\n+    \"b\",",
			Some("module.exports = {\n  plugins: [\n    \"b\",\n    \"a\",\n  ],\n};\n"),
		),
		(
			"deploy.sh",
			"if [ -f x ]; then\n  run\nfi\n",
			"@@ if [ -f x ]; then\n+  prep",
			Some("if [ -f x ]; then\n  prep\n  run\nfi\n"),
		),
		(
			"s.go",
			"func f(x int) {\n\tswitch x {\n\tcase 1:\n\t\trun()\n\t}\n}\n",
			"@@ switch x {\n+\tcase 0:\n+\t\tidle()",
			Some("func f(x int) {\n\tswitch x {\n\tcase 0:\n\t\tidle()\n\tcase 1:\n\t\trun()\n\t}\n}\n"),
		),
		// The body starts right below the anchor: no parse is needed, so a
		// syntax error inside the body does not matter.
		(
			"f.py",
			"def f():\n    if x\n        go()\n    return 1\n",
			"@@ def f():\n+    x = load()",
			Some("def f():\n    x = load()\n    if x\n        go()\n    return 1\n"),
		),
		// A syntax error is judged where it lies: one elsewhere in the file
		// leaves the construct's own parse as evidence, one inside the
		// construct leaves the choice to the model.
		(
			"t.cs",
			"class A\n{\n    void F()\n    {\n        x = 1;\n    }\n    void G( {\n    }\n}\n",
			"@@ void F()\n+        y = 0;",
			Some("class A\n{\n    void F()\n    {\n        y = 0;\n        x = 1;\n    }\n    void G( {\n    }\n}\n"),
		),
		(
			"t.cs",
			"class A\n{\n    void F(int a,\n           int b)\n    {\n        x = = 1;\n    }\n}\n",
			"@@ void F(int a,\n+        y = 0;",
			None,
		),
		// The construct's own errors do not block a clean line right below
		// the anchor that adds no error.
		(
			"u.py",
			"def create(\n    name,\n    email,\n):\n    x = = 1\n    save(name, email)\n",
			"@@     email,\n+    phone,",
			Some("def create(\n    name,\n    email,\n    phone,\n):\n    x = = 1\n    save(name, email)\n"),
		),
		(
			"t.cs",
			"class A\n{\n    void F(int a,\n           int b)\n    {\n        x = = 1;\n    }\n}\n",
			"@@ void F(int a,\n+           int c,",
			Some(
				"class A\n{\n    void F(int a,\n           int c,\n           int b)\n    {\n        x = = \
				 1;\n    }\n}\n",
			),
		),
		// The top of the body never pushes a brace-less loop body out of its
		// loop.
		(
			"s.js",
			"function skip(s, i) {\n  while (i < s.length &&\n         s[i] === ' ')\n    i++;\n  return \
			 i;\n}\n",
			"@@ while (i < s.length &&\n+    count++;",
			None,
		),
		(
			"m.c",
			"int trim(char *buf, int len)\n{\n\twhile (len > 0 &&\n\t       buf[len - 1] == ' ')\n\t\tlen--;\n\treturn \
			 len;\n}\n",
			"@@ while (len > 0 &&\n+\t\tbuf[len] = 0;",
			None,
		),
		// Swift `@` and C++ `[[…]]` attributes, and attributes of items with
		// no body, are never taken over.
		("f.swift", "@MainActor\nclass ViewModel {\n    var x = 1\n}\n", "@@ @MainActor\n+class Helper {}", None),
		(
			"m.cpp",
			"[[nodiscard]]\nint compute(int a) {\n    return a;\n}\n",
			"@@ [[nodiscard]]\n+int helper(int b);",
			None,
		),
		(
			"s.rs",
			"struct Config {\n    #[serde(default)]\n    retries: u32,\n}\n",
			"@@     #[serde(default)]\n+    timeout: u64,",
			None,
		),
		(
			"A.java",
			"class A {\n    @Autowired\n    private UserService users;\n}\n",
			"@@ @Autowired\n+    private Clock clock;",
			None,
		),
		// Where neither position parses, nothing settles the choice.
		(
			"t.cs",
			"class A\n{\n    void F()\n    {\n        x = 1;\n    }\n}\n",
			"@@ void F()\n+        if (x == 1) {",
			None,
		),
		// An attribute of the construct would apply to the inserted lines.
		(
			"lib.rs",
			"pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use \
			 super::*;\n}\n",
			"@@ #[cfg(test)]\n+    use std::collections::HashMap;",
			None,
		),
		("r.py", "@app.route(\"/\")\ndef index():\n    return render()\n", "@@ @app.route(\"/\")\n+def health():\n+    return \"ok\"", None),
		(
			"p.ts",
			"class Panel {\n  @Input()\n  open(): void {\n    this.visible = true;\n  }\n}\n",
			"@@ @Input()\n+  label = \"x\";",
			None,
		),
		(
			"A.java",
			"class A {\n    @Override\n    public String toString() {\n        return \"A\";\n    }\n}\n",
			"@@ @Override\n+    private int count;",
			None,
		),
		// A permissive grammar reads the lines below the header as part of
		// it, or splits the construct from its body: the top of the body
		// parses, so it is taken.
		(
			"m.c",
			"int main()\n{\n    return 0;\n}\n",
			"@@ int main()\n+    int x = 0;",
			Some("int main()\n{\n    int x = 0;\n    return 0;\n}\n"),
		),
		// Body lines that would end the construct beginning on the anchor's
		// line go to the top of its body (an Allman loop header, a template
		// header); a sibling at the anchor's depth is refused.
		(
			"t.cpp",
			"template <typename T>\nT add(T a, T b) {\n    return a + b;\n}\n",
			"@@ template <typename T>\n+    static int calls = 0;",
			Some("template <typename T>\nT add(T a, T b) {\n    static int calls = 0;\n    return a + b;\n}\n"),
		),
		(
			"t.cpp",
			"template <typename T>\nT add(T a, T b) {\n    return a + b;\n}\n",
			"@@ template <typename T>\n+int helper();",
			None,
		),
		(
			"s.js",
			"function f(items) {\n  for (const item of items)\n  {\n    use(item);\n  }\n}\n",
			"@@ for (const item of items)\n+    log(item);",
			Some("function f(items) {\n  for (const item of items)\n  {\n    log(item);\n    use(item);\n  }\n}\n"),
		),
		(
			"t.cs",
			"class C\n{\n    void F(int[] xs)\n    {\n        foreach (var x in xs)\n        {\n            \
			 Use(x);\n        }\n    }\n}\n",
			"@@ foreach (var x in xs)\n+            Log(x);",
			Some(
				"class C\n{\n    void F(int[] xs)\n    {\n        foreach (var x in xs)\n        {\n            \
				 Log(x);\n            Use(x);\n        }\n    }\n}\n",
			),
		),
		// A Rust inner attribute belongs to the enclosing module: nothing
		// below it is its item.
		(
			"lib.rs",
			"#![allow(dead_code)]\nfn helper() -> u32 {\n    1\n}\n",
			"@@ #![allow(dead_code)]\n+use std::fmt;",
			Some("#![allow(dead_code)]\nuse std::fmt;\nfn helper() -> u32 {\n    1\n}\n"),
		),
		// Header parts with no body alternative, a decorator stacked on the
		// anchor's own, and a bound inside a where clause stay below the anchor.
		(
			"F.cs",
			"class Foo : Base\n{\n    public Foo(int x)\n    {\n        Init();\n    }\n}\n",
			"@@ public Foo(int x)\n+        : base(x)",
			Some("class Foo : Base\n{\n    public Foo(int x)\n        : base(x)\n    {\n        Init();\n    }\n}\n"),
		),
		(
			"r.py",
			"@app.route(\"/\")\ndef index():\n    return render()\n",
			"@@ @app.route(\"/\")\n+@login_required",
			Some("@app.route(\"/\")\n@login_required\ndef index():\n    return render()\n"),
		),
		(
			"w.rs",
			"fn f<T>(x: T)\nwhere\n    T: Debug,\n{\n    run(x);\n}\n",
			"@@     T: Debug,\n+    T: Clone,",
			Some("fn f<T>(x: T)\nwhere\n    T: Debug,\n    T: Clone,\n{\n    run(x);\n}\n"),
		),
		// The anchor line's own attribute stays with its parameter, with or
		// without a body, and with its declaration in a stacked PHP group; a
		// decorator stacked on it does not take it over.
		(
			"s.ts",
			"class S {\n  constructor(\n    @Inject(TOKEN)\n    private readonly svc: Service,\n  ) {\n    \
			 init();\n  }\n}\n",
			"@@ @Inject(TOKEN)\n+    private readonly clock: Clock,",
			None,
		),
		(
			"s.ts",
			"class S {\n  constructor(\n    @Inject(TOKEN)\n    private readonly svc: Service,\n  ) {\n    \
			 init();\n  }\n}\n",
			"@@ @Inject(TOKEN)\n+    @Optional()",
			Some(
				"class S {\n  constructor(\n    @Inject(TOKEN)\n    @Optional()\n    private readonly svc: \
				 Service,\n  ) {\n    init();\n  }\n}\n",
			),
		),
		(
			"U.java",
			"class U {\n    Response update(\n            @PathVariable(\"id\")\n            Long id) {\n        \
			 return ok(id);\n    }\n}\n",
			"@@ @PathVariable(\"id\")\n+            Long version,",
			None,
		),
		(
			"U.java",
			"interface U {\n    Response update(\n            @PathVariable(\"id\")\n            Long id);\n}\n",
			"@@ @PathVariable(\"id\")\n+            Long version,",
			None,
		),
		(
			"A.php",
			"<?php\nclass A {\n    #[Inject]\n    #[Lazy]\n    private UserService $users;\n}\n",
			"@@ #[Lazy]\n+    private Clock $clock;",
			None,
		),
		// An `if` never lends its `else` block as its body, and a line pushing
		// a brace-less branch out of it is refused; under the `else` line, the
		// `else` block is the body.
		(
			"t.cs",
			"class C\n{\n    void F(bool a)\n    {\n        if (a)\n            X();\n        else\n        \
			 {\n            Y();\n        }\n    }\n}\n",
			"@@ if (a)\n+            Log();",
			None,
		),
		(
			"A.java",
			"class A {\n    void f(boolean a) {\n        if (a)\n            x();\n        else {\n            \
			 y();\n        }\n    }\n}\n",
			"@@ if (a)\n+            log();",
			None,
		),
		(
			"A.java",
			"class A {\n    void f(boolean a) {\n        if (a)\n            x();\n        else\n        \
			 {\n            y();\n        }\n    }\n}\n",
			"@@ else\n+            log();",
			Some(
				"class A {\n    void f(boolean a) {\n        if (a)\n            x();\n        else\n        \
				 {\n            log();\n            y();\n        }\n    }\n}\n",
			),
		),
		// Body lines that would end a brace-less `if` stay out of it, also
		// where a comment puts its body further down.
		(
			"t.cs",
			"class C\n{\n    void F(bool a)\n    {\n        if (a)\n            // note\n            X();\n    \
			 }\n}\n",
			"@@ if (a)\n+            Log();",
			None,
		),
		// A conditional expression's consequence is no body: the function
		// holding it in a default value still takes the line.
		(
			"s.js",
			"function f(a =\n    cond\n      ? 1\n      : 2) {\n  body();\n}\n",
			"@@     cond\n+  init();",
			Some("function f(a =\n    cond\n      ? 1\n      : 2) {\n  init();\n  body();\n}\n"),
		),
		// Depth compares the exact leading whitespace, past blank lines: four
		// spaces are not deeper than a tab.
		(
			"t.cpp",
			"namespace n {\n\ttemplate <typename T>\n\tT add(T a, T b) {\n\t\treturn a + b;\n\t}\n}\n",
			"@@ template <typename T>\n+    int helper();",
			None,
		),
		(
			"s.js",
			"function f(xs) {\n  for (const x of xs)\n  {\n    use(x);\n  }\n}\n",
			"@@ for (const x of xs)\n+\n+    log(x);",
			Some("function f(xs) {\n  for (const x of xs)\n  {\n\n    log(x);\n    use(x);\n  }\n}\n"),
		),
		(
			"r.py",
			"@app.route(\"/\")\ndef index():\n    return render()\n",
			"@@ @app.route(\"/\")\n+\n+@login_required",
			Some("@app.route(\"/\")\n\n@login_required\ndef index():\n    return render()\n"),
		),
	])
	.await;
	// An errorful construct cannot certify a boundary from a parameter row.
	refused_in(
		"t.cs",
		"class A\n{\n    void F(int a,\n           int b)\n    {\n        x = = 1;\n    }\n}\n",
		"@@ int b)\n+        y = 0;",
	)
	.await;
}

/// Changed lines above their anchor are refused with where they were
/// found, and following that advice applies the edit.
#[tokio::test]
async fn patch_lines_above_the_anchor_are_refused_with_their_location() {
	let original = "def load(path):\n    if not path:\n        raise ValueError(\"path must not be \
	                empty\")\n    return open(path)\n";
	let error = refused_in(
		"l.py",
		original,
		"@@ raise ValueError(\"path must not be empty\")\n-    if not path:\n+    if not path or \
		 path.isspace():",
	)
	.await;
	assert!(error.contains("found at line 2, above the anchor"), "{error}");
	let written = applied_in(
		"l.py",
		original,
		"@@ def load(path):\n-    if not path:\n+    if not path or path.isspace():",
	)
	.await;
	assert_eq!(written, original.replace("if not path:", "if not path or path.isspace():"));
}

/// A bare hunk takes the fuzzy window standing clearly ahead of the rest,
/// exactly as `replace` does for the same text.
#[tokio::test]
async fn patch_bare_hunk_takes_a_standout_fuzzy_window() {
	let (written, _) = applied(
		"let totalValue = computeTotal(items, rate);\nx\nlet totalValue = computeTotal(itemz, \
		 rates);\n",
		"@@\n-let totalValue  = computeTotal(items,  rate);\n+let totalValue = computeTotal(items, \
		 rate) + 1;",
	)
	.await;
	assert_eq!(
		written,
		"let totalValue = computeTotal(items, rate) + 1;\nx\nlet totalValue = computeTotal(itemz, \
		 rates);\n"
	);
}

// ---------------------------------------------- patch: round-3 placement

/// A byte-level hit inside a line is never a placement of the hunk's
/// lines: not in the character fallback, not for a hint, not for an
/// identical-hunk run; and a patch refusal never advises `replace_all`.
#[tokio::test]
async fn patch_never_places_a_partial_line_hit() {
	refused_in(
		"t.py",
		"def a():\n    x = 1\ndef b():\n    y = 2\n",
		"@@ def a():\n-    \n+    return x",
	)
	.await;
	refused_in(
		"t.rs",
		"fn a() {\n    total = x + 1;\n}\nfn b() {\n    total = x + 1;\n}\n",
		"@@ fn a() {\n-x + 1\n+x + 10",
	)
	.await;
	let lines = ["def a():", "    x = 1", "def b():", "    y = 2"];
	assert_eq!(seek_sequence_within(&lines, &["    "], 1, 2, false, true).index, None);
	refused(EditMode::Patch, "xabyab\nother\n", patch("@@ -1,1 +1,1 @@\n-ab\n+cd")).await;
	refused(EditMode::Patch, "xab\nyab\n", patch("@@\n-ab\n+cd\n@@\n-ab\n+cd")).await;
	let error = refused(EditMode::Patch, "aaa\n", patch("@@\n-aa\n+b")).await;
	assert!(!error.contains("replace_all"), "{error}");
	// Every inexact tier aligns a removed line inside its file line: text the
	// file line keeps outside the alignment, which the new lines do not
	// carry, is never dropped. A typo spanning the whole line still applies.
	refused(
		EditMode::Patch,
		"sum1 = compute_total(items);\n}\nb = 1\ngrand_total_value = compute_total(items);\n}\nb = \
		 1\n",
		patch("@@ -1,3 +1,3 @@\n-compute_total(items);\n+compute_total(items, tax);\n }\n b = 1"),
	)
	.await;
	let steps = [
		"}",
		"step_three();",
		"step_four();",
		"step_five();",
		"step_six();",
		"step_seven();",
		"step_eight();",
		"step_nine();",
		"step_ten();",
	]
	.map(|line| format!("{line}\n"))
	.concat();
	let original = format!("let total = x + 1;\n{steps}");
	let context = steps.lines().fold(String::new(), |mut context, line| {
		context.push_str("\n ");
		context.push_str(line);
		context
	});
	for removed in ["x + 1;", "x + l;"] {
		refused(EditMode::Patch, &original, patch(&format!("@@\n-{removed}\n+x + 2;{context}")))
			.await;
	}
	let (written, _) =
		applied(&original, &format!("@@\n-let totl = x + 1;\n+let total = x + 2;{context}")).await;
	assert_eq!(written, format!("let total = x + 2;\n{steps}"));
	// A comment marker the removed line lacks is kept, not dropped.
	refused_in("t.js", "// TODO: fix x\nrun();\n", "@@\n-TODO: fix x\n+TODO: fix y\n run();").await;
	// Long lines are checked token by token: a fragment loses the rest of
	// the line, a whole-line typo the added line rewrites is the edit.
	let body = "abcdefghij".repeat(420);
	refused(
		EditMode::Patch,
		&format!("const data = \"{body}\";\nnext();\n"),
		patch(&format!("@@\n-\"{}abcdefghiX\";\n+\"short\";\n next();", "abcdefghij".repeat(419))),
	)
	.await;
	let body = "abcdefghij".repeat(250);
	let (written, _) = applied(
		&format!("const data = \"{body}\";\nnext();\n"),
		&format!(
			"@@\n-const data = \"{}abcdefghiX\";\n+const data = \"short\";\n next();",
			"abcdefghij".repeat(249)
		),
	)
	.await;
	assert_eq!(written, "const data = \"short\";\nnext();\n");
	// A change block too large to pair line by line still pairs the line it
	// checks, by shared tokens.
	let steps = (1..=99).fold(String::new(), |mut steps, step| {
		let _ = writeln!(steps, "step_{step:03}(alpha_value, beta_value, gamma_value);");
		steps
	});
	let removed = steps.lines().fold(String::new(), |mut diff, line| {
		let _ = write!(diff, "\n-{line}");
		diff
	});
	let added = (1..=97).fold(String::new(), |mut diff, step| {
		let _ = write!(diff, "\n+step_{step:03}(alpha_value, beta_value, gamma_value, delta);");
		diff
	});
	refused(
		EditMode::Patch,
		&format!("// config\nconst MAX = 10;\n{steps}"),
		patch(&format!("@@\n // config\n-let MAX = 10;{removed}\n+let MAX = 20;{added}")),
	)
	.await;
	// A line with too many tokens to align is refused rather than guessed,
	// asking for the file's own line.
	let ones = "1, ".repeat(700);
	let error = refused(
		EditMode::Patch,
		&format!("data = [{ones}7];\n"),
		patch(&format!("@@\n-data = [{ones}8];\n+data = [{ones}9];")),
	)
	.await;
	assert!(error.contains("exactly"), "{error}");
}

/// The text a removed line lacks must reappear in the added line that
/// replaces it, where it stood: never in a context line or another added
/// line, never skipped inside the matched span, never respelled. A refusal
/// quotes whole tokens of the file line, bounded.
#[tokio::test]
async fn patch_partial_lines_are_checked_against_their_counterpart() {
	refused_in(
		"t.json",
		"{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n",
		"@@\n {\n-  \"a\": 1\n+  \"a\": 5\n   \"b\": 2,\n   \"c\": 3\n }",
	)
	.await;
	refused_in(
		"t.js",
		"if (a) {\n  one();\n} else {\n  two();\n}\n",
		"@@\n if (a) {\n   one();\n-else {\n-  two();\n-}\n+else {\n+  three();\n+}",
	)
	.await;
	refused_in("t.rs", "/// Doc text\nfn f() {}\n", "@@\n-// Doc text\n+// Better doc\n fn f() {}")
		.await;
	refused_in(
		"t.py",
		"class Job:\n    def run(self, timeout: int = 5):\n        self.start()\n        \
		 self.wait(timeout)\n        return self.result\n",
		"@@\n class Job:\n-    def run(self, timeout=5):\n+    def run(self, timeout=10):\n         \
		 self.start()\n         self.wait(timeout)\n         return self.result",
	)
	.await;
	refused_in(
		"m.py",
		"def main():\n    result = call(a, b, compute_value(x))\n    print(result)\n    \
		 save(result)\n    return result\n",
		"@@\n def main():\n-    result = call(a, compute_value(x))\n+    result = call(a, \
		 compute_value(y))\n     print(result)\n     save(result)\n     return result",
	)
	.await;
	// The quote is whole tokens of the file line.
	let quoted = |error: &str| {
		error
			.split_once("also contains \"")
			.and_then(|(_, rest)| rest.split_once("\", which"))
			.map(|(quote, _)| quote.to_owned())
			.expect("refusal quotes the lost text")
	};
	// A quote is whole tokens when no identifier runs across either edge.
	let whole_tokens = |line: &str, quote: &str| {
		let wordy = |ch: Option<char>| ch.is_some_and(|ch| ch.is_alphanumeric() || ch == '_');
		let split = |outside: Option<char>, inside: Option<char>| wordy(outside) && wordy(inside);
		line.match_indices(quote).any(|(at, _)| {
			let end = at + quote.len();
			let (before, first) = (line[..at].chars().next_back(), quote.chars().next());
			let (after, last) = (line[end..].chars().next(), quote.chars().next_back());
			!quote.is_empty() && !split(before, first) && !split(after, last)
		})
	};
	let line = "pub(crate) fn foo() {";
	let error = refused_in(
		"t.rs",
		&format!("{line}\n    a();\n    b();\n    c();\n    d();\n}}\n"),
		"@@\n-pub fn foo() {\n+pub fn foo() -> u8 {\n     a();\n     b();\n     c();\n     d();\n }",
	)
	.await;
	assert!(whole_tokens(line, &quoted(&error)), "{error}");
	let line = "  const x = 1;";
	let error = refused_in(
		"t.js",
		&format!("function f() {{\n{line}\n  log(x);\n  return x;\n}}\n"),
		"@@\n function f() {\n-  let x = 1;\n+  let x = 2;\n   log(x);\n   return x;\n }",
	)
	.await;
	assert!(whole_tokens(line, &quoted(&error)), "{error}");
	let error = refused_in(
		"t.js",
		&format!("const DATA = [{}];\nnext();\n", "1, ".repeat(3000)),
		"@@\n-const DATA = [\n+const DATA = [0,\n next();",
	)
	.await;
	assert!(error.len() < 2_000, "{} bytes", error.len());
	// Text a line ends with stays at the end of the line replacing it, not
	// anywhere after its aligned neighbour.
	refused_in(
		"t.json",
		"{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n",
		"@@\n {\n-  \"a\": 1\n+  \"a\": [1, 2]\n   \"b\": 2,\n   \"c\": 3\n }",
	)
	.await;
	refused_in(
		"c.py",
		"CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n",
		"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=max(30, MIN_TIMEOUT)\n     retries=3,\n \
		 )",
	)
	.await;
	refused_in(
		"l.py",
		"items = [\n    foo(a),\n    baz(),\n]\n",
		"@@\n items = [\n-    foo(a)\n+    foo(a) or {\"x\": 1, \"y\": 2}\n     baz(),\n ]",
	)
	.await;
	// A respelled quote is checked even where fuzzy matching folds it.
	refused_in(
		"t.js",
		"function greet(name) {\n  const msg = `Hello ${name}`;\n  return msg;\n}\n",
		"@@\n function greet(name) {\n-  const msg = 'Hello ${name}';\n+  const msg = 'Hi \
		 ${name}';\n   return msg;\n }",
	)
	.await;
	// Text a line ends or starts with may not move inside the replacement,
	// and the refusal says which edge it left.
	let error = refused_in(
		"c.py",
		"CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n",
		"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=60, 5\n     retries=3,\n )",
	)
	.await;
	assert!(error.contains("ends with") && error.contains("does not"), "{error}");
	// A reordered block pairs each line with its own rewrite.
	refused_in(
		"c.py",
		"def connect(\n    port=None,\n    host=None,\n    timeout=None,\n):\n",
		"@@\n def connect(\n-    port=None\n-    host=None,\n+    host=None,\n+    port=8080\n     \
		 timeout=None,\n ):",
	)
	.await;
}

/// A removed line's own tokens pin where the text it lacks goes: a token
/// the replacement changes pins nothing. Text the file line ends with stays
/// last in the line replacing it, or right before its line comment, at the
/// file line's bracket depth and never inside a comment or bracket the
/// replacement opens; every added line rewriting the removed one keeps it;
/// and a misspelling the replacement moves is still the file's.
#[tokio::test]
async fn patch_partial_line_edges_follow_tokens_brackets_and_comments() {
	let config = "CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n";
	let rewrite =
		|line: &str| format!("@@\n CONFIG = dict(\n-    timeout=30\n{line}\n     retries=3,\n )");
	for (path, original, diff, expected) in [
		(
			"c.py",
			config,
			rewrite("+    timeout=60,"),
			"CONFIG = dict(\n    timeout=60,\n    retries=3,\n)\n",
		),
		(
			"c.py",
			config,
			rewrite("+    timeout=60,  # seconds"),
			"CONFIG = dict(\n    timeout=60,  # seconds\n    retries=3,\n)\n",
		),
		(
			"c.py",
			"x = 1  # important note\ny = 2\n",
			"@@\n-x = 1\n+x = 2  # important note\n y = 2".to_owned(),
			"x = 2  # important note\ny = 2\n",
		),
		(
			"t.c",
			"int main() {\n    foo(a, b);\n    return 0;\n}\n",
			"@@\n int main() {\n-    foo(a, b)\n+    foo(a);\n     return 0;".to_owned(),
			"int main() {\n    foo(a);\n    return 0;\n}\n",
		),
		(
			"t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			"@@\n const o = {\n-  a: 1\n+  a: 5, // tuned\n   b: 2,\n };".to_owned(),
			"const o = {\n  a: 5, // tuned\n  b: 2,\n};\n",
		),
		// A line added before the rewrite starts otherwise and keeps nothing.
		(
			"c.py",
			"CONFIG = dict(\n    retries=3,\n    timeout=30,\n)\n",
			"@@\n CONFIG = dict(\n-    retries=3\n+    # retry policy\n+    retries=5,\n     \
			 timeout=30,\n )"
				.to_owned(),
			"CONFIG = dict(\n    # retry policy\n    retries=5,\n    timeout=30,\n)\n",
		),
		// Added lines starting like the removed one are no rewrites of it when
		// its most similar line assigns, binds or calls the same.
		(
			"g.py",
			"def get():\n    result = load()\n    return result  # cached\n",
			"@@\n     result = load()\n-    return result\n+    if not result:\n+        return \
			 None\n+    return result  # cached"
				.to_owned(),
			"def get():\n    result = load()\n    if not result:\n        return None\n    return \
			 result  # cached\n",
		),
		(
			"t.json",
			"{\n  \"a\": 1,\n  \"b\": 2\n}\n",
			"@@\n {\n-  \"a\": 1\n-  \"b\": 2\n+  \"a\": 10,\n+  \"b\": 20\n }".to_owned(),
			"{\n  \"a\": 10,\n  \"b\": 20\n}\n",
		),
		(
			"c.py",
			"class C:\n    def f(self):\n        self.timeout = 30  # seconds\n        return self\n",
			"@@\n     def f(self):\n-        self.timeout = 30\n+        self.timeout = 60  # \
			 seconds\n+        self.retries = 3\n         return self"
				.to_owned(),
			"class C:\n    def f(self):\n        self.timeout = 60  # seconds\n        self.retries \
			 = 3\n        return self\n",
		),
	] {
		assert_eq!(applied_in(path, original, &diff).await, expected, "{diff}");
	}
	for (path, original, diff) in [
		// Inside a bracket the replacement opens.
		("c.py", config, rewrite("+    timeout=max(30,\n+        MIN_TIMEOUT)")),
		("c.py", config, rewrite("+    timeout=max(30,  # floor\n+        MIN_TIMEOUT)")),
		(
			"t.json",
			"{\n  \"a\": 1,\n  \"b\": 2\n}\n",
			"@@\n {\n-  \"a\": 1\n+  \"a\": [1,\n+    2]\n   \"b\": 2\n }".to_owned(),
		),
		// Inside a comment the replacement adds, or after text JSON has no
		// comment syntax for.
		(
			"c.py",
			"CONFIG = dict(\n    retries=3,\n    timeout=30,\n)\n",
			"@@\n CONFIG = dict(\n-    retries=3\n+    retries=5  # was 3,\n     timeout=30,\n )"
				.to_owned(),
		),
		(
			"a.php",
			"<?php\n$o = [\n    'retries' => 3,\n    'timeout' => 30,\n];\n",
			"@@\n $o = [\n-    'retries' => 3\n+    'retries' => 5  # was 3,\n     'timeout' => \
			 30,\n ];"
				.to_owned(),
		),
		(
			"t.json",
			"{\n  \"a\": 1,\n  \"b\": 2\n}\n",
			"@@\n {\n-  \"a\": 1\n+  \"a\": 2, // x\n   \"b\": 2\n }".to_owned(),
		),
		// The line's own rewrite drops the comma a sibling line ends with.
		(
			"c.py",
			"CONFIG = dict(\n    timeout=compute_timeout(base),\n    retries=3,\n)\n",
			"@@\n CONFIG = dict(\n-    timeout=compute_timeout(base)\n+    timeout=60\n+    \
			 connect_timeout=compute_timeout(base),\n     retries=3,\n )"
				.to_owned(),
		),
		(
			"c.py",
			"CONFIG = dict(\n    timeout=compute_timeout(base),\n    debug=False\n)\n",
			"@@\n CONFIG = dict(\n-    timeout=compute_timeout(base)\n-    debug=False\n+    \
			 timeout=60\n+    connect_timeout=compute_timeout(base),\n )"
				.to_owned(),
		),
	] {
		refused_in(path, original, &diff).await;
	}
	// A respelled token the replacement moves is lost all the same.
	for (original, diff) in
		[
			(
				"def run(ctx):\n    send(userId, flag)\n    return ctx\n",
				"@@\n def run(ctx):\n-    send(user_id, flag)\n+    send(ctx, user_id)\n     return \
				 ctx",
			),
			(
				"def f(price, qty):\n    total = price * qty\n    return total\n",
				"@@\n def f(price, qty):\n-    total = price * quantity\n+    total = quantity * \
				 price\n     return total",
			),
		] {
		refused_in("t.py", original, diff).await;
	}
	// Keeping lost edge text elsewhere still loses the original edge.
	for (path, original, diff) in [
		("t.rs", "/// Doc text\nfn f() {}\n", "@@\n-// Doc text\n+// Better doc\n fn f() {}"),
		("t.js", "f(\n  a, b,\n  c\n);\n", "@@\n f(\n-  a, b\n+  a,\n   c\n );"),
	] {
		refused_in(path, original, diff).await;
	}
}

// ----------------------------------------------- patch: round-4 placement

/// Each anchored hunk counts every original candidate in its own region.
/// Only another uniquely bound effect's changed rows may be excluded.
#[tokio::test]
async fn patch_anchored_hunks_count_every_unconsumed_match() {
	both_orders(
		PATH,
		"[a]\nx = 1\n[b]\ny = 1\n[c]\nx = 1\n",
		"@@ [b]\n-y = 1\n+y = 2",
		"@@ [a]\n-x = 1\n+x = 3",
	)
	.await
	.expect_err("unbounded section retains both copies");
	both_orders(
		"a.py",
		"# --- reader ---\nretries = 3\n# --- writer ---\ntimeout = 10\n# --- cache ---\nretries = \
		 3\n",
		"@@ # --- writer ---\n-timeout = 10\n+timeout = 30",
		"@@ # --- reader ---\n-retries = 3\n+retries = 5",
	)
	.await
	.expect_err("comment anchors retain both copies");
	both_orders(
		"k.py",
		"class A:\n    x = 1\n    y = 1\n    x = 1\n",
		"@@ class A:\n-    y = 1\n+    y = 2",
		"@@ class A:\n-    x = 1\n+    x = 3",
	)
	.await
	.expect_err("disjoint changes cannot bind a twin");
	// Lower-ranked copies cannot inherit a consumed best placement.
	let error = both_orders(
		PATH,
		"[a]\nval = 1\n[b]\nval = 1   \n[c]\n  val = 1\n",
		"@@ [a]\n [a]\n-val = 1\n+val = 2",
		"@@ -6,1 +6,1 @@ [a]\n-val = 1\n+val = 3",
	)
	.await
	.expect_err("a hint cannot promote lower-ranked copies");
	let numbers = error
		.split(|ch: char| !ch.is_ascii_digit())
		.filter_map(|word| word.parse::<u32>().ok())
		.collect::<Vec<_>>();
	assert!(numbers.contains(&4) && numbers.contains(&6), "{error}");
	// While a best-ranked copy survives, the lower-ranked ones still count,
	// whichever tied copy was consumed, at the strict and character tiers.
	for context in [" x", " y"] {
		both_orders(
			"t.txt",
			"[a]\nval = 1\nx\nval = 1\ny\n  val = 1\n",
			&format!("@@ [a]\n-val = 1\n+val = 2\n{context}"),
			"@@ [a]\n-val = 1\n+val = 3",
		)
		.await
		.expect_err(context);
	}
	both_orders(
		"t.py",
		"def f():\n    rate = 1.025\n    a = 1\n    rate = 1.025\n    b = 2\n    rate = 1.35\n",
		"@@ def f():\n-    rate = 1.025\n+    rate = 1.05\n     b = 2",
		"@@ def f():\n-    rate = 1.25\n+    rate = 2.0",
	)
	.await
	.expect_err("line 6 stays a candidate");
	// The looser copies are named by their changed line, as the consumed one.
	let error = both_orders(
		"t.txt",
		"[a]\nk\nval = 1\n[b]\nk\nval = 1   \n",
		"@@ [a]\n-val = 1\n+val = 2\n [b]",
		"@@ [a]\n k\n-val = 1\n+val = 3",
	)
	.await
	.expect_err("the best copy is consumed");
	assert!(error.contains("line 6") && !error.contains("line 5"), "{error}");
	both_orders(
		"t.py",
		"def f():\n    x = 1\n    y = 0\n    x = 1  \n",
		"@@ def f():\n-    x = 1\n+    x = 2\n     y = 0",
		"@@ def f():\n-    x = 1\n+    x = 3",
	)
	.await
	.expect_err("the exact copy is consumed");
	// Fixed changed rows exclude the character tier's best copy too.
	both_orders(
		"t.py",
		"def f():\n    rate = 1.025\n    rate = 1.35\n",
		"@@ def f():\n-    rate = 1.025\n+    rate = 1.05",
		"@@ def f():\n-    rate = 1.25\n+    rate = 2.0",
	)
	.await
	.expect_err("the best character placement is changed");
	let hunk = "@@ if ok:\n if ok:\n-    run()\n+    stop()";
	let written = both_orders(PATH, "if ok:\n    run()\nx\nif ok:\n    run()\n", hunk, hunk)
		.await
		.expect("identical effects cover both copies");
	assert_eq!(written, "if ok:\n    stop()\nx\nif ok:\n    stop()\n");
	both_orders(
		PATH,
		"[a]\nx = 1\n[b]\ny = 1\n[c]\nx = 1\n",
		"@@\n-y = 1\n+y = 2",
		"@@\n-x = 1\n+x = 3",
	)
	.await
	.expect_err("changing y cannot distinguish the two x copies");
	// Shared context does not exclude another hunk's changed-row candidates.
	both_orders("f.py",
		"def f(x):\n    if x:\n        a()\n    else:\n        pass\n    if x > 1:\n        b()\n    else:\n        pass\n",
		"@@ def f(x):\n-        a()\n+        a2()\n     else:",
		"@@ def f(x):\n     else:\n-        pass\n+        c()")
		.await.expect_err("both else rows remain candidates");
	both_orders(PATH, "[s]\na\nb\n[t]\nb\n", "@@ [s]\n-a\n+A\n b", "@@ [s]\n-b\n+B")
		.await
		.expect_err("context does not bind either b copy");
	both_orders(
		"t.py",
		"def f():\n    total = compute_invoice_total(order, value_4)\n    other = 1\n    total = \
		 compute_invoice_total(order, value_5)\n",
		"@@ def f():\n-    total = compute_invoice_total(order, value_4)\n+    total = \
		 compute_invoice_total(order, value_44)",
		"@@ def f():\n-    total = compute_invoice_totl(order, value_4)\n+    total = 0",
	)
	.await
	.expect_err("a looser copy cannot replace a fixed best one");
	// Competing effects on the same changed row are refused, naming that row.
	for (original, first, second) in [
		(
			"def f():\n    x = 1\n    y = 9\n",
			"@@ def f():\n-    x = 1\n+    x = 2",
			"@@ def f():\n-    x = 1\n+    y = 9",
		),
		(
			"def f():\n    x = 1\n    y = 2\n",
			"@@ def f():\n-    x = 1\n+    x = 5",
			"@@ def f():\n-    x = 1\n+    x = 6",
		),
	] {
		let error = both_orders("t.py", original, first, second)
			.await
			.expect_err("competing effects");
		assert!(error.contains("line 2"), "{error}");
		// The same with a trailing blank context line the repair drops.
		let error = both_orders("t.py", original, first, &format!("{second}\n "))
			.await
			.expect_err("competing repaired effects");
		assert!(error.contains("line 2"), "{error}");
	}
	let insertion = "@@\n a\n+x\n b";
	both_orders(PATH, "a\nb\n", insertion, insertion)
		.await
		.expect_err("both need the same gap");
	let written = both_orders(PATH, "a\nb\nc\nd\n", "@@\n-a\n+A\n b", "@@\n b\n-c\n+C")
		.await
		.expect("adjacent changed rows may share context");
	assert_eq!(written, "A\nb\nC\nd\n");
}

/// Hunks whose contexts order them give the same bytes in either order:
/// opposite-side insertions share a gap, and an untied replacement does
/// not constrain that gap.
#[tokio::test]
async fn patch_hunk_order_never_changes_the_result() {
	for (path, original, first, second, expected) in [
		("t.txt", "a\nb\n", "@@\n+Y\n b", "@@\n a\n+X", "a\nX\nY\nb\n"),
		(
			"t.py",
			"class S:\n    x = 1\n    y = 2\n",
			"@@ class S:\n+    # about y\n     y = 2",
			"@@ class S:\n     x = 1\n+    z = 3",
			"class S:\n    x = 1\n    z = 3\n    # about y\n    y = 2\n",
		),
		("t.txt", "a\nb\n", "@@\n-b\n+B", "@@\n a\n+X", "a\nX\nB\n"),
		("t.txt", "a\nb\nc\n", "@@\n-b", "@@\n a\n+X", "a\nX\nc\n"),
		("t.txt", "a\nb\n", "@@ a\n+X", "@@\n+Y\n b", "a\nX\nY\nb\n"),
		// An edit closing with inserted lines leaves another gap free.
		("t.txt", "a\nc\nd\ne\n", "@@\n a\n-c\n+C\n+X\n d", "@@\n+Y\n e", "a\nC\nX\nd\nY\ne\n"),
	] {
		for diff in [format!("{first}\n{second}"), format!("{second}\n{first}")] {
			assert_eq!(applied_in(path, original, &diff).await, expected, "{diff}");
		}
	}
}

/// A replacement's adjacency and a pure insertion's side reservation hold
/// against anchored, hinted and context-bearing partners alike.
#[tokio::test]
async fn anchored_insertions_cannot_break_replacement_ties() {
	for (first, second) in
		[("@@ a\n+X", "@@\n a\n-b\n+B"), ("@@\n+X\n b", "@@\n a\n-b\n+B"), ("@@ a\n+X", "@@\n a\n+Y")]
	{
		both_orders("t.txt", "a\nb\n", first, second)
			.await
			.expect_err("contested adjacency");
	}
}

/// Lines two hunks insert next to the same context line cannot both stay
/// next to it, whichever goes first: they are refused as overlapping, also
/// when one of them opens or closes an edit, and in any order of the hunks.
#[tokio::test]
async fn patch_insertions_competing_for_a_gap_are_refused() {
	let edit = "@@\n a\n+X\n b\n-c\n+C";
	for other in ["@@\n+Y\n b", "@@ a\n+E", "@@\n a\n+Z"] {
		both_orders("t.txt", "a\nb\nc\n", edit, other)
			.await
			.expect_err(other);
	}
	both_orders("t.txt", "a\nc\nd\n", "@@\n a\n-c\n+C\n+X\n d", "@@\n+Y\n d")
		.await
		.expect_err("both need the line before d");
	let hunks = ["@@\n a\n+X", "@@ a\n+E", "@@\n z\n a\n+Y"];
	for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
		let diff = order.map(|at| hunks[at]).join("\n");
		refused(EditMode::Patch, "z\na\nb\n", patch(&diff)).await;
	}
}

/// A hunk re-sent after it was applied is refused, never repaired onto the
/// other copy of its removed line: pure removals too, a placement found only
/// at a loose tier too, and a file whose only shared context is a brace.
#[tokio::test]
async fn patch_resent_hunks_are_refused_as_already_applied() {
	refused(
		EditMode::Patch,
		"flask\nrequests\nnumpy\n",
		patch("@@\n flask\n requests\n-requests\n numpy"),
	)
	.await;
	refused_in(
		"a.py",
		"import os\nimport sys\n\ndef main():\n    pass\n",
		"@@\n import os\n-import os\n import sys",
	)
	.await;
	refused_in(
		"a.py",
		"def alpha(items):\n    total = 0\n    total = sum(i.value for i in items)\n    return \
		 total\n\ndef beta(items):\n    total = 0\n    total += item.values\n    return total\n",
		"@@\n     total = 0\n-    total += item.value\n+    total = sum(i.value for i in items)\n     \
		 return total",
	)
	.await;
	refused_in(
		"t.cs",
		"class A\n{\n    void F()\n    {\n        Launch(config);\n    }\n    void G()\n    {\n        \
		 Init();\n        Start();\n    }\n}\n",
		"@@\n     {\n-        Start();\n+        Launch(config);",
	)
	.await;
	// The new side checked in every window the old side could take: one a
	// hunk containing its anchor line proves, and one without the trailing
	// blank line the placement retries.
	refused_in(
		"main.rs",
		"fn main() {\n    let a = 2;\n    log(\"unique marker\");\n    let a = 1;\n}\n",
		"@@     log(\"unique marker\");\n-    let a = 1;\n+    let a = 2;\n     log(\"unique \
		 marker\");",
	)
	.await;
	refused(EditMode::Patch, "old\nx\nalpha\nnew\n", patch("@@\n alpha\n-old\n+new\n ")).await;
	// Each window counts on its own: a stale copy whose remaining context
	// confirms it is still no target while the new side sits where the
	// hunk's anchor line puts it, or where it sits without its blank line.
	refused_in(
		"server.txt",
		"[server]\nport = 8081\nhost = a\n[backup]\nport = 8080\nhost = a\n",
		"@@ [server]\n [server]\n-port = 8080\n+port = 8081\n host = a",
	)
	.await;
	refused(
		EditMode::Patch,
		"alpha\nnew\nbeta\ngamma\nold\nbeta\n",
		patch("@@\n alpha\n-old\n+new\n beta\n "),
	)
	.await;
	// A placement found only without the trailing blank line is checked too.
	refused(
		EditMode::Patch,
		"section\nvalue\nx\nsection\nVALUE\n\n",
		patch("@@\n section\n-value\n+VALUE\n "),
	)
	.await;
	refused_in(
		"a.py",
		"class Job:\n    def setup(self):\n        x = compute_total(1, rate)\n        return x\n\n    \
		 def run(self):\n        x = compte(1)\n        return x\n",
		"@@ class Job:\n-        x = compute(1)\n+        x = compute_total(1, rate)",
	)
	.await;
	// Evidence of an applied hunk stays inside a certain anchor's block, and
	// without one a lone added line needs a context line: the hunk edits its
	// own target instead.
	assert_eq!(
		applied_in(
			"a.py",
			"def load():\n    return self.cache_value_for_current_request\n\ndef other():\n    \
			 return None\n",
			"@@ def load():\n-    return self.cache_value_for_current_requesx\n+    return None",
		)
		.await,
		"def load():\n    return None\n\ndef other():\n    return None\n"
	);
	assert_eq!(
		applied(
			"total = compute_total(items, rate)\nreturn None\n",
			"@@\n-total = compute_totl(items, rate)\n+return None"
		)
		.await
		.0,
		"return None\nreturn None\n"
	);
	refused_in(
		"settings.py",
		"# Config\nDEBUG = 1\nLOG_LEVEL = \"info\"\n\n# Test overrides\nDEBUG = False\n",
		"@@ # Config\n-DEBUG = True\n+DEBUG = False",
	)
	.await;
	// An anchor that bounds nothing is no evidence either: a loose match of
	// the removed line under it is edited although the new line sits in
	// another section.
	assert_eq!(
		applied_in(
			"settings.py",
			"# Config\nDEBUG_MODE_ENABLED = Tru\nLOG = 1\n\n# Test overrides\nDEBUG_MODE_ENABLED = \
			 False\n",
			"@@ # Config\n-DEBUG_MODE_ENABLED = True\n+DEBUG_MODE_ENABLED = False",
		)
		.await,
		"# Config\nDEBUG_MODE_ENABLED = False\nLOG = 1\n\n# Test overrides\nDEBUG_MODE_ENABLED = \
		 False\n"
	);
}

/// Each anchor's own evidence ranks before hints, independently of other
/// hunks; fuzzy hints choose only among equally scored hits.
#[tokio::test]
async fn patch_anchor_evidence_ranks_before_hints() {
	both_orders("a.py",
		"class A:\n    def f(self):\n        x = 1\n        x = 1\nclass B:\n    def f(self):\n        x = 1\n",
		"@@ -2,1 +2,1 @@ def f(self):\n-        x = 1\n+        x = 2",
		"@@ -7,1 +7,1 @@ def f(self):\n-        x = 1\n+        x = 3")
		.await.expect_err("each anchor is ambiguous at its own best tier");
	refused_in(
		"a.py",
		"def process_data(items):\n    return clean(items)\n\ndef process_date(items):\n    return \
		 clean(items)\n",
		"@@ -4,1 +4,1 @@ def proccess_data(items):\n-    return clean(items)\n+    return \
		 clean(items, strict=True)",
	)
	.await;
}

/// One stale context line beside confirming neighbours does not veto a
/// variant, and its offset is measured from where the whole hunk starts.
#[tokio::test]
async fn patch_variant_with_one_stale_context_line_applies() {
	let original = "def handle(event):\n    validate(event)\n    dispatch_now(event)\n    return \
	                True\n\ndef replay(events):\n    for event in events:\n        \
	                log.debug(\"start\")\n        dispatch_later(event)\n";
	let written = applied_in(
		"a.py",
		original,
		"@@\n     validate(event)\n     log.debug(\"start\")\n-    dispatch_now(event)\n+    \
		 dispatch_now(event, retry=True)\n     return True",
	)
	.await;
	assert_eq!(written, original.replace("dispatch_now(event)", "dispatch_now(event, retry=True)"));

	let original = (1..=20)
		.map(|line| format!("line {line}"))
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	let (written, warnings) = applied(
		&original,
		"@@ -5,6 +5,6 @@\n line 5\n line 6\n line 7\n line 8\n-line 9\n+LINE 9\n stale trailing",
	)
	.await;
	assert_eq!(written, original.replace("line 9\n", "LINE 9\n"));
	assert!(warnings.iter().all(|warning| !warning.contains("offset")), "{warnings:?}");

	// Dropped leading context confirms the placement from up to as many lines
	// above it as were dropped.
	let original = "def main():\n    setup()\n    configure()\n    x = 1\n    y = 2\n    \
	                print(\"hello\")\n    return 0\n";
	let written = applied_in(
		"m.py",
		original,
		"@@\n def main():\n     setup()\n     configure()\n-    print(\"hello\")\n+    \
		 print(\"world\")",
	)
	.await;
	assert_eq!(written, original.replace("hello", "world"));
	// A repeated context line confirms only where the hunk puts it.
	refused_in(
		"t.py",
		"class Loader:\n    def __init__(self):\n        self.name = \"loader\"\n        \
		 self.retries = 3\nclass Saver:\n    def __init__(self):\n        self.retries = \
		 compute_retry_budget(config)\n",
		"@@\n     def __init__(self):\n-        self.retries = 3\n+        self.retries = 4",
	)
	.await;
	// One line of slack beyond the dropped lines, on either side, for a line
	// unique in the file.
	assert_eq!(
		applied_in(
			"t.py",
			"def f():\n    a = 1\n    b = 2\n",
			"@@\n def f():\n-    b = 2\n+    b = 3"
		)
		.await,
		"def f():\n    a = 1\n    b = 3\n"
	);
	assert_eq!(
		applied("x = 1\ny = 2\nreturn x\n", "@@\n-x = 1\n+x = 5\n return x")
			.await
			.0,
		"x = 5\ny = 2\nreturn x\n"
	);
}

// ------------------------------------------------------------ replace text

/// `replace_all` over an empty fuzzy window replaces exactly that window.
#[test]
fn replace_all_empty_window_keeps_its_line_breaks() {
	let result = replaced(replace_text("a\n\nb", "   ", "x", true, true, None)
		.expect("one fuzzy window"));
	assert_eq!(result.content, "a\nx\nb");
}

/// Placements that share a line are previewed once, so every candidate
/// line gets a preview.
#[test]
fn replace_text_previews_each_candidate_line_once() {
	let error = replace_miss(
		replace_text(&format!("aaaaaa\n{}aa\n", "x\n".repeat(18)), "aa", "b", false, false, None)
			.expect("six placements"),
	);
	let marked = |row: &str| {
		error
			.lines()
			.filter(|line| line.starts_with('>') && line.ends_with(row))
			.count()
	};
	assert_eq!(marked(" 1 | aaaaaa"), 1, "{error}");
	assert_eq!(marked(" 20 | aa"), 1, "{error}");
	assert!(!error.contains("showing first"), "{error}");

	// Past five previews, every displayed candidate row is still marked and
	// the count stands apart from the file's rows.
	let error = replace_miss(
		replace_text(&"x = 1\ny\n".repeat(7), "x = 1", "x = 2", false, false, None)
			.expect("seven placements"),
	);
	let rows = error
		.lines()
		.filter(|line| line.contains(" | x = 1"))
		.collect::<Vec<_>>();
	assert!(!rows.is_empty() && rows.iter().all(|row| row.starts_with('>')), "{error}");
	assert!(
		error
			.lines()
			.all(|line| !line.contains(" | ") || !line.contains("showing")),
		"{error}"
	);
}

// ------------------------------------------------------------- feedback

/// Suggested anchors are headers the hunk parser reads as anchors: a file
/// line that would parse as a line hint is never suggested.
#[tokio::test]
async fn patch_suggestions_parse_as_anchors() {
	let error =
		refused(EditMode::Patch, "section\nx = 1\nline 7\nx = 1\n", patch("@@\n-x = 1\n+x = 2"))
			.await;
	for anchor in suggested_anchors(&error) {
		let hunks = parse_diff_hunks(&format!("@@ {anchor}\n+x")).expect("suggestion parses");
		assert_eq!(hunks[0].change_context.as_deref(), Some(anchor.as_str()), "{error}");
	}
}

/// Every pre-write refusal of the text-matching modes says, exactly once and
/// as its own sentence, that nothing was written: placement refusals,
/// undecodable targets, plan mode, incomplete arguments, empty payloads, and
/// single- and multi-file `apply_patch`.
#[tokio::test]
async fn refusals_state_that_no_changes_were_applied() {
	let mut errors = vec![
		refused(
			EditMode::Replace,
			"a\n",
			json!({ "path": PATH, "old_string": "missing", "new_string": "b" }),
		)
		.await,
		refused(EditMode::Patch, "a\n", patch("@@\n-missing\n+b")).await,
		refused(EditMode::Patch, "x\nx\n", patch("@@\n-x\n+y")).await,
	];

	let workspace = Workspace::new(EditMode::Patch);
	std::fs::write(workspace.cwd().join(PATH), b"\xff\n").expect("write undecodable bytes");
	let writer = DiskWriter::default();
	let result = workspace.apply_json(&patch("@@\n-x\n+y"), &writer).await;
	errors.push(result.expect_err("undecodable target").to_string());
	assert_eq!(writer.requests.lock().len(), 0);

	let mut workspace = Workspace::new(EditMode::Replace);
	workspace.config.policy.plan_active = true;
	workspace.write(PATH, "one\n");
	let writer = DiskWriter::default();
	let result = workspace
		.apply_json(&json!({ "path": PATH, "old_string": "one", "new_string": "two" }), &writer)
		.await;
	errors.push(result.expect_err("plan mode").to_string());
	assert_eq!(writer.requests.lock().len(), 0);

	let workspace = Workspace::new(EditMode::Patch);
	workspace.write(PATH, "a\n");
	let mut session = workspace.session();
	session.set_args_json(&patch("@@\n-a\n+b").to_string()[..20]);
	let writer = DiskWriter::default();
	let result = session
		.apply(pi_edit::ApplyRequest::default(), &writer)
		.await;
	errors.push(result.expect_err("incomplete arguments").to_string());
	assert_eq!(writer.requests.lock().len(), 0);

	errors.push(refused(EditMode::Patch, "a\n", patch("@@\n a\n-missing\n+b")).await);
	errors.push(refused(EditMode::Patch, "a\n", json!({ "path": PATH, "edits": [] })).await);
	// The closest-match preview quotes a file line that ends a sentence.
	errors.push(
		refused(EditMode::Patch, "intro\nDone.\n", patch("@@\n intro\n-Finished.\n+Complete.")).await,
	);

	for (files, input) in [
		(&[("a.txt", "a\n")][..], "*** Update File: a.txt\n@@\n-missing\n+changed\n"),
		(
			&[("a.txt", "a\n"), ("b.txt", "value\n")][..],
			"*** Update File: a.txt\n@@\n-a\n+A\n*** Update File: b.txt\n@@\n-missing\n+changed\n",
		),
		(&[("a.txt", "a\n")][..], ""),
	] {
		let workspace = Workspace::new(EditMode::ApplyPatch);
		for (name, body) in files {
			workspace.write(name, body);
		}
		let writer = DiskWriter::default();
		let result = workspace
			.apply_raw(&format!("*** Begin Patch\n{input}*** End Patch"), &writer)
			.await;
		errors.push(result.expect_err("missing lines").to_string());
		assert_eq!(writer.requests.lock().len(), 0);
		for (name, body) in files {
			assert_eq!(workspace.read(name).as_deref(), Some(*body));
		}
	}

	for error in errors {
		let notices = error.matches("No changes were applied").count()
			+ error.matches("No files were modified").count();
		assert_eq!(notices, 1, "{error}");
		assert!(error.ends_with('.'), "{error}");
		// The notice is its own sentence, never glued onto quoted text: after a
		// one-line message, or on its own line.
		if let Some((before, _)) = error.rsplit_once("No changes were applied.") {
			assert!(
				before.ends_with('\n') || (!before.contains('\n') && before.ends_with(". ")),
				"{error}"
			);
		}
	}
}
