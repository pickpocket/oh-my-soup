//! Certified scope, retained-unit ownership and atomic composed placement.
mod common;

use std::fmt::Write as _;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
enum Expected<'a> {
	Bytes(&'a str),
	BytesAny(&'a [&'a str]),
	BytesOrRefuse(&'a str),
	Refuse,
}

fn patch(file: &str, diff: &str) -> Value {
	json!({"path": file, "edits": [{"op": "update", "diff": diff}]})
}

async fn check(file: &str, original: &str, args: Value, expected: Expected<'_>) -> (bool, String) {
	let ws = Workspace::new(EditMode::Patch);
	ws.write(file, original);
	let writer = DiskWriter::default();
	let result = ws.apply_json(&args, &writer).await;
	let writes = writer.requests.lock().len();
	let after = ws.read(file).unwrap_or_default();
	if let Err(error) = &result {
		assert!(matches!(expected, Expected::Refuse | Expected::BytesOrRefuse(_)), "{file}: {error}");
		assert_eq!(writes, 0, "{file}: a refused request wrote files");
		assert_eq!(after, original, "{file}: a refused request changed bytes");
	} else {
		match expected {
			Expected::Bytes(bytes) | Expected::BytesOrRefuse(bytes) => {
				assert_eq!(after, bytes, "{file}");
			},
			Expected::BytesAny(bytes) => assert!(bytes.contains(&after.as_str()), "{file}: {after:?}"),
			Expected::Refuse => panic!("{file}: expected atomic refusal, got {after:?}"),
		}
		assert_eq!(writes, 1, "{file}: successful single-file request writes once");
	}
	(result.is_ok(), after)
}

async fn orders(file: &str, original: &str, hunks: &[&str], expected: Expected<'_>) {
	let permutations: &[&[usize]] = match hunks.len() {
		2 => &[&[0, 1], &[1, 0]],
		3 => &[&[0, 1, 2], &[0, 2, 1], &[1, 0, 2], &[1, 2, 0], &[2, 0, 1], &[2, 1, 0]],
		_ => panic!("only two or three independent hunks"),
	};
	let mut first = None;
	for permutation in permutations {
		let mut diff = String::with_capacity(hunks.iter().map(|hunk| hunk.len() + 1).sum());
		for &index in *permutation {
			diff.push_str(hunks[index]);
			diff.push('\n');
		}
		let outcome = check(file, original, patch(file, &diff), expected).await;
		if let Some(first) = &first {
			assert_eq!(&outcome, first, "{file}: order {permutation:?}");
		} else {
			first = Some(outcome);
		}
	}
}

#[tokio::test]
async fn native_labels_and_attributed_wrappers_keep_the_selected_construct() {
	for (file, source, header, from, to) in [
		(
			"label.cpp",
			"void f() {\nouter:\n[[likely]]\n/* first */\ninner:\n[[likely]]\nwhile (ready) {\n  \
			 notify(x);\n}\n}\nvoid g() {\n  notify(x);\n}\n",
			"outer:",
			"notify(x);",
			"notify(y);",
		),
		(
			"label.rs",
			"fn f() {\n  'outer:\n  loop {\n    notify(x);\n  }\n}\nfn g() {\n    notify(x);\n}\n",
			"'outer:",
			"notify(x);",
			"notify(y);",
		),
		(
			"label.ps1",
			"function f {\n:outer while ($ready) {\n  # first\n  Notify $x\n}\n}\nfunction g {\n  \
			 Notify $x\n}\n",
			":outer while ($ready) {",
			"Notify $x",
			"Notify $y",
		),
		(
			"label.f90",
			"subroutine f()\nouter: do while (ready)\n  call notify(x)\nend do outer\nend subroutine \
			 f\nsubroutine g()\n  call notify(x)\nend subroutine g\n",
			"outer: do while (ready)",
			"call notify(x)",
			"call notify(y)",
		),
	] {
		let changed = source.lines().find(|line| line.contains(from)).unwrap();
		let replacement = changed.replace(from, to);
		let diff = format!("@@ {header}\n-{changed}\n+{replacement}");
		check(file, source, patch(file, &diff), Expected::Bytes(&source.replacen(from, to, 1))).await;
	}
}

#[tokio::test]
async fn nontraditional_case_anchors_refuse_on_the_normal_stack() {
	let source = "class C {\n  void f(int x) {\n    switch (x) {\n      case 1 -> {\n        \
	              target();\n      }\n      default -> {}\n    }\n  }\n}\n";
	check(
		"rule.java",
		source,
		patch("rule.java", "@@ case 1 -> {\n+      }\n+      case 2 -> {"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn excessive_label_resolution_is_uncertain_not_missing() {
	let mut source = String::from("void f(void) {\n");
	for index in 0..140 {
		writeln!(source, "label_{index}:").unwrap();
	}
	source.push_str("  target();\n}\nvoid g(void) {\n  target();\n}\n");
	check(
		"deep.c",
		&source,
		patch("deep.c", "@@ label_0:\n-  target();\n+  changed();"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn anchor_positions_and_case_fold_ranks_do_not_use_literal_mentions() {
	for (file, source, diff, expected) in [
		("position.js", "function f() { /* if (ready) { */ if (ready) {\n  notify(x);\n}\n}\nfunction g() {\n  notify(x);\n}\n", "@@ if (ready) {\n-  notify(x);\n+  notify(y);", Expected::BytesOrRefuse("function f() { /* if (ready) { */ if (ready) {\n  notify(y);\n}\n}\nfunction g() {\n  notify(x);\n}\n")),
		("fold.js", "function f() {\n  if (ready) {\n    notify(x);\n  }\n}\nfunction g() {\n  if (ready) {\n    notify(x);\n  }\n}\n", "@@ function f() {\n@@ IF (ready) {\n-    notify(x);\n+    notify(y);", Expected::Bytes("function f() {\n  if (ready) {\n    notify(y);\n  }\n}\nfunction g() {\n  if (ready) {\n    notify(x);\n  }\n}\n")),
		("prefix.js", "function F() { // intended\n  notify(x);\n}\nfunction f() {\n  notify(x);\n}\n", "@@ function F() {\n-  notify(x);\n+  notify(y);", Expected::Bytes("function F() { // intended\n  notify(y);\n}\nfunction f() {\n  notify(x);\n}\n")),
		("comment.yml", "first: # second:\n  value: old\nsecond:\n  value: old1\n", "@@ first: # second:\n-  value: old\n+  value: new", Expected::Bytes("first: # second:\n  value: new\nsecond:\n  value: old1\n")),
		("bom.toml", "\u{feff}[first]\r\nvalue = \"old\"\r\n[second]\r\nvalue = \"old\"\r\n", "@@ [first]\n-value = \"old\"\n+value = \"new\"", Expected::Bytes("\u{feff}[first]\r\nvalue = \"new\"\r\n[second]\r\nvalue = \"old\"\r\n")),
	] {
		check(file, source, patch(file, diff), expected).await;
	}
}

#[tokio::test]
async fn found_uncertain_headers_are_not_genuinely_absent_headers() {
	let source = "function f() { const note = \"function target() {\";\n  notify(x1);\n}\nfunction \
	              g() {\n  notify(x);\n}\n";
	check(
		"literal.js",
		source,
		patch("literal.js", "@@ function target() {\n-  notify(x);\n+  notify(y);"),
		Expected::Refuse,
	)
	.await;
	check(
		"literal.js",
		source,
		patch("literal.js", "@@ genuinely_absent_named_target\n-  notify(x);\n+  notify(y);"),
		Expected::Bytes(&source.replace("  notify(x);", "  notify(y);")),
	)
	.await;
	let errorful =
		"function f() {\n  notify(x1);\n  bad = = 1;\n}\nfunction g() {\n  notify(x);\n}\n";
	check(
		"error.js",
		errorful,
		patch("error.js", "@@ function f() {\n-  notify(x);\n+  notify(y);"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn duplicate_constructs_and_mixed_payloads_keep_all_candidate_bounds() {
	let source = "function f() {\n  notify(x1);\n}\nfunction f() {\n  notify(x2);\n}\nfunction g() \
	              {\n  notify(x);\n}\n";
	check(
		"duplicate.js",
		source,
		patch("duplicate.js", "@@ function f() {\n-  notify(x);\n+  notify(y);"),
		Expected::Refuse,
	)
	.await;
	check(
		"duplicate.js",
		source,
		patch("duplicate.js", "@@ function f() {\n-  notify(x2);\n+  notify(y2);"),
		Expected::Bytes(&source.replace("notify(x2)", "notify(y2)")),
	)
	.await;
	let mixed = "<script lang=\"unknown\">\nfunction f() {\n  \
	             notify(x1);\n}\n</script>\n<script>\nfunction f() {\n  notify(x2);\n}\nfunction \
	             g() {\n  notify(x);\n}\n</script>\n";
	check(
		"mixed.svelte",
		mixed,
		patch("mixed.svelte", "@@ function f() {\n-  notify(x);\n+  notify(y);"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn mapped_host_domains_and_json_keys_never_rerank_outside_candidates() {
	let source =
		"<script>\n// ordinary note\nnotify(x1);\n</script>\n<script>\nnotify(x);\n</script>\n";
	for header in ["@@ // ordinary note", "@@ -3,1 +3,1 @@ // ordinary note"] {
		check(
			"domain.html",
			source,
			patch("domain.html", &format!("{header}\n-notify(x);\n+notify(y);")),
			Expected::Refuse,
		)
		.await;
	}
	let source = "<script>\n// ordinary note\nfirst();\nsecond();\n</script>\n";
	check(
		"domain.html",
		source,
		patch("domain.html", "@@ // ordinary note\n+prepare();\n first();"),
		Expected::Bytes("<script>\n// ordinary note\nprepare();\nfirst();\nsecond();\n</script>\n"),
	)
	.await;
	let source =
		"<script type=\"application/json\">\n{\n  \"first\": {\n    \"value\": \"old1\"\n  },\n  \
		 \"second\": {\n    \"value\": \"old\"\n  }\n}\n</script>\n";
	check(
		"data.html",
		source,
		patch("data.html", "@@ \"first\": {\n-    \"value\": \"old\"\n+    \"value\": \"new\""),
		Expected::BytesOrRefuse(&source.replacen("old1", "new", 1)),
	)
	.await;
}

#[tokio::test]
async fn retained_pivots_and_mixed_blocks_keep_insertion_obligations() {
	for (file, source, diffs) in [
		("pivot.rs", "/// Original f docs\nfn f() {}\n", [
			"@@\n-/// Original f docs\n+/// Original f docs\n+fn g() {}",
			"@@ -1,1 +1,2 @@\n-/// Original f docs\n+/// Original f docs\n+fn g() {}",
		]),
		("pivot.js", "function f(ok) {\n  if (ok)\n    target();\n}\n", [
			"@@\n-  if (ok)\n+  if (ok)\n+    setup();",
			"@@ -2,1 +2,2 @@\n-  if (ok)\n+  if (ok)\n+    setup();",
		]),
	] {
		for diff in diffs {
			check(file, source, patch(file, diff), Expected::Refuse).await;
		}
	}
	let source = "/// Original f docs\nfn f() {}\nfn tail() {}\nfn other() {}\n";
	orders(
		"pivots.rs",
		source,
		&[
			"@@\n-/// Original f docs\n+/// Original f docs\n+fn g() {}",
			"@@\n-fn tail() {}\n+fn renamed_tail() {}",
			"@@\n-fn other() {}\n+fn renamed_other() {}",
		],
		Expected::Refuse,
	)
	.await;
	for header in ["@@", "@@ -1,1 +1,2 @@"] {
		check("sequence.rs", source, json!({"path":"sequence.rs","edits":[{"op":"update","diff":format!("{header}\n-/// Original f docs\n+/// Original f docs\n+fn g() {{}}")},{"op":"update","diff":"@@\n-fn tail() {}\n+fn renamed_tail() {}"}]}), Expected::Refuse).await;
	}
}

#[tokio::test]
async fn all_gap_counterfactuals_keep_rewrites_and_real_owner_capture_distinct() {
	orders(
		"array.js",
		"const values = [1];\nkeep();\n",
		&["@@\n-const values = [1];\n+const values = [", "@@\n const values = [1];\n+1];"],
		Expected::Bytes("const values = [\n1];\nkeep();\n"),
	)
	.await;
	orders(
		"array.html",
		"<script>\nconst values = [1];\nkeep();\n</script>\n",
		&["@@\n-const values = [1];\n+const values = [", "@@\n const values = [1];\n+1];"],
		Expected::Bytes("<script>\nconst values = [\n1];\nkeep();\n</script>\n"),
	)
	.await;
	orders(
		"rewrite.rs",
		"/// Original f docs\nfn f() {\n  work();\n}\n",
		&["@@\n-fn f() {\n+fn renamed_f() {", "@@\n /// Original f docs\n+fn g() {}"],
		Expected::Refuse,
	)
	.await;
	orders(
		"branch.js",
		"function f(ok) {\n  if (ok) {\n    before();\n    target();\n  }\n  end();\n}\n",
		&["@@\n     target();\n-  }\n   end();", "@@\n   if (ok) {\n+    setup();\n+  } else {"],
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn authored_continuations_cannot_capture_retained_logical_successors() {
	for (file, source, context, added, trailing, row) in [
		("logical.sh", "A=(\nold\nfoo\n)\n", "old", "bar\\", "foo", 2),
		(
			"logical.c",
			"void f(void) {\n  first();\n  keep();\n}\n",
			"  first();",
			"  // added \\",
			"  keep();",
			2,
		),
		(
			"logical.py",
			"def f():\n    first()\n    keep()\n",
			"    first()",
			"    value = 1 + \\",
			"    keep()",
			2,
		),
		(
			"Dockerfile",
			"FROM alpine\nRUN echo keep\n",
			"FROM alpine",
			"RUN echo added\\",
			"RUN echo keep",
			1,
		),
	] {
		for header in ["@@".to_owned(), format!("@@ -{row},2 +{row},3 @@")] {
			check(
				file,
				source,
				patch(file, &format!("{header}\n {context}\n+{added}\n {trailing}")),
				Expected::Refuse,
			)
			.await;
		}
	}
	let source = "A=(\nold\nfoo\n)\n";
	check(
		"authored.sh",
		source,
		patch("authored.sh", "@@\n old\n-foo\n+bar\\\n+newfoo"),
		Expected::Bytes("A=(\nold\nbar\\\nnewfoo\n)\n"),
	)
	.await;
}

#[tokio::test]
async fn preserved_escape_and_interpolation_units_keep_their_whole_provenance() {
	for (file, source, diff) in [
		("escape.sh", "printf old\\$KEEP\n", "@@\n-old\\\n+fresh"),
		("space.sh", "printf old\\ KEEP\n", "@@\n-old\\\n+fresh"),
		("escape.py", "text = \"\\N{LATIN CAPITAL LETTER A}KEEP\"\n", "@@\n-A}\n+B}"),
		("entity.html", "<div title=\"old&amp; KEEP\">body</div>\n", "@@\n-old&\n+fresh"),
		(
			"entity.vue",
			"<template><div :title=\"old &amp;&amp; keep\">body</div></template>\n",
			"@@\n-old &amp;\n+fresh |",
		),
		(
			"nested.js",
			"const text = `outer ${`inner ${old + keep()}`} END`;\n",
			"@@\n-old\n+fresh //",
		),
		("raw.py", "text = \"old\\nKEEP\"\n", "@@\n-text = \"old\n+text = r\"fresh"),
		("raw.cs", "var text = \"old{keep} END\";\n", "@@\n-var text = \"old\n+var text = $\"fresh"),
	] {
		check(file, source, patch(file, diff), Expected::Refuse).await;
	}
	for (file, source) in [
		("safe.sh", "printf old\\$KEEP\n"),
		("safe.js", "const text = `outer ${`inner ${old + keep()}`} END`;\n"),
		("safe.vue", "<template><div :title=\"old &amp;&amp; keep\">body</div></template>\n"),
	] {
		check(
			file,
			source,
			patch(file, "@@\n-old\n+fresh"),
			Expected::Bytes(&source.replace("old", "fresh")),
		)
		.await;
	}
}

#[tokio::test]
async fn fuzzy_authored_substitutions_do_not_authorize_omitted_units() {
	for (file, source, diff) in [
		(
			"fuzzy.rs",
			"fn f() {\n    let very_long_configuration_identifier = \"old \\nKEEP\";\n}\n",
			"@@ fn f() {\n-    let very_long_configuration_identifier = \"old\";\n+    let \
			 very_long_configuration_identifier = r\"fresh \\nKEEP\";",
		),
		(
			"fuzzy.py",
			"def f():\n    very_long_configuration_identifier = r\"old \\nKEEP\"\n",
			"@@ def f():\n-    very_long_configuration_identifier = r\"old\"\n+    \
			 very_long_configuration_identifier = \"fresh \\nKEEP\"",
		),
		(
			"fuzzy.js",
			"function f() {\n  const very_long_configuration_identifier = \"old n KEEP\";\n}\n",
			"@@ function f() {\n-  const very_long_configuration_identifier = \"old KEEP\";\n+  \
			 const very_long_configuration_identifier = \"fresh \\n KEEP\";",
		),
		(
			"fuzzy.sh",
			"if true; then\n  printf very_long_configuration_identifier\\$KEEP\nfi\n",
			"@@ if true; then\n-  printf very_long_configuration_identifier\\$\n+  printf fresh$KEEP",
		),
	] {
		check(file, source, patch(file, diff), Expected::Refuse).await;
	}
	let source = "function f() {\n  const very_long_configuration_identifier = old2;\n}\n";
	check(
		"authored.js",
		source,
		patch(
			"authored.js",
			"@@ function f() {\n-  const very_long_configuration_identifier = old1;\n+  const \
			 very_long_configuration_identifier = fresh;",
		),
		Expected::Bytes(&source.replace("old2", "fresh")),
	)
	.await;
}

#[tokio::test]
async fn mapped_embedded_execution_keeps_safe_edits_and_rejects_capture() {
	for (file, source, capture) in [
		("Dockerfile", "FROM alpine\nONBUILD RUN echo old && keep\n", "fresh #"),
		(
			"directive.vue",
			"<template>\n<div v-if=\"old + keep()\">body</div>\n</template>\n",
			"fresh //",
		),
		("Makefile", "define VALUE\n$(shell echo old && keep)\nendef\nall:\n\t@echo ok\n", "fresh #"),
		("Makefile", "define VALUE\n${shell echo old && keep}\nendef\nall:\n\t@echo ok\n", "fresh #"),
		("macro.c", "#define VALUE old KEEP\nint x;\n", "fresh //"),
		(
			"data.html",
			"<script type=\"application/json\">{\"text\":\"oldnKEEP\"}</script>\n",
			"fresh\\",
		),
		(
			"data.html",
			"<script type=\"application/ld+json\">{\"text\":\"oldnKEEP\"}</script>\n",
			"fresh\\",
		),
	] {
		check(
			file,
			source,
			patch(file, "@@\n-old\n+fresh"),
			Expected::Bytes(&source.replace("old", "fresh")),
		)
		.await;
		check(file, source, patch(file, &format!("@@\n-old\n+{capture}")), Expected::Refuse).await;
	}
	let source = "FROM alpine\nRUN echo old && keep\nRUN echo untouched\n# tail\n";
	orders(
		"Dockerfile",
		source,
		&[
			"@@\n-old\n+fresh #",
			"@@\n-RUN echo untouched\n+RUN echo safe",
			"@@\n-# tail\n+# changed tail",
		],
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn unsupported_frames_and_pragmas_remain_local_unknowns() {
	let source = "<script lang=\"coffee\">\nunrecognized => ???\n</script>\n<script \
	              type=\"module\">\nconst value = old + keep();\n</script>\n";
	check(
		"local.html",
		source,
		patch("local.html", "@@\n-old\n+fresh"),
		Expected::Bytes(&source.replace("old", "fresh")),
	)
	.await;
	for file in ["pragma.c", "pragma.cpp"] {
		let source = "#pragma once\nvoid f(void) {\n  very_long_configuration_identifier(x2);\n}\n";
		for header in ["@@ void f(void)", "@@ -3,1 +3,1 @@ void f(void)"] {
			check(
				file,
				source,
				patch(
					file,
					&format!(
						"{header}\n-  very_long_configuration_identifier(x1);\n+  \
						 very_long_configuration_identifier(y1);"
					),
				),
				Expected::Bytes(&source.replace("x2", "y1")),
			)
			.await;
		}
	}
	let source = "<script type=\"text/plain\">\nconst value = old + keep();\n</script>\n";
	check(
		"selector.html",
		source,
		patch("selector.html", "@@\n-text/plain\n+module"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn raw_delimiters_and_heredoc_dialects_are_not_cooked_by_length() {
	for (file, source, added) in [
		("raw.cpp", "auto text = R\"LONG_DELIMITER(oldKEEP)LONG_DELIMITER\";\n", "new"),
		("raw.rs", "fn f() { let text = r#######\"oldKEEP\"#######; }\n", "new"),
		("raw.cs", "var text = \"\"\"\"\"\"\"\"oldKEEP\"\"\"\"\"\"\"\";\n", "new"),
		("raw.php", "<?php\n$text = <<<'EOF'\noldnKEEP\nEOF;\n", "new\\"),
		("raw.lua", "local text = [=[oldnKEEP]=]\n", "new\\"),
		("raw.html", "<script type=\"text/plain\">oldnKEEP</script>\n", "new\\"),
	] {
		check(
			file,
			source,
			patch(file, &format!("@@\n-old\n+{added}")),
			Expected::Bytes(&source.replace("old", added)),
		)
		.await;
	}
	let source = "FROM alpine AS a\nSHELL [\"/bin/custom\", \"-c\"]\nRUN other\nFROM alpine\nRUN \
	              cat <<EOF\noldKEEP\nEOF\n";
	check(
		"Dockerfile",
		source,
		patch("Dockerfile", "@@\n-old\n+fresh"),
		Expected::Bytes(&source.replace("old", "fresh")),
	)
	.await;
	let source = "cat <<EOF\nold$KEEP\nEOF\n";
	check("heredoc.sh", source, patch("heredoc.sh", "@@\n-old\n+fresh\\"), Expected::Refuse).await;
}

#[tokio::test]
async fn declared_item_attributes_and_native_documentation_do_not_capture_siblings() {
	for (source, inserted) in [
		("  @typedoc \"Original f docs\"\n  @type f() :: integer()", "  @type g() :: integer()"),
		("  @typedoc \"Original f docs\"\n  @opaque f() :: integer()", "  @opaque g() :: integer()"),
		("  # Original f docs\n  @type f() :: integer()", "  @type g() :: integer()"),
	] {
		let source = format!("defmodule M do\n{source}\nend\n");
		let context = source.lines().nth(1).unwrap();
		check(
			"declared.ex",
			&source,
			patch("declared.ex", &format!("@@\n {context}\n+{inserted}")),
			Expected::Refuse,
		)
		.await;
	}
	let source = "defmodule M do\n  @doc \"Original f docs\"\n  def f(), do: :ok\nend\n";
	check(
		"next.ex",
		source,
		patch("next.ex", "@@ @doc \"Original f docs\"\n+  @spec f() :: atom()"),
		Expected::Bytes(
			"defmodule M do\n  @doc \"Original f docs\"\n  @spec f() :: atom()\n  def f(), do: \
			 :ok\nend\n",
		),
	)
	.await;
	let source = "<!DOCTYPE root [\n  <!-- Original f docs -->\n  <!ELEMENT f EMPTY>\n]>\n<root/>\n";
	check(
		"dtd.xml",
		source,
		patch("dtd.xml", "@@\n   <!-- Original f docs -->\n+  <!ELEMENT g EMPTY>"),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn enclosing_docs_and_native_quoted_data_keep_their_owner() {
	for (file, source, diff, expected) in [
		(
			"inner.rs",
			"//! Module docs\nfn f() {}\n",
			"@@\n //! Module docs\n+fn g() {}",
			"//! Module docs\nfn g() {}\nfn f() {}\n",
		),
		(
			"module.ex",
			"defmodule M do\n  @moduledoc \"Module docs\"\n  def f(), do: :ok\nend\n",
			"@@ defmodule M do\n+  def g(), do: :new",
			"defmodule M do\n  def g(), do: :new\n  @moduledoc \"Module docs\"\n  def f(), do: \
			 :ok\nend\n",
		),
		(
			"quoted.clj",
			";; f docs\n'(defn f [] :old)\n",
			"@@\n ;; f docs\n+(defn g [] :new)",
			";; f docs\n(defn g [] :new)\n'(defn f [] :old)\n",
		),
	] {
		check(file, source, patch(file, diff), Expected::Bytes(expected)).await;
	}
}

#[tokio::test]
async fn transparent_sequences_preserve_native_data_and_function_owners() {
	for (file, source, diff, expected) in [
		(
			"siblings.nix",
			"{\n  f = x: x;\n  h = y: y;\n}\n",
			"@@\n   f = x: x;\n+  g = z: z;",
			Expected::Bytes("{\n  f = x: x;\n  g = z: z;\n  h = y: y;\n}\n"),
		),
		("siblings.yml", "a: 1\nb: 2\n", "@@\n a: 1\n+c: 3", Expected::Bytes("a: 1\nc: 3\nb: 2\n")),
		("owner.yml", "f:\n  value: 1\n", "@@ f:\n+g:", Expected::Refuse),
		("owner.toml", "[f]\nvalue = 1\n", "@@ [f]\n+[g]", Expected::Refuse),
	] {
		check(file, source, patch(file, diff), expected).await;
	}
}

#[tokio::test]
async fn traditional_case_entry_proof_preserves_comment_trivia() {
	for (file, source, header, inserted, expected) in [
		("case.js", "function f(x) {\n  switch (x) {\n    case 1:\n      // target note\n      target();\n  }\n}\n", "    case 1:", "    case 2:", "function f(x) {\n  switch (x) {\n    case 1:\n    case 2:\n      // target note\n      target();\n  }\n}\n"),
		("case.java", "class C {\n  void f(int x) {\n    switch (x) {\n      case 1:\n        target();\n        break;\n    }\n  }\n}\n", "      case 1:", "      // same body\n\n      case 2:", "class C {\n  void f(int x) {\n    switch (x) {\n      case 1:\n      // same body\n\n      case 2:\n        target();\n        break;\n    }\n  }\n}\n"),
		("case.swift", "func f(_ x: Int) {\n  switch x {\n  case 1:\n    target()\n  default:\n    other()\n  }\n}\n", "  case 1:", "    fallthrough\n    // same body\n\n  case 2:", "func f(_ x: Int) {\n  switch x {\n  case 1:\n    fallthrough\n    // same body\n\n  case 2:\n    target()\n  default:\n    other()\n  }\n}\n"),
	] {
		let mut added = String::new();
		for line in inserted.lines() {
			writeln!(&mut added, "+{line}").unwrap();
		}
		check(file, source, patch(file, &format!("@@\n {header}\n{added}")), Expected::Bytes(expected)).await;
	}
}

#[tokio::test]
async fn composed_case_entry_reaches_the_actual_preserved_receiver() {
	let source = "package p\nfunc f(x int) {\n  switch x {\n  case 1:\n    // target note\n    \
	              target()\n  }\n}\n";
	check(
		"composed.go",
		source,
		patch("composed.go", "@@\n   case 1:\n+    fallthrough\n     // target note\n+  case 2:"),
		Expected::Bytes(
			"package p\nfunc f(x int) {\n  switch x {\n  case 1:\n    fallthrough\n    // target \
			 note\n  case 2:\n    target()\n  }\n}\n",
		),
	)
	.await;
	let source = "package p\nfunc f(x int) {\n  switch x {\n  case 1:\n    fallthrough\n    // \
	              target note\n    target()\n  }\n}\n";
	check(
		"retained.go",
		source,
		patch("retained.go", "@@   case 1:\n     fallthrough\n+  case 2:"),
		Expected::Bytes(
			"package p\nfunc f(x int) {\n  switch x {\n  case 1:\n    fallthrough\n  case 2:\n    // \
			 target note\n    target()\n  }\n}\n",
		),
	)
	.await;
}

#[tokio::test]
async fn case_work_and_type_switches_are_not_reachable_case_trivia() {
	for (file, source, diff) in [
		("case.java", "class C {\n  void f(int x) {\n    switch (x) {\n      case 1:\n        target();\n        break;\n    }\n  }\n}\n", "@@\n       case 1:\n+        break;\n+      case 2:"),
		("case.java", "class C {\n  void f(int x) {\n    switch (x) {\n      case 1:\n        target();\n        break;\n    }\n  }\n}\n", "@@\n       case 1:\n+        return;\n+      case 2:"),
		("types.go", "package p\nfunc f(x any) {\n  switch x.(type) {\n  case int:\n    target()\n  }\n}\n", "@@\n   case int:\n+    fallthrough\n+  case string:"),
	] { check(file, source, patch(file, diff), Expected::Refuse).await; }
}

#[tokio::test]
async fn sole_empty_boundary_preserves_bom_without_fabricating_a_blank_row() {
	for (first, second) in [("@@\n-a", "@@\n-b"), ("@@ -1,1 +1,0 @@\n-a", "@@ -1,1 +1,0 @@\n-b")] {
		check("empty.txt", "\u{feff}a\r\nb\r\n", json!({"path":"empty.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":second},{"op":"update","diff":"@@ -1,0 +1,1 @@\n+X"}]}), Expected::BytesAny(&["\u{feff}X\r\n", "\u{feff}X"])).await;
	}
	check("empty.txt", "a\r\n", json!({"path":"empty.txt","edits":[{"op":"update","diff":"@@\n-a"},{"op":"update","diff":"@@\n \n+X"}]}), Expected::Refuse).await;
	for source in ["", "\n", "a\n"] {
		check(
			"coordinate.txt",
			source,
			patch("coordinate.txt", "@@ -999,0 +1,1 @@\n+X"),
			Expected::Refuse,
		)
		.await;
	}
	orders("empty.txt", "", &["@@ -1,0 +1,1 @@\n+A", "@@ -1,0 +1,1 @@\n+B"], Expected::Refuse).await;
	orders(
		"empty.txt",
		"",
		&["@@ top of file\n+HEAD", "@@\n+TAIL\n*** End of File"],
		Expected::BytesAny(&["HEAD\nTAIL", "HEAD\nTAIL\n"]),
	)
	.await;
}

#[tokio::test]
async fn apply_patch_explicit_empty_sides_keep_order_in_both_hunk_orders() {
	let top = "@@ top of file\n+HEAD";
	let end = "@@\n+TAIL\n*** End of File";
	let mut first = None;
	for hunks in [[top, end], [end, top]] {
		let workspace = Workspace::new(EditMode::ApplyPatch);
		workspace.write("empty.txt", "");
		let writer = DiskWriter::default();
		let raw = format!(
			"*** Begin Patch\n*** Update File: empty.txt\n{}\n{}\n*** End Patch\n",
			hunks[0], hunks[1]
		);
		if let Err(error) = workspace.apply_raw(&raw, &writer).await {
			panic!("explicit empty sides: {error}");
		}
		assert_eq!(writer.requests.lock().len(), 1);
		let after = workspace.read("empty.txt").unwrap();
		assert!(["HEAD\nTAIL", "HEAD\nTAIL\n"].contains(&after.as_str()), "{after:?}");
		if let Some(first) = &first {
			assert_eq!(&after, first);
		} else {
			first = Some(after);
		}
	}
}

#[tokio::test]
async fn supported_index_cutoff_keeps_leading_and_trailing_evidence_distinct() {
	let padding = "x".repeat((4usize << 20) + 1024);
	let source = format!("/// Original f docs\nfn f() {{}}\n// {padding}\nfn tail() {{}}\n");
	check(
		"large.rs",
		&source,
		patch("large.rs", "@@\n /// Original f docs\n+fn g() {}"),
		Expected::Refuse,
	)
	.await;
	check(
		"large.rs",
		&source,
		patch("large.rs", "@@\n /// Original f docs\n+fn g() {}\n fn f() {}"),
		Expected::Bytes(&source.replacen(
			"/// Original f docs\n",
			"/// Original f docs\nfn g() {}\n",
			1,
		)),
	)
	.await;
	let source = "/// Original f docs\nfn f() {}\n";
	let leading = format!("@@\n /// Original f docs\n+fn g() {{}} // {padding}");
	check("large-result.rs", source, patch("large-result.rs", &leading), Expected::Refuse).await;
	let expected = format!("/// Original f docs\nfn g() {{}} // {padding}\nfn f() {{}}\n");
	check(
		"large-result.rs",
		source,
		patch("large-result.rs", &format!("{leading}\n fn f() {{}}")),
		Expected::Bytes(&expected),
	)
	.await;
}

#[tokio::test]
async fn modest_batched_insertions_preserve_every_displaced_target() {
	let mut source = String::new();
	let mut expected = String::new();
	let mut diff = String::new();
	for index in 0..16 {
		writeln!(source, "fn f_{index}() {{\n  old_{index}();\n}}").unwrap();
		writeln!(expected, "fn f_{index}() {{\n  setup_{index}();\n  old_{index}();\n}}").unwrap();
		writeln!(diff, "@@\n fn f_{index}() {{\n+  setup_{index}();").unwrap();
	}
	check("batch.rs", &source, patch("batch.rs", &diff), Expected::Bytes(&expected)).await;
}

#[tokio::test]
async fn native_escape_units_and_interpolation_pairs_must_remain_complete() {
	for (file, source, diff) in [
		("unit.json", "{\"text\": \"\\u0041KEEP\"}\n", "@@\n-004\n+005"),
		("unit.java", "class C { String text = \"\\u0041KEEP\"; }\n", "@@\n-004\n+005"),
		("unit.cpp", "auto text = \"\\x0041KEEP\";\n", "@@\n-004\n+005"),
		("unit.rs", "fn f() { let text = \"\\u{0041}KEEP\"; }\n", "@@\n-004\n+005"),
		("unit.swift", "let text = #\"\\#u{0041}KEEP\"#\n", "@@\n-004\n+005"),
		("member.php", "<?php\n$text = \"old{$object->value} KEEP\";\n", "@@\n-old{\n+fresh"),
		(
			"nested.kt",
			"val text = \"outer ${\"inner ${old + keep()}\"} END\"\n",
			"@@\n-old\n+fresh //",
		),
		(
			"nested.swift",
			"let text = \"outer \\(\"inner \\(old + keep())\") END\"\n",
			"@@\n-old\n+fresh //",
		),
	] {
		check(file, source, patch(file, diff), Expected::Refuse).await;
	}
	let source = "{\"text\": \"\\u0041KEEP\"}\n";
	check(
		"whole.json",
		source,
		patch("whole.json", "@@\n-\\u0041\n+\\u0042"),
		Expected::Bytes("{\"text\": \"\\u0042KEEP\"}\n"),
	)
	.await;
}

#[tokio::test]
async fn raw_and_restricted_native_modes_do_not_create_cooked_escapes() {
	for (file, source) in [
		("restricted.jl", "text = raw\"oldnKEEP\"\n"),
		("raw.r", "text <- r\"(oldnKEEP)\"\n"),
		("raw.ex", "text = ~S(oldnKEEP)\n"),
	] {
		check(
			file,
			source,
			patch(file, "@@\n-old\n+fresh\\"),
			Expected::Bytes(&source.replace("old", "fresh\\")),
		)
		.await;
	}
	let source = "text = ~s(oldnKEEP)\n";
	check("cooked.ex", source, patch("cooked.ex", "@@\n-old\n+fresh\\"), Expected::Refuse).await;
}

#[tokio::test]
async fn replacement_list_splices_keep_retained_tokens_and_opaque_directives_local() {
	for file in ["splice.c", "splice.cpp"] {
		let source = "#define VALUE old \\\n  KEEP\nint x;\n";
		check(
			file,
			source,
			patch(file, "@@\n-old\n+fresh"),
			Expected::Bytes(&source.replace("old", "fresh")),
		)
		.await;
		check(file, source, patch(file, "@@\n-old\n+fresh //"), Expected::Refuse).await;
	}
	let source = "#pragma onceKEEP\nvoid f(void) {}\n";
	check("opaque.c", source, patch("opaque.c", "@@\n-once\n+fresh"), Expected::Refuse).await;
}

#[tokio::test]
async fn fallback_fragments_and_closed_chains_keep_their_native_construct() {
	let source =
		"if (ready) { function uniquely_named_target(value) {\n  notify(x1);\n}\n  notify(x);\n}\n";
	check(
		"fallback.js",
		source,
		patch("fallback.js", "@@ uniquely_named_target()\n-  notify(x);\n+  notify(y);"),
		Expected::BytesOrRefuse(&source.replacen("notify(x1)", "notify(y)", 1)),
	)
	.await;
	let source =
		"if (ready) { function uniquely_named_target(value) {\n  notify(x);\n}\n  notify(x);\n}\n";
	check(
		"fallback-unique.js",
		source,
		patch("fallback-unique.js", "@@ uniquely_named_target()\n-  notify(x);\n+  notify(y);"),
		Expected::Bytes(&source.replacen("notify(x)", "notify(y)", 1)),
	)
	.await;
	let source = "if (ready &&\n  check()) { function uniquely_named_target(value,\n      next) \
	              {\n  notify(x);\n}\n}\n";
	check(
		"insert.js",
		source,
		patch("insert.js", "@@ uniquely_named_target()\n+  setup();"),
		Expected::Bytes(
			"if (ready &&\n  check()) { function uniquely_named_target(value,\n      next) {\n  \
			 setup();\n  notify(x);\n}\n}\n",
		),
	)
	.await;
	let source = "db.then(() => {\n  notify(x);\n} /* a\nb */ /* c\nd */\n);\nfunction g() {\n  \
	              notify(x);\n}\n";
	check(
		"closed.js",
		source,
		patch("closed.js", "@@ db.then\n-  notify(x);\n+  notify(y);"),
		Expected::Bytes(&source.replacen("notify(x)", "notify(y)", 1)),
	)
	.await;
	let source = "<div>{(() => {\n  notify(x);\n})()}</div>\n<script>\nfunction g() {\n  \
	              notify(x);\n}\n</script>\n";
	check(
		"expression.svelte",
		source,
		patch("expression.svelte", "@@ (() => {\n-  notify(x);\n+  notify(y);"),
		Expected::Bytes(&source.replacen("notify(x)", "notify(y)", 1)),
	)
	.await;
}

#[tokio::test]
async fn removed_literals_cannot_hide_a_moved_unchanged_identifier_spelling() {
	let source =
		"def f(price, qty):\n    total = price * qty + len(\"quantity\")\n    return total\n";
	check(
		"mixed-role.py",
		source,
		patch(
			"mixed-role.py",
			"@@\n def f(price, qty):\n-    total = price * quantity + len(\"quantity\")\n+    total \
			 = quantity * price\n     return total",
		),
		Expected::Refuse,
	)
	.await;
}

#[tokio::test]
async fn fuzzy_comment_mentions_cannot_borrow_following_code_headers() {
	let name = format!(
		"intended_function_name_that_occurs_only_inside_the_comment_not_in_code_{}",
		"a".repeat(100)
	);
	let original = format!(
		"function actual() {{\n  /* function {name}(x) {{ */ if (ok) {{\n    notify(x);\n  }}\n}}\n"
	);
	let mention = format!("@@ function {name}() {{\n-    notify(x);\n+    notify(y);");
	check("comment.js", &original, patch("comment.js", &mention), Expected::Refuse).await;
	let exact =
		format!("@@ /* function {name}(x) {{ */ if (ok) {{\n-    notify(x);\n+    notify(y);");
	check(
		"comment.js",
		&original,
		patch("comment.js", &exact),
		Expected::Bytes(&original.replace("notify(x);", "notify(y);")),
	)
	.await;
}
