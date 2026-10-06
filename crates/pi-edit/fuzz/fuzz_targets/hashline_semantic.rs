//! Coverage-guided semantic lane. `check_case` is a deterministic parametric
//! generator (bytes → coherent hashline case with real snapshot tags and
//! in-range anchors) plus a reference-model oracle, shared verbatim with the
//! stable property tests. libFuzzer's byte mutations therefore act as
//! structural mutations of generator-valid cases, and `cargo fuzz tmin`
//! shrinks the choice bytes, so reduced crashes stay generator-valid.
//! Decoding reads a bounded prefix (missing bytes read as zero), so every
//! input is accepted; `run.sh` caps `-max_len` to skip ignored tail bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../tests/support/semantic_case.rs"]
mod semantic_case;

fuzz_target!(|data: &[u8]| {
	if let Err(violation) = semantic_case::check_case(data) {
		panic!("hashline semantic oracle violated: {violation}");
	}
});
