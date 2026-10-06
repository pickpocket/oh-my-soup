//! Grammar-directed generation, mutation, splicing, and reduction for the
//! `hashline_stream` container (`stream_case.rs`).
//!
//! The hashline language (`grammars/hashline.lark`) is non-recursive:
//! payload → sections (`[path#TAG]`) → hunks (one op row + `+` body rows).
//! [`Tree`] is that derivation tree recovered lexically from ANY payload,
//! including invalid ones, and renders back byte-identically, so structural
//! operators compose with libFuzzer's byte mutations:
//!
//! - [`generate_case`] / [`generate_hunk`] walk the grammar with a seeded
//!   choice stream, repairing the context-sensitive parts afterwards: tags
//!   become `{{tag:PATH}}` placeholders the harness resolves to real content
//!   hashes, and anchors land inside the target file's lines.
//! - [`mutate`] regenerates a suffix of hunks, replaces/duplicates/drops one
//!   hunk or section, repairs tags/anchors after byte-level damage, edits a
//!   file line, or flips control lanes.
//! - [`crossover`] splices a section prefix of one input with a section suffix
//!   of another, retargeting foreign headers to the host's files.
//! - [`reduce`] deletes whole files, sections, hunks, rows, and file lines
//!   instead of arbitrary byte ranges, so reduced inputs stay well formed.

use crate::stream_case::{StreamCase, control, tag_placeholder};

/// SplitMix64: deterministic per seed, identical on every platform.
pub struct Rng(u64);

impl Rng {
	pub const fn new(seed: u64) -> Self {
		Self(seed)
	}

	pub fn next_u64(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^ (z >> 31)
	}

	/// Uniform in `0..n`; `0` when `n == 0`.
	pub fn below(&mut self, n: usize) -> usize {
		if n == 0 {
			0
		} else {
			(self.next_u64() % n as u64) as usize
		}
	}

	/// Uniform in `lo..=hi`.
	pub fn range(&mut self, lo: usize, hi: usize) -> usize {
		lo + self.below(hi - lo + 1)
	}

	pub fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
		self.next_u64() % denominator < numerator
	}

	pub fn byte(&mut self) -> u8 {
		self.next_u64() as u8
	}
}

/// Payload derivation tree. Rows are the payload split on `\n`; rendering
/// joins them back, so `Tree::parse(p).render() == p` for every `p`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
	pub sections: Vec<Section>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
	/// `None` only for rows before the first header.
	pub header: Option<String>,
	pub hunks:  Vec<Vec<String>>,
}

impl Section {
	/// Header path (`[path#TAG]` / `[path]`), if the header has that shape.
	pub fn path(&self) -> Option<&str> {
		let inner = self
			.header
			.as_deref()?
			.trim()
			.strip_prefix('[')?
			.strip_suffix(']')?;
		let path = inner.rsplit_once('#').map_or(inner, |(path, _)| path);
		(!path.is_empty()).then_some(path)
	}
}

fn is_header(row: &str) -> bool {
	let row = row.trim();
	row.len() >= 2 && row.starts_with('[') && row.ends_with(']')
}

/// Op rows (and any other non-body, non-blank row) open a hunk.
fn opens_hunk(row: &str) -> bool {
	!row.is_empty() && !row.starts_with('+')
}

impl Tree {
	pub fn parse(payload: &str) -> Self {
		let mut sections = vec![Section { header: None, hunks: Vec::new() }];
		for row in payload.split('\n') {
			if is_header(row) {
				sections.push(Section { header: Some(row.to_owned()), hunks: Vec::new() });
				continue;
			}
			let section = sections.last_mut().expect("at least one section");
			if !opens_hunk(row)
				&& let Some(hunk) = section.hunks.last_mut()
			{
				hunk.push(row.to_owned());
			} else {
				section.hunks.push(vec![row.to_owned()]);
			}
		}
		if sections[0].hunks.is_empty() && sections.len() > 1 {
			sections.remove(0);
		}
		Self { sections }
	}

	pub fn render(&self) -> String {
		let mut rows: Vec<&str> = Vec::new();
		for section in &self.sections {
			if let Some(header) = &section.header {
				rows.push(header);
			}
			for hunk in &section.hunks {
				rows.extend(hunk.iter().map(String::as_str));
			}
		}
		rows.join("\n")
	}

	/// `(section, hunk)` index pairs.
	fn hunk_slots(&self) -> Vec<(usize, usize)> {
		self
			.sections
			.iter()
			.enumerate()
			.flat_map(|(s, section)| (0..section.hunks.len()).map(move |h| (s, h)))
			.collect()
	}
}

const REGISTERS: [&str; 3] = ["r", "fn", "a-1"];
const FILE_NAMES: [&str; 5] = ["a.txt", "src/b.ts", "c.py", "d.md", "dir with spaces/e.rs"];

/// Addressable lines of `content` (a final newline adds no line).
fn file_lines(content: &str) -> Vec<&str> {
	let mut lines: Vec<&str> = content.split('\n').collect();
	if content.ends_with('\n') {
		lines.pop();
	}
	lines
}

fn body_row(rng: &mut Rng, lines: &[&str]) -> String {
	match rng.below(6) {
		// Echo of an existing line: boundary-echo repair paths.
		0 | 1 if !lines.is_empty() => format!("+{}", lines[rng.below(lines.len())]),
		2 => "+".to_owned(),
		3 => format!("+  fz{:04x}", rng.next_u64() as u16),
		_ => format!("+fz{:04x}", rng.next_u64() as u16),
	}
}

fn body(rng: &mut Rng, lines: &[&str], rows: &mut Vec<String>) {
	for _ in 0..rng.range(1, 3) {
		rows.push(body_row(rng, lines));
	}
}

fn register(rng: &mut Rng) -> &'static str {
	REGISTERS[rng.below(REGISTERS.len())]
}

/// One grammar-valid hunk whose anchors lie in `1..=lines.len()`.
pub fn generate_hunk(rng: &mut Rng, lines: &[&str]) -> Vec<String> {
	let count = lines.len().max(1);
	let a = rng.range(1, count);
	let b = rng.range(a, count.min(a + 3));
	let mut rows = Vec::with_capacity(4);
	match rng.below(16) {
		0..=3 => {
			rows.push(format!("PUT {a}.={b}:"));
			body(rng, lines, &mut rows);
		},
		4 => {
			rows.push(format!("PUT {a}*:"));
			body(rng, lines, &mut rows);
		},
		5 => {
			rows.push(format!("PUT <{a}:"));
			body(rng, lines, &mut rows);
		},
		6 => {
			rows.push(format!("PUT >{a}:"));
			body(rng, lines, &mut rows);
		},
		7 => {
			rows.push(format!("PUT >{a}*:"));
			body(rng, lines, &mut rows);
		},
		8 => {
			rows.push("PUT >$:".to_owned());
			body(rng, lines, &mut rows);
		},
		9 => rows.push(if rng.chance(1, 2) {
			format!("CUT {a}.={b} @{}", register(rng))
		} else {
			format!("CUT {a}.={b}")
		}),
		10 => rows.push(format!("CUT {a}*")),
		11 => rows.push(format!("PUT <{a} @{}", register(rng))),
		12 => rows.push(format!("PUT >{a}")),
		13 => rows.push(format!("PUT {a}.={b} @{}", register(rng))),
		14 if rng.chance(1, 4) => rows.push("REM".to_owned()),
		// Identity replace: the no-op/loop-guard lane.
		14 => {
			rows.push(format!("PUT {a}.={a}:"));
			rows.push(format!("+{}", lines.get(a - 1).copied().unwrap_or_default()));
		},
		_ => rows.push(format!("MV {}", FILE_NAMES[rng.below(FILE_NAMES.len())])),
	}
	rows
}

fn header_for(rng: &mut Rng, path: &str) -> String {
	match rng.below(12) {
		// Stale tag: exercises the mismatch/recovery lane.
		0 => format!("[{path}#{:04X}]", rng.next_u64() as u16),
		1 => format!("[{path}]"),
		_ => format!("[{path}#{}]", tag_placeholder(path)),
	}
}

fn generate_file(rng: &mut Rng, path: &str) -> String {
	let count = rng.range(1, 12);
	let code = path.ends_with(".ts") || path.ends_with(".rs") || path.ends_with(".py");
	let mut out = String::new();
	let mut depth = 0usize;
	for index in 0..count {
		let indent = "  ".repeat(depth);
		if code && depth < 2 && rng.chance(1, 4) && index + 1 < count {
			let opener = if path.ends_with(".py") { ":" } else { " {" };
			out.push_str(&format!("{indent}block{index}(){opener}\n"));
			depth += 1;
		} else if code && depth > 0 && !path.ends_with(".py") && rng.chance(1, 3) {
			depth -= 1;
			out.push_str(&format!("{}}}\n", "  ".repeat(depth)));
		} else {
			out.push_str(&format!("{indent}line{index} fz{:04x}\n", rng.next_u64() as u16));
		}
	}
	if !path.ends_with(".py") {
		while depth > 0 {
			depth -= 1;
			out.push_str(&format!("{}}}\n", "  ".repeat(depth)));
		}
	}
	if rng.chance(1, 8) {
		out.pop();
	}
	out
}

fn generate_section(rng: &mut Rng, case: &StreamCase) -> Section {
	let (path, content) = if case.files.is_empty() {
		("a.txt", "")
	} else {
		let (path, content) = &case.files[rng.below(case.files.len())];
		(path.as_str(), content.as_str())
	};
	let lines = file_lines(content);
	let hunks = (0..rng.range(1, 3))
		.map(|_| generate_hunk(rng, &lines))
		.collect();
	Section { header: Some(header_for(rng, path)), hunks }
}

/// A fresh grammar-walked case: 1–2 files, 1–2 sections of 1–3 hunks.
pub fn generate_case(rng: &mut Rng) -> StreamCase {
	let mut case = StreamCase { control: rng.byte(), files: Vec::new(), payload: String::new() };
	for _ in 0..rng.range(1, 2) {
		let path = FILE_NAMES[rng.below(FILE_NAMES.len())];
		if case.file(path).is_none() {
			let content = generate_file(rng, path);
			case.files.push((path.to_owned(), content));
		}
	}
	let sections = (0..rng.range(1, 2))
		.map(|_| generate_section(rng, &case))
		.collect();
	case.payload = Tree { sections }.render();
	case
}

fn lines_for<'a>(case: &'a StreamCase, section: &Section) -> Vec<&'a str> {
	section
		.path()
		.and_then(|path| case.file(path))
		.or_else(|| case.files.first().map(|(_, content)| content.as_str()))
		.map(file_lines)
		.unwrap_or_default()
}

/// Clamp every number in an op row into `1..=count`. Clamping is monotone,
/// so an ordered range (`9.=11`) stays ordered (`5.=5` on five lines); `0`
/// becomes `1` and numbers too large for `u64` become `count`.
fn repair_anchors(row: &str, count: usize) -> String {
	let count = count.max(1) as u64;
	let mut out = String::with_capacity(row.len());
	let mut digits = String::new();
	let flush = |digits: &mut String, out: &mut String| {
		if !digits.is_empty() {
			let value: u64 = digits.parse().unwrap_or(u64::MAX);
			out.push_str(&value.clamp(1, count).to_string());
			digits.clear();
		}
	};
	for ch in row.chars() {
		if ch.is_ascii_digit() {
			digits.push(ch);
		} else {
			flush(&mut digits, &mut out);
			out.push(ch);
		}
	}
	flush(&mut digits, &mut out);
	out
}

/// Semantic repair after byte-level damage: headers naming a container
/// file get their tag placeholder back; op-row anchors move in range.
fn repair(case: &StreamCase, tree: &mut Tree) {
	for section in &mut tree.sections {
		if let Some(path) = section.path().map(ToOwned::to_owned)
			&& case.file(&path).is_some()
		{
			section.header = Some(format!("[{path}#{}]", tag_placeholder(&path)));
		}
		let count = lines_for(case, section).len();
		for hunk in &mut section.hunks {
			if let Some(op) = hunk.first_mut()
				&& (op.starts_with("PUT ") || op.starts_with("CUT "))
			{
				*op = repair_anchors(op, count);
			}
		}
	}
}

/// One structure-aware mutation of a container. Undecodable input starts
/// from a freshly generated case.
pub fn mutate(bytes: &[u8], seed: u64) -> Vec<u8> {
	let mut rng = Rng::new(seed);
	let Some(mut case) = StreamCase::decode(bytes) else {
		return generate_case(&mut rng).encode();
	};
	let mut tree = Tree::parse(&case.payload);
	let slots = tree.hunk_slots();
	match rng.below(9) {
		// Regenerate everything after a random hunk (aggressive suffix walk).
		0 | 1 if !slots.is_empty() => {
			let (s, h) = slots[rng.below(slots.len())];
			tree.sections.truncate(s + 1);
			tree.sections[s].hunks.truncate(h);
			let lines = lines_for(&case, &tree.sections[s]);
			for _ in 0..rng.range(1, 3) {
				let hunk = generate_hunk(&mut rng, &lines);
				tree.sections[s].hunks.push(hunk);
			}
		},
		// Replace one hunk with a fresh derivation of the same nonterminal.
		2 if !slots.is_empty() => {
			let (s, h) = slots[rng.below(slots.len())];
			let lines = lines_for(&case, &tree.sections[s]);
			tree.sections[s].hunks[h] = generate_hunk(&mut rng, &lines);
		},
		// Repeat one hunk 2..=8 times.
		3 if !slots.is_empty() => {
			let (s, h) = slots[rng.below(slots.len())];
			let hunk = tree.sections[s].hunks[h].clone();
			for _ in 1..(1usize << rng.range(1, 3)) {
				tree.sections[s].hunks.insert(h, hunk.clone());
			}
		},
		// Drop one hunk, or a whole section.
		4 if !slots.is_empty() => {
			let (s, h) = slots[rng.below(slots.len())];
			if rng.chance(1, 3) && tree.sections.len() > 1 {
				tree.sections.remove(s);
			} else {
				tree.sections[s].hunks.remove(h);
			}
		},
		// New section (possibly a second one for the same path).
		5 => {
			let section = generate_section(&mut rng, &case);
			let at = rng.below(tree.sections.len() + 1);
			tree.sections.insert(at, section);
		},
		// Tag/anchor repair of a byte-mutated input.
		6 => repair(&case, &mut tree),
		// Edit one file line: tags follow automatically, anchors may drift.
		7 if !case.files.is_empty() => {
			let index = rng.below(case.files.len());
			let (path, content) = &case.files[index];
			let mut lines: Vec<String> = file_lines(content)
				.into_iter()
				.map(ToOwned::to_owned)
				.collect();
			let at = rng.below(lines.len() + 1);
			match rng.below(3) {
				0 if at < lines.len() => {
					lines.remove(at);
				},
				1 if at < lines.len() => lines[at] = format!("{} fz{:04x}", lines[at], rng.byte()),
				_ => lines.insert(at, format!("line fz{:04x}", rng.next_u64() as u16)),
			}
			let mut text = lines.join("\n");
			if content.ends_with('\n') || content.is_empty() {
				text.push('\n');
			}
			let path = path.clone();
			case.files[index] = (path, text);
		},
		// Streaming lanes: chunk count, `_input` alias, raw payload, seen-line policy.
		_ => {
			case.control ^= match rng.below(4) {
				0 => rng.byte() & control::CHUNKS_MASK,
				1 => control::INPUT_ALIAS,
				2 => control::RAW_INPUT,
				_ => control::ENFORCE_SEEN,
			};
		},
	}
	case.payload = tree.render();
	case.encode()
}

/// Splice `a`'s sections before a cut point with `b`'s sections after
/// one, keeping `a`'s control byte and files; spliced headers naming files
/// `a` lacks are retargeted to one of `a`'s files, and anchors repaired.
pub fn crossover(a: &[u8], b: &[u8], seed: u64) -> Vec<u8> {
	let mut rng = Rng::new(seed);
	let (Some(mut host), Some(donor)) = (StreamCase::decode(a), StreamCase::decode(b)) else {
		return a.to_vec();
	};
	let host_tree = Tree::parse(&host.payload);
	let donor_tree = Tree::parse(&donor.payload);
	let keep = rng.below(host_tree.sections.len() + 1);
	let take = rng.below(donor_tree.sections.len() + 1);
	let mut sections: Vec<Section> = host_tree.sections[..keep].to_vec();
	for mut section in donor_tree.sections[take..].iter().cloned() {
		let known = section.path().is_some_and(|path| host.file(path).is_some());
		if !known && !host.files.is_empty() {
			let (path, _) = &host.files[rng.below(host.files.len())];
			section.header = Some(format!("[{path}#{}]", tag_placeholder(path)));
		}
		let count = lines_for(&host, &section).len();
		for hunk in &mut section.hunks {
			if let Some(op) = hunk.first_mut()
				&& (op.starts_with("PUT ") || op.starts_with("CUT "))
			{
				*op = repair_anchors(op, count);
			}
		}
		sections.push(section);
	}
	host.payload = Tree { sections }.render();
	host.encode()
}

/// Structural reduction: repeatedly try deleting container files,
/// sections, hunks, body rows, and file lines, and clearing control lanes,
/// keeping each candidate `interesting` accepts. Stops at a fixpoint or
/// after `budget` predicate calls.
pub fn reduce(bytes: &[u8], mut interesting: impl FnMut(&[u8]) -> bool, budget: usize) -> Vec<u8> {
	let Some(mut best) = StreamCase::decode(bytes) else {
		return bytes.to_vec();
	};
	let mut calls = 0usize;
	let mut accept = |candidate: &StreamCase, best: &mut StreamCase, calls: &mut usize| -> bool {
		if *calls >= budget || candidate == best {
			return false;
		}
		*calls += 1;
		if interesting(&candidate.encode()) {
			*best = candidate.clone();
			true
		} else {
			false
		}
	};
	loop {
		let before = best.clone();

		// Control lanes: prefer one JSON chunk, no alias, no seen policy.
		for mask in
			[control::CHUNKS_MASK, control::INPUT_ALIAS, control::RAW_INPUT, control::ENFORCE_SEEN]
		{
			let mut candidate = best.clone();
			candidate.control &= !mask;
			accept(&candidate, &mut best, &mut calls);
		}

		let mut index = 0;
		while index < best.files.len() {
			let mut candidate = best.clone();
			candidate.files.remove(index);
			if !accept(&candidate, &mut best, &mut calls) {
				index += 1;
			}
		}

		let mut s = 0;
		while s < Tree::parse(&best.payload).sections.len() {
			let mut tree = Tree::parse(&best.payload);
			tree.sections.remove(s);
			let candidate = StreamCase { payload: tree.render(), ..best.clone() };
			if !accept(&candidate, &mut best, &mut calls) {
				s += 1;
			}
		}

		let mut slot = 0;
		while let Some(&(s, h)) = Tree::parse(&best.payload).hunk_slots().get(slot) {
			let mut tree = Tree::parse(&best.payload);
			tree.sections[s].hunks.remove(h);
			let candidate = StreamCase { payload: tree.render(), ..best.clone() };
			if !accept(&candidate, &mut best, &mut calls) {
				slot += 1;
			}
		}

		let mut slot = 0;
		let mut row = 1;
		while let Some(&(s, h)) = Tree::parse(&best.payload).hunk_slots().get(slot) {
			let mut tree = Tree::parse(&best.payload);
			if row >= tree.sections[s].hunks[h].len() {
				slot += 1;
				row = 1;
				continue;
			}
			tree.sections[s].hunks[h].remove(row);
			let candidate = StreamCase { payload: tree.render(), ..best.clone() };
			if !accept(&candidate, &mut best, &mut calls) {
				row += 1;
			}
		}

		let mut file = 0;
		let mut line = 0;
		while file < best.files.len() {
			let content = best.files[file].1.clone();
			let mut lines = file_lines(&content);
			if line >= lines.len() {
				file += 1;
				line = 0;
				continue;
			}
			lines.remove(line);
			let mut text = lines.join("\n");
			if content.ends_with('\n') && !lines.is_empty() {
				text.push('\n');
			}
			let mut candidate = best.clone();
			candidate.files[file].1 = text;
			if !accept(&candidate, &mut best, &mut calls) {
				line += 1;
			}
		}

		if best == before || calls >= budget {
			return best.encode();
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A donor range spliced onto a shorter host file must stay ordered.
	#[test]
	fn crossover_repairs_foreign_range_into_an_ordered_host_range() {
		let host = StreamCase {
			control: 0,
			files:   vec![("a.txt".to_owned(), "1\n2\n3\n4\n5\n".to_owned())],
			payload: String::new(),
		};
		let donor = StreamCase {
			control: 0,
			files:   Vec::new(),
			payload: "[z.txt#ABCD]\nPUT 9.=11:\n+x".to_owned(),
		};
		let mut spliced = 0;
		for seed in 0..32 {
			let out = StreamCase::decode(&crossover(&host.encode(), &donor.encode(), seed))
				.expect("crossover output decodes");
			for row in out
				.payload
				.split('\n')
				.filter(|row| row.starts_with("PUT "))
			{
				assert_eq!(row, "PUT 5.=5:", "seed {seed}: {:?}", out.payload);
				spliced += 1;
			}
		}
		assert!(spliced > 0, "no seed spliced the donor section");
	}
}
