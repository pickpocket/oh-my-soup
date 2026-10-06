//! Placement safety regressions: zero-write refusals, exact bytes and
//! hunk-order independence.
mod common;

use std::fmt::Write as _;

use common::{DiskWriter, Workspace};
use pi_edit::EditMode;
use serde_json::{Value, json};

enum Want {
	/// Must succeed with exactly these bytes.
	Bytes(String),
	/// Either these bytes, or a clean refusal (zero writes, file unchanged).
	BytesOrRefuse(String),
	/// Must refuse cleanly.
	Refuse,
	/// Must refuse cleanly, and the message must satisfy the predicate.
	RefuseMsg(fn(&str) -> bool),
	/// Any one of these byte strings, or a clean refusal.
	BytesAnyOrRefuse(Vec<String>),
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
	let refused_clean = refused_clean && msg.matches("No changes were applied").count() == 1;
	let ok = match &want {
		Want::Bytes(b) => result.is_ok() && &after == b,
		Want::BytesOrRefuse(b) => refused_clean || (result.is_ok() && &after == b),
		Want::Refuse => refused_clean,
		Want::RefuseMsg(check) => refused_clean && check(msg),
		Want::BytesAnyOrRefuse(bs) => {
			refused_clean || (result.is_ok() && bs.iter().any(|b| &after == b))
		},
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
		let refused_clean = r.is_err()
			&& w == 0
			&& a == original
			&& r
				.as_ref()
				.err()
				.is_some_and(|message| message.matches("No changes were applied").count() == 1);
		match &want {
			Want::Bytes(b) => r.is_ok() && a == b,
			Want::BytesOrRefuse(b) => refused_clean || (r.is_ok() && a == b),
			Want::Refuse => refused_clean,
			Want::RefuseMsg(check) => {
				refused_clean && check(r.as_ref().err().map_or("", String::as_str))
			},
			Want::BytesAnyOrRefuse(bs) => refused_clean || (r.is_ok() && bs.iter().any(|b| a == b)),
		}
	};
	let ok = same && meets(&r1, w1, &a1) && meets(&r2, w2, &a2);
	let show = |r: &Result<(), String>, a: &str| match r {
		Ok(()) => format!("Ok {a:?}"),
		Err(e) => format!("Err({:?})", &e[e.len().saturating_sub(200)..]),
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
async fn round9_placement_contracts() {
	let mut fails = Vec::new();
	let f = &mut fails;

	// ---- R9RegionReview
	// RY0 (P1 claim): a statement-list wrapper must not be certified as the
	// anchored statement's region.
	let go = "package p\n\nfunc run() {\n    if ready {\n        notify(x)   \n    }\n  if done \
	          {\n        notify(x)\n  }\n}\n";
	p("RY0a_GO_STATEMENT_LIST_WRAPPER", EditMode::Patch, "s.go", go,
		patch("s.go", "@@ if ready {\n-        notify(x)\n+        notify(y)"),
		Want::BytesOrRefuse("package p\n\nfunc run() {\n    if ready {\n        notify(y)\n    }\n  if done {\n        notify(x)\n  }\n}\n".into()), f).await;
	let sw = "struct S {\n  func outer() {\n    func inner() {\n      work()\n    }\n  }\n}\n";
	p(
		"RY0b_SWIFT_STATEMENTS_WRAPPER",
		EditMode::Patch,
		"v.swift",
		sw,
		patch("v.swift", "@@ func inner() {\n-  }\n+  } // inner"),
		Want::BytesAnyOrRefuse(vec![
			"struct S {\n  func outer() {\n    func inner() {\n      work()\n    } // inner\n  }\n}\n"
				.into(),
			"struct S {\n  func outer() {\n    func inner() {\n      work()\n  } // inner\n  }\n}\n"
				.into(),
		]),
		f,
	)
	.await;
	// RY1 (P2): a comment extra on a callback's closing row does not break the
	// chain's region.
	let bj = "db.save(user).then(() => {\n  ok();\n}) /*\n  chain \
	          note\n*/\n.catch(handleError);\ndb.other().then(() => {\n  ok();\n});\n";
	p(
		"RY1_JS_CHAIN_COMMENT_EXTRA",
		EditMode::Patch,
		"builder.js",
		bj,
		patch("builder.js", "@@ db.save(user).then(() => {\n-  ok();\n+  ok(true);"),
		Want::Bytes(bj.replacen("  ok();", "  ok(true);", 1)),
		f,
	)
	.await;

	// ---- R9InsertionReview
	// IY0 (P1 claim): owner normalization must keep real block and branch identity.
	p(
		"IY0a_GO_BRANCH_OWNER",
		EditMode::Patch,
		"s.go",
		"package p\n\nfunc f(ok bool) {\n\tif ok \
		 {\n\t\tprintln(\"before\")\n\t\tprintln(\"target\")\n\t}\n}\n",
		patch("s.go", "@@ println(\"before\")\n+\t} else {"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IY0b_CS_BLOCK_OWNER",
		EditMode::Patch,
		"C.cs",
		"class C {\n  void F() {\n    {\n      int x = 1;\n      System.Console.WriteLine(x);\n    \
		 }\n  }\n}\n",
		patch("C.cs", "@@ int x = 1;\n+    }\n+    {"),
		Want::Refuse,
		f,
	)
	.await;
	// IY1 (P1 claim): a displaced item's pre-existing attributes are checked even
	// when the anchor row opens none.
	p(
		"IY1a_RUST_ATTR_ABOVE_COMMENT_ANCHOR",
		EditMode::Patch,
		"lib.rs",
		"#[test]\n// marker\nfn f() {}\n",
		patch("lib.rs", "@@ // marker\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IY1b_RUST_ATTR_CONTINUATION_ANCHOR",
		EditMode::Patch,
		"lib.rs",
		"#[cfg(\n    test\n)]\nfn f() {}\n",
		patch("lib.rs", "@@ )]\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	// IY2 (P2): document containers that merely grow keep their owners (HEAD
	// applied these).
	p(
		"IY2a_MD_PARAGRAPH_PREPEND",
		EditMode::Patch,
		"d.md",
		"# Usage\nRun the tool.\n",
		patch("d.md", "@@ # Usage\n+First install it."),
		Want::Bytes("# Usage\nFirst install it.\nRun the tool.\n".into()),
		f,
	)
	.await;
	p(
		"IY2b_YAML_MAPPING_PREPEND",
		EditMode::Patch,
		"jobs.yml",
		"jobs:\n  test:\n    run: npm test\n",
		patch("jobs.yml", "@@ jobs:\n+  lint:\n+    run: npm run lint"),
		Want::Bytes("jobs:\n  lint:\n    run: npm run lint\n  test:\n    run: npm test\n".into()),
		f,
	)
	.await;
	// IY3 (P3): Swift's named else token names the else branch in refusals.
	p(
		"IY3_SWIFT_ELSE_MESSAGE",
		EditMode::Patch,
		"s.swift",
		"func f(_ ok: Bool) {\n  if ok {\n    print(\"x\")\n  } else {\n    print(\"y\")\n  }\n}\n",
		patch("s.swift", "@@ } else {\n+  }\n+}\n+func g() {\n+  if true {"),
		Want::RefuseMsg(|m| m.contains("out of '} else {'")),
		f,
	)
	.await;
	// IY4 (P3): insertion refusals are bounded.
	let huge = format!("if (ok)\n  run(\"{}\");\n", "a".repeat(1_000_000));
	p(
		"IY4_INSERTION_MESSAGE_BOUND",
		EditMode::Patch,
		"s.js",
		&huge,
		patch("s.js", "@@ if (ok)\n+  log();"),
		Want::RefuseMsg(|m| m.len() < 2_000),
		f,
	)
	.await;

	// ---- R9MultiHunkReview
	// HY0 (P1 claim): a consumed best from a repaired variant stops later variants.
	{
		let v = "start = compute_start_amount(config, options, account);";
		let w = "finish = compute_final_amount(config, options, account);";
		let k = "process_repeated_entry();";
		let vx = v.replace("account", "accounx");
		let wx = w.replace("account", "accounx");
		let kx = k.replace("entry", "entri");
		let original = format!("[a]\n{v}\n{kx}\n{kx}\n{wx}\n[other]\n{vx}\n{k}\n{w}\nend\n");
		let h1 = format!("@@ [a]\n-{v}\n+start = 0;");
		let h2 = format!(
			"@@ [a]\n STALE_LEADING_CONTEXT_THAT_IS_NOT_ANYWHERE\n-{v}\n+start = 10;\n {k}\n \
			 {k}\n-{w}\n+finish = 20;\n STALE_TRAILING_CONTEXT_THAT_IS_NOT_ANYWHERE"
		);
		both("HY0_VARIANT_CONSUMED", "t.txt", &original, &h1, &h2, Want::Refuse, f).await;
	}
	// HY1 (P1 claim): replacement exterior ties hold against anchored/hinted
	// insertions at the replacement's edge.
	both(
		"HY1a_REPLACEMENT_ANCHOR_EDGE",
		"t.txt",
		"a\nx\nd\n",
		"@@\n a\n-x\n+y\n+z\n d",
		"@@ a\n+E",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"HY1b_REPLACEMENT_HINT_EDGE",
		"t.txt",
		"a\nx\nd\n",
		"@@\n a\n-x\n+y\n+z\n d",
		"@@ -2,0 +2,1 @@\n+E",
		Want::Refuse,
		f,
	)
	.await;
	{
		let (x, y, z) = ("x".repeat(3000), "y".repeat(3000), "z".repeat(3000));
		let original = format!("a\n{x}\nd\n");
		let h1 = format!("@@\n a\n-{x}\n+{y}\n+{z}\n d");
		both("HY1c_UNKNOWN_SPLIT_ANCHOR_EDGE", "t.txt", &original, &h1, "@@ a\n+E", Want::Refuse, f)
			.await;
	}
	// HY2 (P1 claim): a pure deletion must not remove another hunk's required
	// context.
	both(
		"HY2a_DELETED_INTERIOR_CONTEXT",
		"t.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n-b\n+B\n c\n-d\n+D\n e",
		"@@\n-c",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"HY2b_DELETED_EDGE_CONTEXT",
		"t.txt",
		"a\nb\nc\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n c",
		Want::Refuse,
		f,
	)
	.await;
	// HY3 (P1 claim): consumed evidence carries across same-file ApplyPatch Update
	// sections.
	{
		let original = "[a]\nval = 1\n[a]\nval = 1   \n";
		let s1 = "*** Update File: t.txt\n@@ [a]\n [a]\n-val = 1\n+val = 2";
		let s2 = "*** Update File: t.txt\n@@ [a]\n [a]\n-val = 1\n+val = 3";
		let fwd = format!("*** Begin Patch\n{s1}\n{s2}\n*** End Patch");
		let rev = format!("*** Begin Patch\n{s2}\n{s1}\n*** End Patch");
		p(
			"HY3a_APPLY_PATCH_SECTIONS_FWD",
			EditMode::ApplyPatch,
			"t.txt",
			original,
			json!({ "input": fwd }),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"HY3b_APPLY_PATCH_SECTIONS_REV",
			EditMode::ApplyPatch,
			"t.txt",
			original,
			json!({ "input": rev }),
			Want::Refuse,
			f,
		)
		.await;
	}
	// HY4 (P1 claim): same-gap pure insertions must not take their order from hunk
	// order.
	both(
		"HY4a_EOF_ANCHOR_ORDER",
		"t.txt",
		"a\nb\n",
		"@@\n+X",
		"@@ b\n+Y",
		Want::BytesOrRefuse("a\nb\nY\nX\n".into()),
		f,
	)
	.await;
	both(
		"HY4b_EOF_HINT_ORDER",
		"t.txt",
		"a\nb\n",
		"@@\n+X",
		"@@ -3,0 +3,1 @@\n+Y",
		Want::BytesOrRefuse("a\nb\nY\nX\n".into()),
		f,
	)
	.await;
	// HY5 (P3): equal-gap conflict scanning is not quadratic.
	{
		let diff = (0..20_000).map(|_| "@@\n+X").collect::<Vec<_>>().join("\n");
		p(
			"HY5_EQUAL_GAP_SCAN",
			EditMode::Patch,
			"t.txt",
			"a\n",
			patch("t.txt", &diff),
			Want::BytesOrRefuse(format!("a\n{}", "X\n".repeat(20_000))),
			f,
		)
		.await;
	}

	// ---- parent controls for R9MultiHunkReview scope
	both(
		"HY2c_REPLACED_EDGE_CONTEXT_CONTROL",
		"t.txt",
		"a\nb\nc\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n+B\n c",
		Want::BytesOrRefuse("a\nX\nB\nc\n".into()),
		f,
	)
	.await;
	both(
		"HY2d_REWRITTEN_INTERIOR_CONTEXT_CONTROL",
		"t.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n-b\n+B\n c\n-d\n+D\n e",
		"@@\n-c\n+C",
		Want::Bytes("a\nB\nC\nD\ne\n".into()),
		f,
	)
	.await;
	both(
		"HY2e_DELETION_ANCHOR_EDGE",
		"t.txt",
		"a\nb\nc\n",
		"@@\n a\n-b\n c",
		"@@ a\n+E",
		Want::Refuse,
		f,
	)
	.await;
	{
		let original = "[a]\nval = 1\n[a]\nval = 1   \n";
		let e1 = json!({ "op": "update", "diff": "@@ [a]\n [a]\n-val = 1\n+val = 2" });
		let e2 = json!({ "op": "update", "diff": "@@ [a]\n [a]\n-val = 1\n+val = 3" });
		p(
			"HY3c_PATCH_EDITS_SAME_FILE_FWD",
			EditMode::Patch,
			"t.txt",
			original,
			json!({ "path": "t.txt", "edits": [e1.clone(), e2.clone()] }),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"HY3d_PATCH_EDITS_SAME_FILE_REV",
			EditMode::Patch,
			"t.txt",
			original,
			json!({ "path": "t.txt", "edits": [e2, e1] }),
			Want::Refuse,
			f,
		)
		.await;
	}
	{
		// Controls: same-path edits/sections that are legitimately sequential keep
		// applying.
		let distinct = "[a]\nval = 1\n[b]\nval = 1\n";
		let d1 = json!({ "op": "update", "diff": "@@ [a]\n [a]\n-val = 1\n+val = 2" });
		let d2 = json!({ "op": "update", "diff": "@@ [b]\n [b]\n-val = 1\n+val = 3" });
		p(
			"HY3e_PATCH_EDITS_DISTINCT_CONTROL",
			EditMode::Patch,
			"t.txt",
			distinct,
			json!({ "path": "t.txt", "edits": [d1, d2] }),
			Want::Bytes("[a]\nval = 2\n[b]\nval = 3\n".into()),
			f,
		)
		.await;
		let s1 = json!({ "op": "update", "diff": "@@\n a\n+X\n b" });
		let s2 = json!({ "op": "update", "diff": "@@\n X\n-b\n+B" });
		p(
			"HY3f_PATCH_EDITS_SEQUENTIAL_CONTROL",
			EditMode::Patch,
			"t.txt",
			"a\nb\n",
			json!({ "path": "t.txt", "edits": [s1, s2] }),
			Want::Bytes("a\nX\nB\n".into()),
			f,
		)
		.await;
		let input = "*** Begin Patch\n*** Update File: t.txt\n@@\n a\n+X\n b\n*** Update File: \
		             t.txt\n@@\n X\n-b\n+B\n*** End Patch";
		p(
			"HY3g_APPLY_PATCH_SEQUENTIAL_CONTROL",
			EditMode::ApplyPatch,
			"t.txt",
			"a\nb\n",
			json!({ "input": input }),
			Want::Bytes("a\nX\nB\n".into()),
			f,
		)
		.await;
	}
	both("HY4c_TWO_EOF_APPENDS", "t.txt", "a\n", "@@\n+X", "@@\n+Y", Want::Refuse, f).await;
	both(
		"HY4d_SAME_ANCHOR_TWO_INSERTIONS",
		"t.txt",
		"a\nb\n",
		"@@ a\n+X",
		"@@ a\n+Y",
		Want::Refuse,
		f,
	)
	.await;

	// ---- R9TokenGuardReview
	// TY0 (P1 claim): literal contents never certify a code separator.
	p(
		"TY0a_TEMPLATE_SEPARATOR",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("s.js", "@@\n const o = {\n-  a: 1\n+  a: `hello,\n+    world`\n   b: 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TY0b_TRIPLE_QUOTE_SEPARATOR",
		EditMode::Patch,
		"c.py",
		"CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n",
		patch(
			"c.py",
			"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=len(\"\"\"\n+        hello),\n+    \
			 \"\"\")\n     retries=3,\n )",
		),
		Want::Refuse,
		f,
	)
	.await;
	// TY1 (P1 claim): brackets inside block comments do not count for depth.
	p(
		"TY1_BLOCK_COMMENT_CLOSER",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("s.js", "@@\n const o = {\n-  a: 1\n+  a: Math.max(1 /* ) */,\n+    2)\n   b: 2,\n };"),
		Want::Refuse,
		f,
	)
	.await;
	// TY2 (P1 claim): C++ digit separators are not character quotes.
	p(
		"TY2_CPP_DIGIT_SEPARATOR",
		EditMode::Patch,
		"values.cpp",
		"int values[] = {\n  1,\n  2,\n};\n",
		patch(
			"values.cpp",
			"@@\n int values[] = {\n-  1\n+  1'000 + std::max(2'000,\n+    3)\n   2,\n };",
		),
		Want::Refuse,
		f,
	)
	.await;
	// TY3 (P1 claim): .less files get LESS's // comments.
	p(
		"TY3_LESS_COMMENT_SEPARATOR",
		EditMode::Patch,
		"s.less",
		".a {\n  color: red;\n  margin: 0;\n}\n",
		patch("s.less", "@@\n .a {\n-  color: red\n+  color: blue // was red;\n   margin: 0;\n }"),
		Want::Refuse,
		f,
	)
	.await;
	// TY4 (P2): a same-depth split that keeps the separator applies.
	p(
		"TY4_FLAT_VALUE_SPLIT",
		EditMode::Patch,
		"t.json",
		"{\n  \"a\": 1,\n  \"b\": 2\n}\n",
		patch("t.json", "@@\n {\n-  \"a\": 1\n+  \"a\":\n+    5,\n   \"b\": 2\n }"),
		Want::Bytes("{\n  \"a\":\n    5,\n  \"b\": 2\n}\n".into()),
		f,
	)
	.await;
	// TY5 (P2): an unquoted SCSS url(http://...) is not a comment.
	p("TY5_SCSS_URL_COMMENT", EditMode::Patch, "s.scss", ".a {\n  background: url(http://old.example/a);\n  color: red;\n}\n",
		patch("s.scss", "@@\n .a {\n-  background: url(http://old.example/a)\n+  background: url(http://new.example/a); // asset\n   color: red;\n }"),
		Want::Bytes(".a {\n  background: url(http://new.example/a); // asset\n  color: red;\n}\n".into()), f).await;
	// TY6 (P3): pair work is bounded for short lines.
	{
		let n = 2048;
		let original = format!("HEADER\n{}FOOTER\n", "//\n".repeat(n));
		let diff = format!("@@\n HEADER\n{}{} FOOTER", "-/\n".repeat(n), "+!\n".repeat(n));
		p(
			"TY6_SHORT_PAIR_BUDGET",
			EditMode::Patch,
			"t.txt",
			&original,
			patch("t.txt", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}

	assert!(fails.is_empty(), "placement regressions: {fails:?}");
}

/// Sequential staging preserves physical original-row identities, while
/// continuations cannot borrow another statement's separator or literal bytes.
#[tokio::test]
async fn round9_guard_boundaries() {
	let mut fails = Vec::new();
	let f = &mut fails;
	for (label, original, first, second, expected) in [
		(
			"character_substring_row",
			"prefix abc suffix\nSECOND\n",
			"@@\n-abc",
			"@@\n-SECOND\n+CHANGED",
			"prefix  suffix\nCHANGED\n",
		),
		("character_noop_row", "a\n", "@@\n-a\n+a", "@@\n-a\n+A", "A\n"),
		("character_eof_boundary", "a\nb\n", "@@\n-b\n-", "@@\n-a\n+A", "A\n"),
		("character_normalized_rows", "a\nb", "@@\n-b\n+B\n+\n+\n+", "@@\n-a\n+A", "A\nB"),
		("line_deleted_empty_rows_no_context", "a", "@@ -1,1 +1,0 @@\n-a", "@@\n+B", "B"),
		("line_deleted_real_blank_row", "a\n\n", "@@ -1,1 +1,0 @@\n-a", "@@\n \n+B", "\nB\n"),
	] {
		p(
			label,
			EditMode::Patch,
			"t.txt",
			original,
			json!({"path":"t.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":second}]}),
			Want::Bytes(expected.into()),
			f,
		)
		.await;
	}
	p(
		"line_deleted_empty_rows",
		EditMode::Patch,
		"t.txt",
		"a\n",
		json!({"path":"t.txt","edits":[{"op":"update","diff":"@@ -1,1 +1,0 @@\n-a"},{"op":"update","diff":"@@\n \n+B"}]}),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"hint_without_tie",
		EditMode::Patch,
		"t.txt",
		"a\nb\n",
		patch("t.txt", "@@ -2,0 +2,1 @@\n+X"),
		Want::Refuse,
		f,
	)
	.await;
	both("noop_context_deletion", "t.txt", "a\nb\nc\n", "@@\n a\n b\n c", "@@\n-b", Want::Refuse, f)
		.await;
	both(
		"mixed_context_deletion",
		"t.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n-b\n+B\n c\n d",
		"@@\n-c\n-d\n+C",
		Want::Refuse,
		f,
	)
	.await;
	let c = format!("c = \"{}\";", "x".repeat(3000));
	let d = format!("d = \"{}\";", "y".repeat(3000));
	both(
		"large_mixed_context_deletion",
		"t.txt",
		&format!("a\nb\n{c}\n{d}\ne\n"),
		&format!("@@\n a\n-b\n+B\n {c}\n {d}"),
		&format!("@@\n-{c}\n-{d}\n+{c}"),
		Want::Refuse,
		f,
	)
	.await;
	let first = json!({"op":"update","diff":"@@ [a]\n [a]\n-val = 1\n+val = 2"});
	let second =
		json!({"op":"update","diff":"@@ [a]\n STALE_CONTEXT_NOT_ANYWHERE\n-val = 1\n+val = 3"});
	for edits in [[first.clone(), second.clone()], [second, first]] {
		p(
			"stale_context_sequential_consumption",
			EditMode::Patch,
			"t.txt",
			"[a]\nval = 1\n[other]\nval = 1   \n",
			json!({"path":"t.txt","edits":edits}),
			Want::Refuse,
			f,
		)
		.await;
	}
	let js = "const o = {\n  a: 1,\n  b: 2,\n};\n";
	let rust = "const VALUES: [i32; 2] = [\n    1,\n    2,\n];\n";
	for (label, file, original, diff) in
		[
			(
				"single_quote_literal_separator",
				"s.js",
				js,
				"@@\n const o = {\n-  a: 1\n+  a: 'hello, //\\\n+    world'\n   b: 2,\n };",
			),
			(
				"nested_block_comment_separator",
				"lib.rs",
				rust,
				"@@\n const VALUES: [i32; 2] = [\n-    1\n+    compute(1 /* outer /* inner */ ) \
				 */,\n+        2)\n     2,\n ];",
			),
			(
				"sibling_property_separator",
				"t.json",
				"{\n  \"a\": 1,\n  \"b\": 2\n}\n",
				"@@\n {\n-  \"a\": 1\n+  \"a\": 5\n+  \"c\": 6,\n   \"b\": 2\n }",
			),
		] {
		p(label, EditMode::Patch, file, original, patch(file, diff), Want::Refuse, f).await;
	}
	for (label, file, original, diff, expected) in [
		("single_quote_literal_code_comma", "s.js", js,
			"@@\n const o = {\n-  a: 1\n+  a: 'hello, //\\\n+    world',\n   b: 2,\n };",
			"const o = {\n  a: 'hello, //\\\n    world',\n  b: 2,\n};\n"),
		("nested_block_comment_code_comma", "lib.rs", rust,
			"@@\n const VALUES: [i32; 2] = [\n-    1\n+    compute(1 /* outer /* inner */ ) */,\n+        2),\n     2,\n ];",
			"const VALUES: [i32; 2] = [\n    compute(1 /* outer /* inner */ ) */,\n        2),\n    2,\n];\n"),
		("flat_line_comment_continuation", "c.py", "CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n",
			"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=\n+        # bounded\n+        60,\n     retries=3,\n )",
			"CONFIG = dict(\n    timeout=\n        # bounded\n        60,\n    retries=3,\n)\n"),
		("flat_block_comment_continuation", "s.js", js,
			"@@\n const o = {\n-  a: 1\n+  a:\n+    /* bounded */\n+    5,\n   b: 2,\n };",
			"const o = {\n  a:\n    /* bounded */\n    5,\n  b: 2,\n};\n"),
		("explicit_top_boundary_tie", "t.py", "import os\ndef a():\n    pass\ndef b():\n    pass\ndef main():\n    x = 1\n    print(x)\n    return x\n",
			"@@ -2,3 +2,3 @@\n     x = 1\n-    print(x)\n+    print(x, flush=True)\n     return x\n@@ top of file\n+import sys",
			"import sys\nimport os\ndef a():\n    pass\ndef b():\n    pass\ndef main():\n    x = 1\n    print(x, flush=True)\n    return x\n"),
	] {
		p(label, EditMode::Patch, file, original, patch(file, diff), Want::Bytes(expected.into()), f).await;
	}
	let original = format!("HEADER\n{}FOOTER\n", "x 1,\n".repeat(2048));
	let diff = format!("@@\n HEADER\n{}{} FOOTER", "-x 1\n".repeat(2048), "+x 2,\n".repeat(2048));
	p(
		"same_head_pair_budget",
		EditMode::Patch,
		"t.txt",
		&original,
		patch("t.txt", &diff),
		Want::Refuse,
		f,
	)
	.await;
	assert!(fails.is_empty(), "guard regressions: {fails:?}");
}

/// Identical shifted body spans are not identity when their branch changes.
#[tokio::test]
async fn python_branch_owner_identity() {
	let mut fails = Vec::new();
	p(
		"python_branch_field_owner",
		EditMode::Patch,
		"f.py",
		"if ok:\n    target()\n",
		patch("f.py", "@@ if ok:\n+    pass\n+else:"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	p(
		"python_branch_unchanged_owner",
		EditMode::Patch,
		"f.py",
		"if ok:\n    target()\n",
		patch("f.py", "@@ if ok:\n+    pass"),
		Want::Bytes("if ok:\n    pass\n    target()\n".into()),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "ownership regressions: {fails:?}");
}

/// Language operators and nested-comment dialects cannot impersonate
/// sibling bindings or code separators.
#[tokio::test]
async fn qualified_values_and_nested_comment_dialects() {
	let mut fails = Vec::new();
	p(
		"rust_qualified_value_split",
		EditMode::Patch,
		"lib.rs",
		"struct S {\n    value: Foo,\n}\n",
		patch("lib.rs", "@@\n struct S {\n-    value: Foo\n+    value:\n+        crate::Bar,\n }"),
		Want::Bytes("struct S {\n    value:\n        crate::Bar,\n}\n".into()),
		&mut fails,
	)
	.await;
	let original = "let values = [\n  1,\n  2,\n]\n";
	p(
		"swift_nested_comment_separator",
		EditMode::Patch,
		"s.swift",
		original,
		patch(
			"s.swift",
			"@@\n let values = [\n-  1\n+  compute(1 /* outer /* inner */ ) */,\n+    2)\n   2,\n ]",
		),
		Want::Refuse,
		&mut fails,
	)
	.await;
	p(
		"swift_nested_comment_code_comma",
		EditMode::Patch,
		"s.swift",
		original,
		patch(
			"s.swift",
			"@@\n let values = [\n-  1\n+  compute(1 /* outer /* inner */ ) */,\n+    2),\n   2,\n ]",
		),
		Want::Bytes(
			"let values = [\n  compute(1 /* outer /* inner */ ) */,\n    2),\n  2,\n]\n".into(),
		),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "lexical regressions: {fails:?}");
}

/// Anchored insertion ties cannot survive deletion of their anchor; a
/// rewrite leaves that row's adjacency intact.
#[tokio::test]
async fn anchored_insertion_tie_survives_only_existing_rows() {
	let mut fails = Vec::new();
	both("deleted_anchor_tie", "t.txt", "a\nb\nc\n", "@@\n-b", "@@ b\n+X", Want::Refuse, &mut fails)
		.await;
	both(
		"rewritten_anchor_tie",
		"t.txt",
		"a\nb\nc\n",
		"@@\n-b\n+B",
		"@@ b\n+X",
		Want::Bytes("a\nB\nX\nc\n".into()),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "anchor tie regressions: {fails:?}");
}

/// Hexadecimal apostrophes cannot hide the call's real bracket depth.
#[tokio::test]
async fn hexadecimal_numeric_separators() {
	let original = "int values[] = {\n  1,\n  2,\n};\n";
	let mut fails = Vec::new();
	p(
		"cpp_hex_digit_separator",
		EditMode::Patch,
		"values.cpp",
		original,
		patch(
			"values.cpp",
			"@@\n int values[] = {\n-  1\n+  0x1A'FF + std::max(0x2B'FF,\n+    3)\n   2,\n };",
		),
		Want::Refuse,
		&mut fails,
	)
	.await;
	p(
		"cpp_hex_digit_code_comma",
		EditMode::Patch,
		"values.cpp",
		original,
		patch(
			"values.cpp",
			"@@\n int values[] = {\n-  1\n+  0x1A'FF + std::max(0x2B'FF,\n+    3),\n   2,\n };",
		),
		Want::Bytes("int values[] = {\n  0x1A'FF + std::max(0x2B'FF,\n    3),\n  2,\n};\n".into()),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "numeric regressions: {fails:?}");
}

/// An unterminated literal in the supplied old text cannot claim the
/// actual line's code separator, but restoring both quote and separator is
/// safe.
#[tokio::test]
async fn removed_literal_cannot_capture_code_punctuation() {
	let original = "{\n  \"a\": \"foo\",\n  \"b\": 2\n}\n";
	let mut fails = Vec::new();
	p(
		"removed_literal_separator",
		EditMode::Patch,
		"t.json",
		original,
		patch("t.json", "@@\n {\n-  \"a\": \"foo,\n+  \"a\": \"bar\"\n   \"b\": 2\n }"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	p(
		"removed_literal_code_comma",
		EditMode::Patch,
		"t.json",
		original,
		patch("t.json", "@@\n {\n-  \"a\": \"foo,\n+  \"a\": \"bar\",\n   \"b\": 2\n }"),
		Want::Bytes("{\n  \"a\": \"bar\",\n  \"b\": 2\n}\n".into()),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "literal alignment regressions: {fails:?}");
}

/// A context row created by a prior edit still identifies that updated
/// location when an unrelated original copy exists elsewhere.
#[tokio::test]
async fn reused_written_context_keeps_sequential_evidence() {
	let mut fails = Vec::new();
	p("reused_written_context", EditMode::Patch, "t.txt",
		"a\nresult = calculate_value(argument, 100);\nOTHER\nmarker = newly_created_context();\nz\n",
		json!({"path":"t.txt","edits":[
			{"op":"update","diff":"@@\n a\n+marker = newly_created_context();\n-result = calculate_value(argument, 100);\n+result = calculate_value(argument, 101);"},
			{"op":"update","diff":"@@\n marker = newly_created_context();\n-result = calculate_value(argument, 101);\n+result = calculate_value(argument, 102);"}
		]}),
		Want::Bytes("a\nmarker = newly_created_context();\nresult = calculate_value(argument, 102);\nOTHER\nmarker = newly_created_context();\nz\n".into()),
		&mut fails).await;
	assert!(fails.is_empty(), "sequential context regressions: {fails:?}");
}

/// The separator of a following sibling entry cannot close the rewritten
/// entry, regardless of how its key is spelled.
#[tokio::test]
async fn following_entry_keys_cannot_supply_a_separator() {
	let mut fails = Vec::new();
	for (file, original, head, following, expected) in [
		(
			"values.php",
			"<?php\n$values = [\n    $a => 1,\n    $b => 2,\n];\n",
			"    $a => ",
			"    $c => 4,",
			"<?php\n$values = [\n    $a => 3,\n    $c => 4,\n    $b => 2,\n];\n",
		),
		(
			"t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			"  a: ",
			"  [key]: 4,",
			"const o = {\n  a: 3,\n  [key]: 4,\n  b: 2,\n};\n",
		),
		(
			"t.c",
			"struct S s = {\n  .a = 1,\n  .b = 2,\n};\n",
			"  .a = ",
			"  .c = 4,",
			"struct S s = {\n  .a = 3,\n  .c = 4,\n  .b = 2,\n};\n",
		),
	] {
		for comma in ["", ","] {
			let bare = format!("@@\n-{head}1\n+{head}3{comma}\n+{following}");
			let mut contextual = String::from("@@");
			let old_row = format!("{head}1,");
			for line in original.lines() {
				contextual.push('\n');
				if line == old_row {
					write!(contextual, "-{head}1\n+{head}3{comma}\n+{following}").unwrap();
				} else {
					contextual.push(' ');
					contextual.push_str(line);
				}
			}
			for diff in [bare, contextual] {
				let want = if comma.is_empty() {
					Want::Refuse
				} else {
					Want::Bytes(expected.into())
				};
				p(file, EditMode::Patch, file, original, patch(file, &diff), want, &mut fails).await;
			}
		}
	}
	assert!(fails.is_empty(), "sibling entry regressions: {fails:?}");
}

/// Value continuations remain distinct from new sibling entries, including
/// the character tier's legitimate intraline and line-prefix fragments.
#[tokio::test]
async fn multiline_values_keep_their_own_suffix() {
	let mut fails = Vec::new();
	p(
		"intraline_multiline_value",
		EditMode::Patch,
		"t.js",
		"let value = VALUE;\n",
		patch("t.js", "@@\n-VALUE\n+compute(\n+    1,\n+    2\n+)"),
		Want::Bytes("let value = compute(\n    1,\n    2\n);\n".into()),
		&mut fails,
	)
	.await;
	p(
		"prefix_multiline_value",
		EditMode::Patch,
		"t.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("t.js", "@@\n-  a: 1\n+  a:\n+    5"),
		Want::Bytes("const o = {\n  a:\n    5,\n  b: 2,\n};\n".into()),
		&mut fails,
	)
	.await;
	for value in ["flag ? 3 : 4", "left == right"] {
		p(
			value,
			EditMode::Patch,
			"t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			patch(
				"t.js",
				&format!("@@\n const o = {{\n-  a: 1\n+  a:\n+    {value},\n   b: 2,\n }};"),
			),
			Want::Bytes(format!("const o = {{\n  a:\n    {value},\n  b: 2,\n}};\n")),
			&mut fails,
		)
		.await;
	}
	assert!(fails.is_empty(), "value continuation regressions: {fails:?}");
}

/// Widening a selected literal prefix to its physical row must retain that
/// target, even when another row is a stronger whole-line trim match.
#[tokio::test]
async fn prefix_rewrite_keeps_the_selected_literal_target() {
	let mut fails = Vec::new();
	p(
		"literal_prefix_target",
		EditMode::Patch,
		"t.js",
		"const first = {\n  a: 1,\n};\nconst second = {\na: 1\n};\n",
		patch("t.js", "@@\n-  a: 1\n+  a: 3,\n+  c: 4,"),
		Want::BytesOrRefuse(
			"const first = {\n  a: 3,\n  c: 4,\n};\nconst second = {\na: 1\n};\n".into(),
		),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "literal target regressions: {fails:?}");
}

/// Parameter annotations and lambda arrows belong to the continued value,
/// not to a new entry; association arrows still identify entries.
#[tokio::test]
async fn flat_function_values_keep_the_entry_separator() {
	let mut fails = Vec::new();
	p(
		"flat_arrow_function",
		EditMode::Patch,
		"t.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("t.js", "@@\n-  a: 1\n+  a:\n+    (x) => x + 1"),
		Want::Bytes("const o = {\n  a:\n    (x) => x + 1,\n  b: 2,\n};\n".into()),
		&mut fails,
	)
	.await;
	p(
		"flat_typed_closure",
		EditMode::Patch,
		"t.rs",
		"fn build() {\n    let config = Config {\n        transform: old_handler,\n        retries: \
		 2,\n    };\n}\n",
		patch(
			"t.rs",
			"@@\n-        transform: old_handler\n+        transform:\n+            |x: i32| x + 1",
		),
		Want::Bytes(
			"fn build() {\n    let config = Config {\n        transform:\n            |x: i32| x + \
			 1,\n        retries: 2,\n    };\n}\n"
				.into(),
		),
		&mut fails,
	)
	.await;
	p(
		"parenthesized_association_key",
		EditMode::Patch,
		"values.php",
		"<?php\n$values = [\n    $a => 1,\n    $b => 2,\n];\n",
		patch(
			"values.php",
			"@@\n $values = [\n-    $a => 1\n+    $a => 3\n+    ($c) => 4,\n     $b => 2,\n ];",
		),
		Want::Refuse,
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "function value regressions: {fails:?}");
}

/// Lambda parameter scopes remain value syntax even when their annotations
/// or delimiters span rows.
#[tokio::test]
async fn lambda_parameter_scopes_continue_across_rows() {
	let mut fails = Vec::new();
	p(
		"python_lambda_value",
		EditMode::Patch,
		"c.py",
		"CONFIG = dict(\n    handler=old_handler,\n    retries=2,\n)\n",
		patch("c.py", "@@\n-    handler=old_handler\n+    handler=\n+        lambda x: x + 1"),
		Want::Bytes(
			"CONFIG = dict(\n    handler=\n        lambda x: x + 1,\n    retries=2,\n)\n".into(),
		),
		&mut fails,
	)
	.await;
	p("rust_multiline_typed_parameters", EditMode::Patch, "t.rs",
		"fn build() {\n    let config = Config {\n        transform: old_handler,\n        retries: 2,\n    };\n}\n",
		patch("t.rs", "@@\n-        transform: old_handler\n+        transform:\n+            |x: i32,\n+                y: i32,\n+                z: i32| x + y + z"),
		Want::Bytes("fn build() {\n    let config = Config {\n        transform:\n            |x: i32,\n                y: i32,\n                z: i32| x + y + z,\n        retries: 2,\n    };\n}\n".into()), &mut fails).await;
	assert!(fails.is_empty(), "parameter scope regressions: {fails:?}");
}

/// A switch association arrow retains its role when the next arm uses a
/// numeric or discard pattern that could otherwise resemble a lambda head.
#[tokio::test]
async fn switch_arm_arrows_cannot_supply_another_arms_separator() {
	let mut fails = Vec::new();
	let original = "int value = 1;\nvar result = value switch {\n    1 => 10,\n};\n";
	for pattern in ["2", "_"] {
		p(
			pattern,
			EditMode::Patch,
			"t.cs",
			original,
			patch(
				"t.cs",
				&format!(
					"@@\n var result = value switch {{\n-    1 => 10\n+    1 => 11\n+    {pattern} => \
					 30,\n }};"
				),
			),
			Want::Refuse,
			&mut fails,
		)
		.await;
		p(
			pattern,
			EditMode::Patch,
			"t.cs",
			original,
			patch(
				"t.cs",
				&format!(
					"@@\n var result = value switch {{\n-    1 => 10\n+    1 => 11,\n+    {pattern} => \
					 30,\n }};"
				),
			),
			Want::Bytes(format!(
				"int value = 1;\nvar result = value switch {{\n    1 => 11,\n    {pattern} => \
				 30,\n}};\n"
			)),
			&mut fails,
		)
		.await;
	}
	assert!(fails.is_empty(), "association arrow regressions: {fails:?}");
}

/// Consumption follows the actual character tier, and an exact value
/// explicitly produced by the previous update is legitimate new evidence.
#[tokio::test]
async fn sequential_character_evidence_matches_dispatch() {
	let mut fails = Vec::new();
	p(
		"sequential_new_value_no_context",
		EditMode::Patch,
		"t.txt",
		"result = calculate_value(argument, 100);\n",
		json!({"path":"t.txt","edits":[
			{"op":"update","diff":"@@\n-100\n+101"},
			{"op":"update","diff":"@@\n-101\n+102"}
		]}),
		Want::Bytes("result = calculate_value(argument, 102);\n".into()),
		&mut fails,
	)
	.await;
	let anchored = json!({"op":"update","diff":"@@ const second = {\n-a: 1\n+a: 2"});
	let literal = json!({"op":"update","diff":"@@\n-  a: 1\n+  a: 3"});
	for edits in [[anchored.clone(), literal.clone()], [literal, anchored]] {
		p(
			"character_preflight_mode",
			EditMode::Patch,
			"t.js",
			"const first = {\n  a: 1,\n};\nconst second = {\na: 1\n};\n",
			json!({"path":"t.js","edits":edits}),
			Want::Bytes("const first = {\n  a: 3,\n};\nconst second = {\na: 2\n};\n".into()),
			&mut fails,
		)
		.await;
	}
	assert!(fails.is_empty(), "character consumption regressions: {fails:?}");
}

/// Value operators and function annotations are not sibling entry keys.
#[tokio::test]
async fn value_operator_scopes_do_not_start_entries() {
	let mut fails = Vec::new();
	for (label, file, original, diff, expected) in [
		("multiline_ternary", "t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			"@@\n-  a: 1\n+  a: flag ?\n+    3 : 4",
			"const o = {\n  a: flag ?\n    3 : 4,\n  b: 2,\n};\n"),
		("modifier_word_parameter", "t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			"@@\n-  a: 1\n+  a:\n+    async => async + 1",
			"const o = {\n  a:\n    async => async + 1,\n  b: 2,\n};\n"),
		("static_typed_lambda", "t.cs",
			"var config = new Config {\n    Handler = OldHandler,\n    Count = 2,\n};\n",
			"@@\n-    Handler = OldHandler\n+    Handler =\n+        static (int x) => x + 1",
			"var config = new Config {\n    Handler =\n        static (int x) => x + 1,\n    Count = 2,\n};\n"),
		("async_lambda_head_block_comment", "t.js",
			"const o = {\n  a: 1,\n  b: 2,\n};\n",
			"@@\n-  a: 1\n+  a:\n+    async /* keep */ x => x + 1",
			"const o = {\n  a:\n    async /* keep */ x => x + 1,\n  b: 2,\n};\n"),
		("static_lambda_head_block_comment", "t.cs",
			"var config = new Config {\n    Handler = OldHandler,\n    Count = 2,\n};\n",
			"@@\n-    Handler = OldHandler\n+    Handler =\n+        static /* keep */ (int x) => x + 1",
			"var config = new Config {\n    Handler =\n        static /* keep */ (int x) => x + 1,\n    Count = 2,\n};\n"),
		("arrow_return_annotation", "values.php",
			"<?php\n$values = [\n    'a' => $old_handler,\n    'b' => 2,\n];\n",
			"@@\n-    'a' => $old_handler\n+    'a' =>\n+        fn($x): int => $x + 1",
			"<?php\n$values = [\n    'a' =>\n        fn($x): int => $x + 1,\n    'b' => 2,\n];\n"),
		("arrow_assignment_body", "values.php",
			"<?php\n$values = [\n    'a' => $old_handler,\n    'b' => 2,\n];\n",
			"@@\n-    'a' => $old_handler\n+    'a' =>\n+        fn($x): int => $x = 1",
			"<?php\n$values = [\n    'a' =>\n        fn($x): int => $x = 1,\n    'b' => 2,\n];\n"),
		("static_fn_head_block_comment", "values.php",
			"<?php\n$values = [\n    'a' => $old_handler,\n    'b' => 2,\n];\n",
			"@@\n-    'a' => $old_handler\n+    'a' =>\n+        static /* keep */ fn($x): int => $x = 1",
			"<?php\n$values = [\n    'a' =>\n        static /* keep */ fn($x): int => $x = 1,\n    'b' => 2,\n];\n"),
		("move_closure_head_block_comment", "lib.rs",
			"fn build() {\n    let config = Config {\n        transform: old_handler,\n        retries: 2,\n    };\n}\n",
			"@@\n-        transform: old_handler\n+        transform:\n+            move /* keep */ |x: i32| x + 1",
			"fn build() {\n    let config = Config {\n        transform:\n            move /* keep */ |x: i32| x + 1,\n        retries: 2,\n    };\n}\n"),
		("arrow_assignment_body_next_row", "values.php",
			"<?php\n$values = [\n    'a' => $old_handler,\n    'b' => 2,\n];\n",
			"@@\n-    'a' => $old_handler\n+    'a' =>\n+        fn($x): int =>\n+            $x = 1",
			"<?php\n$values = [\n    'a' =>\n        fn($x): int =>\n            $x = 1,\n    'b' => 2,\n];\n"),
		("labelled_loop_value", "lib.rs",
			"fn build() {\n    let config = Config {\n        a: 1,\n        b: 2,\n    };\n}\n",
			"@@\n-        a: 1\n+        a:\n+            'done: loop {\n+                break 'done 3;\n+            }",
			"fn build() {\n    let config = Config {\n        a:\n            'done: loop {\n                break 'done 3;\n            },\n        b: 2,\n    };\n}\n"),
	] {
		p(label, EditMode::Patch, file, original, patch(file, diff),
			Want::Bytes(expected.into()), &mut fails).await;
	}
	p(
		"function_body_cannot_claim_following_entry",
		EditMode::Patch,
		"values.php",
		"<?php\n$values = [\n    'a' => $old_handler,\n    'b' => 2,\n];\n",
		patch(
			"values.php",
			"@@\n-    'a' => $old_handler\n+    'a' => fn($x): int => $x\n+    'c' => 3,",
		),
		Want::Refuse,
		&mut fails,
	)
	.await;
	p(
		"literal_pattern_pipe_is_not_a_closure",
		EditMode::Patch,
		"lib.rs",
		"fn build() {\n    let config = Config {\n        value: old,\n        retries: 2,\n    \
		 };\n}\n",
		patch(
			"lib.rs",
			"@@\n fn build() {\n     let config = Config {\n-        value: old\n+        value: \
			 match kind {\n+            'a' | 'b' => 1,\n+            _ => 2,\n+        },\n         \
			 retries: 2,\n     };\n }",
		),
		Want::Bytes(
			"fn build() {\n    let config = Config {\n        value: match kind {\n            'a' | \
			 'b' => 1,\n            _ => 2,\n        },\n        retries: 2,\n    };\n}\n"
				.into(),
		),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "value operator regressions: {fails:?}");
}

/// Blank trailing context confirms the first table without widening its
/// certified statement region into the following table.
#[tokio::test]
async fn toml_trimmed_region_keeps_blank_trailing_context() {
	let mut fails = Vec::new();
	p(
		"toml_blank_context",
		EditMode::Patch,
		"t.toml",
		"[a]\nk = 1\n\n[b]\nk = 1\n",
		patch("t.toml", "@@ [a]\n [a]\n-k = 1\n+k = 2\n "),
		Want::Bytes("[a]\nk = 2\n\n[b]\nk = 1\n".into()),
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "TOML region regressions: {fails:?}");
}

#[tokio::test]
async fn sequential_empty_rows_preserve_file_encoding() {
	let mut fails = Vec::new();
	for (label, original, diffs, expected) in [
		("empty_grouped", "", vec!["@@\n \n+X", "@@\n-X\n+Y"], None),
		("emptied_then_insert", "a", vec!["@@\n-a", "@@\n \n+X"], None),
		("bom_empty_grouped", "\u{feff}", vec!["@@\n \n+X", "@@\n-X\n+Y"], None),
		("eof_character_insertion_point", "a\n", vec!["@@\n- \n+X", "@@\n-X\n+Y"], Some("a\nY\n")),
		(
			"bom_crlf_emptied_then_insert",
			"\u{feff}a\r\n",
			vec!["@@ -1,1 +1,0 @@\n-a", "@@\n \n+X", "@@\n-X\n+Y"],
			None,
		),
		("empty_grouped_no_context", "", vec!["@@\n+X", "@@\n-X\n+Y"], Some("Y")),
		("emptied_then_insert_no_context", "a", vec!["@@\n-a", "@@\n+X"], Some("X")),
		("bom_empty_grouped_no_context", "\u{feff}", vec!["@@\n+X", "@@\n-X\n+Y"], Some("\u{feff}Y")),
		("blank_grouped", "\n", vec!["@@\n \n+X", "@@\n-X\n+Y"], Some("\nY\n")),
		(
			"bom_crlf_blank_grouped",
			"\u{feff}\r\n",
			vec!["@@\n \n+X", "@@\n-X\n+Y"],
			Some("\u{feff}\r\nY\r\n"),
		),
	] {
		for mode in [EditMode::Patch, EditMode::ApplyPatch] {
			let args = if mode == EditMode::Patch {
				json!({"path":"t.txt","edits":diffs.iter().map(|diff| json!({"op":"update","diff":diff})).collect::<Vec<_>>()})
			} else {
				json!({"input":format!("*** Begin Patch\n{}\n*** End Patch", diffs.iter().map(|diff| format!("*** Update File: t.txt\n{diff}")).collect::<Vec<_>>().join("\n"))})
			};
			p(
				&format!("{label}_{mode:?}"),
				mode,
				"t.txt",
				original,
				args,
				match expected {
					Some(bytes) => Want::Bytes(bytes.into()),
					None => Want::Refuse,
				},
				&mut fails,
			)
			.await;
		}
	}
	assert!(fails.is_empty(), "sequential empty-row regressions: {fails:?}");
}

#[tokio::test]
async fn character_normalization_and_joining_preserve_consumption() {
	let mut fails = Vec::new();
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		for (label, original, diffs, want) in [
			("trimmed_trailing_rows", "a\n\nb", ["@@\n-b", "@@\n-a\n+A"], Want::Bytes("A".into())),
			(
				"joined_receiving_row",
				"ab\ncd\nOTHER\ncd   \n",
				["@@\n-ab\n-\n+XX", "@@ -2,1 +2,1 @@\n-cd\n+TARGET"],
				Want::Refuse,
			),
		] {
			let args = if mode == EditMode::Patch {
				json!({"path":"t.txt","edits":diffs.iter().map(|diff| json!({"op":"update","diff":diff})).collect::<Vec<_>>()})
			} else {
				json!({"input":format!("*** Begin Patch\n{}\n*** End Patch", diffs.iter().map(|diff| format!("*** Update File: t.txt\n{diff}")).collect::<Vec<_>>().join("\n"))})
			};
			p(&format!("{label}_{mode:?}"), mode, "t.txt", original, args, want, &mut fails).await;
		}
	}
	assert!(fails.is_empty(), "character row-map regressions: {fails:?}");
}
