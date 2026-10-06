//! Placement preserves region, context adjacency, statement ownership and
//! punctuation.
mod common;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::{Value, json};

enum Want {
	Bytes(String),
	BytesOrRefuse(String),
	Refuse,
}

fn patch(file: &str, diff: &str) -> Value {
	json!({ "path": file, "edits": [{ "op": "update", "diff": diff }] })
}

async fn p(
	label: &str,
	mode: EditMode,
	file: &str,
	original: &str,
	args: Value,
	want: Want,
	fails: &mut Vec<String>,
) {
	let ws = Workspace::new(mode);
	ws.write(file, original);
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(&args, &writer)
		.await
		.map(|_| ())
		.map_err(|e| e.to_string());
	let writes = writer.requests.lock().len();
	let after = ws.read(file).unwrap_or_default();
	let refused_clean = result.is_err() && writes == 0 && after == original;
	let ok = match &want {
		Want::Bytes(b) => result.is_ok() && &after == b,
		Want::BytesOrRefuse(b) => refused_clean || (result.is_ok() && &after == b),
		Want::Refuse => refused_clean,
	};
	let tail = |s: &str, n: usize| -> String {
		let cut = s
			.char_indices()
			.rev()
			.nth(n.saturating_sub(1))
			.map_or(0, |(i, _)| i);
		s[cut..].to_owned()
	};
	let shown = match &result {
		Ok(()) => "Ok".to_owned(),
		Err(e) => format!("Err(len={} {:?})", e.len(), tail(e, 400)),
	};
	let shown_after = if after.len() > 400 {
		format!("<{} bytes>", after.len())
	} else {
		format!("{after:?}")
	};
	println!(
		"{} {label}: result={shown} writes={writes} after={shown_after}",
		if ok { "PASS" } else { "FAIL" }
	);
	if !ok {
		fails.push(label.to_owned());
	}
}

/// Runs the same hunks in both orders; each order must meet `want`, and the two
/// results must be identical.
async fn both(
	label: &str,
	file: &str,
	original: &str,
	h1: &str,
	h2: &str,
	want: Want,
	fails: &mut Vec<String>,
) {
	let fwd = format!("{h1}\n{h2}");
	let rev = format!("{h2}\n{h1}");
	let run = |diff: String| {
		let ws = Workspace::new(EditMode::Patch);
		ws.write(file, original);
		async move {
			let writer = DiskWriter::default();
			let result = ws
				.apply_json(&patch(file, &diff), &writer)
				.await
				.map(|_| ())
				.map_err(|e| e.to_string());
			let writes = writer.requests.lock().len();
			(result, writes, ws.read(file).unwrap_or_default())
		}
	};
	let (r1, w1, a1) = run(fwd.clone()).await;
	let (r2, w2, a2) = run(rev.clone()).await;
	let same = r1.is_ok() == r2.is_ok() && a1 == a2;
	let meets = |r: &Result<(), String>, w: usize, a: &str| -> bool {
		let refused_clean = r.is_err() && w == 0 && a == original;
		match &want {
			Want::Bytes(b) => r.is_ok() && a == b,
			Want::BytesOrRefuse(b) => refused_clean || (r.is_ok() && a == b),
			Want::Refuse => refused_clean,
		}
	};
	let ok = same && meets(&r1, w1, &a1) && meets(&r2, w2, &a2);
	let show = |r: &Result<(), String>, a: &str| match r {
		Ok(()) => format!("Ok {a:?}"),
		Err(e) => format!("Err({e:?})"),
	};
	println!(
		"{} {label}: fwd={} rev={}",
		if ok { "PASS" } else { "FAIL" },
		show(&r1, &a1),
		show(&r2, &a2)
	);
	if !ok {
		fails.push(label.to_owned());
	}
}

#[tokio::test]
async fn placement_preserves_target_and_result_contracts() {
	let mut fails = Vec::new();
	let f = &mut fails;

	// ---- R11RegionReview
	// RL0 (P1 claim): a label on its own row before a loop (Go/Java field-less
	// labeled_statement) must scope the loop.
	{
		let go = "package p\n\nfunc f() {\nouter:\n    for ready {\n        notify(x1)\n    \
		          }\n}\nfunc g() {\n        notify(x)\n}\n";
		p(
			"RL0a_GO_LABEL_NEXT_ROW_ESCAPE",
			EditMode::Patch,
			"label.go",
			go,
			patch("label.go", "@@ outer:\n-        notify(x)\n+        notify(y)"),
			Want::BytesOrRefuse(go.replacen("notify(x1)", "notify(y)", 1)),
			f,
		)
		.await;
		let goc = go.replacen("notify(x1)", "notify(x)", 1);
		p(
			"RL0b_GO_LABEL_NEXT_ROW_CONTROL",
			EditMode::Patch,
			"label.go",
			&goc,
			patch("label.go", "@@ outer:\n-        notify(x)\n+        notify(y)"),
			Want::Bytes(goc.replacen("notify(x)", "notify(y)", 1)),
			f,
		)
		.await;
		let java = "class C {\n    void f() {\nouter:\n        while (ready) {\n            \
		            notify(x1);\n        }\n    }\n    void g() {\n            notify(x);\n    \
		            }\n}\n";
		p(
			"RL0c_JAVA_LABEL_NEXT_ROW_ESCAPE",
			EditMode::Patch,
			"Label.java",
			java,
			patch("Label.java", "@@ outer:\n-            notify(x);\n+            notify(y);"),
			Want::BytesOrRefuse(java.replacen("notify(x1);", "notify(y);", 1)),
			f,
		)
		.await;
		let javac = java.replacen("notify(x1);", "notify(x);", 1);
		p(
			"RL0d_JAVA_LABEL_NEXT_ROW_CONTROL",
			EditMode::Patch,
			"Label.java",
			&javac,
			patch("Label.java", "@@ outer:\n-            notify(x);\n+            notify(y);"),
			Want::Bytes(javac.replacen("notify(x);", "notify(y);", 1)),
			f,
		)
		.await;
	}

	// RL1 (P1 claim): a leading comment on the anchored header row must not erase
	// the block's region.
	{
		let js = "function f() {\n  /* lead */ if (ready) {\n    notify(x1);\n  }\n}\nfunction g() \
		          {\n    notify(x);\n}\n";
		p(
			"RL1a_SAME_ROW_LEADING_EXTRA_ESCAPE",
			EditMode::Patch,
			"comment.js",
			js,
			patch("comment.js", "@@ /* lead */ if (ready) {\n-    notify(x);\n+    notify(y);"),
			Want::BytesOrRefuse(js.replacen("notify(x1);", "notify(y);", 1)),
			f,
		)
		.await;
		let jsc = js.replacen("notify(x1);", "notify(x);", 1);
		p(
			"RL1b_SAME_ROW_LEADING_EXTRA_CONTROL",
			EditMode::Patch,
			"comment.js",
			&jsc,
			patch("comment.js", "@@ /* lead */ if (ready) {\n-    notify(x);\n+    notify(y);"),
			Want::Bytes(jsc.replacen("notify(x);", "notify(y);", 1)),
			f,
		)
		.await;
	}
	// RL2 (claim): an anchored chain statement with its own recovery error is not a
	// certain region.
	{
		let chain = "db.save(user).then(() => {\n  notify(x);\n})\n.catch(() => {\n  broken = = \
		             1;\n});\nfunction g() {\n  notify(x);\n}\n";
		p(
			"RL2_CHAIN_ERROR_OWN_SUBTREE",
			EditMode::Patch,
			"broken.js",
			chain,
			patch("broken.js", "@@ db.save(user).then(() => {\n-  notify(x);\n+  notify(y);"),
			Want::BytesOrRefuse(chain.replacen("notify(x);", "notify(y);", 1)),
			f,
		)
		.await;
	}

	// RL3 (P1 claim): stacked Kotlin labels.
	{
		let kt = "fun f() {\n    outer@ inner@ while (ready) {\n        notify(x1)\n    };\n}\nfun \
		          g() {\n        notify(x)\n}\n";
		p(
			"RL3a_KOTLIN_STACKED_LABEL_ESCAPE",
			EditMode::Patch,
			"labels.kt",
			kt,
			patch(
				"labels.kt",
				"@@ outer@ inner@ while (ready) {\n-        notify(x)\n+        notify(y)",
			),
			Want::BytesOrRefuse(kt.replacen("notify(x1)", "notify(y)", 1)),
			f,
		)
		.await;
		let kt2 = kt.replacen("notify(x1)", "notify(x)", 1);
		p(
			"RL3b_KOTLIN_STACKED_LABEL_CONTROL",
			EditMode::Patch,
			"labels.kt",
			&kt2,
			patch(
				"labels.kt",
				"@@ outer@ inner@ while (ready) {\n-        notify(x)\n+        notify(y)",
			),
			Want::Bytes(kt2.replacen("notify(x)", "notify(y)", 1)),
			f,
		)
		.await;
	}
	// RL4 controls (region correct paths).
	for header in ["|2+", ">2+", "|+2", ">+2"] {
		let s = format!("message: {header}\n  hello\n  \nother: {header}\n  hello\n  \n");
		let d = format!("@@ message: {header}\n-  \n+  tail");
		p(
			&format!("RL4a_SCALAR_{header}"),
			EditMode::Patch,
			"scalar.yml",
			&s,
			patch("scalar.yml", &d),
			Want::Bytes(s.replacen("  \n", "  tail\n", 1)),
			f,
		)
		.await;
	}
	{
		let py = "def f():\n    text = \"\"\"hello\n  \n\"\"\"\ndef g():\n    text = \"\"\"hello\n  \
		          \n\"\"\"\n";
		p(
			"RL4b_PY_END_BLOCK_LITERAL",
			EditMode::Patch,
			"literal.py",
			py,
			patch("literal.py", "@@ def f():\n-  \n+  tail"),
			Want::Bytes(py.replacen("  \n", "  tail\n", 1)),
			f,
		)
		.await;
		let ruby = "def f\n  notify(x)\n=begin\ncomment\n=end\nend\ndef g\n  notify(x)\nend\n";
		p(
			"RL4c_RUBY_BEGIN_COMMENT_REGION",
			EditMode::Patch,
			"comment.rb",
			ruby,
			patch("comment.rb", "@@ def f\n-  notify(x)\n+  notify(y)"),
			Want::Bytes(ruby.replacen("notify(x)", "notify(y)", 1)),
			f,
		)
		.await;
		let md = "# A\n```text\n  \n```\n# B\n```text\n  \n```\n";
		p(
			"RL4d_MD_FENCE_BLANK_ROW",
			EditMode::Patch,
			"fence.md",
			md,
			patch("fence.md", "@@ # A\n-  \n+  tail"),
			Want::Bytes(md.replacen("  \n", "  tail\n", 1)),
			f,
		)
		.await;
	}

	// ---- R11MultiHunkReview
	// MX0 (P1 claim): retained byte-identical edge rows must keep the change
	// block's exterior ties.
	both(
		"MX0a_RETAINED_TRAILING_EDGE",
		"t.txt",
		"a\nb\nc\nd\n",
		"@@\n a\n-b\n-c\n+B\n+c\n d",
		"@@ c\n+X",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"MX0b_RETAINED_LEADING_EDGE",
		"t.txt",
		"a\nb\nc\nd\n",
		"@@\n a\n-b\n-c\n+b\n+C\n d",
		"@@ a\n+X",
		Want::Refuse,
		f,
	)
	.await;
	// MX1 (P1 claim): an unevidenced repaired variant must not become writable
	// through fixpoint elimination.
	both(
		"MX1a_VARIANT_ELIMINATION_WRONG_COPY",
		"t.txt",
		"A\nx\nseparator_one\nseparator_two\nseparator_three\nB\nx\n",
		"@@\n A\n-x\n+Y",
		"@@\n A\n STALE_CONTEXT_NOT_ANYWHERE\n-x\n+Z",
		Want::Refuse,
		f,
	)
	.await;
	{
		let original = "A\nx\nmarker_one\nB\nx\nmarker_two\nC\nx\n";
		let hunks = [
			"@@\n A\n-x\n+Y",
			"@@\n A\n STALE_CONTEXT_NOT_ANYWHERE\n-x\n+Z",
			"@@\n A\n STALE_CONTEXT_NOT_ANYWHERE\n-x\n+Z",
		];
		let perms: [[usize; 3]; 6] =
			[[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
		for (i, order) in perms.iter().enumerate() {
			let diff = order
				.iter()
				.map(|&k| hunks[k])
				.collect::<Vec<_>>()
				.join("\n");
			p(
				&format!("MX1b_VARIANT_GROUP_{i}"),
				EditMode::Patch,
				"t.txt",
				original,
				patch("t.txt", &diff),
				Want::Refuse,
				f,
			)
			.await;
		}
	}
	// MX2 (P1 claim): a reordering replacement must not move another hunk's context
	// away from its insertion.
	both(
		"MX2_MOVED_EDGE_CONTEXT",
		"t.txt",
		"a\nb\nc\nd\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n+c\n+b",
		Want::Refuse,
		f,
	)
	.await;
	// MX3 (P2 claim): moving an already-written row twice keeps its provenance.
	{
		let edits = json!({"path":"t.txt","edits":[{"op":"update","diff":"@@\n a\n-foo\n b\n+foo\n c"},{"op":"update","diff":"@@\n b\n-foo\n c\n+foo"},{"op":"update","diff":"@@\n-foo\n+bar"}]});
		p(
			"MX3a_MOVE_WRITTEN_ROW_TWICE",
			EditMode::Patch,
			"t.txt",
			"a\nfoo\nb\nc\n",
			edits,
			Want::Bytes("a\nb\nc\nbar\n".into()),
			f,
		)
		.await;
		let input = "*** Begin Patch\n*** Update File: t.txt\n@@\n a\n-foo\n b\n+foo\n c\n*** \
		             Update File: t.txt\n@@\n b\n-foo\n c\n+foo\n*** Update File: \
		             t.txt\n@@\n-foo\n+bar\n*** End Patch";
		p(
			"MX3b_MOVE_WRITTEN_ROW_TWICE_APPLY_PATCH",
			EditMode::ApplyPatch,
			"t.txt",
			"a\nfoo\nb\nc\n",
			json!({ "input": input }),
			Want::Bytes("a\nb\nc\nbar\n".into()),
			f,
		)
		.await;
	}
	// MX4 (P3): provenance memory for many sequential rewrites of one row.
	for n in [500usize, 1000, 2000] {
		let edits: Vec<_> = (0..n)
			.map(|i| json!({"op":"update","diff": if i % 2 == 0 {"@@\n-x\n+y"} else {"@@\n-y\n+x"}}))
			.collect();
		p(
			&format!("MX4_PROVENANCE_SCALE_{n}"),
			EditMode::Patch,
			"t.txt",
			"x\n",
			json!({"path":"t.txt","edits":edits}),
			Want::Bytes("x\n".into()),
			f,
		)
		.await;
	}
	// MX5 (P3): stale-hint veto scaling.
	for n in [100usize, 200, 400] {
		let mut rows: Vec<String> = (0..n)
			.map(|i| format!("unique {i}"))
			.chain((0..n).map(|i| format!("dupe {i}")))
			.chain((0..1000).map(|i| format!("filler {i}")))
			.chain((0..n).map(|i| format!("dupe {i}")))
			.collect();
		let original = rows.join("\n") + "\n";
		let hunks = (0..n)
			.map(|i| format!("@@ -1,1 +1,1 @@\n-unique {i}\n+UNIQUE {i}"))
			.chain((0..n).map(|i| format!("@@ -{h},1 +{h},1 @@\n-dupe {i}\n+DUPE {i}", h = n + i + 1)))
			.collect::<Vec<_>>()
			.join("\n");
		for i in 0..n {
			rows[i] = format!("UNIQUE {i}");
			rows[n + i] = format!("DUPE {i}");
		}
		p(
			&format!("MX5_VETO_SCALE_{n}"),
			EditMode::Patch,
			"t.txt",
			&original,
			patch("t.txt", &hunks),
			Want::BytesOrRefuse(rows.join("\n") + "\n"),
			f,
		)
		.await;
	}

	for lead in ["", "    // lead\n"] {
		let s = format!(
			"func f() {{\nouter:\n{lead}    while ready {{\n        notify(x1)\n    }}\n}}\nfunc g() \
			 {{\n        notify(x)\n}}\n"
		);
		p(
			"GUARD_SWIFT_ESCAPE",
			EditMode::Patch,
			"s.swift",
			&s,
			patch("s.swift", "@@ outer:\n-        notify(x)\n+        notify(y)"),
			Want::BytesOrRefuse(s.replacen("notify(x1)", "notify(y)", 1)),
			f,
		)
		.await;
		let s = s.replace("notify(x1)", "notify(x)");
		p(
			"GUARD_SWIFT_CONTROL",
			EditMode::Patch,
			"s.swift",
			&s,
			patch("s.swift", "@@ outer:\n-        notify(x)\n+        notify(y)"),
			Want::Bytes(s.replacen("notify(x)", "notify(y)", 1)),
			f,
		)
		.await;
	}

	p("GUARD_DUPLICATE_MOVE", EditMode::Patch, "t.txt", "a\nfoo\nfoo\nb\nc\n", json!({"path":"t.txt","edits":[{"op":"update","diff":"@@\n a\n-foo\n-foo\n b\n+foo\n+foo\n c"},{"op":"update","diff":"@@\n b\n-foo\n-foo\n c\n+foo\n+foo"},{"op":"update","diff":"@@\n c\n-foo\n-foo\n+bar\n+bar"}]}), Want::Bytes("a\nb\nc\nbar\nbar\n".into()), f).await;

	p("GUARD_DUPLICATE_BARE_MOVE", EditMode::Patch, "t.txt", "a\nfoo\nfoo\nb\nc\n", json!({"path":"t.txt","edits":[{"op":"update","diff":"@@\n a\n-foo\n-foo\n b\n+foo\n+foo\n c"},{"op":"update","diff":"@@\n b\n-foo\n-foo\n c\n+foo\n+foo"},{"op":"update","diff":"@@\n-foo\n-foo\n+bar\n+bar"}]}), Want::Bytes("a\nb\nc\nbar\nbar\n".into()), f).await;

	both(
		"GUARD_SHRINK_REWRITE",
		"t.txt",
		"root\nvalue = 1\nobsolete = 1\nend\n",
		"@@\n root\n+added\n value = 1",
		"@@\n-value = 1\n-obsolete = 1\n+value = 2",
		Want::Bytes("root\nadded\nvalue = 2\nend\n".into()),
		f,
	)
	.await;

	for (label, s, diff, expected) in [
		(
			"GUARD_ORDINARY_SIBLING",
			"function f() {\n  before();\n  target();\n}\n",
			"@@ before();\n+  added();",
			"function f() {\n  before();\n  added();\n  target();\n}\n",
		),
		(
			"GUARD_EXPRESSION_COMMENT",
			"function f() {\n  before();\n  // note\n  target();\n}\n",
			"@@ // note\n+  added();",
			"function f() {\n  before();\n  // note\n  added();\n  target();\n}\n",
		),
		(
			"GUARD_COMMENT_BLANK",
			"// note\n\nfunction f() {}\n",
			"@@ // note\n+function g() {}",
			"// note\nfunction g() {}\n\nfunction f() {}\n",
		),
	] {
		p(label, EditMode::Patch, "s.js", s, patch("s.js", diff), Want::Bytes(expected.into()), f)
			.await;
	}
	p(
		"GUARD_DOCSTRING_COMMENT",
		EditMode::Patch,
		"f.py",
		"def f():\n    \"\"\"Original docs\"\"\"\n    return 1\n",
		patch("f.py", "@@ def f():\n+    # explanation"),
		Want::Bytes(
			"def f():\n    # explanation\n    \"\"\"Original docs\"\"\"\n    return 1\n".into(),
		),
		f,
	)
	.await;
	let s =
		"func f(_ x: Int) {\n  switch x {\n  case 1:\n    target()\n  default:\n    break\n  }\n}\n";
	p(
		"GUARD_SWIFT_FALLTHROUGH",
		EditMode::Patch,
		"s.swift",
		s,
		patch("s.swift", "@@ case 1:\n+    fallthrough\n+  case 2:"),
		Want::Bytes(s.replace("  case 1:\n", "  case 1:\n    fallthrough\n  case 2:\n")),
		f,
	)
	.await;

	p(
		"GUARD_GO_STACKED_NO_REACH",
		EditMode::Patch,
		"m.go",
		"package p\n\nfunc f(x int) {\n\tswitch x {\n\tcase 1:\n\t\ttarget()\n\t}\n}\n",
		patch("m.go", "@@ case 1:\n+\t\tfallthrough\n+\tcase 2:\n+\tcase 3:"),
		Want::Refuse,
		f,
	)
	.await;

	let s =
		"void f(int x) {\n    switch (x) {\n    case 1:\n        target();\n        break;\n    \
		 }\n}\n";
	p(
		"GUARD_C_STACKED_REACH",
		EditMode::Patch,
		"m.c",
		s,
		patch("m.c", "@@ case 1:\n+    case 2:\n+    case 3:"),
		Want::Bytes(s.replace("    case 1:\n", "    case 1:\n    case 2:\n    case 3:\n")),
		f,
	)
	.await;

	for s in [
		"def f():\n    (\"Original docs\")\n    return 1\n",
		"def f():\n    \"Original \" \"docs\"\n    return 1\n",
	] {
		p(
			"GUARD_WRAPPED_DOCSTRING",
			EditMode::Patch,
			"f.py",
			s,
			patch("f.py", "@@ def f():\n+    setup()"),
			Want::Refuse,
			f,
		)
		.await;
	}

	p(
		"GUARD_DOCSTRING_PAREN_COMMENT",
		EditMode::Patch,
		"f.py",
		"def f():\n    (\n        \"Original docs\"\n        # note\n    )\n    return 1\n",
		patch("f.py", "@@ def f():\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"GUARD_MODULE_DOCSTRING",
		EditMode::Patch,
		"f.py",
		"# license\n\"\"\"Original docs\"\"\"\nvalue = 1\n",
		patch("f.py", "@@ # license\n+setup()"),
		Want::Refuse,
		f,
	)
	.await;

	p(
		"GUARD_POWERSHELL_COMMENT_DECL",
		EditMode::Patch,
		"s.ps1",
		"# Original docs\nfunction F {\n    \"original\"\n}\n",
		patch("s.ps1", "@@ # Original docs\n+function G { \"new\" }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"GUARD_SQL_COMMENT_DECL",
		EditMode::Patch,
		"s.sql",
		"-- Original docs\nCREATE TABLE f (id INTEGER);\n",
		patch("s.sql", "@@ -- Original docs\n+CREATE TABLE g (id INTEGER);"),
		Want::Refuse,
		f,
	)
	.await;

	p(
		"GUARD_REWRITTEN_SEMICOLON_SUCCESSOR",
		EditMode::Patch,
		"s.js",
		"function f() {\n  const a = \"old\";\n  const b = \"old\";\n}\n",
		patch(
			"s.js",
			"@@\n function f() {\n-  const a = \"old\"\n+  const a = \"new\";\n-  const b = \
			 \"old\"\n+  const b = \"new\";\n }",
		),
		Want::Bytes("function f() {\n  const a = \"new\";\n  const b = \"new\";\n}\n".into()),
		f,
	)
	.await;
	p(
		"GUARD_RENAMED_SCALAR_OWNER",
		EditMode::Patch,
		"s.ini",
		"oldkey=old;\nother=2\n",
		patch("s.ini", "@@\n-oldkey=old\n+newkeylong=new;\n other=2"),
		Want::Bytes("newkeylong=new;\nother=2\n".into()),
		f,
	)
	.await;
	// ---- R11InsertionReview
	// IX0 (P1 claim): the row bound must reach the displaced declaration past a
	// leading comment row.
	p(
		"IX0_C_COMMENT_BOUND",
		EditMode::Patch,
		"m.c",
		"int marker;\n// note\nvoid target(void) {\n    work();\n}\n/* tail */\n",
		patch("m.c", "@@ int marker;\n+/*"),
		Want::Refuse,
		f,
	)
	.await;
	// IX1 (P1 claim): fieldless Swift branch identity when the body starts at the
	// gap.
	p(
		"IX1_SWIFT_FIRST_BODY_BRANCH",
		EditMode::Patch,
		"s.swift",
		"func f(_ ok: Bool) {\n  if ok {\n    print(\"target\")\n  }\n}\n",
		patch("s.swift", "@@ if ok {\n+    print(\"before\")\n+  } else {"),
		Want::Refuse,
		f,
	)
	.await;
	// IX2 (P1 claim): a Python docstring stays first in its body.
	p(
		"IX2_PYTHON_DOCSTRING",
		EditMode::Patch,
		"f.py",
		"def f():\n    \"\"\"Original docs\"\"\"\n    return 1\n",
		patch("f.py", "@@ def f():\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;
	// IX3 (P1 claims): dedicated documentation in other grammars.
	p(
		"IX3a_SWIFT_DOC",
		EditMode::Patch,
		"d.swift",
		"/// Original docs\nfunc f() {}\n",
		patch("d.swift", "@@ /// Original docs\n+func g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IX3b_KOTLIN_DOC",
		EditMode::Patch,
		"d.kt",
		"/** Original docs */\nfun f() {}\n",
		patch("d.kt", "@@ /** Original docs */\n+fun g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IX3c_CPP_DOC",
		EditMode::Patch,
		"d.cpp",
		"/// Original docs\nvoid f() {}\n",
		patch("d.cpp", "@@ /// Original docs\n+void g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IX3d_C_DOC",
		EditMode::Patch,
		"d.c",
		"/** Original docs */\nvoid f(void) {}\n",
		patch("d.c", "@@ /** Original docs */\n+void g(void) {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IX3e_HASKELL_DOC",
		EditMode::Patch,
		"D.hs",
		"module D where\n\n-- | Original docs\nf :: Int\nf = 1\n",
		patch("D.hs", "@@ -- | Original docs\n+g :: Int\n+g = 2"),
		Want::Refuse,
		f,
	)
	.await;
	// IX4 (P1 claim): Elixir @doc attaches to the following def.
	p(
		"IX4_ELIXIR_DOC",
		EditMode::Patch,
		"m.ex",
		"defmodule M do\n  @doc \"Original docs\"\n  def f(), do: :ok\nend\n",
		patch("m.ex", "@@ @doc \"Original docs\"\n+  def g(), do: :new"),
		Want::Refuse,
		f,
	)
	.await;
	// IX5 (P1 claim): a new case label owning old statements requires real
	// fallthrough.
	p(
		"IX5_CASE_BREAK_CAPTURE",
		EditMode::Patch,
		"m.c",
		"void f(int x) {\n    switch (x) {\n    case 1:\n        target();\n        break;\n    \
		 }\n}\n",
		patch("m.c", "@@ case 1:\n+        break;\n+    case 2:"),
		Want::Refuse,
		f,
	)
	.await;
	// IX6 (P2 claim): Go explicit fallthrough case addition applies.
	p(
		"IX6_GO_EXPLICIT_FALLTHROUGH",
		EditMode::Patch,
		"m.go",
		"package p\n\nfunc f(x int) {\n\tswitch x {\n\tcase 1:\n\t\ttarget()\n\t}\n}\n",
		patch("m.go", "@@ case 1:\n+\t\tfallthrough\n+\tcase 2:"),
		Want::Bytes(
			"package p\n\nfunc f(x int) {\n\tswitch x {\n\tcase 1:\n\t\tfallthrough\n\tcase \
			 2:\n\t\ttarget()\n\t}\n}\n"
				.into(),
		),
		f,
	)
	.await;

	// ---- R11TokenGuardReview
	// TX0 (P1 claim): a trivial rewrite must still keep the original successor in
	// its owner.
	p(
		"TX0_TRIVIAL_PREFIX_SWALLOWS_SUCCESSOR",
		EditMode::Patch,
		"s.js",
		"const long_variable_name_to_force_character_fallback = { a: 1, b: 2 };\n",
		patch("s.js", "@@\n-a: 1\n+a: 3,\n+}; //"),
		Want::Refuse,
		f,
	)
	.await;
	// TX1 (P1 claim): an inline VB REM comment cannot supply the separator.
	p("TX1_INLINE_REM_COMMA", EditMode::Patch, "s.vb", "Dim cfg = New Config With {\n    .Value = old,\n    .Other = 2\n}\n",
		patch("s.vb", "@@\n Dim cfg = New Config With {\n-    .Value = old\n+    .Value = updated REM note,\n     .Other = 2\n }"), Want::Refuse, f).await;
	// TX2 (P2 claims): punctuation inside scalars/plain text.
	p(
		"TX2a_INI_VALUE_SEMICOLON",
		EditMode::Patch,
		"s.ini",
		"value=old;\nother=2\n",
		patch("s.ini", "@@\n-value=old\n+value=new;\n other=2"),
		Want::Bytes("value=new;\nother=2\n".into()),
		f,
	)
	.await;
	p(
		"TX2b_YAML_SCALAR_COMMA",
		EditMode::Patch,
		"s.yml",
		"greeting: hello,\nother: world\n",
		patch("s.yml", "@@\n-greeting: hello\n+greeting: goodbye,\n other: world"),
		Want::Bytes("greeting: goodbye,\nother: world\n".into()),
		f,
	)
	.await;
	// TX3 (P2 claim): two string-value edits keeping both commas.
	p(
		"TX3_TWO_STRING_VALUES_KEEP_COMMAS",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: \"old\",\n  b: \"old\",\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: \"old\"\n+  a: \"new\",\n-  b: \"old\"\n+  b: \"new\",\n };",
		),
		Want::Bytes("const o = {\n  a: \"new\",\n  b: \"new\",\n};\n".into()),
		f,
	)
	.await;

	p(
		"GUARD_ERLANG_COMMENT_DECL",
		EditMode::Patch,
		"m.erl",
		"-module(m).\n%% Original docs\nf() -> ok.\n",
		patch("m.erl", "@@ %% Original docs\n+g() -> ok."),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"GUARD_OBJC_COMMENT_DECL",
		EditMode::Patch,
		"F.m",
		"// Original docs\n@interface F\n@end\n",
		patch("F.m", "@@ // Original docs\n+@interface G\n+@end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"GUARD_CLOJURE_COMMENT_DECL",
		EditMode::Patch,
		"f.clj",
		";; Original docs\n(defn f [] 1)\n",
		patch("f.clj", "@@ ;; Original docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"GUARD_NEW_SIBLING_CANNOT_REPLACE_ORIGINAL_SUCCESSOR",
		EditMode::Patch,
		"s.js",
		"const long_variable_name_to_force_character_fallback = { a: 1, b: 2 };\n",
		patch("s.js", "@@\n-a: 1\n+a: 3, b: 999,\n+}; //"),
		Want::Refuse,
		f,
	)
	.await;

	for (before, after) in [("\u{a0}", " "), (" ", "\u{a0}")] {
		let original = "Dim cfg = New Config With {\n    .Value = old,\n    .Other = 2\n}\n";
		let diff = format!(
			"@@\n Dim cfg = New Config With {{\n-    .Value = old\n+    .Value = \
			 updated{before}REM{after}note,\n     .Other = 2\n }}"
		);
		p(
			"GUARD_UNICODE_REM_BOUNDARY",
			EditMode::Patch,
			"s.vb",
			original,
			patch("s.vb", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}

	let deep_docstring =
		format!("def f():\n    {}\"docs\"{}\n    return 1\n", "(".repeat(10_000), ")".repeat(10_000));
	p(
		"GUARD_DEEP_PYTHON_DOCSTRING",
		EditMode::Patch,
		"f.py",
		&deep_docstring,
		patch("f.py", "@@ def f():\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;

	for attribute in ["moduledoc", "doc"] {
		let original =
			format!("defmodule M do\n  @{attribute} \"Original docs\"\n  def f(), do: :ok\nend\n");
		p(
			"GUARD_ELIXIR_BODY_DOC",
			EditMode::Patch,
			"m.ex",
			&original,
			patch("m.ex", "@@ defmodule M do\n+  def g(), do: :new"),
			Want::Bytes(format!(
				"defmodule M do\n  def g(), do: :new\n  @{attribute} \"Original docs\"\n  def f(), \
				 do: :ok\nend\n"
			)),
			f,
		)
		.await;
		p(
			"GUARD_ELIXIR_BODY_DOC_COMMENT",
			EditMode::Patch,
			"m.ex",
			&original,
			patch("m.ex", "@@ defmodule M do\n+  # explanation"),
			Want::Bytes(format!(
				"defmodule M do\n  # explanation\n  @{attribute} \"Original docs\"\n  def f(), do: \
				 :ok\nend\n"
			)),
			f,
		)
		.await;
	}

	p(
		"FG11a_C_VAR_DECLARATION_DOC",
		EditMode::Patch,
		"m.c",
		"// Original docs\nint f;\n",
		patch("m.c", "@@ // Original docs\n+int g;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"FG11b_C_VAR_DECLARATION_COMMENT_ONLY",
		EditMode::Patch,
		"m.c",
		"// Original docs\nint f;\n",
		patch("m.c", "@@ // Original docs\n+// More docs"),
		Want::Bytes("// Original docs\n// More docs\nint f;\n".into()),
		f,
	)
	.await;
	p(
		"FG11c_C_PROTOTYPE_DOC",
		EditMode::Patch,
		"m.h",
		"/* Original docs */\nint f(void);\n",
		patch("m.h", "@@ /* Original docs */\n+int g(void);"),
		Want::Refuse,
		f,
	)
	.await;

	let css = "a {\n  /* Original docs */\n  color: red;\n}\n";
	p(
		"CSS_COMMENT_PROPERTY_ATTACHMENT",
		EditMode::Patch,
		"s.css",
		css,
		patch("s.css", "@@ /* Original docs */\n+  margin: 0;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"CSS_PROPERTY_VALUE_EDIT",
		EditMode::Patch,
		"s.css",
		css,
		patch("s.css", "@@\n a {\n   /* Original docs */\n-  color: red;\n+  color: blue;\n }"),
		Want::Bytes("a {\n  /* Original docs */\n  color: blue;\n}\n".into()),
		f,
	)
	.await;
	p(
		"CSS_AFTER_PROPERTY_INSERT",
		EditMode::Patch,
		"s.css",
		css,
		patch("s.css", "@@ color: red;\n+  margin: 0;"),
		Want::Bytes("a {\n  /* Original docs */\n  color: red;\n  margin: 0;\n}\n".into()),
		f,
	)
	.await;

	for (label, file, original, diff) in [
		(
			"GO_VAR_DECLARATION",
			"m.go",
			"package p\n// Original docs\nvar f int\n",
			"@@ // Original docs\n+var g int",
		),
		(
			"GO_CONST_DECLARATION",
			"m.go",
			"package p\n// Original docs\nconst f = 1\n",
			"@@ // Original docs\n+const g = 2",
		),
		(
			"GO_TYPE_DECLARATION",
			"m.go",
			"package p\n// Original docs\ntype F int\n",
			"@@ // Original docs\n+type G int",
		),
		(
			"TS_LEXICAL_DECLARATION",
			"m.ts",
			"// Original docs\nconst f = 1;\n",
			"@@ // Original docs\n+const g = 2;",
		),
		(
			"CPP_FIELD_DECLARATION",
			"m.cpp",
			"class C {\n  // Original docs\n  int f;\n};\n",
			"@@ // Original docs\n+  int g;",
		),
		(
			"BASH_DECLARATION_COMMAND",
			"m.sh",
			"# Original docs\ndeclare f=1\n",
			"@@ # Original docs\n+declare g=2",
		),
		(
			"CS_LOCAL_DECLARATION_STATEMENT",
			"m.cs",
			"class C {\n  void F() {\n    // Original docs\n    int f;\n  }\n}\n",
			"@@ // Original docs\n+    int g;",
		),
		(
			"SOLIDITY_VARIABLE_DECLARATION_STATEMENT",
			"m.sol",
			"contract C {\n  function f() public {\n    // Original docs\n    uint x;\n  }\n}\n",
			"@@ // Original docs\n+    uint y;",
		),
		(
			"GRAPHQL_DEFINITION",
			"m.graphql",
			"# Original docs\ntype F { value: Int }\n",
			"@@ # Original docs\n+type G { value: Int }",
		),
		(
			"C_MACRO_DEFINITION",
			"m.c",
			"// Original docs\n#define F 1\n",
			"@@ // Original docs\n+#define G 2",
		),
		(
			"C_FUNCTION_MACRO_DEFINITION",
			"m.c",
			"// Original docs\n#define F(x) (x)\n",
			"@@ // Original docs\n+#define G(x) (x)",
		),
		(
			"CMAKE_FUNCTION_DEFINITION",
			"m.cmake",
			"# Original docs\nfunction(f)\nendfunction()\n",
			"@@ # Original docs\n+function(g)\n+endfunction()",
		),
		(
			"CMAKE_MACRO_DEFINITION",
			"m.cmake",
			"# Original docs\nmacro(f)\nendmacro()\n",
			"@@ # Original docs\n+macro(g)\n+endmacro()",
		),
		(
			"ERLANG_MACRO_DEFINITION",
			"m.erl",
			"% Original docs\n-define(F, 1).\n",
			"@@ % Original docs\n+-define(G, 2).",
		),
		(
			"MAKE_DEFINE_DIRECTIVE",
			"Makefile",
			"# Original docs\ndefine F\nvalue\nendef\n",
			"@@ # Original docs\n+define G\n+value\n+endef",
		),
	] {
		p(label, EditMode::Patch, file, original, patch(file, diff), Want::Refuse, f).await;
	}

	for (label, old, new) in [
		("XML_GENERAL_ENTITY", "<!ENTITY f \"f\">", "<!ENTITY g \"g\">"),
		("XML_PARAMETER_ENTITY", "<!ENTITY % f \"f\">", "<!ENTITY % g \"g\">"),
		("XML_ELEMENT_DECLARATION", "<!ELEMENT f EMPTY>", "<!ELEMENT g EMPTY>"),
		(
			"XML_ATTRIBUTE_DECLARATION",
			"<!ATTLIST root f CDATA #IMPLIED>",
			"<!ATTLIST root g CDATA #IMPLIED>",
		),
		("XML_NOTATION_DECLARATION", "<!NOTATION f SYSTEM \"f\">", "<!NOTATION g SYSTEM \"g\">"),
	] {
		let original = format!("<!DOCTYPE root [\n<!-- Original docs -->\n{old}\n]>\n<root/>\n");
		p(
			label,
			EditMode::Patch,
			"m.xml",
			&original,
			patch("m.xml", &format!("@@ <!-- Original docs -->\n+{new}")),
			Want::Refuse,
			f,
		)
		.await;
	}
	p(
		"XML_COMMENT_ONLY",
		EditMode::Patch,
		"m.xml",
		"<!DOCTYPE root [\n<!-- Original docs -->\n<!ENTITY f \"f\">\n]>\n<root/>\n",
		patch("m.xml", "@@ <!-- Original docs -->\n+<!-- More docs -->"),
		Want::Bytes(
			"<!DOCTYPE root [\n<!-- Original docs -->\n<!-- More docs -->\n<!ENTITY f \
			 \"f\">\n]>\n<root/>\n"
				.into(),
		),
		f,
	)
	.await;

	assert!(fails.is_empty(), "round-11 placement regressions: {fails:?}");
}
