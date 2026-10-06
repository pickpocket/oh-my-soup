//! Parser/streaming robustness lane over arbitrary payloads (see
//! `support/stream_case.rs` for the container and asserted contracts).
//!
//! Mutation keeps two lanes distinct: half of all mutations are libFuzzer's
//! own byte-level ones (malformed/lenient input for the parser), half are
//! grammar-directed (`support/stream_grammar.rs`: suffix regeneration, hunk
//! replacement/repetition/removal, tag/anchor repair) so inputs keep
//! reaching staging and apply. Crossover splices sections across inputs.
#![no_main]

use libfuzzer_sys::{fuzz_crossover, fuzz_mutator, fuzz_target, fuzzer_mutate};

#[path = "../support/stream_case.rs"]
#[allow(dead_code, reason = "shared with the uninstrumented tools")]
mod stream_case;
#[path = "../support/stream_grammar.rs"]
#[allow(dead_code, reason = "shared with the uninstrumented tools")]
mod stream_grammar;

fuzz_target!(|data: &[u8]| {
	if let Err(violation) = stream_case::check_stream(data) {
		panic!("hashline stream contract violated: {violation}");
	}
});

fuzz_mutator!(|data: &mut [u8], size: usize, max_size: usize, seed: u32| {
	if seed & 1 == 0 {
		return fuzzer_mutate(data, size, max_size);
	}
	let mutated = stream_grammar::mutate(&data[..size], u64::from(seed >> 1));
	if mutated.len() > max_size {
		// Too large for this slot (e.g. while minimizing): fall back to bytes.
		return fuzzer_mutate(data, size, max_size);
	}
	data[..mutated.len()].copy_from_slice(&mutated);
	mutated.len()
});

fuzz_crossover!(|data1: &[u8], data2: &[u8], out: &mut [u8], seed: u32| {
	let spliced = stream_grammar::crossover(data1, data2, u64::from(seed));
	let len = spliced.len().min(out.len());
	out[..len].copy_from_slice(&spliced[..len]);
	len
});
