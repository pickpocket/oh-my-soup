//! Deterministic seed corpus for both fuzz targets, regenerated from the
//! checked-in fixtures (`tests/fixtures/hashline/*.json`) — never from
//! recorded sessions or edit logs.
//!
//! Output (generator-owned, wiped and rewritten on every run):
//!   seeds/hashline_stream/    fixture payloads in the stream container
//!                             (file text + `{{tag:PATH}}` headers), plus
//!                             grammar-walked cases
//!   seeds/hashline_semantic/  choice sequences for `check_case`: the
//!                             support file's exemplars (one per lane),
//!                             fixture bytes, and SplitMix streams for every
//!                             lane selector (byte 0), kept per (lane,
//!                             staged) so valid and invalid lanes stay distinct
//!
//! Usage: `bash crates/pi-edit/fuzz/run.sh seeds` (uninstrumented; any
//! toolchain the repo pins).
//! Exit status 1 when a candidate already violates an oracle (the violating
//! inputs are also written to artifacts/seed_corpus/ for replay).

use std::{
	collections::{BTreeMap, BTreeSet},
	path::Path,
	process::ExitCode,
};

use pi_edit_fuzz_tools::{
	Target, content_name, fuzz_dir, run,
	semantic_case::{
		Lane, MULTI_SECTION_BYTES, NONTRIVIAL_RANGE_BYTES, STALE_TAG_LATER_SECTION_BYTES,
	},
	silence_panic_output,
	stream_case::{MAX_INPUT_BYTES, StreamCase, control, is_safe_relative_path, tag_placeholder},
	stream_grammar::{Rng, Tree, generate_case},
};
use serde_json::Value;

/// Stream seeds rotate through these lanes: one JSON chunk, eight JSON
/// chunks, raw payload in four chunks, `_input` alias in 32 chunks.
const STREAM_LANES: [u8; 4] =
	[0, 7, control::RAW_INPUT | 3, control::INPUT_ALIAS | control::CHUNKS_MASK];
const GRAMMAR_SEEDS: u64 = 32;
const DEFAULT_FILE: &str = "one\ntwo\nthree\nfour\nfive\nsix\n";
/// `check_case` picks its lane from byte 0 mod 16.
const SEMANTIC_LANE_SELECTORS: u8 = 16;
const SEMANTIC_CANDIDATES_PER_SELECTOR: u64 = 32;
/// Kept per `(lane, stage_succeeded)` bucket.
const SEMANTIC_KEEP_PER_BUCKET: usize = 8;
/// `check_case` decodes a bounded prefix (about 200 bytes); longer seeds
/// would only carry ignored tail bytes.
const SEMANTIC_SEED_BYTES: usize = 256;

fn main() -> ExitCode {
	silence_panic_output();
	let fuzz = fuzz_dir();
	let fixtures = fuzz.join("../tests/fixtures/hashline");
	let cases = load_fixture_cases(&fixtures);
	let mut violations = 0usize;

	let stream = stream_seeds(&cases);
	violations += write_seeds(&fuzz, Target::Stream, &stream);

	let semantic = semantic_seeds(&cases, &mut violations, &fuzz);
	violations += write_seeds(&fuzz, Target::Semantic, &semantic);

	if violations == 0 {
		ExitCode::SUCCESS
	} else {
		eprintln!("{violations} seed candidate(s) violated an oracle; see artifacts/seed_corpus/");
		ExitCode::FAILURE
	}
}

/// `(fixture stem, case index, case)` in file-name then case order.
fn load_fixture_cases(dir: &Path) -> Vec<(String, usize, Value)> {
	let mut files: Vec<_> = std::fs::read_dir(dir)
		.unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| path.extension().is_some_and(|ext| ext == "json"))
		.collect();
	files.sort();
	let mut out = Vec::new();
	for path in files {
		let text = std::fs::read_to_string(&path)
			.unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
		let root: Value = serde_json::from_str(&text)
			.unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
		let stem = path
			.file_stem()
			.and_then(|stem| stem.to_str())
			.unwrap_or("fixture")
			.to_owned();
		for (index, case) in root["cases"].as_array().into_iter().flatten().enumerate() {
			out.push((stem.clone(), index, case.clone()));
		}
	}
	out
}

fn has_header(payload: &str) -> bool {
	Tree::parse(payload)
		.sections
		.iter()
		.any(|section| section.header.is_some())
}

fn with_header(path: &str, input: &str) -> String {
	if has_header(input) {
		input.to_owned()
	} else {
		format!("[{path}#{}]\n{input}", tag_placeholder(path))
	}
}

/// Named stream containers, in deterministic order. A payload is seeded
/// once: its first occurrence (real file text before the default file)
/// wins.
fn stream_seeds(cases: &[(String, usize, Value)]) -> Vec<(String, Vec<u8>)> {
	let mut seeds = Vec::new();
	let mut payloads = BTreeSet::new();
	let mut lane = 0usize;
	let mut push = |name: String, files: Vec<(String, String)>, payload: String| {
		if !payloads.insert(payload.clone()) {
			return;
		}
		let case = StreamCase { control: STREAM_LANES[lane % STREAM_LANES.len()], files, payload };
		lane += 1;
		seeds.push((name, case.encode()));
	};

	for (stem, index, case) in cases {
		// patcher.json shape: files + args.input with `{{tag:PATH}}`.
		if let Some(input) = case["args"]["input"].as_str() {
			let files = case["files"]
				.as_object()
				.into_iter()
				.flatten()
				.filter(|(path, _)| is_safe_relative_path(path))
				.filter_map(|(path, text)| Some((path.clone(), text.as_str()?.to_owned())))
				.collect();
			push(format!("{stem}-{index:03}-args"), files, input.to_owned());
		}
		// parity `apply[]`: file text + headerless (or headed) section body.
		for (n, apply) in case["apply"].as_array().into_iter().flatten().enumerate() {
			let (Some(text), Some(input)) = (apply["text"].as_str(), apply["input"].as_str()) else {
				continue;
			};
			let path = apply["path"]
				.as_str()
				.filter(|path| is_safe_relative_path(path))
				.unwrap_or("a.txt");
			push(
				format!("{stem}-{index:03}-apply{n}"),
				vec![(path.to_owned(), text.to_owned())],
				with_header(path, input),
			);
		}
		// parity `parse[]`: section bodies, valid and deliberately invalid.
		for (n, parse) in case["parse"].as_array().into_iter().flatten().enumerate() {
			let Some(input) = parse["input"].as_str() else {
				continue;
			};
			push(
				format!("{stem}-{index:03}-parse{n}"),
				vec![("a.txt".to_owned(), DEFAULT_FILE.to_owned())],
				with_header("a.txt", input),
			);
		}
		// Streaming matcher / preview fixtures: payload only.
		if let Some(input) = case["input"].as_str() {
			push(format!("{stem}-{index:03}-input"), Vec::new(), input.to_owned());
		}
	}

	for seed in 0..GRAMMAR_SEEDS {
		let case = generate_case(&mut Rng::new(seed));
		seeds.push((format!("grammar-{seed:03}"), case.encode()));
	}
	seeds
}

fn splitmix_bytes(selector: u8, seed: u64) -> Vec<u8> {
	let mut rng = Rng::new(seed);
	let len = rng.range(16, SEMANTIC_SEED_BYTES);
	let mut bytes: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
	bytes[0] = selector;
	bytes
}

/// Choice sequences that `check_case` decodes into staged and rejected
/// cases of every lane. The generator owns all case text (tags, anchors,
/// lines), so fixture bytes are simply extra choice sequences with
/// realistic byte statistics; exemplars go first so every bucket keeps them.
fn semantic_seeds(
	cases: &[(String, usize, Value)],
	violations: &mut usize,
	fuzz: &Path,
) -> Vec<(String, Vec<u8>)> {
	// The support file's documented exemplars first, then the multi-section
	// stale-tag exemplar re-pinned to every lane (byte 0 selects the lane).
	let mut candidates: Vec<(String, Vec<u8>)> = vec![
		("exemplar-nontrivial-range".to_owned(), NONTRIVIAL_RANGE_BYTES.to_vec()),
		("exemplar-multi-section".to_owned(), MULTI_SECTION_BYTES.to_vec()),
		("exemplar-stale-tag-later-section".to_owned(), STALE_TAG_LATER_SECTION_BYTES.to_vec()),
	];
	for lane in Lane::ALL {
		let mut bytes = STALE_TAG_LATER_SECTION_BYTES.to_vec();
		bytes[0] = lane.choice();
		candidates.push((format!("exemplar-lane-{}", lane.name()), bytes));
	}
	for (stem, index, case) in cases {
		for (n, apply) in case["apply"].as_array().into_iter().flatten().enumerate() {
			let (Some(text), Some(input)) = (apply["text"].as_str(), apply["input"].as_str()) else {
				continue;
			};
			let mut bytes = text.as_bytes().to_vec();
			bytes.extend_from_slice(input.as_bytes());
			bytes.truncate(SEMANTIC_SEED_BYTES);
			candidates.push((format!("{stem}-{index:03}-apply{n}"), bytes));
		}
	}
	for selector in 0..SEMANTIC_LANE_SELECTORS {
		for seed in 0..SEMANTIC_CANDIDATES_PER_SELECTOR {
			let seed = u64::from(selector) * SEMANTIC_CANDIDATES_PER_SELECTOR + seed;
			candidates
				.push((format!("splitmix-{selector:02}-{seed:04}"), splitmix_bytes(selector, seed)));
		}
	}

	let mut seen = BTreeSet::new();
	let mut buckets: BTreeMap<_, Vec<_>> = BTreeMap::new();
	for (name, bytes) in candidates {
		if !seen.insert(bytes.clone()) {
			continue;
		}
		let outcome = run(Target::Semantic, &bytes);
		if let Some(violation) = outcome.violation {
			*violations += 1;
			let path = save_violation(fuzz, Target::Semantic, &bytes);
			eprintln!("semantic candidate {name} violates: {violation}\n  saved {}", path.display());
			continue;
		}
		let bucket = buckets
			.entry((outcome.lane, outcome.stage_succeeded))
			.or_default();
		if bucket.len() < SEMANTIC_KEEP_PER_BUCKET {
			bucket.push((name, bytes));
		}
	}
	let mut kept = Vec::new();
	for ((lane, staged), bucket) in buckets {
		println!(
			"hashline_semantic: lane {lane} {}: kept {}",
			if staged { "staged" } else { "rejected" },
			bucket.len()
		);
		kept.extend(bucket);
	}
	kept
}

fn save_violation(fuzz: &Path, target: Target, bytes: &[u8]) -> std::path::PathBuf {
	let dir = fuzz.join("artifacts/seed_corpus");
	std::fs::create_dir_all(&dir).expect("create artifacts/seed_corpus");
	let path = dir.join(format!("{}-{}", target.binary(), content_name(bytes)));
	std::fs::write(&path, bytes).expect("write violation artifact");
	path
}

/// Replace `seeds/<target>/` with `seeds`; returns stream violations found
/// while validating them (semantic ones are counted during selection).
fn write_seeds(fuzz: &Path, target: Target, seeds: &[(String, Vec<u8>)]) -> usize {
	let dir = fuzz.join("seeds").join(target.binary());
	if dir.exists() {
		std::fs::remove_dir_all(&dir).expect("clear generated seed dir");
	}
	std::fs::create_dir_all(&dir).expect("create seed dir");
	let mut written = BTreeSet::new();
	let mut violations = 0;
	let (mut staged, mut parsed) = (0usize, 0usize);
	for (name, bytes) in seeds {
		let oversized = target == Target::Stream && bytes.len() > MAX_INPUT_BYTES;
		if oversized || !written.insert(bytes.clone()) {
			continue;
		}
		let file: String = name
			.chars()
			.map(|c| {
				if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
					c
				} else {
					'_'
				}
			})
			.collect();
		std::fs::write(dir.join(&file), bytes).expect("write seed");
		if target == Target::Stream {
			let outcome = run(target, bytes);
			if let Some(violation) = outcome.violation {
				violations += 1;
				let path = save_violation(fuzz, target, bytes);
				eprintln!("stream seed {file} violates: {violation}\n  saved {}", path.display());
			}
			staged += usize::from(outcome.stage_succeeded);
			parsed += usize::from(outcome.parse_succeeded);
		}
	}
	if target == Target::Stream {
		println!("hashline_stream: wrote {} seeds ({parsed} parsed, {staged} staged)", written.len());
	}
	violations
}
