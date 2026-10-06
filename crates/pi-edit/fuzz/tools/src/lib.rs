//! Shared driver for the uninstrumented fuzz tools. Compiles the exact
//! harness sources the fuzz targets use, without libFuzzer.

use std::{
	cell::Cell,
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Path, PathBuf},
};

thread_local! {
	static IN_HARNESS: Cell<bool> = const { Cell::new(false) };
}

#[path = "../../../tests/support/semantic_case.rs"]
pub mod semantic_case;
#[path = "../../support/stream_case.rs"]
pub mod stream_case;
#[path = "../../support/stream_grammar.rs"]
pub mod stream_grammar;

/// Fuzz target, named like its `fuzz_targets/*.rs` binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
	Semantic,
	Stream,
}

impl Target {
	pub fn parse(name: &str) -> Option<Self> {
		match name {
			"semantic" | "hashline_semantic" => Some(Self::Semantic),
			"stream" | "hashline_stream" => Some(Self::Stream),
			_ => None,
		}
	}

	pub const fn binary(self) -> &'static str {
		match self {
			Self::Semantic => "hashline_semantic",
			Self::Stream => "hashline_stream",
		}
	}
}

/// One harness execution.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
	/// Oracle violation (`Err`) or panic message: what libFuzzer would
	/// report as a crash.
	pub violation:       Option<String>,
	pub stage_succeeded: bool,
	/// Stream target only: `Patch::parse` accepted the payload.
	pub parse_succeeded: bool,
	/// Passed the harness input guards (stream: size/container/host path;
	/// semantic: always).
	pub executed:        bool,
	/// Semantic target only: generator lane (`Lane::name`), e.g. `valid`.
	pub lane:            &'static str,
}

/// Run `bytes` through `target`'s harness, turning panics into violations.
/// Call [`silence_panic_output`] first to keep stderr readable.
pub fn run(target: Target, bytes: &[u8]) -> Outcome {
	IN_HARNESS.with(|flag| flag.set(true));
	let result = catch_unwind(AssertUnwindSafe(|| match target {
		Target::Semantic => semantic_case::check_case(bytes).map(|metrics| Outcome {
			stage_succeeded: metrics.stage_succeeded,
			executed: true,
			lane: metrics.lane.name(),
			..Outcome::default()
		}),
		Target::Stream => stream_case::check_stream(bytes).map(|metrics| Outcome {
			stage_succeeded: metrics.stage_succeeded,
			parse_succeeded: metrics.parse_succeeded,
			executed: metrics.executed,
			..Outcome::default()
		}),
	}));
	IN_HARNESS.with(|flag| flag.set(false));
	match result {
		Ok(Ok(outcome)) => outcome,
		Ok(Err(violation)) => Outcome { violation: Some(violation), ..Outcome::default() },
		Err(payload) => {
			let message = payload
				.downcast_ref::<&str>()
				.map(|s| (*s).to_owned())
				.or_else(|| payload.downcast_ref::<String>().cloned())
				.unwrap_or_else(|| "non-string panic payload".to_owned());
			Outcome { violation: Some(format!("panic: {message}")), ..Outcome::default() }
		},
	}
}

/// Silence the panic hook while [`run`] executes a harness (it reports the
/// message itself); panics elsewhere still print normally.
pub fn silence_panic_output() {
	let default = std::panic::take_hook();
	std::panic::set_hook(Box::new(move |info| {
		if !IN_HARNESS.with(Cell::get) {
			default(info);
		}
	}));
}

/// `crates/pi-edit/fuzz`.
pub fn fuzz_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.expect("tools lives inside the fuzz directory")
		.to_path_buf()
}

/// Stable content-derived file name (FNV-1a 64).
pub fn content_name(bytes: &[u8]) -> String {
	let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
	for &byte in bytes {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}
	format!("{hash:016x}")
}

/// Every regular file directly inside `dirs`, sorted by path. A missing or
/// unreadable directory is an error, so a mistyped corpus never samples as
/// empty.
pub fn corpus_files(dirs: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
	let mut files = Vec::new();
	for dir in dirs {
		let entries =
			std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
		for entry in entries {
			let path = entry
				.map_err(|error| format!("{}: {error}", dir.display()))?
				.path();
			if path.is_file() {
				files.push(path);
			}
		}
	}
	files.sort();
	Ok(files)
}

/// Violation class used to keep reductions on the same failure: panic vs
/// oracle, plus the shape of the first line (the oracle problem or panic
/// message; case context follows on later lines). Free-form detail after
/// `": "` is dropped and digit runs, quoted strings, and bracketed payloads
/// are abstracted, so one defect keeps its class across files, lines, and
/// bytes while different problems in the same lane stay distinct.
pub fn violation_signature(violation: &str) -> String {
	let (class, message) = violation
		.strip_prefix("panic: ")
		.map_or(("", violation), |rest| ("panic: ", rest));
	let mut head = String::from(class);
	let mut depth = 0usize;
	let mut chars = message
		.lines()
		.next()
		.unwrap_or_default()
		.chars()
		.peekable();
	while let Some(c) = chars.next() {
		match c {
			'"' => {
				while let Some(quoted) = chars.next() {
					match quoted {
						'\\' => {
							chars.next();
						},
						'"' => break,
						_ => {},
					}
				}
				if depth == 0 {
					head.push_str("\"…\"");
				}
			},
			'(' | '[' | '{' => {
				if depth == 0 {
					head.push(c);
					head.push('…');
				}
				depth += 1;
			},
			')' | ']' | '}' => {
				depth = depth.saturating_sub(1);
				if depth == 0 {
					head.push(c);
				}
			},
			_ if depth > 0 => {},
			':' if chars.peek() == Some(&' ') => break,
			'0'..='9' => {
				while chars.next_if(char::is_ascii_digit).is_some() {}
				head.push('#');
			},
			_ => head.push(c),
		}
	}
	head.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
	use super::violation_signature;

	/// Same-lane semantic failures keep distinct classes; one failure keeps
	/// its class when only the file, line numbers, or bytes differ.
	#[test]
	fn signature_separates_same_lane_problems() {
		let context = "\n--- valid lane, faulty section None ---\n--- patch ---\n[f0.txt#1A2B]";
		let changed =
			|file: &str, from: &str| format!("{file} changed from {from:?} to \"b\"{context}");
		let on_disk = format!("f0.txt on disk is \"b\"; model expects \"a\"{context}");
		let rejected = format!("coherent patch was rejected: stale tag{context}");
		let signatures = [
			violation_signature(&changed("f0.txt", "a")),
			violation_signature(&on_disk),
			violation_signature(&rejected),
		];
		assert_ne!(signatures[0], signatures[1]);
		assert_ne!(signatures[0], signatures[2]);
		assert_ne!(signatures[1], signatures[2]);
		assert_eq!(signatures[0], violation_signature(&changed("f1.txt", "x\r\ny")));
		assert_ne!(violation_signature("panic: boom"), violation_signature("boom"));
	}
}
