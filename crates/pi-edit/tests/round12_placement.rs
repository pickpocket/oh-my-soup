//! Round-12 placement regressions: byte preservation, zero-write refusals and
//! order independence.
mod common;

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

			Want::BytesAnyOrRefuse(bs) => refused_clean || (r.is_ok() && bs.iter().any(|b| a == b)),
		}
	};
	let ok = same && meets(&r1, w1, &a1) && meets(&r2, w2, &a2);
	let show = |r: &Result<(), String>, a: &str| match r {
		Ok(()) => format!("Ok {a:?}"),
		Err(e) => {
			let cut = e.char_indices().rev().nth(199).map_or(0, |(at, _)| at);
			format!("Err({:?})", &e[cut..])
		},
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
async fn round12_multihunk() {
	let mut fails = Vec::new();
	let f = &mut fails;
	both(
		"M1_N_TO_ONE_CONTEXT_ALIAS",
		"adj.txt",
		"a\nb\nc\nd\n",
		"@@\n a\n+bump\n b",
		"@@\n-b\n-c\n+B",
		Want::Bytes("a\nbump\nB\nd\n".into()),
		f,
	)
	.await;
	both(
		"M2_ONE_TO_N_CONTEXT_ALIAS",
		"adj.txt",
		"a\nb\nc\nd\n",
		"@@\n a\n+bump\n b",
		"@@\n-b\n+B\n+extra",
		Want::Bytes("a\nbump\nB\nextra\nc\nd\n".into()),
		f,
	)
	.await;
	p(
		"M3_NO_NEWLINE_EMPTY_ROWS",
		EditMode::Patch,
		"eof.txt",
		"a",
		patch("eof.txt", "@@\n a\n+X\n+\n+"),
		Want::Bytes("a\nX".into()),
		f,
	)
	.await;
	{
		let best = "let total_value = compute_total(items, rate);";
		let lower = "let total_value = compute_total(itemz, rate);";
		let query = "let total_value = compute_total(items, rates);";
		let original = format!("[a]\n{best}\nend\n[b]\nother\nendb\n");
		let first = format!(
			"@@\n [a]\n-{best}\n+gone\n end\n [b]\n other\n+{lower}\n endb\n@@\n endb\n+{best}"
		);
		let second = format!("@@\n-{query}\n+let replacement = 0;\n@@\n-endb\n+endb");
		let reversed = |diff: &str| {
			let (a, b) = diff.split_once("\n@@").unwrap();
			format!("@@{b}\n{a}")
		};
		for first in [&first, &reversed(&first)] {
			for second in [&second, &reversed(&second)] {
				p("M4_CONSTRAIN_LOWER_INHERITS_TOP_SCORE", EditMode::Patch, "evidence.txt", &original, json!({"path":"evidence.txt","edits":[{"op":"update","diff":first},{"op":"update","diff":second}]}), Want::Refuse, f).await;
			}
		}
	}
	both(
		"M6a_REORDER_THROUGH_RETAINED_PIVOT",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n-d\n+d\n+c\n+b",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"M6b_RETAINED_PIVOT_REWRITE_CONTROL",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n-d\n+B\n+c\n+D",
		Want::Bytes("a\nX\nB\nc\nD\ne\n".into()),
		f,
	)
	.await;
	both(
		"M6c_RETAINED_PIVOT_MULTIPLE",
		"adj.txt",
		"a\nb\nc\nx\nd\ne\n",
		"@@\n a\n+X\n b",
		"@@\n-b\n-c\n-x\n-d\n+d\n+c\n+x\n+b",
		Want::Refuse,
		f,
	)
	.await;
	both(
		"M6d_RETAINED_PIVOT_NOOP_PLUS_MOVE_CONTROL",
		"adj.txt",
		"a\nb\nc\nd\ne\n",
		"@@\n-a\n+a",
		"@@\n-b\n-c\n-d\n+d\n+c\n+b",
		Want::Bytes("a\nd\nc\nb\ne\n".into()),
		f,
	)
	.await;
	p(
		"M7a_EMPTY_EOF_APPEND",
		EditMode::Patch,
		"empty.txt",
		"",
		patch("empty.txt", "@@\n+X"),
		Want::Bytes("X".into()),
		f,
	)
	.await;
	p(
		"M7b_EMPTY_EXPLICIT_EOF_APPEND",
		EditMode::Patch,
		"empty.txt",
		"",
		patch("empty.txt", "@@\n+X\n*** End of File"),
		Want::Bytes("X".into()),
		f,
	)
	.await;
	p("M7c_EMPTIED_EOF_APPEND", EditMode::Patch, "empty.txt", "a", json!({"path":"empty.txt","edits":[{"op":"update","diff":"@@\n-a"},{"op":"update","diff":"@@\n+X"}]}), Want::Bytes("X".into()), f).await;
	{
		let x = "x".repeat(5000);
		let y = "y".repeat(5000);
		let original = format!("root\n{x}\nend\n");
		both(
			"M9a_LONG_INPLACE_REWRITE",
			"large.txt",
			&original,
			&format!("@@\n root\n-{x}\n+{x}\n end"),
			&format!("@@\n-{x}\n+{y}"),
			Want::Bytes(format!("root\n{y}\nend\n")),
			f,
		)
		.await;
	}
	both(
		"M9b_BLANK_INPLACE_REWRITE",
		"blank.txt",
		"a\nb\nc\n",
		"@@\n a\n-b\n+b\n c",
		"@@\n-b\n+",
		Want::Bytes("a\n\nc\n".into()),
		f,
	)
	.await;
	p("M10_MOVE_UNIQUE_SOURCE_AND_COPY", EditMode::Patch, "moves.txt", "a\nfoo\nb\nc\n", json!({"path":"moves.txt","edits":[{"op":"update","diff":"@@\n a\n-foo\n b\n+foo\n c"},{"op":"update","diff":"@@\n b\n-foo\n c\n+foo\n+foo"},{"op":"update","diff":"@@ -4,1 +4,1 @@\n-foo\n+bar"}]}), Want::BytesOrRefuse("a\nb\nc\nbar\nfoo\n".into()), f).await;
	{
		let original = "a\nfoo\np\nfoo   \nz\n";
		let e1 = json!({"op":"update","diff":"@@\n a\n-foo\n+other\n p"});
		let e2 = json!({"op":"update","diff":"@@\n p\n-foo   \n+foo\n z"});
		let e3 = json!({"op":"update","diff":"@@\n a\n-other\n+foo\n p"});
		let e4c = json!({"op":"update","diff":"@@\n-foo\n-p\n-foo\n-z\n+p\n+z\n+foo\n+foo"});
		let e4l =
			json!({"op":"update","diff":"@@ -2,4 +2,4 @@\n-foo\n-p\n-foo\n-z\n+p\n+z\n+foo\n+foo"});
		let row4 = json!({"op":"update","diff":"@@ -4,1 +4,1 @@\n-foo\n+bar"});
		let row5 = json!({"op":"update","diff":"@@ -5,1 +5,1 @@\n-foo\n+bar"});
		let row5_bytes = "a\np\nz\nfoo\nbar\n".to_string();
		p(
			"M11a_CHAR_MOVE_POISONS_RETAINED_SIBLING",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),e4c.clone(),row4.clone()]}),
			Want::BytesOrRefuse(row5_bytes.clone()),
			f,
		)
		.await;
		p(
			"M11b_CHAR_MOVE_ROW5_CONTROL",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),e4c,row5.clone()]}),
			Want::Refuse,
			f,
		)
		.await;
		p(
			"M11c_LINE_MOVE_ROW4",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1.clone(),e2.clone(),e3.clone(),e4l.clone(),row4]}),
			Want::BytesOrRefuse(row5_bytes.clone()),
			f,
		)
		.await;
		p(
			"M11d_LINE_MOVE_ROW5_CONTROL",
			EditMode::Patch,
			"moves.txt",
			original,
			json!({"path":"moves.txt","edits":[e1,e2,e3,e4l,row5]}),
			Want::Refuse,
			f,
		)
		.await;
	}
	println!("PROBE_R12_MULTIHUNK_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn round12_token() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"J1a_LEAF_DOCKER_SUFFIX_CAPTURE",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN printf old; printf untouched\n",
		patch("Dockerfile", "@@\n-printf old\n+printf new;\n+#"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J1b_LEAF_MAKE_SUFFIX_CAPTURE",
		EditMode::Patch,
		"Makefile",
		"all:\n\tprintf old; printf untouched\n",
		patch("Makefile", "@@\n-printf old\n+printf new;\n+\t#"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J1c_LEAF_INI_SUFFIX_CAPTURE",
		EditMode::Patch,
		"s.properties",
		"very_long_configuration_key=old; untouched\nother=2\n",
		patch("s.properties", "@@\n-old\n+new;\n+#"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J2a_MAKE_LEAF_COMMENT_TERMINATOR",
		EditMode::Patch,
		"Makefile",
		"all:\n\tprintf old;\n",
		patch("Makefile", "@@\n all:\n-\tprintf old\n+\tprintf new # explanation;"),
		Want::BytesOrRefuse("all:\n\tprintf new # explanation;\n".into()),
		f,
	)
	.await;
	p(
		"J2b_DOCKER_LEAF_COMMENT_TERMINATOR",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN printf old;\n",
		patch("Dockerfile", "@@\n FROM alpine\n-RUN printf old\n+RUN printf new # explanation;"),
		Want::BytesOrRefuse("FROM alpine\nRUN printf new # explanation;\n".into()),
		f,
	)
	.await;
	p(
		"J2c_NGINX_LEAF_COMMENT_TERMINATOR",
		EditMode::Patch,
		"nginx.conf",
		"listen 80;\nother=2\n",
		patch("nginx.conf", "@@\n-listen 80\n+listen 8080 # explanation;\n other=2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J2d_INI_VALUE_COMMENT_TERMINATOR",
		EditMode::Patch,
		"s.properties",
		"value=old;\nother=2\n",
		patch("s.properties", "@@\n-value=old\n+value=new # explanation;\n other=2"),
		Want::BytesOrRefuse("value=new # explanation;\nother=2\n".into()),
		f,
	)
	.await;
	p(
		"J2e_SQL_VALUE_SEMICOLON_CONTROL",
		EditMode::Patch,
		"s.sql",
		"SELECT old;\nSELECT 2;\n",
		patch("s.sql", "@@\n-SELECT old\n+SELECT new;\n SELECT 2;"),
		Want::Bytes("SELECT new;\nSELECT 2;\n".into()),
		f,
	)
	.await;
	p(
		"J3a_REORDER_REWRITTEN_ROWS",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: \"old-a\",\n  b: \"old-b\",\n  c: \"old-c\",\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: \"old-a\"\n-  b: \"old-b\"\n-  c: \"old-c\"\n+  c: \
			 \"new-c\",\n+  a: \"new-a\",\n+  b: \"new-b\",\n };",
		),
		Want::BytesOrRefuse(
			"const o = {\n  c: \"new-c\",\n  a: \"new-a\",\n  b: \"new-b\",\n};\n".into(),
		),
		f,
	)
	.await;
	p(
		"J3b_REWRITTEN_KIND_WITH_COMMAS",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: \"old\",\n  b: \"old\",\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: \"old\"\n-  b: \"old\"\n+  a: \"new\",\n+  ...extra,\n };",
		),
		Want::BytesOrRefuse("const o = {\n  a: \"new\",\n  ...extra,\n};\n".into()),
		f,
	)
	.await;
	p(
		"J3c_MULTIPLE_LOSSES_COMMENT_ONE",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: \"old\",\n  b: \"old\",\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: \"old\"\n-  b: \"old\"\n+  a: \"new\",\n+  b: \"new\" // lost \
			 comma,\n };",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J3d_UNICODE_CRLF_REWRITTEN",
		EditMode::Patch,
		"s.js",
		"const o = {\r\n\tα: \"old\",\r\n\tβ: \"old\",\r\n};\r\n",
		patch(
			"s.js",
			"@@\n const o = {\n-\tα: \"old\"\n-\tβ: \"old\"\n+\tα: \"new\",\n+\tβ: \"new\",\n };",
		),
		Want::Bytes("const o = {\r\n\tα: \"new\",\r\n\tβ: \"new\",\r\n};\r\n".into()),
		f,
	)
	.await;
	p(
		"J3e_REPLACE_UNAFFECTED",
		EditMode::Replace,
		"s.js",
		"const o = { a: 1, b: 2 };\n",
		json!({"path":"s.js","old_string":"a: 1","new_string":"a: 3,\n}; //"}),
		Want::Bytes("const o = { a: 3,\n}; //, b: 2 };\n".into()),
		f,
	)
	.await;
	p(
		"J4a_MULTILINE_REWRITTEN_SUCCESSOR",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: {\n    x: 2\n  },\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: 1\n-  b: {\n-    x: 2\n-  },\n+  a: 3,\n+  b: {\n+    x: \
			 4000\n+  },\n };",
		),
		Want::BytesOrRefuse("const o = {\n  a: 3,\n  b: {\n    x: 4000\n  },\n};\n".into()),
		f,
	)
	.await;
	p(
		"J4b_MULTILINE_SUCCESSOR_BECOMES_MULTILINE",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: { x: 2 },\n};\n",
		patch(
			"s.js",
			"@@\n const o = {\n-  a: 1\n-  b: { x: 2 },\n+  a: 3,\n+  b: {\n+    x: 4\n+  },\n };",
		),
		Want::BytesOrRefuse("const o = {\n  a: 3,\n  b: {\n    x: 4\n  },\n};\n".into()),
		f,
	)
	.await;
	p(
		"J4c_MULTI_SUCCESSOR_WIDTH",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: \"old\",\n  b: {\n    x: 1\n  },\n};\n",
		patch(
			"s.js",
			"@@ const o = {\n-  a: \"old\"\n-  b: {\n-    x: 1\n-  },\n+  a: \"new\",\n+  b: {\n+    \
			 x: 4000\n+  },",
		),
		Want::BytesOrRefuse("const o = {\n  a: \"new\",\n  b: {\n    x: 4000\n  },\n};\n".into()),
		f,
	)
	.await;
	p("J5a_VB_REM_COLON_SEPARATOR", EditMode::Patch, "s.vb", "Dim cfg = New Config With {\n    .Value = old,\n    .Other = 2\n}\n", patch("s.vb", "@@\n Dim cfg = New Config With {\n-    .Value = old\n+    .Value = updated:REM note,\n     .Other = 2\n }"), Want::Refuse, f).await;
	p(
		"J5b_VB_APOSTROPHE_SEPARATOR",
		EditMode::Patch,
		"s.vb",
		"Dim cfg = New Config With {\n    .Value = old,\n    .Other = 2\n}\n",
		patch(
			"s.vb",
			"@@\n Dim cfg = New Config With {\n-    .Value = old\n+    .Value = updated' note,\n     \
			 .Other = 2\n }",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J5c_LESS_TRIVIAL_VALUE_COMMENT",
		EditMode::Patch,
		"s.less",
		".a {\n  color: red;\n  margin: 0;\n}\n",
		patch("s.less", "@@\n .a {\n-  color: red\n+  color: blue; // note\n   margin: 0;\n }"),
		Want::Bytes(".a {\n  color: blue; // note\n  margin: 0;\n}\n".into()),
		f,
	)
	.await;
	p(
		"J5d_SQL_COMMENT_SEPARATOR",
		EditMode::Patch,
		"s.sql",
		"SELECT old;\nSELECT 2;\n",
		patch("s.sql", "@@\n-SELECT old\n+SELECT new -- note;\n SELECT 2;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J5e_ENV_COMMENT_SEPARATOR",
		EditMode::Patch,
		"config.env",
		"VALUE=old;\nOTHER=2\n",
		patch("config.env", "@@\n-VALUE=old\n+VALUE=new # note;\n OTHER=2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J5f_YAML_LEAF_MULTI_RUN",
		EditMode::Patch,
		"s.yml",
		"greeting: hello,;\nother: world\n",
		patch("s.yml", "@@\n-greeting: hello\n+greeting: goodbye,;\n other: world"),
		Want::Bytes("greeting: goodbye,;\nother: world\n".into()),
		f,
	)
	.await;
	p(
		"J5g_PROPERTY_UNICODE_RENAME",
		EditMode::Patch,
		"s.properties",
		"clé=ancien;\nother=2\n",
		patch("s.properties", "@@\n-clé=ancien\n+nouvelle_clé=nouveau;\n other=2"),
		Want::Bytes("nouvelle_clé=nouveau;\nother=2\n".into()),
		f,
	)
	.await;
	p(
		"J5h_UNKNOWN_TRIVIAL_LINE",
		EditMode::Patch,
		"s.txt",
		"value=old;\nother=2\n",
		patch("s.txt", "@@\n-value=old\n+value=new;\n other=2"),
		Want::Bytes("value=new;\nother=2\n".into()),
		f,
	)
	.await;
	p(
		"J6a_SINGLE_LINE_JS_SUFFIX_COMMENT",
		EditMode::Patch,
		"s.js",
		"const long_variable_name_to_force_character_fallback = { a: 1, b: 2 };\n",
		patch("s.js", "@@\n-a: 1\n+a: 3 //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J6b_SINGLE_LINE_JS_CLOSED_SUFFIX_COMMENT",
		EditMode::Patch,
		"s.js",
		"const long_variable_name_to_force_character_fallback = { a: 1, b: 2 };\n",
		patch("s.js", "@@\n-a: 1\n+a: 3 }; //"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J6c_SINGLE_LINE_PY_SUFFIX_COMMENT",
		EditMode::Patch,
		"s.py",
		"long_variable_name_to_force_character_fallback = dict(a=1, b=2)\n",
		patch("s.py", "@@\n-a=1\n+a=3) #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J6d_SINGLE_LINE_DOCKER_SUFFIX_COMMENT",
		EditMode::Patch,
		"Dockerfile",
		"FROM alpine\nRUN printf old; printf untouched\n",
		patch("Dockerfile", "@@\n-printf old\n+printf new #"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J7_MAKE_LEAF_COMMENT_SEMI",
		EditMode::Patch,
		"t.mk",
		"all:\n\techo old;\n\techo keep\n",
		patch("t.mk", "@@ all:\n-\techo old\n+\techo new #;"),
		Want::BytesOrRefuse("all:\n\techo new #;\n\techo keep\n".into()),
		f,
	)
	.await;
	p(
		"J8_UNICODE_IDENTIFIER_GUARD_BYPASS",
		EditMode::Patch,
		"s.js",
		"function f() {\n  let a\u{200d}b = 1;\n  return a\u{200d}b;\n}\n",
		patch("s.js", "@@ function f() {\n-  return ab;\n+  return ab + 1;"),
		Want::Refuse,
		f,
	)
	.await;
	println!("PROBE_R12_TOKEN_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn round12_region() {
	let mut fails = Vec::new();
	let f = &mut fails;
	// (label, file, original-with-x1 target, diff, x1 text, plain text,
	// replacement)
	let rows: Vec<(&str, &str, &str, &str, &str, &str, &str)> = vec![
		("RG1_C_LABEL_OWN_ROW_BLOCK", "label.c", "void f(void) {\nouter:\n    {\n        notify(x1);\n    }\n}\nvoid g(void) {\n        notify(x);\n}\n", "@@ outer:\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG2_RUST_LABEL_OWN_ROW_BLOCK", "label.rs", "fn f() {\n    'outer:\n    {\n        notify(x1);\n    }\n}\nfn g() {\n        notify(x);\n}\n", "@@ 'outer:\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG3_PHP_LABEL_OWN_ROW_BLOCK", "label.php", "<?php\nfunction f() {\nouter:\n    {\n        notify($x1);\n    }\n}\nfunction g() {\n        notify($x);\n}\n", "@@ outer:\n-        notify($x);\n+        notify($y);", "notify($x1);", "notify($x);", "notify($y);"),
		("RG4_PHP_LABEL_LOOP", "label.php", "<?php\nfunction f() {\nouter:\n    while ($ready) {\n        notify($x1);\n    }\n}\nfunction g() {\n        notify($x);\n}\n", "@@ outer:\n-        notify($x);\n+        notify($y);", "notify($x1);", "notify($x);", "notify($y);"),
		("RG5_ELSE_IF_ROW", "s.js", "function f() {\n  if (a) {\n    first();\n  } else if (b) {\n    notify(x1);\n  }\n}\nfunction g() {\n    notify(x);\n}\n", "@@ } else if (b) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG6_CATCH_ROW", "s.js", "function f() {\n  try {\n    first();\n  } catch (e) {\n    notify(x1);\n  }\n}\nfunction g() {\n    notify(x);\n}\n", "@@ } catch (e) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG7_CLOSE_THEN_NEXT_ROW", "s.js", "function f() {\n  if (a) {\n    first();\n  } if (b) {\n    notify(x1);\n  }\n}\nfunction g() {\n    notify(x);\n}\n", "@@ } if (b) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG8_CS_ATTR_HEADER", "L.cs", "class C {\n    [Attr] void F() {\n        notify(x1);\n    }\n    void G() {\n        notify(x);\n    }\n}\n", "@@ [Attr] void F() {\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG9_JAVA_LEAD_ANNOTATION_HEADER", "L.java", "class C {\n    /* lead */ @Attr void f() {\n        notify(x1);\n    }\n    void g() {\n        notify(x);\n    }\n}\n", "@@ /* lead */ @Attr void f() {\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG10_RUST_LEAD_ATTR_HEADER", "L.rs", "/* lead */ #[attr] fn f() {\n        notify(x1);\n}\nfn g() {\n        notify(x);\n}\n", "@@ /* lead */ #[attr] fn f() {\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG11_CS_LEAD_ATTR_HEADER", "L.cs", "class C {\n    /* lead */ [Attr] void F() {\n        notify(x1);\n    }\n    void G() {\n        notify(x);\n    }\n}\n", "@@ /* lead */ [Attr] void F() {\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG12_C_TWO_LEAD_COMMENTS", "L.c", "void f(void) {\n    /* one */ /* two */ if (ready) {\n        notify(x1);\n    }\n}\nvoid g(void) {\n        notify(x);\n}\n", "@@ /* one */ /* two */ if (ready) {\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG13_RUST_LABEL_LOOP_OWN_ROW", "label.rs", "fn f() {\n    'outer:\n    loop {\n        notify(x1);\n    }\n}\nfn g() {\n        notify(x);\n}\n", "@@ 'outer:\n-        notify(x);\n+        notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG14_SWIFT_DELAYED_LABEL", "label.swift", "func f() {\nouter:\n\n    // lead\n    for i in items {\n        notify(x1)\n    }\n}\nfunc g() {\n        notify(x)\n}\n", "@@ outer:\n-        notify(x)\n+        notify(y)", "notify(x1)", "notify(x)", "notify(y)"),
		("RG15_TWO_STATEMENTS_HEADER", "s.js", "function f() {\n  before(); if (ready) {\n    notify(x1);\n  }\n}\nfunction g() {\n    notify(x);\n}\n", "@@ if (ready) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG16_TWO_CONSTRUCTS_HEADER", "s.js", "function f() { if (ready) {\n    notify(x1);\n  }\n  if (done) {\n    notify(x);\n  }\n}\n", "@@ if (ready) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG17_XML_LEAD_COMMENT", "comment.xml", "<root>\n  <!-- lead --><deps>\n    <v>1a</v>\n  </deps>\n  <other>\n    <v>1</v>\n  </other>\n</root>\n", "@@ <!-- lead --><deps>\n-    <v>1</v>\n+    <v>2</v>", "<v>1a</v>", "<v>1</v>", "<v>2</v>"),
		("RG18_HTML_LEAD_COMMENT", "comment.html", "<root>\n  <!-- lead --><deps>\n    <v>1a</v>\n  </deps>\n  <other>\n    <v>1</v>\n  </other>\n</root>\n", "@@ <!-- lead --><deps>\n-    <v>1</v>\n+    <v>2</v>", "<v>1a</v>", "<v>1</v>", "<v>2</v>"),
		("RG19_RUBY_END_THEN_IF", "s.rb", "def f\n  if a\n    first()\n  end; if b\n    notify(x1)\n  end\nend\ndef g\n    notify(x)\nend\n", "@@ end; if b\n-    notify(x)\n+    notify(y)", "notify(x1)", "notify(x)", "notify(y)"),
		("RG20_JS_CLOSING_ROW_COMMENT", "tail.js", "db.save(user).then(() => {\n  notify(x1);\n/* close */ });\nfunction g() {\n  notify(x);\n}\n", "@@ db.save(user).then\n-  notify(x);\n+  notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
		("RG24_NBSP_REAL_HEADER", "unicode-header.js", "function f() {\n  /* marker */\u{00a0}if (ready) {\n    notify(x1);\n  }\n    notify(x);\n}\n", "@@ /* marker */\u{00a0}if (ready) {\n-    notify(x);\n+    notify(y);", "notify(x1);", "notify(x);", "notify(y);"),
	];
	for (label, file, original, diff, from, plain, to) in rows {
		p(
			&format!("{label}_ESCAPE"),
			EditMode::Patch,
			file,
			original,
			patch(file, diff),
			Want::BytesOrRefuse(original.replacen(from, to, 1)),
			f,
		)
		.await;
		let control = original.replacen(from, plain, 1);
		p(
			&format!("{label}_CONTROL"),
			EditMode::Patch,
			file,
			&control,
			patch(file, diff),
			Want::Bytes(control.replacen(plain, to, 1)),
			f,
		)
		.await;
	}
	{
		let py = "def f():\n    before = 1; text = '''hello\nneedle\n'''\ndef g():\n    text = \
		          '''hello\nneedle\n'''\n";
		p(
			"RG21_ROW_TWO_STATEMENTS_LITERAL",
			EditMode::Patch,
			"s.py",
			py,
			patch("s.py", "@@ before = 1; text = '''hello\n-needle\n+changed"),
			Want::BytesOrRefuse(py.replacen("needle", "changed", 1)),
			f,
		)
		.await;
	}
	{
		let nbsp =
			"function f() {\n  /* marker */\u{00a0}\n    notify(x);   \n}\nfunction g() {\n    \
			 notify(x);\n}\n";
		p(
			"RG22_NBSP_AFTER_COMMENT_ANCHOR",
			EditMode::Patch,
			"unicode-comment.js",
			nbsp,
			patch("unicode-comment.js", "@@ /* marker */\n-    notify(x);\n+    notify(y);"),
			Want::BytesOrRefuse(nbsp.replacen("    notify(x);   ", "    notify(y);", 1)),
			f,
		)
		.await;
		let ascii = nbsp.replace('\u{00a0}', " ");
		p(
			"RG22b_ASCII_AFTER_COMMENT_ANCHOR",
			EditMode::Patch,
			"unicode-comment.js",
			&ascii,
			patch("unicode-comment.js", "@@ /* marker */\n-    notify(x);\n+    notify(y);"),
			Want::BytesOrRefuse(ascii.replacen("    notify(x);   ", "    notify(y);", 1)),
			f,
		)
		.await;
	}
	{
		let broken = "db.save(user).then(() => {\n    notify(x);   \n})\n.catch(() => {\n    \
		              notify(x);\n    broken = = 1;\n});\nfunction g() {}\n";
		p(
			"RG23_ERRORFUL_CHAIN_TWO_TIERS",
			EditMode::Patch,
			"broken.js",
			broken,
			patch("broken.js", "@@ db.save(user).then\n-    notify(x);\n+    notify(y);"),
			Want::BytesOrRefuse(broken.replacen("    notify(x);   ", "    notify(y);", 1)),
			f,
		)
		.await;
	}
	println!("PROBE_R12_REGION_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn round12_insertion() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"IF1_JULIA_DOCSTRING_CAPTURE",
		EditMode::Patch,
		"docs.jl",
		"\"\"\"Original function docs\"\"\"\nfunction f()\n    return 1\nend\n",
		patch("docs.jl", "@@ \"\"\"Original function docs\"\"\"\n+function g()\n+    return 2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF2_RUBY_SINGLETON_COMMENT_CAPTURE",
		EditMode::Patch,
		"docs.rb",
		"# Original f docs\ndef self.f\n  1\nend\n",
		patch("docs.rb", "@@ # Original f docs\n+def self.g\n+  2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF3_FUNCTION_COMMENT_STATEMENT",
		EditMode::Patch,
		"comment.py",
		"def f():\n    # setup note\n    run()\n",
		patch("comment.py", "@@     # setup note\n+    setup()"),
		Want::Bytes("def f():\n    # setup note\n    setup()\n    run()\n".into()),
		f,
	)
	.await;
	p(
		"IF4_R_ROXYGEN_CAPTURE",
		EditMode::Patch,
		"docs.R",
		"#' Original f docs\nf <- function() {\n  1\n}\n",
		patch("docs.R", "@@ #' Original f docs\n+g <- function() {\n+  2\n+}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF5_RUBY_MODULE_COMMENT_CAPTURE",
		EditMode::Patch,
		"docs.rb",
		"# Original module docs\nmodule F\nend\n",
		patch("docs.rb", "@@ # Original module docs\n+module G\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF6_PY_IF_LITERAL_NOT_DOCSTRING",
		EditMode::Patch,
		"literal.py",
		"def f():\n    if ready:\n        \"ordinary literal\"\n        run()\n",
		patch("literal.py", "@@     if ready:\n+        setup()"),
		Want::Bytes(
			"def f():\n    if ready:\n        setup()\n        \"ordinary literal\"\n        run()\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"IF7_NEW_COMMENT_OVER_DECL",
		EditMode::Patch,
		"docs.py",
		"marker = 1\ndef f():\n    return 1\n",
		patch("docs.py", "@@ marker = 1\n+# New f docs"),
		Want::Bytes("marker = 1\n# New f docs\ndef f():\n    return 1\n".into()),
		f,
	)
	.await;
	p(
		"IF8_AFTER_TRAILING_COMMENT",
		EditMode::Patch,
		"docs.c",
		"int marker; // marker docs\nvoid f(void) {}\n",
		patch("docs.c", "@@ int marker; // marker docs\n+int added;"),
		Want::Bytes("int marker; // marker docs\nint added;\nvoid f(void) {}\n".into()),
		f,
	)
	.await;
	p(
		"IF9_DART_FUNCTION_DOC",
		EditMode::Patch,
		"docs.dart",
		"/// Original f docs\nint f() { return 1; }\n",
		patch("docs.dart", "@@ /// Original f docs\n+int g() { return 2; }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF10_OCAML_VALUE_DOC",
		EditMode::Patch,
		"docs.ml",
		"(** Original f docs *)\nlet f x = x\n",
		patch("docs.ml", "@@ (** Original f docs *)\n+let g x = x + 1"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF11_LUA_LOCAL_FUNCTION_DOC",
		EditMode::Patch,
		"docs.lua",
		"-- Original f docs\nlocal function f()\n  return 1\nend\n",
		patch("docs.lua", "@@ -- Original f docs\n+local function g()\n+  return 2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF12_SCALA_COMMENT_ATTRIBUTE",
		EditMode::Patch,
		"docs.scala",
		"/** Original f docs */\n@deprecated(\"old\", \"1\")\ndef f(): Int = 1\n",
		patch("docs.scala", "@@ /** Original f docs */\n+def g(): Int = 2"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF13_ZIG_COMMENT_DECL",
		EditMode::Patch,
		"docs.zig",
		"/// Original f docs\nfn f() void {}\n",
		patch("docs.zig", "@@ /// Original f docs\n+fn g() void {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF14_POWERSHELL_CLASS_DOC",
		EditMode::Patch,
		"docs.ps1",
		"# Original F docs\nclass F {\n}\n",
		patch("docs.ps1", "@@ # Original F docs\n+class G {\n+}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF15_YAML_COMMENT_BEFORE_SEQUENCE",
		EditMode::Patch,
		"items.yml",
		"items:\n  - first\n  # section note\n  - second\n",
		patch("items.yml", "@@   # section note\n+  - added"),
		Want::Bytes("items:\n  - first\n  # section note\n  - added\n  - second\n".into()),
		f,
	)
	.await;
	p(
		"IF16_TOUCHING_COMMENT_NEW_PAIR",
		EditMode::Patch,
		"docs.rs",
		"/// Original f docs\nfn f() {}\n",
		patch("docs.rs", "@@ /// Original f docs\n+/// New g docs\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF17_BLANK_BOUNDARY",
		EditMode::Patch,
		"docs.rs",
		"// section note\n\nfn f() {}\n",
		patch("docs.rs", "@@ // section note\n+fn g() {}"),
		Want::Bytes("// section note\nfn g() {}\n\nfn f() {}\n".into()),
		f,
	)
	.await;
	p(
		"IF18_COMMENT_BEFORE_ATTRIBUTE",
		EditMode::Patch,
		"docs.rs",
		"/// Original f docs\n#[test]\nfn f() {}\n",
		patch("docs.rs", "@@ /// Original f docs\n+fn g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF19_COMMENT_ATTRIBUTE_DECL_CAPTURE",
		EditMode::Patch,
		"docs.java",
		"class C {\n  /** Original f docs */\n  @Deprecated\n  void f() {}\n}\n",
		patch("docs.java", "@@ @Deprecated\n+  void g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF20_JS_DEFAULT_TO_CASE",
		EditMode::Patch,
		"switch.js",
		"function f(x) {\n  switch (x) {\n    default:\n      target();\n  }\n}\n",
		patch("switch.js", "@@ default:\n+    case 2:"),
		Want::Bytes(
			"function f(x) {\n  switch (x) {\n    default:\n    case 2:\n      target();\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"IF21_JS_CASE_TO_DEFAULT",
		EditMode::Patch,
		"switch.js",
		"function f(x) {\n  switch (x) {\n    case 1:\n      target();\n  }\n}\n",
		patch("switch.js", "@@ case 1:\n+    default:"),
		Want::Bytes(
			"function f(x) {\n  switch (x) {\n    case 1:\n    default:\n      target();\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"IF22_GO_DEFAULT_FALLTHROUGH_CASE",
		EditMode::Patch,
		"switch.go",
		"package p\nfunc f(x int) {\n  switch x {\n  default:\n    target()\n  }\n}\n",
		patch("switch.go", "@@ default:\n+    fallthrough\n+  case 2:"),
		Want::Bytes(
			"package p\nfunc f(x int) {\n  switch x {\n  default:\n    fallthrough\n  case 2:\n    \
			 target()\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"IF23_CS_GOTO_CASE_WITH_LABEL",
		EditMode::Patch,
		"switch.cs",
		"class C {\n  void F(int x) {\n    switch (x) {\n      case 1:\n        Target();\n        \
		 break;\n    }\n  }\n}\n",
		patch("switch.cs", "@@ case 1:\n+        goto case 2;\n+      case 2:"),
		Want::Refuse,
		f,
	)
	.await;
	p("IF24_CS_GUARDED_CASE_LABEL", EditMode::Patch, "switch.cs", "class C {\n  void F(object x) {\n    switch (x) {\n      case 1:\n        Target();\n        break;\n    }\n  }\n}\n", patch("switch.cs", "@@ case 1:\n+      case int y when y > 2:"), Want::Bytes("class C {\n  void F(object x) {\n    switch (x) {\n      case 1:\n      case int y when y > 2:\n        Target();\n        break;\n    }\n  }\n}\n".into()), f).await;
	p(
		"IF25_LUA_FIELDLESS_ELSE_CAPTURE",
		EditMode::Patch,
		"branch.lua",
		"function f()\n  if ok then\n    target()\n  end\nend\n",
		patch("branch.lua", "@@ if ok then\n+    before()\n+  else"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF26_KOTLIN_FIELDLESS_ELSE_CAPTURE",
		EditMode::Patch,
		"branch.kt",
		"fun f() {\n  if (ok) {\n    target()\n  }\n}\n",
		patch("branch.kt", "@@ if (ok) {\n+    before()\n+  } else {"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF27_ELIXIR_COMMENT_THEN_DOC_CAPTURE",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  # Original f docs\n  @doc \"Original f docs\"\n  def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ # Original f docs\n+  def g(), do: :new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF28_ELIXIR_COMMENT_THEN_SPEC_CAPTURE",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  # Original f docs\n  @spec f() :: :ok\n  def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ # Original f docs\n+  def g(), do: :new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF29_RUBY_TRAILING_PREVIOUS_DOC",
		EditMode::Patch,
		"docs.rb",
		"marker = 1 # marker comment\ndef f\n  1\nend\n",
		patch("docs.rb", "@@ marker = 1 # marker comment\n+def g\n+  2\n+end"),
		Want::Bytes("marker = 1 # marker comment\ndef g\n  2\nend\ndef f\n  1\nend\n".into()),
		f,
	)
	.await;
	p(
		"IF30_ELIXIR_COMMENT_ONLY_ADDITION",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  @doc \"Original f docs\"\n  def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ @doc \"Original f docs\"\n+  # More docs"),
		Want::Bytes(
			"defmodule M do\n  @doc \"Original f docs\"\n  # More docs\n  def f(), do: :ok\nend\n"
				.into(),
		),
		f,
	)
	.await;
	p(
		"IF31_EXPORTED_JS_DOC_CAPTURE",
		EditMode::Patch,
		"docs.js",
		"/** Original f docs */\nexport function f() {}\n",
		patch("docs.js", "@@ /** Original f docs */\n+export function g() {}"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF32_EXPORTED_TS_DOC_CAPTURE",
		EditMode::Patch,
		"docs.ts",
		"// Original f docs\nexport const f = 1;\n",
		patch("docs.ts", "@@ // Original f docs\n+export const g = 2;"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF33_RUBY_METHOD_CONTROL",
		EditMode::Patch,
		"docs.rb",
		"# Original f docs\ndef f\n  1\nend\n",
		patch("docs.rb", "@@ # Original f docs\n+def g\n+  2\n+end"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF34_HASKELL_FUNCTION_CONTROL",
		EditMode::Patch,
		"Docs.hs",
		"module Docs where\n-- | Original f docs\nf x = x\n",
		patch("Docs.hs", "@@ -- | Original f docs\n+g x = x + 1"),
		Want::Refuse,
		f,
	)
	.await;
	p("IF35_NESTED_SWITCH_OLD_REACH", EditMode::Patch, "nested.js", "function f(x, y) {\n  switch (x) {\n    case 1:\n      switch (y) {\n        case 3:\n          target();\n      }\n  }\n}\n", patch("nested.js", "@@     case 1:\n+    case 2:"), Want::Bytes("function f(x, y) {\n  switch (x) {\n    case 1:\n    case 2:\n      switch (y) {\n        case 3:\n          target();\n      }\n  }\n}\n".into()), f).await;
	p("IF36_NESTED_SWITCH_BREAK_NO_REACH", EditMode::Patch, "nested.js", "function f(x, y) {\n  switch (x) {\n    case 1:\n      switch (y) {\n        case 3:\n          target();\n      }\n  }\n}\n", patch("nested.js", "@@     case 1:\n+      break;\n+    case 2:"), Want::Refuse, f).await;
	p(
		"IF37_JULIA_ELSE_OWNER",
		EditMode::Patch,
		"branch.jl",
		"function f()\n  if ok\n    target()\n  end\nend\n",
		patch("branch.jl", "@@ if ok\n+    before()\n+  else"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF38_RUBY_ELSE_OWNER",
		EditMode::Patch,
		"branch.rb",
		"def f\n  if ok\n    target()\n  end\nend\n",
		patch("branch.rb", "@@ if ok\n+    before()\n+  else"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF39_CLOJURE_QUALIFIED_DEFN_DOC_CAPTURE",
		EditMode::Patch,
		"docs.clj",
		";; Original f docs\n(clojure.core/defn f [] 1)\n",
		patch("docs.clj", "@@ ;; Original f docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF40_CLOJURE_METADATA_DEFN_DOC_CAPTURE",
		EditMode::Patch,
		"docs.clj",
		";; Original f docs\n^{:private true} (defn f [] 1)\n",
		patch("docs.clj", "@@ ;; Original f docs\n+(defn g [] 2)"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF41_ELIXIR_DEFDELEGATE_DOC_CAPTURE",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  # Original f docs\n  defdelegate f(x), to: Target\nend\n",
		patch("docs.ex", "@@ # Original f docs\n+  def g(x), do: x"),
		Want::Refuse,
		f,
	)
	.await;
	{
		let php = "<?php\nfunction f($x) {\n  switch ($x) {\n    case 1:\n      target();\n      \
		           break;\n  }\n}\n";
		p(
			"IF42_PHP_CASE_DEFAULT_REACH",
			EditMode::Patch,
			"switch.php",
			php,
			patch("switch.php", "@@ case 1:\n+    default:"),
			Want::Bytes(php.replacen("    case 1:\n", "    case 1:\n    default:\n", 1)),
			f,
		)
		.await;
		let php = "<?php\nfunction f($x) {\n  switch ($x) {\n    default:\n      target();\n      \
		           break;\n  }\n}\n";
		p(
			"IF43_PHP_DEFAULT_CASE_REACH",
			EditMode::Patch,
			"switch.php",
			php,
			patch("switch.php", "@@ default:\n+    case 2:"),
			Want::Bytes(php.replacen("    default:\n", "    default:\n    case 2:\n", 1)),
			f,
		)
		.await;
		let go = "package p\nfunc f(x int) {\n  switch x {\n  case 1:\n    target()\n  }\n}\n";
		p(
			"IF44_GO_LEADING_BLANK_FALLTHROUGH",
			EditMode::Patch,
			"switch.go",
			go,
			patch("switch.go", "@@ case 1:\n+\n+    fallthrough\n+  case 2:"),
			Want::Bytes(go.replacen("  case 1:\n", "  case 1:\n\n    fallthrough\n  case 2:\n", 1)),
			f,
		)
		.await;
	}
	p(
		"IF45_ELIXIR_COMMENT_DOC_AFTER_PRIOR_CAPTURE",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  def prior(), do: :ok\n  # Original f docs\n  @doc \"Original f docs\"\n  \
		 def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ # Original f docs\n+  def g(), do: :new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF46_ELIXIR_COMMENT_SPEC_CAPTURE_MIN",
		EditMode::Patch,
		"docs.ex",
		"defmodule M do\n  # Original f docs\n  @spec f() :: atom()\n  def f(), do: :ok\nend\n",
		patch("docs.ex", "@@ # Original f docs\n+  def g(), do: :new"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IF47_YAML_COMMENT_MID_SEQUENCE",
		EditMode::Patch,
		"items.yaml",
		"items:\n  - first\n  # note\n  - second\n",
		patch("items.yaml", "@@ # note\n+  - inserted"),
		Want::Bytes("items:\n  - first\n  # note\n  - inserted\n  - second\n".into()),
		f,
	)
	.await;
	p(
		"IF48_MARKDOWN_COMMENT_LIST_INSERT",
		EditMode::Patch,
		"items.md",
		"- first\n<!-- note -->\n- second\n",
		patch("items.md", "@@ <!-- note -->\n+- inserted"),
		Want::Bytes("- first\n<!-- note -->\n- inserted\n- second\n".into()),
		f,
	)
	.await;
	p(
		"IF49_JSON_OBJECT_SIBLING_INSERT",
		EditMode::Patch,
		"items.json",
		"{\n  \"first\": 1,\n  \"second\": 2\n}\n",
		patch("items.json", "@@ \"first\": 1,\n+  \"inserted\": 3,"),
		Want::Bytes("{\n  \"first\": 1,\n  \"inserted\": 3,\n  \"second\": 2\n}\n".into()),
		f,
	)
	.await;
	println!("PROBE_R12_INSERTION_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn round12_scalability_outcomes() {
	let mut fails = Vec::new();
	let f = &mut fails;
	for n in [16usize, 32] {
		let diff = std::iter::repeat_n("@@\n a\n b\n-c\n+c", n)
			.chain(std::iter::repeat_n("@@\n+X", n))
			.collect::<Vec<_>>()
			.join("\n");

		p(
			&format!("PF1_CONTEXT_GAP_SCALE_{n}"),
			EditMode::Patch,
			"scale.txt",
			"a\nb\nc\n",
			patch("scale.txt", &diff),
			Want::Refuse,
			f,
		)
		.await;
	}
	{
		let n = 32usize;
		let edits: Vec<_> = (0..n)
			.map(|i| json!({"op":"update","diff": if i % 2 == 0 {"@@\n-x\n+y"} else {"@@\n-y\n+x"}}))
			.collect();

		p(
			&format!("PF2_PROVENANCE_LONG_{n}"),
			EditMode::Patch,
			"scale.txt",
			"x\n",
			json!({"path":"scale.txt","edits":edits}),
			Want::Bytes("x\n".into()),
			f,
		)
		.await;
	}
	{
		let head = "const unique_0=1;\n";
		let pad = "// filler\n".repeat(((16 << 10) - head.len() - 100) / 10);
		let original = format!("{head}{pad}");
		let wanted = format!("const unique_0=2;\n{pad}");

		p(
			"PF3_SEPARATOR_NEAR_GATE",
			EditMode::Patch,
			"big.js",
			&original,
			patch("big.js", "@@ -1,1 +1,1 @@\n-const unique_0=1\n+const unique_0=2;"),
			Want::BytesOrRefuse(wanted),
			f,
		)
		.await;
	}
	for n in [16usize, 64] {
		let source = format!("marker();\nfunction f() {{\n{}}}\n", "  work();\n".repeat(n));
		let expected = source.replacen("marker();\n", "marker();\ninserted();\n", 1);

		p(
			&format!("PF4_OWNER_ORDINAL_SCALE_{n}"),
			EditMode::Patch,
			"cost.js",
			&source,
			patch("cost.js", "@@ marker();\n+inserted();"),
			Want::Bytes(expected),
			f,
		)
		.await;
	}
	for n in [8usize, 32] {
		let source = format!("// unique first\n{}function f() {{}}\n", "// further docs\n".repeat(n));

		p(
			&format!("PF5_ATTACHMENT_SCAN_SCALE_{n}"),
			EditMode::Patch,
			"docs.js",
			&source,
			patch("docs.js", "@@ // unique first\n+function g() {}"),
			Want::Refuse,
			f,
		)
		.await;
	}
	for n in [16usize, 64] {
		let source = format!("{}if (ready) {{\n  notify(x);\n}}\n", "/* c */ ".repeat(n));

		p(
			&format!("PF6_LEADING_EXTRAS_SCALE_{n}"),
			EditMode::Patch,
			"scale.js",
			&source,
			patch("scale.js", "@@ if (ready)\n-  notify(x);\n+  notify(y);"),
			Want::Bytes(source.replacen("notify(x);", "notify(y);", 1)),
			f,
		)
		.await;
	}
	for (label, partial) in [("PF7_COMMENT_ROWS_EXACT", false), ("PF7_COMMENT_ROWS_PARTIAL", true)] {
		let pad = "// filler\n".repeat(64);
		let original = format!("const unique_0=1;\n{pad}");
		let diff = if partial {
			"@@ -1,1 +1,1 @@\n-const unique_0=1\n+const unique_0=2;"
		} else {
			"@@ -1,1 +1,1 @@\n-const unique_0=1;\n+const unique_0=2;"
		};

		p(
			label,
			EditMode::Patch,
			"big.js",
			&original,
			patch("big.js", diff),
			Want::Bytes(format!("const unique_0=2;\n{pad}")),
			f,
		)
		.await;
	}
	println!("PROBE_R12_PERF_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn round12_token_extra() {
	let mut fails = Vec::new();
	let f = &mut fails;
	p(
		"J9_MAKE_LEAF_SAME_COLUMN_COMMAND",
		EditMode::Patch,
		"t.mk",
		"all:\n\techo old; echo keep\n",
		patch("t.mk", "@@ all:\n-\techo old echo keep\n+\techo x #; echo keep"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"J10a_ENV_HASH_WORD_VALUE",
		EditMode::Patch,
		"s.env",
		"VALUE=old#tail;\nOTHER=2\n",
		patch("s.env", "@@ -1,1 +1,1 @@\n-VALUE=old#tail\n+VALUE=new#tail;"),
		Want::Bytes("VALUE=new#tail;\nOTHER=2\n".into()),
		f,
	)
	.await;
	p(
		"J10b_PROPERTIES_HASH_VALUE",
		EditMode::Patch,
		"s.properties",
		"value=old#tail;\nother=2\n",
		patch("s.properties", "@@ -1,1 +1,1 @@\n-value=old#tail\n+value=new#tail;"),
		Want::Bytes("value=new#tail;\nother=2\n".into()),
		f,
	)
	.await;
	p(
		"J10c_SQL_MINUS_MINUS_VALUE",
		EditMode::Patch,
		"s.sql",
		"SELECT a--b;\nSELECT 2;\n",
		patch("s.sql", "@@ -1,1 +1,1 @@\n-SELECT a--b\n+SELECT a--c;"),
		Want::BytesOrRefuse("SELECT a--c;\nSELECT 2;\n".into()),
		f,
	)
	.await;
	p(
		"J11_REWRITTEN_SUCCESSOR_KIND",
		EditMode::Patch,
		"s.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("s.js", "@@ const o = {\n-  a: 1\n-  b: 2,\n+  a: 3,\n+  b() { return 2; },"),
		Want::BytesOrRefuse("const o = {\n  a: 3,\n  b() { return 2; },\n};\n".into()),
		f,
	)
	.await;
	p(
		"J12_LITERAL_TRAILING_SPACES",
		EditMode::Patch,
		"s.py",
		"value = \"\"\"first\nkeep  \nlast\"\"\"\n",
		patch("s.py", "@@\n value = \"\"\"first\n-keep\n+changed\n last\"\"\""),
		Want::BytesAnyOrRefuse(vec![
			"value = \"\"\"first\nchanged  \nlast\"\"\"\n".into(),
			"value = \"\"\"first\nchanged\nlast\"\"\"\n".into(),
		]),
		f,
	)
	.await;
	println!("PROBE_R12_TOKEN_EXTRA_FAILS={fails:?}");
	assert!(fails.is_empty(), "round-12 failures: {fails:?}");
}

#[tokio::test]
async fn guard_counterexamples_keep_target_and_lexical_identity() {
	let mut fails = Vec::new();
	for (label, file, source, diff) in [
		(
			"cross_row_comment_capture",
			"s.js",
			"const x = old\nkeep();\n/* tail */\n",
			"@@\n-old\n+0; /*",
		),
		("interpolation_capture", "s.js", "const text = `a${foo} tail`;\n", "@@\n-`a${\n+`a"),
		(
			"opaque_quote_capture",
			"Dockerfile",
			"FROM alpine\nRUN printf old; printf untouched\n",
			"@@\n-printf old\n+printf \"ne",
		),
		("heredoc_capture", "s.sh", "echo old\nprintf keep\nEOF\n", "@@\n-old\n+<<EOF"),
		("shell_simple_expansion_capture", "s.sh", "echo \"$old\"; echo keep\n", "@@\n-\"$\n+\""),
		("shell_braced_expansion_capture", "s.sh", "echo \"${old}\"; echo keep\n", "@@\n-\"${\n+\""),
		(
			"same_end_constructs",
			"s.js",
			"if (ready) { if (ready) {\n  notify(x);\n}}\nfunction g() {\n  notify(x);\n}\n",
			"@@ if (ready) {\n-  notify(x);\n+  notify(y);",
		),
		(
			"julia_assignment_docs",
			"docs.jl",
			"\"\"\"Original x docs\"\"\"\nx = 1\n",
			"@@ \"\"\"Original x docs\"\"\"\n+y = 2",
		),
		("ruby_character_capture", "s.rb", "puts x\n", "@@\n-puts \n+puts ?"),
		("regex_flag_capture", "s.js", "const x = a / b/g;\n", "@@\n-a / b\n+/a"),
		(
			"raw_properties_quote_capture",
			"s.properties",
			"value=\"old untouched\nother=2\n",
			"@@\n-old\n+new\n+#",
		),
		(
			"opaque_borrowed_suffix",
			"nginx.conf",
			"server {\n    listen 80 ssl;\n    server_name example.com;\n}\n",
			"@@\n-listen 80\n+listen 8080; #",
		),
		(
			"make_assignment_comment_capture",
			"Makefile",
			"VALUE=old#tail\nall:\n\t@echo ok\n",
			"@@\n-VALUE=old#\n+VALUE=new ",
		),
		(
			"make_quoted_assignment_comment_capture",
			"Makefile",
			"VALUE=\"old#tail\"\nall:\n\t@echo ok\n",
			"@@\n-old#\n+new ",
		),
		(
			"make_unknown_recipe_context",
			"Makefile",
			".RECIPEPREFIX=+\nall:\n+@echo old#tail\n",
			"@@\n-old#\n+new #",
		),
		(
			"make_recipe_lost_tail_missing_separator",
			"Makefile",
			"all:\n\tprintf old_very_long_configuration_identifier#tail; echo keep\n",
			"@@\n-\tprintf old_very_long_configuration_identifier#tail echo keep\n+\tprintf \
			 new_very_long_configuration_identifier#tail # note; echo keep",
		),
		(
			"properties_raw_quote_multiline",
			"s.properties",
			"VALUE=\"old\nlong_configuration_identifier_tail; keep\n",
			"@@\n-VALUE=\"old\n-long_configuration_identifier_tail \
			 keep\n+VALUE=\"new\n+#long_configuration_identifier_tail; keep",
		),
		(
			"docker_embedded_expansion_capture",
			"Dockerfile",
			"FROM alpine\nRUN printf \"old$KEEP\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"docker_exposed_expansion_capture",
			"Dockerfile",
			"FROM alpine\nENV VALUE=\"old$KEEP\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"docker_path_expansion_capture",
			"Dockerfile",
			"FROM alpine\nWORKDIR /old$KEEP\n",
			"@@\n-/old\n+/new\\",
		),
		(
			"docker_declared_shell_expansion_capture",
			"Dockerfile",
			"FROM alpine\nSHELL [\"/bin/bash\", \"-c\"]\nRUN printf \"old$KEEP\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"docker_unknown_shell_context",
			"Dockerfile",
			"FROM alpine\nSHELL [\"custom-shell\", \"-c\"]\nRUN printf \"old$KEEP\"\n",
			"@@\n-old\n+new",
		),
		(
			"make_shell_expansion_capture",
			"Makefile",
			"all:\n\tprintf \"old$$KEEP\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"make_shell_braced_expansion_capture",
			"Makefile",
			"all:\n\tprintf \"old$${KEEP}\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"make_shell_command_substitution_capture",
			"Makefile",
			"all:\n\tprintf \"old$$(printf KEEP)\"\n",
			"@@\n-old\n+new\\",
		),
		(
			"make_unknown_shell_context",
			"Makefile",
			"SHELL := custom-shell\nall:\n\tprintf \"old$$KEEP\"\n",
			"@@\n-old\n+new",
		),
		(
			"make_at_prefix_comment_capture",
			"Makefile",
			"all:\n\t@printf old_very_long_configuration_identifier; echo keep\n",
			"@@\n-printf old_very_long_configuration_identifier\n+# note",
		),
		(
			"make_ignore_error_prefix_comment_capture",
			"Makefile",
			"all:\n\t-printf old_very_long_configuration_identifier; echo keep\n",
			"@@\n-printf old_very_long_configuration_identifier\n+# note",
		),
		(
			"make_recursive_prefix_comment_capture",
			"Makefile",
			"all:\n\t+printf old_very_long_configuration_identifier; echo keep\n",
			"@@\n-printf old_very_long_configuration_identifier\n+# note",
		),
		(
			"make_continuation_prefix_capture",
			"Makefile",
			"all:\n\tprintf old_very_long_configuration_identifier\\\n\t#tail; echo keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier ",
		),
		(
			"shell_continuation_word_capture",
			"s.sh",
			"printf old_very_long_configuration_identifier\\\n#tail; echo keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier ",
		),
		(
			"make_multiple_prefix_context",
			"Makefile",
			"all:\n\t@-printf old_very_long_configuration_identifier; echo keep\n",
			"@@\n-printf old_very_long_configuration_identifier\n+# note",
		),
		(
			"shell_newly_exposed_continuation",
			"s.sh",
			"printf old_very_long_configuration_identifier\\\n#one\\\n#two; echo keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier ",
		),
	] {
		p(label, EditMode::Patch, file, source, patch(file, diff), Want::Refuse, &mut fails).await;
	}
	for (label, file, source) in [
		(
			"normalized_substring",
			"s.js",
			"function f() { if (ready)  {\n    notify(x1);\n  }\n  if (done) {\n    notify(x);\n  \
			 }\n}\n"
				.to_owned(),
		),
		(
			"bom_substring",
			"s.js",
			format!(
				"{}function f() {{ if (ready) {{\n    notify(x1);\n  }}\n  if (done) {{\n    \
				 notify(x);\n  }}\n}}\n",
				"\u{feff}".repeat(8)
			),
		),
		(
			"earlier_attribute",
			"s.java",
			"class C {\n  @Attr void f() { if (ready) {\n    notify(x1);\n  }\n  if (done) {\n    \
			 notify(x);\n  }\n  }\n}\n"
				.to_owned(),
		),
		(
			"repeated_attribute_same_owner",
			"s.java",
			"class C {\n  @A @A void f() {\n    notify(x1);\n  }\n  void g() {\n    notify(x);\n  \
			 }\n}\n"
				.to_owned(),
		),
	] {
		p(
			label,
			EditMode::Patch,
			file,
			&source,
			patch(
				file,
				if label == "repeated_attribute_same_owner" {
					"@@ @A\n-    notify(x);\n+    notify(y);"
				} else {
					"@@ if (ready) {\n-    notify(x);\n+    notify(y);"
				},
			),
			Want::BytesOrRefuse(source.replacen("notify(x1)", "notify(y)", 1)),
			&mut fails,
		)
		.await;
	}
	both(
		"residual_rewrite_after_move",
		"s.txt",
		"root\na\nfoo\nb\nc\nend\n",
		"@@\n root\n+X\n a",
		"@@\n-a\n-foo\n-b\n-c\n+\n+b\n+c\n+foo",
		Want::Bytes("root\nX\n\nb\nc\nfoo\nend\n".into()),
		&mut fails,
	)
	.await;
	let lua = "local funcs = {\n  -- entry note\n  f = function() return 1 end,\n}\n";
	p(
		"function_mapping_entry",
		EditMode::Patch,
		"docs.lua",
		lua,
		patch("docs.lua", "@@ -- entry note\n+  g = function() return 2 end,"),
		Want::Bytes(lua.replacen(
			"  -- entry note\n",
			"  -- entry note\n  g = function() return 2 end,\n",
			1,
		)),
		&mut fails,
	)
	.await;
	for (label, source) in [
		("evaluated_function_call_is_not_literal", "-- setup note\nvalue = compute()\n"),
		("function_collection_is_not_binding", "-- setup note\nvalue = {function() return 1 end}\n"),
	] {
		p(
			label,
			EditMode::Patch,
			"s.lua",
			source,
			patch("s.lua", "@@ -- setup note\n+prepare()"),
			Want::Bytes(source.replacen("-- setup note\n", "-- setup note\nprepare()\n", 1)),
			&mut fails,
		)
		.await;
	}
	for (label, source, diff, expected) in [
		(
			"make_escaped_assignment_hash",
			"VALUE=old\\#tail\nall:\n\t@echo ok\n",
			"@@\n-VALUE=old\\#\n+VALUE=new ",
			"VALUE=new tail\nall:\n\t@echo ok\n",
		),
		(
			"make_recipe_word_hash_preserves_suffix",
			"all:\n\tprintf old#tail\n",
			"@@\n-old#\n+new",
			"all:\n\tprintf newtail\n",
		),
		(
			"make_raw_define_hash",
			"define VALUE\nold#tail\nendef\nall:\n\t@echo ok\n",
			"@@\n-old#\n+new ",
			"define VALUE\nnew tail\nendef\nall:\n\t@echo ok\n",
		),
	] {
		p(
			label,
			EditMode::Patch,
			"Makefile",
			source,
			patch("Makefile", diff),
			Want::Bytes(expected.into()),
			&mut fails,
		)
		.await;
	}
	p(
		"make_recipe_word_hash",
		EditMode::Patch,
		"Makefile",
		"all:\n\tprintf old#tail\n",
		patch("Makefile", "@@\n-old#\n+new "),
		Want::Refuse,
		&mut fails,
	)
	.await;
	for (label, file, source, diff, expected) in [
		(
			"json_dollar_literal",
			"s.json",
			"{\"VALUE\":\"old$KEEP\"}\n",
			"@@\n-old\n+new\\\\",
			"{\"VALUE\":\"new\\\\$KEEP\"}\n",
		),
		(
			"docker_json_dollar_literal",
			"Dockerfile",
			"FROM alpine\nRUN [\"printf\", \"old$KEEP\"]\n",
			"@@\n-old\n+new\\\\",
			"FROM alpine\nRUN [\"printf\", \"new\\\\$KEEP\"]\n",
		),
		(
			"docker_expansion_even_escape",
			"Dockerfile",
			"FROM alpine\nENV VALUE=\"old$KEEP\"\n",
			"@@\n-old\n+new\\\\",
			"FROM alpine\nENV VALUE=\"new\\\\$KEEP\"\n",
		),
		(
			"docker_declared_shell_retains_expansion",
			"Dockerfile",
			"FROM alpine\nSHELL [\"/bin/bash\", \"-c\"]\nRUN printf \"old$KEEP\"\n",
			"@@\n-old\n+new",
			"FROM alpine\nSHELL [\"/bin/bash\", \"-c\"]\nRUN printf \"new$KEEP\"\n",
		),
		(
			"make_retains_shell_expansion",
			"Makefile",
			"all:\n\tprintf \"old$$KEEP\"\n",
			"@@\n-old\n+new",
			"all:\n\tprintf \"new$$KEEP\"\n",
		),
		(
			"make_single_quoted_dollar",
			"Makefile",
			"all:\n\tprintf 'old$$KEEP'\n",
			"@@\n-old\n+new",
			"all:\n\tprintf 'new$$KEEP'\n",
		),
		(
			"make_exposed_reference_in_literal",
			"Makefile",
			"all:\n\tprintf 'old$(KEEP)'\n",
			"@@\n-old\n+new",
			"all:\n\tprintf 'new$(KEEP)'\n",
		),
		(
			"make_declared_shell_retains_expansion",
			"Makefile",
			"SHELL := /bin/bash\nall:\n\tprintf \"old$$KEEP\"\n",
			"@@\n-old\n+new",
			"SHELL := /bin/bash\nall:\n\tprintf \"new$$KEEP\"\n",
		),
		(
			"make_continuation_retained",
			"Makefile",
			"all:\n\tprintf old_very_long_configuration_identifier\\\n\t#tail; echo keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier",
			"all:\n\tprintf new_very_long_configuration_identifier\\\n\t#tail; echo keep\n",
		),
		(
			"make_continuation_literal_prefix",
			"Makefile",
			"all:\n\tprintf old_very_long_configuration_identifier\\\n\t@printf keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier",
			"all:\n\tprintf new_very_long_configuration_identifier\\\n\t@printf keep\n",
		),
		(
			"julia_collection_not_docstring",
			"s.jl",
			"[\"ordinary\"]\nx = 1\n",
			"@@ [\"ordinary\"]\n+prepare()",
			"[\"ordinary\"]\nprepare()\nx = 1\n",
		),
		(
			"julia_unary_not_docstring",
			"s.jl",
			"!\"ordinary\"\nx = 1\n",
			"@@ !\"ordinary\"\n+prepare()",
			"!\"ordinary\"\nprepare()\nx = 1\n",
		),
		(
			"shell_retained_continuation_word",
			"s.sh",
			"printf old_very_long_configuration_identifier\\\n#tail; echo keep\n",
			"@@\n-old_very_long_configuration_identifier\n+new_very_long_configuration_identifier",
			"printf new_very_long_configuration_identifier\\\n#tail; echo keep\n",
		),
		(
			"shell_real_comment_continuation",
			"s.sh",
			"printf old\n# real comment\\\nprintf keep\n",
			"@@\n-old\n+new ",
			"printf new \n# real comment\\\nprintf keep\n",
		),
		(
			"shell_literal_continuation",
			"s.sh",
			"printf 'old\\\n#tail'; echo keep\n",
			"@@\n-old\n+new ",
			"printf 'new \\\n#tail'; echo keep\n",
		),
	] {
		p(
			label,
			EditMode::Patch,
			file,
			source,
			patch(file, diff),
			Want::Bytes(expected.into()),
			&mut fails,
		)
		.await;
	}
	let attributes =
		format!("// unique first\n{}fn f() {{}}\n", "#[allow(dead_code)]\n".repeat(2000));
	p(
		"long_attribute_run_keeps_owner",
		EditMode::Patch,
		"lib.rs",
		&attributes,
		patch("lib.rs", "@@ // unique first\n+fn g() {}"),
		Want::Refuse,
		&mut fails,
	)
	.await;
	assert!(fails.is_empty(), "guard counterexamples: {fails:?}");
}

#[tokio::test]
async fn deeply_wrapped_julia_docs_stay_attached() {
	let row = format!("{}\"\"\"docs\"\"\"{}", "(".repeat(20000), ")".repeat(20000));
	let source = format!("{row}\nx = 1\n");
	let ws = Workspace::new(EditMode::Patch);
	ws.write("docs.jl", &source);
	let writer = DiskWriter::default();
	let result = ws
		.apply_json(&patch("docs.jl", &format!("@@ {row}\n+y = 2")), &writer)
		.await;
	assert!(result.is_err());
	assert_eq!(writer.requests.lock().len(), 0);
	assert_eq!(ws.read("docs.jl").unwrap(), source);
}
