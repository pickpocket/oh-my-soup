//! Atomic placement across native scopes, retained origins and logical phases.
mod common;

use std::fmt::Write as _;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::{Value, json};

fn request(mode: EditMode, file: &str, diffs: &[&str]) -> Value {
	if mode == EditMode::ApplyPatch {
		let mut input = String::from("*** Begin Patch\n");
		for diff in diffs {
			writeln!(input, "*** Update File: {file}\n{diff}").unwrap();
		}
		input.push_str("*** End Patch");
		json!({"input": input})
	} else {
		json!({"path": file, "edits": diffs.iter().map(|diff| json!({"op": "update", "diff": diff})).collect::<Vec<_>>()})
	}
}

async fn check(mode: EditMode, file: &str, original: &str, diffs: &[&str], expected: Option<&str>) {
	let ws = Workspace::new(mode);
	ws.write(file, original);
	let writer = DiskWriter::default();
	let result = ws.apply_json(&request(mode, file, diffs), &writer).await;
	let writes = writer.requests.lock().len();
	let after = ws.read(file).unwrap();
	if let Some(expected) = expected {
		assert!(result.is_ok(), "{mode:?} {file}: {result:?}");
		assert_eq!(writes, 1, "{mode:?} {file}: successful single-file request writes once");
		assert_eq!(after, expected, "{mode:?} {file}");
	} else {
		assert!(result.is_err(), "{mode:?} {file}: expected refusal, got {after:?}");
		assert_eq!(writes, 0, "{mode:?} {file}: refusal must not write");
		assert_eq!(after, original, "{mode:?} {file}: refusal must preserve original bytes");
	}
}

async fn both(file: &str, original: &str, diff: &str, expected: Option<&str>) {
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		check(mode, file, original, &[diff], expected).await;
	}
}

async fn orders(file: &str, original: &str, hunks: &[&str], expected: Option<&str>) {
	let permutations: &[&[usize]] = match hunks.len() {
		2 => &[&[0, 1], &[1, 0]],
		3 => &[&[0, 1, 2], &[0, 2, 1], &[1, 0, 2], &[1, 2, 0], &[2, 0, 1], &[2, 1, 0]],
		_ => panic!("two or three independent hunks required"),
	};
	for permutation in permutations {
		let diff = permutation
			.iter()
			.map(|&at| hunks[at])
			.collect::<Vec<_>>()
			.join("\n");
		both(file, original, &diff, expected).await;
	}
}

#[tokio::test]
async fn required_deep_native_and_metadata_proofs_refuse_atomically() {
	for depth in [16, 2048] {
		let original = format!("{}\n0\n{}\n", "[".repeat(depth), "]".repeat(depth));
		let diff = format!("@@ {}\n-0\n+1", "[".repeat(depth));
		let expected = original.replace("\n0\n", "\n1\n");
		both("deep.json", &original, &diff, (depth == 16).then_some(expected.as_str())).await;
	}
	let original = "defmodule M do\n  @doc \"F docs\"\n  def f(), do: :ok\nend\n";
	for depth in [16, 161] {
		let attribute = format!("@impl {}true{}", "(".repeat(depth), ")".repeat(depth));
		let diff = format!("@@\n   @doc \"F docs\"\n+  {attribute}");
		let expected = original.replace("  def f()", &format!("  {attribute}\n  def f()"));
		both("depth.ex", original, &diff, (depth == 16).then_some(expected.as_str())).await;
	}
}

#[tokio::test]
async fn certain_ancestor_bounds_cover_changes_and_inserted_gaps() {
	let original = "function f() {\n  one();\n}\nfunction g() {\n  two();\n}\n";
	both(
		"scope.js",
		original,
		"@@ function f() {\n   one();\n }\n function g() {\n-  two();\n+  changed();",
		None,
	)
	.await;
	both("scope.js", original, "@@ function f() {\n   one();\n }\n+outside();", None).await;
	let expected = original.replace("one();", "first();");
	both("scope.js", original, "@@ function f() {\n-  one();\n+  first();", Some(&expected)).await;
	let original = "# Same\n\nfirst\n\n# Same\n\nsecond\n";
	both(
		"scope.md",
		original,
		"@@ # Same\n first\n \n+added\n+",
		Some("# Same\n\nfirst\n\nadded\n\n# Same\n\nsecond\n"),
	)
	.await;
}

#[tokio::test]
async fn unresolved_middle_anchor_cannot_target_another_nested_branch() {
	let original = "function unique() {\n  if (ready) {\n    while (intended) {\n      work(x1);\n    }\n  }\n  if (ready) {\n    while (other) {\n      work(x);\n    }\n  }\n}\n";
	let diff =
		"@@ function unique() {\n@@ if (ready) {\n@@ while (intended) {\n-      work(x);\n+      \
		 changed();";
	both("chain.js", original, diff, None).await;
	let original = original
		.replace("if (ready)", "if (first)")
		.replacen("work(x1);", "work(x);", 1)
		.replacen("while (other)", "while (later)", 1);
	let diff =
		"@@ function unique() {\n@@ if (first) {\n@@ while (intended) {\n-      work(x);\n+      \
		 changed();";
	let original = original.replacen(
		"  if (first) {\n    while (later)",
		"  if (second) {\n    while (later)",
		1,
	);
	let expected = original.replacen("work(x);", "changed();", 1);
	both("chain.js", &original, diff, Some(&expected)).await;
}

#[tokio::test]
async fn fuzzy_headers_require_native_code_not_long_mentions() {
	let name = format!("intended_function_header_{}", "long".repeat(40));
	let diff = format!("@@ function {name}(y) {{\n-  target();\n+  changed();");
	let original =
		format!("const z = 0; if (ready) {{ /* function {name}(x) {{ */\n  target();\n}}\n");
	both("header.js", &original, &diff, None).await;
	let original =
		format!("function {name}(x) {{\n  target();\n}}\nfunction other() {{\n  target();\n}}\n");
	let expected = original.replacen("target();", "changed();", 1);
	both("header.js", &original, &diff, Some(&expected)).await;
}

#[tokio::test]
async fn case_anchors_never_fall_through_to_another_native_section() {
	let original = "function f(x) {\n  switch (x) {\n    case 1:\n      other();\n      break;\n    default:\n      target();\n      break;\n  }\n}\n";
	both("case.js", original, "@@ case 1:\n-      target();\n+      changed();", None).await;
	let original = original.replace("other();", "target();");
	let expected = original.replacen("target();", "changed();", 1);
	both("case.js", &original, "@@ case 1:\n-      target();\n+      changed();", Some(&expected))
		.await;
}

#[tokio::test]
async fn mixed_identity_pivots_keep_original_documentation_owners() {
	let original = "const BEFORE: i32 = 0;\n/// Original f docs\n// Original note\nfn f() {}\nfn \
	                tail() {}\nconst END: i32 = 0;\n";
	for header in ["@@", "@@ -1,3 +1,4 @@"] {
		let capture = format!(
			"{header}\n-const BEFORE: i32 = 0;\n-/// Original f docs\n-// Original note\n+const \
			 BEFORE: i32 = 1;\n+/// Original f docs\n+fn g() {{}}\n+// Changed note"
		);
		let tail = "@@\n-fn tail() {}\n+fn tail2() {}";
		let end = "@@\n-const END: i32 = 0;\n+const END: i32 = 1;";
		both("origin.rs", original, &capture, None).await;
		orders("origin.rs", original, &[&capture, tail], None).await;
		orders("origin.rs", original, &[&capture, tail, end], None).await;
		let first = "@@\n-const END: i32 = 0;\n+const END: i32 = 1;";
		for mode in [EditMode::Patch, EditMode::ApplyPatch] {
			check(mode, "origin.rs", original, &[first, &capture], None).await;
		}
		let safe = format!(
			"{header}\n-const BEFORE: i32 = 0;\n-/// Original f docs\n-// Original note\n+const \
			 BEFORE: i32 = 1;\n+fn g() {{}}\n+/// Original f docs\n+// Changed note"
		);
		both(
			"origin.rs",
			original,
			&safe,
			Some(
				"const BEFORE: i32 = 1;\nfn g() {}\n/// Original f docs\n// Changed note\nfn f() \
				 {}\nfn tail() {}\nconst END: i32 = 0;\n",
			),
		)
		.await;
	}
}

#[tokio::test]
async fn top_gap_preserves_original_owner_without_a_fake_predecessor() {
	both("root.toml", "value = 1\n", "@@ top of file\n+[g]", None).await;
	both("root.toml", "value = 1\n", "@@ top of file\n+other = 2", Some("other = 2\nvalue = 1\n"))
		.await;
	both("root.toml", "value = 1\n", "@@ top of file\n+# license", Some("# license\nvalue = 1\n"))
		.await;
	both("root.toml", "", "@@ top of file\n+[g]\n+value = 1", Some("[g]\nvalue = 1")).await;
}

#[tokio::test]
async fn metadata_certification_follows_evaluated_not_inert_quoted_definitions() {
	let original = "defmodule M do\n  @doc \"F docs\"\n  def f(), do: :ok\nend\n";
	for attribute in [
		"@impl (Kernel.def(g(), do: :new); true)",
		"@doc quote(do: unquote((def g(), do: :new)))",
		"@doc quote bind_quoted: [value: (def g(), do: :new)] do value end",
	] {
		both("metadata.ex", original, &format!("@@\n   @doc \"F docs\"\n+  {attribute}"), None).await;
	}
	for attribute in ["@impl (true)", "@impl quote(do: def(hidden(), do: :ok))"] {
		let expected = original.replace("  def f()", &format!("  {attribute}\n  def f()"));
		both(
			"metadata.ex",
			original,
			&format!("@@\n   @doc \"F docs\"\n+  {attribute}"),
			Some(&expected),
		)
		.await;
	}
}

#[tokio::test]
async fn partial_words_cannot_split_or_join_preserved_suffix_arguments() {
	for (file, prefix) in
		[("word.sh", ""), ("Makefile", "all:\n\t"), ("Dockerfile", "FROM alpine\nRUN ")]
	{
		let original = format!("{prefix}printf oldKEEP\n");
		both(file, &original, "@@\n-old\n+fresh ", None).await;
		let expected = original.replace("old", "fresh");
		both(file, &original, "@@\n-old\n+fresh", Some(&expected)).await;
		let original = format!("{prefix}printf old KEEP\n");
		both(file, &original, "@@\n-old \n+fresh", None).await;
	}
}

#[tokio::test]
async fn docker_host_phase_keeps_comments_whitespace_and_execution_membership() {
	let original = "FROM alpine\r\nRUN printf old \\ \t\r\n  # host1\r\n\t# host2\r\n&& \
	                keep\r\nRUN printf later\r\n";
	both("Dockerfile", original, "@@\n-RUN printf old \\ \t\n+RUN printf fresh # \\ \t", None).await;
	let expected = original.replace("printf old", "printf fresh");
	both(
		"Dockerfile",
		original,
		"@@\n-RUN printf old \\ \t\n+RUN printf fresh \\ \t",
		Some(&expected),
	)
	.await;
}

#[tokio::test]
async fn heredoc_splices_cannot_capture_retained_terminators() {
	let original = "cat <<-EOF\r\nold\r\n\tEOF\r\nprintf keep\r\n";
	both("heredoc.sh", original, "@@\n-old\n+fresh\\\n \tEOF", None).await;
	let expected = original.replace("old", "fresh\\\\");
	both("heredoc.sh", original, "@@\n-old\n+fresh\\\\", Some(&expected)).await;
	let original = "cat <<-'EOF'\r\nold\r\n\tEOF\r\nprintf keep\r\n";
	let expected = original.replace("old", "fresh\\");
	both("heredoc.sh", original, "@@\n-old\n+fresh\\", Some(&expected)).await;
}

#[tokio::test]
async fn python_successors_require_certain_complete_statement_membership() {
	for statement in ["return keep()", "assert keep()", "raise Keep()", "pass", "yield keep()"] {
		let original = format!("def f():\n    value = 1\n    {statement}\n");
		for slash in ["\\", "\\ \t"] {
			let diff = format!("@@\n-    value = 1\n+    value = 2 + {slash}\n     {statement}");
			both("statement.py", &original, &diff, None).await;
		}
	}
	let original = "def f():\n    if ready():\n        return 1\n    elif old \\\n        and \
	                keep():\n        return 2\n";
	let expected = original.replace("elif old", "elif fresh");
	both("statement.py", original, "@@\n-old\n+fresh", Some(&expected)).await;
	let original = "def f():\n    value = 1\n    return keep()\n";
	both(
		"statement.py",
		original,
		"@@\n-    value = 1\n+    value = 2\n     return keep()",
		Some("def f():\n    value = 2\n    return keep()\n"),
	)
	.await;
}

#[tokio::test]
async fn removed_edges_and_payload_owner_changes_protect_retained_successors() {
	for (file, original, diff) in [
		("remove.sh", "printf old\\\nKEEP\n", "@@\n-printf old\\\n+printf fresh\n KEEP"),
		(
			"remove.py",
			"def f():\n    value = old \\\n    + keep()\n",
			"@@\n-    value = old \\\n+    value = fresh\n     + keep()",
		),
		(
			"remove.c",
			"#define VALUE old \\\n  + keep()\n",
			"@@\n-#define VALUE old \\\n+#define VALUE fresh\n   + keep()",
		),
	] {
		both(file, original, diff, None).await;
	}
	both(
		"remove.sh",
		"printf old\\\nKEEP\n",
		"@@\n-printf old\\\n-KEEP\n+printf fresh\n+OTHER",
		Some("printf fresh\nOTHER\n"),
	)
	.await;
	let original = "FROM alpine\nSHELL [\"sh\", \"-c\"]\nRUN printf held \\\n    KEEP\n";
	both("Dockerfile", original, "@@\n-SHELL [\"sh\", \"-c\"]\n+SHELL [\"opaque\", \"-c\"]", None)
		.await;
}

#[tokio::test]
async fn three_independent_old_edges_refuse_in_every_order_and_sequentially() {
	let original = "printf old_a\\\nA_KEEP\nprintf old_b\\\nB_KEEP\nprintf old_c\\\nC_KEEP\n";
	let hunks = [
		"@@\n-printf old_a\\\n+printf fresh_a",
		"@@\n-printf old_b\\\n+printf fresh_b",
		"@@\n-printf old_c\\\n+printf fresh_c",
	];
	for hunk in hunks {
		both("three.sh", original, hunk, None).await;
	}
	orders("three.sh", original, &hunks, None).await;
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		check(
			mode,
			"three.sh",
			original,
			&["@@\n-old_a\n+changed_a", "@@\n-printf changed_a\\\n+printf released"],
			None,
		)
		.await;
	}
}

#[tokio::test]
async fn composed_root_owner_and_lexical_hunks_refuse_in_all_six_orders() {
	let original = "Original paragraph.\n\n```sh\nprintf old\\\nKEEP\n```\n\nTail paragraph.\n";
	let hunks = [
		"@@ top of file\n+- new item",
		"@@\n-printf old\\\n+printf fresh",
		"@@\n-Tail paragraph.\n+Changed tail.",
	];
	orders("root.md", original, &hunks, None).await;
}

#[tokio::test]
async fn exact_context_headers_keep_native_footprints() {
	let original = "function process() {\n    return 1;\n}\n\nfunction process() {\n    return \
	                2;\n}\n\nfunction process() {\n    return 3;\n}\n";
	let expected = original.replace("return 2;", "return 200;");
	both(
		"context.js",
		original,
		"@@ -9,3 +9,3 @@ function process() {\n function process() {\n-    return 2;\n+    return \
		 200;\n }",
		Some(&expected),
	)
	.await;
	let original = "def helper():\n    return 0\n\nclass A:\n    def helper():\n        return 1\n";
	let expected = original.replace("return 1", "return 2");
	both(
		"context.py",
		original,
		"@@ def helper():\n     def helper():\n-        return 1\n+        return 2",
		Some(&expected),
	)
	.await;
	both(
		"context.py",
		"def pin():\n    return 0\nclass Group:\n      def pin():\n          return 9\n",
		"@@ def pin():\n     def pin():\n-        return 9\n+        return 10",
		None,
	)
	.await;
	let original = "function pin() {\n  own();\n}\nfunction later() {\n  target();\n}\n";
	both(
		"context.js",
		original,
		"@@ function pin() {\n function pin() {\n   own();\n }\n function later() {\n-  \
		 target();\n+  changed();",
		None,
	)
	.await;
	let original = "function certain() {\n  if (ready) {\n    first();\n  }\n}\nfunction other() \
	                {\n  if (ready) {\n    target();\n  }\n}\n";
	both(
		"context.js",
		original,
		"@@ function certain() {\n@@ if (ready) {\n   if (ready) {\n-    target();\n+    \
		 changed();\n   }",
		None,
	)
	.await;
}

#[tokio::test]
async fn native_anchor_candidates_do_not_accept_literal_host_domains() {
	let source = "function guarded() {\n  first();\n}\nconst text = `\nfunction guarded() \
	              {\n`;\nfunction neighbor() {\n  old();\n}\n";
	let diff = "@@ function guarded() {\n function guarded() {\n `;\n function neighbor() {\n-  \
	            old();\n+  fresh();\n }";
	both("literal.js", source, diff, None).await;
	both("literal.html", &format!("<script>\n{source}</script>\n"), diff, None).await;
	both("literal.md", &format!("```javascript\n{source}```\n"), diff, None).await;
}

#[tokio::test]
async fn complete_author_chains_and_whole_headers_keep_their_boundaries() {
	let original = "module dut;\ninitial begin : outer\n  // first\n  x = a;\nend\ninitial begin : \
	                other\n  x = a;\nend\nendmodule\n";
	let expected = original.replacen("x = a;", "x = b;", 1);
	both("label.v", original, "@@ begin : outer\n-  x = a;\n+  x = b;", Some(&expected)).await;
	let original = "function repeated() {\n  if (ready) {\n    first();\n  }\n}\nfunction \
	                repeated() {\n  if (ready) {\n    target();\n  }\n}\n";
	both(
		"chain.js",
		original,
		"@@ function repeated() {\n@@ if (ready) {\n   if (ready) {\n-    target();\n+    \
		 changed();\n   }",
		None,
	)
	.await;
}

#[tokio::test]
async fn certified_single_row_gap_requires_a_pure_anchor_insertion() {
	let original = "#[inline] fn one() {}";
	both(
		"gap.rs",
		original,
		"@@ #[inline] fn one() {}\n+fn two() {}",
		Some("#[inline] fn one() {}\nfn two() {}"),
	)
	.await;
	both("gap.rs", original, "@@ #[inline] fn one() {}\n #[inline] fn one() {}\n+fn two() {}", None)
		.await;
}

#[tokio::test]
async fn unterminated_eof_backslashes_do_not_create_successor_edges() {
	let padding = "p".repeat(4 * 1024 * 1024);
	let original = format!("const value = old;\n// {padding}\n// EOF \\");
	let expected = original.replacen("const value = old;", "const value = fresh;", 1);
	both(
		"eof.js",
		&original,
		"@@ -1,1 +1,1 @@\n-const value = old;\n+const value = fresh;",
		Some(&expected),
	)
	.await;
	let original = format!("const value = old;\n// {padding}\nconst tail = old;");
	let expected = original.replacen("const tail = old;", "// EOF \\", 1);
	both("eof.js", &original, "@@ -3,1 +3,1 @@\n-const tail = old;\n+// EOF \\", Some(&expected))
		.await;
	both("edge.sh", "printf old\nKEEP\n", "@@\n-printf old\n+printf fresh \\\n KEEP", None).await;
}

#[tokio::test]
async fn exact_internal_hierarchies_never_promote_weaker_whole_text() {
	let original = "section alpha:\n  marker\n  value\nsection alpha:\n  marker\n  value\nsection \
	                alpha: markerz\ntail:\n  unique nine\n";
	let unhinted = "@@ section alpha: marker\n+  NEW";
	let wrong_hint = "@@ -7,0 +7,1 @@ section alpha: marker\n+  NEW";
	let hinted = "@@ -3,0 +3,1 @@ section alpha: marker\n+  NEW";
	let neighbor = "@@\n-  unique nine\n+  UNIQUE NINE";
	let expected = original.replacen("  marker\n", "  marker\n  NEW\n", 1);
	let paired = expected.replace("  unique nine\n", "  UNIQUE NINE\n");
	for (diff, wanted) in [(unhinted, None), (wrong_hint, None), (hinted, Some(expected.as_str()))] {
		both("hierarchy.yml", original, diff, wanted).await;
		orders("hierarchy.yml", original, &[diff, neighbor], wanted.map(|_| paired.as_str())).await;
	}
	let incomplete = "section alpha:\n  marker\n  value\nsection alpha:\n  absent\n  \
	                  target\nsection alpha: markerz\ntail:\n  unique nine\n";
	both("hierarchy.yml", incomplete, "@@ section alpha: marker\n-  target\n+  CHANGED", None).await;
	let original = "section alpha:\n  marker\n  first\nsection alpha:\n  marker\n  second\nsection \
	                alpha: markerz\n";
	both(
		"hierarchy.yml",
		original,
		"@@ section alpha: marker\n-  first\n+  FIRST",
		Some(
			"section alpha:\n  marker\n  FIRST\nsection alpha:\n  marker\n  second\nsection alpha: \
			 markerz\n",
		),
	)
	.await;
	let expected = expected.replace("tail:\n", "later:\n");
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		check(
			mode,
			"hierarchy.yml",
			"section alpha:\n  marker\n  value\nsection alpha:\n  marker\n  value\nsection alpha: \
			 markerz\ntail:\n  unique nine\n",
			&["@@\n-tail:\n+later:", hinted],
			Some(&expected),
		)
		.await;
	}
	let source = "namespace root child:\n  selected:\n    inside: one\n  target: \
	              original\nnamespace root child:\n  selected:\n    inside: two\n  target: \
	              other\nnamespace root child: selected:Z\ntail:\n  unique: tail\n";
	both(
		"hierarchy.yml",
		source,
		"@@ namespace root child: selected:\n-  target: original\n+  target: changed",
		None,
	)
	.await;
	let inside = source.replacen("inside: one", "inside: changed", 1);
	both(
		"hierarchy.yml",
		source,
		"@@ namespace root child: selected:\n-    inside: one\n+    inside: changed",
		Some(&inside),
	)
	.await;
	let source = "{\n  \"root\":\n  {\n    \"selected\":\n    {\n      \"inside\": \"one\"\n    \
	              },\n    \"target\": \"original\"\n  },\n  \"root\":\n  {\n    \"selected\":\n    \
	              {\n      \"inside\": \"two\"\n    },\n    \"target\": \"other\"\n  }\n}\n";
	both(
		"hierarchy.json",
		source,
		"@@ \"root\": \"selected\":\n-    \"target\": \"original\"\n+    \"target\": \"changed\"",
		None,
	)
	.await;
	let inside = source.replacen("\"inside\": \"one\"", "\"inside\": \"changed\"", 1);
	both(
		"hierarchy.json",
		source,
		"@@ \"root\": \"selected\":\n-      \"inside\": \"one\"\n+      \"inside\": \"changed\"",
		Some(&inside),
	)
	.await;
	let source = "<script lang=\"unknown\">\nROOT\n</script>\n<script \
	              lang=\"unknown\">\nROOT\n</script>\n<script lang=\"unknown\">\nROOT \
	              marker:z\n</script>\n<script>\nmarker:\n{\n  target();\n}\n</script>\n";
	for diff in [
		"@@ ROOT marker:\n-  target();\n+  changed();",
		"@@ -2,1 +2,1 @@ ROOT marker:\n-  target();\n+  changed();",
	] {
		both("hierarchy.svelte", source, diff, None).await;
	}
	let supported = source.replacen("target();", "changed();", 1);
	both("hierarchy.svelte", source, "@@ marker:\n-  target();\n+  changed();", Some(&supported))
		.await;
}
