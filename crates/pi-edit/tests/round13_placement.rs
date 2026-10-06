//! Placement boundaries: exact byte results, atomic refusals and hunk order
//! independence.
mod common;

use std::fmt::Write;

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
	/// Must succeed with any one of these byte strings.
	BytesAny(Vec<String>),
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
	let ok = match &want {
		Want::Bytes(b) => result.is_ok() && &after == b,
		Want::BytesOrRefuse(b) => refused_clean || (result.is_ok() && &after == b),
		Want::Refuse => refused_clean,
		Want::BytesAny(bs) => result.is_ok() && bs.iter().any(|b| &after == b),
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
		let refused_clean = r.is_err() && w == 0 && a == original;
		match &want {
			Want::Bytes(b) => r.is_ok() && a == b,
			Want::BytesOrRefuse(b) => refused_clean || (r.is_ok() && a == b),
			Want::Refuse => refused_clean,
			Want::BytesAny(bs) => r.is_ok() && bs.iter().any(|b| a == b),
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
async fn anchored_construct_boundaries() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"R13A_SUBSTRING_BODY_AFTER_MID_TOKEN",
		EditMode::Patch,
		"pos.js",
		"function f() { if (ready) {\n    notify(x1);\n  }\n  if (done) {\n    notify(x);\n  }\n}\n",
		patch("pos.js", "@@ f() {\n-    notify(x);\n+    notify(y);"),
		Want::BytesOrRefuse(
			"function f() { if (ready) {\n    notify(x1);\n  }\n  if (done) {\n    notify(y);\n  \
			 }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p("R13A_KOTLIN_LABEL_ESCAPE", EditMode::Patch, "label.kt", "fun f() {\n    outer@\n    while (ready) {\n        notify(x1)\n    }\n}\nfun g() {\n        notify(x)\n}\n", patch("label.kt", "@@ outer@\n-        notify(x)\n+        notify(y)"), Want::BytesOrRefuse("fun f() {\n    outer@\n    while (ready) {\n        notify(y)\n    }\n}\nfun g() {\n        notify(x)\n}\n".into()), f).await;
	p("R13A_KOTLIN_LABEL_CONTROL", EditMode::Patch, "label.kt", "fun f() {\n    outer@\n    while (ready) {\n        notify(x)\n    }\n}\nfun g() {\n        notify(x)\n}\n", patch("label.kt", "@@ outer@\n-        notify(x)\n+        notify(y)"), Want::Bytes("fun f() {\n    outer@\n    while (ready) {\n        notify(y)\n    }\n}\nfun g() {\n        notify(x)\n}\n".into()), f).await;
	p("R13A_LUA_LONG_COMMENT_HEADER_ESCAPE", EditMode::Patch, "pos.lua", "function f()\n  --[=[marker]=] if ready then\n    notify(x1)\n  end\nend\nfunction g()\n    notify(x)\nend\n", patch("pos.lua", "@@ --[=[marker]=] if ready then\n-    notify(x)\n+    notify(y)"), Want::BytesOrRefuse("function f()\n  --[=[marker]=] if ready then\n    notify(y)\n  end\nend\nfunction g()\n    notify(x)\nend\n".into()), f).await;
	p(
		"R13A_OCAML_COMMENT_HEADER_ESCAPE",
		EditMode::Patch,
		"pos.ml",
		"(* lead (* nested *) *) let f () =\n  notify x1\nlet g () =\n  notify x\n",
		patch("pos.ml", "@@ (* lead (* nested *) *) let f () =\n-  notify x\n+  notify y"),
		Want::BytesOrRefuse(
			"(* lead (* nested *) *) let f () =\n  notify y\nlet g () =\n  notify x\n".into(),
		),
		f,
	)
	.await;
	p("R13A_ATTRIBUTE_IN_STRING_ESCAPE", EditMode::Patch, "pos.java", "class C {\n  @A(\"@A\") void f() {\n    notify(x1);\n  }\n  void g() {\n    notify(x);\n  }\n}\n", patch("pos.java", "@@ @A\n-    notify(x);\n+    notify(y);"), Want::BytesOrRefuse("class C {\n  @A(\"@A\") void f() {\n    notify(y);\n  }\n  void g() {\n    notify(x);\n  }\n}\n".into()), f).await;
	p(
		"R13A_CHAIN_MULTIBODY_SAME_CLOSER_ROW",
		EditMode::Patch,
		"pos.js",
		"db.then(() => {\n  notify(x1);\n}).catch(() => {\n  notify(x);\n});\n",
		patch("pos.js", "@@ db.then\n-  notify(x);\n+  notify(y);"),
		Want::BytesOrRefuse(
			"db.then(() => {\n  notify(x1);\n}).catch(() => {\n  notify(y);\n});\n".into(),
		),
		f,
	)
	.await;
	p(
		"R13A_CHAIN_MULTIBODY_ERROR_SUFFIX",
		EditMode::Patch,
		"pos.js",
		"db.then(() => {\n  notify(x1);\n})\n.catch(() => {\n  notify(x);\n  broken = = 1;\n});\n",
		patch("pos.js", "@@ db.then\n-  notify(x);\n+  notify(y);"),
		Want::BytesAnyOrRefuse(vec![
			"db.then(() => {\n  notify(y);\n})\n.catch(() => {\n  notify(x);\n  broken = = 1;\n});\n"
				.into(),
			"db.then(() => {\n  notify(x1);\n})\n.catch(() => {\n  notify(y);\n  broken = = 1;\n});\n"
				.into(),
		]),
		f,
	)
	.await;
	for (label, file, original, diff, from, to) in [
	("R13A_HTML_SCRIPT_FUNCTION_ESCAPE", "s.html", "<script>\nfunction f() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n</script>\n", "@@ function f() {\n-  notify(x);\n+  notify(y);", "notify(x1)", "notify(y)"),
	("R13A_VUE_SCRIPT_FUNCTION_ESCAPE", "s.vue", "<script>\nfunction f() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n</script>\n", "@@ function f() {\n-  notify(x);\n+  notify(y);", "notify(x1)", "notify(y)"),
	("R13A_SVELTE_SCRIPT_FUNCTION_ESCAPE", "s.svelte", "<script>\nfunction f() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n</script>\n", "@@ function f() {\n-  notify(x);\n+  notify(y);", "notify(x1)", "notify(y)"),
	("R13A_ASTRO_FRONTMATTER_FUNCTION_ESCAPE", "s.astro", "---\nfunction f() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n---\n<p>body</p>\n", "@@ function f() {\n-  notify(x);\n+  notify(y);", "notify(x1)", "notify(y)"),
	("R13A_YAML_MAPPING_ESCAPE", "s.yml", "first:\n  nested:\n    value: old1\nsecond:\n  nested:\n    value: old\n", "@@ first:\n-    value: old\n+    value: new", "value: old1", "value: new"),
	("R13A_TOML_TABLE_ESCAPE", "s.toml", "[first]\nvalue = \"old1\"\n[second]\nvalue = \"old\"\n", "@@ [first]\n-value = \"old\"\n+value = \"new\"", "value = \"old1\"", "value = \"new\""),
	("R13A_JSON_PAIR_ESCAPE", "s.json", "{\n  \"first\": {\n    \"value\": \"old1\"\n  },\n  \"second\": {\n    \"value\": \"old\"\n  }\n}\n", "@@ \"first\": {\n-    \"value\": \"old\"\n+    \"value\": \"new\"", "\"value\": \"old1\"", "\"value\": \"new\""),
	("R13A_GO_LABEL_ESCAPE", "label.go", "package p\nfunc f() {\nouter:\n  for ready {\n    notify(x1)\n  }\n}\nfunc g() {\n    notify(x)\n}\n", "@@ outer:\n-    notify(x)\n+    notify(y)", "notify(x1)", "notify(y)"),
	("R13A_CS_LABEL_ESCAPE", "label.cs", "class C {\nvoid F() {\nouter:\n  while (ready) {\n    notify(x1);\n  }\n}\nvoid G() {\n    notify(x);\n}\n}\n", "@@ outer:\n-    notify(x);\n+    notify(y);", "notify(x1)", "notify(y)"),
	("R13A_PHP_LABEL_COMMENT_ATTR_ESCAPE", "label.php", "<?php\nfunction f() {\nouter: /* label */\n  while ($ready) {\n    notify($x1);\n  }\n}\nfunction g() {\n    notify($x);\n}\n", "@@ outer: /* label */\n-    notify($x);\n+    notify($y);", "notify($x1)", "notify($y)"),
	("R13A_CRLF_TAB_NORMALIZED_ESCAPE", "pos.js", "function f() {\r\n\tbefore();\t\tif (ready) {\r\n\t\tnotify(x1);\r\n\t}\r\n\tif (done) {\r\n\t\tnotify(x);\r\n\t}\r\n}\r\n", "@@ before(); if (ready) {\n-\t\tnotify(x);\n+\t\tnotify(y);", "notify(x1)", "notify(y)"),
	("R13A_REPEATED_ANCHOR_DIFFERENT_CONSTRUCTS", "pos.js", "if (ready) { if (ready) {\n  notify(x);\n}\n  notify(x);\n}\n", "@@ if (ready) {\n-  notify(x);\n+  notify(y);", "no target", "no target"),
	] {
	let want = if label == "R13A_REPEATED_ANCHOR_DIFFERENT_CONSTRUCTS" { Want::Refuse } else { Want::BytesOrRefuse(original.replacen(from, to, 1)) };
	p(label, EditMode::Patch, file, original, patch(file, diff), want, f).await;
	}
	for (label, anchor) in [
		("R13A_FUZZY_HEADER_CASE_ESCAPE", "FUNCTION f() {"),
		("R13A_FUZZY_HEADER_TYPO_ESCAPE", "function ff() {"),
		("R13A_FUZZY_HEADER_TYPO_NORMALIZED_ESCAPE", "function f()  { // markerz"),
	] {
		let original = if label == "R13A_FUZZY_HEADER_TYPO_NORMALIZED_ESCAPE" {
			"function f() { // marker\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n"
		} else {
			"function f() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n"
		};
		p(
			label,
			EditMode::Patch,
			"pos.js",
			original,
			patch("pos.js", &format!("@@ {anchor}\n-  notify(x);\n+  notify(y);")),
			Want::BytesOrRefuse(original.replacen("notify(x1)", "notify(y)", 1)),
			f,
		)
		.await;
	}
	for (label, original, diff, from, to) in [
		(
			"R13A_UNICODE_NFC_HEADER_ESCAPE",
			"function fe\u{301}() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n",
			"@@ function fé() {\n-  notify(x);\n+  notify(y);",
			"notify(x1)",
			"notify(y)",
		),
		(
			"R13A_UNICODE_JOINER_HEADER_ESCAPE",
			"function a\u{200d}b() {\n  notify(x1);\n}\nfunction g() {\n  notify(x);\n}\n",
			"@@ function ab() {\n-  notify(x);\n+  notify(y);",
			"notify(x1)",
			"notify(y)",
		),
		(
			"R13A_MID_TOKEN_ANCHOR_IF_ESCAPE",
			"function f() { if (ready) {\n  notify(x1);\n}\nif (done) {\n  notify(x);\n}\n}\n",
			"@@ f (ready) {\n-  notify(x);\n+  notify(y);",
			"notify(x1)",
			"notify(y)",
		),
	] {
		p(
			label,
			EditMode::Patch,
			"pos.js",
			original,
			patch("pos.js", diff),
			Want::BytesOrRefuse(original.replacen(from, to, 1)),
			f,
		)
		.await;
	}
	for (label, anchor) in [
		("R13A_FUZZY_ISOLATED_HEADER_TYPO_ESCAPE", "function uniquely_named_target_functionn() {"),
		("R13A_FUZZY_ISOLATED_HEADER_CASE_ESCAPE", "Function uniquely_named_target_function() {"),
		("R13A_FUZZY_ISOLATED_HEADER_PAREN_ESCAPE", "function uniquely_named_target_function()"),
	] {
		let original = "function uniquely_named_target_function() {\n  notify(x1);\n}\nfunction g() \
		                {\n  notify(x);\n}\n";
		p(
			label,
			EditMode::Patch,
			"pos.js",
			original,
			patch("pos.js", &format!("@@ {anchor}\n-  notify(x);\n+  notify(y);")),
			Want::BytesOrRefuse(original.replacen("notify(x1)", "notify(y)", 1)),
			f,
		)
		.await;
	}
	for (label, anchor) in [
		("R13A_FUZZY_ISOLATED_HEADER_TYPO_CONTROL", "function uniquely_named_target_functionn() {"),
		("R13A_FUZZY_ISOLATED_HEADER_CASE_CONTROL", "Function uniquely_named_target_function() {"),
	] {
		let original = "function uniquely_named_target_function() {\n  notify(x);\n}\nfunction g() \
		                {\n  notify(x);\n}\n";
		p(
			label,
			EditMode::Patch,
			"pos.js",
			original,
			patch("pos.js", &format!("@@ {anchor}\n-  notify(x);\n+  notify(y);")),
			Want::Bytes(original.replacen("notify(x)", "notify(y)", 1)),
			f,
		)
		.await;
	}
	for (label, file, original, diff) in [
		(
			"R13A_KOTLIN_STACKED_OWN_ROWS_CONTROL",
			"labels.kt",
			"fun f() {\nouter@\ninner@\n  while (ready) {\n    notify(x)\n  }\n}\nfun g() {\n    \
			 notify(x)\n}\n",
			"@@ outer@\n-    notify(x)\n+    notify(y)",
		),
		(
			"R13A_PHP_STACKED_OWN_ROWS_CONTROL",
			"labels.php",
			"<?php\nfunction f() {\nouter:\ninner:\n  while ($ready) {\n    notify($x);\n  \
			 }\n}\nfunction g() {\n    notify($x);\n}\n",
			"@@ outer:\n-    notify($x);\n+    notify($y);",
		),
		(
			"R13A_KOTLIN_LABEL_COMMENT_CONTROL",
			"labels.kt",
			"fun f() {\nouter@\n  /* between */\n  while (ready) {\n    notify(x)\n  }\n}\nfun g() \
			 {\n    notify(x)\n}\n",
			"@@ outer@\n-    notify(x)\n+    notify(y)",
		),
	] {
		let expected = if file == "labels.php" {
			original.replacen("notify($x)", "notify($y)", 1)
		} else {
			original.replacen("notify(x)", "notify(y)", 1)
		};
		p(label, EditMode::Patch, file, original, patch(file, diff), Want::Bytes(expected), f).await;
	}
	p(
		"R13A_LIST_INNER_CLOSER_CERTAINTY",
		EditMode::Patch,
		"pos.js",
		"const things = [{\n  notify: \"x\",   \n}, {\n  notify: \"x\",\n}];\n",
		patch("pos.js", "@@ const things = [{\n-  notify: \"x\",\n+  notify: \"y\","),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"R13A_LIST_INNER_CLOSER_CONTROL",
		EditMode::Patch,
		"pos.js",
		"const things = [{\n  notify: \"x\",\n}];\nconst other = {\n  notify: \"x\",\n};\n",
		patch("pos.js", "@@ const things = [{\n-  notify: \"x\",\n+  notify: \"y\","),
		Want::BytesOrRefuse(
			"const things = [{\n  notify: \"y\",\n}];\nconst other = {\n  notify: \"x\",\n};\n".into(),
		),
		f,
	)
	.await;
	p(
		"R13A_ARRAY_ONE_OBJECT_VS_OTHER_RANK",
		EditMode::Patch,
		"pos.js",
		"const things = [{\n  notify: \"x\",   \n}];\nconst other = {\n  notify: \"x\",\n};\n",
		patch("pos.js", "@@ const things = [{\n-  notify: \"x\",\n+  notify: \"y\","),
		Want::BytesOrRefuse(
			"const things = [{\n  notify: \"y\",\n}];\nconst other = {\n  notify: \"x\",\n};\n".into(),
		),
		f,
	)
	.await;
	p(
		"R13A_KOTLIN_STACKED_OWN_ROWS_ESCAPE",
		EditMode::Patch,
		"labels.kt",
		"fun f() {\nouter@\ninner@\n  while (ready) {\n    notify(x1)\n  }\n}\nfun g() {\n    \
		 notify(x)\n}\n",
		patch("labels.kt", "@@ outer@\n-    notify(x)\n+    notify(y)"),
		Want::BytesOrRefuse(
			"fun f() {\nouter@\ninner@\n  while (ready) {\n    notify(y)\n  }\n}\nfun g() {\n    \
			 notify(x)\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"R13A_PHP_STACKED_OWN_ROWS_ESCAPE",
		EditMode::Patch,
		"labels.php",
		"<?php\nfunction f() {\nouter:\ninner:\n  while ($ready) {\n    notify($x1);\n  \
		 }\n}\nfunction g() {\n    notify($x);\n}\n",
		patch("labels.php", "@@ outer:\n-    notify($x);\n+    notify($y);"),
		Want::BytesOrRefuse(
			"<?php\nfunction f() {\nouter:\ninner:\n  while ($ready) {\n    notify($y);\n  \
			 }\n}\nfunction g() {\n    notify($x);\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p("R13A_SUBSTRING_INSERTION_MULTILINE_HEADER",EditMode::Patch,"pos.js","function f() {\n  before(); if (ready &&\n      check()) {\n    work();\n  }\n}\n",patch("pos.js","@@ if (ready &&\n+    setup();"),Want::Bytes("function f() {\n  before(); if (ready &&\n      check()) {\n    setup();\n    work();\n  }\n}\n".into()),f).await;
	p(
		"R13A_NESTED_SUBSTRING_INSERTION_MULTILINE_HEADER",
		EditMode::Patch,
		"pos.js",
		"function f() { if (ready &&\n    check()) {\n  work();\n}\n}\n",
		patch("pos.js", "@@ if (ready &&\n+  setup();"),
		Want::Bytes(
			"function f() { if (ready &&\n    check()) {\n  setup();\n  work();\n}\n}\n".into(),
		),
		f,
	)
	.await;
	p(
		"R13A_SUBSTRING_INSERTION_BARE_BODY_OWNER",
		EditMode::Patch,
		"pos.js",
		"function f() {\n  before(); if (ready)\n    work();\n}\n",
		patch("pos.js", "@@ if (ready)\n+    setup();"),
		Want::Refuse,
		f,
	)
	.await;
	for (label,file,original,diff,from,to) in [
	("R13A_YAML_MIDKEY_ESCAPE","s.yml","uniquely_named_target:\n  value: old1\nsecond:\n  value: old\n","@@ named_target:\n-  value: old\n+  value: new","value: old1","value: new"),
	("R13A_JSON_MIDKEY_ESCAPE","s.json","{\n  \"uniquely_named_target\":\n  {\n    \"value\": \"old1\"\n  },\n  \"second\": {\n    \"value\": \"old\"\n  }\n}\n","@@ named_target\":\n-    \"value\": \"old\"\n+    \"value\": \"new\"","\"value\": \"old1\"","\"value\": \"new\""),
	("R13A_ALLMAN_MIDNAME_ESCAPE","pos.cs","class C {\n  void uniquely_named_target()\n  {\n    notify(x1);\n  }\n  void g() {\n    notify(x);\n  }\n}\n","@@ named_target()\n-    notify(x);\n+    notify(y);","notify(x1)","notify(y)"),
	] {
	p(label,EditMode::Patch,file,original,patch(file,diff),Want::BytesOrRefuse(original.replacen(from,to,1)),f).await;
	}
	for (label, original) in [
		(
			"R13A_CLOSER_INTER_TOKEN_COMMENT_ESCAPE",
			"db.then(() => {\n  notify(x1);\n} /* end comment\n*/);\nfunction g() {\n  \
			 notify(x);\n}\n",
		),
		(
			"R13A_CLOSER_INTER_TOKEN_COMMENT_CONTROL",
			"db.then(() => {\n  notify(x);\n} /* end comment\n*/);\nfunction g() {\n  notify(x);\n}\n",
		),
	] {
		let expected = original.replacen(
			if label.ends_with("ESCAPE") {
				"notify(x1)"
			} else {
				"notify(x)"
			},
			"notify(y)",
			1,
		);
		let want = if label.ends_with("ESCAPE") {
			Want::BytesOrRefuse(expected)
		} else {
			Want::Bytes(expected)
		};
		p(
			label,
			EditMode::Patch,
			"pos.js",
			original,
			patch("pos.js", "@@ db.then\n-  notify(x);\n+  notify(y);"),
			want,
			f,
		)
		.await;
	}
	// REGION_ROWS
	assert!(fails.is_empty(), "region placement failures: {fails:?}");
}

#[tokio::test]
async fn row_ancestry_and_fixed_gaps() {
	let mut fails = Vec::new();
	let f = &mut fails;
	both(
		"R13MH_DUPLICATE_MOVE_REWRITE",
		"adj.txt",
		"a\nfoo\np\nfoo\nz\n",
		"@@\n a\n+X\n foo",
		"@@\n-foo\n-p\n-foo\n-z\n+p\n+z\n+foo\n+bar",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"R13MH_DUPLICATE_MOVE_RETAINED",
		"adj.txt",
		"a\nfoo\np\nfoo\nz\nend\n",
		"@@\n a\n+X\n foo",
		"@@\n-foo\n-p\n-foo\n-z\n+z\n+p\n+foo\n+foo",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"R13MH_MOVE_COPY_REWRITE_CONTEXT",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n c\n+X\n d",
		"@@\n-b\n-c\n-d\n+d\n+c\n+D\n+b",
		Want::Refuse,
		f,
	)
	.await;
	p("R13MH_EMPTY_CRLF_SEQ", EditMode::Patch, "empty.txt", "a\r\n", json!({"path":"empty.txt","edits":[{"op":"update","diff":"@@\n-a"},{"op":"update","diff":"@@\n+X"}]}), Want::BytesAny(vec!["X\r\n".into(), "X".into()]), f).await;
	p(
		"R13MH_BOM_EMPTY_APPEND",
		EditMode::Patch,
		"empty.txt",
		"\u{feff}",
		patch("empty.txt", "@@\n+X"),
		Want::BytesAny(vec!["\u{feff}X".into(), "\u{feff}X\n".into()]),
		f,
	)
	.await;
	{
		let original = "a\nfoo\np\nfo0\nz\n";
		let e1 = json!({"op":"update","diff":"@@\n a\n-foo\n+other\n p"});
		let e2 = json!({"op":"update","diff":"@@\n p\n-fo0\n+foo\n z"});
		let e3 = json!({"op":"update","diff":"@@\n a\n-other\n+foo\n p"});
		let movec = json!({"op":"update","diff":"@@\n-foo\n-p\n-foo\n-z\n+z\n+foo\n+p\n+foo"});
		let movel =
			json!({"op":"update","diff":"@@ -2,4 +2,4 @@\n-foo\n-p\n-foo\n-z\n+z\n+foo\n+p\n+foo"});
		let row3 = json!({"op":"update","diff":"@@ -3,1 +3,1 @@\n-foo\n+bar"});
		let row5 = json!({"op":"update","diff":"@@ -5,1 +5,1 @@\n-foo\n+bar"});
		p("R13MH_UNRETAINED_CHAR_MOVE_WRONG_DUP",EditMode::Patch,"moves.txt",original,json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),movec.clone(),row5.clone()]}),Want::Refuse,f).await;
		p(
			"R13MH_UNRETAINED_LINE_MOVE_WRONG_DUP",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),movel.clone(),row5]}),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"R13MH_UNRETAINED_CHAR_MOVE_CONTROL",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),movec,row3.clone()]}),
			Want::BytesOrRefuse("a\nz\nbar\np\nfoo\n".into()),
			f,
		)
		.await;
		p(
			"R13MH_UNRETAINED_LINE_MOVE_CONTROL",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1,e2,e3,movel,row3]}),
			Want::BytesOrRefuse("a\nz\nbar\np\nfoo\n".into()),
			f,
		)
		.await;
	}
	{
		let original = "a\nfoo\np\nfo0\nz\n";
		let e1 = json!({"op":"update","diff":"@@\n a\n-foo\n+other\n p"});
		let e2 = json!({"op":"update","diff":"@@\n p\n-fo0\n+foo\n z"});
		let mc = json!({"op":"update","diff":"@@\n-other\n-p\n-foo\n-z\n+z\n+foo\n+p\n+foo"});
		let ml =
			json!({"op":"update","diff":"@@ -2,4 +2,4 @@\n-other\n-p\n-foo\n-z\n+z\n+foo\n+p\n+foo"});
		let wrong = json!({"op":"update","diff":"@@ -3,1 +3,1 @@\n-foo\n+bar"});
		p(
			"R13MH_MOVE_PLUS_REWRITE_CHAR_WRONG",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),mc,wrong.clone()]}),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"R13MH_MOVE_PLUS_REWRITE_LINE_WRONG",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1,e2,ml,wrong]}),
			Want::Refuse,
			f,
		)
		.await;
	}
	p(
		"R13X_CRLF_DELETE_ONLY",
		EditMode::Patch,
		"empty.txt",
		"a\r\n",
		patch("empty.txt", "@@\n-a"),
		Want::BytesAny(vec![String::new(), "\r\n".into()]),
		f,
	)
	.await;
	p(
		"R13X_LF_DELETE_ONLY",
		EditMode::Patch,
		"empty.txt",
		"a\n",
		patch("empty.txt", "@@\n-a"),
		Want::BytesAny(vec![String::new(), "\n".into()]),
		f,
	)
	.await;
	p("R13X_LF_EMPTIED_APPEND", EditMode::Patch, "empty.txt", "a\n", json!({"path":"empty.txt","edits":[{"op":"update","diff":"@@\n-a"},{"op":"update","diff":"@@\n+X"}]}), Want::BytesAny(vec!["X\n".into(), "X".into()]), f).await;
	p("R13X_CRLF_EMPTIED_APPEND", EditMode::Patch, "empty.txt", "a\r\n", json!({"path":"empty.txt","edits":[{"op":"update","diff":"@@\n-a"},{"op":"update","diff":"@@\n+X"}]}), Want::BytesAny(vec!["X\r\n".into(), "X".into()]), f).await;
	p(
		"R13X_CRLF_SINGLE_DIFF_REPLACE_ALL",
		EditMode::Patch,
		"empty.txt",
		"a\r\n",
		patch("empty.txt", "@@\n-a\n+X"),
		Want::Bytes("X\r\n".into()),
		f,
	)
	.await;
	{
		let hs = ["@@\n a\n+X\n b", "@@\n-b\n-c\n-d\n+d\n+c\n+b", "@@\n e\n+Y\n f"];
		for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
			p(
				&format!("R13MH_MOVE_THREE_ORDER_{order:?}"),
				EditMode::Patch,
				"adj.txt",
				"a\nb\nc\nd\ne\nf\n",
				patch("adj.txt", &order.map(|i| hs[i]).join("\n")),
				Want::Refuse,
				f,
			)
			.await;
		}
	}
	{
		let hs = ["@@\n a\n-foo\n+A\n b", "@@\n-foo\n+B", "@@\n c\n-foo\n+C\n d"];
		for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
			p(
				&format!("R13MH_ELIM_CHAIN_ORDER_{order:?}"),
				EditMode::Patch,
				"adj.txt",
				"a\nfoo\nb\nx\nfoo\ny\nc\nfoo\nd\n",
				patch("adj.txt", &order.map(|i| hs[i]).join("\n")),
				Want::Bytes("a\nA\nb\nx\nB\ny\nc\nC\nd\n".into()),
				f,
			)
			.await;
		}
	}
	both(
		"R13MH_MOVE_MISALIGNED_RESIDUAL_REWRITE",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n-d\n+d\n+B\n+c",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"R13MH_MOVE_MISALIGNED_RESIDUAL_CONTROL",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n-d\n+B\n+d\n+c",
		Want::BytesOrRefuse("a\nX\nB\nd\nc\ne\n".into()),
		f,
	)
	.await;
	{
		let orig = "a\nfoo\np\nfo0\nz\n";
		let e1 = json!({"op":"update","diff":"@@\n a\n-foo\n+other\n p"});
		let e2 = json!({"op":"update","diff":"@@\n p\n-fo0\n+foo\n z"});
		for (label, mv) in [
			("R13MH_UNIQUE_MOVE_CHAR_WRONG", "@@\n-other\n-p\n-foo\n-z\n+z\n+foo\n+p\n+other"),
			(
				"R13MH_UNIQUE_MOVE_LINE_WRONG",
				"@@ -2,4 +2,4 @@\n-other\n-p\n-foo\n-z\n+z\n+foo\n+p\n+other",
			),
		] {
			p(label,EditMode::Patch,"moves.txt",orig,json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),{"op":"update","diff":mv},{"op":"update","diff":"@@\n-foo\n+bar"}]}),Want::Refuse,f).await;
		}
		p("R13MH_UNIQUE_NOMOVE_CONTROL",EditMode::Patch,"moves.txt",orig,json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),{"op":"update","diff":"@@\n-foo\n+bar"}]}),Want::Refuse,f).await;
	}
	both(
		"R13MH_CONTEXT_DOC_CAPTURE",
		"docs.rs",
		"/// Original f docs\nfn f() {}\nlet end = 1;\n",
		"@@\n /// Original f docs\n+fn g() {}",
		"@@\n-let end = 1;\n+let end = 1;",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"R13MH_CONTEXT_PY_COMMENT_CAPTURE",
		"docs.py",
		"# Original f docs\ndef f():\n    return 1\nmarker = 1\n",
		"@@\n # Original f docs\n+def g():\n+    return 2",
		"@@\n-marker = 1\n+marker = 1",
		Want::Refuse,
		f,
	)
	.await;
	p(
		"R13X_CONTEXT_DOC_CAPTURE_SINGLE",
		EditMode::Patch,
		"docs.rs",
		"/// Original f docs\nfn f() {}\nlet end = 1;\n",
		patch("docs.rs", "@@\n /// Original f docs\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	both(
		"R13MH_NOEOF_DELETE_BREAKS_BLANK_CONTEXT",
		"adj.txt",
		"a\n\nb",
		"@@\n a\n \n-b",
		"@@\n-a\n+A",
		Want::BytesAnyOrRefuse(vec!["A\n\n".into(), "A".into()]),
		f,
	)
	.await;
	both(
		"R13MH_NOEOF_DELETE_DROPS_UNTOUCHED_BLANK",
		"adj.txt",
		"a\n\nb",
		"@@\n-b",
		"@@\n-a\n+A",
		Want::BytesAnyOrRefuse(vec!["A\n\n".into(), "A".into()]),
		f,
	)
	.await;
	p(
		"R13MH_NOEOF_CHARACTER_DELETE_BLANK_CONTEXT",
		EditMode::Patch,
		"adj.txt",
		"a\n\nb",
		patch("adj.txt", "@@\n a\n \n-b"),
		Want::BytesAnyOrRefuse(vec!["a\n\n".into(), "a".into()]),
		f,
	)
	.await;
	p(
		"R13MH_NOEOF_CHARACTER_DELETE_BLANK_UNTOUCHED",
		EditMode::Patch,
		"adj.txt",
		"a\n\nb",
		patch("adj.txt", "@@\n-b"),
		Want::BytesAnyOrRefuse(vec!["a\n\n".into(), "a".into()]),
		f,
	)
	.await;
	p(
		"R13X_CONTEXT_INSERT_SWIFT_ELSE_OWNER",
		EditMode::Patch,
		"s.swift",
		"func f(ok: Bool) {\n  if ok {\n    print(\"target\")\n  }\n}\n",
		patch("s.swift", "@@\n   if ok {\n+    print(\"before\")\n+  } else {"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"R13X_CONTEXT_INSERT_JS_ELSE_OWNER",
		EditMode::Patch,
		"s.js",
		"function f(ok) {\n  if (ok) {\n    target();\n  }\n}\n",
		patch("s.js", "@@\n   if (ok) {\n+    before();\n+  } else {"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"R13X_CONTEXT_INSERT_EXPLICIT_TRAILING_CONTROL",
		EditMode::Patch,
		"docs.rs",
		"/// Original f docs\nfn f() {}\nlet end = 1;\n",
		patch("docs.rs", "@@\n /// Original f docs\n+fn g() {}\n fn f() {}"),
		Want::Bytes("/// Original f docs\nfn g() {}\nfn f() {}\nlet end = 1;\n".into()),
		f,
	)
	.await;
	p(
		"R13X_CONTEXT_INSERT_PY_DOCSTRING",
		EditMode::Patch,
		"f.py",
		"def f():\n    \"\"\"Original docs\"\"\"\n    return 1\n",
		patch("f.py", "@@\n def f():\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;
	// MULTIHUNK_ROWS
	assert!(fails.is_empty(), "multihunk placement failures: {fails:?}");
}

#[tokio::test]
async fn preserved_token_and_payload_roles() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"L13_HTML_SCRIPT_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.html",
		"<script>\nconst value = old\nkeep()\n</script>\n",
		patch("s.html", "@@\n-old\n+0 /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_VUE_SCRIPT_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.vue",
		"<script>\nconst value = old\nkeep()\n</script>\n",
		patch("s.vue", "@@\n-old\n+0 /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SVELTE_SCRIPT_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.svelte",
		"<script>\nconst value = old\nkeep()\n</script>\n",
		patch("s.svelte", "@@\n-old\n+0 /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_HTML_STYLE_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.html",
		"<style>\n.a { color: old }\n.b { color: blue }\n</style>\n",
		patch("s.html", "@@\n-old\n+red /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MD_FENCE_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.md",
		"```js\nconst value = old\nkeep()\n```\n",
		patch("s.md", "@@\n-old\n+0 /*"),
		Want::BytesOrRefuse("```js\nconst value = 0 /*\nkeep()\n```\n".into()),
		f,
	)
	.await;
	both(
		"L13_JS_STRING_TO_REGEX",
		"s.js",
		"const expression = \"oldKEEP\"\n",
		"@@\n-\"old\n+/new",
		"@@\n-KEEP\"\n+KEEP/",
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JS_REGEX_ESCAPE_UNTOUCHED",
		EditMode::Patch,
		"s.js",
		"const expression = /oldKEEP/\n",
		patch("s.js", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SWIFT_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.swift",
		"let text = \"old\\(value) KEEP\"\n",
		patch("s.swift", "@@\n-old\\(\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_KOTLIN_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.kt",
		"val text = \"old${value} KEEP\"\n",
		patch("s.kt", "@@\n-old${\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_KOTLIN_SIMPLE_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.kt",
		"val text = \"old$value KEEP\"\n",
		patch("s.kt", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_RUBY_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.rb",
		"text = \"old#{value} KEEP\"\n",
		patch("s.rb", "@@\n-old#{\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_FSTRING_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.py",
		"text = f\"old{value} KEEP\"\n",
		patch("s.py", "@@\n-f\"old{\n+\"new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PHP_HEREDOC_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.php",
		"<?php\n$text = <<<TXT\nold$value KEEP\nTXT;\n",
		patch("s.php", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SHELL_HEREDOC_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"cat <<TXT\nold$value KEEP\nTXT\n",
		patch("s.sh", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_RUBY_HEREDOC_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.rb",
		"text = <<TXT\nold#{value} KEEP\nTXT\n",
		patch("s.rb", "@@\n-old#{\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MAKE_AT_SAFE_VALUE",
		EditMode::Patch,
		"Makefile",
		"all:\n\t@printf \"old$$KEEP\"\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("all:\n\t@printf \"new$$KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_MAKE_MINUS_SAFE_VALUE",
		EditMode::Patch,
		"Makefile",
		"all:\n\t-printf \"old$$KEEP\"\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("all:\n\t-printf \"new$$KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_CRLF_SAFE_VALUE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\r\nRUN printf \"old$KEEP\"\r\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes("FROM alpine\r\nRUN printf \"new$KEEP\"\r\n".into()),
		f,
	)
	.await;
	p(
		"L13_CSV_SAFE_VALUE",
		EditMode::Patch,
		"s.csv",
		"name,value\nitem,\"old,KEEP\"\n",
		patch("s.csv", "@@\n-old\n+new"),
		Want::Bytes("name,value\nitem,\"new,KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_JS_REGEX_CLASS_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const expression = /olddata/\n",
		patch("s.js", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_HTML_SCRIPT_LINE_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.html",
		"<script>const value = old + keep()</script>\n",
		patch("s.html", "@@\n-old\n+0 //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_VUE_INTERPOLATION_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.vue",
		"<div>{{ old + keep() }}</div>\n",
		patch("s.vue", "@@\n-old\n+0 //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SVELTE_INTERPOLATION_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.svelte",
		"<div>{ old + keep() }</div>\n",
		patch("s.svelte", "@@\n-old\n+0 //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SWIFT_REGEX_TO_CODE",
		EditMode::Patch,
		"s.swift",
		"let expression = #/old KEEP/#\n",
		patch("s.swift", "@@\n-#/old\n+0 //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_DOCKER_MAKE_DOLLAR_BOUNDARY",
		EditMode::Patch,
		"Makefile",
		"all:\n\tprintf \"old$$KEEP\"\n",
		patch("Makefile", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MAKE_REFERENCE_CAPTURE",
		EditMode::Patch,
		"Makefile",
		"all:\n\tprintf 'old$(KEEP)'\n",
		patch("Makefile", "@@\n-old$(\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SHELL_HERESTRING_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"cat <<<old; keep\n",
		patch("s.sh", "@@\n-<<<old\n+<<EOF\n+"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_UNKNOWN_ESCAPED_QUOTE_CAPTURE",
		EditMode::Patch,
		"s.csv",
		"id,\"old\"\"KEEP\",last\n",
		patch("s.csv", "@@\n-old\"\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_UNKNOWN_TSV_MULTILINE_SAFE",
		EditMode::Patch,
		"s.tsv",
		"key\t\"old\nKEEP\"\tlast\n",
		patch("s.tsv", "@@\n-old\n+new"),
		Want::Bytes("key\t\"new\nKEEP\"\tlast\n".into()),
		f,
	)
	.await;
	p(
		"L13_KOTLIN_SIMPLE_ADD_ESCAPE",
		EditMode::Patch,
		"s.kt",
		"val text = \"old$value KEEP\"\n",
		patch("s.kt", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SWIFT_SIMPLE_ADD_ESCAPE",
		EditMode::Patch,
		"s.swift",
		"let text = \"old\\(value) KEEP\"\n",
		patch("s.swift", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JS_UNKNOWN_EXTENSION_CAPTURE",
		EditMode::Patch,
		"s.mjs",
		"const value = old + keep()\n",
		patch("s.mjs", "@@\n-old\n+0 /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_RAW_STRING_CAPTURE",
		EditMode::Patch,
		"s.py",
		"text = r\"old\\nKEEP\"\n",
		patch("s.py", "@@\n-r\"old\n+\"new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_RUST_RAW_STRING_CAPTURE",
		EditMode::Patch,
		"s.rs",
		"fn f() { let text = r\"old\\nKEEP\"; }\n",
		patch("s.rs", "@@\n-r\"old\n+\"new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_CSV_BACKSLASH_QUOTE_CAPTURE",
		EditMode::Patch,
		"s.csv",
		"id,\"old\\\",KEEP,last\n",
		patch("s.csv", "@@\n-old\\\n+new\""),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_TEXT_APOSTROPHE_SAFE",
		EditMode::Patch,
		"s.txt",
		"It's old and KEEP\n",
		patch("s.txt", "@@\n-It's old\n+It is new"),
		Want::Bytes("It is new and KEEP\n".into()),
		f,
	)
	.await;
	p(
		"L13_CSV_APOSTROPHE_SAFE",
		EditMode::Patch,
		"s.csv",
		"id,old'KEEP,last\n",
		patch("s.csv", "@@\n-old'\n+new"),
		Want::Bytes("id,newKEEP,last\n".into()),
		f,
	)
	.await;
	p(
		"L13_KOTLIN_FUZZY_LOST_SEMI_ROLE",
		EditMode::Patch,
		"s.kt",
		"fun f() {\n  val text = \"old$value\"; println(1)\n}\n",
		patch(
			"s.kt",
			"@@ fun f() {\n-  val text = \"old$value\" println(1)\n+  val text = \"new\\$value\"; \
			 println(1)",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SWIFT_FUZZY_LOST_SEMI_ROLE",
		EditMode::Patch,
		"s.swift",
		"func f() {\n  let text = \"old\\(value)\"; print(1)\n}\n",
		patch(
			"s.swift",
			"@@ func f() {\n-  let text = \"old\\(value)\" print(1)\n+  let text = \
			 \"new\\\\(value)\"; print(1)",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_UNICODE_NBSP_STRING_LOSS",
		EditMode::Patch,
		"s.py",
		"value = \"old\u{00a0}KEEP\"\n",
		patch("s.py", "@@ -1,1 +1,1 @@\n-value = \"old KEEP\"\n+value = \"new KEEP\""),
		Want::BytesOrRefuse("value = \"new KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_PY_UNICODE_DASH_STRING_LOSS",
		EditMode::Patch,
		"s.py",
		"value = \"old\u{2014}KEEP\"\n",
		patch("s.py", "@@ -1,1 +1,1 @@\n-value = \"old-KEEP\"\n+value = \"new-KEEP\""),
		Want::BytesOrRefuse("value = \"new-KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_PY_COMBINING_STRING_LOSS",
		EditMode::Patch,
		"s.py",
		"value = \"oldcafe\u{0301}KEEP\"\n",
		patch(
			"s.py",
			"@@ -1,1 +1,1 @@\n-value = \"oldcaf\u{00e9}KEEP\"\n+value = \"newcaf\u{00e9}KEEP\"",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JS_ZWJ_STRING_LOSS",
		EditMode::Patch,
		"s.js",
		"const value = \"old\u{200d}KEEP\";\n",
		patch("s.js", "@@ -1,1 +1,1 @@\n-const value = \"oldKEEP\";\n+const value = \"newKEEP\";"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_NFC_IDENTIFIER_LOSS",
		EditMode::Patch,
		"s.py",
		"oldcaf\u{00e9}KEEP = 1\n",
		patch("s.py", "@@ -1,1 +1,1 @@\n-oldcafe\u{0301}KEEP = 1\n+oldcafe\u{0301}KEEP = 2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SHELL_WORD_BACKSLASH_HASH_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"printf old\\#KEEP\n",
		patch("s.sh", "@@\n-old\\\n+new "),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13X_JS_COMMENT_CAPTURE_CONTROL",
		EditMode::Patch,
		"s.js",
		"const value = old\nkeep()\n",
		patch("s.js", "@@\n-old\n+0 /*"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13X_JS_STRING_ESCAPE_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const text = \"oldnKEEP\";\n",
		patch("s.js", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13X_PY_STRING_ESCAPE_CAPTURE",
		EditMode::Patch,
		"s.py",
		"text = \"oldnKEEP\"\n",
		patch("s.py", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13X_JS_REGEX_DIGIT_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const re = /olddKEEP/;\n",
		patch("s.js", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PHP_STRING_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.php",
		"<?php\n$text = \"old$value KEEP\";\n",
		patch("s.php", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PHP_HEREDOC_ESCAPE_CAPTURE",
		EditMode::Patch,
		"s.php",
		"<?php\n$text = <<<TXT\nold$value KEEP\nTXT;\n",
		patch("s.php", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SWIFT_RAW_INTERPOLATION_CAPTURE",
		EditMode::Patch,
		"s.swift",
		"let text = #\"old\\#(value) KEEP\"#\n",
		patch("s.swift", "@@\n-old\\#(\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_DOCKER_FROM_RESETS_SHELL",
		EditMode::Patch,
		"Dockerfile",
		"FROM windows AS first\nSHELL [\"custom-shell\", \"-c\"]\nFROM alpine\nRUN printf \
		 \"old$KEEP\"\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes(
			"FROM windows AS first\nSHELL [\"custom-shell\", \"-c\"]\nFROM alpine\nRUN printf \
			 \"new$KEEP\"\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"L13_DOCKER_LATER_SHELL_IRRELEVANT",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN printf \"old$KEEP\"\nSHELL [\"custom-shell\", \"-c\"]\nRUN other\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes(
			"FROM alpine\nRUN printf \"new$KEEP\"\nSHELL [\"custom-shell\", \"-c\"]\nRUN other\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"L13_MAKE_ONESHELL_MULTILINE_CAPTURE",
		EditMode::Patch,
		"Makefile",
		".ONESHELL:\nall:\n\tprintf 'old\n\tKEEP'\n",
		patch("Makefile", "@@\n-old\n+new' #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MAKE_ONESHELL_SAFE",
		EditMode::Patch,
		"Makefile",
		".ONESHELL:\nall:\n\tprintf 'old\n\tKEEP'\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes(".ONESHELL:\nall:\n\tprintf 'new\n\tKEEP'\n".into()),
		f,
	)
	.await;
	p(
		"L13_SHELL_BACKTICK_SUBSTITUTION_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"printf \"old`printf KEEP`\"\n",
		patch("s.sh", "@@\n-old`\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_RUBY_PERCENT_STRING_RAW_ESCAPE",
		EditMode::Patch,
		"s.rb",
		"text = %q{old\\nKEEP}\n",
		patch("s.rb", "@@\n-%q{old\n+%Q{new"),
		Want::Refuse,
		f,
	)
	.await;
	both(
		"L13_PHP_SINGLE_TO_DOUBLE_INTERPOLATION",
		"s.php",
		"<?php\n$text = 'old$value KEEP';\n",
		"@@\n-'old\n+\"new",
		"@@\n-KEEP'\n+KEEP\"",
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JS_STRING_ESCAPE_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const text = \"old\"; keep(); const tail = \"END\";\n",
		patch("s.js", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_TRIPLE_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.py",
		"text = \"\"\"old\"\"\"; keep(); tail = \"\"\"END\"\"\"\n",
		patch("s.py", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_C_BLOCK_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.c",
		"void f() { /* old*/ keep(); /* END */ }\n",
		patch("s.c", "@@\n-old*\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_OCAML_BLOCK_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.ml",
		"let value = (* old*) 1 (* END *)\n",
		patch("s.ml", "@@\n-old*\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_HASKELL_BLOCK_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.hs",
		"value = {- old-} 1 {- END -}\n",
		patch("s.hs", "@@\n-old-\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_LUA_BLOCK_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.lua",
		"local value = --[[old]]\nkeep(); --[[END]]\n",
		patch("s.lua", "@@\n-old]\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_XML_BLOCK_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.xml",
		"<root><!--old--><keep/><!--END--></root>\n",
		patch("s.xml", "@@\n-old--\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SHELL_HEREDOC_CLOSE_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"cat <<EOF\nold\nEOF\nprintf keep\nEOF\n",
		patch("s.sh", "@@\n-old\n-EOF\n+new\n+X"),
		Want::BytesOrRefuse("cat <<EOF\nnew\nX\nprintf keep\nEOF\n".into()),
		f,
	)
	.await;
	p(
		"L13_PHP_HEREDOC_MEMBER_CAPTURE",
		EditMode::Patch,
		"s.php",
		"<?php\n$text = <<<TXT\nold$object->value KEEP\nTXT;\n",
		patch("s.php", "@@\n-old$\n+new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_RUST_CHARACTER_ESCAPE_CAPTURE",
		EditMode::Patch,
		"s.rs",
		"fn f() { let ch = 'n'; }\n",
		patch("s.rs", "@@\n-'\n+'\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JAVA_CHARACTER_ESCAPE_CAPTURE",
		EditMode::Patch,
		"s.java",
		"class C { char value = 'n'; }\n",
		patch("s.java", "@@\n- = '\n+ = '\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_VB_BACKSLASH_QUOTE_CAPTURE",
		EditMode::Patch,
		"s.vb",
		"Dim text = \"old\\\" : Keep()\n",
		patch("s.vb", "@@\n-old\\\n+new\""),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_VB_BACKSLASH_SAFE_VALUE",
		EditMode::Patch,
		"s.vb",
		"Dim text = \"old\\\" : Keep()\n",
		patch("s.vb", "@@\n-old\\\n+new"),
		Want::Bytes("Dim text = \"new\" : Keep()\n".into()),
		f,
	)
	.await;
	p(
		"L13_VB_DOUBLE_QUOTE_SAFE_VALUE",
		EditMode::Patch,
		"s.vb",
		"Dim text = \"old\"\"KEEP\" : Keep()\n",
		patch("s.vb", "@@\n-old\n+new"),
		Want::Bytes("Dim text = \"new\"\"KEEP\" : Keep()\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_CRLF_CONTINUATION_CAPTURE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\r\nRUN printf old\\\r\n    #KEEP\r\n",
		patch("Dockerfile", "@@\n-old\n+new\""),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_DOCKER_CONTINUED_QUOTE_SAFE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN printf 'old\\\n    KEEP'\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes("FROM alpine\nRUN printf 'new\\\n    KEEP'\n".into()),
		f,
	)
	.await;
	p(
		"L13_MAKE_HERESTRING_SAFE",
		EditMode::Patch,
		"Makefile",
		"SHELL := /bin/bash\nall:\n\tcat <<<old\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("SHELL := /bin/bash\nall:\n\tcat <<<new\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_HERESTRING_SAFE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nSHELL [\"/bin/bash\", \"-c\"]\nRUN cat <<<old\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes("FROM alpine\nSHELL [\"/bin/bash\", \"-c\"]\nRUN cat <<<new\n".into()),
		f,
	)
	.await;
	p(
		"L13_FUZZY_LINE_OUTSIDE_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const value = old_very_long_configuration_identifier;\nkeep();\n/* tail */\n",
		patch(
			"s.js",
			"@@ -1,1 +1,1 @@\n-const value = old_very_long_configuration_identifiers;\n+const value \
			 = 0; /*",
		),
		Want::BytesOrRefuse("const value = 0; /*\nkeep();\n/* tail */\n".into()),
		f,
	)
	.await;
	p(
		"L13_FUZZY_LINE_CONTEXT_COMMENT_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const value = old_very_long_configuration_identifier;\nkeep();\n/* tail */\n",
		patch(
			"s.js",
			"@@\n-const value = old_very_long_configuration_identifiers;\n+const value = 0; /*\n \
			 keep();",
		),
		Want::BytesOrRefuse("const value = 0; /*\nkeep();\n/* tail */\n".into()),
		f,
	)
	.await;
	p(
		"L13_FUZZY_PY_LINE_OUTSIDE_STRING_CAPTURE",
		EditMode::Patch,
		"s.py",
		"value = old_very_long_configuration_identifier\nkeep()\n# \"\"\"\n",
		patch(
			"s.py",
			"@@ -1,1 +1,1 @@\n-value = old_very_long_configuration_identifiers\n+value = \"\"\"new",
		),
		Want::BytesOrRefuse("value = \"\"\"new\nkeep()\n# \"\"\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_FUZZY_UNKNOWN_LINE_OUTSIDE_STRING_CAPTURE",
		EditMode::Patch,
		"s.vb",
		"Dim value = old_very_long_configuration_identifier\nKeep()\n' \"\n",
		patch(
			"s.vb",
			"@@ -1,1 +1,1 @@\n-Dim value = old_very_long_configuration_identifiers\n+Dim value = \
			 \"new",
		),
		Want::BytesOrRefuse("Dim value = \"new\nKeep()\n\' \"\n".into()),
		f,
	)
	.await;
	p(
		"L13_FUZZY_SHELL_LINE_HEREDOC_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"printf old_very_long_configuration_identifier\nprintf keep\nEOF\n",
		patch("s.sh", "@@ -1,1 +1,1 @@\n-printf old_very_long_configuration_identifiers\n+cat <<EOF"),
		Want::BytesOrRefuse("cat <<EOF\nprintf keep\nEOF\n".into()),
		f,
	)
	.await;
	p(
		"L13X_EXACT_LINE_OUTSIDE_COMMENT_CONTROL",
		EditMode::Patch,
		"s.js",
		"const value = old_very_long_configuration_identifier;\nkeep();\n/* tail */\n",
		patch(
			"s.js",
			"@@ -1,1 +1,1 @@\n-const value = old_very_long_configuration_identifier;\n+const value = \
			 0; /*",
		),
		Want::BytesOrRefuse("const value = 0; /*\nkeep();\n/* tail */\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_RUN_HEREDOC_COMMENT_CAPTURE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN <<EOF\nprintf old keep\nEOF\n",
		patch("Dockerfile", "@@\n-old\n+new #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_DOCKER_COPY_HEREDOC_LITERAL_CONTROL",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nCOPY <<EOF /data\nold keep\nEOF\n",
		patch("Dockerfile", "@@\n-old\n+new #"),
		Want::Bytes("FROM alpine\nCOPY <<EOF /data\nnew # keep\nEOF\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_RUN_HEREDOC_SAFE_VALUE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN <<EOF\nprintf old keep\nEOF\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes("FROM alpine\nRUN <<EOF\nprintf new keep\nEOF\n".into()),
		f,
	)
	.await;
	p(
		"L13_DOCKER_RUN_HEREDOC_CONTINUED_CAPTURE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN <<EOF\nprintf old\nprintf keep\n# END\nEOF\n",
		patch("Dockerfile", "@@\n-old\n+new '"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PY_LITERAL_WHITESPACE_CAPTURE",
		EditMode::Patch,
		"s.py",
		"value = \"old   \"\n",
		patch("s.py", "@@\n-old\n+new\" #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_JS_LITERAL_WHITESPACE_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const value = \"old   \";\n",
		patch("s.js", "@@\n-old\n+new\" //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_SHELL_LITERAL_WHITESPACE_CAPTURE",
		EditMode::Patch,
		"s.sh",
		"printf 'old   '\n",
		patch("s.sh", "@@\n-old\n+new' #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PHP_LITERAL_WHITESPACE_CAPTURE",
		EditMode::Patch,
		"s.php",
		"<?php\n$text = \"old   \";\n",
		patch("s.php", "@@\n-old\n+new\" //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_DOCKER_CRLF_CONTINUATION_SAFE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\r\nRUN printf old \\\r\n    keep\r\n",
		patch("Dockerfile", "@@\n-old\n+new"),
		Want::Bytes("FROM alpine\r\nRUN printf new \\\r\n    keep\r\n".into()),
		f,
	)
	.await;
	p(
		"L13_MAKE_CRLF_CONTINUATION_SAFE",
		EditMode::Patch,
		"Makefile",
		"all:\r\n\tprintf old \\\r\n\tkeep\r\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("all:\r\n\tprintf new \\\r\n\tkeep\r\n".into()),
		f,
	)
	.await;
	p(
		"L13_PARTIAL_LINE_RETAINS_LOSS_CAPTURES_EXTERIOR",
		EditMode::Patch,
		"s.js",
		"const very_long_configuration_identifier = \"old KEEP\";\nkeep();\n/* tail */\n",
		patch(
			"s.js",
			"@@ -1,1 +1,1 @@\n-const very_long_configuration_identifier = \"old\";\n+const \
			 very_long_configuration_identifier = \"new KEEP\"; /*",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_PARTIAL_CONTEXT_LITERAL_CAPTURE",
		EditMode::Patch,
		"s.js",
		"const very_long_configuration_identifier = \"old KEEP\";\nkeep();\n/* tail */\n",
		patch(
			"s.js",
			"@@\n-const very_long_configuration_identifier = \"old\";\n+const \
			 very_long_configuration_identifier = \"new KEEP\"; /*\n keep();",
		),
		Want::BytesOrRefuse(
			"const very_long_configuration_identifier = \"new KEEP\"; /*\nkeep();\n/* tail */\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"L13_MAKE_SHELL_ASSIGNMENT_EXPANSION_CAPTURE",
		EditMode::Patch,
		"Makefile",
		"VALUE != printf \"old$$KEEP\"\n",
		patch("Makefile", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MAKE_SHELL_FUNCTION_EXPANSION_CAPTURE",
		EditMode::Patch,
		"Makefile",
		"VALUE := $(shell printf \"old$$KEEP\")\n",
		patch("Makefile", "@@\n-old\n+new\\"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"L13_MAKE_SHELL_ASSIGNMENT_SAFE_VALUE",
		EditMode::Patch,
		"Makefile",
		"VALUE != printf \"old$$KEEP\"\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("VALUE != printf \"new$$KEEP\"\n".into()),
		f,
	)
	.await;
	p(
		"L13_MAKE_SHELL_FUNCTION_SAFE_VALUE",
		EditMode::Patch,
		"Makefile",
		"VALUE := $(shell printf \"old$$KEEP\")\n",
		patch("Makefile", "@@\n-old\n+new"),
		Want::Bytes("VALUE := $(shell printf \"new$$KEEP\")\n".into()),
		f,
	)
	.await;
	// TOKEN_ROWS
	assert!(fails.is_empty(), "token placement failures: {fails:?}");
}

#[tokio::test]
async fn attachments_and_displaced_ownership() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"DC1_KOTLIN_NAMED_COMPANION_DOCS",
		EditMode::Patch,
		"docs.kt",
		"class C {\n  // Original companion docs\n  companion object F {\n    fun f() {}\n  }\n}\n",
		patch("docs.kt", "@@ // Original companion docs\n+  fun g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC2_ERLANG_SPEC_DOCS",
		EditMode::Patch,
		"docs.erl",
		"-module(docs).\n%% Original f docs\n-spec f() -> integer().\nf() -> 1.\n",
		patch("docs.erl", "@@ %% Original f docs\n+-spec g() -> integer().\n+g() -> 2."),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC3_CLOJURE_NS_DOCS",
		EditMode::Patch,
		"docs.clj",
		";; Original namespace docs\n(ns original)\n(defn f [] 1)\n",
		patch("docs.clj", "@@ ;; Original namespace docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC4_JS_RETURN_FUNCTION_IS_NOT_DECL",
		EditMode::Patch,
		"ordinary.js",
		"function f() {\n  // ordinary expression note\n  return () => 1;\n}\n",
		patch("ordinary.js", "@@ // ordinary expression note\n+  prepare();"),
		Want::Bytes(
			"function f() {\n  // ordinary expression note\n  prepare();\n  return () => 1;\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC5_JS_ARRAY_FUNCTION_IS_NOT_DECL",
		EditMode::Patch,
		"ordinary.js",
		"// ordinary expression note\n[() => 1];\n",
		patch("ordinary.js", "@@ // ordinary expression note\n+prepare();"),
		Want::Bytes("// ordinary expression note\nprepare();\n[() => 1];\n".into()),
		f,
	)
	.await;
	p(
		"DC6_JS_CALL_OBJECT_NOT_DECL",
		EditMode::Patch,
		"ordinary.js",
		"// ordinary expression note\nf({ m() {} });\n",
		patch("ordinary.js", "@@ // ordinary expression note\n+prepare();"),
		Want::Bytes("// ordinary expression note\nprepare();\nf({ m() {} });\n".into()),
		f,
	)
	.await;
	p(
		"DC7_JS_OBJECT_ANONYMOUS_METHOD",
		EditMode::Patch,
		"ordinary.js",
		"const obj = {\n  // ordinary method entry note\n  m() {}\n};\n",
		patch("ordinary.js", "@@ // ordinary method entry note\n+  x: 1,"),
		Want::Bytes("const obj = {\n  // ordinary method entry note\n  x: 1,\n  m() {}\n};\n".into()),
		f,
	)
	.await;
	p(
		"DC8_ERLANG_FUN_DOCS_CONTROL",
		EditMode::Patch,
		"docs.erl",
		"-module(docs).\n%% Original f docs\nf() -> 1.\n",
		patch("docs.erl", "@@ %% Original f docs\n+g() -> 2."),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC9_LUA_FUNCTION_ASSIGNMENT_DOCS",
		EditMode::Patch,
		"docs.lua",
		"-- Original f docs\nf = function()\n  return 1\nend\n",
		patch("docs.lua", "@@ -- Original f docs\n+g = function() return 2 end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC10_LUA_LOCAL_FUNCTION_DOCS_CONTROL",
		EditMode::Patch,
		"docs.lua",
		"-- Original f docs\nlocal f = function()\n  return 1\nend\n",
		patch("docs.lua", "@@ -- Original f docs\n+local g = function() return 2 end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC11_OCAML_EXTERNAL_DOCS",
		EditMode::Patch,
		"docs.ml",
		"(** Original f docs *)\nexternal f : int -> int = \"f\"\n",
		patch("docs.ml", "@@ (** Original f docs *)\n+external g : int -> int = \"g\""),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC12_KOTLIN_OBJECT_DOCS_CONTROL",
		EditMode::Patch,
		"docs.kt",
		"// Original object docs\nobject F {\n  fun f() {}\n}\n",
		patch("docs.kt", "@@ // Original object docs\n+object G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC13_SCALA_GIVEN_DOCS_CONTROL",
		EditMode::Patch,
		"docs.scala",
		"// Original given docs\ngiven answer: Int = 1\n",
		patch("docs.scala", "@@ // Original given docs\n+val inserted = 2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC14_SWIFT_EXTENSION_DOCS_CONTROL",
		EditMode::Patch,
		"docs.swift",
		"/// Original extension docs\nextension F {\n  func f() {}\n}\n",
		patch("docs.swift", "@@ /// Original extension docs\n+struct G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC15_POWERSHELL_FILTER_DOCS_CONTROL",
		EditMode::Patch,
		"docs.ps1",
		"# Original filter docs\nfilter F { $_ }\n",
		patch("docs.ps1", "@@ # Original filter docs\n+function G { 2 }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC16_CMAKE_FUNCTION_DOCS_CONTROL",
		EditMode::Patch,
		"CMakeLists.txt",
		"# Original function docs\nfunction(f)\n  message(STATUS \"old\")\nendfunction()\n",
		patch("CMakeLists.txt", "@@ # Original function docs\n+function(g)\n+endfunction()"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC17_NIX_FUNCTION_BINDING_DOCS_CONTROL",
		EditMode::Patch,
		"docs.nix",
		"{\n  # Original f docs\n  f = x: x;\n}\n",
		patch("docs.nix", "@@ # Original f docs\n+  g = x: x + 1;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC18_HCL_RESOURCE_DOCS",
		EditMode::Patch,
		"docs.tf",
		"# Original resource docs\nresource \"null_resource\" \"f\" {\n}\n",
		patch("docs.tf", "@@ # Original resource docs\n+resource \"null_resource\" \"g\" {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC19_TOML_TABLE_DOCS",
		EditMode::Patch,
		"docs.toml",
		"# Original table docs\n[f]\nvalue = 1\n",
		patch("docs.toml", "@@ # Original table docs\n+[g]\n+value = 2"),
		Want::BytesOrRefuse("# Original table docs\n[g]\nvalue = 2\n[f]\nvalue = 1\n".into()),
		f,
	)
	.await;
	p(
		"DC20_JS_UNARY_CLASS_NOT_DECL",
		EditMode::Patch,
		"ordinary.js",
		"// ordinary expression note\nvoid class F {};\n",
		patch("ordinary.js", "@@ // ordinary expression note\n+prepare();"),
		Want::Bytes("// ordinary expression note\nprepare();\nvoid class F {};\n".into()),
		f,
	)
	.await;
	p(
		"DC21_JS_TYPEOF_FUNCTION_NOT_DECL",
		EditMode::Patch,
		"ordinary.js",
		"// ordinary expression note\ntypeof function f() {};\n",
		patch("ordinary.js", "@@ // ordinary expression note\n+prepare();"),
		Want::Bytes("// ordinary expression note\nprepare();\ntypeof function f() {};\n".into()),
		f,
	)
	.await;
	p(
		"DC22_SWIFT_PROTOCOL_DOCS",
		EditMode::Patch,
		"docs.swift",
		"/// Original protocol docs\nprotocol F {\n  func f()\n}\n",
		patch("docs.swift", "@@ /// Original protocol docs\n+struct G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC23_SCALA_OBJECT_DOCS",
		EditMode::Patch,
		"docs.scala",
		"// Original object docs\nobject F { def f = 1 }\n",
		patch("docs.scala", "@@ // Original object docs\n+object G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC24_HASKELL_DATA_DOCS",
		EditMode::Patch,
		"docs.hs",
		"-- | Original data docs\ndata F = F Int\n",
		patch("docs.hs", "@@ -- | Original data docs\n+data G = G Int"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC25_HASKELL_NEWTYPE_DOCS",
		EditMode::Patch,
		"docs.hs",
		"-- | Original newtype docs\nnewtype F = F Int\n",
		patch("docs.hs", "@@ -- | Original newtype docs\n+newtype G = G Int"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC26_HASKELL_INSTANCE_DOCS",
		EditMode::Patch,
		"docs.hs",
		"data F = F\n-- | Original instance docs\ninstance Eq F where\n  F == F = True\n",
		patch("docs.hs", "@@ -- | Original instance docs\n+data G = G"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC27_OCAML_MODULE_DOCS",
		EditMode::Patch,
		"docs.ml",
		"(** Original module docs *)\nmodule F = struct let f = 1 end\n",
		patch("docs.ml", "@@ (** Original module docs *)\n+module G = struct end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC28_ELIXIR_DEFSTRUCT_DOCS",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  # Original struct docs\n  defstruct [:f]\nend\n",
		patch("docs.ex", "@@ # Original struct docs\n+  def g(), do: 2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC29_ELIXIR_DEFIMPL_DOCS",
		EditMode::Patch,
		"docs.ex",
		"# Original implementation docs\ndefimpl String.Chars, for: F do\n  def to_string(_), do: \
		 \"f\"\nend\n",
		patch("docs.ex", "@@ # Original implementation docs\n+defmodule G do\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC30_CLOJURE_PROTOCOL_DOCS",
		EditMode::Patch,
		"docs.clj",
		";; Original protocol docs\n(defprotocol F (f [this]))\n",
		patch("docs.clj", "@@ ;; Original protocol docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC31_BASH_FUNCTION_DOCS",
		EditMode::Patch,
		"docs.sh",
		"# Original function docs\nf() {\n  echo old\n}\n",
		patch("docs.sh", "@@ # Original function docs\n+g() { echo new; }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC32_PROTO_MESSAGE_DOCS",
		EditMode::Patch,
		"docs.proto",
		"syntax = \"proto3\";\n// Original message docs\nmessage F {}\n",
		patch("docs.proto", "@@ // Original message docs\n+message G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC33_PROTO_SERVICE_DOCS",
		EditMode::Patch,
		"docs.proto",
		"syntax = \"proto3\";\nmessage F {}\n// Original service docs\nservice S { rpc FCall (F) \
		 returns (F); }\n",
		patch("docs.proto", "@@ // Original service docs\n+service G { rpc GCall (F) returns (F); }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC34_PROTO_RPC_DOCS",
		EditMode::Patch,
		"docs.proto",
		"syntax = \"proto3\";\nmessage F {}\nservice S {\n  // Original rpc docs\n  rpc FCall (F) \
		 returns (F);\n}\n",
		patch("docs.proto", "@@ // Original rpc docs\n+  rpc GCall (F) returns (F);"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC35_GRAPHQL_TYPE_DOCS",
		EditMode::Patch,
		"docs.graphql",
		"# Original type docs\ntype F { value: Int }\n",
		patch("docs.graphql", "@@ # Original type docs\n+type G { value: Int }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC36_SOLIDITY_CONTRACT_DOCS",
		EditMode::Patch,
		"docs.sol",
		"/// Original contract docs\ncontract F {}\n",
		patch("docs.sol", "@@ /// Original contract docs\n+contract G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC37_SOLIDITY_EVENT_DOCS",
		EditMode::Patch,
		"docs.sol",
		"contract C {\n  /// Original event docs\n  event F(uint value);\n}\n",
		patch("docs.sol", "@@ /// Original event docs\n+  event G(uint value);"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC38_SOLIDITY_MODIFIER_DOCS",
		EditMode::Patch,
		"docs.sol",
		"contract C {\n  /// Original modifier docs\n  modifier f() { _; }\n}\n",
		patch("docs.sol", "@@ /// Original modifier docs\n+  modifier g() { _; }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC39_SQL_CREATE_DOCS",
		EditMode::Patch,
		"docs.sql",
		"-- Original table docs\nCREATE TABLE f (value INT);\n",
		patch("docs.sql", "@@ -- Original table docs\n+CREATE TABLE g (value INT);"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC40_ZIG_TEST_DOCS",
		EditMode::Patch,
		"docs.zig",
		"// Original test docs\ntest \"f\" {\n  const x = 1;\n  _ = x;\n}\n",
		patch("docs.zig", "@@ // Original test docs\n+test \"g\" {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC41_ODIN_PROCEDURE_DOCS",
		EditMode::Patch,
		"docs.odin",
		"package docs\n// Original procedure docs\nf :: proc() {}\n",
		patch("docs.odin", "@@ // Original procedure docs\n+g :: proc() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC42_FORTRAN_SUBROUTINE_DOCS",
		EditMode::Patch,
		"docs.f90",
		"! Original subroutine docs\nsubroutine f()\n  print *, 1\nend subroutine f\n",
		patch("docs.f90", "@@ ! Original subroutine docs\n+subroutine g()\n+end subroutine g"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC43_VERILOG_MODULE_DOCS",
		EditMode::Patch,
		"docs.v",
		"// Original module docs\nmodule f;\nendmodule\n",
		patch("docs.v", "@@ // Original module docs\n+module g;\n+endmodule"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC44_JUST_RECIPE_DOCS",
		EditMode::Patch,
		"justfile",
		"# Original recipe docs\nf:\n    echo old\n",
		patch("justfile", "@@ # Original recipe docs\n+g:\n+    echo new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC45_TS_OVERLOAD_DOCS",
		EditMode::Patch,
		"docs.ts",
		"/** Original overload docs */\nfunction f(x: string): string;\nfunction f(x: string) { \
		 return x; }\n",
		patch("docs.ts", "@@ /** Original overload docs */\n+function g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC46_TS_AMBIENT_DOCS",
		EditMode::Patch,
		"docs.ts",
		"/** Original ambient docs */\ndeclare function f(x: string): string;\n",
		patch("docs.ts", "@@ /** Original ambient docs */\n+declare function g(): void;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC47_TS_EXPORT_DEFAULT_DOCS",
		EditMode::Patch,
		"docs.ts",
		"/** Original default docs */\nexport default function f() {}\n",
		patch("docs.ts", "@@ /** Original default docs */\n+function g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC48_TS_DECORATOR_DOCS",
		EditMode::Patch,
		"docs.ts",
		"/** Original class docs */\n@decorator\nclass F {}\n",
		patch("docs.ts", "@@ /** Original class docs */\n+class G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC49_SWIFT_BLANK_FALLTHROUGH_DEFAULT",
		EditMode::Patch,
		"switch.swift",
		"func f(_ x: Int) {\n  switch x {\n  case 1:\n    target()\n  default:\n    other()\n  \
		 }\n}\n",
		patch("switch.swift", "@@ case 1:\n+\n+    fallthrough\n+  case 2:"),
		Want::Bytes(
			"func f(_ x: Int) {\n  switch x {\n  case 1:\n\n    fallthrough\n  case 2:\n    \
			 target()\n  default:\n    other()\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC50_SWIFT_NO_FALLTHROUGH_OWNER_CAPTURE",
		EditMode::Patch,
		"switch.swift",
		"func f(_ x: Int) {\n  switch x {\n  case 1:\n    target()\n  default:\n    other()\n  \
		 }\n}\n",
		patch("switch.swift", "@@ case 1:\n+  case 2:"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC51_CS_DEFAULT_CASE_REACH",
		EditMode::Patch,
		"switch.cs",
		"class C {\n  void F(int x) {\n    switch (x) {\n      default:\n        Target();\n        \
		 break;\n    }\n  }\n}\n",
		patch("switch.cs", "@@ default:\n+      case 2:"),
		Want::Bytes(
			"class C {\n  void F(int x) {\n    switch (x) {\n      default:\n      case 2:\n        \
			 Target();\n        break;\n    }\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC52_PY_MODULE_DOCSTRING_OWNER",
		EditMode::Patch,
		"docs.py",
		"# marker\n\"\"\"Original module docs\"\"\"\nx = 1\n",
		patch("docs.py", "@@ # marker\n+setup()"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC53_PY_CLASS_DOCSTRING_OWNER",
		EditMode::Patch,
		"docs.py",
		"class F:\n    # marker\n    \"\"\"Original class docs\"\"\"\n    x = 1\n",
		patch("docs.py", "@@ # marker\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC54_PY_DECORATED_ASYNC_DOCSTRING_OWNER",
		EditMode::Patch,
		"docs.py",
		"@decorator\nasync def f():\n    \"\"\"Original function docs\"\"\"\n    return 1\n",
		patch("docs.py", "@@ async def f():\n+    setup()"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC55_PY_WITH_LITERAL_NOT_DOCSTRING",
		EditMode::Patch,
		"ordinary.py",
		"with resource:\n    \"ordinary literal\"\n    run()\n",
		patch("ordinary.py", "@@ with resource:\n+    setup()"),
		Want::Bytes("with resource:\n    setup()\n    \"ordinary literal\"\n    run()\n".into()),
		f,
	)
	.await;
	p(
		"DC56_PY_EXCEPT_LITERAL_NOT_DOCSTRING",
		EditMode::Patch,
		"ordinary.py",
		"try:\n    run()\nexcept Error:\n    \"ordinary literal\"\n    recover()\n",
		patch("ordinary.py", "@@ except Error:\n+    setup()"),
		Want::Bytes(
			"try:\n    run()\nexcept Error:\n    setup()\n    \"ordinary literal\"\n    recover()\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC57_PY_BYTES_LITERAL_NOT_DOCSTRING",
		EditMode::Patch,
		"ordinary.py",
		"def f():\n    b\"ordinary literal\"\n    run()\n",
		patch("ordinary.py", "@@ def f():\n+    setup()"),
		Want::Bytes("def f():\n    setup()\n    b\"ordinary literal\"\n    run()\n".into()),
		f,
	)
	.await;
	p(
		"DC58_PY_FSTRING_LITERAL_NOT_DOCSTRING",
		EditMode::Patch,
		"ordinary.py",
		"def f():\n    f\"ordinary literal\"\n    run()\n",
		patch("ordinary.py", "@@ def f():\n+    setup()"),
		Want::Bytes("def f():\n    setup()\n    f\"ordinary literal\"\n    run()\n".into()),
		f,
	)
	.await;
	p(
		"DC59_JULIA_PAREN_LITERAL_DOCS",
		EditMode::Patch,
		"docs.jl",
		"(\"Original function docs\")\nfunction f()\n  return 1\nend\n",
		patch("docs.jl", "@@ (\"Original function docs\")\n+function g()\n+  return 2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC60_JULIA_TWO_STRING_DOCS",
		EditMode::Patch,
		"docs.jl",
		"\"First docs\"\n\"Original function docs\"\nfunction f()\n  return 1\nend\n",
		patch("docs.jl", "@@ \"Original function docs\"\n+function g()\n+  return 2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC61_LUA_LATER_BRANCH_OWNER_CAPTURE",
		EditMode::Patch,
		"branch.lua",
		"function f()\n  if ok then\n    -- leading comment\n    first()\n    second()\n  end\nend\n",
		patch("branch.lua", "@@ if ok then\n+    before()\n+  elseif other then"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC62_ELIXIR_MODULEDOC_NEW_FUNCTION",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  @moduledoc \"Original module docs\"\n  def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ @moduledoc \"Original module docs\"\n+  def g(), do: :new"),
		Want::Bytes(
			"defmodule M do\n  @moduledoc \"Original module docs\"\n  def g(), do: :new\n  def f(), \
			 do: :ok\nend\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC63_JUST_BRACKET_ATTR_CAPTURE",
		EditMode::Patch,
		"justfile",
		"[private]\nf:\n    echo old\n",
		patch("justfile", "@@ [private]\n+g:\n+    echo new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC64_ERLANG_SPEC_CAPTURE",
		EditMode::Patch,
		"docs.erl",
		"-module(docs).\n-spec f() -> integer().\nf() -> 1.\n",
		patch("docs.erl", "@@ -spec f() -> integer().\n+g() -> 2."),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC65_LUA_FUNCTION_SLOT_DOCS",
		EditMode::Patch,
		"docs.lua",
		"-- Original f docs\nM.f = function()\n  return 1\nend\n",
		patch("docs.lua", "@@ -- Original f docs\n+M.g = function() return 2 end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC66_CLOJURE_HEAD_META_DOCS",
		EditMode::Patch,
		"docs.clj",
		";; Original f docs\n(^:private defn f [] 1)\n",
		patch("docs.clj", "@@ ;; Original f docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC67_JULIA_STRING_MACRO_EVAL_CONTROL",
		EditMode::Patch,
		"ordinary.jl",
		"r\"ordinary\"\nx = 1\n",
		patch("ordinary.jl", "@@ r\"ordinary\"\n+prepare()"),
		Want::Bytes("r\"ordinary\"\nprepare()\nx = 1\n".into()),
		f,
	)
	.await;
	p(
		"DC68_JULIA_LITERAL_COMMENT_GAP_DOCS",
		EditMode::Patch,
		"docs.jl",
		"\"Original function docs\"\n# implementation note\nfunction f()\n  return 1\nend\n",
		patch("docs.jl", "@@ # implementation note\n+function g()\n+  return 2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC69_POWERSHELL_FUNCTION_DOCS",
		EditMode::Patch,
		"docs.ps1",
		"# Original function docs\nfunction F { 1 }\n",
		patch("docs.ps1", "@@ # Original function docs\n+function G { 2 }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC70_POWERSHELL_ENUM_DOCS",
		EditMode::Patch,
		"docs.ps1",
		"# Original enum docs\nenum F { First; Second }\n",
		patch("docs.ps1", "@@ # Original enum docs\n+enum G { Third }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC71_JUST_COMMENT_ATTR_RUN_CAPTURE",
		EditMode::Patch,
		"justfile",
		"# Original recipe docs\n[private]\nf:\n    echo old\n",
		patch("justfile", "@@ # Original recipe docs\n+g:\n+    echo new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC72_CLOJURE_QUOTED_FORM_IS_DATA",
		EditMode::Patch,
		"ordinary.clj",
		";; ordinary quoted value note\n'(defn f [] 1)\n",
		patch("ordinary.clj", "@@ ;; ordinary quoted value note\n+(prepare)"),
		Want::Bytes(";; ordinary quoted value note\n(prepare)\n'(defn f [] 1)\n".into()),
		f,
	)
	.await;
	p(
		"DC73_JS_CASE_COMMENT_REACH",
		EditMode::Patch,
		"switch.js",
		"function f(x) {\n  switch (x) {\n    case 1:\n      target();\n  }\n}\n",
		patch("switch.js", "@@ case 1:\n+    case 2: // same body"),
		Want::Bytes(
			"function f(x) {\n  switch (x) {\n    case 1:\n    case 2: // same body\n      \
			 target();\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC74_KOTLIN_SECONDARY_CONSTRUCTOR_DOCS",
		EditMode::Patch,
		"docs.kt",
		"class C {\n  /** Original constructor docs */\n  constructor(x: Int) {}\n}\n",
		patch("docs.kt", "@@ /** Original constructor docs */\n+  constructor(x: String) {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC75_HASKELL_FOREIGN_IMPORT_DOCS",
		EditMode::Patch,
		"docs.hs",
		"module Docs where\n-- | Original f docs\nforeign import ccall \"f\" f :: Int -> IO Int\n",
		patch("docs.hs", "@@ -- | Original f docs\n+foreign import ccall \"g\" g :: Int -> IO Int"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC76_ERLANG_OPAQUE_TYPE_DOCS",
		EditMode::Patch,
		"docs.erl",
		"-module(docs).\n%% Original f type docs\n-opaque f() :: integer().\n",
		patch("docs.erl", "@@ %% Original f type docs\n+-opaque g() :: integer()."),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC77_SCALA_PACKAGE_OBJECT_DOCS",
		EditMode::Patch,
		"docs.scala",
		"/** Original package docs */\npackage object original { val value = 1 }\n",
		patch("docs.scala", "@@ /** Original package docs */\n+object G {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"DC78_HCL_RESOURCE_SIBLING_AFTER_BINDING",
		EditMode::Patch,
		"ordinary.tf",
		"marker = 1\n\nresource \"null_resource\" \"f\" {\n}\n",
		patch("ordinary.tf", "@@ marker = 1\n+resource \"null_resource\" \"g\" {}"),
		Want::Bytes(
			"marker = 1\nresource \"null_resource\" \"g\" {}\n\nresource \"null_resource\" \"f\" \
			 {\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"DC79_HCL_RESOURCE_SIBLING_COMMENT_BLANK",
		EditMode::Patch,
		"ordinary.tf",
		"# marker\n\nresource \"null_resource\" \"f\" {\n}\n",
		patch("ordinary.tf", "@@ # marker\n+resource \"null_resource\" \"g\" {}"),
		Want::Bytes(
			"# marker\nresource \"null_resource\" \"g\" {}\n\nresource \"null_resource\" \"f\" {\n}\n"
				.into(),
		),
		f,
	)
	.await;
	// INSERTION_ROWS
	assert!(fails.is_empty(), "insertion placement failures: {fails:?}");
}

async fn run(label: &str, path: &str, source: &str, edits: Value, expected: Option<&str>) {
	let ws = Workspace::new(EditMode::Patch);
	ws.write(path, source);
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(&json!({"path":path,"edits":edits}), &writer)
		.await;
	if let Some(expected) = expected {
		assert!(result.is_ok(), "{label}: {result:?}");
		assert_eq!(ws.read(path).unwrap(), expected, "{label}");
		assert_eq!(writer.requests.lock().len(), 1, "{label}");
	} else {
		assert!(result.is_err(), "{label}: {result:?}");
		assert_eq!(ws.read(path).unwrap(), source, "{label}");
		assert_eq!(writer.requests.lock().len(), 0, "{label}");
	}
	println!("PASS payload_boundary {label}");
}
fn update(diff: &str) -> Value {
	json!([{"op":"update","diff":diff}])
}
#[tokio::test]
async fn independent_and_selected_payloads() {
	let source = "<script lang=\"coffee\">unrelated + preserve()</script>\n<script>const value = \
	              old + keep();</script>\n";
	run(
		"unknown_independent",
		"s.html",
		source,
		update("@@\n-old\n+fresh"),
		Some(&source.replace("old", "fresh")),
	)
	.await;
	run("unknown_affected", "s.html", source, update("@@\n-unrelated\n+new"), None).await;
	let source = "<script lang=\"coffee\">\nfunction f() {\n  keep();\n}\n</script>\n";
	run("unknown_internal_anchor", "s.html", source, update("@@ function f() {\n+  setup();"), None)
		.await;
	let source = "<style>.a { color: red; padding: 0; }\n.b { color: blue; }</style>\n";
	run(
		"style_safe",
		"s.html",
		source,
		update("@@\n-red\n+green"),
		Some(&source.replace("red", "green")),
	)
	.await;
	let source = "<script>\nfunction f()\n{\n  keep();\n}\n</script>\n";
	run(
		"mapped_body_insertion",
		"s.html",
		source,
		update("@@ function f()\n+  setup();"),
		Some("<script>\nfunction f()\n{\n  setup();\n  keep();\n}\n</script>\n"),
	)
	.await;
	let source = "<div>{ old + keep() }</div>\n";
	run(
		"svelte_expression_safe",
		"s.svelte",
		source,
		update("@@\n-old\n+fresh"),
		Some("<div>{ fresh + keep() }</div>\n"),
	)
	.await;
	run("svelte_expression_capture", "s.svelte", source, update("@@\n-old\n+0 //"), None).await;
	let source = "<script lang=\"ts\">\nconst value = old + keep();\n</script>\n";
	run(
		"lang_change_blocks_stale_tree",
		"s.html",
		source,
		json!([
			 {"op":"update","diff":"@@\n-<script lang=\"ts\">\n+<script lang=\"coffee\">"},
			 {"op":"update","diff":"@@\n-old\n+new"}
		]),
		None,
	)
	.await;
	let source = source.replace("\"ts\"", "\"coffee\"");
	run(
		"lang_change_enables_new_tree",
		"s.html",
		&source,
		json!([
			 {"op":"update","diff":"@@\n-<script lang=\"coffee\">\n+<script lang=\"js\">"},
			 {"op":"update","diff":"@@\n-old\n+fresh"}
		]),
		Some("<script lang=\"js\">\nconst value = fresh + keep();\n</script>\n"),
	)
	.await;
}
#[tokio::test]
async fn make_selector_order_and_uncertainty() {
	let source = "VALUE != printf \"old$$KEEP\"\nSHELL := /bin/custom\nall:\n\tother\n";
	run(
		"make_immediate_before_custom",
		"Makefile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
	let source = "VALUE := $(shell printf \"old$$KEEP\")\nSHELL := /bin/custom\nall:\n\tother\n";
	run(
		"make_immediate_function_before_custom",
		"Makefile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
	let source = "all:\n\tprintf \"old$$KEEP\"\nSHELL := /bin/custom\n";
	run("make_recipe_uses_final_shell", "Makefile", source, update("@@\n-old\n+new"), None).await;
	let source = "SHELL := /bin/custom\nSHELL ?= /bin/bash\nall:\n\tprintf \"old$$KEEP\"\n";
	run("make_conditional_shell_unknown", "Makefile", source, update("@@\n-old\n+new"), None).await;
	let source = ".RECIPEPREFIX := >\n.RECIPEPREFIX ?= \nall:\n>printf \"old$$KEEP\"\n";
	run("make_conditional_prefix_unknown", "Makefile", source, update("@@\n-old\n+new\\"), None)
		.await;
	let source =
		".RECIPEPREFIX := >\nall:\n>printf \"old$$KEEP\"\n.RECIPEPREFIX := \nother:\n\tprintf keep\n";
	run("make_prefix_source_order", "Makefile", source, update("@@\n-old\n+new\\"), None).await;
}

#[tokio::test]
async fn docker_typed_execution_forms() {
	let source =
		"FROM alpine\nRUN --mount=type=cache,target=/tmp if true; then printf \"old$KEEP\"; fi\n";
	run(
		"docker_option_compound_safe",
		"Dockerfile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
	let source = "FROM alpine\nRUN [\"printf\", \"\\u0041KEEP\"]\n";
	run("docker_json_escape_payload", "Dockerfile", source, update("@@\n-\\u00\n+\\u01"), None)
		.await;
	let source = "FROM alpine\nRUN [\"printf\", \"oldnKEEP\"]\n";
	run("docker_json_created_escape", "Dockerfile", source, update("@@\n-old\n+new\\"), None).await;
	let source = "FROM alpine\nSHELL [\"custom-shell\", \"-c\"]\nRUN [\"printf\", \"old$KEEP\"]\n";
	run(
		"docker_json_independent_shell",
		"Dockerfile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
	let source = "# escape=`\nFROM alpine\nRUN printf old`\n  $KEEP\n";
	run(
		"docker_unknown_escape_complete_frame",
		"Dockerfile",
		source,
		update("@@\n-old\n+new"),
		None,
	)
	.await;
	for instruction in ["RUN <<EOF", "RUN cat <<EOF"] {
		let source = format!("FROM alpine\n{instruction}\nprintf \"old\\\nKEEP\"\nEOF\n");
		run("docker_heredoc_escape_rebound", "Dockerfile", &source, update("@@\n-old\n+new\\"), None)
			.await;
	}
	let source = "FROM alpine AS first\nSHELL [\"custom-shell\", \"-c\"]\nFROM \
	              --platform=windows/amd64 mcr.microsoft.com/windows/nanoserver:ltsc2022\nRUN echo \
	              old& echo KEEP\n";
	run("docker_windows_default_unknown", "Dockerfile", source, update("@@\n-old\n+new^"), None)
		.await;
	let source = "FROM --platform=windows/amd64 base\nRUN [\"printf\", \"oldKEEP\"]\n";
	run(
		"docker_windows_json_safe",
		"Dockerfile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
	let source = "FROM --platform=linux alpine\nRUN printf \"old$KEEP\"\n";
	run(
		"docker_linux_os_only",
		"Dockerfile",
		source,
		update("@@\n-old\n+new"),
		Some(&source.replace("old", "new")),
	)
	.await;
}

#[tokio::test]
async fn raw_yaml_scalar_dialects() {
	for marker in ["|-", ">-"] {
		let source = format!("value: {marker}\n  oldKEEP\nother: 1\n");
		run(
			"yaml_raw_scalar",
			"s.yaml",
			&source,
			update("@@\n-old\n+new\\"),
			Some(&source.replace("old", "new\\")),
		)
		.await;
	}
	let source = "value: \"oldnKEEP\"\nother: 1\n";
	run("yaml_cooked_capture", "s.yaml", source, update("@@\n-old\n+new\\"), None).await;
	let source = "value: oldtrue\nother: 1\n";
	run("yaml_plain_type_capture", "s.yaml", source, update("@@\n-old\n+"), None).await;
	let source = "value: oldKEEP\nother: 1\n";
	run(
		"yaml_plain_raw_safe",
		"s.yaml",
		source,
		update("@@\n-old\n+new\\"),
		Some(&source.replace("old", "new\\")),
	)
	.await;
	let source = "value: 'old''KEEP'\nother: 1\n";
	run(
		"yaml_doubled_quote_safe",
		"s.yaml",
		source,
		update("@@\n-old\n+fresh"),
		Some(&source.replace("old", "fresh")),
	)
	.await;
}

#[tokio::test]
async fn registered_raw_literal_dialects() {
	for (path, source) in [
		("s.cs", "class C { string value = @\"oldKEEP\"; }\n"),
		("s.cpp", "auto value = R\"(oldKEEP)\";\n"),
		("s.go", "package p\nvar value = `oldKEEP`\n"),
		("s.swift", "let value = #\"oldKEEP\"#\n"),
		("s.cs", "class C { string value = @\"old\"\"KEEP\"; }\n"),
		("s.cs", "class C { string value = \"\"\"oldKEEP\"\"\"; }\n"),
		("s.scala", "object C { val value = \"\"\"oldKEEP\"\"\" }\n"),
		("s.kt", "val value = \"\"\"oldKEEP\"\"\"\n"),
	] {
		run(
			"raw_literal_safe",
			path,
			source,
			update("@@\n-old\n+new\\"),
			Some(&source.replace("old", "new\\")),
		)
		.await;
	}
	let source = "class C { string value = \"oldnKEEP\"; }\n";
	run("csharp_cooked_capture", "s.cs", source, update("@@\n-old\n+new\\"), None).await;
	let source = "let value = #\"old#nKEEP\"#\n";
	run("swift_hash_escape_capture", "s.swift", source, update("@@\n-old\n+new\\"), None).await;
	let source = "class C { string value = @\"old\"\"KEEP\"; }\n";
	run("verbatim_doubled_quote_rebound", "s.cs", source, update("@@\n-old\"\n+fresh"), None).await;
}

#[tokio::test]
async fn continuation_and_composed_payload_obligations() {
	let source = "all:\n\techo old\\\n\t@#KEEP\n";
	run("make_continuation_flags_are_data", "Makefile", source, update("@@\n-old\n+new "), None)
		.await;
	run(
		"make_continuation_flags_remain_word_data",
		"Makefile",
		source,
		update("@@\n-old\n+new"),
		Some("all:\n\techo new\\\n\t@#KEEP\n"),
	)
	.await;
	let source = ".ONESHELL:\nall:\n\techo \\\\\n\t@#KEEP\n";
	run(
		"oneshell_even_backslashes_strip_flags",
		"Makefile",
		source,
		update("@@\n-@\n+"),
		Some(".ONESHELL:\nall:\n\techo \\\\\n\t#KEEP\n"),
	)
	.await;
	let source = "all:\n\techo marker\n\techo target\n";
	run(
		"make_inter_invocation_gap",
		"Makefile",
		source,
		update("@@\n \techo marker\n+\techo before"),
		Some("all:\n\techo marker\n\techo before\n\techo target\n"),
	)
	.await;
	let source = ".ONESHELL:\nall:\n\techo marker\n\techo target\n";
	run(
		"oneshell_internal_gap",
		"Makefile",
		source,
		update("@@\n \techo marker\n+\techo before"),
		Some(".ONESHELL:\nall:\n\techo marker\n\techo before\n\techo target\n"),
	)
	.await;
	run(
		"oneshell_capture_original_command",
		"Makefile",
		source,
		update("@@\n \techo marker\n+\tif true; then"),
		None,
	)
	.await;
	let source = "<script type=\"text/plain\">\nfirst\nsecond\n</script>\n";
	run(
		"data_script_leading_gap",
		"s.html",
		source,
		update("@@\n first\n+new"),
		Some("<script type=\"text/plain\">\nfirst\nnew\nsecond\n</script>\n"),
	)
	.await;
	run("data_script_envelope_capture", "s.html", source, update("@@\n first\n+</script>"), None)
		.await;
	for (path, source) in [
		("s.py", "value = \"\"\"oldnKEEP\"\"\"\n"),
		("s.java", "class C { String value = \"\"\"\noldnKEEP\n\"\"\"; }\n"),
		("s.jl", "value = \"\"\"oldnKEEP\"\"\"\n"),
	] {
		run("ordinary_cooked_triple_capture", path, source, update("@@\n-old\n+new\\"), None).await;
	}
	let source = "<p>{\n(() => {\n  marker();\n  target();\n})()\n}</p>\n";
	run(
		"svelte_synthetic_wrapper_internal_gap",
		"s.svelte",
		source,
		update("@@\n   marker();\n+  before();"),
		Some("<p>{\n(() => {\n  marker();\n  before();\n  target();\n})()\n}</p>\n"),
	)
	.await;
	let source = "function f(ok) {\n  if (ok) {\n    before();\n    target();\n  }\n}\n";
	run(
		"retained_diff_pivot_is_not_trailing_authority",
		"s.js",
		source,
		update(
			"@@\n   if (ok) {\n-    before();\n-    target();\n+    before(1);\n+  } else {\n+    \
			 target();",
		),
		None,
	)
	.await;
	run(
		"genuine_trailing_context_authorizes_branch",
		"s.js",
		source,
		update("@@\n   if (ok) {\n-    before();\n+    before(1);\n+  } else {\n     target();"),
		Some("function f(ok) {\n  if (ok) {\n    before(1);\n  } else {\n    target();\n  }\n}\n"),
	)
	.await;
	for path in ["s.html", "s.vue", "s.svelte"] {
		let source = "<script>\nfunction f(ok) {\n  if (ok) {\n    target();\n  }\n}\n</script>\n";
		run(
			"inner_context_else_capture",
			path,
			source,
			update("@@\n   if (ok) {\n+    before();\n+  } else {"),
			None,
		)
		.await;
		let source = "<script>\n/** Original f docs */\nfunction f() {}\n</script>\n";
		run(
			"inner_context_doc_capture",
			path,
			source,
			update("@@\n /** Original f docs */\n+function g() {}"),
			None,
		)
		.await;
		run(
			"inner_context_explicit_trailing",
			path,
			source,
			update("@@\n /** Original f docs */\n+function g() {}\n function f() {}"),
			Some("<script>\n/** Original f docs */\nfunction g() {}\nfunction f() {}\n</script>\n"),
		)
		.await;
		let source = "<style>\n.a { color: red; }</style>\n<p>keep</p>\n";
		run(
			"host_gap_after_style",
			path,
			source,
			update("@@\n .a { color: red; }</style>\n+<p>new</p>"),
			Some("<style>\n.a { color: red; }</style>\n<p>new</p>\n<p>keep</p>\n"),
		)
		.await;
		let source = "<script>\nconst value=1;</script>\n<p>keep</p>\n";
		run(
			"host_gap_after_script",
			path,
			source,
			update("@@\n const value=1;</script>\n+<p>new</p>"),
			Some("<script>\nconst value=1;</script>\n<p>new</p>\n<p>keep</p>\n"),
		)
		.await;
	}
}

#[tokio::test]
async fn duplicate_executable_type_cannot_be_downgraded_to_data() {
	let source =
		"<script type=\"text/javascript\" type=\"text/plain\">const value = old + keep()</script>\n";
	let ws = Workspace::new(EditMode::Patch);
	ws.write("s.html", source);
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(
			&json!({"path":"s.html","edits":[{"op":"update","diff":"@@\n-old\n+0 //"}]}),
			&writer,
		)
		.await;
	assert!(result.is_err());
	assert_eq!(writer.requests.lock().len(), 0);
	assert_eq!(ws.read("s.html").unwrap(), source);
}
#[tokio::test]
async fn duplicate_data_type_is_still_data() {
	let source =
		"<script type=\"text/plain\" type=\"text/javascript\">const value = old + keep()</script>\n";
	let ws = Workspace::new(EditMode::Patch);
	ws.write("s.html", source);
	let writer = DiskWriter::default();
	ws.apply_json(
		&json!({"path":"s.html","edits":[{"op":"update","diff":"@@\n-old\n+0 //"}]}),
		&writer,
	)
	.await
	.unwrap();
	assert_eq!(writer.requests.lock().len(), 1);
	assert_eq!(ws.read("s.html").unwrap(), source.replace("old", "0 //"));
}
#[tokio::test]
async fn first_empty_or_unknown_selector_remains_authoritative() {
	for attributes in
		["type type=\"text/plain\"", "type=\"\" type=\"text/plain\"", "lang=\"coffee\" lang=\"js\""]
	{
		let source = format!("<script {attributes}>const value = old + keep()</script>\n");
		let ws = Workspace::new(EditMode::Patch);
		ws.write("s.html", &source);
		let writer = DiskWriter::default();
		let result = ws
			.apply_json(
				&json!({"path":"s.html","edits":[{"op":"update","diff":"@@\n-old\n+0 //"}]}),
				&writer,
			)
			.await;
		assert!(result.is_err(), "{attributes}: {result:?}");
		assert_eq!(writer.requests.lock().len(), 0);
		assert_eq!(ws.read("s.html").unwrap(), source);
	}
}

#[tokio::test]
async fn cached_scope_and_lexical_answers_preserve_real_outcomes() {
	let mut fails = Vec::new();
	p(
		"genuine_blank_rows_are_not_zero_rows",
		EditMode::Patch,
		"blank.txt",
		"\n\n",
		patch("blank.txt", "@@\n+X"),
		Want::Bytes("\n\nX\n".into()),
		&mut fails,
	)
	.await;
	let mut labels = String::new();
	let mut noops = String::new();
	for i in 0..32 {
		writeln!(labels, "label_{i}:").unwrap();
		writeln!(noops, "@@ label_{i}:\n-label_{i}:\n+label_{i}:").unwrap();
	}
	let source =
		format!("<?php\nfunction f() {{\n{labels}  while ($ready) {{\n    notify($x);\n  }}\n}}\n");
	p(
		"label_run_anchored_noops",
		EditMode::Patch,
		"labels.php",
		&source,
		patch("labels.php", &noops),
		Want::Bytes(source.clone()),
		&mut fails,
	)
	.await;
	let source = format!("<?php\n{labels}echo 1;\n");
	p(
		"label_run_without_terminal_block",
		EditMode::Patch,
		"labels.php",
		&source,
		patch("labels.php", &noops),
		Want::Bytes(source.clone()),
		&mut fails,
	)
	.await;
	let source = format!(
		"<?php\nfunction f() {{\n{labels}  while ($ready) {{\n    notify($x);\n    broken = = 1;\n  \
		 }}\n}}\nfunction g() {{\n    notify($x);\n}}\n"
	);
	p(
		"uncertain_label_owner_cannot_select_other_function",
		EditMode::Patch,
		"labels.php",
		&source,
		patch("labels.php", "@@ label_0:\n-    notify($x);\n+    notify($y);"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	for (file, source) in [
		("escaped.js", "const value = \"old\\nKEEP\";\n"),
		("escaped.json", "{\"value\": \"old\\u0041KEEP\"}\n"),
		("escaped.py", "value = \"old\\123KEEP\"\n"),
	] {
		p(
			"unchanged_complete_escape_survives",
			EditMode::Patch,
			file,
			source,
			patch(file, "@@\n-old\n+new"),
			Want::Bytes(source.replace("old", "new")),
			&mut fails,
		)
		.await;
	}
	let mut unknown = String::new();
	for i in 0..24 {
		writeln!(unknown, "<script lang=\"coffee\">unknown_{i} KEEP</script>").unwrap();
	}
	let source = format!("{unknown}<script>const value = old + keep()</script>\n{unknown}");
	p(
		"independent_unknown_frames_around_supported_change",
		EditMode::Patch,
		"frames.html",
		&source,
		patch("frames.html", "@@\n-old\n+fresh"),
		Want::Bytes(source.replace("old", "fresh")),
		&mut fails,
	)
	.await;
	let mut noops_source = String::new();
	let mut noops = String::new();
	for i in 0..48 {
		writeln!(noops_source, "const value_{i} = compute({i});").unwrap();
		writeln!(
			noops,
			"@@ const value_{i} = compute({i});\n-const value_{i} = compute({i});\n+const value_{i} \
			 = compute({i});"
		)
		.unwrap();
	}
	p(
		"unique_anchor_noops",
		EditMode::Patch,
		"anchors.js",
		&noops_source,
		patch("anchors.js", &noops),
		Want::Bytes(noops_source.clone()),
		&mut fails,
	)
	.await;
	for file in ["ambiguous.js", "ambiguous.txt"] {
		let mut source = String::new();
		for i in 0..48 {
			writeln!(source, "function f_{i}() {{\n  notify(x);\n}}").unwrap();
		}
		p(
			"distinct_owners_cannot_break_equal_target_rank",
			EditMode::Patch,
			file,
			&source,
			patch(file, "@@\n-notify(x);\n+notify(y);"),
			Want::Refuse,
			&mut fails,
		)
		.await;
	}
	for punctuation in [false, true] {
		let extra = if punctuation {
			"a! ".repeat(24)
		} else {
			"word ".repeat(24)
		};
		let mut source = String::new();
		for i in 0..128 {
			writeln!(source, "Paragraph {i} {extra}").unwrap();
			if i % 32 == 0 {
				source.push_str("- Fixed a bug.\n");
			}
		}
		p(
			"markdown_width_and_token_ambiguity",
			EditMode::Patch,
			"target.md",
			&source,
			patch("target.md", "@@\n-- Fixed a bug.\n+- Fixed the bug."),
			Want::Refuse,
			&mut fails,
		)
		.await;
	}
	assert!(fails.is_empty(), "cached placement failures: {fails:?}");
}

#[tokio::test]
async fn anchor_case_evidence_keeps_construct_and_body_identity() {
	let mut fails = Vec::new();
	let source = "function f() {\n  keep();\n}\nfunction g() {\n  keep();\n}\n";
	p(
		"anchor_case_unique_whitespace",
		EditMode::Patch,
		"case.js",
		source,
		patch("case.js", "@@ \tFUNCTION   f() {\n-  keep();\n+  changed();"),
		Want::Bytes("function f() {\n  changed();\n}\nfunction g() {\n  keep();\n}\n".to_owned()),
		&mut fails,
	)
	.await;
	let repeated = "function f() {\n  first();\n}\nfunction F() {\n  second();\n}\n";
	for (label, diff) in [
		("anchor_case_repeated", "@@ FUNCTION f() {\n-  first();\n+  changed();"),
		("anchor_case_repeated_hint", "@@ -1,2 +1,2 @@ FUNCTION f() {\n-  first();\n+  changed();"),
		(
			"anchor_case_repeated_context",
			"@@ FUNCTION f() {\n function f() {\n-  first();\n+  changed();\n }",
		),
	] {
		p(
			label,
			EditMode::Patch,
			"case.js",
			repeated,
			patch("case.js", diff),
			Want::Refuse,
			&mut fails,
		)
		.await;
	}
	p(
		"anchor_case_body_tiers_unchanged",
		EditMode::Patch,
		"case.js",
		"function f() {\n  lowercasewordonly();\n}\n",
		patch("case.js", "@@ FUNCTION f() {\n-  LOWERCASEWORDONLY();\n+  changed();"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "anchor-only case evidence: {fails:?}");
}

#[tokio::test]
async fn known_unexecuted_data_preserves_anchored_gaps() {
	let source = "FROM alpine\nCOPY <<EOF /dest\nmarker\nold\nEOF\n";
	let expected = "FROM alpine\nCOPY <<EOF /dest\nmarker\nnew\nold\nEOF\n";
	let mut fails = Vec::new();
	for mode in [EditMode::Patch, EditMode::ApplyPatch] {
		let ws = Workspace::new(mode);
		ws.write("Dockerfile", source);
		let writer = DiskWriter::default();
		let result = match mode {
			EditMode::Patch => {
				ws.apply_json(&patch("Dockerfile", "@@ marker\n+new"), &writer)
					.await
			},
			EditMode::ApplyPatch => {
				ws.apply_raw(
					"*** Begin Patch\n*** Update File: Dockerfile\n@@ marker\n+new\n*** End Patch",
					&writer,
				)
				.await
			},
			_ => unreachable!(),
		}
		.map(|_| ())
		.map_err(|error| error.to_string());
		let writes = writer.requests.lock().len();
		let after = ws.read("Dockerfile").unwrap();
		let ok = result.is_ok() && writes == 1 && after == expected;
		println!(
			"{} known_data_gap_{mode:?}: result={result:?} writes={writes} after={after:?}",
			if ok { "PASS" } else { "FAIL" }
		);
		if !ok {
			fails.push(mode);
		}
	}
	assert!(fails.is_empty(), "{fails:?}");
}

#[tokio::test]
async fn preserved_host_activation_controls() {
	run(
		"make_commented_shell_function_stays_inactive",
		"Makefile",
		"VALUE=old#$(shell printf KEEP)\nall:\n\t@echo $(VALUE)\n",
		update("@@\n-VALUE=old#\n+VALUE=new"),
		None,
	)
	.await;
	for source in ["VALUE != printf old#; touch KEEP\n", "VALUE != printf 'old#'; touch KEEP\n"] {
		run(
			"make_immediate_assignment_comment_stays_inactive",
			"Makefile",
			source,
			update("@@\n-old#\n+new"),
			None,
		)
		.await;
	}
	run(
		"make_immediate_assignment_safe_value",
		"Makefile",
		"VALUE != printf old#; touch KEEP\n",
		update("@@\n-old\n+new"),
		Some("VALUE != printf new#; touch KEEP\n"),
	)
	.await;
	run(
		"make_active_shell_function_safe_value",
		"Makefile",
		"VALUE=$(shell printf 'oldKEEP')\nall:\n\t@echo $(VALUE)\n",
		update("@@\n-old\n+new"),
		Some("VALUE=$(shell printf 'newKEEP')\nall:\n\t@echo $(VALUE)\n"),
	)
	.await;
	run(
		"make_escaped_comment_marker_remains_escaped",
		"Makefile",
		"VALUE=old\\#KEEP\n",
		update("@@\n-old\n+new"),
		Some("VALUE=new\\#KEEP\n"),
	)
	.await;
	let source = "# escape=`\nFROM alpine\nWORKDIR /old$KEEP\n";
	run("docker_selected_escape_capture", "Dockerfile", source, update("@@\n-/old\n+/new`"), None)
		.await;
	run(
		"docker_selected_escape_safe_value",
		"Dockerfile",
		source,
		update("@@\n-/old\n+/new"),
		Some("# escape=`\nFROM alpine\nWORKDIR /new$KEEP\n"),
	)
	.await;
	run(
		"docker_selected_even_escape_keeps_expansion",
		"Dockerfile",
		"# escape=`\nFROM alpine\nWORKDIR /old``$KEEP\n",
		update("@@\n-/old\n+/new"),
		Some("# escape=`\nFROM alpine\nWORKDIR /new``$KEEP\n"),
	)
	.await;
	let json_source = "# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"oldnKEEP\"]\n";
	run(
		"docker_json_retains_json_escape_dialect",
		"Dockerfile",
		json_source,
		update("@@\n-old\n+new\\"),
		None,
	)
	.await;
	run(
		"docker_json_safe_value_with_host_escape",
		"Dockerfile",
		json_source,
		update("@@\n-old\n+new"),
		Some("# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"newnKEEP\"]\n"),
	)
	.await;
	run(
		"docker_json_backtick_is_literal_data",
		"Dockerfile",
		"# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"old`KEEP\"]\n",
		update("@@\n-old\n+new"),
		Some("# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"new`KEEP\"]\n"),
	)
	.await;
	run(
		"docker_json_new_backtick_is_literal_data",
		"Dockerfile",
		"# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"oldKEEP\"]\n",
		update("@@\n-old\n+new`"),
		Some("# escape=`\nFROM alpine\nSHELL [\"/bin/bash\", \"-c\", \"new`KEEP\"]\n"),
	)
	.await;
	run(
		"docker_copy_data_anchor",
		"Dockerfile",
		"FROM alpine\nCOPY <<EOF /dest\nmarker\nold\nEOF\n",
		update("@@ marker\n-old\n+new"),
		Some("FROM alpine\nCOPY <<EOF /dest\nmarker\nnew\nEOF\n"),
	)
	.await;
}

#[tokio::test]
async fn insertion_effect_isolation_preserves_strict_ownership() {
	run(
		"authored_deletion_is_not_an_insertion_effect",
		"target.md",
		"aa\n    bb\ncc",
		update("@@\n-aa\n     bb\n+    0"),
		Some("    bb\n    0\ncc"),
	)
	.await;
	run(
		"blank_insertion_cannot_capture_lazy_continuation",
		"target.md",
		"Intro\n    lazy\nNext",
		update("@@ Intro\n+"),
		None,
	)
	.await;
	run(
		"unindented_insertion_cannot_turn_untouched_code_into_prose",
		"target.md",
		"    aa\n    aa\n    bb\ncc\ndd",
		update("@@\n-    aa\n     aa\n+0"),
		None,
	)
	.await;
}

#[tokio::test]
async fn isolated_insertions_follow_surviving_attachment_owners() {
	let mut fails = Vec::new();
	both(
		"authored_declaration_rewrite_removes_its_attachment_obligation",
		"s.js",
		"function f() {\n /** h docs */\n function h() {}\n}\n",
		"@@ /** h docs */\n+ function g() {}",
		"@@\n- function h() {}\n+ return;",
		Want::Bytes("function f() {\n /** h docs */\n function g() {}\n return;\n}\n".into()),
		&mut fails,
	)
	.await;
	both(
		"independent_scope_endpoints_include_every_insertion_run",
		"s.js",
		"function f() {\n  keepF();\n}\nfunction g() {\n  keepG();\n}\n",
		"@@\n function f() {\n+  first();",
		"@@\n function g() {\n+  second();",
		Want::Bytes(
			"function f() {\n  first();\n  keepF();\n}\nfunction g() {\n  second();\n  keepG();\n}\n"
				.into(),
		),
		&mut fails,
	)
	.await;
	for (label, file, source, expected) in [
		(
			"errorful_native_counterfactual_uses_original_proof",
			"s.js",
			"const x = 1;\nkeep();\n",
			"const x = (\n1);\nkeep();\n",
		),
		(
			"errorful_payload_counterfactual_uses_original_proof",
			"doc.html",
			"<script>\nconst x = 1;\nkeep();\n</script>\n",
			"<script>\nconst x = (\n1);\nkeep();\n</script>\n",
		),
	] {
		both(
			label,
			file,
			source,
			"@@ const x = 1;\n+1);",
			"@@\n-const x = 1;\n+const x = (",
			Want::Bytes(expected.into()),
			&mut fails,
		)
		.await;
	}
	assert!(fails.is_empty(), "{fails:?}");
}

#[tokio::test]
async fn isolated_eof_insertions_keep_terminal_newline_policy() {
	for ending in ["", "\n"] {
		let source = format!("const x = 1;{ending}");
		let expected = format!("const x = 1;\nconst y = 2;{ending}");
		run(
			"eof_code_insertion",
			"s.js",
			&source,
			update("@@ const x = 1;\n+const y = 2;"),
			Some(&expected),
		)
		.await;
	}
}

#[tokio::test]
async fn opaque_data_prefixes_keep_token_and_container_identity() {
	run(
		"punctuation_free_opaque_data_content",
		"d.md",
		"# Usage\nRun the tool\n",
		update("@@ # Usage\n+First install it"),
		Some("# Usage\nFirst install it\nRun the tool\n"),
	)
	.await;
}
