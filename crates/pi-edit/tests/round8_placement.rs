//! Regression coverage for chain scopes, atomic edge ties, insertion ownership,
//! and partial-line token preservation.
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
async fn round8_placement_contracts() {
	let mut fails = Vec::new();
	let f = &mut fails;

	// ---- R8RegionReview
	// RX0 (P1 claim): a chain whose next link starts on a later row must not get a
	// region that stops at the first callback.
	let s_js = "db.save(user).then(() => {\n  res.sendStatus(200);\n})\n.catch(() => {\n  \
	            res.sendStatus(500);\n});\n";
	p(
		"RX0a_CHAIN_NEXT_LINK_ON_LATER_ROW_JS",
		EditMode::Patch,
		"s.js",
		s_js,
		patch(
			"s.js",
			"@@ db.save(user).then(() => {\n-  res.sendStatus(500);\n+  res.sendStatus(503);",
		),
		Want::BytesOrRefuse(s_js.replacen("res.sendStatus(500);", "res.sendStatus(503);", 1)),
		f,
	)
	.await;
	let f_java =
		"class F {\n    void run() {\n        CompletableFuture.supplyAsync(() -> {\n            \
		 return load(1);\n        })\n        .thenApply(r -> {\n            return load(2);\n        \
		 });\n    }\n}\n";
	p(
		"RX0b_CHAIN_NEXT_LINK_ON_LATER_ROW_JAVA",
		EditMode::Patch,
		"F.java",
		f_java,
		patch(
			"F.java",
			"@@ CompletableFuture.supplyAsync(() -> {\n-            return load(2);\n+            \
			 return load(3);",
		),
		Want::BytesOrRefuse(f_java.replacen("return load(2);", "return load(3);", 1)),
		f,
	)
	.await;
	// RX1 (P2): the statement's own continuation lines stay in the anchor's region.
	let s2 = "db.save(user).then(() => {\n  ok();\n})\n.catch(handleError);\n";
	p(
		"RX1a_CHAIN_CONTINUATION_LINE_JS",
		EditMode::Patch,
		"s.js",
		s2,
		patch("s.js", "@@ db.save(user).then(() => {\n-.catch(handleError);\n+.catch(reportError);"),
		Want::Bytes("db.save(user).then(() => {\n  ok();\n})\n.catch(reportError);\n".into()),
		f,
	)
	.await;
	let rs = "async fn main() -> std::io::Result<()> {\n    HttpServer::new(|| {\n        \
	          App::new().service(index)\n    })\n    .bind((\"127.0.0.1\", 8080))?\n    .run()\n    \
	          .await\n}\n";
	p(
		"RX1b_CHAIN_CONTINUATION_LINE_RUST",
		EditMode::Patch,
		"main.rs",
		rs,
		patch(
			"main.rs",
			"@@ HttpServer::new(|| {\n-    .bind((\"127.0.0.1\", 8080))?\n+    .bind((\"0.0.0.0\", \
			 8080))?",
		),
		Want::Bytes(rs.replacen("\"127.0.0.1\"", "\"0.0.0.0\"", 1)),
		f,
	)
	.await;

	// ---- R8MultiHunkReview
	// MH0 (P1 claim): past 2^16 line pairs the fallback split must keep the
	// trailing inserted edge as its own atom.
	let big = |n: usize| -> (String, String) {
		let mut orig = String::from("a\n");
		let mut h1 = String::from("@@\n a\n");
		for i in 0..n {
			writeln!(orig, "c{i}").unwrap();
			writeln!(h1, "-c{i}").unwrap();
		}
		for i in 0..n {
			writeln!(h1, "+C{i}").unwrap();
		}
		h1.push_str("+X\n d");
		orig.push_str("d\n");
		(orig, h1)
	};
	let (orig256, h256) = big(256);
	both("MH0a_LARGE_BLOCK_TRAIL_EDGE_256", "t.txt", &orig256, &h256, "@@\n+Y\n d", Want::Refuse, f)
		.await;
	let (orig255, h255) = big(255);
	both(
		"MH0a_CTRL_LARGE_BLOCK_TRAIL_EDGE_255",
		"t.txt",
		&orig255,
		&h255,
		"@@\n+Y\n d",
		Want::Refuse,
		f,
	)
	.await;
	let (xs, ys, zs) = ("x".repeat(3000), "y".repeat(3000), "z".repeat(3000));
	both(
		"MH0b_LONG_LINES_NO_SHARED_TOKENS",
		"t.txt",
		&format!("a\n{xs}\nd\n"),
		&format!("@@\n a\n-{xs}\n+{ys}\n+{zs}\n d"),
		"@@\n+Y\n d",
		Want::Refuse,
		f,
	)
	.await;
	// MH1 (P1 claim): prove_by_anchor_line must rank proofs before dropping
	// consumed ones.
	both(
		"MH1_PROOF_RANK_BEFORE_CONSUMED",
		"t.txt",
		"[a]\nval = 1\n[a]\nval = 1   \n",
		"@@ [a]\n [a]\n-val = 1\n+val = 2",
		"@@ [a]\n [a]\n-val = 1\n+val = 3",
		Want::Refuse,
		f,
	)
	.await;
	// A fixed rewrite consumes the other hunk's exact changed-row evidence;
	// it cannot fall through to the looser block in either order.
	both(
		"MH2_CONSUMED_BEST_FRAME_MULTI_BLOCK",
		"t.txt",
		"[a]\nk\nv\nx\nw\n[b]\nk\nv\nx\nw   \n",
		"@@ [a]\n-w\n+W1\n [b]",
		"@@ [a]\n k\n-v\n+V\n x\n-w\n+W2",
		Want::Refuse,
		f,
	)
	.await;
	// MH3 (P3): the same_gap refusal names both hunks.
	both(
		"MH3_SAME_GAP_REFUSAL_NAMES_HUNKS",
		"t.txt",
		"a\nvalue = 1\n",
		"@@\n a\n-value = 1\n+extra = 0\n+value = 2",
		"@@ a\n+E",
		Want::RefuseMsg(|m| m.contains("#1") && m.contains("#2")),
		f,
	)
	.await;

	// ---- R8InsertionReview
	// IR8a (P1 claim): brace-less else / else-if / `} else` bodies are guarded
	// against push-out.
	p(
		"IR8a1_JS_BRACELESS_ELSE",
		EditMode::Patch,
		"s.js",
		"function f(a) {\n  if (a)\n    x();\n  else\n    y();\n}\n",
		patch("s.js", "@@ else\n+    log();"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IR8a2_JS_BRACELESS_ELSE_IF",
		EditMode::Patch,
		"s.js",
		"function f(a, b) {\n  if (a)\n    x();\n  else if (b)\n    y();\n}\n",
		patch("s.js", "@@ else if (b)\n+    log();"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"IR8a3_JAVA_BRACELESS_ELSE_IF",
		EditMode::Patch,
		"A.java",
		"class A {\n    void f(boolean a, boolean b) {\n        if (a)\n            x();\n        \
		 else if (b)\n            y();\n    }\n}\n",
		patch("A.java", "@@ else if (b)\n+            log();"),
		Want::RefuseMsg(|m| {
			m.contains("'else if (b)'") && !m.contains("'if (a)'") && m.contains("'y();'")
		}),
		f,
	)
	.await;
	p("IR8a4_JAVA_CLOSE_BRACE_ELSE", EditMode::Patch, "A.java",
		"class A {\n    void f(boolean a) {\n        if (a) {\n            x();\n        } else\n            y();\n    }\n}\n",
		patch("A.java", "@@ } else\n+            log();"), Want::Refuse, f).await;
	// IR8b (P1 claim): C# lock/fixed bare statement bodies are guarded too.
	p(
		"IR8b_CS_LOCK_BARE_BODY",
		EditMode::Patch,
		"t.cs",
		"class C\n{\n    void F()\n    {\n        lock (gate)\n            count++;\n    }\n}\n",
		patch("t.cs", "@@ lock (gate)\n+            Log();"),
		Want::Refuse,
		f,
	)
	.await;
	// IR8c (P2): a case label inserted under a case falls through instead of being
	// refused.
	let sw = "function f(kind) {\n  switch (kind) {\n    case \"a\":\n      return 1;\n    \
	          default:\n      return 0;\n  }\n}\n";
	p(
		"IR8c_JS_CASE_LABEL_FALLTHROUGH",
		EditMode::Patch,
		"s.js",
		sw,
		patch("s.js", "@@ case \"a\":\n+    case \"b\":"),
		Want::Bytes(
			"function f(kind) {\n  switch (kind) {\n    case \"a\":\n    case \"b\":\n      return \
			 1;\n    default:\n      return 0;\n  }\n}\n"
				.into(),
		),
		f,
	)
	.await;
	// IR8d (P3 kill row, should refuse today): the post-growth fallback where H
	// breaks.
	p(
		"IR8d_C_ENUM_POST_GROWTH_FALLBACK",
		EditMode::Patch,
		"e.c",
		"enum color\n{\n  RED,\n  GREEN\n};\n",
		patch("e.c", "@@ enum color\n+palette[] ="),
		Want::Refuse,
		f,
	)
	.await;

	// ---- R8TokenGuardReview
	let cfg = "CONFIG = dict(\n    timeout=30,\n    retries=3,\n)\n";
	// TX0 (P1 claim): a trailing separator must not be substituted for a respelled
	// last token.
	p("TX0a_PY_SEPARATOR_SUBSTITUTED", EditMode::Patch, "c.py", "def make(user_name, age):\n    return dict(\n        name=user_name,\n        age=age,\n    )\n",
		patch("c.py", "@@\n     return dict(\n-        name=usr_name\n+        name=user_name.strip()\n         age=age,\n     )"),
		Want::Refuse, f).await;
	p(
		"TX0b_JS_SEPARATOR_SUBSTITUTED",
		EditMode::Patch,
		"t.js",
		"function make(userName, age) {\n  return {\n    name: userName,\n    age: age,\n  };\n}\n",
		patch(
			"t.js",
			"@@\n   return {\n-    name: username\n+    name: userName.trim()\n     age: age,\n   };",
		),
		Want::Refuse,
		f,
	)
	.await;
	// TX1 (P1 claim): Rust lifetimes are not quotes (bracket depth must see `(`
	// after `&'a`).
	let srs = "struct S<'a, 'b> {\n    cb: &'a str,\n    name: &'b str,\n}\n";
	p(
		"TX1a_RUST_LIFETIMES_HIDE_BRACKET",
		EditMode::Patch,
		"s.rs",
		srs,
		patch(
			"s.rs",
			"@@\n struct S<'a, 'b> {\n-    cb: &'a str\n+    cb: &'a dyn Fn(&'b str,\n+        u32) \
			 -> bool\n     name: &'b str,\n }",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TX1b_RUST_LIFETIME_COMMENT_APPLIES",
		EditMode::Patch,
		"s.rs",
		srs,
		patch(
			"s.rs",
			"@@\n struct S<'a, 'b> {\n-    cb: &'a str\n+    cb: &'b str, // it's borrowed\n     \
			 name: &'b str,\n }",
		),
		Want::Bytes(
			"struct S<'a, 'b> {\n    cb: &'b str, // it's borrowed\n    name: &'b str,\n}\n".into(),
		),
		f,
	)
	.await;
	// TX2 (P1 claim): SCSS has `//` line comments.
	let scss = ".a {\n  color: red;\n  margin: 0;\n}\n";
	p(
		"TX2a_SCSS_SEPARATOR_IN_NEW_COMMENT",
		EditMode::Patch,
		"s.scss",
		scss,
		patch("s.scss", "@@\n .a {\n-  color: red\n+  color: blue // was red;\n   margin: 0;\n }"),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TX2b_SCSS_TRAILING_COMMENT_APPLIES",
		EditMode::Patch,
		"s.scss",
		scss,
		patch("s.scss", "@@\n .a {\n-  color: red\n+  color: blue; // brand\n   margin: 0;\n }"),
		Want::Bytes(".a {\n  color: blue; // brand\n  margin: 0;\n}\n".into()),
		f,
	)
	.await;
	// TX3 (P1 claim): PHP `#[` opens an attribute, not a comment.
	let php = "<?php\nclass C {\n    public function __construct(\n        #[SensitiveParameter] \
	           array $keys,\n        int $n,\n    ) {}\n}\n";
	p("TX3a_PHP_ATTRIBUTE_NOT_COMMENT", EditMode::Patch, "C.php", php,
		patch("C.php", "@@\n     public function __construct(\n-        #[SensitiveParameter] array $keys\n+        #[SensitiveParameter] array $keys = ['a',\n+            'b']\n         int $n,"),
		Want::Refuse, f).await;
	p("TX3b_PHP_ATTRIBUTE_TRAILING_COMMENT_APPLIES", EditMode::Patch, "C.php", php,
		patch("C.php", "@@\n     public function __construct(\n-        #[SensitiveParameter] array $keys\n+        #[SensitiveParameter] array $keys, // secret\n         int $n,"),
		Want::Bytes(php.replacen("array $keys,\n", "array $keys, // secret\n", 1)), f).await;
	// TX4 (P1 claim): in .conf files `;` terminates directives; it is a comment
	// only at line start.
	let ngx = "server {\n    listen 80;\n    server_name example.com;\n}\n";
	p(
		"TX4a_NGINX_SEMICOLON_IN_NEW_COMMENT",
		EditMode::Patch,
		"nginx.conf",
		ngx,
		patch(
			"nginx.conf",
			"@@\n server {\n-    listen 80\n+    listen 8080 # was 80;\n     server_name example.com;",
		),
		Want::Refuse,
		f,
	)
	.await;
	p(
		"TX4b_NGINX_TRAILING_COMMENT_APPLIES",
		EditMode::Patch,
		"nginx.conf",
		ngx,
		patch(
			"nginx.conf",
			"@@\n server {\n-    listen 80\n+    listen 8080; # http\n     server_name example.com;",
		),
		Want::Bytes("server {\n    listen 8080; # http\n    server_name example.com;\n}\n".into()),
		f,
	)
	.await;
	// TX5 (P2): a multi-line rewrite may carry the separator on its closing line
	// (HEAD and round 6 applied).
	p("TX5_MULTILINE_REWRITE_SEPARATOR_ON_CLOSING_LINE", EditMode::Patch, "c.py", cfg,
		patch("c.py", "@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=max(30,\n+        MIN_TIMEOUT),\n     retries=3,\n )"),
		Want::Bytes("CONFIG = dict(\n    timeout=max(30,\n        MIN_TIMEOUT),\n    retries=3,\n)\n".into()), f).await;
	// TX6 (P2): a comment-only added line quoting the old code is not the rewrite's
	// counterpart.
	p(
		"TX6_COMMENT_LINE_NOT_COUNTERPART",
		EditMode::Patch,
		"c.py",
		"CONFIG = dict(\n    timeout=compute_timeout(base),\n    retries=3,\n)\n",
		patch(
			"c.py",
			"@@\n CONFIG = dict(\n-    timeout=compute_timeout(base)\n+    # was \
			 compute_timeout(base)\n+    timeout=60,\n     retries=3,\n )",
		),
		Want::Bytes(
			"CONFIG = dict(\n    # was compute_timeout(base)\n    timeout=60,\n    retries=3,\n)\n"
				.into(),
		),
		f,
	)
	.await;
	// TX7 (P2): a new trailing comment repeating a removed token must not capture
	// the alignment.
	p(
		"TX7a_PY_COMMENT_REPEATS_OLD_VALUE",
		EditMode::Patch,
		"c.py",
		cfg,
		patch(
			"c.py",
			"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=60,  # was 30\n     retries=3,\n )",
		),
		Want::Bytes("CONFIG = dict(\n    timeout=60,  # was 30\n    retries=3,\n)\n".into()),
		f,
	)
	.await;
	p(
		"TX7b_JS_COMMENT_REPEATS_OLD_VALUE",
		EditMode::Patch,
		"t.js",
		"const o = {\n  a: 1,\n  b: 2,\n};\n",
		patch("t.js", "@@\n const o = {\n-  a: 1\n+  a: 5, // was 1\n   b: 2,\n };"),
		Want::Bytes("const o = {\n  a: 5, // was 1\n  b: 2,\n};\n".into()),
		f,
	)
	.await;
	// TX8 (P3 kill row, should apply now): a quoted bracket does not count toward
	// depth.
	p(
		"TX8_QUOTED_BRACKET_DEPTH",
		EditMode::Patch,
		"c.py",
		cfg,
		patch(
			"c.py",
			"@@\n CONFIG = dict(\n-    timeout=30\n+    timeout=fmt(\"(\", 30),\n     retries=3,\n )",
		),
		Want::Bytes("CONFIG = dict(\n    timeout=fmt(\"(\", 30),\n    retries=3,\n)\n".into()),
		f,
	)
	.await;

	assert!(fails.is_empty(), "failed contracts: {fails:?}");
}

#[tokio::test]
async fn strict_anchor_proof_survives_a_looser_twin() {
	let mut failures = Vec::new();
	p(
		"strict proof control",
		EditMode::Patch,
		"t.txt",
		"[a]\nval = 1\n[a]\nval = 1   \n",
		patch("t.txt", "@@ [a]\n [a]\n-val = 1\n+val = 2"),
		Want::Bytes("[a]\nval = 2\n[a]\nval = 1   \n".into()),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn markdown_heading_is_not_case_fallthrough() {
	let mut failures = Vec::new();
	p(
		"section ownership",
		EditMode::Patch,
		"d.md",
		"## Usage\n\nRun it.\n",
		patch("d.md", "@@ ## Usage\n+## Install"),
		Want::RefuseMsg(|m| m.contains("Run it.") && !m.contains("braces")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn replacement_edge_refusal_names_the_contested_gap() {
	let mut failures = Vec::new();
	both(
		"replacement gap frame",
		"t.txt",
		"a\nx\nd\n",
		"@@\n a\n-x\n+q\n d",
		"@@\n+Y\n d",
		Want::RefuseMsg(|m| m.contains("#1") && m.contains("#2") && m.contains("line 3")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn append_after_an_inline_attribute_keeps_its_owner() {
	let mut failures = Vec::new();
	p(
		"append rows",
		EditMode::Patch,
		"lib.rs",
		"#[test] fn f() {}",
		patch("lib.rs", "@@ #[test] fn f() {}\n+fn g() {}"),
		Want::Bytes("#[test] fn f() {}\nfn g() {}".into()),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn long_tokens_keep_a_trailing_separator_without_quadratic_similarity() {
	let a = "a".repeat(20_000);
	let b = "b".repeat(20_000);
	let original = format!("run(\n    {a}, {b},\n)\n");
	let diff = format!("@@\n run(\n-    {a}, {b}\n+    {a}, {b},  # keep\n )");
	let mut failures = Vec::new();
	p(
		"long token separator",
		EditMode::Patch,
		"c.py",
		&original,
		patch("c.py", &diff),
		Want::Bytes(format!("run(\n    {a}, {b},  # keep\n)\n")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn function_splitting_is_not_case_fallthrough() {
	let mut failures = Vec::new();
	p(
		"function ownership",
		EditMode::Patch,
		"f.py",
		"def f():\n    x()\n",
		patch("f.py", "@@ def f():\n+    log()\n+def g():"),
		Want::Refuse,
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn reordered_comments_keep_their_own_counterparts() {
	let mut failures = Vec::new();
	p(
		"comment counterparts",
		EditMode::Patch,
		"s.rs",
		"/// Alpha\n// Beta\nfn f() {}\n",
		patch("s.rs", "@@\n-// Alpha\n-// Beta\n+// Beta\n+/// Alpha better\n fn f() {}"),
		Want::Bytes("// Beta\n/// Alpha better\nfn f() {}\n".into()),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn existing_comments_cannot_capture_a_lost_code_separator() {
	let mut failures = Vec::new();
	p("TX9 code loss with existing comment", EditMode::Patch, "c.py",
		"CONFIG = dict(\n    timeout=30, # note\n    retries=3,\n)\n",
		patch("c.py", "@@\n CONFIG = dict(\n-    timeout=30 # note\n+    timeout=60 # note was 30, # note\n     retries=3,\n )"),
		Want::Refuse, &mut failures).await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn spelling_counts_compare_corresponding_code_and_comment_segments() {
	let mut failures = Vec::new();
	p(
		"TX10 moved spelling with existing comment",
		EditMode::Patch,
		"c.py",
		"def run(ctx):\n    send(userId, flag) # user_id\n    return ctx\n",
		patch(
			"c.py",
			"@@\n def run(ctx):\n-    send(user_id, flag) # user_id\n+    send(ctx, user_id) # \
			 user_id\n     return ctx",
		),
		Want::Refuse,
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn leading_blank_body_lines_preserve_python_statement_ownership() {
	let mut failures = Vec::new();
	p(
		"leading blank body",
		EditMode::Patch,
		"f.py",
		"def f():\n    x()\n",
		patch("f.py", "@@ def f():\n+\n+    log()"),
		Want::Bytes("def f():\n\n    log()\n    x()\n".into()),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn swift_chain_scope_excludes_the_enclosing_property_closer() {
	let original =
		"struct V {\n  var body: some View {\n    VStack {\n      Text(\"a\")\n    }\n    \
		 .padding()\n  }\n}\n";
	let mut failures = Vec::new();
	p(
		"Swift outer closer boundary",
		EditMode::Patch,
		"v.swift",
		original,
		patch("v.swift", "@@ VStack {\n-  }\n+  }.background(Color.red)"),
		Want::BytesOrRefuse(original.replacen("    }\n", "    }.background(Color.red)\n", 1)),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn attribute_only_insertions_attach_to_the_following_item() {
	let mut failures = Vec::new();
	for (path, original, diff, expected) in [
		(
			"d.py",
			"x = 1\n\n\ndef f():\n    pass\n",
			"@@ x = 1\n+@cache",
			"x = 1\n@cache\n\n\ndef f():\n    pass\n",
		),
		(
			"A.java",
			"class A {\n    int a;\n    public void m() {\n    }\n}\n",
			"@@ int a;\n+    @Override",
			"class A {\n    int a;\n    @Override\n    public void m() {\n    }\n}\n",
		),
		(
			"C.cs",
			"class C\n{\n    int a;\n    public void M()\n    {\n    }\n}\n",
			"@@ int a;\n+    [Obsolete]",
			"class C\n{\n    int a;\n    [Obsolete]\n    public void M()\n    {\n    }\n}\n",
		),
	] {
		p(
			path,
			EditMode::Patch,
			path,
			original,
			patch(path, diff),
			Want::Bytes(expected.into()),
			&mut failures,
		)
		.await;
	}
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn an_argument_insertion_without_a_comma_cannot_capture_the_callback() {
	let original = "app.get('/x',\n  auth,\n  (req, res) => {\n    res.send();\n  });\n";
	let mut failures = Vec::new();
	p(
		"no comma callback owner",
		EditMode::Patch,
		"s.js",
		original,
		patch("s.js", "@@ auth,\n+  audit"),
		Want::RefuseMsg(|m| m.contains("(req, res) =>")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn an_insertion_cannot_detach_a_csharp_expression_body() {
	let mut failures = Vec::new();
	p(
		"expression body owner",
		EditMode::Patch,
		"C.cs",
		"class C\n{\n    [Fact]\n    public int Compute(int a)\n        => a + 1;\n}\n",
		patch("C.cs", "@@ public int Compute(int a)\n+        log();"),
		Want::RefuseMsg(|m| m.contains("=> a + 1")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test]
async fn an_else_word_in_a_comment_does_not_name_the_statement_owner() {
	let mut failures = Vec::new();
	p(
		"comment is not an else branch",
		EditMode::Patch,
		"c.js",
		"function f() {\n  // else\n  x();\n}\n",
		patch("c.js", "@@ // else\n+  }\n+function g() {"),
		Want::RefuseMsg(|m| m.contains("'function f() {'") && m.contains("'x();'")),
		&mut failures,
	)
	.await;
	assert!(failures.is_empty(), "{failures:?}");
}
