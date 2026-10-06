//! Deterministic validity sampling for the fuzz harnesses, uninstrumented.
//!
//! Reports how often inputs get past staging (`stage_succeeded`) — the
//! semantic-validity signal the coverage-guided search depends on — over
//! repeated independent trials, plus any oracle violations. It measures NO
//! code coverage and is NOT a bug count: coverage comes from libFuzzer's own
//! `cov:`/`ft:` status lines (`run.sh fuzz …`) or `cargo fuzz coverage`.
//!
//! Usage (`bash crates/pi-edit/fuzz/run.sh sample <target> …` wraps this):
//!   sample <semantic|stream> [--trials N] [--cases N] [--seed S]
//!   sample <semantic|stream> --corpus DIR [--corpus DIR]...
//!
//! Generated mode: trial `t` draws `--cases` inputs from SplitMix64 seeded
//! with `S + t` (semantic: uniform random choice sequences of 1..=256
//! bytes, reported per generator lane; stream: grammar-walked containers).
//! Same arguments, same numbers.
//! Exit status 1 when any input violates an oracle; each is saved to
//! artifacts/sample/<target>-<hash> for `cargo fuzz run <target> <file>`.
//! Exit status 2 on bad arguments, including a missing or unreadable corpus
//! directory.

use std::{collections::BTreeMap, path::PathBuf, process::ExitCode};

use pi_edit_fuzz_tools::{
	Outcome, Target, content_name, corpus_files, fuzz_dir, run, silence_panic_output,
	stream_grammar::{Rng, generate_case},
};

struct Args {
	target:  Target,
	trials:  u64,
	cases:   u64,
	seed:    u64,
	corpora: Vec<PathBuf>,
}

fn usage() -> ExitCode {
	eprintln!(
		"usage: sample <semantic|stream> [--trials N] [--cases N] [--seed S]\n       sample \
		 <semantic|stream> --corpus DIR [--corpus DIR]..."
	);
	ExitCode::from(2)
}

fn parse_args() -> Option<Args> {
	let mut argv = std::env::args().skip(1);
	let target = Target::parse(&argv.next()?)?;
	let mut args = Args { target, trials: 5, cases: 1000, seed: 1, corpora: Vec::new() };
	while let Some(flag) = argv.next() {
		let value = argv.next()?;
		match flag.as_str() {
			"--trials" => args.trials = value.parse().ok().filter(|&n| n > 0)?,
			"--cases" => args.cases = value.parse().ok().filter(|&n| n > 0)?,
			"--seed" => args.seed = value.parse().ok()?,
			"--corpus" => args.corpora.push(PathBuf::from(value)),
			_ => return None,
		}
	}
	Some(args)
}

#[derive(Default)]
struct Tally {
	inputs:     u64,
	executed:   u64,
	parsed:     u64,
	staged:     u64,
	violations: u64,
	/// Semantic generator lane → (executed, staged).
	lanes:      BTreeMap<&'static str, (u64, u64)>,
}

impl Tally {
	fn add(&mut self, target: Target, bytes: &[u8], outcome: &Outcome) {
		self.inputs += 1;
		self.executed += u64::from(outcome.executed);
		self.parsed += u64::from(outcome.parse_succeeded);
		self.staged += u64::from(outcome.stage_succeeded);
		if !outcome.lane.is_empty() {
			let lane = self.lanes.entry(outcome.lane).or_default();
			lane.0 += 1;
			lane.1 += u64::from(outcome.stage_succeeded);
		}
		if let Some(violation) = &outcome.violation {
			self.violations += 1;
			let dir = fuzz_dir().join("artifacts/sample");
			std::fs::create_dir_all(&dir).expect("create artifacts/sample");
			let path = dir.join(format!("{}-{}", target.binary(), content_name(bytes)));
			std::fs::write(&path, bytes).expect("write violation artifact");
			eprintln!("VIOLATION: {violation}\n  saved {}", path.display());
		}
	}

	fn fraction(&self) -> f64 {
		if self.executed == 0 {
			0.0
		} else {
			self.staged as f64 / self.executed as f64
		}
	}

	fn line(&self, target: Target) -> String {
		let parsed = if target == Target::Stream {
			format!(" parsed={}/{}", self.parsed, self.executed)
		} else {
			String::new()
		};
		let lanes: String = self
			.lanes
			.iter()
			.map(|(lane, (executed, staged))| {
				format!("\n    lane {lane}: stage_succeeded={staged}/{executed}")
			})
			.collect();
		format!(
			"inputs={} executed={}{parsed} stage_succeeded={}/{} ({:.1}%) violations={}{lanes}",
			self.inputs,
			self.executed,
			self.staged,
			self.executed,
			100.0 * self.fraction(),
			self.violations
		)
	}
}

fn generated_input(target: Target, rng: &mut Rng) -> Vec<u8> {
	match target {
		Target::Semantic => {
			// check_case reads roughly the first 200 choice bytes.
			let len = rng.range(1, 256);
			(0..len).map(|_| rng.byte()).collect()
		},
		Target::Stream => generate_case(rng).encode(),
	}
}

fn main() -> ExitCode {
	let Some(args) = parse_args() else {
		return usage();
	};
	silence_panic_output();
	let target = args.target;
	println!(
		"{}: stage-validity sample (not coverage; see libFuzzer cov:/ft: for that)",
		target.binary()
	);

	let mut violations = 0;
	if args.corpora.is_empty() {
		let mut fractions = Vec::new();
		for trial in 0..args.trials {
			let mut rng = Rng::new(args.seed.wrapping_add(trial));
			let mut tally = Tally::default();
			for _ in 0..args.cases {
				let bytes = generated_input(target, &mut rng);
				let outcome = run(target, &bytes);
				tally.add(target, &bytes, &outcome);
			}
			println!("trial {trial} seed={}: {}", args.seed.wrapping_add(trial), tally.line(target));
			fractions.push(tally.fraction());
			violations += tally.violations;
		}
		let mean = fractions.iter().sum::<f64>() / fractions.len() as f64;
		let min = fractions.iter().copied().fold(f64::INFINITY, f64::min);
		let max = fractions.iter().copied().fold(f64::NEG_INFINITY, f64::max);
		println!(
			"summary over {} trials: stage_succeeded mean={:.1}% min={:.1}% max={:.1}%",
			fractions.len(),
			100.0 * mean,
			100.0 * min,
			100.0 * max
		);
	} else {
		let files = match corpus_files(&args.corpora) {
			Ok(files) => files,
			Err(error) => {
				eprintln!("corpus {error}");
				return ExitCode::from(2);
			},
		};
		let mut tally = Tally::default();
		for path in &files {
			let bytes =
				std::fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
			let outcome = run(target, &bytes);
			tally.add(target, &bytes, &outcome);
		}
		println!("corpus ({} files): {}", files.len(), tally.line(target));
		violations = tally.violations;
	}

	if violations == 0 {
		ExitCode::SUCCESS
	} else {
		ExitCode::FAILURE
	}
}
