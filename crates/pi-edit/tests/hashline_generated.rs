//! Generated hashline patches: coherent sections with real snapshot tags and
//! in-range original anchors, applied through a real `Session` and a disk
//! writer, and checked against an independent line model
//! (`support/semantic_case.rs`, shared with the coverage-guided fuzz target).

#[path = "support/semantic_case.rs"]
mod semantic_case;

mod common;

use std::cell::Cell;

use pi_edit::EditMode;
use proptest::{
	collection::vec,
	prelude::*,
	test_runner::{Config, RngAlgorithm, TestRng, TestRunner},
};
use semantic_case::{
	Lane, MAX_OPS, MAX_SECTIONS, MULTI_SECTION_BYTES, NONTRIVIAL_RANGE_BYTES, OP_BYTES,
	PRELUDE_BYTES, STALE_TAG_LATER_SECTION_BYTES, behavioral_fixture, check_case, encode_choices,
};

/// Choice sequences shaped as sections of op records. Shrinking drops whole
/// sections and ops and lowers single choices, so every shrunk candidate still
/// decodes to a coherent case with live tags and in-range anchors.
fn structured_case(lane: impl Strategy<Value = u8>) -> impl Strategy<Value = Vec<u8>> {
	let op = vec(any::<u8>(), OP_BYTES);
	let section = vec(op, 1..=MAX_OPS);
	(lane, vec(any::<u8>(), PRELUDE_BYTES - 1), vec(section, 1..=MAX_SECTIONS)).prop_map(
		|(lane, rest, sections)| {
			let mut prelude = Vec::with_capacity(PRELUDE_BYTES);
			prelude.push(lane);
			prelude.extend(rest);
			encode_choices(&prelude, &sections)
		},
	)
}

/// Deterministic runner: a fixed `ChaCha` seed keeps CI reproducible, and
/// failures report their shrunk input instead of writing regression files.
fn check_property<S: Strategy>(
	cases: u32,
	strategy: &S,
	test: impl Fn(S::Value) -> Result<(), TestCaseError>,
) {
	let config = Config { cases, failure_persistence: None, ..Config::default() };
	let mut runner =
		TestRunner::new_with_rng(config, TestRng::deterministic_rng(RngAlgorithm::ChaCha));
	if let Err(error) = runner.run(strategy, test) {
		panic!("{error}");
	}
}

fn checked(bytes: &[u8]) -> semantic_case::CaseMetrics {
	check_case(bytes).unwrap_or_else(|problem| panic!("{problem}"))
}

#[test]
fn generated_valid_patches_land_exactly_on_the_model() {
	let cases = Cell::new(0_usize);
	let applied = Cell::new(0_usize);
	let multi_line = Cell::new(0_usize);
	let moved = Cell::new(0_usize);
	let multi_section = Cell::new(0_usize);
	check_property(256, &structured_case(0_u8..8), |bytes| {
		let metrics = check_case(&bytes).map_err(TestCaseError::fail)?;
		prop_assert_eq!(metrics.lane, Lane::Valid);
		cases.set(cases.get() + 1);
		if metrics.stage_succeeded {
			applied.set(applied.get() + 1);
			multi_line.set(multi_line.get() + usize::from(metrics.max_replace_len >= 2));
			moved.set(moved.get() + usize::from(metrics.move_ops > 0 && metrics.writes > 0));
			multi_section.set(multi_section.get() + usize::from(metrics.writes >= 2));
		}
		Ok(())
	});
	// The property only means something if the semantic stage is reached:
	// most coherent patches must apply, including the shapes that carry risk.
	assert!(applied.get() * 4 >= cases.get() * 3, "{} of {} applied", applied.get(), cases.get());
	assert!(multi_line.get() > 0, "no multi-line range replacement applied");
	assert!(moved.get() > 0, "no register move applied");
	assert!(multi_section.get() > 0, "no multi-file write applied");
}

#[test]
fn a_faulty_later_section_aborts_staging_before_any_write() {
	check_property(192, &structured_case(8_u8..15), |bytes| {
		let metrics = check_case(&bytes).map_err(TestCaseError::fail)?;
		prop_assert!(!metrics.lane.is_valid());
		prop_assert!(!metrics.stage_succeeded);
		prop_assert_eq!(metrics.writes, 0);
		prop_assert!(
			metrics
				.invalid_section
				.is_some_and(|index| index >= 1 && index < metrics.sections)
		);
		Ok(())
	});
}

#[test]
fn arbitrary_choice_bytes_decode_to_checked_cases() {
	check_property(256, &vec(any::<u8>(), 0..=96), |bytes| {
		check_case(&bytes).map_err(TestCaseError::fail)?;
		Ok(())
	});
}

#[test]
fn multi_line_range_replacement_lands_exactly() {
	let metrics = checked(NONTRIVIAL_RANGE_BYTES);
	assert!(metrics.stage_succeeded);
	assert_eq!(metrics.writes, 1);
	assert_eq!(metrics.max_replace_len, 2);
}

#[test]
fn moves_inserts_and_cuts_across_crlf_bom_and_unterminated_files_land_exactly() {
	let metrics = checked(MULTI_SECTION_BYTES);
	assert!(metrics.stage_succeeded);
	assert_eq!(metrics.writes, 2);
	assert!(metrics.move_ops >= 1 && metrics.cut_ops >= 1 && metrics.insert_ops >= 3);
	assert!(metrics.max_replace_len >= 2);
}

#[test]
fn every_fault_lane_in_a_later_section_rejects_before_any_write() {
	for lane in Lane::ALL.into_iter().filter(|lane| !lane.is_valid()) {
		let mut bytes = STALE_TAG_LATER_SECTION_BYTES.to_vec();
		bytes[0] = lane.choice();
		let metrics = checked(&bytes);
		assert_eq!(metrics.lane, lane);
		assert_eq!(metrics.invalid_section, Some(1), "{}", lane.name());
		assert!(!metrics.stage_succeeded, "{}", lane.name());
		assert_eq!(metrics.writes, 0, "{}", lane.name());
	}
}

#[tokio::test]
async fn reduced_semantic_cases_replay_as_behavioral_json_fixtures() {
	for bytes in [NONTRIVIAL_RANGE_BYTES, MULTI_SECTION_BYTES] {
		let fixture = behavioral_fixture(bytes);
		common::run_case(&fixture, EditMode::Hashline)
			.await
			.unwrap_or_else(|error| panic!("{error}\n{fixture}"));
	}
	for lane in Lane::ALL.into_iter().filter(|lane| !lane.is_valid()) {
		let mut bytes = STALE_TAG_LATER_SECTION_BYTES.to_vec();
		bytes[0] = lane.choice();
		if lane == Lane::StaleTag {
			// The synthetic tag-bypass repro shrinks to just its lane choice.
			bytes.truncate(1);
		}
		let fixture = behavioral_fixture(&bytes);
		common::run_case(&fixture, EditMode::Hashline)
			.await
			.unwrap_or_else(|error| panic!("{error}\n{fixture}"));
	}
}
