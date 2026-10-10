//! Order-independent placement, syntax ownership, and separator regressions.
mod common;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::{Value, json};

enum Want {
	/// Must succeed with exactly these bytes.
	Bytes(String),
	/// The contract permits clean refusal or an edit confined to these bytes.
	BytesOrRefuse(String),
	/// Must refuse cleanly.
	Refuse,
	/// Must refuse cleanly, and the message must satisfy the predicate.
	RefuseMsg(fn(&str) -> bool),
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
	let msg = result.as_ref().err().map_or("", String::as_str);
	let ok = match &want {
		Want::Bytes(b) => result.is_ok() && &after == b,
		Want::BytesOrRefuse(b) => refused_clean || (result.is_ok() && &after == b),
		Want::Refuse => refused_clean,
		Want::RefuseMsg(check) => refused_clean && check(msg),
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
			Want::RefuseMsg(check) => {
				refused_clean && check(r.as_ref().err().map_or("", String::as_str))
			},
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
async fn round10_review_regressions() {
	let mut fails = Vec::new();
	let f = &mut fails;

	// ---- R10MultiHunkReview (early)
	// H0: identical old lines, different new lines, no distinguishing context
	// (B7 in-order assignment).
	both(
		"H0_IDENTICAL_OLD_DIFFERENT_NEW",
		"t.txt",
		"a\nx\na\nx\n",
		"@@\n a\n-x\n+X",
		"@@\n a\n-x\n+Y",
		Want::Refuse,
		f,
	)
	.await;
	// H0 control: identical old AND new lines stay order-free (B7/AP4).
	both(
		"H0c_IDENTICAL_OLD_IDENTICAL_NEW",
		"t.txt",
		"a\nx\na\nx\n",
		"@@\n a\n-x\n+X",
		"@@\n a\n-x\n+X",
		Want::Bytes("a\nX\na\nX\n".into()),
		f,
	)
	.await;
	// H1: numeric-hinted twin hunks; the second's exact best is consumed by the
	// first (MH1 with hints instead of anchors).
	both(
		"H1_UNANCHORED_CONSUMED_BEST",
		"t.txt",
		"a\nval = 1\na\nval = 1   \n",
		"@@ -1,2 +1,2 @@\n a\n-val = 1\n+val = 2",
		"@@ -1,2 +1,2 @@\n a\n-val = 1\n+val = 3",
		Want::Refuse,
		f,
	)
	.await;
	// H1 control: no hints, bare hunks.
	both(
		"H1c_BARE_CONSUMED_BEST",
		"t.txt",
		"a\nval = 1\na\nval = 1   \n",
		"@@\n a\n-val = 1\n+val = 2",
		"@@\n a\n-val = 1\n+val = 3",
		Want::Refuse,
		f,
	)
	.await;

	// A hunk's own exact hint fixes one twin; changed-row elimination then
	// resolves the other, even when the two replacements differ.
	both(
		"G_H_INDEPENDENT_HINT_FIXES_TWIN",
		"t.py",
		"if ok:\n    run()\nx\nif ok:\n    run()\n",
		"@@\n if ok:\n-    run()\n+    stop()",
		"@@ -1,2 +1,2 @@\n if ok:\n-    run()\n+    start()",
		Want::Bytes("if ok:\n    start()\nx\nif ok:\n    stop()\n".into()),
		f,
	)
	.await;

	// H2 (parent): the anchor-less cursor rule uses listing order as placement
	// evidence.
	both(
		"H2_CURSOR_ORDER",
		"notes.txt",
		"x = 1\n[b]\ny = 1\nx = 1\n",
		"@@\n-y = 1\n+y = 2",
		"@@\n-x = 1\n+x = 3",
		Want::Refuse,
		f,
	)
	.await;
	// H2 control: disjoint edits cannot resolve an unbound twin in either order.
	both(
		"H2c_AP0D_BOTH_ORDERS",
		"notes.txt",
		"[a]\nx = 1\n[b]\ny = 1\n[c]\nx = 1\n",
		"@@\n-y = 1\n+y = 2",
		"@@\n-x = 1\n+x = 3",
		Want::Refuse,
		f,
	)
	.await;

	// H3 (P2 claims): later same-path edits that target text an earlier edit
	// wrote.
	{
		let e1 = json!({ "op": "update", "diff": "@@\n a\n-result = calculate_value(argument, 100);\n+result = calculate_value(argument, 101);" });
		let e2 = json!({ "op": "update", "diff": "@@\n a\n-result = calculate_value(argument, 101);\n+result = calculate_value(argument, 102);" });
		p(
			"H3a_REWRITE_WRITTEN_VALUE_WITH_CONTEXT",
			EditMode::Patch,
			"t.txt",
			"a\nresult = calculate_value(argument, 100);\n",
			json!({ "path": "t.txt", "edits": [e1.clone(), e2] }),
			Want::Bytes("a\nresult = calculate_value(argument, 102);\n".into()),
			f,
		)
		.await;
		let e2b = json!({ "op": "update", "diff": "@@\n-result = calculate_value(argument, 101);\n+result = calculate_value(argument, 102);" });
		p(
			"H3b_REWRITE_WRITTEN_VALUE_BARE_CONTROL",
			EditMode::Patch,
			"t.txt",
			"a\nresult = calculate_value(argument, 100);\n",
			json!({ "path": "t.txt", "edits": [e1, e2b] }),
			Want::Bytes("a\nresult = calculate_value(argument, 102);\n".into()),
			f,
		)
		.await;
		let m1 = json!({ "op": "update", "diff": "@@\n a\n-foo\n b\n+foo" });
		let m2 = json!({ "op": "update", "diff": "@@\n-foo\n+bar" });
		p(
			"H3c_MOVED_ROW_THEN_EDIT",
			EditMode::Patch,
			"t.txt",
			"a\nfoo\nb\n",
			json!({ "path": "t.txt", "edits": [m1, m2] }),
			Want::Bytes("a\nb\nbar\n".into()),
			f,
		)
		.await;
		let input = "*** Begin Patch\n*** Update File: t.txt\n@@\n a\n-foo\n b\n+foo\n*** Update \
		             File: t.txt\n@@\n-foo\n+bar\n*** End Patch";
		p(
			"H3d_MOVED_ROW_THEN_EDIT_APPLY_PATCH",
			EditMode::ApplyPatch,
			"t.txt",
			"a\nfoo\nb\n",
			json!({ "input": input }),
			Want::Bytes("a\nb\nbar\n".into()),
			f,
		)
		.await;
	}

	// H4 (P1 claim): the newly-written-context exemption is global, not
	// placement-local.
	{
		let original = "[a]\nmarker = existing_context_with_long_unique_name();\nvalue = \
		                compute_value(argument, 100);\n[other]\nmarker = \
		                existing_context_with_long_unique_namXYZ();\nvalue = \
		                compute_value(argument, 100);\nEND\n";
		let first = "@@\n [a]\n marker = existing_context_with_long_unique_name();\n-value = \
		             compute_value(argument, 100);\n+value = 0;";
		let insert = "@@\n+marker = existing_context_with_long_unique_names();";
		let e2 = json!({ "op": "update", "diff": "@@\n marker = existing_context_with_long_unique_names();\n-value = compute_value(argument, 100);\n+value = compute_value(argument, 200);" });
		for (order, diff) in [format!("{first}\n{insert}"), format!("{insert}\n{first}")]
			.into_iter()
			.enumerate()
		{
			p(
				&format!("H4a_UNRELATED_WRITTEN_CONTEXT_BYPASS_{order}"),
				EditMode::Patch,
				"t.txt",
				original,
				json!({ "path": "t.txt", "edits": [{"op":"update","diff":diff}, e2.clone()] }),
				Want::Refuse,
				f,
			)
			.await;
		}
		let e1c = json!({ "op": "update", "diff": "@@\n [a]\n marker = existing_context_with_long_unique_name();\n-value = compute_value(argument, 100);\n+value = 0;" });
		p(
			"H4b_NO_WRITTEN_CONTEXT_CONTROL",
			EditMode::Patch,
			"t.txt",
			original,
			json!({ "path": "t.txt", "edits": [e1c, e2] }),
			Want::Refuse,
			f,
		)
		.await;
	}

	// ---- R10RegionReview (early)
	// RZ0 (P1 claim): a labelled loop's statement-list descent picks the label,
	// not the loop.
	p("RZ0a_SWIFT_LABELED_LOOP", EditMode::Patch, "label.swift",
		"func f() {\n  outer: while ready {\n    notify(x1)\n  };\n}\nfunc g() {\n  while done {\n    notify(x)\n  }\n}\n",
		patch("label.swift", "@@ outer: while ready {\n-    notify(x)\n+    notify(y)"),
		Want::BytesOrRefuse("func f() {\n  outer: while ready {\n    notify(y)\n  };\n}\nfunc g() {\n  while done {\n    notify(x)\n  }\n}\n".into()), f).await;
	p(
		"RZ0b_KOTLIN_LABELED_LOOP",
		EditMode::Patch,
		"label.kt",
		"fun f() {\n    outer@ while (ready) {\n        notify(x1)\n    };\n}\nfun g() {\n    while \
		 (done) {\n        notify(x)\n    }\n}\n",
		patch("label.kt", "@@ outer@ while (ready) {\n-        notify(x)\n+        notify(y)"),
		Want::BytesOrRefuse(
			"fun f() {\n    outer@ while (ready) {\n        notify(y)\n    };\n}\nfun g() {\n    \
			 while (done) {\n        notify(x)\n    }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	// RZ0 controls (P2 claims): the same files with the target inside the
	// labelled loop edit f only.
	p("RZ0c_SWIFT_LABELED_LOOP_CONTROL", EditMode::Patch, "label.swift",
		"func f() {\n  outer: while ready {\n    notify(x)\n  };\n}\nfunc g() {\n  while done {\n    notify(x)\n  }\n}\n",
		patch("label.swift", "@@ outer: while ready {\n-    notify(x)\n+    notify(y)"),
		Want::Bytes("func f() {\n  outer: while ready {\n    notify(y)\n  };\n}\nfunc g() {\n  while done {\n    notify(x)\n  }\n}\n".into()), f).await;
	p(
		"RZ0d_KOTLIN_LABELED_LOOP_CONTROL",
		EditMode::Patch,
		"label.kt",
		"fun f() {\n    outer@ while (ready) {\n        notify(x)\n    };\n}\nfun g() {\n    while \
		 (done) {\n        notify(x)\n    }\n}\n",
		patch("label.kt", "@@ outer@ while (ready) {\n-        notify(x)\n+        notify(y)"),
		Want::Bytes(
			"fun f() {\n    outer@ while (ready) {\n        notify(y)\n    };\n}\nfun g() {\n    \
			 while (done) {\n        notify(x)\n    }\n}\n"
				.into(),
		),
		f,
	)
	.await;

	// H5 (P1 claim): an EOF append lands after a trailing blank row, not before
	// it.
	p(
		"H5a_EOF_AFTER_TRAILING_BLANK",
		EditMode::Patch,
		"t.txt",
		"a\n\n",
		patch("t.txt", "@@\n+X\n*** End of File"),
		Want::Bytes("a\n\nX\n".into()),
		f,
	)
	.await;
	both(
		"H5b_TRAILING_BLANK_DISTINCT_GAPS",
		"t.txt",
		"a\n\n",
		"@@\n+X\n*** End of File",
		"@@ a\n+Y",
		Want::Bytes("a\nY\n\nX\n".into()),
		f,
	)
	.await;
	// H5 control: the plain no-context append (no EOF marker) on the same file.
	p(
		"H5c_PLAIN_APPEND_TRAILING_BLANK",
		EditMode::Patch,
		"t.txt",
		"a\n\n",
		patch("t.txt", "@@\n+X"),
		Want::Bytes("a\n\nX\n".into()),
		f,
	)
	.await;

	// H6 (P1 claim): an insertion between two consecutive context rows of
	// another hunk breaks that hunk's adjacency.
	both(
		"H6a_INSERT_BETWEEN_INTERIOR_CONTEXT_ROWS",
		"t.txt",
		"a\nb\nc\nd\ne\nf\n",
		"@@\n a\n-b\n+B\n c\n d\n-e\n+E\n f",
		"@@ c\n+X",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"H6b_INSERT_BETWEEN_TRAILING_CONTEXT_ROWS",
		"t.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n-b\n+B\n c\n d\n e",
		"@@ c\n+X",
		Want::Refuse,
		f,
	)
	.await;
	// H6 control: an insertion just outside the other hunk's context applies in
	// both orders.
	both(
		"H6c_INSERT_OUTSIDE_CONTEXT_CONTROL",
		"t.txt",
		"a\nb\nc\nd\ne\nf\ng\n",
		"@@\n a\n-b\n+B\n c",
		"@@ e\n+X",
		Want::Bytes("a\nB\nc\nd\ne\nX\nf\ng\n".into()),
		f,
	)
	.await;

	// H7 (P2 claim): two disjoint character edits on one row through same-path
	// edits / sections.
	{
		let e1 = json!({ "op": "update", "diff": "@@\n-alpha\n+ALPHA" });
		let e2 = json!({ "op": "update", "diff": "@@\n-beta\n+BETA" });
		p(
			"H7a_DISJOINT_CHAR_EDITS_SAME_ROW",
			EditMode::Patch,
			"t.txt",
			"alpha beta\n",
			json!({ "path": "t.txt", "edits": [e1, e2] }),
			Want::Bytes("ALPHA BETA\n".into()),
			f,
		)
		.await;
		let input = "*** Begin Patch\n*** Update File: t.txt\n@@\n-alpha\n+ALPHA\n*** Update File: \
		             t.txt\n@@\n-beta\n+BETA\n*** End Patch";
		p(
			"H7b_DISJOINT_CHAR_SECTIONS_SAME_ROW",
			EditMode::ApplyPatch,
			"t.txt",
			"alpha beta\n",
			json!({ "input": input }),
			Want::Bytes("ALPHA BETA\n".into()),
			f,
		)
		.await;
	}

	// A matched @@ confines the whole hunk to its construct: exact context
	// cannot authorize changed rows in a later sibling block.
	p(
		"RZ1a_CONTEXT_CROSSES_ANCHOR_BLOCK",
		EditMode::Patch,
		"boundary.py",
		"def first():\n    before()\ndef second():\n    notify(x)\n",
		patch(
			"boundary.py",
			"@@ def first():\n     before()\n def second():\n-    notify(x)\n+    notify(y)",
		),
		Want::Refuse,
		f,
	)
	.await;
	// RZ1 control: YAML keep-chomping block scalar edit inside the anchored key.
	p(
		"RZ1b_YAML_KEEP_SCALAR_CONTROL",
		EditMode::Patch,
		"scalar.yml",
		"message: |+\n  hello\n  \nother: |+\n  hello\n  \n",
		patch("scalar.yml", "@@ message: |+\n   hello\n-  \n+  tail"),
		Want::Bytes("message: |+\n  hello\n  tail\nother: |+\n  hello\n  \n".into()),
		f,
	)
	.await;

	// RZ2 (P2 claim): a keep-chomping block scalar owns its trailing blank row.
	p(
		"RZ2_YAML_SCALAR_OWNED_BLANK_ROW",
		EditMode::Patch,
		"scalar.yml",
		"message: |+\n  hello\n  \nother: |+\n  hello\n  \n",
		patch("scalar.yml", "@@ message: |+\n-  \n+  tail\n other: |+"),
		Want::Bytes("message: |+\n  hello\n  tail\nother: |+\n  hello\n  \n".into()),
		f,
	)
	.await;
	// RZ3 (P1 claim): an ERROR sibling inside a statement list must not make the
	// anchored hunk escape to another function.
	p(
		"RZ3a_GO_ERROR_SIBLING_ESCAPE",
		EditMode::Patch,
		"recover.go",
		"package p\n\nfunc f() {\n    if ready {\n        notify(x1)\n    }\n  broken = = \
		 1\n}\nfunc g() {\n        notify(x)\n}\n",
		patch("recover.go", "@@ if ready {\n-        notify(x)\n+        notify(y)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"RZ3b_GO_ERROR_SAME_INDENT_CONTROL",
		EditMode::Patch,
		"recover.go",
		"package p\n\nfunc f() {\n    if ready {\n        notify(x1)\n    }\n    broken = = \
		 1\n}\nfunc g() {\n        notify(x)\n}\n",
		patch("recover.go", "@@ if ready {\n-        notify(x)\n+        notify(y)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"RZ3c_GO_ERROR_SIBLING_TARGET_INSIDE",
		EditMode::Patch,
		"recover.go",
		"package p\n\nfunc f() {\n    if ready {\n        notify(x)\n    }\n  broken = = 1\n}\nfunc \
		 g() {\n        notify(x)\n}\n",
		patch("recover.go", "@@ if ready {\n-        notify(x)\n+        notify(y)"),
		Want::Bytes(
			"package p\n\nfunc f() {\n    if ready {\n        notify(y)\n    }\n  broken = = \
			 1\n}\nfunc g() {\n        notify(x)\n}\n"
				.into(),
		),
		f,
	)
	.await;

	// H8 controls (final multi-hunk coverage).
	both(
		"H8a_DELETION_HINT_EDGE",
		"t.txt",
		"a\nb\nc\n",
		"@@\n a\n-b\n c",
		"@@ -3,0 +3,1 @@\n+X",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"H8b_DELETION_EOF_SHARED_ANCHOR",
		"t.txt",
		"a\nb\n",
		"@@\n a\n-b",
		"@@ a\n+X",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"H8c_DELETE_WITH_NEIGHBOUR_REWRITE",
		"t.txt",
		"a\nb\nc\n",
		"@@\n a\n-b\n c",
		"@@\n-c\n+C",
		Want::Bytes("a\nC\n".into()),
		f,
	)
	.await;
	both(
		"H8d_TOP_BOUNDARY_AND_BELOW_TIE",
		"t.txt",
		"a\nb\n",
		"@@ top of file\n+X",
		"@@\n+Y\n a",
		Want::Bytes("X\nY\na\nb\n".into()),
		f,
	)
	.await;
	{
		let perms: [[usize; 3]; 6] =
			[[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
		let same_gap = ["@@ a\n+X", "@@\n+Y\n b", "@@ -2,0 +2,1 @@\n+Z"];
		let distinct = ["@@ a\n+X", "@@ b\n+Y", "@@\n+Z"];
		for (i, order) in perms.iter().enumerate() {
			let diff = order
				.iter()
				.map(|&k| same_gap[k])
				.collect::<Vec<_>>()
				.join("\n");
			p(
				&format!("H8e_THREE_HUNK_SAME_GAP_{i}"),
				EditMode::Patch,
				"t.txt",
				"a\nb\n",
				patch("t.txt", &diff),
				Want::Refuse,
				f,
			)
			.await;
			let diff = order
				.iter()
				.map(|&k| distinct[k])
				.collect::<Vec<_>>()
				.join("\n");
			p(
				&format!("H8f_THREE_DISTINCT_GAPS_{i}"),
				EditMode::Patch,
				"t.txt",
				"a\nb\nc\n",
				patch("t.txt", &diff),
				Want::Bytes("a\nX\nb\nY\nc\nZ\n".into()),
				f,
			)
			.await;
		}
	}
	// H9 (P2 claim): a later same-path edit whose original tie partner was
	// consumed applies to the equally exact survivor.
	{
		let e1 = json!({ "op": "update", "diff": "@@\n a\n-value\n+VALUE\n b" });
		let e2 = json!({ "op": "update", "diff": "@@\n-value\n+changed" });
		p(
			"H9_SEQUENTIAL_EQUAL_EXACT_SURVIVOR",
			EditMode::Patch,
			"t.txt",
			"a\nvalue\nb\nvalue\n",
			json!({ "path": "t.txt", "edits": [e1, e2] }),
			Want::Bytes("a\nVALUE\nb\nchanged\n".into()),
			f,
		)
		.await;
	}

	// H10 (P1 claim): rows inserted by an earlier same-path edit get no
	// consumption record, so a later stale edit inherits a looser twin.
	{
		let u1 = json!({ "op": "update", "diff": "@@ [a]\n [a]\n-val = 1\n+val = 2" });
		let u2 = json!({ "op": "update", "diff": "@@ [a]\n [a]\n-val = 1\n+val = 3" });
		let refill =
			json!({ "op": "update", "diff": "@@\n root\n+[a]\n+val = 1\n+[a]\n+val = 1   " });
		p(
			"H10a_INSERTED_ROWS_STALE_TWIN_FWD",
			EditMode::Patch,
			"t.txt",
			"root\n",
			json!({ "path": "t.txt", "edits": [refill.clone(), u1.clone(), u2.clone()] }),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"H10b_INSERTED_ROWS_STALE_TWIN_REV",
			EditMode::Patch,
			"t.txt",
			"root\n",
			json!({ "path": "t.txt", "edits": [refill, u2.clone(), u1.clone()] }),
			Want::Refuse,
			f,
		)
		.await;
		let create = json!({ "op": "create", "diff": "[a]\nval = 1\n[a]\nval = 1   \n" });
		p(
			"H10c_CREATED_ROWS_STALE_TWIN",
			EditMode::Patch,
			"t.txt",
			"",
			json!({ "path": "t.txt", "edits": [create, u1, u2] }),
			Want::Refuse,
			f,
		)
		.await;
	}

	// RZ4: Rust inner attributes retain their token-tree region, not the next
	// item.
	{
		let original =
			"#![doc = stringify!({\n    marker()\n})]\nfn marker() {}\nfn main() {\n    marker()\n}\n";
		p(
			"RZ4a_RUST_INNER_ATTR_TOKEN_TREE",
			EditMode::Patch,
			"inner.rs",
			original,
			patch("inner.rs", "@@ #![doc = stringify!({\n-    marker()\n+    changed()"),
			Want::Bytes(
				"#![doc = stringify!({\n    changed()\n})]\nfn marker() {}\nfn main() {\n    \
				 marker()\n}\n"
					.into(),
			),
			f,
		)
		.await;
		p(
			"RZ4b_RUST_INNER_ATTR_MAIN_CONTROL",
			EditMode::Patch,
			"inner.rs",
			original,
			patch("inner.rs", "@@ fn main() {\n-    marker()\n+    changed()"),
			Want::Bytes(
				"#![doc = stringify!({\n    marker()\n})]\nfn marker() {}\nfn main() {\n    \
				 changed()\n}\n"
					.into(),
			),
			f,
		)
		.await;
	}

	// ---- R10InsertionReview
	// IZ0 (P1 claim): Rust outer doc comments are attributes of the following
	// item.
	p(
		"IZ0_RUST_DOC_ATTRIBUTE",
		EditMode::Patch,
		"lib.rs",
		"/// Original function docs\nfn f() {}\n",
		patch("lib.rs", "@@ /// Original function docs\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	// IZ1 (P1 claim): Swift if-statement branches without field names keep their
	// identity.
	p(
		"IZ1_SWIFT_FIELDLESS_BRANCH",
		EditMode::Patch,
		"s.swift",
		"func f(_ ok: Bool) {\n  if ok {\n    print(\"before\")\n    print(\"target\")\n  }\n}\n",
		patch("s.swift", "@@ print(\"before\")\n+  } else {"),
		Want::Refuse,
		f,
	)
	.await;
	// IZ2 (P1 claim): an insertion that splits a multi-line leaf changes its
	// owner.
	p(
		"IZ2a_YAML_SPLIT_SCALAR_OWNER",
		EditMode::Patch,
		"data.yml",
		"key: first\n  second\n",
		patch("data.yml", "@@ key: first\n+other:"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IZ2b_MD_SPLIT_PARAGRAPH_OWNER",
		EditMode::Patch,
		"d.md",
		"## Usage\nFirst line.\nSecond line.\n",
		patch("d.md", "@@ First line.\n+## Install"),
		Want::Refuse,
		f,
	)
	.await;
	// IZ3 (P1 claim): a same-kind container covering the old one's span is not
	// proof the old container survived.
	p(
		"IZ3_MD_GROWTH_CAPTURES_LIST",
		EditMode::Patch,
		"d.md",
		"# Usage\n  - first\n  - second\n",
		patch("d.md", "@@ # Usage\n+- wrapper\n+  ```"),
		Want::Refuse,
		f,
	)
	.await;
	// IZ4 (P3): an Allman method's refusal names the method, not its bare brace.
	p(
		"IZ4_ALLMAN_OWNER_MESSAGE",
		EditMode::Patch,
		"C.cs",
		"class C\n{\n    void F()\n    {\n        Before();\n        Target();\n    }\n}\n",
		patch("C.cs", "@@ Before();\n+    }\n+    void G()\n+    {"),
		Want::RefuseMsg(|m| m.contains("'void F()'") && m.contains("'Target();'")),
		f,
	)
	.await;
	// IZ5 (P2): a decorator insertion accompanied by a comment applies.
	p(
		"IZ5_DECORATOR_WITH_COMMENT",
		EditMode::Patch,
		"d.py",
		"marker = 1\ndef f():\n    pass\n",
		patch("d.py", "@@ marker = 1\n+@cache\n+# explanation"),
		Want::Bytes("marker = 1\n@cache\n# explanation\ndef f():\n    pass\n".into()),
		f,
	)
	.await;

	// ---- R10TokenGuardReview
	// TZ0 (P1 claim): a following spread entry must not lend its comma.
	p(
		"TZ0_SPREAD_SEPARATOR",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("s.js", "@@\n const o = {\n-  a: 1\n+  a: 5\n+  ...extra,\n   b: 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	// TZ1 (P1 claim): Rust raw strings stay opaque until their hash-delimited
	// closer.
	p("TZ1_RUST_RAW_SEPARATOR", EditMode::Patch, "lib.rs", "const S: S = S {\n    value: old,\n    other: 2,\n};\n",
		patch("lib.rs", "@@\n const S: S = S {\n-    value: old\n+    value: r#\"first \"\n+        hidden,\n+        last\"#\n     other: 2,\n };"), Want::Refuse, f).await;
	// TZ2 (P1 claim): regex-literal punctuation is not code.
	p(
		"TZ2_REGEX_CLOSER_SEPARATOR",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("s.js", "@@\n const o = {\n-  a: 1\n+  a: compute(/\\)/,\n+    5)\n   b: 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	// TZ3 (P1 claim): heredoc bodies are literal.
	p(
		"TZ3_HEREDOC_SEPARATOR",
		EditMode::Patch,
		"v.php",
		"<?php\n$values = [\n    'a' => old,\n    'b' => 2,\n];\n",
		patch(
			"v.php",
			"@@\n $values = [\n-    'a' => old\n+    'a' => <<<TXT\n+        text,\n+    TXT\n     \
			 'b' => 2,\n ];",
		),
		Want::Refuse,
		f,
	)
	.await;
	// TZ4 (P1 claim): C# verbatim strings escape quotes by doubling, not
	// backslash.
	{
		let diff = [
			"@@",
			" var o = new Config {",
			"-    Value = old",
			r#"+    Value = Compute(@"first\"""#,
			"+        ),",
			r#"+        last")"#,
			"     Other = 2,",
			" };",
		]
		.join("\n");
		p(
			"TZ4_CS_VERBATIM_WRONG_WRITE",
			EditMode::Patch,
			"s.cs",
			"var o = new Config {\n    Value = old,\n    Other = 2,\n};\n",
			patch("s.cs", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}
	// TZ5 (P1 claim): same-quote f-string expressions stay literal for depth.
	p(
		"TZ5_PY_FSTRING_SEPARATOR",
		EditMode::Patch,
		"s.py",
		"CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n",
		patch(
			"s.py",
			"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=compute(f\"{\")\"}\",\n+        \
			 MIN_TIMEOUT)\n     retries=3,\n )",
		),
		Want::Refuse,
		f,
	)
	.await;
	// TZ6 (P2 claims): legitimate edits that keep their own separator.
	p(
		"TZ6a_TS_RETURN_ANNOTATION",
		EditMode::Patch,
		"s.ts",
		"const o = {\n  a: old,\n  b: 2,\n};\n",
		patch(
			"s.ts",
			"@@\n const o = {\n-  a: old\n+  a:\n+    (x: number): number => x + 1,\n   b: 2,\n };",
		),
		Want::Bytes("const o = {\n  a:\n    (x: number): number => x + 1,\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	p(
		"TZ6b_PHP_FN_VARIABLE_RENAME",
		EditMode::Patch,
		"v.php",
		"<?php\n$values = [\n    'a' => $fn,\n    'b' => 2,\n];\n",
		patch("v.php", "@@\n $values = [\n-    'a' => $fn\n+    'a' => $fn2,\n     'b' => 2,\n ];"),
		Want::Bytes("<?php\n$values = [\n    'a' => $fn2,\n    'b' => 2,\n];\n".into()),
		f,
	)
	.await;
	p("TZ6c_PY_SPLIT_LAMBDA_BODY", EditMode::Patch, "s.py", "CONFIG = dict(\n    handler=old_handler,\n    retries=2,\n)\n",
		patch("s.py", "@@\n CONFIG = dict(\n-    handler=old_handler\n+    handler=\n+        lambda x:\n+            x + 1,\n     retries=2,\n )"),
		Want::Bytes("CONFIG = dict(\n    handler=\n        lambda x:\n            x + 1,\n    retries=2,\n)\n".into()), f).await;
	p(
		"TZ6d_RUST_CONTINUED_BITOR",
		EditMode::Patch,
		"lib.rs",
		"let config = Config {\n    flags: OLD,\n    other: 2,\n};\n",
		patch(
			"lib.rs",
			"@@\n let config = Config {\n-    flags: OLD\n+    flags: Flags::A\n+        | \
			 Flags::B,\n     other: 2,\n };",
		),
		Want::Bytes(
			"let config = Config {\n    flags: Flags::A\n        | Flags::B,\n    other: 2,\n};\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"TZ6e_VB_COMMENT_BEFORE_VALUE",
		EditMode::Patch,
		"s.vb",
		"Dim cfg = New Config With {\n    .Value = old,\n    .Other = 2\n}\n",
		patch(
			"s.vb",
			"@@\n Dim cfg = New Config With {\n-    .Value = old\n+    ' value note\n+    .Value = \
			 updated,\n     .Other = 2\n }",
		),
		Want::Bytes(
			"Dim cfg = New Config With {\n    ' value note\n    .Value = updated,\n    .Other = \
			 2\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"TZ6f_BLOCK_COMMENT_NOT_COUNTERPART",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: compute_old(base),\n  b: 2,\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: compute_old(base)\n+  /* a: compute_old(base) */\n+  a: 5,\n   \
			 b: 2,\n };",
		),
		Want::Bytes("const o = {\n  /* a: compute_old(base) */\n  a: 5,\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	// Large digit-separator values must preserve refusal semantics.
	for n in [4096usize, 8192, 16384] {
		let hex = format!("0xAA{}", "'AA".repeat(n));
		let diff =
			format!("@@\n int values[] = {{\n-  1\n+  {hex} + std::max(0,\n+    1)\n   2,\n }};");
		p(
			&format!("TZ7_HEX_SCAN_COST_{n}"),
			EditMode::Patch,
			"v.cpp",
			"int values[] = {\n  1,\n  2,\n};\n",
			patch("v.cpp", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}

	// ---- parent addenda
	// IZ0b-e: dedicated doc-comment syntax attaches to the following declaration
	// like an attribute.
	p(
		"IZ0b_RUST_BLOCK_DOC_ATTRIBUTE",
		EditMode::Patch,
		"lib.rs",
		"/** Original docs */\nfn f() {}\n",
		patch("lib.rs", "@@ /** Original docs */\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IZ0c_CSHARP_XML_DOC",
		EditMode::Patch,
		"C.cs",
		"class C {\n    /// <summary>Docs</summary>\n    void F() {}\n}\n",
		patch("C.cs", "@@ /// <summary>Docs</summary>\n+    void G() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IZ0d_JAVA_JAVADOC",
		EditMode::Patch,
		"C.java",
		"class C {\n    /** Docs */\n    void f() {}\n}\n",
		patch("C.java", "@@ /** Docs */\n+    void g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IZ0e_JS_JSDOC",
		EditMode::Patch,
		"s.js",
		"/** Docs */\nfunction f() {}\n",
		patch("s.js", "@@ /** Docs */\n+function g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	// IZ0f: any touching comment run attaches to the declaration.
	p(
		"IZ0f_GO_PLAIN_COMMENT_CONTROL",
		EditMode::Patch,
		"s.go",
		"package p\n\n// section\nfunc f() {}\n",
		patch("s.go", "@@ // section\n+func g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	// TZ8: implicit string concatenation must not absorb a dropped list
	// separator.
	p(
		"TZ8a_PY_IMPLICIT_CONCAT_TRIVIAL",
		EditMode::Patch,
		"s.py",
		"names = [\n    \"alice\",\n    \"bob\",\n]\n",
		patch("s.py", "@@\n names = [\n-    \"alice\"\n+    \"alicia\"\n     \"bob\",\n ]"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TZ8b_PY_IMPLICIT_CONCAT_CONTINUATION",
		EditMode::Patch,
		"s.py",
		"names = [\n    \"alice\",\n    \"bob\",\n]\n",
		patch(
			"s.py",
			"@@\n names = [\n-    \"alice\"\n+    \"alicia\"\n+    \"x\",\n     \"bob\",\n ]",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TZ8c_C_ADJACENT_STRING_CONTINUATION",
		EditMode::Patch,
		"t.c",
		"const char *names[] = {\n    \"alice\",\n    \"bob\",\n};\n",
		patch(
			"t.c",
			"@@\n const char *names[] = {\n-    \"alice\"\n+    \"alicia\"\n+    \"x\",\n     \
			 \"bob\",\n };",
		),
		Want::Refuse,
		f,
	)
	.await;

	assert!(fails.is_empty(), "round-10 placement regressions: {fails:?}");
}

#[tokio::test]
async fn separator_ownership_regressions() {
	let mut fails = Vec::new();
	let f = &mut fails;
	let object = "const o = {\n  a: 1,\n  b: 2,\n};\n";
	p(
		"G_J_DOUBLED_COMMA",
		EditMode::Patch,
		"s.js",
		object,
		patch("s.js", "@@ const o = {\n-  a: 1\n+  a: 3,\n+  [key]: 4,"),
		Want::Bytes("const o = {\n  a: 3,\n  [key]: 4,\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	p(
		"G_J_COMMA_BORROWED_BY_NEW_ELEMENT",
		EditMode::Patch,
		"s.js",
		object,
		patch("s.js", "@@ const o = {\n-  a: 1\n+  a: 3\n+  [key]: 4,"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_INDEX_DESIGNATOR",
		EditMode::Patch,
		"s.c",
		"enum { INDEX = 2 };\nvoid f(void) {\n  int item[3] = {0};\n  int values[] = {\n    [0] = \
		 1,\n    [1] = 2,\n  };\n}\n",
		patch(
			"s.c",
			"@@\n   int values[] = {\n-    [0] = 1\n+    [0] = item\n+    [INDEX] = 3,\n     [1] = \
			 2,\n   };",
		),
		Want::Refuse,
		f,
	)
	.await;
	for (old, inserted) in [(".a[0]", ".b"), (".a", ".b[INDEX]")] {
		let original = format!("struct S s = {{\n  {old} = 1,\n  .c = 2,\n}};\n");
		let diff = format!(
			"@@\n struct S s = {{\n-  {old} = 1\n+  {old} = 3\n+  {inserted} = 4,\n   .c = 2,\n }};"
		);
		p(
			&format!("G_J_DESIGNATOR_{old}_{inserted}"),
			EditMode::Patch,
			"s.c",
			&original,
			patch("s.c", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}
	p(
		"G_J_LITERAL_COMMA",
		EditMode::Patch,
		"s.js",
		"const o = {\n  name: \"abc,\",\n  other: 2,\n};\n",
		patch("s.js", "@@ const o = {\n-  name: \"abc\"\n+  name: \"def\","),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_MIXED_CLOSER",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: foo(x),\n  b: 2,\n};\n",
		patch("s.js", "@@ const o = {\n-  a: foo(x\n+  a: bar,"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_TERMINATOR_OWNER",
		EditMode::Patch,
		"s.js",
		"const v =\n  original;\n(thing);\n",
		patch("s.js", "@@\n const v =\n-  original\n+  replacement"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_TRIVIAL_SEMICOLON",
		EditMode::Patch,
		"s.js",
		"const count = 1;\nconst other = 2;\n",
		patch("s.js", "@@\n-const count = 1\n+const count = 3;\n const other = 2;"),
		Want::Bytes("const count = 3;\nconst other = 2;\n".into()),
		f,
	)
	.await;
	p(
		"G_J_LITERAL_NEW_SIBLING",
		EditMode::Patch,
		"s.js",
		"const items = [\n  \"first\",\n  \"tail\",\n];\n",
		patch(
			"s.js",
			"@@\n const items = [\n-  \"first\"\n+  \"changed\",\n+  \"inserted\",\n   \"tail\",\n ];",
		),
		Want::Bytes("const items = [\n  \"changed\",\n  \"inserted\",\n  \"tail\",\n];\n".into()),
		f,
	)
	.await;
	p(
		"G_J_UNKNOWN_LONG_STRING",
		EditMode::Patch,
		"s.txt",
		"local rows = {\n  item = 1,\n  other = 2,\n}\n",
		patch(
			"s.txt",
			"@@\n local rows = {\n-  item = 1\n+  item = compute([[)]],\n+    5)\n   other = 2,\n }",
		),
		Want::Refuse,
		f,
	)
	.await;
	for (label, file, prefix, filler, diff) in [
		(
			"G_J_GATED_REGEX",
			"s.js",
			object,
			"// filler\n",
			"@@\n const o = {\n-  a: 1\n+  a: compute(/\\)/,\n+    5)\n   b: 2,\n };",
		),
		(
			"G_J_GATED_LONG_STRING",
			"s.lua",
			"local rows = {\n  item = 1,\n  other = 2,\n}\n",
			"-- filler\n",
			"@@\n local rows = {\n-  item = 1\n+  item = compute([[)]],\n+    5)\n   other = 2,\n }",
		),
	] {
		let original = format!("{prefix}{}", filler.repeat(500_000));
		p(label, EditMode::Patch, file, &original, patch(file, diff), Want::Refuse, f).await;
	}
	for header in ["@@", "@@ const o = {"] {
		p(
			&format!("G_J_COPIED_SUCCESSOR_{header}"),
			EditMode::Patch,
			"s.js",
			"const o = {\n  a: old,\n  b: 2,\n};\n",
			patch("s.js", &format!("{header}\n-  a: old\n-  b: 2,\n+  a: updated,\n+  b: 2,")),
			Want::Bytes("const o = {\n  a: updated,\n  b: 2,\n};\n".into()),
			f,
		)
		.await;
	}
	let switch = "function f(kind) {\n  switch (kind) {\n    case \"a\":\n      work();\n    \
	              default:\n      other();\n  }\n}\n";
	p(
		"G_F_CASE_CALL",
		EditMode::Patch,
		"s.js",
		switch,
		patch("s.js", "@@ case \"a\":\n+    case \"b\":"),
		Want::Bytes(switch.replace("      work();", "    case \"b\":\n      work();")),
		f,
	)
	.await;
	p(
		"G_J_PARENT_HEADER_RENAME",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: old,\n  b: 2,\n};\n",
		patch(
			"s.js",
			"@@\n-const o = {\n-  a: old\n-  b: 2,\n-};\n+const p = {\n+  a: updated,\n+  b: 2,\n+};",
		),
		Want::Bytes("const p = {\n  a: updated,\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	p(
		"G_J_LATER_DESIGNATOR_CAPTURE",
		EditMode::Patch,
		"s.c",
		"struct S s = {\n  .a = 1,\n  .b = 2,\n};\n",
		patch(
			"s.c",
			"@@\n struct S s = {\n-  .a = 1\n+  .c = 3,\n+  .a = 4\n+  .d = 5,\n   .b = 2,\n };",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_BARE_INDEX_CAPTURE",
		EditMode::Patch,
		"s.c",
		"enum { INDEX = 2 };\nvoid f(void) {\n  int item[3] = {0};\n  int values[] = {\n    1,\n    \
		 2,\n  };\n}\n",
		patch("s.c", "@@\n   int values[] = {\n-    1\n+    item\n+    [INDEX] = 3,\n     2,\n   };"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_HEADER_RENAME_SIBLING",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: old,\n  b: 2,\n};\n",
		patch(
			"s.js",
			"@@\n-const o = {\n-  a: old\n-  b: 2,\n-};\n+const p = {\n+  a: updated,\n+  c: 3,\n+  \
			 b: 2,\n+};",
		),
		Want::Bytes("const p = {\n  a: updated,\n  c: 3,\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	p(
		"G_J_DICT_IMPLICIT_CONCAT",
		EditMode::Patch,
		"s.py",
		"values = {\n  \"a\": \"alice\",\n  \"b\": \"bob\",\n}\n",
		patch(
			"s.py",
			"@@\n values = {\n-  \"a\": \"alice\"\n+  \"a\": \"alicia\"\n+  \"x\",\n   \"b\": \
			 \"bob\",\n }",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_CSS_BLOCK_COMMENT",
		EditMode::Patch,
		"s.css",
		"a {\n  color: red;\n}\n",
		patch("s.css", "@@\n a {\n-  color: red\n+  color: blue /* note */;\n }"),
		Want::Bytes("a {\n  color: blue /* note */;\n}\n".into()),
		f,
	)
	.await;
	p(
		"G_J_ENCLOSING_SCOPE_ERROR",
		EditMode::Patch,
		"s.js",
		"function f() {\nconst o = {\n  a: 1,\n  b: 2,\n};\n}\n",
		patch(
			"s.js",
			"@@\n-const o = {\n-  a: 1\n+function g() { const p = {\n+  a: 3,\n   b: 2,\n };",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_COPIED_OPENER_UNRELATED_ERROR",
		EditMode::Patch,
		"s.js",
		"function f() {\nconst o = {\n  a: 1,\n  b: 2,\n};\n}\nfunction broken() {\n",
		patch(
			"s.js",
			"@@\n function f() {\n-const o = {\n-  a: 1\n+function g() { const p = {\n+  a: 3,\n   \
			 b: 2,\n };",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_UNRELATED_ERROR_JSX_KIND_CHANGE",
		EditMode::Patch,
		"s.tsx",
		"const long_variable_name_to_force_character_fallback = <A />;\nfunction broken() {\n",
		patch("s.tsx", "@@\n-<A />\n+<A>\n+  child\n+</A>"),
		Want::Bytes(
			"const long_variable_name_to_force_character_fallback = <A>\n  child\n</A>;\nfunction \
			 broken() {\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"G_J_RECOVERY_CANNOT_SUPPLY_MISSING_COMMA",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  broken: = 4,\n  b: 2,\n};\n",
		patch("s.js", "@@\n const o = {\n-  a: 1\n-  broken: = 4,\n+  a: 3\n   b: 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_CONTINUED_LINE_COMMENT",
		EditMode::Patch,
		"s.c",
		"struct S s = {\n  .a = 1,\n  .b = 2,\n};\n",
		patch("s.c", "@@\n struct S s = {\n-  .a = 1\n+  .a = 3, // note\\\n   .b = 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"G_J_LONG_COMMENT_LINE_PREFIX",
		EditMode::Patch,
		"s.lua",
		"local t = {\n  a = 1,\n  b = 2,\n}\n",
		patch("s.lua", "@@\n local t = {\n-  a = 1\n+  --[[\n+  a = 3,\n   b = 2,\n }"),
		Want::Refuse,
		f,
	)
	.await;
	assert!(fails.is_empty(), "separator ownership regressions: {fails:?}");
}

#[tokio::test]
async fn evidence_inheritance_regressions() {
	let mut fails = Vec::new();
	let f = &mut fails;
	both(
		"G_H_FIXED_ANCHOR_RESOLVES_FLAT_TWINS",
		"order.txt",
		"first\nkeep\nsecond\nkeep\n",
		"@@ first\n-keep\n+KEEP1",
		"@@ second\n-keep\n+KEEP2",
		Want::Bytes("first\nKEEP1\nsecond\nKEEP2\n".into()),
		f,
	)
	.await;
	let original = "a\nmarker\nfoo\nb\nc\nmarker\nfoo\nd\n";
	let second = "@@\n marker\n-foo\n+bar";
	for first in [
		"@@\n a\n marker\n-fooo\n+foo\n b",
		"@@\n-a\n+A\n marker\n-fooo\n+foo\n b",
		"@@\n a\n marker\n-fooo\n+head\n+foo\n b",
	] {
		both(&format!("G_H_ACTUAL_NOOP_{first}"), "t.txt", original, first, second, Want::Refuse, f)
			.await;
		let want = if first.contains("+head") {
			Want::Bytes("a\nmarker\nhead\nfoo\nb\nc\nmarker\nbar\nd\n".into())
		} else {
			Want::Refuse
		};
		p(
			&format!("G_H_SEQUENTIAL_NOOP_{first}"),
			EditMode::Patch,
			"t.txt",
			original,
			json!({"path":"t.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":second}]}),
			want,
			f,
		)
		.await;
	}
	let first = "@@\n-a\n-marker\n-foo\n-b\n+A\n+marker\n+foo\n+b";
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		let args = if mode == EditMode::Patch {
			json!({"path":"t.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":second}]})
		} else {
			json!({"input":format!("*** Begin Patch\n*** Update File: t.txt\n{first}\n*** Update File: t.txt\n{second}\n*** End Patch")})
		};
		p(&format!("G_H_CHAR_PARTIAL_NOOP_{mode:?}"), mode, "t.txt", original, args, Want::Refuse, f)
			.await;
	}
	both(
		"G_H_RAW_NOOP",
		"t.txt",
		"a\nb\n",
		"@@\n a\n-b\n+b",
		"@@\n-b\n+B",
		Want::Bytes("a\nB\n".into()),
		f,
	)
	.await;
	p(
		"G_H_CURRENT_HINT_IDENTITY",
		EditMode::Patch,
		"t.txt",
		original,
		json!({"path":"t.txt","edits":[
			{"op":"update","diff":"@@\n+head1\n+head2\n+head3\n+head4\n a"},
			{"op":"update","diff":"@@ -6,2 +6,2 @@\n marker\n-foo\n+bar"}
		]}),
		Want::Bytes("head1\nhead2\nhead3\nhead4\na\nmarker\nbar\nb\nc\nmarker\nfoo\nd\n".into()),
		f,
	)
	.await;
	let first = "@@\n a\n marker\n-value = 100\n+value = 0";
	let other = "@@\n b\n-other\n-value = 99\n+marker\n+value = 100";
	for diff in [format!("{first}\n{other}"), format!("{other}\n{first}")] {
		p("G_H_OUTPUT_WRITER_LOCAL", EditMode::Patch, "t.txt", "a\nmarker\nvalue = 100\nb\nother\nvalue = 99\n",
			json!({"path":"t.txt","edits":[{"op":"update","diff":diff},{"op":"update","diff":"@@\n marker\n-value = 100\n+value = 200"}]}),
			Want::Refuse, f).await;
	}
	let first = "@@\n a\n-marker\n+updated_marker";
	let other = "@@\n b\n-other\n+marker";
	for diff in [format!("{first}\n{other}"), format!("{other}\n{first}")] {
		for insertion in ["@@\n marker\n+X", "@@ marker\n+X"] {
			p(
				&format!("G_H_INSERT_WRITER_LOCAL_{insertion}"),
				EditMode::Patch,
				"t.txt",
				"a\nmarker\nb\nother\n",
				json!({"path":"t.txt","edits":[{"op":"update","diff":diff},{"op":"update","diff":insertion}]}),
				Want::Refuse,
				f,
			)
			.await;
		}
	}
	let local = "root\nmarker = calculate_value(argument, 100);\n";
	for insertion in [
		"@@\n root\n marker = calculate_value(argument, 101);\n+X",
		"@@ root\n@@ marker = calculate_value(argument, 101);\n+X",
	] {
		p(&format!("G_H_LOCAL_GAP_{insertion}"), EditMode::Patch, "t.txt", local,
			json!({"path":"t.txt","edits":[{"op":"update","diff":"@@\n root\n-marker = calculate_value(argument, 100);\n+marker = calculate_value(argument, 101);"},{"op":"update","diff":insertion}]}),
			Want::Bytes("root\nmarker = calculate_value(argument, 101);\nX\n".into()), f).await;
	}
	let first = "@@ -1,2 +1,2 @@\n-root\n-marker\n+changed_root\n+updated_marker";
	let other = "@@\n root\n-other\n+marker";
	for diff in [format!("{first}\n{other}"), format!("{other}\n{first}")] {
		p("G_H_NESTED_GAP_WRITER_LOCAL", EditMode::Patch, "t.txt", "root\nmarker\nroot\nother\n",
			json!({"path":"t.txt","edits":[{"op":"update","diff":diff},{"op":"update","diff":"@@ root\n@@ marker\n+X"}]}),
			Want::Refuse, f).await;
	}
	p("G_H_NESTED_GAP_UNCHANGED_LEAF", EditMode::Patch, "t.txt", "root\nmarker\nroot\nmarker\n",
		json!({"path":"t.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":"@@ root\n@@ marker\n+X"}]}),
		Want::Bytes("changed_root\nupdated_marker\nroot\nmarker\nX\n".into()), f).await;
	p(
		"G_H_PLAIN_EOF_NONBLANK",
		EditMode::Patch,
		"t.txt",
		"a\n",
		patch("t.txt", "@@\n+X"),
		Want::Bytes("a\nX\n".into()),
		f,
	)
	.await;
	assert!(fails.is_empty(), "evidence inheritance regressions: {fails:?}");
}

#[tokio::test]
async fn touching_comments_keep_their_declarations() {
	let mut fails = Vec::new();
	for (label, file, original, diff) in [
		("G_F_RUST_EMPTY_BLOCK_COMMENT", "lib.rs", "/**/\nfn f() {}\n", "@@ /**/\n+fn g() {}"),
		(
			"G_F_CSHARP_FOUR_SLASH",
			"s.cs",
			"//// section\nclass C {}\n",
			"@@ //// section\n+class D {}",
		),
		(
			"G_F_JSDOC_THREE_STAR_COMMENT",
			"s.js",
			"/*** section */\nfunction f() {}\n",
			"@@ /*** section */\n+function g() {}",
		),
		(
			"G_F_PHP_NON_DOC_BLOCK",
			"s.php",
			"<?php\n/**section*/\nfunction f() {}\n",
			"@@ /**section*/\n+function g() {}",
		),
	] {
		p(label, EditMode::Patch, file, original, patch(file, diff), Want::Refuse, &mut fails).await;
	}
	p(
		"G_F_PHP_TRUE_DOC_BLOCK",
		EditMode::Patch,
		"s.php",
		"<?php\n/** Docs */\nfunction f() {}\n",
		patch("s.php", "@@ /** Docs */\n+function g() {}"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "ordinary comment ownership regressions: {fails:?}");
}
