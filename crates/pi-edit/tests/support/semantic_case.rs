//! Coherent generated hashline cases checked against an independent model.
//!
//! Shared by the stable property tests (`tests/hashline_generated.rs`) and the
//! coverage-guided fuzz target (`fuzz/fuzz_targets/hashline_semantic.rs`).
//!
//! Every byte string is a *choice sequence*: [`check_case`] reads it as
//! bounded choices (zero-padded when short, ignored past the last choice), so
//! any input decodes to a case whose section tags are the real content tags of
//! freshly written files and whose anchors name original lines that exist. A
//! byte mutation therefore changes the case structurally — op kind, range,
//! op/section count — instead of breaking the patch syntax, and deleting
//! choices or lowering them toward zero yields a smaller case that is still
//! coherent.
//!
//! Layout ([`encode_choices`] is the inverse):
//! - [`PRELUDE_BYTES`] fixed bytes: lane, faulty-section selector, fault
//!   detail, flags (bit 0 patch envelope, bit 1 untouched bystander file), then
//!   two bytes per file (line count; style bits: 0 no final newline, 1 CRLF, 2
//!   BOM, 3 indented lines, high nibble selects the kept line).
//! - Sections: the first is implicit; each later one follows a continue byte
//!   (odd continues). Inside a section the first op is implicit and each later
//!   op follows a continue byte; every op is [`OP_BYTES`] choice bytes (kind,
//!   start, length, destination, body).
//!
//! Lanes: [`Lane::Valid`] cases must apply and land byte-for-byte on the
//! model with untouched files unchanged. Every other lane corrupts exactly one
//! *later* section (index >= 1) and must be rejected while staging, before the
//! writer sees any request, leaving every file as it was.
#![allow(dead_code, reason = "the fuzz target and the property tests use different subsets")]

use std::{
	collections::BTreeMap,
	ffi::OsStr,
	fmt::Write,
	fs,
	future::Future,
	path::{Path, PathBuf},
	sync::{
		Mutex, PoisonError,
		atomic::{AtomicU64, Ordering},
	},
};

use async_trait::async_trait;
use pi_edit::{
	ApplyOutcome, ApplyRequest, EditError, EditMode, EditResult, EditStore, EditWriter, FileOp,
	PathPolicy, Session, WriteRequest, WriteResponse, path_policy::canonical_key,
	session::SessionConfig, store::file_hash,
};

/// Most file sections one case authors.
pub const MAX_SECTIONS: usize = 3;
/// Most ops one section authors.
pub const MAX_OPS: usize = 4;
/// Target files plus the untouched bystander.
pub const MAX_FILES: usize = MAX_SECTIONS + 1;
/// Fixed choice bytes before the first section.
pub const PRELUDE_BYTES: usize = 4 + 2 * MAX_FILES;
/// Choice bytes per op.
pub const OP_BYTES: usize = 5;

/// Valid lane, one section: `PUT 2.=3:` with a two-row body over a five-line
/// file.
pub const NONTRIVIAL_RANGE_BYTES: &[u8] = &[0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1];

/// Valid lane, two sections inside a patch envelope plus an untouched
/// bystander. `f0.txt` (six lines, CRLF, BOM) gets `CUT 4.=5 @m0x0` pasted by
/// `PUT >1 @m0x0`, `PUT >6:` and `CUT 2.=2`; `f1.txt` (four indented lines, no
/// final newline) gets `PUT <1:`, `PUT 3.=4:` with a blank middle row, and
/// `PUT >$:`.
pub const MULTI_SECTION_BYTES: &[u8] = &[
	0, 0, 0, 3, 4, 6, 2, 0x19, 0, 0, 1, 0, // prelude
	5, 3, 1, 0, 0, 1, 1, 5, 0, 0, 0, 1, 4, 1, 0, 0, 0, 0, // section 0
	1, // one more section
	2, 0, 0, 0, 5, 1, 0, 2, 2, 0, 0x44, 1, 3, 0, 0, 0, 0, 0, // section 1
	0,
];

/// Stale-tag lane: section 0 authors `PUT 2.=3:` on `f0.txt` under its live
/// tag; section 1 authors the same on `f1.txt` under the tag of an older
/// version. Replace byte 0 with another [`Lane::choice`] to fault section 1
/// differently.
pub const STALE_TAG_LATER_SECTION_BYTES: &[u8] =
	&[8, 0, 0, 0, 3, 0, 3, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1];

const MIN_LINES: usize = 2;
const MAX_LINES: usize = 9;
const MAX_RUN: usize = 3;
const MAX_BODY_ROWS: usize = 3;
const INDENTS: [&str; 4] = ["", "  ", "\t", "    "];

/// What a case expects from staging.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Lane {
	/// Every section is coherent; the patch must land exactly.
	#[default]
	Valid,
	/// The faulty section's header carries the tag of an older version.
	StaleTag,
	/// The faulty section anchors a line past the end of its file.
	OutOfRange,
	/// The faulty section authors `N.=M` with `N > M`.
	InvertedRange,
	/// The faulty section's extra hunk overlaps its first range replacement.
	Overlap,
	/// The faulty section's header has no tag.
	MissingTag,
	/// The faulty section targets a file that does not exist.
	MissingFile,
}

impl Lane {
	/// Every lane, valid first.
	pub const ALL: [Self; 7] = [
		Self::Valid,
		Self::StaleTag,
		Self::OutOfRange,
		Self::InvertedRange,
		Self::Overlap,
		Self::MissingTag,
		Self::MissingFile,
	];

	/// Lane selected by the first prelude byte.
	pub const fn from_choice(byte: u8) -> Self {
		match byte % 16 {
			8 | 9 => Self::StaleTag,
			10 => Self::OutOfRange,
			11 => Self::InvertedRange,
			12 => Self::Overlap,
			13 => Self::MissingTag,
			14 => Self::MissingFile,
			_ => Self::Valid,
		}
	}

	/// A first prelude byte selecting this lane.
	pub const fn choice(self) -> u8 {
		match self {
			Self::Valid => 0,
			Self::StaleTag => 8,
			Self::OutOfRange => 10,
			Self::InvertedRange => 11,
			Self::Overlap => 12,
			Self::MissingTag => 13,
			Self::MissingFile => 14,
		}
	}

	pub const fn is_valid(self) -> bool {
		matches!(self, Self::Valid)
	}

	pub const fn name(self) -> &'static str {
		match self {
			Self::Valid => "valid",
			Self::StaleTag => "stale-tag",
			Self::OutOfRange => "out-of-range",
			Self::InvertedRange => "inverted-range",
			Self::Overlap => "overlap",
			Self::MissingTag => "missing-tag",
			Self::MissingFile => "missing-file",
		}
	}
}

/// What one checked case exercised.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CaseMetrics {
	/// `Session::apply` staged every section and returned `Ok`.
	pub stage_succeeded: bool,
	pub lane:            Lane,
	/// Index of the corrupted section (always >= 1) outside the valid lane.
	pub invalid_section: Option<usize>,
	pub sections:        usize,
	/// Coherent ops authored across all sections (fault hunks excluded).
	pub ops:             usize,
	pub replace_ops:     usize,
	/// Longest replaced range, in original lines.
	pub max_replace_len: usize,
	pub insert_ops:      usize,
	pub cut_ops:         usize,
	pub move_ops:        usize,
	/// Requests the writer received.
	pub writes:          usize,
	/// Some section's edits reproduce its file byte-for-byte.
	pub noop:            bool,
}

/// Decode `bytes` into a case, apply it through a real [`Session`] and a
/// disk-backed writer, and check the outcome against the independent model.
///
/// `Err` is an oracle violation (or a scratch-directory I/O failure); its
/// text carries the rendered patch and the original files.
pub fn check_case(bytes: &[u8]) -> Result<CaseMetrics, String> {
	let case = decode(bytes);
	let scratch = ScratchDir::create()?;
	let root = scratch.path();
	let store = EditStore::new();
	let mut headers = Vec::with_capacity(case.sections.len());
	let mut targets = Vec::with_capacity(case.sections.len());
	for (index, file) in case.files.iter().take(case.sections.len()).enumerate() {
		let fault = (case.invalid == Some(index)).then_some(case.lane);
		let missing = fault == Some(Lane::MissingFile);
		let name = if missing {
			format!("gone{index}.txt")
		} else {
			file.name.clone()
		};
		let path = root.join(&name);
		let lf = file.lf_text();
		let (tag, before) = if missing {
			(file_hash(&lf), None)
		} else {
			let bytes = file.disk_text().into_bytes();
			write_file(&path, &bytes)?;
			(store.record(&canonical_key(&path), &lf, None), Some(bytes))
		};
		headers.push(match fault {
			Some(Lane::MissingTag) => format!("[{name}]"),
			Some(Lane::StaleTag) => format!("[{name}#{}]", stale_tag(file, &tag)),
			_ => format!("[{name}#{tag}]"),
		});
		targets.push(Tracked { name, path, before });
	}
	let mut bystanders = Vec::new();
	if let Some(file) = case.files.get(case.sections.len()) {
		let path = root.join(&file.name);
		let bytes = file.disk_text().into_bytes();
		write_file(&path, &bytes)?;
		bystanders.push(Tracked { name: file.name.clone(), path, before: Some(bytes) });
	}

	let patch = render_patch(&case, &headers);
	let writer = RecordingDiskWriter::default();
	let result = apply_patch(root, store, &patch, &writer)?;
	let requests = writer.into_requests();

	let mut metrics = tally(&case);
	metrics.stage_succeeded = result.is_ok();
	metrics.writes = requests.len();
	let verdict = if case.lane.is_valid() {
		let expectations = expectations(&case, &targets);
		metrics.noop = expectations.iter().any(|expected| expected.noop);
		verify_applied(&expectations, &result, &requests, &bystanders)
	} else {
		verify_rejected(&result, &requests, targets.iter().chain(&bystanders))
	};
	verdict
		.map(|()| metrics)
		.map_err(|problem| describe_failure(&case, &patch, &problem))
}

/// Materialize a shrunk choice sequence as one existing hashline fixture case.
/// The expected bytes come from the independent model, never from the edit
/// engine; callers wrap this value in `{"cases":[...]}` for `run_fixture`.
pub fn behavioral_fixture(bytes: &[u8]) -> serde_json::Value {
	let case = decode(bytes);
	let mut files = BTreeMap::new();
	let mut expected_files = BTreeMap::new();
	let mut snapshots = Vec::with_capacity(case.sections.len());
	let mut headers = Vec::with_capacity(case.sections.len());
	let mut changed = 0;
	let mut has_noop = false;

	for (index, file) in case.files.iter().enumerate() {
		let faulty = case.invalid == Some(index);
		let missing = faulty && case.lane == Lane::MissingFile;
		let name = if missing {
			format!("gone{index}.txt")
		} else {
			file.name.clone()
		};
		let lf = file.lf_text();
		if let Some(section) = case.sections.get(index) {
			let live = file_hash(&lf);
			let header = match (faulty, case.lane) {
				(true, Lane::MissingTag) => format!("[{name}]"),
				(true, Lane::StaleTag) => format!("[{name}#{}]", stale_tag(file, &live)),
				(true, Lane::MissingFile) => format!("[{name}#{live}]"),
				_ => format!("[{name}#{{{{tag:{name}}}}}]"),
			};
			headers.push(header);
			if !missing {
				snapshots.push(serde_json::json!({ "path": name, "text": lf }));
			}
			if !missing && case.lane.is_valid() {
				let modeled = model_lines(file, &section.ops);
				if modeled == file.lines {
					has_noop = true;
				} else {
					changed += 1;
					expected_files.insert(
						name.clone(),
						persisted(&join_lines(&modeled, file.final_newline), file.crlf, file.bom),
					);
				}
			}
		}
		if !missing {
			let before = file.disk_text();
			files.insert(name.clone(), before.clone());
			expected_files.entry(name).or_insert(before);
		}
	}

	let rejects = !case.lane.is_valid() || (case.sections.len() > 1 && has_noop);
	let mut expect = serde_json::json!({
		"files": if rejects { &files } else { &expected_files },
		"writes": if rejects { 0 } else { changed },
	});
	if rejects {
		// An empty substring requires an error without freezing its wording.
		expect["error"] = serde_json::json!("");
	}
	if case.lane == Lane::MissingFile {
		expect["deleted"] = serde_json::json!([format!(
			"gone{}.txt",
			case
				.invalid
				.expect("missing-file lane has a faulty section")
		)]);
	}
	serde_json::json!({
		"name": format!("generated {} hashline regression", case.lane.name()),
		"mode": "hashline",
		"files": files,
		"snapshots": snapshots,
		"args": { "input": render_patch(&case, &headers) },
		"expect": expect,
	})
}

/// Encode a prelude plus per-section op records as a choice sequence
/// [`check_case`] decodes back to exactly those choices. Short records are
/// zero-padded, long ones truncated; empty lists become one zero record.
pub fn encode_choices(prelude: &[u8], sections: &[Vec<Vec<u8>>]) -> Vec<u8> {
	let mut bytes: Vec<u8> = (0..PRELUDE_BYTES)
		.map(|index| prelude.get(index).copied().unwrap_or(0))
		.collect();
	let section_count = sections.len().clamp(1, MAX_SECTIONS);
	for section in 0..section_count {
		if section > 0 {
			bytes.push(1);
		}
		let ops = sections.get(section).map_or(&[][..], Vec::as_slice);
		let op_count = ops.len().clamp(1, MAX_OPS);
		for op in 0..op_count {
			if op > 0 {
				bytes.push(1);
			}
			let record = ops.get(op).map_or(&[][..], Vec::as_slice);
			bytes.extend((0..OP_BYTES).map(|index| record.get(index).copied().unwrap_or(0)));
		}
		if op_count < MAX_OPS {
			bytes.push(0);
		}
	}
	if section_count < MAX_SECTIONS {
		bytes.push(0);
	}
	bytes
}

// ── Choice decoding ──────────────────────────────────────────────────────────

struct Choices<'a> {
	bytes:    &'a [u8],
	position: usize,
}

impl Choices<'_> {
	fn byte(&mut self) -> u8 {
		let byte = self.bytes.get(self.position).copied().unwrap_or(0);
		self.position += 1;
		byte
	}

	fn record<const N: usize>(&mut self) -> [u8; N] {
		std::array::from_fn(|_| self.byte())
	}

	fn more(&mut self) -> bool {
		self.byte() & 1 == 1
	}
}

struct FileSpec {
	name:          String,
	/// Unique rows, so every model line is attributable to one origin.
	lines:         Vec<String>,
	final_newline: bool,
	crlf:          bool,
	bom:           bool,
	/// Never deleted, so no edit empties the file.
	keeper:        usize,
}

impl FileSpec {
	fn decode(index: usize, count: u8, style: u8) -> Self {
		let count = MIN_LINES + usize::from(count) % (MAX_LINES - MIN_LINES + 1);
		let indented = style & 8 != 0;
		let lines = (1..=count)
			.map(|line| {
				let indent = if indented {
					INDENTS[line % INDENTS.len()]
				} else {
					""
				};
				format!("{indent}f{index} line {line}")
			})
			.collect();
		Self {
			name: format!("f{index}.txt"),
			lines,
			final_newline: style & 1 == 0,
			crlf: style & 2 != 0,
			bom: style & 4 != 0,
			keeper: usize::from(style >> 4) % count,
		}
	}

	/// LF-normalized, BOM-free text: what the snapshot tag hashes.
	fn lf_text(&self) -> String {
		join_lines(&self.lines, self.final_newline)
	}

	fn disk_text(&self) -> String {
		persisted(&self.lf_text(), self.crlf, self.bom)
	}
}

/// One coherent op. Lines are 1-based original line numbers.
enum Op {
	Replace {
		start: usize,
		end:   usize,
		body:  Vec<String>,
	},
	InsertBefore {
		line: usize,
		body: Vec<String>,
	},
	InsertAfter {
		line: usize,
		body: Vec<String>,
	},
	InsertEof {
		body: Vec<String>,
	},
	Cut {
		start: usize,
		end:   usize,
	},
	/// `CUT start.=end @register`, then paste after (`below`) or before `dest`.
	Move {
		start:    usize,
		end:      usize,
		dest:     usize,
		below:    bool,
		register: String,
	},
}

struct Section {
	ops:        Vec<Op>,
	/// Hunk appended to the faulty section by range-shaped lanes.
	fault_hunk: Option<String>,
}

struct Case {
	lane:     Lane,
	invalid:  Option<usize>,
	envelope: bool,
	/// File `i` is section `i`'s target; the bystander, when present, follows
	/// the last target.
	files:    Vec<FileSpec>,
	sections: Vec<Section>,
}

fn decode(bytes: &[u8]) -> Case {
	let mut choices = Choices { bytes, position: 0 };
	let prelude: [u8; PRELUDE_BYTES] = choices.record();
	let lane = Lane::from_choice(prelude[0]);
	let invalid = (!lane.is_valid()).then(|| 1 + usize::from(prelude[1]) % (MAX_SECTIONS - 1));
	let mut files: Vec<FileSpec> = (0..MAX_FILES)
		.map(|index| FileSpec::decode(index, prelude[4 + 2 * index], prelude[5 + 2 * index]))
		.collect();
	// A fault must sit after at least one coherent section.
	let required = invalid.map_or(1, |index| index + 1);
	let mut sections = Vec::with_capacity(MAX_SECTIONS);
	loop {
		let index = sections.len();
		let faulty = invalid == Some(index);
		// Tag and overlap faults need an anchored range to act on.
		let force_replace = faulty && matches!(lane, Lane::StaleTag | Lane::Overlap);
		let mut section = decode_section(&mut choices, index, &files[index], force_replace);
		if faulty {
			section.fault_hunk = fault_hunk(lane, prelude[2], index, &files[index], &section.ops);
		}
		sections.push(section);
		if sections.len() == MAX_SECTIONS {
			break;
		}
		if !choices.more() && sections.len() >= required {
			break;
		}
	}
	let bystander = prelude[3] & 2 != 0;
	files.truncate(sections.len() + usize::from(bystander));
	Case { lane, invalid, envelope: prelude[3] & 1 != 0, files, sections }
}

fn decode_section(
	choices: &mut Choices<'_>,
	section: usize,
	file: &FileSpec,
	force_replace: bool,
) -> Section {
	let mut planner = Planner { file, used: vec![false; file.lines.len()], eof_used: false };
	let mut ops = Vec::new();
	for op in 0..MAX_OPS {
		if op > 0 && !choices.more() {
			break;
		}
		let record: [u8; OP_BYTES] = choices.record();
		let kind = if op == 0 && force_replace {
			0
		} else {
			record[0] % 6
		};
		// The first op always finds room: a fresh file has a free non-kept line.
		if let Some(planned) = planner.plan(kind, record, section, op) {
			ops.push(planned);
		}
	}
	Section { ops, fault_hunk: None }
}

/// Places ops so each original line takes part in at most one of them and the
/// kept line is never deleted; a choice that finds no room drops its op.
struct Planner<'a> {
	file:     &'a FileSpec,
	used:     Vec<bool>,
	eof_used: bool,
}

impl Planner<'_> {
	fn plan(&mut self, kind: u8, record: [u8; OP_BYTES], section: usize, op: usize) -> Option<Op> {
		match kind {
			0 => {
				let (start, end) = self.run(record[1], record[2])?;
				self.mark(start, end, true);
				Some(Op::Replace { start, end, body: body_rows(record[4], section, op) })
			},
			1 | 2 => {
				let line = self.line(record[1])?;
				self.mark(line, line, true);
				let body = body_rows(record[4], section, op);
				Some(if kind == 1 {
					Op::InsertAfter { line, body }
				} else {
					Op::InsertBefore { line, body }
				})
			},
			3 => {
				if self.eof_used {
					return None;
				}
				self.eof_used = true;
				Some(Op::InsertEof { body: body_rows(record[4], section, op) })
			},
			4 => {
				let (start, end) = self.run(record[1], record[2])?;
				self.mark(start, end, true);
				Some(Op::Cut { start, end })
			},
			_ => {
				let (start, end) = self.run(record[1], record[2])?;
				self.mark(start, end, true);
				let Some(dest) = self.line(record[3]) else {
					self.mark(start, end, false);
					return None;
				};
				self.mark(dest, dest, true);
				Some(Op::Move {
					start,
					end,
					dest,
					below: record[4] & 1 == 0,
					register: format!("m{section}x{op}"),
				})
			},
		}
	}

	/// The first free, deletable line at or after `start` (wrapping), extended
	/// over free deletable lines up to the chosen length.
	fn run(&self, start: u8, length: u8) -> Option<(usize, usize)> {
		let count = self.used.len();
		let want = 1 + usize::from(length) % MAX_RUN;
		let deletable = |index: usize| !self.used[index] && index != self.file.keeper;
		let first = (0..count)
			.map(|offset| (usize::from(start) + offset) % count)
			.find(|&index| deletable(index))?;
		let mut last = first;
		while last + 1 < count && last + 1 - first < want && deletable(last + 1) {
			last += 1;
		}
		Some((first + 1, last + 1))
	}

	/// The first free line at or after `choice` (wrapping); may be the kept
	/// line, which inserts never delete.
	fn line(&self, choice: u8) -> Option<usize> {
		let count = self.used.len();
		(0..count)
			.map(|offset| (usize::from(choice) + offset) % count)
			.find(|&index| !self.used[index])
			.map(|index| index + 1)
	}

	fn mark(&mut self, start: usize, end: usize, used: bool) {
		self.used[start - 1..end].fill(used);
	}
}

/// Unique payload rows; a blank row only ever sits between two others, so no
/// body starts or ends blank.
fn body_rows(choice: u8, section: usize, op: usize) -> Vec<String> {
	let rows = 1 + usize::from(choice) % MAX_BODY_ROWS;
	let indent = INDENTS[usize::from(choice >> 2) % 3];
	let blank_middle = rows == 3 && choice & 0x40 != 0;
	(0..rows)
		.map(|row| {
			if blank_middle && row == 1 {
				String::new()
			} else {
				format!("{indent}s{section}o{op}r{row}")
			}
		})
		.collect()
}

/// The extra hunk a range-shaped fault appends to its section.
fn fault_hunk(
	lane: Lane,
	detail: u8,
	section: usize,
	file: &FileSpec,
	ops: &[Op],
) -> Option<String> {
	let count = file.lines.len();
	let bad = format!("bad{section}");
	match lane {
		Lane::OutOfRange => {
			// Past the phantom row a final newline adds, so never a real line.
			let line = count + 2 + usize::from(detail >> 2) % 3;
			Some(match detail % 3 {
				0 => format!("PUT {line}.={}:\n+{bad}\n", line + 1),
				1 => format!("PUT >{line}:\n+{bad}\n"),
				_ => format!("CUT {line}.={line}\n"),
			})
		},
		Lane::InvertedRange => {
			let low = 1 + usize::from(detail >> 2) % (count - 1);
			let high = low + 1;
			Some(if detail.is_multiple_of(2) {
				format!("PUT {high}.={low}:\n+{bad}\n")
			} else {
				format!("CUT {high}.={low}\n")
			})
		},
		Lane::Overlap => {
			// Strictly wider than the first replacement, so never an exact
			// duplicate the parser would coalesce. The kept line guarantees the
			// replacement leaves room on one side.
			let (low, high) = match ops.first() {
				Some(Op::Replace { start, end, .. }) if *end < count => (*start, end + 1),
				Some(Op::Replace { start, end, .. }) => (start - 1, *end),
				_ => (1, count),
			};
			Some(if detail.is_multiple_of(2) {
				format!("PUT {low}.={high}:\n+{bad}\n")
			} else {
				format!("CUT {low}.={high}\n")
			})
		},
		_ => None,
	}
}

// ── Independent model ────────────────────────────────────────────────────────

/// Expected lines: per original line, its before-inserts, the replacement body
/// a range starts there, the line itself unless deleted, then its
/// after-inserts; EOF inserts close the file. Moves carry original lines.
fn model_lines(file: &FileSpec, ops: &[Op]) -> Vec<String> {
	let count = file.lines.len();
	let mut before = vec![Vec::new(); count];
	let mut replacement = vec![Vec::new(); count];
	let mut after = vec![Vec::new(); count];
	let mut deleted = vec![false; count];
	let mut eof = Vec::new();
	for op in ops {
		match op {
			Op::Replace { start, end, body } => {
				replacement[start - 1].clone_from(body);
				deleted[start - 1..*end].fill(true);
			},
			Op::InsertBefore { line, body } => before[line - 1].extend_from_slice(body),
			Op::InsertAfter { line, body } => after[line - 1].extend_from_slice(body),
			Op::InsertEof { body } => eof.extend_from_slice(body),
			Op::Cut { start, end } => deleted[start - 1..*end].fill(true),
			Op::Move { start, end, dest, below, .. } => {
				deleted[start - 1..*end].fill(true);
				let moved = &file.lines[start - 1..*end];
				if *below {
					after[dest - 1].extend_from_slice(moved);
				} else {
					before[dest - 1].extend_from_slice(moved);
				}
			},
		}
	}
	let mut lines = Vec::with_capacity(count);
	for index in 0..count {
		lines.append(&mut before[index]);
		lines.append(&mut replacement[index]);
		if !deleted[index] {
			lines.push(file.lines[index].clone());
		}
		lines.append(&mut after[index]);
	}
	lines.append(&mut eof);
	lines
}

fn join_lines(lines: &[String], final_newline: bool) -> String {
	let mut text = lines.join("\n");
	if final_newline {
		text.push('\n');
	}
	text
}

/// Bytes the file keeps on disk: its BOM and line-ending style survive edits.
fn persisted(lf: &str, crlf: bool, bom: bool) -> String {
	let mut text = String::with_capacity(lf.len() + 3);
	if bom {
		text.push('\u{feff}');
	}
	if crlf {
		text.push_str(&lf.replace('\n', "\r\n"));
	} else {
		text.push_str(lf);
	}
	text
}

/// Tag of an older version of `file` that the store never saw; differs from
/// the live tag.
fn stale_tag(file: &FileSpec, live: &str) -> String {
	let mut older = file.lines.clone();
	older[file.keeper].push_str(" (older)");
	let tag = file_hash(&join_lines(&older, file.final_newline));
	if tag == live {
		let flipped = u16::from_str_radix(live, 16).unwrap_or_default() ^ 0x8000;
		format!("{flipped:04X}")
	} else {
		tag
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────

fn render_patch(case: &Case, headers: &[String]) -> String {
	let mut patch = String::new();
	if case.envelope {
		patch.push_str("*** Begin Patch\n");
	}
	for (section, header) in case.sections.iter().zip(headers) {
		patch.push_str(header);
		patch.push('\n');
		for op in &section.ops {
			render_op(op, &mut patch);
		}
		if let Some(hunk) = &section.fault_hunk {
			patch.push_str(hunk);
		}
	}
	if case.envelope {
		patch.push_str("*** End Patch\n");
	}
	patch
}

fn render_op(op: &Op, patch: &mut String) {
	match op {
		Op::Replace { start, end, body } => {
			let _ = writeln!(patch, "PUT {start}.={end}:");
			push_body(patch, body);
		},
		Op::InsertBefore { line, body } => {
			let _ = writeln!(patch, "PUT <{line}:");
			push_body(patch, body);
		},
		Op::InsertAfter { line, body } => {
			let _ = writeln!(patch, "PUT >{line}:");
			push_body(patch, body);
		},
		Op::InsertEof { body } => {
			patch.push_str("PUT >$:\n");
			push_body(patch, body);
		},
		Op::Cut { start, end } => {
			let _ = writeln!(patch, "CUT {start}.={end}");
		},
		Op::Move { start, end, dest, below, register } => {
			let side = if *below { '>' } else { '<' };
			let _ = writeln!(patch, "CUT {start}.={end} @{register}\nPUT {side}{dest} @{register}");
		},
	}
}

fn push_body(patch: &mut String, body: &[String]) {
	for row in body {
		patch.push('+');
		patch.push_str(row);
		patch.push('\n');
	}
}

fn tally(case: &Case) -> CaseMetrics {
	let mut metrics = CaseMetrics {
		lane: case.lane,
		invalid_section: case.invalid,
		sections: case.sections.len(),
		..CaseMetrics::default()
	};
	for op in case.sections.iter().flat_map(|section| &section.ops) {
		metrics.ops += 1;
		match op {
			Op::Replace { start, end, .. } => {
				metrics.replace_ops += 1;
				metrics.max_replace_len = metrics.max_replace_len.max(end - start + 1);
			},
			Op::InsertBefore { .. } | Op::InsertAfter { .. } | Op::InsertEof { .. } => {
				metrics.insert_ops += 1;
			},
			Op::Cut { .. } => metrics.cut_ops += 1,
			Op::Move { .. } => metrics.move_ops += 1,
		}
	}
	metrics
}

// ── Execution ────────────────────────────────────────────────────────────────

struct ScratchDir(PathBuf);

impl ScratchDir {
	fn create() -> Result<Self, String> {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let unique = NEXT.fetch_add(1, Ordering::Relaxed);
		let path =
			std::env::temp_dir().join(format!("pi-edit-semantic-{}-{unique}", std::process::id()));
		let _ = fs::remove_dir_all(&path);
		fs::create_dir_all(&path).map_err(|error| format!("create {}: {error}", path.display()))?;
		match path.canonicalize() {
			Ok(canonical) => Ok(Self(canonical)),
			Err(error) => {
				let _ = fs::remove_dir_all(&path);
				Err(format!("canonicalize {}: {error}", path.display()))
			},
		}
	}

	fn path(&self) -> &Path {
		&self.0
	}
}

impl Drop for ScratchDir {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
	fs::write(path, bytes).map_err(|error| format!("write {}: {error}", path.display()))
}

/// Persists every request to disk and records it, like a host writer.
#[derive(Default)]
struct RecordingDiskWriter {
	requests: Mutex<Vec<WriteRequest>>,
}

impl RecordingDiskWriter {
	fn into_requests(self) -> Vec<WriteRequest> {
		self
			.requests
			.into_inner()
			.unwrap_or_else(PoisonError::into_inner)
	}
}

#[async_trait]
impl EditWriter for RecordingDiskWriter {
	async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
		self
			.requests
			.lock()
			.unwrap_or_else(PoisonError::into_inner)
			.push(request.clone());
		let written = match request.op {
			FileOp::Create | FileOp::Update => {
				let content = request.content.unwrap_or_default();
				let target = request.move_to.as_ref().unwrap_or(&request.absolute);
				fs::write(target, &content).map_err(|error| EditError::Writer(error.to_string()))?;
				if request.move_to.is_some() {
					fs::remove_file(&request.absolute)
						.map_err(|error| EditError::Writer(error.to_string()))?;
				}
				content
			},
			FileOp::Delete => {
				fs::remove_file(&request.absolute)
					.map_err(|error| EditError::Writer(error.to_string()))?;
				String::new()
			},
			FileOp::Noop => String::new(),
		};
		Ok(WriteResponse { written, diagnostics_json: None })
	}
}

thread_local! {
	static RUNTIME: Result<tokio::runtime::Runtime, String> =
		tokio::runtime::Builder::new_current_thread()
			.build()
			.map_err(|error| format!("tokio runtime: {error}"));
}

/// Drive `future` on this thread's current-thread runtime. Callers must not
/// already be inside a Tokio runtime.
fn block_on<F: Future>(future: F) -> Result<F::Output, String> {
	RUNTIME.with(|runtime| match runtime {
		Ok(runtime) => Ok(runtime.block_on(future)),
		Err(error) => Err(error.clone()),
	})
}

fn apply_patch(
	root: &Path,
	store: EditStore,
	patch: &str,
	writer: &RecordingDiskWriter,
) -> Result<EditResult<ApplyOutcome>, String> {
	let config = SessionConfig {
		mode:               EditMode::Hashline,
		policy:             PathPolicy {
			cwd:                  root.to_path_buf(),
			home_dir:             root.to_path_buf(),
			url_schemes:          Vec::new(),
			url_alias_schemes:    Vec::new(),
			plan_writable_roots:  Vec::new(),
			plan_active:          false,
			block_auto_generated: true,
		},
		allow_fuzzy:        false,
		fuzzy_threshold:    0.95,
		enforce_seen_lines: false,
		raw_input:          true,
	};
	let mut session = Session::new(config, store);
	session.push(patch);
	session.finish();
	block_on(session.apply(ApplyRequest::default(), writer))
}

// ── Verification ─────────────────────────────────────────────────────────────

/// A file the case knows about and its bytes before apply (`None`: absent).
struct Tracked {
	name:   String,
	path:   PathBuf,
	before: Option<Vec<u8>>,
}

struct Expectation<'a> {
	target: &'a Tracked,
	/// Model bytes on disk after apply.
	after:  Vec<u8>,
	/// The model reproduces the original file.
	noop:   bool,
}

fn expectations<'a>(case: &Case, targets: &'a [Tracked]) -> Vec<Expectation<'a>> {
	case
		.sections
		.iter()
		.zip(&case.files)
		.zip(targets)
		.map(|((section, file), target)| {
			let lines = model_lines(file, &section.ops);
			let noop = lines == file.lines;
			let after = persisted(&join_lines(&lines, file.final_newline), file.crlf, file.bom);
			Expectation { target, after: after.into_bytes(), noop }
		})
		.collect()
}

fn verify_applied(
	expectations: &[Expectation<'_>],
	result: &EditResult<ApplyOutcome>,
	requests: &[WriteRequest],
	bystanders: &[Tracked],
) -> Result<(), String> {
	if expectations.len() > 1 && expectations.iter().any(|expected| expected.noop) {
		// A byte-identical section rejects a multi-section call during staging.
		if result.is_ok() {
			return Err("a multi-section patch with a byte-identical section applied".into());
		}
		no_requests(requests)?;
		return unchanged(
			expectations
				.iter()
				.map(|expected| expected.target)
				.chain(bystanders),
		);
	}
	let outcome = result
		.as_ref()
		.map_err(|error| format!("coherent patch was rejected: {error}"))?;
	let staged: Vec<FileOp> = outcome.files.iter().map(|file| file.op).collect();
	let modeled: Vec<FileOp> = expectations
		.iter()
		.map(|expected| {
			if expected.noop {
				FileOp::Noop
			} else {
				FileOp::Update
			}
		})
		.collect();
	if staged != modeled {
		return Err(format!("staged ops {staged:?}; model expects {modeled:?}"));
	}
	let writes: Vec<&Expectation<'_>> = expectations
		.iter()
		.filter(|expected| !expected.noop)
		.collect();
	if requests.len() != writes.len() {
		return Err(format!(
			"writer received {} request(s) for {} changed file(s)",
			requests.len(),
			writes.len()
		));
	}
	for (request, expected) in requests.iter().zip(&writes) {
		if request.absolute.file_name() != Some(OsStr::new(&expected.target.name)) {
			return Err(format!(
				"write for {} landed on {}",
				expected.target.name,
				request.absolute.display()
			));
		}
		if request.op != FileOp::Update || request.move_to.is_some() {
			return Err(format!(
				"write for {} is {:?} (move_to {:?}), not an in-place update",
				expected.target.name, request.op, request.move_to
			));
		}
		let sent = request.content.as_deref().map(str::as_bytes);
		if sent != Some(expected.after.as_slice()) {
			return Err(format!(
				"write for {} sent {}; model expects {}",
				expected.target.name,
				shown(sent),
				shown(Some(expected.after.as_slice()))
			));
		}
	}
	for expected in expectations {
		let on_disk = fs::read(&expected.target.path).ok();
		let modeled = if expected.noop {
			expected.target.before.as_deref()
		} else {
			Some(expected.after.as_slice())
		};
		if on_disk.as_deref() != modeled {
			return Err(format!(
				"{} on disk is {}; model expects {}",
				expected.target.name,
				shown(on_disk.as_deref()),
				shown(modeled)
			));
		}
	}
	unchanged(bystanders)
}

fn verify_rejected<'a>(
	result: &EditResult<ApplyOutcome>,
	requests: &[WriteRequest],
	tracked: impl IntoIterator<Item = &'a Tracked>,
) -> Result<(), String> {
	if let Ok(outcome) = result {
		return Err(format!(
			"the faulty later section staged; apply reported {} file(s) after {} write(s)",
			outcome.files.len(),
			requests.len()
		));
	}
	no_requests(requests)?;
	unchanged(tracked)
}

fn no_requests(requests: &[WriteRequest]) -> Result<(), String> {
	if requests.is_empty() {
		return Ok(());
	}
	let targets: Vec<String> = requests
		.iter()
		.map(|request| request.absolute.display().to_string())
		.collect();
	Err(format!("staging failed but the writer was called for {targets:?}"))
}

fn unchanged<'a>(tracked: impl IntoIterator<Item = &'a Tracked>) -> Result<(), String> {
	for file in tracked {
		let now = fs::read(&file.path).ok();
		if now != file.before {
			return Err(format!(
				"{} changed from {} to {}",
				file.name,
				shown(file.before.as_deref()),
				shown(now.as_deref())
			));
		}
	}
	Ok(())
}

fn shown(bytes: Option<&[u8]>) -> String {
	bytes.map_or_else(
		|| "<absent>".to_owned(),
		|bytes| format!("{:?}", String::from_utf8_lossy(bytes)),
	)
}

/// The oracle problem leads (the reducer classes violations by that first
/// line), then the case context: lane, faulty section, patch, and files.
fn describe_failure(case: &Case, patch: &str, problem: &str) -> String {
	let mut text = format!(
		"{problem}\n--- {} lane, faulty section {:?} ---\n--- patch ---\n{patch}",
		case.lane.name(),
		case.invalid
	);
	for file in &case.files {
		let _ = writeln!(text, "--- {} (LF view) ---\n{:?}", file.name, file.lf_text());
	}
	text
}
