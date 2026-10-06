//! `hashline_stream` harness: an arbitrary hashline payload, streamed as
//! tool-call argument deltas through a real [`Session`] over a temp
//! workspace, then applied through a recording writer that never fails and
//! never touches disk.
//!
//! This is the parser/streaming robustness lane. Unlike the semantic target
//! (`../tests/support/semantic_case.rs`, generated-valid cases with a
//! reference model) it feeds anything — lenient legacy forms, broken
//! headers, stale tags — so it only asserts contracts that hold for EVERY
//! input:
//!
//! 1. Parsing is deterministic: two independent `Patch::parse` runs yield the
//!    same sections, tags, and per-section `Parsed`/error.
//! 2. Streamed JSON projection (`stream_json.rs`): after every delta the
//!    projected `input` is a prefix of the final input, `complete` is set
//!    exactly when the whole argument text has arrived, and the finished
//!    projection equals the payload.
//! 3. Apply atomicity (`session.rs` `Session::apply` docs): with a writer that
//!    never fails, a failed apply issued no write; a successful apply wrote
//!    each non-noop staged file exactly once, in outcome order, with content
//!    present unless it is a delete (`engine.rs` `StagedFile::persisted`).
//!
//! Panics anywhere (parser, preview, stage) surface as libFuzzer crashes.
//! It never checks that the Lark grammar and the runtime parser accept the
//! same language: the runtime intentionally accepts recovery forms.
//!
//! # Input container
//! `control byte` + (`path` NUL `content` NUL){0..=4} + `payload`, the rest
//! decoded as lossy UTF-8. `{{tag:PATH}}` in the payload is replaced with
//! the snapshot tag minted for container file `PATH` (the real
//! `store::file_hash` of its editable text), so fixture seeds and mutated
//! inputs keep reaching past the tag check. Control bits: see [`control`].

use std::path::Path;

use async_trait::async_trait;
use parking_lot::Mutex;
use pi_edit::{
	ApplyRequest, EditMode, EditResult, EditStore, EditWriter, FileOp, PathPolicy, Session,
	WriteRequest, WriteResponse,
	modes::hashline::input::{
		Parsed, Patch, SplitOptions, contains_recognizable_hashline_operations,
	},
	path_policy::canonical_key,
	session::SessionConfig,
	stream_json::{ArgSnapshot, ArgStream},
	text::{normalize_to_lf, strip_bom},
};

/// Inputs above this are ignored (pass `-max_len` with the same value).
pub const MAX_INPUT_BYTES: usize = 8 * 1024;
/// Container files beyond this are ignored.
pub const MAX_FILES: usize = 4;
const MAX_PATH_BYTES: usize = 64;

/// Control-byte layout.
pub mod control {
	/// `1 + (control & CHUNKS_MASK)` argument deltas (1..=32).
	pub const CHUNKS_MASK: u8 = 0x1f;
	/// JSON key `_input` instead of `input`.
	pub const INPUT_ALIAS: u8 = 0x20;
	/// Custom-format tool: the payload is streamed verbatim, not as JSON.
	pub const RAW_INPUT: u8 = 0x40;
	/// `enforce_seen_lines` session policy. Each container file is recorded
	/// as if a truncated read displayed its first half (lines
	/// `1..=ceil(n/2)`), so anchors inside it apply and anchors past it
	/// reject before any write. Without the bit no provenance is recorded.
	pub const ENFORCE_SEEN: u8 = 0x80;
}

/// Decoded container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamCase {
	pub control: u8,
	/// `(relative path, content)`, unique safe paths only.
	pub files:   Vec<(String, String)>,
	pub payload: String,
}

impl StreamCase {
	pub fn decode(bytes: &[u8]) -> Option<Self> {
		let (&control, rest) = bytes.split_first()?;
		let text = String::from_utf8_lossy(rest);
		let mut parts: Vec<&str> = text.split('\0').collect();
		let payload = parts.pop().unwrap_or_default().to_owned();
		let mut files: Vec<(String, String)> = Vec::new();
		for pair in parts.as_chunks::<2>().0 {
			if files.len() == MAX_FILES {
				break;
			}
			let (path, content) = (pair[0], pair[1]);
			if is_safe_relative_path(path) && !files.iter().any(|(known, _)| known == path) {
				files.push((path.to_owned(), content.to_owned()));
			}
		}
		Some(Self { control, files, payload })
	}

	/// Inverse of [`Self::decode`] for NUL-free paths/contents/payload.
	pub fn encode(&self) -> Vec<u8> {
		let mut out = Vec::with_capacity(
			1 + self.payload.len()
				+ self
					.files
					.iter()
					.map(|(path, content)| path.len() + content.len() + 2)
					.sum::<usize>(),
		);
		out.push(self.control);
		for (path, content) in &self.files {
			out.extend(path.bytes().filter(|&b| b != 0));
			out.push(0);
			out.extend(content.bytes().filter(|&b| b != 0));
			out.push(0);
		}
		out.extend(self.payload.bytes().filter(|&b| b != 0));
		out
	}

	/// Container file content by relative path.
	pub fn file(&self, path: &str) -> Option<&str> {
		self
			.files
			.iter()
			.find(|(known, _)| known == path)
			.map(|(_, content)| content.as_str())
	}
}

/// Per-input outcome, for sampling statistics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StreamMetrics {
	/// Passed the container/host-safety guards and ran.
	pub executed:        bool,
	/// `Patch::parse` accepted the payload.
	pub parse_succeeded: bool,
	/// Staging succeeded and apply completed.
	pub stage_succeeded: bool,
	/// Writer calls during apply.
	pub writes:          usize,
}

/// Run one input. `Err` means a contract listed in the module docs broke.
pub fn check_stream(bytes: &[u8]) -> Result<StreamMetrics, String> {
	if bytes.len() > MAX_INPUT_BYTES {
		return Ok(StreamMetrics::default());
	}
	let Some(case) = StreamCase::decode(bytes) else {
		return Ok(StreamMetrics::default());
	};
	if touches_host_devices(&case.payload) {
		return Ok(StreamMetrics::default());
	}

	let dir = tempfile::tempdir().expect("harness: create temp workspace");
	let cwd = dir
		.path()
		.canonicalize()
		.expect("harness: canonical temp workspace");
	let store = EditStore::new();
	let enforce_seen_lines = case.control & control::ENFORCE_SEEN != 0;
	let mut tags: Vec<(String, String)> = Vec::with_capacity(case.files.len());
	for (rel, content) in &case.files {
		let path = cwd.join(rel);
		if let Some(parent) = path.parent()
			&& std::fs::create_dir_all(parent).is_err()
		{
			continue;
		}
		// `a` and `a/b` in one container conflict; the loser is just absent.
		if std::fs::write(&path, content).is_err() {
			continue;
		}
		let editable = normalize_to_lf(strip_bom(content).1);
		let seen: Vec<u32> = if enforce_seen_lines {
			let shown = editable.lines().count().div_ceil(2);
			(1..=u32::try_from(shown).unwrap_or(u32::MAX)).collect()
		} else {
			Vec::new()
		};
		let seen = (!seen.is_empty()).then_some(seen.as_slice());
		let tag = store.record(&canonical_key(&path), &editable, seen);
		tags.push((rel.clone(), tag));
	}
	let payload = substitute_tags(&case.payload, &tags);

	let parse_succeeded = check_parse_determinism(&payload, &cwd)?;
	let _ = contains_recognizable_hashline_operations(&payload);

	let raw_input = case.control & control::RAW_INPUT != 0;
	let config = SessionConfig {
		mode: EditMode::Hashline,
		policy: PathPolicy {
			cwd:                  cwd.clone(),
			home_dir:             cwd.clone(),
			url_schemes:          Vec::new(),
			url_alias_schemes:    Vec::new(),
			plan_writable_roots:  Vec::new(),
			plan_active:          false,
			block_auto_generated: true,
		},
		allow_fuzzy: true,
		fuzzy_threshold: 0.95,
		enforce_seen_lines,
		raw_input,
	};
	let mut session = Session::new(config, store);

	let args = if raw_input {
		payload.clone()
	} else {
		let key = if case.control & control::INPUT_ALIAS != 0 {
			"_input"
		} else {
			"input"
		};
		let mut object = serde_json::Map::new();
		object.insert(key.to_owned(), serde_json::Value::String(payload.clone()));
		serde_json::Value::Object(object).to_string()
	};
	let chunks = 1 + usize::from(case.control & control::CHUNKS_MASK);
	let mut projection = ArgStream::new(raw_input);
	let mut start = 0;
	for index in 1..=chunks {
		let mut end = args.len() * index / chunks;
		while !args.is_char_boundary(end) {
			end += 1;
		}
		if end <= start {
			continue;
		}
		let delta = &args[start..end];
		start = end;
		session.push(delta);
		projection.push(delta);
		let _ = session.preview();
		check_projection(&projection.snapshot(), &payload, end == args.len(), raw_input)?;
	}
	session.finish();
	projection.finish();
	let _ = session.preview();
	let finished = projection.snapshot();
	if finished.input.as_deref() != Some(payload.as_str()) || !finished.complete {
		return Err(format!(
			"finished argument projection lost the input: complete={}, input={:?}, \
			 expected={payload:?}",
			finished.complete, finished.input
		));
	}

	let writer = RecordingWriter::default();
	let outcome = block_on(session.apply(ApplyRequest::default(), &writer));
	let requests = writer.requests.into_inner();
	let writes = requests.len();
	let stage_succeeded = match outcome {
		Err(error) => {
			if writes != 0 {
				return Err(format!(
					"apply failed after {writes} write(s) although the writer never fails: {error}"
				));
			}
			false
		},
		Ok(outcome) => {
			let written: Vec<_> = outcome
				.files
				.iter()
				.filter(|file| file.op != FileOp::Noop)
				.collect();
			if written.len() != writes {
				return Err(format!(
					"apply reported {} non-noop file(s) but issued {writes} write(s)",
					written.len()
				));
			}
			for (request, file) in requests.iter().zip(&written) {
				if request.absolute != file.absolute || request.op != file.op {
					return Err(format!(
						"write order diverged from outcome order: wrote {:?} {:?}, outcome {:?} {:?}",
						request.op, request.absolute, file.op, file.absolute
					));
				}
				if (request.op == FileOp::Delete) == request.content.is_some() {
					return Err(format!(
						"{:?} write for {:?} carried content={}",
						request.op,
						request.display,
						request.content.is_some()
					));
				}
			}
			true
		},
	};

	Ok(StreamMetrics { executed: true, parse_succeeded, stage_succeeded, writes })
}

/// Replace `{{tag:PATH}}` with the tag minted for container file `PATH`.
/// Unknown paths stay literal (a malformed-tag lane).
pub fn substitute_tags(payload: &str, tags: &[(String, String)]) -> String {
	let mut out = payload.to_owned();
	for (path, tag) in tags {
		let needle = tag_placeholder(path);
		if out.contains(&needle) {
			out = out.replace(&needle, tag);
		}
	}
	out
}

/// `{{tag:PATH}}`.
pub fn tag_placeholder(path: &str) -> String {
	format!("{{{{tag:{path}}}}}")
}

/// Relative, portable, non-escaping path made of `[A-Za-z0-9._ /-]`.
pub fn is_safe_relative_path(path: &str) -> bool {
	if path.is_empty() || path.len() > MAX_PATH_BYTES || path.starts_with('/') {
		return false;
	}
	if !path
		.bytes()
		.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b' ' | b'/'))
	{
		return false;
	}
	path.split('/').all(|component| {
		!component.is_empty()
			&& component != "."
			&& component != ".."
			&& !component.ends_with(['.', ' '])
			&& !component.starts_with(' ')
			&& !is_windows_device_name(component.split('.').next().unwrap_or(component))
	})
}

fn is_windows_device_name(stem: &str) -> bool {
	let stem = stem.to_ascii_lowercase();
	matches!(stem.as_str(), "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
		|| ((stem.starts_with("com") || stem.starts_with("lpt"))
			&& stem.len() == 4
			&& stem.as_bytes()[3].is_ascii_digit())
}

/// Whether a payload could steer a read outside the per-input temp
/// workspace at something that blocks or never ends: devices and pseudo
/// files (`/dev/zero`, `/proc/self/fd/0`, FIFOs under `/run` or next to the
/// workspace via `..`), Windows devices (`CON`) and UNC/network paths.
/// Only non-body rows are checked: engines take paths solely from headers
/// and op rows (`MV`), never from `+` literal rows, so code comments like
/// `+// …` keep their coverage. Plain regular-file reads elsewhere are
/// harmless: the recording writer never writes, and `~` is the workspace.
pub fn touches_host_devices(payload: &str) -> bool {
	payload
		.split('\n')
		.filter(|row| !row.starts_with('+'))
		.any(|row| {
			let row = row.to_ascii_lowercase();
			["..", "/dev", "/proc", "/sys", "/run"]
				.iter()
				.any(|needle| row.contains(needle))
				// `file://` URLs are percent-decoded before resolution.
				|| (row.contains("file:") && row.contains('%'))
				|| (cfg!(windows)
					&& (row.contains("\\\\")
						|| row.contains("//")
						|| row
							.split(|c: char| !(c.is_ascii_alphanumeric() || c == '$'))
							.any(is_windows_device_name)))
		})
}

type ParseFingerprint = Result<Vec<(String, Option<String>, Result<Parsed, String>)>, String>;

fn parse_fingerprint(payload: &str, cwd: &Path) -> ParseFingerprint {
	let patch = Patch::parse(payload, &SplitOptions { cwd: Some(cwd), path: None })
		.map_err(|error| error.to_string())?;
	Ok(patch
		.sections
		.iter()
		.map(|section| {
			(
				section.path.clone(),
				section.file_hash.clone(),
				section.parse().cloned().map_err(|error| error.to_string()),
			)
		})
		.collect())
}

fn check_parse_determinism(payload: &str, cwd: &Path) -> Result<bool, String> {
	let first = parse_fingerprint(payload, cwd);
	let second = parse_fingerprint(payload, cwd);
	if first != second {
		return Err(format!("Patch::parse is nondeterministic:\n{first:?}\nvs\n{second:?}"));
	}
	Ok(first.is_ok())
}

fn check_projection(
	snapshot: &ArgSnapshot,
	payload: &str,
	whole: bool,
	raw_input: bool,
) -> Result<(), String> {
	if let Some(input) = snapshot.input.as_deref()
		&& !payload.starts_with(input)
	{
		return Err(format!(
			"streamed input projection is not a prefix of the final input: {input:?} vs {payload:?}"
		));
	}
	// Raw payloads only complete on `finish()`; JSON completes once parseable,
	// and no proper prefix of `{"input":"…"}` parses.
	let expected_complete = whole && !raw_input;
	if snapshot.complete != expected_complete {
		return Err(format!(
			"projection complete={} after {} of the arguments",
			snapshot.complete,
			if whole { "all" } else { "part" }
		));
	}
	Ok(())
}

/// Accepts every write without touching disk; reports the content as
/// persisted verbatim.
#[derive(Default)]
struct RecordingWriter {
	requests: Mutex<Vec<WriteRequest>>,
}

#[async_trait]
impl EditWriter for RecordingWriter {
	async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
		let written = request.content.clone().unwrap_or_default();
		self.requests.lock().push(request);
		Ok(WriteResponse { written, diagnostics_json: None })
	}
}

thread_local! {
	static RUNTIME: tokio::runtime::Runtime = tokio::runtime::Builder::new_current_thread()
		.build()
		.expect("harness: tokio runtime");
}

fn block_on<F: Future>(future: F) -> F::Output {
	RUNTIME.with(|runtime| runtime.block_on(future))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn replace_line(control: u8, line: u32) -> StreamMetrics {
		let case = StreamCase {
			control: control::RAW_INPUT | control,
			files:   vec![("a.txt".to_owned(), "one\ntwo\nthree\nfour\n".to_owned())],
			payload: format!("[a.txt#{}]\nPUT {line}.={line}:\n+edited", tag_placeholder("a.txt")),
		};
		check_stream(&case.encode()).unwrap_or_else(|violation| panic!("{violation}"))
	}

	/// The seen-line lane accepts anchors inside the recorded read and
	/// rejects the rest before any write; without the bit both apply.
	#[test]
	fn enforce_seen_rejects_only_anchors_outside_the_recorded_read() {
		let seen = replace_line(control::ENFORCE_SEEN, 2);
		assert!(seen.stage_succeeded && seen.writes == 1, "{seen:?}");
		let unseen = replace_line(control::ENFORCE_SEEN, 4);
		assert!(!unseen.stage_succeeded && unseen.writes == 0, "{unseen:?}");
		let unenforced = replace_line(0, 4);
		assert!(unenforced.stage_succeeded && unenforced.writes == 1, "{unenforced:?}");
	}
}
