//! Reduce a violating input while it keeps the same violation class.
//!
//! - `stream`: structural passes over the container (drop files, sections,
//!   hunks, body rows, file lines; clear control lanes), so the result is still
//!   a well-formed hashline payload rather than a byte fragment.
//! - `semantic`: the input is `check_case`'s choice sequence, so reducing it
//!   regenerates a smaller *valid* case: delete byte regions (halving sizes),
//!   zero regions, then lower individual bytes, shortlex-first.
//!
//! For semantic inputs it also exports `<input>.fixture.json`, a runnable
//! `tests/fixtures/hashline/*.json` case with independently modeled file
//! bytes and zero-write rejection for fault lanes.
//!
//! `cargo fuzz tmin <target> <artifact>` remains the libFuzzer-native
//! alternative; this runs uninstrumented and needs no nightly sanitizer.
//!
//! Usage: reduce <semantic|stream> <input> [--out FILE] [--budget N]
//! Writes `<input>.min` by default. Exit status 2 when the input does not
//! violate an oracle in the first place.

use std::{path::PathBuf, process::ExitCode};

use pi_edit_fuzz_tools::{
	Target, content_name, run, semantic_case, silence_panic_output, stream_grammar,
	violation_signature,
};

fn violation(target: Target, bytes: &[u8]) -> Option<String> {
	run(target, bytes).violation
}

/// Hypothesis-style passes over a choice sequence (MacIver & Donaldson,
/// ECOOP 2020 §3.1: region deletion, region zeroing, lexicographic lowering).
fn reduce_choices(
	bytes: &[u8],
	mut interesting: impl FnMut(&[u8]) -> bool,
	budget: usize,
) -> Vec<u8> {
	let mut best = bytes.to_vec();
	let mut calls = 0usize;
	let mut try_accept = |candidate: Vec<u8>, best: &mut Vec<u8>, calls: &mut usize| -> bool {
		if *calls >= budget || candidate == *best {
			return false;
		}
		*calls += 1;
		if interesting(&candidate) {
			*best = candidate;
			true
		} else {
			false
		}
	};
	loop {
		let before = best.clone();

		let mut size = best.len().next_power_of_two();
		while size > 0 {
			let mut start = 0;
			while start < best.len() {
				let end = (start + size).min(best.len());
				let mut candidate = best[..start].to_vec();
				candidate.extend_from_slice(&best[end..]);
				if !try_accept(candidate, &mut best, &mut calls) {
					start += size;
				}
			}
			size /= 2;
		}

		let mut size = best.len().next_power_of_two();
		while size > 0 {
			let mut start = 0;
			while start < best.len() {
				let end = (start + size).min(best.len());
				let mut candidate = best.clone();
				candidate[start..end].fill(0);
				try_accept(candidate, &mut best, &mut calls);
				start += size;
			}
			size /= 2;
		}

		for index in 0..best.len() {
			let mut value = best[index];
			while value > 0 {
				let mut candidate = best.clone();
				candidate[index] = value / 2;
				if try_accept(candidate, &mut best, &mut calls) {
					value = best[index];
				} else {
					break;
				}
			}
		}

		if best == before || calls >= budget {
			return best;
		}
	}
}

fn main() -> ExitCode {
	let argv: Vec<String> = std::env::args().skip(1).collect();
	let (Some(target), Some(input)) =
		(argv.first().and_then(|name| Target::parse(name)), argv.get(1))
	else {
		eprintln!("usage: reduce <semantic|stream> <input> [--out FILE] [--budget N]");
		return ExitCode::from(2);
	};
	let mut out = PathBuf::from(format!("{input}.min"));
	let mut budget = 20_000usize;
	let mut rest = argv[2..].iter();
	while let Some(flag) = rest.next() {
		match (flag.as_str(), rest.next()) {
			("--out", Some(value)) => out = PathBuf::from(value),
			("--budget", Some(value)) if value.parse::<usize>().is_ok() => {
				budget = value.parse().expect("checked");
			},
			_ => {
				eprintln!("unknown or incomplete argument: {flag}");
				return ExitCode::from(2);
			},
		}
	}

	silence_panic_output();
	let bytes = match std::fs::read(input) {
		Ok(bytes) => bytes,
		Err(error) => {
			eprintln!("read {input}: {error}");
			return ExitCode::from(2);
		},
	};
	let Some(original) = violation(target, &bytes) else {
		eprintln!("{input} does not violate any {} oracle", target.binary());
		return ExitCode::from(2);
	};
	let signature = violation_signature(&original);
	println!("violation class: {signature}");
	let interesting = |candidate: &[u8]| {
		violation(target, candidate).is_some_and(|found| violation_signature(&found) == signature)
	};
	let reduced = match target {
		Target::Stream => stream_grammar::reduce(&bytes, interesting, budget),
		Target::Semantic => reduce_choices(&bytes, interesting, budget),
	};
	if let Err(error) = std::fs::write(&out, &reduced) {
		eprintln!("write {}: {error}", out.display());
		return ExitCode::FAILURE;
	}
	println!(
		"{} -> {} bytes: {}\n{}",
		bytes.len(),
		reduced.len(),
		out.display(),
		violation(target, &reduced).unwrap_or_default()
	);
	if target == Target::Semantic {
		let mut fixture = semantic_case::behavioral_fixture(&reduced);
		fixture["name"] = serde_json::json!(format!("reduced semantic {}", content_name(&reduced)));
		let wrapped = serde_json::json!({ "cases": [fixture] });
		let fixture_path = out.with_extension("fixture.json");
		let json = serde_json::to_vec_pretty(&wrapped).expect("behavioral fixture serializes");
		if let Err(error) = std::fs::write(&fixture_path, json) {
			eprintln!("write {}: {error}", fixture_path.display());
			return ExitCode::FAILURE;
		}
		println!("behavioral fixture: {}", fixture_path.display());
	}
	ExitCode::SUCCESS
}
