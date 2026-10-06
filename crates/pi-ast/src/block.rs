//! Resolve the syntactic block that begins on a given source line.
//!
//! Powers the hashline `replace block N:` operator: given a 1-indexed line,
//! parse the source with tree-sitter and return the line span of the outermost
//! named node that *begins* on that line (excluding the whole-file root). Brace
//! languages anchor a construct's block to its opening line, so pointing at the
//! line that opens an `if` / `function` / `struct` resolves to that construct's
//! full span; pointing at a continuation line or a lone closing delimiter
//! resolves to nothing.

use std::{
	borrow::Cow,
	cell::RefCell,
	collections::{BTreeMap, BTreeSet, HashMap, HashSet},
	ops::Range,
	sync::OnceLock,
};

use anyhow::{Result, anyhow};
use ast_grep_core::tree_sitter::LanguageExt;
use serde::{Deserialize, Serialize};
use tree_sitter::{InputEdit, Node, Parser, Point, Tree, TreeCursor};

use crate::{
	language::SupportLang,
	parse_cache::parse_cached,
	summary::{node_content_end_line, node_start_line, resolve_language},
};

const PROOF_DEPTH: usize = 128;
const DEPTH_REFUSAL: &str = "Syntax nesting is too deep to prove ownership or scope; add explicit \
                             trailing context or use a smaller hunk";

type ProofDepths = RefCell<HashMap<(usize, bool), usize>>;

/// Only visit the region whose descendants participate in this proof. Header
/// helper resolution never needs descendants beginning on later source rows.
fn proof_depth(node: Node<'_>, headers_only: bool, cache: &ProofDepths) -> usize {
	if let Some(result) = cache.borrow().get(&(node.id(), headers_only)) {
		return *result;
	}
	let mut cursor = node.walk();
	let mut depth = 0;
	let mut maximum = 0;
	loop {
		let relevant =
			!headers_only || cursor.node().start_position().row == node.start_position().row;
		if relevant {
			maximum = maximum.max(depth);
		}
		if maximum > PROOF_DEPTH {
			cache
				.borrow_mut()
				.insert((node.id(), headers_only), maximum);
			return maximum;
		}
		if relevant && cursor.goto_first_child() {
			depth += 1;
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				cache
					.borrow_mut()
					.insert((node.id(), headers_only), maximum);
				return maximum;
			}
			depth -= 1;
		}
	}
}

fn bounded_ownership(
	root: Node<'_>,
	at: usize,
	cache: &ProofDepths,
	transitions: usize,
) -> Result<()> {
	if let Some(node) = first_named_after(root, at, None) {
		let ancestors = std::iter::successors(node.parent(), |node| node.parent())
			.take(PROOF_DEPTH + 1)
			.count();
		if proof_depth(node, false, cache) + ancestors + transitions > PROOF_DEPTH {
			return Err(anyhow!(DEPTH_REFUSAL));
		}
	}
	Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockRangeOptions {
	/// Source code to inspect.
	pub code: String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang: Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path: Option<String>,
	/// 1-indexed source line the block must begin on.
	pub line: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockRange {
	/// 1-indexed inclusive first line of the resolved block.
	pub start_line: u32,
	/// 1-indexed inclusive last line of the resolved block.
	pub end_line:   u32,
}

/// Node identity qualified by its physical payload frame within this snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeOwner {
	frame: usize,
	node:  usize,
}

/// Placement-only evidence. An error-tolerant envelope can veto, never
/// authorize.
#[derive(Debug, Clone, Copy)]
pub struct ScopeEvidence {
	pub range:         BlockRange,
	pub owner:         ScopeOwner,
	pub certain:       bool,
	/// A certified host boundary, not positive inner-construct evidence.
	pub host_domain:   bool,
	/// The source gap after the last owned row remains inside this owner.
	pub owned_end_gap: bool,
}

/// Active placement queries share one guard across host and payload indexes.
#[derive(Default)]
struct ScopeResolution {
	active:   BTreeSet<(usize, usize)>,
	failed:   bool,
	too_deep: bool,
}

/// Separator evidence from parsing the exact candidate bytes.
#[derive(Debug, Clone, Copy)]
pub enum SeparatorProof {
	Preserved,
	Rejected,
	/// The grammar treats the original code separator as bounded comment
	/// trivia. The candidate is code-only, but the caller must still prove
	/// the counterpart retains its own physical separator.
	TrivialOnly,
}

/// A literal's grammar and snapshot-local exact prefix, not its changing value.
/// Compare descriptors from different snapshots through `LexicalView`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiteralDialect {
	language: SupportLang,
	kind:     u16,
	mode:     usize,
	escape:   u8,
}

/// Lexical interpretation of preserved source bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LexicalRole {
	Code,
	Comment,
	Literal(LiteralDialect),
	Escape(LiteralDialect),
	Delimiter(LiteralDialect, usize),
	Unknown,
}

#[derive(Debug, Clone)]
enum LiteralPrefix {
	Source(Range<usize>),
	Projected(Box<str>),
}

impl LiteralPrefix {
	fn text<'a>(&'a self, source: &'a str) -> &'a str {
		match self {
			Self::Source(range) => &source[range.clone()],
			Self::Projected(text) => text,
		}
	}
}

#[derive(Debug, Clone)]
struct CodeToken {
	range:    Range<usize>,
	language: SupportLang,
	/// Only the positive INI-style lexical policy has no native grammar kind.
	kind:     Option<u16>,
	field:    Option<&'static str>,
}

#[derive(Debug, Clone)]
struct LogicalUnit {
	range:     Range<usize>,
	language:  SupportLang,
	statement: Option<u16>,
	certain:   bool,
}

#[derive(Debug, Clone)]
struct InterpolationUnit {
	range: Range<usize>,
	body:  Range<usize>,
	kind:  u16,
}

#[derive(Debug, Clone, Default)]
struct RoleSpans {
	spans:                   Vec<(Range<usize>, LexicalRole)>,
	modes:                   Vec<LiteralPrefix>,
	words:                   Vec<LogicalUnit>,
	word_ends:               Vec<usize>,
	code:                    Vec<CodeToken>,
	pairs:                   Vec<InterpolationUnit>,
	continuations:           Vec<Range<usize>>,
	uncertain_continuations: Vec<Range<usize>>,
	units:                   Vec<Range<usize>>,
}

impl std::ops::Deref for RoleSpans {
	type Target = [(Range<usize>, LexicalRole)];

	fn deref(&self) -> &Self::Target {
		&self.spans
	}
}

impl RoleSpans {
	/// Import exact prefixes once per frame. Synthetic prefix bytes cannot
	/// supply a source descriptor; decoded/spliced spellings are kept once.
	fn import_modes(
		&mut self,
		from: &Self,
		payload: &str,
		source: &str,
		map: impl Fn(usize, bool) -> Option<usize>,
	) -> Vec<Option<usize>> {
		from
			.modes
			.iter()
			.map(|prefix| {
				let text = prefix.text(payload);
				let projected = match prefix {
					LiteralPrefix::Source(range) if !range.is_empty() => {
						let range = map(range.start, false)?..map(range.end, true)?;
						if source.get(range.clone()) == Some(text) {
							LiteralPrefix::Source(range)
						} else {
							LiteralPrefix::Projected(text.into())
						}
					},
					LiteralPrefix::Source(_) => LiteralPrefix::Source(0..0),
					LiteralPrefix::Projected(_) => LiteralPrefix::Projected(text.into()),
				};
				let id = self.modes.len();
				self.modes.push(projected);
				Some(id)
			})
			.collect()
	}

	fn import_words(&mut self, from: &Self, map: impl Fn(usize, bool) -> Option<usize>) {
		self.words.extend(from.words.iter().filter_map(|unit| {
			Some(LogicalUnit {
				range:     map(unit.range.start, false)?..map(unit.range.end, true)?,
				language:  unit.language,
				statement: unit.statement,
				certain:   unit.certain,
			})
		}));
	}

	fn import_code(
		&mut self,
		from: &Self,
		projection: &[Projection],
		map: impl Fn(usize, bool) -> Option<usize>,
	) {
		let mut push = |range: Range<usize>, token: &CodeToken| {
			if let (Some(start), Some(end)) = (map(range.start, false), map(range.end, true))
				&& start < end
			{
				self.code.push(CodeToken {
					range:    start..end,
					language: token.language,
					kind:     token.kind,
					field:    token.field,
				});
			}
		};
		for token in &from.code {
			if projection.is_empty() {
				push(token.range.clone(), token);
				continue;
			}
			let at = projection.partition_point(|part| part.payload.end <= token.range.start);
			for part in projection[at..]
				.iter()
				.take_while(|part| part.payload.start < token.range.end)
				.filter(|part| !part.payload.is_empty() && !part.source.is_empty())
			{
				push(
					token.range.start.max(part.payload.start)..token.range.end.min(part.payload.end),
					token,
				);
			}
		}
	}

	fn import_pairs(
		&mut self,
		from: &Self,
		map: impl Fn(usize, bool) -> Option<usize>,
	) -> Vec<Option<usize>> {
		from
			.pairs
			.iter()
			.map(|unit| {
				let range = map(unit.range.start, false)?..map(unit.range.end, true)?;
				let body = map(unit.body.start, false)?..map(unit.body.end, true)?;
				let id = self.pairs.len();
				self
					.pairs
					.push(InterpolationUnit { range, body, kind: unit.kind });
				Some(id)
			})
			.collect()
	}

	fn import_continuations(
		&mut self,
		from: &Self,
		map: impl Fn(usize, bool) -> Option<usize>,
	) -> Option<()> {
		for range in &from.continuations {
			self
				.continuations
				.push(map(range.start, false)?..map(range.end, true)?);
		}
		for range in &from.uncertain_continuations {
			self
				.uncertain_continuations
				.push(map(range.start, false)?..map(range.end, true)?);
		}
		Some(())
	}

	fn unit_at(&self, byte: usize) -> Option<&Range<usize>> {
		let at = self.units.partition_point(|range| range.end <= byte);
		self.units.get(at).filter(|range| range.contains(&byte))
	}

	fn unit_boundary(&self, byte: usize, limit: usize) -> usize {
		let at = self.units.partition_point(|range| range.end <= byte);
		self.units.get(at).map_or(limit, |range| {
			if range.start <= byte {
				range.end.min(limit)
			} else {
				range.start.min(limit)
			}
		})
	}

	fn code_at(&self, byte: usize) -> Option<&CodeToken> {
		let at = self.code.partition_point(|token| token.range.end <= byte);
		self
			.code
			.get(at)
			.filter(|token| token.range.contains(&byte))
	}

	fn code_boundary(&self, byte: usize, limit: usize) -> usize {
		let at = self.code.partition_point(|token| token.range.end <= byte);
		self.code.get(at).map_or(limit, |token| {
			if token.range.start <= byte {
				token.range.end.min(limit)
			} else {
				token.range.start.min(limit)
			}
		})
	}

	fn sort_words(&mut self) {
		self
			.words
			.sort_unstable_by_key(|unit| (unit.range.start, std::cmp::Reverse(unit.range.end)));
		self.word_ends.clear();
		let mut end = 0;
		self.word_ends.extend(self.words.iter().map(|unit| {
			end = end.max(unit.range.end);
			end
		}));
	}

	fn word_at(&self, byte: usize) -> Option<&Range<usize>> {
		self.word_unit_at(byte).map(|unit| &unit.range)
	}

	fn word_unit_at(&self, byte: usize) -> Option<&LogicalUnit> {
		let language = match role_at(self, byte) {
			LexicalRole::Literal(dialect)
			| LexicalRole::Escape(dialect)
			| LexicalRole::Delimiter(dialect, _) => dialect.language,
			_ => self.code_at(byte)?.language,
		};
		let mut end = self.words.partition_point(|unit| unit.range.start <= byte);
		while end > 0 && self.word_ends[end - 1] > byte {
			end -= 1;
			if self.words[end].language == language && self.words[end].range.contains(&byte) {
				return Some(&self.words[end]);
			}
		}
		None
	}
}

fn imported_role(
	role: LexicalRole,
	modes: &[Option<usize>],
	pairs: &[Option<usize>],
) -> LexicalRole {
	let import = |mut dialect: LiteralDialect| {
		dialect.mode = modes.get(dialect.mode).copied().flatten()?;
		Some(dialect)
	};
	match role {
		LexicalRole::Literal(dialect) => {
			import(dialect).map_or(LexicalRole::Unknown, LexicalRole::Literal)
		},
		LexicalRole::Escape(dialect) => {
			import(dialect).map_or(LexicalRole::Unknown, LexicalRole::Escape)
		},
		LexicalRole::Delimiter(dialect, pair) => import(dialect)
			.zip(pairs.get(pair).copied().flatten())
			.map_or(LexicalRole::Unknown, |(dialect, pair)| LexicalRole::Delimiter(dialect, pair)),
		other => other,
	}
}

/// Borrowed evidence ties compact descriptors to their source snapshot.
#[derive(Clone, Copy)]
pub struct LexicalView<'a> {
	roles:  &'a RoleSpans,
	source: &'a str,
}

impl<'a> LexicalView<'a> {
	pub fn spans(self) -> &'a [(Range<usize>, LexicalRole)] {
		&self.roles.spans
	}

	pub fn role_at(self, byte: usize) -> LexicalRole {
		role_at(self.roles, byte)
	}

	fn equivalent(self, before: LexicalRole, other: Self, after: LexicalRole) -> bool {
		let dialects = match (before, after) {
			(LexicalRole::Code, LexicalRole::Code) | (LexicalRole::Comment, LexicalRole::Comment) => {
				return true;
			},
			(LexicalRole::Literal(left), LexicalRole::Literal(right))
			| (LexicalRole::Escape(left), LexicalRole::Escape(right)) => (left, right),
			(LexicalRole::Delimiter(left, at), LexicalRole::Delimiter(right, to)) => {
				if self.roles.pairs[at].kind != other.roles.pairs[to].kind {
					return false;
				}
				(left, right)
			},
			_ => return false,
		};
		let (left, right) = dialects;
		left.language == right.language
			&& left.kind == right.kind
			&& left.escape == right.escape
			&& self.roles.modes[left.mode].text(self.source)
				== other.roles.modes[right.mode].text(other.source)
	}

	/// Spelling membership for omission vetoes, not permission to substitute
	/// or preserve bytes. Native kind/field position cannot erase a copy.
	pub fn same_spelling_role(self, byte: usize, other: Self, mapped: usize) -> bool {
		let before = self.role_at(byte);
		if !self.equivalent(before, other, other.role_at(mapped)) {
			return false;
		}
		if before != LexicalRole::Code {
			return true;
		}
		match (self.roles.code_at(byte), other.roles.code_at(mapped)) {
			(Some(left), Some(right)) => left.language == right.language,
			_ => false,
		}
	}

	/// Complete descriptor and native leaf provenance for authored
	/// substitutions.
	pub fn same_provenance(self, byte: usize, other: Self, mapped: usize) -> bool {
		let before = self.role_at(byte);
		let after = other.role_at(mapped);
		if !self.equivalent(before, other, after) {
			return false;
		}
		if before != LexicalRole::Code {
			return true;
		}
		if self.source[byte..]
			.chars()
			.next()
			.is_some_and(char::is_whitespace)
			&& other.source[mapped..]
				.chars()
				.next()
				.is_some_and(char::is_whitespace)
		{
			return true;
		}
		match (self.roles.code_at(byte), other.roles.code_at(mapped)) {
			(Some(left), Some(right)) => {
				left.language == right.language && left.kind == right.kind && left.field == right.field
			},
			_ => false,
		}
	}

	/// Preserved bytes additionally retain their atomic projection membership.
	pub fn equivalent_at(self, byte: usize, other: Self, mapped: usize) -> bool {
		self.same_provenance(byte, other, mapped)
			&& match (self.roles.unit_at(byte), other.roles.unit_at(mapped)) {
				(None, None) => true,
				(Some(left), Some(right)) => {
					byte - left.start == mapped - right.start
						&& self.source[left.clone()] == other.source[right.clone()]
				},
				_ => false,
			}
	}

	/// Preserved portions keep both logical-unit boundary relations; an
	/// authored interior outside these portions may change value or length.
	fn same_word_boundaries(
		self,
		byte: usize,
		range: &Range<usize>,
		other: Self,
		mapped: usize,
		to: &Range<usize>,
	) -> bool {
		match (self.roles.word_at(byte), other.roles.word_at(mapped)) {
			(None, None) => true,
			(Some(word), Some(next)) => {
				let start = word.start >= range.start;
				let end = word.end <= range.end;
				start == (next.start >= to.start)
					&& end == (next.end <= to.end)
					&& (!start || word.start - range.start == next.start - to.start)
					&& (!end || word.end - range.start == next.end - to.start)
			},
			_ => false,
		}
	}

	/// An omitted run must carry complete atomic units, not merely their
	/// payload.
	pub fn preserves_run(self, range: Range<usize>, other: Self, mapped: Range<usize>) -> bool {
		let mut left = self.source[range.clone()].char_indices();
		let mut right = other.source[mapped.clone()].char_indices();
		loop {
			match (left.next(), right.next()) {
				(None, None) => return true,
				(Some((at, _)), Some((to, _))) => {
					let at = range.start + at;
					let to = mapped.start + to;
					if !self.equivalent_at(at, other, to) {
						return false;
					}
					if let Some(unit) = self.roles.unit_at(at) {
						let Some(next) = other.roles.unit_at(to) else {
							return false;
						};
						if unit.start < range.start
							|| unit.end > range.end
							|| next.start < mapped.start
							|| next.end > mapped.end
						{
							return false;
						}
					}
					if matches!(self.role_at(at), LexicalRole::Escape(_) | LexicalRole::Delimiter(_, _))
					{
						let unit = &self.roles[self.roles.partition_point(|(span, _)| span.end <= at)].0;
						let next =
							&other.roles[other.roles.partition_point(|(span, _)| span.end <= to)].0;
						if unit.start < range.start
							|| unit.end > range.end
							|| next.start < mapped.start
							|| next.end > mapped.end
							|| at - unit.start != to - next.start
							|| self.source[unit.clone()] != other.source[next.clone()]
						{
							return false;
						}
					}
					if let (LexicalRole::Delimiter(_, from), LexicalRole::Delimiter(_, next)) =
						(self.role_at(at), other.role_at(to))
					{
						let from = &self.roles.pairs[from];
						let next = &other.roles.pairs[next];
						if from.range.start >= range.start
							&& from.range.start < range.end
							&& (from.range.start - range.start
								!= next.range.start.saturating_sub(mapped.start)
								|| next.range.start < mapped.start)
							|| from.range.end > range.start
								&& from.range.end <= range.end
								&& (from.range.end - range.start
									!= next.range.end.saturating_sub(mapped.start)
									|| next.range.end > mapped.end)
						{
							return false;
						}
					}
					if !self.same_word_boundaries(at, &range, other, to, &mapped) {
						return false;
					}
				},
				_ => return false,
			}
		}
	}

	fn certain_python_continuation(self, edge: &Range<usize>, successor: &Range<usize>) -> bool {
		let Some(unit) = self.roles.word_unit_at(edge.start).filter(|unit| {
			unit.language == SupportLang::Python && unit.statement.is_some() && unit.certain
		}) else {
			return false;
		};
		let Some((at, _)) = self.source[successor.clone()]
			.char_indices()
			.find(|(_, ch)| !ch.is_whitespace())
		else {
			return false;
		};
		unit.range.contains(&(successor.start + at)) && edge.end <= unit.range.end
	}

	fn preserves_successor(self, range: Range<usize>, other: Self, mapped: Range<usize>) -> bool {
		if !self.preserves_run(range.clone(), other, mapped.clone()) {
			return false;
		}
		for (at, ch) in self.source[range.clone()].char_indices() {
			let at = range.start + at;
			if ch.is_whitespace()
				|| !self
					.roles
					.code_at(at)
					.is_some_and(|code| code.language == SupportLang::Python)
			{
				continue;
			}
			let to = mapped.start + at - range.start;
			if !matches!(
				(self.roles.word_unit_at(at), other.roles.word_unit_at(to)),
				(Some(left), Some(right)) if left.certain && right.certain
					&& left.statement.is_some() && left.statement == right.statement
			) {
				return false;
			}
		}
		true
	}
}

#[derive(Debug)]
struct Projection {
	payload: Range<usize>,
	source:  Range<usize>,
}

fn projected_byte(projection: &[Projection], range: &Range<usize>, byte: usize) -> Option<usize> {
	if !range.contains(&byte) {
		return None;
	}
	if projection.is_empty() {
		return Some(byte - range.start);
	}
	let at = projection.partition_point(|part| part.source.end <= byte);
	let part = projection
		.get(at)
		.filter(|part| part.source.contains(&byte))?;
	Some(part.payload.start + (byte - part.source.start) * part.payload.len() / part.source.len())
}

fn projection_source_byte(
	projection: &[Projection],
	range: &Range<usize>,
	byte: usize,
	end: bool,
) -> Option<usize> {
	if projection.is_empty() {
		return (byte <= range.len()).then_some(range.start + byte);
	}
	let at = projection.partition_point(|part| {
		if end {
			part.payload.start < byte
		} else {
			part.payload.start <= byte
		}
	});
	let part = projection.get(at.saturating_sub(1))?;
	(part.payload.start <= byte && byte <= part.payload.end).then(|| {
		if part.payload.is_empty() {
			if end {
				part.source.start
			} else {
				part.source.end
			}
		} else {
			part.source.start + (byte - part.payload.start) * part.source.len() / part.payload.len()
		}
	})
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FrameKind {
	Code,
	Onbuild,
	Expression,
	Macro,
	Data,
}

struct PayloadFrame {
	range:                  Range<usize>,
	envelope:               Range<usize>,
	selectors:              [Option<Range<usize>>; 2],
	language:               Option<SupportLang>,
	kind:                   FrameKind,
	data:                   bool,
	text:                   Option<String>,
	projection:             Vec<Projection>,
	tree:                   Option<Tree>,
	host_code:              Vec<CodeToken>,
	continuations:          Vec<Range<usize>>,
	line_starts:            Vec<usize>,
	/// Make expansion can change subsequent syntax before the shell parses it.
	unresolved:             Option<usize>,
	labels:                 RefCell<HashMap<usize, Option<ScopeEvidence>>>,
	roles:                  OnceLock<Option<RoleSpans>>,
	boundaries:             OnceLock<Vec<BoundaryNode>>,
	independent_invocation: bool,
	sibling_targets:        RefCell<HashMap<usize, Option<ScopeEvidence>>>,
	proof_depths:           ProofDepths,
	metadata_owners:        MetadataOwners,
}

impl PayloadFrame {
	fn new(
		source: &str,
		range: Range<usize>,
		envelope: Range<usize>,
		selectors: [Option<Range<usize>>; 2],
		language: Option<SupportLang>,
		data: bool,
		projected: Option<(String, Vec<Projection>)>,
	) -> Self {
		let (text, projection) = projected
			.map_or_else(|| (None, Vec::new()), |(text, projection)| (Some(text), projection));
		let payload = text.as_deref().unwrap_or_else(|| &source[range.clone()]);
		let tree = language.and_then(|language| parse_cached(payload, language).ok().flatten());
		let line_starts = std::iter::once(0)
			.chain(payload.match_indices('\n').map(|(at, _)| at + 1))
			.collect();
		Self {
			range,
			envelope,
			selectors,
			language,
			data,
			kind: if data {
				FrameKind::Data
			} else {
				FrameKind::Code
			},
			text,
			projection,
			tree,
			host_code: Vec::new(),
			continuations: Vec::new(),
			line_starts,
			unresolved: None,
			labels: RefCell::default(),
			roles: OnceLock::new(),
			boundaries: OnceLock::new(),
			independent_invocation: false,
			sibling_targets: RefCell::default(),
			proof_depths: RefCell::default(),
			metadata_owners: RefCell::default(),
		}
	}

	fn text<'a>(&'a self, source: &'a str) -> &'a str {
		self
			.text
			.as_deref()
			.unwrap_or_else(|| &source[self.range.clone()])
	}

	fn roles(&self, source: &str) -> Option<&RoleSpans> {
		self
			.roles
			.get_or_init(|| {
				lexical_roles(self.tree.as_ref()?.root_node(), self.text(source), self.language?)
			})
			.as_ref()
	}

	fn unknown(&self) -> bool {
		!self.data
			&& self
				.tree
				.as_ref()
				.is_none_or(|tree| tree.root_node().has_error())
	}

	fn source_byte(&self, byte: usize, end: bool) -> Option<usize> {
		projection_source_byte(&self.projection, &self.range, byte, end)
	}

	fn payload_byte(&self, byte: usize) -> Option<usize> {
		projected_byte(&self.projection, &self.range, byte)
	}

	fn payload_gap(&self, source: &str, byte: usize) -> Option<usize> {
		if let Some(byte) = self.payload_byte(byte) {
			return Some(byte);
		}
		if byte == self.range.end {
			return Some(self.text(source).len());
		}
		if byte < self.range.start
			|| byte > self.range.end
			|| byte > 0 && source.as_bytes()[byte - 1] != b'\n'
		{
			return None;
		}
		let at = self
			.projection
			.partition_point(|part| part.source.end <= byte);
		let part = self.projection.get(at)?;
		(part.source.start >= byte
			&& !source[byte..part.source.start].contains('\n')
			&& part.payload.start > 0
			&& self.text(source).as_bytes()[part.payload.start - 1] == b'\n')
			.then_some(part.payload.start)
	}

	/// The unchanged unknown tail starts in the same proven lexical state.
	/// Its template is never used as whole-program placement authority.
	fn same_unresolved_boundary(
		&self,
		next: &Self,
		source: &str,
		candidate: &str,
		shift: &impl Fn(usize) -> Option<usize>,
	) -> Option<()> {
		let byte = self.payload_byte(self.unresolved?)?;
		let after = next.payload_byte(next.unresolved?)?;
		let old_view = LexicalView { roles: self.roles(source)?, source: self.text(source) };
		let new_view = LexicalView { roles: next.roles(candidate)?, source: next.text(candidate) };
		if !old_view.equivalent_at(byte, new_view, after) {
			return None;
		}
		let mut left = self
			.tree
			.as_ref()?
			.root_node()
			.descendant_for_byte_range(byte, byte + 1)?;
		let mut right = next
			.tree
			.as_ref()?
			.root_node()
			.descendant_for_byte_range(after, after + 1)?;
		loop {
			if left.kind_id() != right.kind_id()
				|| field_role(left) != field_role(right)
				|| shift(self.source_byte(left.start_byte(), false)?)
					!= Some(next.source_byte(right.start_byte(), false)?)
				|| shift(self.source_byte(left.end_byte(), true)?)
					!= Some(next.source_byte(right.end_byte(), true)?)
			{
				return None;
			}
			if literal_owner(left, self.language?)
				&& (self.language != next.language
					|| self
						.text(source)
						.get(literal_prefix(left, self.text(source), self.language?)?)
						!= next.text(candidate).get(literal_prefix(
							right,
							next.text(candidate),
							next.language?,
						)?)) {
				return None;
			}
			match (left.parent(), right.parent()) {
				(Some(parent), Some(next)) => {
					left = parent;
					right = next;
				},
				(None, None) => return Some(()),
				_ => return None,
			}
		}
	}

	fn with_index<T>(&self, source: &str, query: impl FnOnce(&BlockIndex<'_>) -> T) -> Option<T> {
		if self.unresolved.is_some() {
			return None;
		}
		let tree = self.tree.as_ref()?;
		let index = BlockIndex {
			code:            self.text(source),
			language:        self.language?,
			tree:            Cow::Borrowed(tree),
			line_starts:     Cow::Borrowed(&self.line_starts),
			role_spans:      Cow::Borrowed(&self.roles),
			label_targets:   RefCell::new(std::mem::take(&mut *self.labels.borrow_mut())),
			payloads:        OnceLock::new(),
			boundaries:      Cow::Borrowed(&self.boundaries),
			sibling_targets: Cow::Borrowed(&self.sibling_targets),
			proof_depths:    Cow::Borrowed(&self.proof_depths),
			metadata_owners: Cow::Borrowed(&self.metadata_owners),
		};
		let result = query(&index);
		*self.labels.borrow_mut() = index.label_targets.into_inner();
		Some(result)
	}
}

/// C phase two applies before comment/string tokenization. Only copied
/// replacement-list bytes are projected; no enclosing expression is invented.
fn project_macro(source: &str, range: Range<usize>) -> Option<(String, Vec<Projection>)> {
	let fragment = &source[range.clone()];
	if !(fragment.contains("\\\n") || fragment.contains("\\\r\n")) {
		return None;
	}
	let mut text = String::with_capacity(fragment.len());
	let mut projection = Vec::new();
	let mut start = range.start;
	for (at, _) in fragment.match_indices('\\') {
		let end = match fragment.as_bytes().get(at + 1..) {
			Some([b'\n', ..]) => range.start + at + 2,
			Some([b'\r', b'\n', ..]) => range.start + at + 3,
			_ => continue,
		};
		let at = range.start + at;
		if start < at {
			let from = text.len();
			text.push_str(&source[start..at]);
			projection.push(Projection { payload: from..text.len(), source: start..at });
		}
		start = end;
	}
	if start < range.end {
		let from = text.len();
		text.push_str(&source[start..range.end]);
		projection.push(Projection { payload: from..text.len(), source: start..range.end });
	}
	Some((text, projection))
}

fn macro_payloads(root: Node<'_>, source: &str, language: SupportLang) -> Vec<PayloadFrame> {
	let mut frames = Vec::new();
	let mut cursor = root.walk();
	loop {
		let node = cursor.node();
		if node.kind() == "preproc_arg" {
			let parent = node.parent().unwrap_or(node);
			let known =
				matches!(parent.kind(), "preproc_def" | "preproc_function_def") && !node.is_missing();
			let mut frame = PayloadFrame::new(
				source,
				node.byte_range(),
				parent.byte_range(),
				[Some(parent.start_byte()..node.start_byte()), None],
				known.then_some(language),
				false,
				project_macro(source, node.byte_range()),
			);
			frame.kind = if known {
				FrameKind::Macro
			} else {
				FrameKind::Code
			};
			frames.push(frame);
		} else if cursor.goto_first_child() {
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				return frames;
			}
		}
	}
}

fn directive_expression(source: &str, range: Range<usize>) -> Option<(String, Vec<Projection>)> {
	let mut text = String::with_capacity(range.len() + 2);
	let mut projection = Vec::new();
	text.push('(');
	projection.push(Projection { payload: 0..1, source: range.start..range.start });
	let mut at = range.start;
	while at < range.end {
		let start = text.len();
		if source.as_bytes()[at] == b'&'
			&& source
				.as_bytes()
				.get(at + 1)
				.is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'#')
		{
			let end = at + source[at..range.end].find(';')? + 1;
			let entity = &source[at + 1..end - 1];
			let decoded = match entity {
				"amp" => '&',
				"lt" => '<',
				"gt" => '>',
				"quot" => '"',
				"apos" => '\'',
				"nbsp" => '\u{a0}',
				_ => {
					let number = if let Some(hex) = entity
						.strip_prefix("#x")
						.or_else(|| entity.strip_prefix("#X"))
					{
						u32::from_str_radix(hex, 16).ok()?
					} else {
						entity.strip_prefix('#')?.parse().ok()?
					};
					let scalar = char::from_u32(number)?;
					if scalar == '\0' {
						return None;
					}
					scalar
				},
			};
			text.push(decoded);
			projection.push(Projection { payload: start..text.len(), source: at..end });
			at = end;
		} else {
			let end = if source.as_bytes()[at] == b'&' {
				at + 1
			} else {
				at + source[at..range.end].find('&').unwrap_or(range.end - at)
			};
			text.push_str(&source[at..end]);
			projection.push(Projection { payload: start..text.len(), source: at..end });
			at = end;
		}
	}
	let start = text.len();
	text.push(')');
	projection.push(Projection { payload: start..text.len(), source: range.end..range.end });
	Some((text, projection))
}

fn directive_frame(node: Node<'_>, source: &str) -> Option<PayloadFrame> {
	let mut cursor = node.walk();
	let quoted = node
		.named_children(&mut cursor)
		.find(|child| child.kind() == "quoted_attribute_value")?;
	let value = quoted
		.named_child(0)
		.filter(|child| child.kind() == "attribute_value")?;
	let range = value.byte_range();
	let projected = directive_expression(source, range.clone());
	let mut frame = PayloadFrame::new(
		source,
		range,
		node.byte_range(),
		[Some(node.start_byte()..quoted.start_byte()), None],
		projected.as_ref().map(|_| SupportLang::JavaScript),
		false,
		projected,
	);
	frame.kind = FrameKind::Expression;
	Some(frame)
}

fn payload_frames(root: Node<'_>, source: &str, language: SupportLang) -> Vec<PayloadFrame> {
	if matches!(language, SupportLang::C | SupportLang::Cpp) {
		return ordered_frames(source, macro_payloads(root, source, language));
	}
	if language == SupportLang::Make {
		return ordered_frames(source, make_payloads(root, source));
	}
	if language == SupportLang::Dockerfile {
		return ordered_frames(source, docker_payloads(source));
	}
	if !matches!(
		language,
		SupportLang::Html | SupportLang::Vue | SupportLang::Svelte | SupportLang::Astro
	) {
		return Vec::new();
	}
	let mut frames = Vec::new();
	let mut cursor = root.walk();
	loop {
		let node = cursor.node();
		let parent = node.parent();
		let host =
			parent.filter(|parent| matches!(parent.kind(), "script_element" | "style_element"));
		let frame = if language == SupportLang::Vue && node.kind() == "directive_attribute" {
			directive_frame(node, source)
		} else if node.kind() == "raw_text"
			&& let Some(host) = host
		{
			let tag = host.named_child(0).filter(|tag| tag.kind() == "start_tag");
			let mut alias = None;
			let mut mime = None;
			if let Some(tag) = tag {
				let mut attrs = tag.walk();
				for attr in tag
					.named_children(&mut attrs)
					.filter(|node| node.kind() == "attribute")
				{
					let name = attr.named_child(0).map(|name| &source[name.byte_range()]);
					let mut value = attr.named_child(1);
					if value.is_some_and(|node| node.kind() == "quoted_attribute_value") {
						value = value.and_then(|node| node.named_child(0));
					}
					let value = value.map(|value| &source[value.byte_range()]);
					if alias.is_none() && name.is_some_and(|name| name.eq_ignore_ascii_case("lang")) {
						alias = Some(value.unwrap_or(""));
					}
					if mime.is_none() && name.is_some_and(|name| name.eq_ignore_ascii_case("type")) {
						mime = Some(value.unwrap_or(""));
					}
				}
			}
			let (payload, data) =
				crate::language::markup_payload_language(host.kind() == "style_element", alias, mime);
			Some(PayloadFrame::new(
				source,
				node.byte_range(),
				host.byte_range(),
				[tag.map(|tag| tag.byte_range()), None],
				payload,
				data,
				None,
			))
		} else if node.kind() == "frontmatter_js_block" {
			Some(PayloadFrame::new(
				source,
				node.byte_range(),
				parent.unwrap_or(node).byte_range(),
				[None, None],
				Some(SupportLang::TypeScript),
				false,
				None,
			))
		} else if matches!(node.kind(), "raw_text" | "svelte_raw_text")
			&& parent.is_some_and(|parent| matches!(parent.kind(), "interpolation" | "expression"))
		{
			let range = node.byte_range();
			let expression = node.kind() == "svelte_raw_text";
			let projected = expression.then(|| {
				let mut text = String::with_capacity(range.len() + 2);
				text.push('(');
				text.push_str(&source[range.clone()]);
				text.push(')');
				let projection = vec![
					Projection { payload: 0..1, source: range.start..range.start },
					Projection { payload: 1..range.len() + 1, source: range.clone() },
					Projection {
						payload: range.len() + 1..range.len() + 2,
						source:  range.end..range.end,
					},
				];
				(text, projection)
			});
			Some(PayloadFrame::new(
				source,
				range,
				parent.unwrap().byte_range(),
				[None, None],
				expression.then_some(SupportLang::JavaScript),
				false,
				projected,
			))
		} else {
			None
		};
		if let Some(frame) = frame {
			frames.push(frame);
		} else if node.is_named() && cursor.goto_first_child() {
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				return ordered_frames(source, frames);
			}
		}
	}
}

struct SeparatorSnapshot<'a> {
	source:              &'a str,
	tree:                &'a Tree,
	change:              Range<usize>,
	replacement_end:     usize,
	new_roles:           Option<&'a RoleSpans>,
	independent_unknown: &'a [Range<usize>],
	frames:              &'a [PayloadFrame],
}

fn ordered_frames(source: &str, mut frames: Vec<PayloadFrame>) -> Vec<PayloadFrame> {
	if frames
		.windows(2)
		.any(|pair| pair[0].range.start > pair[1].range.start)
	{
		frames.sort_unstable_by_key(|frame| frame.range.start);
	}
	if !frames
		.windows(2)
		.any(|pair| pair[0].range.end > pair[1].range.start)
	{
		return frames;
	}
	let mut result: Vec<PayloadFrame> = Vec::with_capacity(frames.len());
	for frame in frames {
		if let Some(previous) = result.last_mut()
			&& previous.range.end > frame.range.start
		{
			let mut selectors = previous.selectors.iter().chain(&frame.selectors).flatten();
			let selector = selectors.next().map(|first| {
				selectors.fold(first.clone(), |range, next| {
					range.start.min(next.start)..range.end.max(next.end)
				})
			});
			*previous = PayloadFrame::new(
				source,
				previous.range.start..previous.range.end.max(frame.range.end),
				previous.envelope.start.min(frame.envelope.start)
					..previous.envelope.end.max(frame.envelope.end),
				[selector, None],
				None,
				false,
				None,
			);
		} else {
			result.push(frame);
		}
	}
	result
}

fn frame_at(frames: &[PayloadFrame], byte: usize, gap: bool) -> Option<&PayloadFrame> {
	let at = frames
		.partition_point(|frame| frame.range.start <= byte)
		.checked_sub(1)?;
	frames
		.get(at)
		.filter(|frame| !(gap && byte == frame.range.start && frame.independent_invocation))
		.filter(|frame| {
			frame.range.contains(&byte) || gap && byte == frame.range.end && frame.envelope.end > byte
		})
}

/// Maximal genuinely retained runs with constant byte translation. Original
/// order and result order differ for moves, so keep a separate result index.
struct RetainedRuns {
	runs:   Vec<(Range<usize>, Range<usize>)>,
	result: Vec<usize>,
}

impl RetainedRuns {
	fn new(retained: &[(Range<usize>, Range<usize>)]) -> Self {
		let mut runs = retained.to_vec();
		runs.sort_unstable_by_key(|(old, _)| old.start);
		let mut count = 0;
		for at in 0..runs.len() {
			if count > 0
				&& runs[count - 1].0.end == runs[at].0.start
				&& runs[count - 1].1.end == runs[at].1.start
			{
				runs[count - 1].0.end = runs[at].0.end;
				runs[count - 1].1.end = runs[at].1.end;
			} else {
				runs[count] = runs[at].clone();
				count += 1;
			}
		}
		runs.truncate(count);
		let mut result = (0..runs.len()).collect::<Vec<_>>();
		result.sort_unstable_by_key(|&at| runs[at].1.start);
		Self { runs, result }
	}

	fn map(&self, range: &Range<usize>, original: bool) -> Option<Range<usize>> {
		let at = if original {
			self
				.runs
				.partition_point(|(old, _)| old.start <= range.start)
				.checked_sub(1)?
		} else {
			let at = self
				.result
				.partition_point(|&at| self.runs[at].1.start <= range.start)
				.checked_sub(1)?;
			self.result[at]
		};
		let (old, new) = &self.runs[at];
		let (from, to) = if original { (old, new) } else { (new, old) };
		(range.end <= from.end)
			.then(|| to.start + range.start - from.start..to.start + range.end - from.start)
	}
}

fn continuation_span<'a>(root: Node<'a>, source: &str, edge: &Range<usize>) -> Option<Node<'a>> {
	let (at, ch) = source
		.get(edge.end..)?
		.char_indices()
		.find(|(_, ch)| !ch.is_whitespace())?;
	root.descendant_for_byte_range(edge.start, edge.end + at + ch.len_utf8())
}

fn unchanged_continuation(
	before: (&str, Node<'_>, &[PayloadFrame]),
	after: (&str, Node<'_>, &[PayloadFrame]),
	edge: &Range<usize>,
	correspondence: &RetainedRuns,
	original: bool,
) -> bool {
	let (source, root, frames) = before;
	let (other_source, other_root, other_frames) = after;
	let Some(mapped_edge) = correspondence.map(edge, original) else {
		return false;
	};
	let frame = frame_at(frames, edge.start, false);
	let next = frame_at(other_frames, mapped_edge.start, false);
	match (frame, next) {
		(Some(frame), Some(next)) => {
			correspondence.map(&frame.range, original).as_ref() == Some(&next.range)
				&& correspondence.map(&frame.envelope, original).as_ref() == Some(&next.envelope)
				&& frame.language == next.language
				&& frame.kind == next.kind
				&& frame.data == next.data
				&& frame
					.selectors
					.iter()
					.zip(&next.selectors)
					.all(|(from, to)| match (from, to) {
						(None, None) => true,
						(Some(from), Some(to)) => correspondence.map(from, original).as_ref() == Some(to),
						_ => false,
					})
		},
		(None, None) => {
			match (
				continuation_span(root, source, edge),
				continuation_span(other_root, other_source, &mapped_edge),
			) {
				(Some(node), Some(next)) => {
					node.kind_id() == next.kind_id()
						&& correspondence.map(&node.byte_range(), original).as_ref()
							== Some(&next.byte_range())
				},
				_ => false,
			}
		},
		_ => false,
	}
}

fn project_make_shell(
	source: &str,
	range: Range<usize>,
	recipe: bool,
	oneshell: bool,
) -> (Option<(String, Vec<Projection>)>, Option<usize>) {
	let fragment = &source[range.clone()];
	let bytes = fragment.as_bytes();
	let transform = fragment.contains("$$")
		|| fragment.contains("\r\n")
		|| recipe
			&& (fragment.contains("\n\t")
				|| bytes
					.first()
					.is_some_and(|byte| matches!(*byte, b'@' | b'-' | b'+')));
	let mut unresolved = None;
	if !transform {
		return (
			None,
			bytes
				.iter()
				.position(|byte| *byte == b'$')
				.map(|at| range.start + at),
		);
	}
	let mut text = Vec::with_capacity(bytes.len());
	let mut projection: Vec<Projection> = Vec::new();
	let mut at = 0;
	let mut line_start = recipe;
	let mut logical_start = recipe;
	let mut escaped = false;
	while at < bytes.len() {
		if line_start && recipe {
			if bytes[at] == b'\t' {
				at += 1;
			}
			if logical_start {
				while bytes
					.get(at)
					.is_some_and(|byte| matches!(*byte, b'@' | b'-' | b'+'))
				{
					at += 1;
				}
			}
			line_start = false;
			if at == bytes.len() {
				break;
			}
		}
		if bytes[at] == b'\r' && bytes.get(at + 1) == Some(&b'\n') {
			at += 1;
			continue;
		}
		let start = at;
		let payload_start = text.len();
		let doubled = bytes[at] == b'$' && bytes.get(at + 1) == Some(&b'$');
		if bytes[at] == b'$' && !doubled {
			unresolved.get_or_insert(range.start + at);
		}
		text.push(bytes[at]);
		line_start = bytes[at] == b'\n';
		if line_start {
			logical_start = oneshell && !escaped;
			escaped = false;
		} else if bytes[at] == b'\\' {
			escaped = !escaped;
		} else {
			escaped = false;
		}
		at += if doubled { 2 } else { 1 };
		let segment = Projection {
			payload: payload_start..text.len(),
			source:  range.start + start..range.start + at,
		};
		if let Some(previous) = projection.last_mut()
			&& previous.payload.end == segment.payload.start
			&& previous.source.end == segment.source.start
			&& previous.payload.len() == previous.source.len()
			&& segment.payload.len() == segment.source.len()
		{
			previous.payload.end = segment.payload.end;
			previous.source.end = segment.source.end;
		} else {
			projection.push(segment);
		}
	}
	(
		Some((String::from_utf8(text).expect("Make projection preserves UTF-8"), projection)),
		unresolved,
	)
}

fn make_shell(node: Node<'_>, source: &str) -> Option<SupportLang> {
	if node
		.parent()
		.is_none_or(|parent| parent.kind() != "makefile")
	{
		return None;
	}
	if node.kind() != "variable_assignment" {
		return None;
	}
	let name = node.child_by_field_name("name")?;
	let value = node.child_by_field_name("value")?;
	if !matches!(source[name.end_byte()..value.start_byte()].trim(), "=" | ":=" | "::=" | ":::=") {
		return None;
	}
	let value = source[value.byte_range()].trim();
	if value.contains('$') {
		return None;
	}
	SupportLang::from_alias(value.rsplit(['/', '\\']).next().unwrap_or(value))
		.filter(|language| *language == SupportLang::Bash)
}

fn make_ordinary_prefix(node: Node<'_>, source: &str) -> bool {
	if !matches!(node.kind(), "variable_assignment" | "RECIPEPREFIX_assignment")
		|| node
			.parent()
			.is_none_or(|parent| parent.kind() != "makefile")
	{
		return false;
	}
	let Some(value) = node.child_by_field_name("value") else {
		return false;
	};
	let name_end = node
		.child_by_field_name("name")
		.map_or_else(|| node.start_byte() + ".RECIPEPREFIX".len(), |name| name.end_byte());
	matches!(source[name_end..value.start_byte()].trim(), "=" | ":=" | "::=" | ":::=")
		&& source[value.byte_range()].trim().is_empty()
}

fn make_immediate_command(node: Node<'_>, source: &str) -> bool {
	let mut current = node.parent();
	while let Some(parent) = current {
		if parent.kind() == "shell_assignment" {
			return true;
		}
		if parent.kind() == "variable_assignment" {
			let Some(name) = parent.child_by_field_name("name") else {
				return false;
			};
			let Some(value) = parent.child_by_field_name("value") else {
				return false;
			};
			return matches!(
				source[name.end_byte()..value.start_byte()].trim(),
				":=" | "::=" | ":::="
			);
		}
		current = parent.parent();
	}
	false
}

fn make_define_frames(
	node: Node<'_>,
	source: &str,
	shell: Option<SupportLang>,
	selector: Option<Range<usize>>,
) -> Vec<PayloadFrame> {
	let Some(body) = node
		.child_by_field_name("value")
		.filter(|body| body.kind() == "raw_text")
	else {
		return Vec::new();
	};
	let fragment = &source[body.byte_range()];
	let tree = parse_cached(fragment, SupportLang::Make).ok().flatten();
	let mut islands = Vec::new();
	if let Some(tree) = &tree {
		let mut cursor = tree.walk();
		loop {
			let current = cursor.node();
			let command = if current.kind() == "shell_function" && !current.has_error() {
				let mut children = current.walk();
				current
					.named_children(&mut children)
					.find(|child| child.kind() == "shell_command")
					.map(|command| command.byte_range())
			} else if current.kind() == "variable_reference" {
				let text = &fragment[current.byte_range()];
				if text.starts_with("${shell")
					&& text.as_bytes().get(7).is_some_and(u8::is_ascii_whitespace)
					&& text.ends_with('}')
				{
					let mut canonical = text.to_owned();
					canonical.replace_range(1..2, "(");
					let last = canonical.len() - 1;
					canonical.replace_range(last..=last, ")");
					parse_cached(&canonical, SupportLang::Make)
						.ok()
						.flatten()
						.and_then(|tree| {
							let function = tree.root_node().named_child(0)?;
							if function.kind() != "shell_function"
								|| function.has_error()
								|| function.end_byte() != canonical.len()
							{
								return None;
							}
							let mut children = function.walk();
							function
								.named_children(&mut children)
								.find(|child| child.kind() == "shell_command")
								.map(|command| {
									current.start_byte() + command.start_byte()
										..current.start_byte() + command.end_byte()
								})
						})
				} else {
					None
				}
			} else {
				None
			};
			if let Some(command) = command {
				islands.push((current.byte_range(), command));
			} else if cursor.goto_first_child() {
				continue;
			}
			loop {
				if cursor.goto_next_sibling() {
					break;
				}
				if !cursor.goto_parent() {
					break;
				}
			}
			if cursor.node().id() == tree.root_node().id() {
				break;
			}
		}
	}
	let native = tree
		.as_ref()
		.and_then(|tree| raw_lexical_roles(tree.root_node(), fragment, SupportLang::Make));
	let mut frames = Vec::new();
	let mut at = body.start_byte();
	for (envelope, command) in islands {
		let envelope = body.start_byte() + envelope.start..body.start_byte() + envelope.end;
		let range = body.start_byte() + command.start..body.start_byte() + command.end;
		if at < envelope.start {
			frames.push(PayloadFrame::new(
				source,
				at..envelope.start,
				at..envelope.start,
				[selector.clone(), None],
				None,
				!source[at..envelope.start].contains('$'),
				None,
			));
		}
		let (projection, unresolved) = project_make_shell(source, range.clone(), false, false);
		let mut frame = PayloadFrame::new(
			source,
			range.clone(),
			envelope.clone(),
			[selector.clone(), Some(node.start_byte()..body.start_byte())],
			shell,
			false,
			projection,
		);
		frame.unresolved = unresolved;
		if let Some(native) = &native {
			frame
				.host_code
				.extend(native.code.iter().filter_map(|token| {
					let token_range =
						body.start_byte() + token.range.start..body.start_byte() + token.range.end;
					if envelope.start > token_range.start || token_range.end > envelope.end {
						return None;
					}
					if token_range.start < range.end && range.start < token_range.end {
						return None;
					}
					Some(CodeToken {
						range:    token_range,
						language: token.language,
						kind:     token.kind,
						field:    token.field,
					})
				}));
		}
		frames.push(frame);
		at = envelope.end;
	}
	if at < body.end_byte() {
		frames.push(PayloadFrame::new(
			source,
			at..body.end_byte(),
			at..body.end_byte(),
			[selector, None],
			None,
			!source[at..body.end_byte()].contains('$'),
			None,
		));
	}
	frames
}

fn make_payloads(root: Node<'_>, source: &str) -> Vec<PayloadFrame> {
	let mut shell = Some(SupportLang::Bash);
	let mut shell_selector = None;
	let mut oneshell = false;
	let mut shell_consistent = true;
	let mut metadata = root.walk();
	loop {
		let node = metadata.node();
		if let Some(name) = node.child_by_field_name("name") {
			let name = source[name.byte_range()].trim();
			if name == "SHELL" {
				shell_selector = Some(node.byte_range());
				shell = make_shell(node, source);
				shell_consistent &= shell.is_some();
			}
		}
		if node.kind() == "rule" {
			oneshell |= node
				.named_child(0)
				.is_some_and(|targets| source[targets.byte_range()].trim() == ".ONESHELL");
		}
		if metadata.goto_first_child() {
			continue;
		}
		loop {
			if metadata.goto_next_sibling() {
				break;
			}
			if !metadata.goto_parent() {
				break;
			}
		}
		if metadata.node().id() == root.id() {
			break;
		}
	}
	let host_roles = raw_lexical_roles(root, source, SupportLang::Make);
	let mut frames = Vec::new();
	let mut immediate_shell = Some(SupportLang::Bash);
	let mut immediate_selector = None;
	let mut ordinary_prefix = true;
	let mut prefix_selector = None;
	let mut pending_shell: Option<(usize, Option<SupportLang>, Range<usize>)> = None;
	let mut pending_prefix: Option<(usize, bool, Range<usize>)> = None;
	let mut cursor = root.walk();
	loop {
		let node = cursor.node();
		if pending_shell
			.as_ref()
			.is_some_and(|(end, ..)| node.start_byte() >= *end)
		{
			let (_, language, selector) = pending_shell.take().unwrap();
			immediate_shell = language;
			immediate_selector = Some(selector);
		}
		if pending_prefix
			.as_ref()
			.is_some_and(|(end, ..)| node.start_byte() >= *end)
		{
			let (_, ordinary, selector) = pending_prefix.take().unwrap();
			ordinary_prefix = ordinary;
			prefix_selector = Some(selector);
		}
		if let Some(name) = node.child_by_field_name("name") {
			match source[name.byte_range()].trim() {
				"SHELL" => {
					pending_shell = Some((node.end_byte(), make_shell(node, source), node.byte_range()));
				},
				".RECIPEPREFIX" => {
					let ordinary = make_ordinary_prefix(node, source);
					pending_prefix = Some((node.end_byte(), ordinary, node.byte_range()));
				},
				_ => {},
			}
		}
		if node.kind() == "RECIPEPREFIX_assignment" {
			pending_prefix =
				Some((node.end_byte(), make_ordinary_prefix(node, source), node.byte_range()));
		}
		let recipe = node.kind() == if oneshell { "recipe" } else { "recipe_line" };
		let command = node.kind() == "shell_command"
			&& node.parent().is_some_and(|parent| {
				matches!(parent.kind(), "shell_assignment" | "shell_function")
					&& host_roles
						.as_deref()
						.is_some_and(|roles| role_at(roles, parent.start_byte()) == LexicalRole::Code)
			});
		if node.kind() == "define_directive" {
			frames.extend(make_define_frames(
				node,
				source,
				shell.filter(|_| shell_consistent),
				shell_selector.clone(),
			));
		} else if recipe || command {
			let range = if oneshell && recipe {
				let mut lines = node.walk();
				let mut lines = node
					.named_children(&mut lines)
					.filter(|line| line.kind() == "recipe_line");
				let first = lines.next();
				first.map(|first| first.start_byte()..lines.last().unwrap_or(first).end_byte())
			} else {
				Some(node.byte_range())
			};
			if let Some(mut range) = range {
				let mut envelope = if recipe {
					node.byte_range()
				} else {
					node.parent().unwrap().byte_range()
				};
				if command
					&& node
						.parent()
						.is_some_and(|parent| parent.kind() == "shell_assignment")
					&& let Some((comment, _)) =
						host_roles
							.as_deref()
							.unwrap_or_default()
							.iter()
							.find(|(span, role)| {
								*role == LexicalRole::Comment
									&& range.start <= span.start
									&& span.start < range.end
							}) {
					range.end = comment.start;
					envelope.end = comment.start;
				}
				let (projection, unresolved) =
					project_make_shell(source, range.clone(), recipe, oneshell);
				let immediate = command && make_immediate_command(node, source);
				let language = if recipe {
					shell
				} else if immediate {
					immediate_shell
				} else {
					shell.filter(|_| shell_consistent)
				}
				.filter(|_| !recipe || ordinary_prefix);
				let selector = if immediate {
					immediate_selector.clone()
				} else {
					shell_selector.clone()
				};
				let mut frame = PayloadFrame::new(
					source,
					range,
					envelope,
					[
						selector,
						if recipe {
							prefix_selector.clone()
						} else {
							None
						},
					],
					language,
					false,
					projection,
				);
				frame.independent_invocation = recipe && !oneshell;
				frame.unresolved = unresolved;
				frames.push(frame);
			}
		} else if node.is_error() && !ordinary_prefix {
			let start = source[..node.start_byte()]
				.rfind('\n')
				.map_or(0, |at| at + 1);
			let end = node.end_byte()
				+ source[node.end_byte()..]
					.find('\n')
					.map_or_else(|| source.len() - node.end_byte(), |at| at + 1);
			frames.push(PayloadFrame::new(
				source,
				start..end,
				start..end,
				[shell_selector.clone(), prefix_selector.clone()],
				None,
				false,
				None,
			));
		} else if cursor.goto_first_child() {
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				return frames;
			}
		}
	}
}

struct DockerRemoval {
	range:     Range<usize>,
	successor: Option<usize>,
}

struct DockerHeader {
	end:      usize,
	next_row: usize,
	complete: bool,
	removed:  Vec<DockerRemoval>,
}

/// Docker removes host continuations and whole comment rows before handing
/// a logical instruction to its command parser. Keep one physical-byte plan
/// for both instruction extent and every projected proof.
fn docker_header(rows: &[(usize, &str)], first: usize, escape: char) -> DockerHeader {
	let mut row = first;
	let mut removed = Vec::new();
	let mut complete = true;
	loop {
		let (start, line) = rows[row];
		let tail = line
			.trim_end_matches(['\r', '\n'])
			.trim_end_matches([' ', '\t']);
		if !line.ends_with('\n') || !tail.ends_with(escape) {
			break;
		}
		let splice = removed.len();
		removed.push(DockerRemoval {
			range:     start + tail.len() - escape.len_utf8()..start + line.len(),
			successor: Some(start + line.len()),
		});
		row += 1;
		while row < rows.len() && rows[row].1.trim_start().starts_with('#') {
			let (start, line) = rows[row];
			removed.push(DockerRemoval { range: start..start + line.len(), successor: None });
			row += 1;
		}
		let successor = rows.get(row).map_or_else(
			|| rows.last().map_or(0, |(start, line)| start + line.len()),
			|(start, _)| *start,
		);
		removed[splice].successor = Some(successor);
		if row == rows.len() {
			row -= 1;
			complete = false;
			break;
		}
	}
	DockerHeader { end: rows[row].0 + rows[row].1.len(), next_row: row + 1, complete, removed }
}

fn project_docker_shell(
	source: &str,
	range: Range<usize>,
	removed: &[DockerRemoval],
) -> Option<(String, Vec<Projection>)> {
	let fragment = &source[range.clone()];
	let mut omission = removed.partition_point(|part| part.range.end <= range.start);
	if removed
		.get(omission)
		.is_none_or(|part| part.range.start >= range.end)
		&& !fragment.contains("\r\n")
	{
		return None;
	}
	let bytes = fragment.as_bytes();
	let mut text = Vec::with_capacity(bytes.len());
	let mut projection: Vec<Projection> = Vec::new();
	let mut at = 0;
	while at < bytes.len() {
		if let Some(part) = removed.get(omission)
			&& part.range.start <= range.start + at
		{
			at = part.range.end.min(range.end) - range.start;
			omission += 1;
			continue;
		}
		if bytes[at] == b'\r' && bytes.get(at + 1) == Some(&b'\n') {
			at += 1;
			continue;
		}
		let start = text.len();
		text.push(bytes[at]);
		if let Some(previous) = projection.last_mut()
			&& previous.source.end == range.start + at
		{
			previous.source.end += 1;
			previous.payload.end += 1;
		} else {
			projection.push(Projection {
				payload: start..text.len(),
				source:  range.start + at..range.start + at + 1,
			});
		}
		at += 1;
	}
	Some((String::from_utf8(text).expect("Docker projection preserves UTF-8"), projection))
}

/// Docker directives are authoritative only in the initial directive run.
fn docker_escape(source: &str) -> (Option<u8>, Option<Range<usize>>) {
	let mut selected = Some(b'\\');
	let mut selector = None;
	let mut at = 0;
	for line in source.split_inclusive('\n') {
		let Some(comment) = line.trim_start().strip_prefix('#') else {
			break;
		};
		let Some((key, value)) = comment.trim().split_once('=') else {
			break;
		};
		if key.trim().eq_ignore_ascii_case("escape") {
			selected = if selector.is_none() {
				match value.trim() {
					"\\" => Some(b'\\'),
					"`" => Some(b'`'),
					_ => None,
				}
			} else {
				None
			};
			selector = Some(at..at + line.len());
		} else if !["syntax", "check"]
			.iter()
			.any(|known| key.trim().eq_ignore_ascii_case(known))
		{
			break;
		}
		at += line.len();
	}
	(selected, selector)
}

fn docker_payloads(source: &str) -> Vec<PayloadFrame> {
	let rows: Vec<_> = source
		.split_inclusive('\n')
		.scan(0, |at, row| {
			let start = *at;
			*at += row.len();
			Some((start, row))
		})
		.collect();
	let mut frames = Vec::new();
	let mut shell = Some(SupportLang::Bash);
	let mut shell_selector = None;
	let (escape, escape_selector) = docker_escape(source);
	let escape_supported = escape == Some(b'\\');
	let escape_byte = char::from(escape.unwrap_or(b'\\'));
	let mut row = 0;
	while row < rows.len() {
		let (start, line) = rows[row];
		let trimmed = line.trim_start();
		if trimmed.starts_with('#') {
			row += 1;
			continue;
		}
		let keyword_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
		let mut keyword = &trimmed[..keyword_end];
		let body = start + line.len() - trimmed.len() + keyword_end;
		let mut body = body + source[body..start + line.len()].len()
			- source[body..start + line.len()].trim_start().len();
		let onbuild = keyword.eq_ignore_ascii_case("ONBUILD");
		let mut instruction_start = start;
		if onbuild {
			instruction_start = body;
			let instruction = &source[body..start + line.len()];
			let end = instruction
				.find(char::is_whitespace)
				.unwrap_or(instruction.len());
			keyword = &instruction[..end];
			body += end;
			body += source[body..start + line.len()].len()
				- source[body..start + line.len()].trim_start().len();
		}
		let header_start = row;
		let phase = docker_header(&rows, row, escape_byte);
		let header_end = phase.end;
		row = phase.next_row;
		if !onbuild && keyword.eq_ignore_ascii_case("FROM") {
			let projection = project_docker_shell(source, body..header_end, &phase.removed);
			let header = projection
				.as_ref()
				.map_or(&source[body..header_end], |(text, _)| text.as_str());
			let first = header.split_ascii_whitespace().next().unwrap_or_default();
			let posix = !first.starts_with("--")
				|| first.strip_prefix("--platform=").is_some_and(|platform| {
					(platform == "linux" || platform.starts_with("linux/")) && !platform.contains('$')
				});
			shell = (posix && phase.complete).then_some(SupportLang::Bash);
			shell_selector = Some(start..header_end);
			continue;
		}
		if !onbuild && keyword.eq_ignore_ascii_case("SHELL") {
			shell_selector = Some(start..header_end);
			let projection = project_docker_shell(source, body..header_end, &phase.removed);
			let header = projection
				.as_ref()
				.map_or(&source[body..header_end], |(text, _)| text.as_str())
				.trim();
			shell = phase
				.complete
				.then(|| parse_cached(header, SupportLang::Json).ok().flatten())
				.flatten()
				.filter(|tree| !tree.root_node().has_error())
				.and_then(|tree| {
					let array = tree.root_node().named_child(0)?;
					if array.kind() != "array" {
						return None;
					}
					let command = array.named_child(0)?;
					if command.kind() != "string" {
						return None;
					}
					let command = header[command.byte_range()].trim_matches('"');
					(!command.contains('\\'))
						.then(|| SupportLang::from_alias(command.rsplit('/').next().unwrap_or(command)))
						.flatten()
				})
				.filter(|language| *language == SupportLang::Bash);
			continue;
		}
		let run = keyword.eq_ignore_ascii_case("RUN");
		let copy = keyword.eq_ignore_ascii_case("COPY");
		if !run && !copy {
			continue;
		}
		let header_body = body;
		let mut header_projection = project_docker_shell(source, body..header_end, &phase.removed);
		let (has_options, possible_json, has_heredoc) = {
			let header = header_projection
				.as_ref()
				.map_or(&source[body..header_end], |(text, _)| text.as_str());
			(run && header.starts_with("--"), run && header.starts_with('['), header.contains("<<"))
		};
		let instruction_range = instruction_start..header_end;
		let instruction_projection = (has_options || possible_json || has_heredoc)
			.then(|| project_docker_shell(source, instruction_range.clone(), &phase.removed))
			.flatten();
		let docker_header = instruction_projection
			.as_ref()
			.map_or_else(|| &source[instruction_range.clone()], |(text, _)| text.as_str());
		let instruction_map = instruction_projection
			.as_ref()
			.map_or(&[][..], |(_, map)| map.as_slice());
		let docker_tree = (has_options || possible_json || has_heredoc)
			.then(|| {
				parse_cached(docker_header, SupportLang::Dockerfile)
					.ok()
					.flatten()
			})
			.flatten();
		let mut header_certain = phase.complete;
		let mut exec_json = false;
		if has_options || possible_json {
			let command = docker_tree.as_ref().and_then(|tree| {
				let instruction = tree.root_node().named_child(0)?;
				let mut cursor = instruction.walk();
				instruction
					.named_children(&mut cursor)
					.find(|node| matches!(node.kind(), "shell_command" | "json_string_array"))
			});
			if let Some((at, json)) = command.and_then(|command| {
				Some((
					projection_source_byte(
						instruction_map,
						&instruction_range,
						command.start_byte(),
						false,
					)?,
					command.kind() == "json_string_array",
				))
			}) {
				body = at;
				exec_json = json;
			} else {
				header_certain = false;
			}
		}
		header_certain &= !possible_json || exec_json;
		if body != header_body {
			header_projection = project_docker_shell(source, body..header_end, &phase.removed);
		}
		let header = header_projection
			.as_ref()
			.map_or(&source[body..header_end], |(text, _)| text.as_str());
		let header_tree = (shell == Some(SupportLang::Bash) && run && header.contains("<<"))
			.then(|| parse_cached(header, SupportLang::Bash).ok().flatten())
			.flatten();
		let header_roles = header_tree
			.as_ref()
			.and_then(|tree| lexical_roles(tree.root_node(), header, SupportLang::Bash));
		let mut markers = Vec::new();
		if header.contains("<<")
			&& let Some(tree) = &docker_tree
		{
			let mut cursor = tree.walk();
			loop {
				let node = cursor.node();
				if node.kind() == "heredoc_marker"
					&& let Some(absolute) = projection_source_byte(
						instruction_map,
						&instruction_range,
						node.start_byte(),
						false,
					) {
					let projection = header_projection
						.as_ref()
						.map_or(&[][..], |(_, projection)| projection.as_slice());
					let position = projected_byte(projection, &(body..header_end), absolute);
					let literal = position.is_some_and(|at| {
						header_roles.as_ref().is_some_and(|roles| {
							matches!(
								role_at(roles, at),
								LexicalRole::Literal(_)
									| LexicalRole::Escape(_)
									| LexicalRole::Delimiter(_, _)
							)
						})
					});
					let mut leaf = position.and_then(|at| {
						header_tree
							.as_ref()?
							.root_node()
							.descendant_for_byte_range(at, at + 1)
					});
					let mut here_string = false;
					while let Some(current) = leaf {
						here_string |= current.kind() == "herestring_redirect";
						leaf = current.parent();
					}
					if !literal && !here_string {
						let marker = &docker_header[node.byte_range()];
						if let Some(delimiter) = marker
							.strip_prefix("<<-")
							.or_else(|| marker.strip_prefix("<<"))
						{
							markers.push((
								absolute,
								delimiter.trim_matches(['\'', '"']),
								marker.starts_with("<<-"),
							));
						}
					}
				} else if cursor.goto_first_child() {
					continue;
				}
				loop {
					if cursor.goto_next_sibling() {
						break;
					}
					if !cursor.goto_parent() {
						break;
					}
				}
				if cursor.node().id() == tree.root_node().id() {
					break;
				}
			}
		}
		let mut complete = true;
		let mut body_end = header_end;
		for (_, marker, strip_tabs) in &markers {
			let mut found = false;
			while row < rows.len() {
				let tail = rows[row].1.trim_end_matches(['\r', '\n']);
				let tail = if *strip_tabs {
					tail.trim_start_matches('\t')
				} else {
					tail
				};
				row += 1;
				if tail == *marker {
					body_end = rows[row - 1].0;
					found = true;
					break;
				}
			}
			complete &= found;
		}
		let end = rows[row.saturating_sub(1)].0 + rows[row.saturating_sub(1)].1.len();
		let shorthand = run
			&& markers
				.first()
				.is_some_and(|(at, ..)| source[body..*at].trim().is_empty());
		let range = if copy || shorthand {
			header_end..if complete { body_end } else { end }
		} else {
			body..end
		};
		let language = if exec_json {
			(header_certain && complete && escape_supported).then_some(SupportLang::Json)
		} else if run {
			shell.filter(|_| {
				header_certain && complete && escape_supported && (!shorthand || markers.len() == 1)
			})
		} else {
			None
		};
		if !range.is_empty() {
			let projection = if copy {
				None
			} else if !shorthand && end == header_end {
				header_projection
			} else {
				project_docker_shell(source, range.clone(), &phase.removed)
			};
			let mut frame = PayloadFrame::new(
				source,
				range,
				rows[header_start].0..end,
				[shell_selector.clone(), escape_selector.clone()],
				language,
				copy && complete,
				projection,
			);
			if onbuild {
				frame.kind = FrameKind::Onbuild;
			}
			if language == Some(SupportLang::Bash) {
				frame
					.continuations
					.extend(phase.removed.iter().filter_map(|part| {
						let successor = part.successor?;
						(frame.range.start <= part.range.start && successor <= frame.range.end)
							.then_some(part.range.start..successor)
					}));
			}
			frames.push(frame);
		}
	}
	frames
}

fn lexical_roles_view(
	root: Node<'_>,
	source: &str,
	language: SupportLang,
	frames: &[PayloadFrame],
) -> Option<RoleSpans> {
	let host = lexical_roles(root, source, language)?;
	if frames.is_empty() {
		return Some(host);
	}
	// Keep genuine host tokens on source-only prefixes/trivia removed by the
	// projection (for example Make's @/+ recipe flags). Payload tokens replace
	// only the mapped bytes; synthetic payload bytes certify nothing.
	let mut code = Vec::new();
	for token in host.code {
		let mut start = token.range.start;
		let at = frames.partition_point(|frame| frame.range.end <= start);
		let mut remove = |range: &Range<usize>| {
			if range.start >= token.range.end || range.end <= start {
				return;
			}
			if start < range.start {
				code.push(CodeToken {
					range:    start..range.start.min(token.range.end),
					language: token.language,
					kind:     token.kind,
					field:    token.field,
				});
			}
			start = start.max(range.end);
		};
		for frame in frames[at..]
			.iter()
			.take_while(|frame| frame.range.start < token.range.end)
		{
			if frame.projection.is_empty() || frame.unknown() || frame.data {
				remove(&frame.range);
			} else {
				for part in frame
					.projection
					.iter()
					.filter(|part| !part.payload.is_empty())
				{
					remove(&part.source);
				}
			}
		}
		if start < token.range.end {
			code.push(CodeToken {
				range:    start..token.range.end,
				language: token.language,
				kind:     token.kind,
				field:    token.field,
			});
		}
	}
	let mut result = RoleSpans {
		spans: Vec::with_capacity(host.spans.len()),
		modes: host.modes,
		words: host.words,
		word_ends: host.word_ends,
		code,
		pairs: host.pairs,
		continuations: host.continuations,
		uncertain_continuations: host.uncertain_continuations,
		units: host.units,
	};
	let mut frame_at = 0;
	for (range, role) in host.spans {
		let mut start = range.start;
		while frame_at < frames.len() && frames[frame_at].envelope.end <= start {
			frame_at += 1;
		}
		for frame in frames[frame_at..]
			.iter()
			.take_while(|frame| frame.envelope.start < range.end)
		{
			if start < frame.envelope.start {
				result
					.spans
					.push((start..frame.envelope.start.min(range.end), role));
			}
			start = start.max(frame.envelope.end);
		}
		if start < range.end {
			result.spans.push((start..range.end, role));
		}
	}
	for frame in frames {
		result.code.extend(frame.host_code.iter().cloned());
		result
			.continuations
			.extend(frame.continuations.iter().cloned());
		if frame.data && frame.language.is_none() {
			let mode = result.modes.len();
			result.modes.push(LiteralPrefix::Source(0..0));
			result.spans.push((
				frame.range.clone(),
				LexicalRole::Literal(LiteralDialect { language, kind: u16::MAX, mode, escape: b'\\' }),
			));
		} else if frame.unknown() && frame.kind != FrameKind::Macro {
			result
				.spans
				.push((frame.range.clone(), LexicalRole::Unknown));
		} else {
			result.units.extend(
				frame
					.projection
					.iter()
					.filter(|part| {
						!part.payload.is_empty()
							&& !part.source.is_empty()
							&& part.payload.len() != part.source.len()
					})
					.map(|part| part.source.clone()),
			);
			let roles = frame.roles(source)?;
			let modes = result.import_modes(roles, frame.text(source), source, |byte, end| {
				frame.source_byte(byte, end)
			});
			result.import_words(roles, |byte, end| frame.source_byte(byte, end));
			result.import_continuations(roles, |byte, end| frame.source_byte(byte, end))?;
			result.import_code(roles, &frame.projection, |byte, end| frame.source_byte(byte, end));
			let pairs = result.import_pairs(roles, |byte, end| frame.source_byte(byte, end));
			let limit = frame.unresolved.unwrap_or(frame.range.end);
			let mut push = |mut range: Range<usize>, role| {
				range.end = range.end.min(limit);
				if range.start < range.end {
					result.spans.push((range, role));
				}
			};
			for (range, role) in roles.iter() {
				let role = imported_role(*role, &modes, &pairs);
				if frame.projection.is_empty()
					|| matches!(role, LexicalRole::Escape(_) | LexicalRole::Delimiter(_, _))
				{
					push(
						frame.source_byte(range.start, false)?..frame.source_byte(range.end, true)?,
						role,
					);
				} else {
					let at = frame
						.projection
						.partition_point(|part| part.payload.end <= range.start);
					for part in frame.projection[at..]
						.iter()
						.take_while(|part| part.payload.start < range.end)
					{
						let start = range.start.max(part.payload.start);
						let end = range.end.min(part.payload.end);
						push(frame.source_byte(start, false)?..frame.source_byte(end, true)?, role);
					}
				}
			}
			if let Some(at) = frame.unresolved {
				result
					.spans
					.push((at..frame.range.end, LexicalRole::Unknown));
			}
		}
		if frame.kind == FrameKind::Macro {
			let mode = result.modes.len();
			result.modes.push(LiteralPrefix::Source(0..0));
			let dialect =
				LiteralDialect { language: frame.language?, kind: u16::MAX, mode, escape: b'\\' };
			for parts in frame.projection.windows(2) {
				let range = parts[0].source.end..parts[1].source.start;
				if source
					.get(range.clone())
					.is_some_and(|text| matches!(text, "\\\n" | "\\\r\n"))
				{
					result
						.spans
						.push((range.clone(), LexicalRole::Escape(dialect)));
					result.continuations.push(range);
				}
			}
		}
	}
	result.spans.sort_unstable_by_key(|(range, _)| range.start);
	result.sort_words();
	result.code.sort_unstable_by_key(|token| token.range.start);
	result
		.continuations
		.sort_unstable_by_key(|range| range.start);
	result
		.uncertain_continuations
		.sort_unstable_by_key(|range| range.start);
	result.units.sort_unstable_by_key(|range| range.start);
	Some(result)
}

fn unchanged_range(
	range: &Range<usize>,
	change: &Range<usize>,
	replacement: usize,
) -> Option<Range<usize>> {
	if range.end <= change.start {
		Some(range.clone())
	} else if range.start >= change.end {
		Some(
			range.start - change.end + change.start + replacement
				..range.end - change.end + change.start + replacement,
		)
	} else {
		None
	}
}

fn independent_unknown(
	old: &[PayloadFrame],
	new: &[PayloadFrame],
	source: &str,
	candidate: &str,
	change: &Range<usize>,
	replacement: usize,
) -> Vec<Range<usize>> {
	old.iter()
		.filter(|frame| frame.unknown() || frame.unresolved.is_some())
		.filter_map(|frame| {
			let shift = |byte| {
				if byte <= change.start {
					Some(byte)
				} else if byte >= change.end {
					Some(byte - change.len() + replacement)
				} else {
					None
				}
			};
			let opaque = if frame.unknown() {
				frame.range.clone()
			} else {
				frame.unresolved?..frame.range.end
			};
			let mapped_opaque = unchanged_range(&opaque, change, replacement)?;
			let untouched = unchanged_range(&frame.envelope, change, replacement);
			if untouched.is_none()
				&& (frame.unknown() || change.start < frame.range.start || change.end > opaque.start)
			{
				return None;
			}
			let envelope = shift(frame.envelope.start)?..shift(frame.envelope.end)?;
			let range = shift(frame.range.start)?..shift(frame.range.end)?;
			let same = frame_at(new, range.start, false).filter(|next| {
				next.range == range
					&& next.envelope == envelope
					&& next.language == frame.language
					&& next.data == frame.data
					&& next.kind == frame.kind
					&& next.unresolved == frame.unresolved.and_then(shift)
			})?;
			if let Some(envelope) = untouched {
				if source[frame.envelope.clone()] != candidate[envelope] {
					return None;
				}
			} else if source[opaque.clone()] != candidate[mapped_opaque]
				|| source[frame.envelope.start..frame.range.start]
					!= candidate[envelope.start..range.start]
				|| source[frame.range.end..frame.envelope.end] != candidate[range.end..envelope.end]
				|| frame
					.same_unresolved_boundary(same, source, candidate, &shift)
					.is_none()
			{
				return None;
			}
			for (selector, next) in frame.selectors.iter().zip(&same.selectors) {
				match (selector, next) {
					(None, None) => {},
					(Some(selector), Some(next))
						if unchanged_range(selector, change, replacement).as_ref() == Some(next)
							&& source[selector.clone()] == candidate[next.clone()] => {},
					_ => return None,
				}
			}
			Some(opaque)
		})
		.collect()
}

/// One incrementally parsed candidate, shared by lexical and separator checks.
pub struct ParsedChange<'a> {
	original:            &'a BlockIndex<'a>,
	change:              Range<usize>,
	replacement_end:     usize,
	source:              String,
	tree:                Tree,
	roles:               Option<RoleSpans>,
	independent_unknown: Vec<Range<usize>>,
	frames:              Vec<PayloadFrame>,
}

impl ParsedChange<'_> {
	pub const fn start_byte(&self) -> usize {
		self.change.start
	}

	pub fn original_fragment(&self) -> &str {
		&self.original.code[self.change.clone()]
	}

	pub fn original_roles(&self) -> Option<LexicalView<'_>> {
		Some(LexicalView { roles: self.original.role_spans()?, source: self.original.code })
	}

	pub fn roles(&self) -> Option<LexicalView<'_>> {
		Some(LexicalView { roles: self.roles.as_ref()?, source: &self.source })
	}

	pub fn with_replacement(&self, replacement: &str) -> Result<ParsedChange<'_>> {
		self.original.parse_change(self.change.clone(), replacement)
	}

	/// Validate omitted separators and retained text against these exact bytes.
	pub fn preserves_separators(
		&self,
		separators: &[(usize, usize)],
		unchanged: &[(usize, usize)],
		rewritten: &[(usize, usize)],
	) -> SeparatorProof {
		self
			.original
			.checked_separators(self, separators, unchanged, rewritten)
	}

	pub const fn original(&self) -> &BlockIndex<'_> {
		self.original
	}

	/// Move the exact candidate bytes into the writer without another copy.
	pub fn into_source(self) -> String {
		self.source
	}
}

/// Count of leading space/tab bytes on `row` (0-indexed), i.e. the byte column
/// of the first content character. Returns `None` when `row` is out of range
/// or the line is blank / whitespace-only — there is no block to resolve there.
fn first_content_column(code: &str, row: usize) -> Option<usize> {
	content_column(code.split('\n').nth(row)?)
}

/// Byte column of `line`'s first character other than a space or tab.
fn content_column(line: &str) -> Option<usize> {
	line.bytes().position(|byte| byte != b' ' && byte != b'\t')
}

/// Resolve the block beginning on `options.line`.
///
/// Returns `None` (a soft "no block here", surfaced as a hard error one layer
/// up) when the language is unrecognized, the line is out of range / blank, no
/// node begins on that line, or the resolved subtree contains a syntax error.
pub fn block_range_at(options: BlockRangeOptions) -> Result<Option<BlockRange>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	with_block_node(&code, lang.as_deref(), path.as_deref(), line, range_of)
}

fn range_of(node: Node<'_>) -> BlockRange {
	BlockRange { start_line: node_start_line(node), end_line: node_content_end_line(node) }
}

/// One parse of a source that answers block questions about any of its lines.
///
/// Every query walks the tree it holds; none re-parses, re-hashes or
/// re-splits the source, so asking about many lines of a large file costs one
/// parse.
pub struct BlockIndex<'a> {
	code:            &'a str,
	language:        SupportLang,
	tree:            Cow<'a, Tree>,
	/// Byte offset at which each row begins.
	line_starts:     Cow<'a, [usize]>,
	role_spans:      Cow<'a, OnceLock<Option<RoleSpans>>>,
	label_targets:   RefCell<HashMap<usize, Option<ScopeEvidence>>>,
	payloads:        OnceLock<Vec<PayloadFrame>>,
	boundaries:      Cow<'a, OnceLock<Vec<BoundaryNode>>>,
	sibling_targets: Cow<'a, RefCell<HashMap<usize, Option<ScopeEvidence>>>>,
	proof_depths:    Cow<'a, ProofDepths>,
	metadata_owners: Cow<'a, MetadataOwners>,
}

#[derive(Clone, Copy)]
struct BoundaryNode {
	id:    usize,
	start: usize,
	end:   usize,
	row:   usize,
}

impl<'a> BlockIndex<'a> {
	/// Parse `code` (through the parse cache) in the language `path` names.
	/// `None` when the source is empty, the language is unrecognized, or the
	/// parser yields nothing.
	pub fn new(code: &'a str, path: &str) -> Result<Option<Self>> {
		if code.is_empty() {
			return Ok(None);
		}
		let Some(language) = resolve_language(None, Some(path)) else {
			return Ok(None);
		};
		let Some(tree) = parse_cached(code, language)? else {
			return Ok(None);
		};
		let line_starts: Vec<usize> = std::iter::once(0)
			.chain(code.match_indices('\n').map(|(at, _)| at + 1))
			.collect();
		Ok(Some(Self {
			code,
			language,
			tree: Cow::Owned(tree),
			line_starts: Cow::Owned(line_starts),
			role_spans: Cow::Owned(OnceLock::new()),
			label_targets: RefCell::default(),
			payloads: OnceLock::new(),
			boundaries: Cow::Owned(OnceLock::new()),
			sibling_targets: Cow::Owned(RefCell::default()),
			proof_depths: Cow::Owned(RefCell::default()),
			metadata_owners: Cow::Owned(RefCell::default()),
		}))
	}

	fn sibling_label_scope(
		&self,
		label: Node<'_>,
		resolution: &mut ScopeResolution,
	) -> Option<ScopeEvidence> {
		let mut labels = Vec::new();
		let mut target = label;
		let proof = loop {
			let cached = self.sibling_targets.borrow().get(&target.id()).copied();
			if let Some(proof) = cached {
				break proof;
			}
			labels.push(target.id());
			let mut next = sibling_after(target, |node| node.is_named() && !is_comment(node));
			while let Some(attribute) = next.filter(|node| is_attribute_like(*node)) {
				if !matches!(
					attribute_owner(attribute, self.code, self.language, &self.metadata_owners),
					AttributeOwner::NextItem
				) {
					resolution.failed = true;
					next = None;
					break;
				}
				next = sibling_after(attribute, |node| node.is_named() && !is_comment(node));
			}
			let Some(next) = next else {
				resolution.failed = true;
				break None;
			};
			if next.start_byte() < target.end_byte() {
				resolution.failed = true;
				break None;
			}
			if !next.kind().split('_').any(|word| word == "label") {
				let closed_statement = self.language.attachment_executable_kind(next.kind())
					&& !next.has_error()
					&& !next.is_missing()
					&& next.child_count().checked_sub(1).is_some_and(|last| {
						next
							.child(last)
							.is_some_and(|end| !end.is_named() && !end.is_missing() && end.kind() == ";")
					});
				if (statement_container(next) && Self::closes_its_opener(next)) || closed_statement {
					break Some(ScopeEvidence {
						range:         BlockRange {
							start_line: node_start_line(next),
							end_line:   node_content_end_line(next),
						},
						owner:         ScopeOwner { frame: 0, node: next.id() },
						certain:       !next.has_error(),
						host_domain:   false,
						owned_end_gap: false,
					});
				}
				let position = next.start_position();
				break self.resolve_scope(row_to_line(position.row), position.column, resolution);
			}
			target = next;
		};
		if proof.is_none() {
			resolution.failed = true;
		}
		let mut targets = self.sibling_targets.borrow_mut();
		for label in labels {
			targets.insert(label, proof);
		}
		proof
	}

	fn boundary_nodes(&self, row: usize) -> &[BoundaryNode] {
		let nodes = self.boundaries.get_or_init(|| {
			let mut nodes = Vec::new();
			let mut stack = vec![self.tree.root_node()];
			while let Some(node) = stack.pop() {
				if content_end_row(node) <= node.start_position().row {
					continue;
				}
				nodes.push(BoundaryNode {
					id:    node.id(),
					start: node.start_byte(),
					end:   node.end_byte(),
					row:   node.start_position().row,
				});
				if node.named_child_count() == 0 {
					continue;
				}
				let mut cursor = node.walk();
				stack.extend(node.named_children(&mut cursor));
			}
			nodes.sort_unstable_by_key(|node| (node.row, node.start));
			nodes
		});
		let start = nodes.partition_point(|node| node.row < row);
		let end = start + nodes[start..].partition_point(|node| node.row == row);
		&nodes[start..end]
	}

	fn row_text(&self, row: usize) -> Option<&'a str> {
		let start = *self.line_starts.get(row)?;
		let end = self
			.line_starts
			.get(row + 1)
			.map_or(self.code.len(), |next| next - 1);
		Some(&self.code[start..end])
	}

	/// The node [`block_range_at`] resolves for 1-indexed `line`.
	fn node(&self, line: u32) -> Option<Node<'_>> {
		let row = (line as usize).checked_sub(1)?;
		let col = content_column(self.row_text(row)?)?;
		block_node(self.tree.root_node(), row, col)
	}

	/// The block beginning on `line`, as [`block_range_at`] resolves it.
	pub fn block_range(&self, line: u32) -> Option<BlockRange> {
		self.node(line).map(range_of)
	}

	/// Whether this byte begins a real grammar separator, not literal data
	/// or comment text.
	pub fn separator_at(&self, row: usize, column: usize) -> bool {
		let Some(byte) = self.line_starts.get(row).map(|start| start + column) else {
			return false;
		};
		if let Some(frame) = frame_at(self.frames(), byte, false) {
			return frame
				.with_index(self.code, |index| {
					let Some(at) = frame.payload_byte(byte) else {
						return false;
					};
					let point = index.point_at(at);
					index.separator_at(point.row, point.column)
				})
				.unwrap_or(false);
		}
		self
			.tree
			.root_node()
			.descendant_for_byte_range(byte, byte + 1)
			.is_some_and(|node| !node.is_named() && matches!(node.kind(), "," | ";"))
	}

	fn role_spans(&self) -> Option<&RoleSpans> {
		self
			.role_spans
			.get_or_init(|| {
				lexical_roles_view(self.tree.root_node(), self.code, self.language, self.frames())
			})
			.as_ref()
	}

	fn frames(&self) -> &[PayloadFrame] {
		self
			.payloads
			.get_or_init(|| payload_frames(self.tree.root_node(), self.code, self.language))
	}

	/// Parse a candidate once, reusing the original tree and lexical-role cache.
	pub fn parse_change(&self, change: Range<usize>, replacement: &str) -> Result<ParsedChange<'_>> {
		let (source, tree) = self.reparse(change.clone(), replacement)?;
		let frames = payload_frames(tree.root_node(), &source, self.language);
		let roles = lexical_roles_view(tree.root_node(), &source, self.language, &frames);
		let independent_unknown = independent_unknown(
			self.frames(),
			&frames,
			self.code,
			&source,
			&change,
			replacement.len(),
		);
		Ok(ParsedChange {
			original: self,
			replacement_end: change.start + replacement.len(),
			change,
			source,
			tree,
			roles,
			independent_unknown,
			frames,
		})
	}

	/// Original byte offset of a physical row.
	pub fn row_start(&self, row: usize) -> Option<usize> {
		self.line_starts.get(row).copied()
	}

	/// Validate omitted separators on the exact candidate bytes, retaining
	/// the original successor's grammar identity and separator parent.
	fn checked_separators(
		&self,
		parsed: &ParsedChange<'_>,
		separators: &[(usize, usize)],
		unchanged: &[(usize, usize)],
		rewritten: &[(usize, usize)],
	) -> SeparatorProof {
		self.checked_separator_view(
			SeparatorSnapshot {
				source:              &parsed.source,
				tree:                &parsed.tree,
				change:              parsed.change.clone(),
				replacement_end:     parsed.replacement_end,
				new_roles:           parsed.roles.as_ref(),
				independent_unknown: &parsed.independent_unknown,
				frames:              &parsed.frames,
			},
			separators,
			unchanged,
			rewritten,
		)
	}

	fn checked_separator_view(
		&self,
		snapshot: SeparatorSnapshot<'_>,
		separators: &[(usize, usize)],
		unchanged: &[(usize, usize)],
		rewritten: &[(usize, usize)],
	) -> SeparatorProof {
		let SeparatorSnapshot {
			source,
			tree,
			change,
			replacement_end,
			new_roles,
			independent_unknown,
			frames,
		} = snapshot;
		let replacement = &source[change.start..replacement_end];
		let Some(old_roles) = self.role_spans() else {
			return SeparatorProof::Rejected;
		};
		let Some(new_roles) = new_roles else {
			return SeparatorProof::Rejected;
		};
		if !retained_roles(
			old_roles,
			new_roles,
			self.code,
			source,
			change.clone(),
			replacement.len(),
			independent_unknown,
		) {
			return SeparatorProof::Rejected;
		}
		let replacement_starts = std::iter::once(0)
			.chain(replacement.match_indices('\n').map(|(at, _)| at + 1))
			.collect::<Vec<_>>();
		let shared_prefix = self.code[change.clone()]
			.bytes()
			.zip(replacement.bytes())
			.take_while(|(old, new)| old == new)
			.count();
		let change_point = self.point_at(change.start);
		let first_column = change_point.column;
		let shift = |byte: usize| {
			if byte >= change.end {
				Some(byte - change.len() + replacement.len())
			} else if byte <= change.start + shared_prefix {
				Some(byte)
			} else {
				let point = self.point_at(byte);
				unchanged
					.iter()
					.find(|(old, _)| *old == point.row)
					.and_then(|(_, new)| {
						replacement_starts
							.get(*new)
							.map(|start| (start, if *new == 0 { first_column } else { 0 }))
					})
					.and_then(|(start, prefix)| {
						point
							.column
							.checked_sub(prefix)
							.map(|column| change.start + start + column)
					})
			}
		};
		// A changed row may still prove a construct's opening position.
		// This does not make its whole named node an unchanged successor.
		let row_positions = std::cell::OnceCell::new();
		let position = |byte: usize| {
			shift(byte).or_else(|| {
				let positions = row_positions.get_or_init(|| {
					let old_rows = self.code[change.clone()].split('\n').collect::<Vec<_>>();
					let new_rows = replacement.split('\n').collect::<Vec<_>>();
					rewritten
						.iter()
						.filter_map(|&(old_row, new_row)| {
							let old = *old_rows.get(old_row.checked_sub(change_point.row)?)?;
							let new = *new_rows.get(new_row)?;
							let prefix = old
								.bytes()
								.zip(new.bytes())
								.take_while(|(old, new)| old == new)
								.count();
							let suffix = old.as_bytes()[prefix..]
								.iter()
								.rev()
								.zip(new.as_bytes()[prefix..].iter().rev())
								.take_while(|(old, new)| old == new)
								.count();
							Some((old_row, (new_row, prefix, old.len() - suffix, new.len() - suffix)))
						})
						.collect::<BTreeMap<_, _>>()
				});
				let point = self.point_at(byte);
				let row = point.row - change_point.row;
				let column = point
					.column
					.checked_sub(if row == 0 { first_column } else { 0 })?;
				let &(new_row, prefix, old_suffix, new_suffix) = positions.get(&point.row)?;
				let column = if column <= prefix {
					column
				} else if column >= old_suffix {
					new_suffix + column - old_suffix
				} else {
					return None;
				};
				Some(change.start + replacement_starts[new_row] + column)
			})
		};
		fn corresponding<'t>(
			root: Node<'t>,
			original: Node<'_>,
			shift: &impl Fn(usize) -> Option<usize>,
		) -> Option<Node<'t>> {
			let at = shift(original.start_byte())?;
			let mut current = root.descendant_for_byte_range(
				at,
				at + usize::from(original.end_byte() > original.start_byte()),
			);
			while let Some(node) = current {
				if node.kind() == original.kind()
					&& node.start_byte() == at
					&& Some(node.end_byte()) == shift(original.end_byte())
					&& node.byte_range().len() == original.byte_range().len()
				{
					return Some(node);
				}
				current = node.parent();
			}
			None
		}
		let old_root = self.tree.root_node();
		let new_root = tree.root_node();
		let rewritten_node = |original: Node<'_>| {
			if original.start_byte() < change.start
				|| original.end_byte() > change.end
				|| original.start_position().row != content_end_row(original)
			{
				return None;
			}
			let &(old_row, new_row) = rewritten
				.iter()
				.find(|(old, _)| *old == original.start_position().row)?;
			if let Some(at) = position(original.start_byte()) {
				let mut current = new_root.descendant_for_byte_range(at, at + 1);
				while let Some(node) = current {
					if node.kind() == original.kind()
						&& node.start_byte() == at
						&& node.start_position().row == change_point.row + new_row
						&& content_end_row(node) == change_point.row + new_row
					{
						return Some(node);
					}
					current = node.parent();
				}
			}
			// Explicit row pairing also permits a key/value rewrite to
			// change widths. Follow grammar fields (or same-kind child
			// ordinals), not the old column, to the corresponding leaf.
			let mut path = vec![original];
			let mut top = original;
			while let Some(parent) = top.parent().filter(|parent| {
				parent.parent().is_some()
					&& parent.start_position().row == old_row
					&& content_end_row(*parent) == old_row
			}) {
				path.push(parent);
				top = parent;
			}
			let row_at = change.start + replacement_starts[new_row];
			let row_at = source[..row_at].rfind('\n').map_or(0, |at| at + 1);
			let row_end = row_at + source[row_at..].find('\n').unwrap_or(source.len() - row_at);
			let at = row_at + content_column(&source[row_at..row_end])?;
			let mut current = new_root.named_descendant_for_byte_range(at, at + 1);
			let mut mapped = loop {
				let node = current?;
				if node.kind() == top.kind() && node.start_byte() == at {
					break node;
				}
				current = node.parent();
			};
			for old in path.iter().rev().skip(1) {
				mapped = if let Some(field) = field_role(*old) {
					mapped.child_by_field_name(field)?
				} else {
					let mut previous = old.prev_named_sibling();
					let mut ordinal = 0;
					while let Some(node) = previous {
						ordinal += usize::from(node.kind() == old.kind());
						previous = node.prev_named_sibling();
					}
					let mut cursor = mapped.walk();
					mapped
						.named_children(&mut cursor)
						.filter(|node| node.kind() == old.kind())
						.nth(ordinal)?
				};
				if mapped.kind() != old.kind() || mapped.is_extra() {
					return None;
				}
			}
			(mapped.start_position().row == change_point.row + new_row
				&& content_end_row(mapped) == change_point.row + new_row)
				.then_some(mapped)
		};
		let element_start = |node: Node<'_>| {
			let mut at = position(node.start_byte())?;
			loop {
				at += source[at..]
					.chars()
					.take_while(|ch| ch.is_whitespace())
					.map(char::len_utf8)
					.sum::<usize>();
				if at == source.len() {
					return Some(at);
				}
				let mut current = new_root.descendant_for_byte_range(at, at + 1);
				let mut extra = None;
				while let Some(node) = current {
					if node.is_extra() {
						extra = Some(node);
						break;
					}
					current = node.parent();
				}
				let Some(extra) = extra else {
					return Some(at);
				};
				at = extra.end_byte();
			}
		};
		let old_node = old_root
			.named_descendant_for_byte_range(change.start, change.end)
			.unwrap_or(old_root);
		let new_node = new_root
			.named_descendant_for_byte_range(change.start, change.start + replacement.len())
			.unwrap_or(new_root);
		let errors = |node| {
			let (inside, outside) = error_counts(node, 0, usize::MAX);
			inside + outside
		};
		if errors(new_node) > errors(old_node) {
			return SeparatorProof::Rejected;
		}
		// A new inner construct can be healthy while consuming an outer
		// scope's closer. Compare the original scope at its immutable opener,
		// not just whichever new node happens to enclose the changed text.
		if new_root.has_error() {
			let mut scope = old_node.parent().unwrap_or(old_root);
			loop {
				let mapped = if scope.id() == old_root.id() {
					Some(new_root)
				} else if !scope.is_error() && scope.start_byte() < change.start {
					let Some(at) = shift(scope.start_byte()) else {
						return SeparatorProof::Rejected;
					};
					let mut current = new_root.named_descendant_for_byte_range(at, at + 1);
					let mut mapped = None;
					while let Some(node) = current {
						if node.kind() == scope.kind() && node.start_byte() == at {
							mapped = Some(node);
							break;
						}
						current = node.parent();
					}
					if mapped.is_none() {
						return SeparatorProof::Rejected;
					}
					mapped
				} else {
					None
				};
				if let Some(mapped) = mapped {
					if (scope.id() != old_node.id() || mapped.id() != new_node.id())
						&& errors(mapped) > errors(scope)
					{
						return SeparatorProof::Rejected;
					}
					break;
				}
				scope = scope.parent().unwrap_or(old_root);
			}
		}
		// The JSON grammar accepts comment extras that strict JSON does not.
		// Copied comments are neutral, but this proof cannot introduce them.
		if self.language == SupportLang::Json {
			let mut cursor = new_root.walk();
			loop {
				let node = cursor.node();
				if node.end_byte() > change.start
					&& node.start_byte() < change.start + replacement.len()
				{
					if node.is_extra() {
						let last = node
							.end_position()
							.row
							.saturating_sub(usize::from(node.end_position().column == 0));
						if !(node.start_position().row..=last).all(|row| {
							row.checked_sub(change_point.row).is_some_and(|row| {
								unchanged
									.binary_search_by_key(&row, |&(_, new)| new)
									.is_ok()
							})
						}) {
							return SeparatorProof::Rejected;
						}
					}
					if cursor.goto_first_child() {
						continue;
					}
				}
				while !cursor.goto_next_sibling() {
					if !cursor.goto_parent() {
						break;
					}
				}
				if cursor.node().id() == new_root.id() {
					break;
				}
			}
		}
		let mut checked_owners = BTreeSet::new();
		let trivial = std::cell::OnceCell::new();
		fn value(mut node: Node<'_>) -> Node<'_> {
			while let Some(inner) = node.child_by_field_name("value") {
				node = inner;
			}
			node
		}
		// Quoted property labels are code names. Bounded comment extras cannot
		// consume another row; value literals and multiline comments still can.
		fn code_only(text: &str) -> bool {
			text.bytes().all(|byte| {
				byte.is_ascii_alphanumeric()
					|| byte.is_ascii_whitespace()
					|| b"_=:.,;+-*&|(){}".contains(&byte)
			})
		}
		fn trivial_code(
			root: Node<'_>,
			code: &str,
			range: Range<usize>,
			first_row: usize,
			unchanged: &[(usize, usize)],
		) -> bool {
			let mut cursor = root.walk();
			let mut at = range.start;
			loop {
				let node = cursor.node();
				if node.end_byte() > range.start && node.start_byte() < range.end {
					let stable = node.start_position().row == node.end_position().row
						&& unchanged
							.binary_search_by_key(
								&node.start_position().row.saturating_sub(first_row),
								|&(_, new)| new,
							)
							.is_ok();
					let label = node.kind() == "string"
						&& node
							.parent()
							.and_then(|parent| parent.child_by_field_name("key"))
							.is_some_and(|key| key.id() == node.id())
						&& code[node.byte_range()]
							.strip_prefix('"')
							.and_then(|text| text.strip_suffix('"'))
							.is_some_and(|text| {
								text
									.bytes()
									.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
							});
					let bounded_comment = node.is_extra()
						&& node.kind().contains("comment")
						&& node_start_line(node) == node_content_end_line(node);
					if !stable && !label && !bounded_comment {
						if node.is_extra() && !node.is_error() {
							return false;
						}
						if cursor.goto_first_child() {
							continue;
						}
					}
					let begin = node.start_byte().max(at).min(range.end);
					let end = node.end_byte().min(range.end);
					if !code_only(&code[at..begin])
						|| (!stable && !label && !bounded_comment && !code_only(&code[begin..end]))
					{
						return false;
					}
					at = end.max(at);
				}
				while !cursor.goto_next_sibling() {
					if !cursor.goto_parent() {
						return code_only(&code[at..range.end]);
					}
				}
			}
		}
		fn real_separator(node: Node<'_>, kind: &str) -> bool {
			!node.is_named()
				&& !node.is_missing()
				&& node.end_byte() > node.start_byte()
				&& node.kind() == kind
		}
		let mut trivial_only = false;
		let mut payload_proofs = HashMap::new();
		for &(row, column) in separators {
			let Some(byte) = self.line_starts.get(row).map(|start| start + column) else {
				return SeparatorProof::Rejected;
			};
			// Encoded source-unit bytes are not native separators. The complete
			// retained-unit proof above has already preserved their correspondence.
			if old_roles.unit_at(byte).is_some() {
				continue;
			}
			if role_at(old_roles, byte) == LexicalRole::Comment
				&& position(byte).is_some_and(|mapped| {
					role_at(new_roles, mapped) == LexicalRole::Comment
						&& source.as_bytes().get(mapped) == self.code.as_bytes().get(byte)
				}) {
				continue;
			}
			if let Some(frame) =
				frame_at(self.frames(), byte, false).filter(|frame| frame.language.is_some())
			{
				let proof = *payload_proofs.entry(frame.range.start).or_insert_with(|| {
					let Some(start) = position(frame.range.start) else {
						return SeparatorProof::Rejected;
					};
					let Some(end) = position(frame.range.end) else {
						return SeparatorProof::Rejected;
					};
					let Some(next) = frame_at(frames, start, false).filter(|next| {
						next.range == (start..end)
							&& next.language == frame.language
							&& next.kind == frame.kind
							&& !next.unknown()
					}) else {
						return SeparatorProof::Rejected;
					};
					frame
						.with_index(self.code, |index| {
							let local_separators: Vec<_> = separators
								.iter()
								.filter_map(|&(row, column)| {
									let at = frame.payload_byte(*self.line_starts.get(row)? + column)?;
									let point = index.point_at(at);
									Some((point.row, point.column))
								})
								.collect();
							let mut local_unchanged = Vec::new();
							let mut local_rewritten = Vec::new();
							for (row, &at) in frame.line_starts.iter().enumerate() {
								if at == frame.text(self.code).len() {
									continue;
								}
								let Some(original) = frame.source_byte(at, false) else {
									return SeparatorProof::Rejected;
								};
								let Some(mapped) = position(original).and_then(|at| next.payload_byte(at))
								else {
									return SeparatorProof::Rejected;
								};
								let new_row = next
									.line_starts
									.partition_point(|at| *at <= mapped)
									.saturating_sub(1);
								if next.line_starts[new_row] != mapped {
									return SeparatorProof::Rejected;
								}
								let old_end = frame
									.line_starts
									.get(row + 1)
									.copied()
									.unwrap_or_else(|| frame.text(self.code).len());
								let new_end = next
									.line_starts
									.get(new_row + 1)
									.copied()
									.unwrap_or_else(|| next.text(source).len());
								if frame.text(self.code)[at..old_end] == next.text(source)[mapped..new_end]
								{
									local_unchanged.push((row, new_row));
								} else {
									let source_row = self.point_at(original).row;
									if rewritten.iter().any(|&(old, _)| old == source_row) {
										local_rewritten.push((row, new_row));
									}
								}
							}
							index.checked_separator_view(
								SeparatorSnapshot {
									source:              next.text(source),
									tree:                next.tree.as_ref().unwrap(),
									change:              0..index.code.len(),
									replacement_end:     next.text(source).len(),
									new_roles:           next.roles(source),
									independent_unknown: &[],
									frames:              &[],
								},
								&local_separators,
								&local_unchanged,
								&local_rewritten,
							)
						})
						.unwrap_or(SeparatorProof::Rejected)
				});
				match proof {
					SeparatorProof::Rejected => return proof,
					SeparatorProof::TrivialOnly => trivial_only = true,
					SeparatorProof::Preserved => {},
				}
				continue;
			}
			let Some(token) = old_root.descendant_for_byte_range(byte, byte + 1) else {
				return SeparatorProof::Rejected;
			};
			if !matches!(token.kind(), "," | ";") || !real_separator(token, token.kind()) {
				if token.is_named()
					&& token.child_count() == 0
					&& let Some(now) = rewritten_node(token)
				{
					let end = byte
						+ self.code[byte..token.end_byte()]
							.bytes()
							.take_while(|byte| matches!(byte, b',' | b';'))
							.count();
					let run = &self.code[byte..end];
					let role = role_at(old_roles, byte);
					let ordinal = self.code[token.start_byte()..byte]
						.match_indices(run)
						.filter(|(at, _)| role_at(old_roles, token.start_byte() + at) == role)
						.count();
					let mapped = source[now.byte_range()]
						.match_indices(run)
						.map(|(at, _)| now.start_byte() + at)
						.filter(|at| {
							(LexicalView { roles: old_roles, source: self.code }).equivalent_at(
								byte,
								LexicalView { roles: new_roles, source },
								*at,
							)
						})
						.nth(ordinal);
					let kept = mapped.is_some_and(|at| {
						!token.is_extra()
							|| (is_comment(token)
								&& node_start_line(token) == node_content_end_line(token)
								&& code_only(&source[now.start_byte()..at + run.len()]))
					});
					if kept {
						continue;
					}
				}
				if token.is_extra()
					&& is_comment(token)
					&& node_start_line(token) == node_content_end_line(token)
					&& let Some(&(old_row, new_row)) = rewritten.iter().find(|&&(old, _)| old == row)
				{
					let start = self.line_starts[old_row];
					let end = start
						+ self.code[start..]
							.find('\n')
							.unwrap_or(self.code.len() - start);
					let complete = change.end >= end
						&& (change.start <= start
							|| (change.start <= end && self.code[start..change.start].trim().is_empty()));
					if complete {
						let new_at = change.start + replacement_starts[new_row];
						let new_start = source[..new_at].rfind('\n').map_or(0, |at| at + 1);
						let new_end = new_start
							+ source[new_start..]
								.find('\n')
								.unwrap_or(source.len() - new_start);
						let run = &self.code[byte..=byte];
						let role = role_at(old_roles, byte);
						let ordinal = self.code[start..byte]
							.match_indices(run)
							.filter(|(at, _)| role_at(old_roles, start + at) == role)
							.count();
						let mapped = source[new_start..new_end]
							.match_indices(run)
							.map(|(at, _)| new_start + at)
							.filter(|at| {
								(LexicalView { roles: old_roles, source: self.code }).equivalent_at(
									byte,
									LexicalView { roles: new_roles, source },
									*at,
								)
							})
							.nth(ordinal);
						if let Some(mapped) = mapped {
							let old_prefix = &self.code[start..=byte];
							let new_prefix = &source[new_start..=mapped];
							let depth = |text: &str| {
								text.bytes().fold(0_i32, |depth, byte| {
									depth
										+ match byte {
											b'(' | b'{' => 1,
											b')' | b'}' => -1,
											_ => 0,
										}
								})
							};
							if code_only(old_prefix)
								&& code_only(new_prefix)
								&& depth(old_prefix) == depth(new_prefix)
							{
								continue;
							}
						}
					}
				}
				if token.is_extra()
					&& token.kind().contains("comment")
					&& node_start_line(token) == node_content_end_line(token)
					&& *trivial.get_or_init(|| {
						trivial_code(
							new_root,
							source,
							change.start..change.start + replacement.len(),
							change_point.row,
							unchanged,
						)
					}) {
					trivial_only = true;
					continue;
				}
				return SeparatorProof::Rejected;
			}
			let Some(parent) = token.parent() else {
				return SeparatorProof::Rejected;
			};
			let next = sibling_after(token, |node| !node.is_extra());
			let Some(next) = next else {
				// A semicolon may terminate a declaration rather than be a
				// sibling separator. Its declaration must retain that token.
				if token.kind() != ";" {
					return SeparatorProof::Rejected;
				}
				let Some(at) = element_start(parent) else {
					return SeparatorProof::Rejected;
				};
				let mut current = new_root.named_descendant_for_byte_range(at, at + 1);
				let mut retained = None;
				while let Some(node) = current {
					if node.kind() == parent.kind() && node.start_byte() == at {
						let mut tail = node;
						while let Some(child) = tail.child(tail.child_count().saturating_sub(1)) {
							tail = child;
						}
						if real_separator(tail, ";") {
							retained = Some(node);
						}
						break;
					}
					current = node.parent();
				}
				let Some(retained) = retained else {
					return SeparatorProof::Rejected;
				};
				let successor = sibling_after(parent, |node| !node.is_extra());
				if let Some(successor) = successor {
					let Some(now) =
						corresponding(new_root, successor, &shift).or_else(|| rewritten_node(successor))
					else {
						return SeparatorProof::Rejected;
					};
					if now.parent().map(|node| node.id()) != retained.parent().map(|node| node.id()) {
						return SeparatorProof::Rejected;
					}
					if now.start_byte() < retained.end_byte() {
						return SeparatorProof::Rejected;
					}
				}
				continue;
			};
			let Some(owner_at) = position(parent.start_byte()) else {
				return SeparatorProof::Rejected;
			};
			let mut current = new_root.named_descendant_for_byte_range(owner_at, owner_at + 1);
			let mut owner = None;
			while let Some(node) = current {
				if node.kind() == parent.kind() && node.start_byte() == owner_at {
					owner = Some(node);
					break;
				}
				current = node.parent();
			}
			let Some(owner) = owner else {
				return SeparatorProof::Rejected;
			};
			// Every changed child must retain its value boundary, not just the
			// first one at the original element's start.
			if checked_owners.insert(owner.id()) {
				let mut old_values = None;
				let mut cursor = owner.walk();
				for child in owner.named_children(&mut cursor) {
					if child.is_extra()
						|| child.end_byte() <= change.start
						|| child.start_byte() >= change.start + replacement.len()
					{
						continue;
					}
					let last = child
						.end_position()
						.row
						.saturating_sub(usize::from(child.end_position().column == 0));
					let stable = (child.start_position().row..=last).all(|row| {
						row.checked_sub(change_point.row).is_some_and(|row| {
							unchanged
								.binary_search_by_key(&row, |&(_, new)| new)
								.is_ok()
						})
					});
					if stable {
						continue;
					}
					if Self::captures_initializer_row(owner, child, new_root, source) {
						return SeparatorProof::Rejected;
					}
					let new_value = value(child);
					if new_value.kind().contains("concatenat") {
						let values = old_values.get_or_insert_with(|| {
							let mut old_cursor = parent.walk();
							parent
								.named_children(&mut old_cursor)
								.filter_map(|old| {
									let old_value = value(old);
									element_start(old)
										.map(|at| (at, (old_value.kind(), old_value.named_child_count())))
								})
								.collect::<BTreeMap<_, _>>()
						});
						if values.get(&child.start_byte())
							!= Some(&(new_value.kind(), new_value.named_child_count()))
						{
							return SeparatorProof::Rejected;
						}
					}
				}
			}
			// The rewritten first element must retain its own separator.
			// Explicit new siblings may follow it; they cannot supply that
			// missing boundary or implicitly merge with a literal element.
			let old_element = sibling_before(token, |node| node.is_named() && !node.is_extra());
			if let Some(old) = old_element {
				let Some(at) = element_start(old) else {
					return SeparatorProof::Rejected;
				};
				let mut current = new_root.named_descendant_for_byte_range(at, at + 1);
				let mut first = None;
				while let Some(node) = current {
					if node.parent().is_some_and(|node| node.id() == owner.id()) {
						if node.start_byte() == at {
							first = Some(node);
						}
						break;
					}
					current = node.parent();
				}
				let Some(first) = first else {
					return SeparatorProof::Rejected;
				};
				let following = sibling_after(first, |node| !node.is_extra());
				if following.is_none_or(|node| !real_separator(node, token.kind()))
					|| (old.kind().contains("string") && first.kind().contains("concatenat"))
				{
					return SeparatorProof::Rejected;
				}
			}
			let Some(now) = corresponding(new_root, next, &shift).or_else(|| rewritten_node(next))
			else {
				return SeparatorProof::Rejected;
			};
			if now.parent().is_none_or(|node| node.id() != owner.id()) {
				return SeparatorProof::Rejected;
			}
			let previous = sibling_before(now, |node| !node.is_extra());
			if previous.is_none_or(|node| !real_separator(node, token.kind())) {
				return SeparatorProof::Rejected;
			}
			let before_separator =
				previous.and_then(|node| sibling_before(node, |node| !node.is_extra()));
			if before_separator.is_none_or(|node| !node.is_named()) {
				return SeparatorProof::Rejected;
			}
		}
		if trivial_only {
			SeparatorProof::TrivialOnly
		} else {
			SeparatorProof::Preserved
		}
	}

	/// A designator-looking row in an initializer cannot implicitly become
	/// the left side of a value assignment begun on a prior row. A parsed
	/// body or delimited container establishes its own continuation scope.
	fn captures_initializer_row(
		parent: Node<'_>,
		new: Node<'_>,
		root: Node<'_>,
		source: &str,
	) -> bool {
		if parent.kind() != "initializer_list" {
			return false;
		}
		let mut start = new.start_byte();
		for (row, line) in source[new.byte_range()].split_inclusive('\n').enumerate() {
			let end = start + line.len();
			let row_start = start;
			let mut at = start + line.len() - line.trim_start().len();
			start = end;
			if row == 0 {
				continue;
			}
			let mut current = None;
			while at < end {
				current = root.descendant_for_byte_range(at, at + 1);
				let Some(extra) = current.filter(|node| node.is_extra() && node.end_byte() > at) else {
					break;
				};
				at = extra.end_byte();
				if at < end {
					at += source[at..end]
						.chars()
						.take_while(|ch| ch.is_whitespace())
						.map(char::len_utf8)
						.sum::<usize>();
				}
			}
			if at >= end
				|| current.is_none_or(|node| node.is_named() || !matches!(node.kind(), "." | "["))
			{
				continue;
			}
			let (mut captured, mut contained) = (false, false);
			while let Some(node) = current.filter(|node| node.id() != parent.id()) {
				// The designator's own brackets do not establish an earlier
				// continuation scope (e.g. a subscript_argument_list).
				contained |= node.start_byte() < row_start
					&& (is_body(node)
						|| node.parent().is_some_and(|parent| {
							body_of(parent).is_some_and(|body| body.id() == node.id())
						}) || matches!(
						(
							node.child(0).map(|node| node.kind()),
							node
								.child(node.child_count().saturating_sub(1))
								.map(|node| node.kind())
						),
						(Some("("), Some(")")) | (Some("["), Some("]")) | (Some("{"), Some("}"))
					));
				if node.kind() == "assignment_expression"
					&& node
						.child_by_field_name("left")
						.is_some_and(|left| left.start_byte() < row_start && left.end_byte() > at)
				{
					let mut cursor = node.walk();
					captured |= node
						.children(&mut cursor)
						.any(|child| !child.is_named() && child.kind() == "=");
				}
				current = node.parent();
			}
			if captured && !contained {
				return true;
			}
		}
		false
	}

	fn reparse(&self, change: Range<usize>, replacement: &str) -> Result<(String, Tree)> {
		let mut source = String::with_capacity(self.code.len() - change.len() + replacement.len());
		source.push_str(&self.code[..change.start]);
		source.push_str(replacement);
		source.push_str(&self.code[change.end..]);
		let start = self.point_at(change.start);
		let newlines = replacement.matches('\n').count();
		let tail = replacement.rsplit('\n').next().unwrap_or_default().len();
		let new_end = if newlines == 0 {
			Point::new(start.row, start.column + tail)
		} else {
			Point::new(start.row + newlines, tail)
		};
		let mut previous = self.tree.as_ref().clone();
		previous.edit(&InputEdit {
			start_byte:       change.start,
			old_end_byte:     change.end,
			new_end_byte:     change.start + replacement.len(),
			start_position:   start,
			old_end_position: self.point_at(change.end),
			new_end_position: new_end,
		});
		let mut parser = Parser::new();
		parser
			.set_language(&self.language.get_ts_language())
			.map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;
		let tree = parser
			.parse(&source, Some(&previous))
			.ok_or_else(|| anyhow!("tree-sitter produced no tree"))?;
		Ok((source, tree))
	}

	/// The certain syntax region opened at or after the matched anchor's byte
	/// position on `line`. Trivia and closing tokens do not open constructs.
	pub fn scope_range(&self, line: u32, column: usize, last_column: usize) -> Option<BlockRange> {
		let first = self.scope_evidence(line, column)?;
		let last = self.scope_evidence(line, last_column)?;
		(first.certain
			&& last.certain
			&& !first.host_domain
			&& !last.host_domain
			&& first.owner == last.owner)
			.then_some(first.range)
	}

	/// An internal payload without a grammar/mapping cannot authorize an anchor.
	pub fn unsupported_payload_anchor(&self, line: u32, column: usize) -> bool {
		let row = (line as usize).saturating_sub(1);
		let Some(start) = self.line_starts.get(row) else {
			return false;
		};
		let at = start + column;
		let mut node = self
			.tree
			.root_node()
			.named_descendant_for_byte_range(at, at);
		while let Some(candidate) = node {
			if candidate.kind() == "fenced_code_block"
				&& candidate.start_position().row < row
				&& row < candidate.end_position().row
			{
				return true;
			}
			node = candidate.parent();
		}
		frame_at(self.frames(), start + column, false).is_some_and(|frame| {
			!frame.data
				&& (frame.language.is_none()
					|| frame.unresolved.is_some()
					|| frame.payload_byte(start + column).is_none())
		})
	}

	/// Recover one source occurrence, without treating recovery errors as
	/// certainty.
	pub fn scope_evidence(&self, line: u32, column: usize) -> Option<ScopeEvidence> {
		self.checked_scope_evidence(line, column).ok().flatten()
	}

	/// Unlike absence, failed structural resolution cannot authorize a cursor.
	pub fn checked_scope_evidence(&self, line: u32, column: usize) -> Result<Option<ScopeEvidence>> {
		let mut resolution = ScopeResolution::default();
		let proof = self.resolve_scope(line, column, &mut resolution);
		if resolution.failed {
			return Err(anyhow!(if resolution.too_deep {
				DEPTH_REFUSAL
			} else {
				"the anchor's structural scope is unprovable"
			}));
		}
		Ok(proof)
	}

	/// A header occurrence must name parsed code or a structural data key,
	/// rather than a mention of that header inside a comment or literal.
	pub fn checked_scope_occurrence(
		&self,
		line: u32,
		mut column: usize,
		whole_header: bool,
		allow_data_key: bool,
	) -> Result<Option<(ScopeEvidence, usize)>> {
		let row = (line as usize)
			.checked_sub(1)
			.ok_or_else(|| anyhow!("invalid anchor row"))?;
		let mut at = self
			.line_starts
			.get(row)
			.and_then(|start| start.checked_add(column))
			.ok_or_else(|| anyhow!("invalid anchor occurrence"))?;
		let roles = self
			.role_spans()
			.ok_or_else(|| anyhow!("the anchor's lexical role is unprovable"))?;
		let next = roles.partition_point(|(range, _)| range.end <= at);
		let mut role = roles
			.get(next)
			.filter(|(range, _)| range.contains(&at))
			.map_or(LexicalRole::Code, |(_, role)| *role);
		if whole_header && role == LexicalRole::Comment {
			let end = self
				.line_starts
				.get(row + 1)
				.copied()
				.unwrap_or(self.code.len());
			let mut candidate = at;
			while candidate < end {
				let next = roles.partition_point(|(range, _)| range.end <= candidate);
				let span = roles
					.get(next)
					.filter(|(range, _)| range.contains(&candidate));
				let candidate_role = span.map_or(LexicalRole::Code, |(_, role)| *role);
				if candidate_role == LexicalRole::Comment {
					candidate = span.unwrap().0.end.min(end);
				} else if candidate_role == LexicalRole::Code
					&& let Some(ch) = self.code[candidate..end]
						.chars()
						.next()
						.filter(|ch| ch.is_whitespace())
				{
					candidate += ch.len_utf8();
				} else if candidate_role == LexicalRole::Code {
					at = candidate;
					column = at - self.line_starts[row];
					role = candidate_role;
					break;
				} else {
					break;
				}
			}
		}
		if !allow_data_key && (role != LexicalRole::Code || roles.code_at(at).is_none()) {
			return Ok(None);
		}
		let proof = self.checked_scope_evidence(line, column)?;
		if role == LexicalRole::Code {
			let case = if let Some(frame) = frame_at(self.frames(), at, false) {
				let byte = frame.payload_byte(at);
				let local_row = byte.map(|byte| {
					frame
						.line_starts
						.partition_point(|start| *start <= byte)
						.saturating_sub(1)
				});
				frame.tree.as_ref().zip(byte).and_then(|(tree, byte)| {
					tree
						.root_node()
						.named_descendant_for_byte_range(byte, byte + 1)
						.and_then(native_case_owner)
						.filter(|node| Some(node.start_position().row) == local_row)
						.map(|node| {
							let end = frame
								.line_starts
								.get(content_end_row(node))
								.and_then(|byte| frame.source_byte(*byte, false))
								.map(|byte| row_to_line(self.point_at(byte).row));
							(node.has_error() || node.is_missing(), end, ScopeOwner {
								frame: frame.range.start + 1,
								node:  node.id(),
							})
						})
				})
			} else {
				self
					.tree
					.root_node()
					.named_descendant_for_byte_range(at, at + 1)
					.and_then(native_case_owner)
					.filter(|node| node.start_position().row == row)
					.map(|node| {
						(
							node.has_error() || node.is_missing(),
							Some(row_to_line(content_end_row(node))),
							ScopeOwner { frame: 0, node: node.id() },
						)
					})
			};
			if let Some((uncertain, end, owner)) = case
				&& (uncertain
					|| end.is_none()
					|| proof.is_none_or(|proof| {
						!proof.certain
							|| proof.host_domain
							|| proof.owner != owner
							|| end.is_none_or(|end| proof.range.end_line > end)
					})) {
				return Err(anyhow!(
					"the native case section has no certain scope; add explicit context inside the \
					 intended case"
				));
			}
		}
		if role == LexicalRole::Code || proof.is_none_or(|proof| proof.host_domain) && whole_header {
			return Ok(proof.map(|proof| (proof, column)));
		}
		let mut node = if let Some(frame) =
			frame_at(self.frames(), at, false).filter(|frame| frame.language.is_some())
		{
			let byte = frame
				.payload_byte(at)
				.ok_or_else(|| anyhow!("the anchor key has no certain payload mapping"))?;
			frame
				.tree
				.as_ref()
				.and_then(|tree| tree.root_node().named_descendant_for_byte_range(byte, byte))
		} else {
			self
				.tree
				.root_node()
				.named_descendant_for_byte_range(at, at)
		};
		while let Some(candidate) = node {
			if field_role(candidate) == Some("key")
				|| matches!(candidate.kind(), "key" | "bare_key" | "quoted_key" | "dotted_key")
			{
				return Ok(proof.map(|proof| (proof, column)));
			}
			node = candidate.parent();
		}
		Err(anyhow!("the anchor occurrence is a literal or comment mention, not a construct header"))
	}

	/// Veto-only identifying-code evidence for an already selected fuzzy
	/// construct. `None` is reserved for separately certified structural keys.
	pub fn scope_header_code(
		&self,
		line: u32,
		column: usize,
		proof: ScopeEvidence,
	) -> Result<Option<String>> {
		let row = line.saturating_sub(1) as usize;
		let start = *self
			.line_starts
			.get(row)
			.ok_or_else(|| anyhow!("invalid header row"))?;
		let at = start + column;
		if let Some(frame) = frame_at(self.frames(), at, false) {
			let byte = frame
				.payload_byte(at)
				.ok_or_else(|| anyhow!("the fuzzy header has no certain payload mapping"))?;
			let local_row = frame
				.line_starts
				.partition_point(|start| *start <= byte)
				.saturating_sub(1);
			return frame
				.with_index(self.code, |index| {
					index.scope_header_code(
						row_to_line(local_row),
						byte - frame.line_starts[local_row],
						proof,
					)
				})
				.ok_or_else(|| anyhow!("the fuzzy header has no native payload proof"))?;
		}
		let roles = self
			.role_spans()
			.ok_or_else(|| anyhow!("the fuzzy header's lexical roles are unprovable"))?;
		let root = self.tree.root_node();
		if roles.code_at(at).is_none() {
			let mut key = root.named_descendant_for_byte_range(at, at);
			while let Some(node) = key {
				if field_role(node) == Some("key")
					|| matches!(node.kind(), "key" | "bare_key" | "quoted_key" | "dotted_key")
				{
					return Ok(None);
				}
				key = node.parent();
			}
		}
		let mut cursor = root.walk();
		let owner = loop {
			let node = cursor.node();
			if node.id() == proof.owner.node {
				break node;
			}
			if node.start_position().row <= row
				&& content_end_row(node) >= row
				&& cursor.goto_first_child()
			{
				continue;
			}
			loop {
				if cursor.goto_next_sibling() {
					break;
				}
				if !cursor.goto_parent() {
					return Err(anyhow!("the fuzzy header's selected owner is unprovable"));
				}
			}
		};
		let mut end = self
			.line_starts
			.get(row + 1)
			.copied()
			.unwrap_or(self.code.len())
			.min(owner.end_byte());
		if let Some(body) = body_of(owner) {
			let boundary = body
				.child(0)
				.filter(|token| !token.is_named() && BODY_OPENERS.contains(&token.kind()))
				.map_or_else(|| body.start_byte(), |token| token.end_byte());
			end = end.min(boundary);
		}
		let begin = start.max(owner.start_byte());
		if begin >= end {
			return Err(anyhow!("the fuzzy construct has no certain header code on its anchor row"));
		}
		let mut projection = String::with_capacity(end.saturating_sub(begin));
		for (offset, ch) in self.code[begin..end].char_indices() {
			let at = begin + offset;
			if role_at(roles, at) == LexicalRole::Code
				&& (ch.is_whitespace() || roles.code_at(at).is_some())
			{
				projection.push(ch);
			} else {
				projection.push(' ');
			}
		}
		Ok(Some(projection))
	}

	fn resolve_scope(
		&self,
		line: u32,
		column: usize,
		resolution: &mut ScopeResolution,
	) -> Option<ScopeEvidence> {
		let row = (line as usize).checked_sub(1)?;
		let position = self.line_starts.get(row)?.checked_add(column)?;
		let key = (self.tree.root_node().id(), position);
		if resolution.active.len() >= PROOF_DEPTH || !resolution.active.insert(key) {
			resolution.failed = true;
			resolution.too_deep |= resolution.active.len() >= PROOF_DEPTH;
			return None;
		}
		let proof = self.scope_evidence_inner(line, column, resolution);
		resolution.active.remove(&key);
		proof
	}

	fn scope_evidence_inner(
		&self,
		line: u32,
		column: usize,
		resolution: &mut ScopeResolution,
	) -> Option<ScopeEvidence> {
		let row = (line as usize).checked_sub(1)?;
		let position = self.line_starts.get(row)?.checked_add(column)?;
		if let Some(frame) = frame_at(self.frames(), position, false) {
			if frame.kind == FrameKind::Macro {
				resolution.failed = true;
				return None;
			}
			let Some(byte) = frame.payload_byte(position) else {
				resolution.failed = true;
				return None;
			};
			if frame.data && frame.language.is_none() {
				let end = self.point_at(frame.range.end);
				return Some(ScopeEvidence {
					range:         BlockRange {
						start_line: line,
						end_line:   (end.row + usize::from(end.column > 0)) as u32,
					},
					owner:         ScopeOwner {
						frame: frame.range.start + 1,
						node:  self.tree.root_node().id(),
					},
					certain:       true,
					host_domain:   true,
					owned_end_gap: end.column == 0,
				});
			}
			let payload_row = frame
				.line_starts
				.partition_point(|start| *start <= byte)
				.saturating_sub(1);
			let queried = frame.with_index(self.code, |index| {
				index.resolve_scope(
					row_to_line(payload_row),
					byte - frame.line_starts[payload_row],
					resolution,
				)
			});
			let Some(proof) = queried else {
				resolution.failed = true;
				return None;
			};
			let Some(mut proof) = proof else {
				if resolution.failed
					|| frame
						.tree
						.as_ref()
						.is_none_or(|tree| tree.root_node().has_error())
				{
					resolution.failed = true;
					return None;
				}
				let end = self.point_at(frame.envelope.end);
				return Some(ScopeEvidence {
					range:         BlockRange {
						start_line: line,
						end_line:   (end.row + usize::from(end.column > 0)) as u32,
					},
					owner:         ScopeOwner {
						frame: frame.range.start + 1,
						node:  frame.tree.as_ref()?.root_node().id(),
					},
					certain:       true,
					host_domain:   true,
					owned_end_gap: false,
				});
			};
			let mapped_end = frame
				.line_starts
				.get(proof.range.end_line.saturating_sub(1) as usize)
				.and_then(|&last| frame.source_byte(last, false));
			let Some(end) = mapped_end else {
				resolution.failed = true;
				return None;
			};
			if proof.owned_end_gap {
				let next = frame
					.line_starts
					.get(proof.range.end_line as usize)
					.copied()
					.unwrap_or_else(|| frame.text(self.code).len());
				proof.owned_end_gap = frame
					.source_byte(next, true)
					.is_some_and(|at| self.point_at(at).column == 0);
			}
			proof.range.start_line = line;
			proof.range.end_line = row_to_line(self.point_at(end).row);
			proof.owner.frame = frame.range.start + 1;
			return Some(proof);
		}
		let root = self.tree.root_node();
		let mut cursor = root.walk();
		let mut candidate = None;
		let mut label = None;
		let mut containing = None;
		loop {
			let node = cursor.node();
			let starts = node.start_position().row;
			let relevant = starts <= row && content_end_row(node) >= row;
			if relevant
				&& node.id() != root.id()
				&& starts == row
				&& (node.start_byte() >= position || node.end_byte() > position)
				&& node.is_named()
				&& !is_comment(node)
			{
				if node.start_byte() < position
					&& content_end_row(node) > row
					&& !incidental_list(node, self.code, self.language)
					&& !statement_container(node)
					&& !self.placement_sequence(node)
				{
					containing = Some(node);
				}
				if node
					.kind()
					.as_bytes()
					.windows(5)
					.any(|word| word.eq_ignore_ascii_case(b"label"))
				{
					label.get_or_insert(node);
				}
				if node.start_byte() >= position
					&& (is_attribute_like(node)
						|| (content_end_row(node) > row
							&& !incidental_list(node, self.code, self.language)
							&& !statement_container(node)))
					&& !self.placement_sequence(node)
				{
					candidate = Some(node);
					break;
				}
			}
			if relevant
				&& node.is_named()
				&& node.named_child_count() > 0
				&& cursor.goto_first_child_for_byte(position).is_some()
			{
				continue;
			}
			loop {
				if cursor.goto_next_sibling() && cursor.node().start_position().row <= row {
					break;
				}
				if !cursor.goto_parent() {
					break;
				}
			}
			if cursor.node().id() == root.id() {
				break;
			}
		}
		if candidate.is_none()
			&& let Some(label) = label
			&& let Some(mut proof) = self.sibling_label_scope(label, resolution)
		{
			proof.range.start_line = line;
			proof.certain &= !label.has_error();
			return Some(proof);
		}
		let top = candidate.or(containing);
		if let Some(candidate) = top {
			if proof_depth(candidate, true, &self.proof_depths)
				+ resolution.active.len().saturating_sub(1)
				> PROOF_DEPTH
			{
				resolution.failed = true;
				resolution.too_deep = true;
				return None;
			}
			if is_case(candidate) && !candidate.has_error() && !candidate.is_missing() {
				return Some(ScopeEvidence {
					range:         self.statement_range(candidate),
					owner:         ScopeOwner { frame: 0, node: candidate.id() },
					certain:       true,
					host_domain:   false,
					owned_end_gap: false,
				});
			}
			if self.language == SupportLang::Fortran && candidate.kind() == "do_loop" {
				let mut children = candidate.walk();
				let children = candidate.named_children(&mut children).collect::<Vec<_>>();
				let opener = children.iter().find(|child| child.kind() == "do_statement");
				let closer = children.last().filter(|child| {
					matches!(child.kind(), "end_do_loop_statement" | "end_do_label_loop_statement")
				});
				if opener.is_some_and(|opener| !opener.has_error() && !opener.is_missing())
					&& closer.is_some_and(|closer| !closer.has_error() && !closer.is_missing())
				{
					return Some(ScopeEvidence {
						range:         self.statement_range(candidate),
						owner:         ScopeOwner { frame: 0, node: candidate.id() },
						certain:       !candidate.has_error() && !candidate.is_missing(),
						host_domain:   false,
						owned_end_gap: false,
					});
				}
			}
			let mut terminal = candidate;
			let mut wrappers = Vec::new();
			loop {
				if let Some(cached) = self.label_targets.borrow().get(&terminal.id()).copied() {
					let Some(mut proof) = cached else {
						resolution.failed = true;
						return None;
					};
					proof.range.start_line = line;
					proof.certain &= !candidate.has_error();
					return Some(proof);
				}
				let mut children = terminal.walk();
				let mut children = terminal
					.named_children(&mut children)
					.filter(|child| !child.is_extra() && !is_comment(*child));
				let Some(first) = children.next() else { break };
				let label = terminal
					.child_by_field_name("label")
					.is_some_and(|label| label.id() == first.id())
					|| matches!(first.kind(), "label" | "statement_label" | "switch_label");
				let metadata = terminal.kind() == "attributed_statement"
					&& is_attribute_like(first)
					&& matches!(
						attribute_owner(first, self.code, self.language, &self.metadata_owners),
						AttributeOwner::NextItem
					);
				if !label && !metadata {
					break;
				}
				let Some(applied) = children.next() else {
					break;
				};
				if children.next().is_some() {
					break;
				}
				if applied.id() == terminal.id()
					|| applied.start_byte() < terminal.start_byte()
					|| applied.end_byte() > terminal.end_byte()
					|| (applied.start_byte() == terminal.start_byte()
						&& applied.end_byte() == terminal.end_byte())
					|| wrappers.contains(&applied.id())
					|| wrappers.len() >= 128
				{
					resolution.failed = true;
					self.label_targets.borrow_mut().insert(candidate.id(), None);
					return None;
				}
				wrappers.push(terminal.id());
				terminal = applied;
			}
			if !wrappers.is_empty() && terminal.id() != candidate.id() {
				let target = terminal.start_position();
				let proof = if statement_container(terminal) {
					Self::closes_its_opener(terminal).then_some(ScopeEvidence {
						range:         self.statement_range(terminal),
						owner:         ScopeOwner { frame: 0, node: terminal.id() },
						certain:       !terminal.has_error() && !terminal.is_missing(),
						host_domain:   false,
						owned_end_gap: false,
					})
				} else {
					self.resolve_scope(row_to_line(target.row), target.column, resolution)
				};
				for wrapper in wrappers {
					self.label_targets.borrow_mut().insert(wrapper, proof);
				}
				let Some(mut proof) = proof else {
					resolution.failed = true;
					return None;
				};
				proof.range.start_line = line;
				proof.certain &= !candidate.has_error();
				return Some(proof);
			}
			let leaf = root
				.named_descendant_for_byte_range(candidate.start_byte(), candidate.start_byte() + 1)?;
			let mut top = if candidate.start_byte() < position {
				candidate
			} else {
				leaf
			};
			while let Some(parent) = top.parent() {
				if parent.id() == root.id()
					|| parent.start_position().row != row
					|| parent.start_byte() < position
					|| is_statement_sequence(parent, top)
					|| incidental_list(parent, self.code, self.language)
					|| self.placement_sequence(parent)
				{
					break;
				}
				top = parent;
			}
			let mut current = Some(leaf);
			while let Some(node) = current {
				if is_attribute_like(node)
					&& !matches!(
						attribute_owner(node, self.code, self.language, &self.metadata_owners),
						AttributeOwner::EnclosingOwner
					) {
					let item = attributed_item(node, self.code, self.language, &self.metadata_owners)?;
					return Self::is_block(item).then(|| ScopeEvidence {
						range:         BlockRange {
							start_line: line,
							end_line:   node_content_end_line(item),
						},
						owner:         ScopeOwner { frame: 0, node: item.id() },
						certain:       !item.has_error(),
						host_domain:   false,
						owned_end_gap: false,
					});
				}
				if node.id() == top.id() {
					break;
				}
				current = node.parent();
			}
			let mut block = Self::is_block(top);
			let candidates = if block {
				&[][..]
			} else {
				self.boundary_nodes(row)
			};
			for candidate in candidates.iter().filter(|candidate| {
				candidate.start >= top.start_byte() && candidate.end <= top.end_byte()
			}) {
				if block {
					break;
				}
				let Some(mut node) =
					root.named_descendant_for_byte_range(candidate.start, candidate.end)
				else {
					continue;
				};
				while node.id() != candidate.id {
					let Some(parent) = node.parent() else {
						break;
					};
					node = parent;
				}
				if node.id() != candidate.id {
					continue;
				}
				if node.is_named()
					&& node.start_position().row == row
					&& content_end_row(node) > row
					&& Self::closes_its_opener(node)
				{
					let closed_row = content_end_row(node);
					let clean_end = closing_tail(node, top);
					let mut closed_receiver = clean_end;
					let mut chained = node.start_byte() == top.start_byte();
					let mut receiver = node;
					if !chained
						&& node.child_by_field_name("body").is_some()
						&& let Some(arguments) =
							node.parent().filter(|parent| parent.kind() == "arguments")
						&& let Some(call) = arguments.parent().filter(|parent| {
							parent.start_byte() == top.start_byte()
								&& parent
									.child_by_field_name("arguments")
									.is_some_and(|args| args.id() == arguments.id())
						}) {
						let mut cursor = arguments.walk();
						let mut children = arguments
							.named_children(&mut cursor)
							.filter(|child| !child.is_extra() && !is_comment(*child));
						if children.next().is_some_and(|child| child.id() == node.id())
							&& children.all(|child| {
								child.start_position().row == closed_row
									&& content_end_row(child) == closed_row
									&& !introduces_body(child)
							}) {
							chained = true;
							receiver = call;
							closed_receiver = closing_tail(node, call);
						}
					}
					while chained && receiver.id() != top.id() {
						let Some(parent) = receiver.parent() else {
							chained = false;
							break;
						};
						if parent.start_byte() != receiver.start_byte()
							|| statement_container(parent)
							|| incidental_list(parent, self.code, self.language)
						{
							chained = false;
							break;
						}
						let field = ["target", "receiver", "object", "function", "callee"]
							.into_iter()
							.any(|field| {
								parent
									.child_by_field_name(field)
									.is_some_and(|child| child.id() == receiver.id())
							});
						let mut cursor = parent.walk();
						let mut children = parent
							.named_children(&mut cursor)
							.filter(|child| !child.is_extra() && !is_comment(*child));
						let first = children.next();
						let mut suffixes = first.is_some_and(|child| child.id() == receiver.id());
						let bounded = |child: Node<'_>| {
							child.id() == receiver.id()
								|| (node_start_line(child) == node_content_end_line(child)
									&& !introduces_body(child))
								|| (closed_receiver && child.start_position().row > closed_row)
						};
						let mut companions = first.is_none_or(bounded);
						for child in children {
							suffixes &= child.id() != receiver.id()
								&& child.kind().split('_').any(|word| word == "suffix");
							companions &= bounded(child);
						}
						chained = (field || suffixes) && companions;
						receiver = parent;
					}
					if chained || clean_end {
						block = true;
						break;
					}
				}
			}
			if block {
				let mut range = self.statement_range(top);
				if self.language == SupportLang::Markdown && top.kind() == "section" {
					range.end_line = row_to_line(self.point_at(top.end_byte().saturating_sub(1)).row);
				}
				range.start_line = line;
				return Some(ScopeEvidence {
					range,
					owner: ScopeOwner { frame: 0, node: top.id() },
					certain: !top.has_error(),
					host_domain: false,
					owned_end_gap: self.language == SupportLang::Markdown && top.kind() == "section",
				});
			}
		}
		let leaf = root.named_descendant_for_byte_range(position, position + 1)?;
		Self::annotated_header(row, leaf).map(|declaration| ScopeEvidence {
			range:         BlockRange {
				start_line: line,
				end_line:   node_content_end_line(declaration),
			},
			owner:         ScopeOwner { frame: 0, node: declaration.id() },
			certain:       !declaration.has_error(),
			host_domain:   false,
			owned_end_gap: false,
		})
	}

	/// PowerShell exposes these tokenless statement wrappers as script blocks,
	/// even when their first source byte is a label rather than a delimiter.
	fn placement_sequence(&self, node: Node<'_>) -> bool {
		if self.language != SupportLang::Powershell
			|| !matches!(node.kind(), "script_block" | "script_block_body")
		{
			return false;
		}
		let mut cursor = node.walk();
		node.children(&mut cursor).all(|child| {
			child.is_named() || child.is_extra() || self.code[child.byte_range()].trim().is_empty()
		})
	}

	/// Some grammars absorb whitespace on the next row into a statement.
	/// Only rows carrying the statement's own bytes may be certified.
	fn statement_range(&self, node: Node<'_>) -> BlockRange {
		let content = self.code[node.start_byte()..node.end_byte()].trim_end();
		let trimmed_end = node.start_byte() + content.len();
		let mut end = trimmed_end;
		let mut stack = vec![node];
		// YAML's scalar scanner ends at its last nonblank token; following
		// empty rows still belong to the scalar value.
		let mut scalar_end = None;
		while let Some(part) = stack.pop() {
			if part.is_extra() || part.end_byte() < trimmed_end {
				continue;
			}
			if part.kind() == "block_scalar" && part.end_byte() == node.end_byte() {
				scalar_end = Some(content_end_row(part) + 1);
			}
			if part.is_named()
				&& (part.child_count() == 0 || part.kind() == "block_scalar")
				&& !self.code[part.byte_range()].trim().is_empty()
			{
				end = end.max(part.end_byte());
			} else {
				let mut cursor = part.walk();
				stack.extend(part.children(&mut cursor));
			}
		}
		if let Some(mut row) = scalar_end {
			while self
				.line_starts
				.get(row)
				.is_some_and(|start| *start < self.code.len())
				&& self
					.row_text(row)
					.is_some_and(|text| text.trim().is_empty())
			{
				end = self
					.line_starts
					.get(row + 1)
					.copied()
					.unwrap_or(self.code.len());
				row += 1;
			}
		}
		BlockRange {
			start_line: row_to_line(node.start_position().row),
			end_line:   row_to_line(self.point_at(end.saturating_sub(1)).row),
		}
	}

	/// The declaration whose header proper begins on 0-based `row` after
	/// attributes, decorators or annotated modifiers on earlier rows: the
	/// first node from `leaf` up beginning before `row` that is no modifier
	/// list, when it is an error-free block whose header is on `row`.
	fn annotated_header(row: usize, leaf: Node<'_>) -> Option<Node<'_>> {
		let mut declaration = leaf;
		while declaration.start_position().row == row
			|| matches!(declaration.kind(), "modifiers" | "attributes")
		{
			declaration = declaration.parent()?;
		}
		(declaration.parent().is_some()
			&& header_row(declaration) == row
			&& !attributes_of(declaration).is_empty()
			&& !declaration.has_error()
			&& content_end_row(declaration) > row
			&& Self::is_block(declaration))
		.then_some(declaration)
	}

	/// The attribute, decorator or annotation the anchor row opens: the node
	/// `block_node` resolves, or a node of the chain below it beginning on the
	/// row's first column (a PHP attribute group inside a list counts).
	fn attribute_at<'t>(&'t self, row: usize, top: Node<'t>) -> Option<Node<'t>> {
		if is_attribute_like(top) {
			return Some(top);
		}
		let col = content_column(self.row_text(row)?)?;
		let mut current = self
			.tree
			.root_node()
			.named_descendant_for_point_range(Point::new(row, col), Point::new(row, col + 1));
		while let Some(node) = current.filter(|node| node.start_position().row == row) {
			let grouped = node.kind() == "attribute_group"
				&& node
					.parent()
					.is_some_and(|list| list.kind() == "attribute_list");
			if is_attribute_like(node) || grouped {
				return (node.start_position().column == col).then_some(node);
			}
			if node.id() == top.id() {
				break;
			}
			current = node.parent();
		}
		None
	}

	/// A node holding a body or entries, or closing on its last line what
	/// its first line opens.
	fn is_block(node: Node<'_>) -> bool {
		body_of(node).is_some() || entries_row(node).is_some() || Self::closes_its_opener(node)
	}

	/// Locate the actual final syntax token, ignoring comment extras.
	fn closes_its_opener(node: Node<'_>) -> bool {
		let first = node.start_position().row;
		let last = content_end_row(node);
		if last <= first {
			return false;
		}
		let mut leaf = node;
		loop {
			let mut child = leaf.child(leaf.child_count().saturating_sub(1));
			while child.is_some_and(is_comment) {
				child = child.unwrap().prev_sibling();
			}
			let Some(child) = child else { break };
			leaf = child;
		}
		// A statement may end in a terminator after its construct's closer.
		while matches!(leaf.kind(), ";" | ")" | "]") {
			let Some(previous) = leaf.prev_sibling() else {
				return false;
			};
			leaf = previous;
			loop {
				let mut child = leaf.child(leaf.child_count().saturating_sub(1));
				while child.is_some_and(is_comment) {
					child = child.unwrap().prev_sibling();
				}
				let Some(child) = child else { break };
				leaf = child;
			}
		}
		let Some(parent) = leaf.parent() else {
			return false;
		};
		let on_first = |token: Node<'_>| token.start_position().row == first;
		if !leaf.is_named() && leaf.kind() == "}" {
			let mut cursor = parent.walk();
			return parent
				.children(&mut cursor)
				.any(|child| !child.is_named() && child.kind() == "{" && on_first(child));
		}
		if !leaf.is_named() && CLOSING_KEYWORDS.contains(&leaf.kind()) {
			// The construct the keyword closes is the innermost ancestor ending
			// with it whose first token is a keyword on the anchor row.
			let mut ancestor = Some(parent);
			while let Some(current) = ancestor.filter(|current| {
				current.start_byte() >= node.start_byte() && content_end_row(*current) == last
			}) {
				let mut first_token = current;
				while let Some(child) = first_token.child(0) {
					first_token = child;
				}
				let keyword = !first_token.is_named()
					&& first_token
						.kind()
						.chars()
						.all(|ch| ch.is_ascii_alphabetic());
				if keyword && first_token.id() != leaf.id() && on_first(first_token) {
					return true;
				}
				ancestor = current.parent();
			}
			return false;
		}
		let mut tag = Some(leaf);
		while let Some(current) = tag.filter(|current| current.id() != node.id()) {
			if END_TAGS.contains(&current.kind()) {
				return current
					.parent()
					.and_then(|element| element.named_child(0))
					.is_some_and(|start| {
						START_TAGS.contains(&start.kind()) && start.start_position().row == first
					});
			}
			tag = current.parent();
		}
		false
	}

	/// The construct whose body an insertion below 0-based `row` may belong
	/// to, and the row its body starts on: the block beginning on `row`, the
	/// construct whose header holds `row` without beginning on it (a
	/// signature continuation or a modifier line under an attribute), the
	/// `if` whose `else` begins `row` (its `else` branch is the body then), or
	/// the item the attribute, decorator or annotation on `row` precedes. A
	/// line inside a body or among a call's arguments is in no header.
	fn insertion_construct(&self, row: usize, col: usize) -> Option<(Node<'_>, usize)> {
		let root = self.tree.root_node();
		let leaf =
			root.named_descendant_for_point_range(Point::new(row, col), Point::new(row, col + 1))?;
		let below = |body: Node<'_>| body_start(body).filter(|start| *start > row);
		let mut current = Some(leaf);
		while let Some(node) = current.filter(|node| node.id() != root.id()) {
			if node.start_position().row == row
				&& let Some(start) = body_insert_row(node)
			{
				return Some((node, start));
			}
			if is_body(node)
				|| matches!(node.kind(), "arguments" | "argument_list" | "value_arguments")
			{
				break;
			}
			if let Some(branch) = else_branch(node, row, col) {
				return below(branch).map(|start| (node, start));
			}
			if let Some(body) = body_of(node).filter(|body| body.start_position().row > row) {
				return below(body).map(|start| (node, start));
			}
			// A bare statement standing as an `if`'s consequence is its body
			// here, which an insertion must not push out; a conditional
			// expression's consequence is none.
			if let Some(start) = node
				.child_by_field_name("consequence")
				.filter(|body| body.start_position().row > row)
				.and_then(below)
			{
				return Some((node, start));
			}
			current = node.parent();
		}
		let mut outer = leaf;
		while let Some(parent) = outer
			.parent()
			.filter(|parent| parent.id() != root.id() && parent.start_position().row == row)
		{
			outer = parent;
		}
		if outer.start_position().row != row || !is_attribute_like(outer) {
			return None;
		}
		let item = attributed_item(outer, self.code, self.language, &self.metadata_owners)?;
		below(body_of(item)?).map(|start| (item, start))
	}

	/// Where `text` (whole lines, without a final newline) inserted below the
	/// anchor on 1-indexed `line` goes: right below it, the literal V4A
	/// position, unless the construct H whose header holds the anchor has a
	/// body starting further down and the parse says otherwise.
	///
	/// - Below the anchor, the insertion must parse without taking over an
	///   attribute of H, or of the item (a parameter, a field) an attribute on
	///   the anchor's line belongs to, and without ending the construct that
	///   begins where H does; then it goes there unless it joins H's header as a
	///   new part of another kind, or splits H from its body: then the top of
	///   the body is taken if that parses and keeps H whole, and right below the
	///   anchor only while H stays whole there.
	/// - Otherwise the top of the body is taken if it parses and keeps H whole;
	///   if not, nothing settles the choice.
	/// - When H's body starts right below the anchor (a bare statement under a
	///   brace-less `if` or loop), the insertion must keep H whole; with no body
	///   below, an insertion under an attribute line is still checked for taking
	///   that attribute over.
	///
	/// A position parses when H (with the insertion) holds no syntax error and
	/// the rest of the file no more than before. When H holds errors of its
	/// own, only the line below the anchor is taken, and only when the
	/// insertion adds no error to H, touches none, and changes H's header in
	/// no other way.
	pub fn anchored_insertion(&self, line: u32, column: usize, text: &str) -> Result<Insertion> {
		self.anchored_insertion_impl(line, column, text, true)
	}

	/// Preserve native position selection while deferring ownership to the
	/// completed operation's insertion-effect proof.
	pub fn anchored_gap(&self, line: u32, column: usize, text: &str) -> Result<Insertion> {
		self.anchored_insertion_impl(line, column, text, false)
	}

	fn anchored_insertion_impl(
		&self,
		line: u32,
		column: usize,
		text: &str,
		check_ownership: bool,
	) -> Result<Insertion> {
		let row = (line as usize).saturating_sub(1);
		let position = self
			.line_starts
			.get(row)
			.and_then(|start| start.checked_add(column));
		if let Some(frame) = position
			.and_then(|at| frame_at(self.frames(), at, false))
			.filter(|frame| !frame.data)
		{
			let byte = frame
				.payload_byte(position.unwrap())
				.ok_or_else(|| anyhow!("The payload anchor has no certain source mapping"))?;
			let payload_row = frame
				.line_starts
				.partition_point(|start| *start <= byte)
				.saturating_sub(1);
			let insertion = frame
				.with_index(self.code, |index| {
					index.anchored_insertion_impl(
						row_to_line(payload_row),
						byte - frame.line_starts[payload_row],
						text,
						check_ownership,
					)
				})
				.ok_or_else(|| anyhow!("The payload anchor's language is unsupported"))??;
			return Ok(match insertion {
				Insertion::At(at) => Insertion::At(self.payload_line(frame, at, true)?),
				Insertion::NeitherParses { body, header } => {
					Insertion::NeitherParses { body: self.payload_line(frame, body, false)?, header }
				},
				Insertion::ConstructHasErrors { body, header, error_line } => {
					Insertion::ConstructHasErrors {
						body: self.payload_line(frame, body, false)?,
						header,
						error_line: self.payload_line(frame, error_line, false)?,
					}
				},
				other => other,
			});
		}
		self.checked_scope_evidence(line, column)?;
		let after = row + 1;
		let insertion_at = |edited: &Edited| {
			if check_ownership {
				self.insertion_at(row, edited)
			} else {
				Insertion::At(row_to_line(edited.rows.start))
			}
		};
		let found = self.insertion_construct(row, column);
		let Some((construct, body)) = found.filter(|(_, body)| *body > after) else {
			// No body below: an attribute on the anchor's line may be taken
			// over, and the construct whose body starts right there must keep
			// it whole.
			let below = self.edited(after, text)?;
			if !check_ownership {
				return Ok(insertion_at(&below));
			}
			let item = self.attributed_on_row(row).or_else(|| {
				self.displaced(&below).filter(|item| {
					self
						.attachments(*item)
						.iter()
						.any(|attribute| attribute.start_byte() < below.at)
				})
			});
			if let Some(detached) = item.and_then(|item| self.detaches(&below, item)) {
				return Ok(detached);
			}
			if let Some((construct, _)) = found
				&& !self.new_sibling_parent(&below)
				&& !below.keeps_whole(construct)
			{
				return Ok(self.pushes_out(construct, row, after));
			}
			return Ok(insertion_at(&below));
		};
		let header = self
			.row_text(header_row(construct))
			.unwrap_or_default()
			.trim()
			.to_owned();
		let errors = construct.has_error().then(|| {
			let first = error_nodes(construct, construct.start_byte(), construct.end_byte())
				.first()
				.map_or_else(|| construct.start_position().row, |error| error.start_position().row);
			Insertion::ConstructHasErrors {
				body:       row_to_line(body),
				header:     header.clone(),
				error_line: row_to_line(first),
			}
		});
		let below = self.edited(after, text)?;
		if self.new_sibling_parent(&below) {
			return Ok(insertion_at(&below));
		}
		// The item an attribute on the anchor's line belongs to (a
		// parameter, a field) inside H must keep it too.
		if let Some(detached) = self
			.attributed_on_row(row)
			.filter(|item| item.id() != construct.id())
			.and_then(|item| self.detaches(&below, item))
		{
			return Ok(if check_ownership {
				detached
			} else {
				insertion_at(&below)
			});
		}
		let below_parses = if errors.is_some() {
			self.adds_no_errors(&below, construct)
		} else {
			self.parses_locally(&below, construct)
		};
		if below_parses {
			// Lines that end the construct beginning where it does: indented
			// deeper than the anchor they are its body content, split from
			// it, so only the top of the body may take them; otherwise they
			// take its first line over, as an attribute of an unknown kind.
			let (anchor_text, start_text) = (
				self.row_text(row).unwrap_or_default(),
				self
					.row_text(construct.start_position().row)
					.unwrap_or_default(),
			);
			let base = if indentation(start_text) < indentation(anchor_text) {
				start_text
			} else {
				anchor_text
			};
			let deeper = deeper_than(text, &base[..indentation(base)]);
			if let Some(detached) = self
				.detaches(&below, construct)
				.filter(|detached| !deeper || !matches!(detached, Insertion::EndsConstruct { .. }))
			{
				return Ok(if check_ownership {
					detached
				} else {
					insertion_at(&below)
				});
			}
			if deeper && below.ends_within(construct.start_byte()) {
				if let Some(errors) = errors {
					return Ok(errors);
				}
				let top = self.edited(body, text)?;
				return Ok(if self.keeps_cleanly(&top, construct) {
					insertion_at(&top)
				} else {
					Insertion::EndsConstruct { start: self.first_line_of(construct) }
				});
			}
			if !below.grows_header(construct, &self.row_kinds(row)) {
				return Ok(insertion_at(&below));
			}
			if let Some(errors) = errors {
				return Ok(errors);
			}
			let top = self.edited(body, text)?;
			return Ok(if self.keeps_cleanly(&top, construct) {
				insertion_at(&top)
			} else if below.keeps_whole(construct) {
				insertion_at(&below)
			} else {
				Insertion::NeitherParses { body: row_to_line(body), header }
			});
		}
		if let Some(errors) = errors {
			return Ok(errors);
		}
		let top = self.edited(body, text)?;
		Ok(if self.keeps_cleanly(&top, construct) {
			insertion_at(&top)
		} else {
			Insertion::NeitherParses { body: row_to_line(body), header }
		})
	}

	fn payload_line(&self, frame: &PayloadFrame, line: u32, gap: bool) -> Result<u32> {
		let row = line.saturating_sub(1) as usize;
		let position = frame
			.line_starts
			.get(row)
			.and_then(|byte| frame.source_byte(*byte, false));
		let position = position
			.or_else(|| {
				let next = *self
					.line_starts
					.get(self.point_at(frame.range.end).row + 1)?;
				(row == frame.line_starts.len()
					&& next <= frame.envelope.end
					&& self.code[frame.range.end..next].trim().is_empty())
				.then_some(next)
			})
			.ok_or_else(|| anyhow!("The payload insertion has no certain source-row mapping"))?;
		let point = self.point_at(position);
		if gap && point.column != 0 {
			return Err(anyhow!("The payload insertion is not a complete source-row gap"));
		}
		Ok(row_to_line(point.row))
	}

	/// Check an authored line gap without relocating it to a construct's body.
	/// Explicit trailing context is handled by the caller's adjacency proof.
	pub fn fixed_insertion(&self, line: u32, column: usize, text: &str) -> Result<Insertion> {
		let row = line.saturating_sub(1) as usize;
		let gap = row + 1;
		let at = self
			.line_starts
			.get(gap)
			.copied()
			.unwrap_or(self.code.len());
		if let Some(frame) = frame_at(self.frames(), at, true).filter(|frame| !frame.data) {
			let byte = frame
				.payload_gap(self.code, at)
				.ok_or_else(|| anyhow!("The payload gap has no certain source mapping"))?;
			let local_gap = frame
				.line_starts
				.partition_point(|start| *start <= byte)
				.saturating_sub(1);
			let local_row = local_gap
				.checked_sub(1)
				.ok_or_else(|| anyhow!("The payload gap has no preceding row"))?;
			let insertion = frame
				.with_index(self.code, |index| {
					let column = index
						.row_text(local_row)
						.and_then(content_column)
						.unwrap_or(0);
					index.fixed_insertion(row_to_line(local_row), column, text)
				})
				.ok_or_else(|| anyhow!("The payload gap's language is unsupported"))??;
			return Ok(match insertion {
				Insertion::At(line) if line as usize == local_gap + 1 => {
					Insertion::At(row_to_line(gap))
				},
				Insertion::At(_) => {
					return Err(anyhow!("The native insertion does not preserve the authored gap"));
				},
				other => other,
			});
		}
		let edited = self.edited(gap, text)?;
		let outcome = self.fixed_insertion_at(row, column, &edited);
		edited.checked_metadata_depth()?;
		Ok(outcome)
	}

	fn fixed_insertion_at(&self, row: usize, column: usize, edited: &Edited) -> Insertion {
		if let Some((construct, _)) = self.insertion_construct(row, column)
			&& edited.at < construct.end_byte()
			&& !self.new_sibling_parent(edited)
			&& !edited.keeps_whole(construct)
		{
			return self.pushes_out(construct, row, edited.rows.start);
		}
		self.insertion_at(row, edited)
	}

	fn fixed_insertion_gap(&self, predecessor: Option<usize>, edited: &Edited) -> Insertion {
		if let Some(row) = predecessor {
			self.fixed_insertion_at(
				row,
				content_column(self.row_text(row).unwrap_or_default()).unwrap_or(0),
				edited,
			)
		} else {
			self
				.parent_change(None, edited)
				.unwrap_or_else(|| Insertion::At(row_to_line(edited.rows.start)))
		}
	}

	/// Isolate insertion effects from the operation's authored deletions and
	/// rewrites. Every remaining row has a pure-shift correspondence.
	/// A native refusal retains its owner evidence; unsupported mappings fail.
	pub fn fixed_insertions(
		&self,
		source: &str,
		mapping: &[(usize, Option<usize>)],
		gaps: &[(usize, Range<usize>)],
		inserted: &[Range<usize>],
		retained: &[(Range<usize>, Range<usize>)],
	) -> Result<Option<Insertion>> {
		let Some(tree) = parse_cached(source, self.language)? else {
			return Err(anyhow!("The composed source has no supported parser"));
		};
		let frames = payload_frames(tree.root_node(), source, self.language);
		if !retained.is_empty()
			&& (has_continuation_candidate(self.code) || has_continuation_candidate(source))
		{
			let correspondence = RetainedRuns::new(retained);
			let old_input = (self.code, self.tree.root_node(), self.frames());
			let new_input = (source, tree.root_node(), frames.as_slice());
			let successor_row = |edge: &Range<usize>, original: bool| {
				let point = if original {
					correspondence.map(&(edge.end..edge.end + 1), true)?.start
				} else {
					edge.end
				};
				let row = retained.partition_point(|(_, range)| range.end <= point);
				retained
					.get(row)
					.filter(|(_, range)| range.contains(&point))
					.map(|_| row)
			};
			let affected = physical_continuation_boundaries(self.code).any(|edge| {
				successor_row(&edge, true).is_some()
					&& !unchanged_continuation(old_input, new_input, &edge, &correspondence, true)
			}) || physical_continuation_boundaries(source).any(|edge| {
				successor_row(&edge, false).is_some()
					&& !unchanged_continuation(new_input, old_input, &edge, &correspondence, false)
			});
			if affected {
				let final_roles = lexical_roles_view(tree.root_node(), source, self.language, &frames)
					.ok_or_else(|| {
						anyhow!("The composed continuation has no certain lexical snapshot")
					})?;
				let old_roles = self.role_spans().ok_or_else(|| {
					anyhow!("The retained continuation has no certain lexical snapshot")
				})?;
				let old = LexicalView { roles: old_roles, source: self.code };
				let new = LexicalView { roles: &final_roles, source };
				let mut obligations = Vec::new();
				for original in [true, false] {
					let (view, input, other) = if original {
						(old, old_input, new_input)
					} else {
						(new, new_input, old_input)
					};
					for (edge, certain) in view
						.roles
						.continuations
						.iter()
						.map(|edge| (edge, true))
						.chain(
							view
								.roles
								.uncertain_continuations
								.iter()
								.map(|edge| (edge, false)),
						) {
						let Some(row) = successor_row(edge, original) else {
							continue;
						};
						if unchanged_continuation(input, other, edge, &correspondence, original) {
							continue;
						}
						let successor = if original {
							&retained[row].0
						} else {
							&retained[row].1
						};
						if !certain
							|| view
								.roles
								.code_at(edge.start)
								.is_some_and(|code| code.language == SupportLang::Python)
								&& !view.certain_python_continuation(edge, successor)
						{
							return Err(anyhow!(
								"The affected continuation has no certain logical statement"
							));
						}
						obligations.push(row);
					}
				}
				obligations.sort_unstable();
				obligations.dedup();
				let result_depths = RefCell::default();
				for row in obligations {
					let (original, mapped) = &retained[row];
					let first_code = |code: &str, range: &Range<usize>| {
						range.start
							+ code[range.clone()]
								.char_indices()
								.find(|(_, ch)| !ch.is_whitespace())
								.map_or(0, |(at, _)| at)
					};
					let old_point = first_code(self.code, original);
					let new_point = first_code(source, mapped);
					let same_frame = match (
						frame_at(self.frames(), old_point, false),
						frame_at(&frames, new_point, false),
					) {
						(None, None) => true,
						(Some(before), Some(after)) => {
							let row = mapping
								.partition_point(|(at, _)| *at <= before.envelope.start)
								.checked_sub(1);
							let header = row.and_then(|row| mapping[row].1);
							header.is_some_and(|start| {
								let end = source[start..]
									.find('\n')
									.map_or(source.len(), |at| start + at);
								start <= after.envelope.start && after.envelope.start <= end
							}) && before.language == after.language
								&& before.kind == after.kind
								&& before.data == after.data
						},
						_ => false,
					};
					if !same_frame {
						return Err(anyhow!("The retained successor loses its original payload owner"));
					}
					for (code, root, payloads, point, depths) in [
						(self.code, self.tree.root_node(), self.frames(), old_point, &*self.proof_depths),
						(source, tree.root_node(), frames.as_slice(), new_point, &result_depths),
					] {
						bounded_ownership(root, point, depths, 0)?;
						if let Some(frame) =
							frame_at(payloads, point, false).filter(|frame| frame.language.is_some())
						{
							let at = frame.payload_byte(point).ok_or_else(|| {
								anyhow!("The retained successor has no certain payload mapping")
							})?;
							frame
								.with_index(code, |index| {
									bounded_ownership(index.tree.root_node(), at, &index.proof_depths, 1)
								})
								.ok_or_else(|| {
									anyhow!("The retained successor has no supported payload index")
								})??;
						}
					}
					if !old.preserves_successor(original.clone(), new, mapped.clone()) {
						return Err(anyhow!(
							"The changed continuation captures or releases a retained logical successor"
						));
					}
				}
			}
		}
		if gaps.is_empty() {
			return Ok(None);
		}
		let mut ranges = gaps
			.iter()
			.map(|(_, range)| range.clone())
			.collect::<Vec<_>>();
		ranges.sort_unstable_by_key(|range| range.start);
		let mut count = 0;
		for at in 0..ranges.len() {
			let range = ranges[at].clone();
			if count > 0 && range.start < ranges[count - 1].end {
				return Err(anyhow!("The composed insertion ranges overlap"));
			}
			if count > 0 && range.start == ranges[count - 1].end {
				ranges[count - 1].end = range.end;
			} else {
				ranges[count] = range;
				count += 1;
			}
		}
		ranges.truncate(count);
		if !self.code.ends_with('\n')
			&& let Some(last) = ranges.last_mut().filter(|range| range.end == source.len())
			&& last.start > 0
			&& source.as_bytes()[last.start - 1] == b'\n'
		{
			last.start -= 1;
			if last.start > 0 && source.as_bytes()[last.start - 1] == b'\r' {
				last.start -= 1;
			}
		}
		let mut counterfactual = String::with_capacity(source.len());
		let mut counter_gaps = Vec::with_capacity(gaps.len());
		let mut cursor = 0;
		for range in ranges {
			if range.start < cursor || range.end > source.len() {
				return Err(anyhow!("The composed insertion has no certain byte mapping"));
			}
			counterfactual.push_str(&source[cursor..range.start]);
			counter_gaps.push((counterfactual.len(), range.clone()));
			cursor = range.end;
		}
		counterfactual.push_str(&source[cursor..]);
		let starts = std::iter::once(0)
			.chain(counterfactual.match_indices('\n').map(|(at, _)| at + 1))
			.collect::<Vec<_>>();
		for (gap, _) in &mut counter_gaps {
			*gap = match starts.binary_search(gap) {
				Ok(row) => row,
				Err(_) if *gap == counterfactual.len() && !counterfactual.ends_with('\n') => {
					starts.len()
				},
				Err(_) => return Err(anyhow!("The composed insertion has no certain row mapping")),
			};
		}
		let mut next = 0;
		let mut removed = 0;
		let shifted = starts
			.iter()
			.enumerate()
			.map(|(row, start)| {
				while next < counter_gaps.len() && counter_gaps[next].0 <= row {
					removed += counter_gaps[next].1.len();
					next += 1;
				}
				(*start, Some(*start + removed))
			})
			.chain([(counterfactual.len(), Some(source.len()))])
			.collect::<Vec<_>>();
		if counterfactual == self.code {
			return self.fixed_insertions_against(
				source,
				&tree,
				&shifted,
				&counter_gaps,
				inserted,
				&frames,
			);
		}
		let Some(counter_tree) = parse_cached(&counterfactual, self.language)? else {
			return self.fixed_insertions_against(source, &tree, mapping, gaps, inserted, &frames);
		};
		let counter = BlockIndex {
			// The original fallback cannot waive a depth failure in the required
			// counterfactual proof.
			code:            &counterfactual,
			language:        self.language,
			tree:            Cow::Owned(counter_tree),
			line_starts:     Cow::Owned(starts),
			role_spans:      Cow::Owned(OnceLock::new()),
			label_targets:   RefCell::default(),
			payloads:        OnceLock::new(),
			boundaries:      Cow::Owned(OnceLock::new()),
			sibling_targets: Cow::Owned(RefCell::default()),
			proof_depths:    Cow::Owned(RefCell::default()),
			metadata_owners: Cow::Owned(RefCell::default()),
		};
		for (gap, _) in &counter_gaps {
			let at = counter
				.line_starts
				.get(*gap)
				.copied()
				.unwrap_or(counter.code.len());
			bounded_ownership(counter.tree.root_node(), at, &counter.proof_depths, 0)?;
		}
		if counter.tree.root_node().has_error() && !tree.root_node().has_error()
			|| counter_gaps
				.iter()
				.any(|(gap, _)| counter.insertion_ancestry_uncertain(*gap))
		{
			return self.fixed_insertions_against(source, &tree, mapping, gaps, inserted, &frames);
		}
		counter.fixed_insertions_against(source, &tree, &shifted, &counter_gaps, inserted, &frames)
	}

	fn insertion_ancestry_uncertain(&self, gap: usize) -> bool {
		let at = self
			.line_starts
			.get(gap)
			.copied()
			.unwrap_or(self.code.len());
		if frame_at(self.frames(), at, true)
			.filter(|frame| !frame.data)
			.and_then(|frame| frame.tree.as_ref())
			.is_some_and(|tree| tree.root_node().has_error())
		{
			return true;
		}
		let last = first_named_after(self.tree.root_node(), at, None)
			.map_or(gap, |node| content_end_row(node).saturating_add(1));
		(gap..self.line_starts.len().min(last.saturating_add(1))).any(|row| {
			let Some(column) = self.row_text(row).and_then(content_column) else {
				return false;
			};
			let byte = self.line_starts[row] + column;
			let Some(node) = self
				.tree
				.root_node()
				.named_descendant_for_byte_range(byte, byte + 1)
			else {
				return true;
			};
			std::iter::successors(Some(node), |node| node.parent()).any(|owner| {
				owner.is_error() || owner.is_missing() || owner.parent().is_some() && owner.has_error()
			})
		})
	}

	fn fixed_insertions_against(
		&self,
		source: &str,
		tree: &Tree,
		mapping: &[(usize, Option<usize>)],
		gaps: &[(usize, Range<usize>)],
		inserted: &[Range<usize>],
		frames: &[PayloadFrame],
	) -> Result<Option<Insertion>> {
		let old_identities = RefCell::default();
		let new_identities = RefCell::default();
		let data_content_growth = RefCell::default();
		let attachment_spans = OnceLock::new();
		let metadata_owners = RefCell::default();
		let case_snapshot = CaseSnapshot::default();
		let mut frame_mappings = HashMap::<usize, Result<FrameInsertionMapping>>::new();
		let result_depths = RefCell::default();
		for (gap, range) in gaps {
			let row = gap.checked_sub(1);
			let Some(at) = self
				.line_starts
				.get(*gap)
				.copied()
				.or_else(|| (*gap == self.line_starts.len()).then_some(self.code.len()))
			else {
				return Err(anyhow!("The insertion has no certain source row"));
			};
			let Some(insert) = source.get(range.clone()) else {
				return Err(anyhow!("The insertion has no certain result range"));
			};
			bounded_ownership(self.tree.root_node(), at, &self.proof_depths, 0)?;
			bounded_ownership(tree.root_node(), range.end, &result_depths, 0)?;
			let edited = Edited {
				tree: Cow::Borrowed(tree),
				source: Cow::Borrowed(source),
				at,
				len: range.len(),
				rows: *gap..*gap + insert.matches('\n').count(),
				insert: Cow::Borrowed(insert),
				language: self.language,
				result_at: range.start,
				mapping: Some(mapping),
				inserted: Cow::Borrowed(inserted),
				old_identities: Cow::Borrowed(&old_identities),
				new_identities: Cow::Borrowed(&new_identities),
				case_snapshot: Cow::Borrowed(&case_snapshot),
				attachment_spans: Cow::Borrowed(&attachment_spans),
				metadata_owners: Cow::Borrowed(&metadata_owners),
				data_content_growth: Cow::Borrowed(&data_content_growth),
			};
			let outcome = if let Some(frame) = frame_at(self.frames(), at, true) {
				let Some(candidate) = frame_at(frames, range.start, false).filter(|candidate| {
					candidate.language == frame.language
						&& candidate.data == frame.data
						&& candidate.kind == frame.kind
				}) else {
					return Err(anyhow!("The insertion changes its receiving payload frame"));
				};
				if frame.unknown() || candidate.unknown() {
					return Err(anyhow!("The receiving payload is unsupported or cannot be projected"));
				}
				if frame.language.is_some() {
					let old_at = frame
						.payload_gap(self.code, at)
						.ok_or_else(|| anyhow!("The receiving payload has no certain original gap"))?;
					let new_at = candidate
						.payload_gap(source, range.end)
						.ok_or_else(|| anyhow!("The receiving payload has no certain result gap"))?;
					frame
						.with_index(self.code, |index| {
							bounded_ownership(index.tree.root_node(), old_at, &index.proof_depths, 1)
						})
						.ok_or_else(|| {
							anyhow!("The receiving payload has no supported native index")
						})??;
					candidate
						.with_index(source, |result| {
							bounded_ownership(result.tree.root_node(), new_at, &result.proof_depths, 1)
						})
						.ok_or_else(|| {
							anyhow!("The receiving payload has no supported native index")
						})??;
				}
				if frame.data {
					self.fixed_insertion_gap(row, &edited)
				} else {
					let Some(old_at) = frame.payload_gap(self.code, at) else {
						return Err(anyhow!("The receiving payload has no certain original gap"));
					};
					let Some(begin) = candidate.payload_gap(source, range.start) else {
						return Err(anyhow!("The receiving payload has no certain result gap"));
					};
					let Some(end) = range
						.end
						.checked_sub(1)
						.and_then(|byte| candidate.payload_byte(byte))
						.map(|byte| byte + 1)
					else {
						return Err(anyhow!("The receiving payload has no certain result boundary"));
					};
					let new_range = begin..end;
					let frame_mapping = frame_mappings.entry(frame.range.start).or_insert_with(|| {
						let rows = frame
							.line_starts
							.iter()
							.map(|start| {
								let synthetic = frame
									.projection
									.iter()
									.find(|part| part.source.is_empty() && part.payload.contains(start));
								let mapped = if let Some(part) = synthetic {
									candidate
										.projection
										.iter()
										.find(|next| {
											next.source.is_empty()
												&& (part.payload.start == 0 && next.payload.start == 0
													|| part.payload.end == frame.text(self.code).len()
														&& next.payload.end == candidate.text(source).len())
												&& frame.text(self.code)[part.payload.clone()]
													== candidate.text(source)[next.payload.clone()]
										})
										.map(|next| next.payload.start + start - part.payload.start)
								} else {
									frame
										.source_byte(*start, false)
										.and_then(|byte| candidate.payload_byte(edited.shift(byte)))
								};
								(*start, mapped)
							})
							.chain([(frame.text(self.code).len(), Some(candidate.text(source).len()))])
							.collect::<Vec<_>>();
						let first = inserted.partition_point(|range| range.end <= candidate.range.start);
						let inserted = inserted[first..]
							.iter()
							.take_while(|range| range.start < candidate.range.end)
							.map(|range| {
								let start = range.start.max(candidate.range.start);
								let end = range.end.min(candidate.range.end);
								let begin = candidate.payload_gap(source, start);
								let end = end.checked_sub(1).and_then(|at| candidate.payload_byte(at));
								match (begin, end) {
									(Some(begin), Some(end)) => Ok(begin..end + 1),
									_ => Err(anyhow!("The inserted payload unit has no certain projection")),
								}
							})
							.collect::<Result<Vec<_>>>()?;
						Ok(FrameInsertionMapping {
							rows,
							inserted,
							old_identities: RefCell::default(),
							new_identities: RefCell::default(),
							data_content_growth: RefCell::default(),
							attachment_spans: OnceLock::new(),
							case_snapshot: CaseSnapshot::default(),
						})
					});
					let frame_mapping = frame_mapping.as_ref().map_err(|error| anyhow!("{error}"))?;
					let local_row = frame
						.line_starts
						.partition_point(|start| *start <= old_at)
						.checked_sub(2);
					let Some(outcome) = frame
						.with_index(self.code, |index| {
							candidate.with_index(source, |result| {
								let local = Edited {
									tree:                Cow::Borrowed(&result.tree),
									source:              Cow::Borrowed(result.code),
									at:                  old_at,
									len:                 new_range.len(),
									rows:                local_row.map_or(0, |row| row + 1)
										..local_row.map_or(0, |row| row + 1) + insert.matches('\n').count(),
									insert:              Cow::Borrowed(&result.code[new_range.clone()]),
									language:            index.language,
									result_at:           new_range.start,
									mapping:             Some(&frame_mapping.rows),
									inserted:            Cow::Borrowed(&frame_mapping.inserted),
									old_identities:      Cow::Borrowed(&frame_mapping.old_identities),
									new_identities:      Cow::Borrowed(&frame_mapping.new_identities),
									case_snapshot:       Cow::Borrowed(&frame_mapping.case_snapshot),
									data_content_growth: Cow::Borrowed(&frame_mapping.data_content_growth),
									attachment_spans:    Cow::Borrowed(&frame_mapping.attachment_spans),
									metadata_owners:     Cow::Borrowed(&result.metadata_owners),
								};
								let outcome = index.fixed_insertion_gap(local_row, &local);
								local.checked_metadata_depth()?;
								Ok::<_, anyhow::Error>(outcome)
							})
						})
						.flatten()
					else {
						return Err(anyhow!("The receiving payload has no supported native index"));
					};
					outcome?
				}
			} else {
				if frame_at(frames, range.start, true).is_some() {
					return Err(anyhow!("The insertion introduces a receiving payload frame"));
				}
				self.fixed_insertion_gap(row, &edited)
			};
			edited.checked_metadata_depth()?;
			if !matches!(outcome, Insertion::At(_)) {
				return Ok(Some(outcome));
			}
		}
		Ok(None)
	}

	/// Reuse the chosen position's incremental parse to preserve ownership,
	/// even when `insertion_construct` does not recognize the header.
	fn insertion_at(&self, row: usize, edited: &Edited) -> Insertion {
		let item = self.attributed_on_row(row).or_else(|| {
			self.displaced(edited).filter(|item| {
				self
					.attachments(*item)
					.iter()
					.any(|attribute| attribute.start_byte() < edited.at)
			})
		});
		if let Some(detached) = item.and_then(|item| self.detaches(edited, item)) {
			return detached;
		}
		self
			.parent_change(Some(row), edited)
			.unwrap_or_else(|| Insertion::At(row_to_line(edited.rows.start)))
	}

	fn displaced(&self, edited: &Edited) -> Option<Node<'_>> {
		first_named_after(self.tree.root_node(), edited.at, None)
	}

	fn new_sibling_parent(&self, edited: &Edited) -> bool {
		self
			.displaced(edited)
			.is_some_and(|node| edited.new_sibling_parent(node))
	}

	fn parent_change(&self, row: Option<usize>, edited: &Edited) -> Option<Insertion> {
		let root = self.tree.root_node();
		let mut item = if let Some(row) = row {
			let byte = self.line_starts.get(row).copied()? + content_column(self.row_text(row)?)?;
			root.named_descendant_for_byte_range(byte, byte + 1)?
		} else {
			root
		};
		while let Some(parent) = item.parent().filter(|parent| parent.id() != root.id()) {
			item = parent;
		}
		let last = self
			.displaced(edited)
			.map_or(edited.rows.start, |item| content_end_row(item).saturating_add(1));
		let reachable_case = self.new_sibling_parent(edited);
		let attributes_only = edited.attributes_only();
		if !attributes_only
			&& let Some(docstring) = self
				.displaced(edited)
				.filter(|node| is_docstring(*node, self.code, self.language))
		{
			return Some(Insertion::DetachesAttribute {
				attribute: self.first_line_of(docstring),
				item:      self.first_line_of(
					docstring
						.parent()
						.and_then(|body| body.parent())
						.unwrap_or(root),
				),
			});
		}
		for displaced_row in edited.rows.start..self.line_starts.len().min(last.saturating_add(1)) {
			let text = self.row_text(displaced_row)?;
			let Some(col) = content_column(text).filter(|_| !text.trim().is_empty()) else {
				continue;
			};
			let byte = self.line_starts[displaced_row] + col;
			let old = root.named_descendant_for_byte_range(byte, byte + 1)?;
			let mapped_row = edited.shift(self.line_starts[displaced_row]);
			let mapped_col = edited
				.source
				.get(mapped_row..)
				.and_then(|source| source.lines().next())
				.and_then(content_column)
				.unwrap_or(0);
			let mapped_byte = mapped_row + mapped_col;
			let now = edited
				.tree
				.root_node()
				.named_descendant_for_byte_range(mapped_byte, mapped_byte + 1);
			if old.is_error() {
				continue;
			}
			if reachable_case
				&& is_comment(old)
				&& now.is_some_and(|now| {
					is_comment(now)
						&& now.start_byte() == edited.shift(old.start_byte())
						&& now.end_byte() == edited.shift(old.end_byte())
				}) {
				continue;
			}
			if now.is_some_and(|now| edited.keeps_chain(old, now, self.code, attributes_only)) {
				continue;
			}
			let owner = old.parent().unwrap_or(old);
			let mut header_owner = owner;
			while header_owner.id() != root.id()
				&& !is_body(header_owner)
				&& !Self::is_block(header_owner)
				&& !matches!(
					header_owner.kind(),
					"switch_case" | "switch_default" | "case_statement" | "switch_section"
				) {
				header_owner = header_owner.parent().unwrap_or(root);
			}
			if header_owner.id() == root.id() {
				header_owner = item;
			}
			if is_body(header_owner)
				&& let Some(declaration) = header_owner
					.parent()
					.filter(|parent| body_of(*parent).is_some_and(|body| body.id() == header_owner.id()))
			{
				header_owner = declaration;
			}
			let header = row
				.and_then(|row| self.else_header(row, owner))
				.map_or_else(
					|| {
						self
							.row_text(header_row(header_owner))
							.unwrap_or_default()
							.trim()
							.to_owned()
					},
					str::to_owned,
				);
			return Some(Insertion::PushesOut {
				header,
				displaced: text.trim().to_owned(),
				braces: self.braces_advice(header_owner),
			});
		}
		None
	}

	fn else_header(&self, row: usize, construct: Node<'_>) -> Option<&str> {
		let mut current = Some(construct);
		while let Some(node) = current {
			if else_on_row(node, row) {
				return self.row_text(row).map(str::trim);
			}
			if is_body(node) {
				break;
			}
			current = node.parent();
		}
		None
	}

	/// Whether `construct` keeps its whole extent in the edited source and
	/// parses there (see [`Self::parses_locally`]).
	fn keeps_cleanly(&self, edited: &Edited, construct: Node<'_>) -> bool {
		edited.keeps_whole(construct) && self.parses_locally(edited, construct)
	}

	/// The refusal for an insertion right below the anchor that pushes the
	/// line on 0-based `row` (the start of `construct`'s body) out of it.
	fn pushes_out(&self, construct: Node<'_>, anchor_row: usize, row: usize) -> Insertion {
		let text = |row: usize| self.row_text(row).unwrap_or_default().trim().to_owned();
		let displaced = (row..self.line_starts.len())
			.map(text)
			.find(|line| !line.is_empty())
			.unwrap_or_default();
		Insertion::PushesOut {
			header: self
				.else_header(anchor_row, construct)
				.map_or_else(|| text(header_row(construct)), str::to_owned),
			displaced,
			braces: self.braces_advice(construct),
		}
	}

	fn braces_advice(&self, construct: Node<'_>) -> bool {
		!matches!(self.language, SupportLang::Markdown | SupportLang::Yaml | SupportLang::Toml)
			&& !matches!(
				construct.kind(),
				"switch_case" | "switch_default" | "case_statement" | "switch_section"
			)
	}

	/// The item an attribute, decorator or annotation on 0-based `row`
	/// applies to.
	fn attributed_on_row(&self, row: usize) -> Option<Node<'_>> {
		let col = content_column(self.row_text(row)?)?;
		let top = block_node(self.tree.root_node(), row, col)?;
		let attribute = self.attribute_at(row, top).or_else(|| {
			let mut node = Some(top);
			while let Some(part) = node {
				if is_comment(part)
					|| (self.language == SupportLang::Julia && string_statement(part, self.code))
				{
					return Some(part);
				}
				node = part.parent();
			}
			None
		})?;
		if is_comment(attribute)
			&& matches!(
				attribute_owner(attribute, self.code, self.language, &self.metadata_owners),
				AttributeOwner::EnclosingOwner
			) {
			return attributed_item(attribute, self.code, self.language, &self.metadata_owners);
		}
		if is_comment(attribute)
			|| (self.language == SupportLang::Julia && string_statement(attribute, self.code))
		{
			let item = first_named_after(
				self.tree.root_node(),
				attribute.end_byte(),
				Some((self.code, self.language, &self.metadata_owners)),
			)?;
			return ((attachment_target(item, self.code, self.language).protects_docs()
				|| self.language == SupportLang::Julia)
				&& (content_end_row(attribute) + 1..item.start_position().row).all(|row| {
					self
						.row_text(row)
						.is_some_and(|text| !text.trim().is_empty())
				}))
			.then_some(item);
		}
		attributed_item(attribute, self.code, self.language, &self.metadata_owners)
	}

	fn attachments<'t>(&'t self, construct: Node<'t>) -> Vec<Node<'t>> {
		let mut attributes = attributes_of(construct);
		attributes.retain(|attribute| {
			matches!(
				attribute_owner(*attribute, self.code, self.language, &self.metadata_owners),
				AttributeOwner::NextItem | AttributeOwner::Unknown
			)
		});
		let declaration = attachment_target(construct, self.code, self.language).protects_docs();
		if !declaration && self.language != SupportLang::Julia {
			return attributes;
		}
		let holder = construct
			.parent()
			.filter(|parent| {
				(declaration_container(*parent) || statement_container(*parent))
					&& parent
						.named_child(0)
						.is_some_and(|first| first.id() == construct.id())
			})
			.unwrap_or(construct);
		let mut first_row = construct.start_position().row;
		for node in preceding_run(holder, |node| {
			(declaration
				&& is_comment(node)
				&& matches!(
					attribute_owner(node, self.code, self.language, &self.metadata_owners),
					AttributeOwner::NextItem | AttributeOwner::Unknown
				)) || is_attribute_like(node)
				&& matches!(
					attribute_owner(node, self.code, self.language, &self.metadata_owners),
					AttributeOwner::NextItem | AttributeOwner::Unknown
				) || (self.language == SupportLang::Julia && string_statement(node, self.code))
		})
		.into_iter()
		.rev()
		{
			if content_end_row(node) + 1 < first_row {
				break;
			}
			if ((declaration
				&& is_comment(node)
				&& matches!(
					attribute_owner(node, self.code, self.language, &self.metadata_owners),
					AttributeOwner::NextItem | AttributeOwner::Unknown
				)) || (self.language == SupportLang::Julia && string_statement(node, self.code)))
				&& self
					.row_text(node.start_position().row)
					.is_some_and(|text| content_column(text) == Some(node.start_position().column))
			{
				attributes.push(node);
			}
			first_row = node.start_position().row;
		}
		let mut cursor = construct.walk();
		attributes.extend(construct.named_children(&mut cursor).filter(|node| {
			is_comment(*node)
				&& content_end_row(*node) < header_row(construct)
				&& matches!(
					attribute_owner(*node, self.code, self.language, &self.metadata_owners),
					AttributeOwner::NextItem | AttributeOwner::Unknown
				)
		}));
		attributes
	}

	/// The refusal for an insertion that takes over one of `construct`'s
	/// attributes, or that ends the construct beginning where `construct`
	/// does inside the inserted lines (an attribute of a kind not recognized
	/// as one would otherwise move to the inserted lines).
	fn detaches(&self, edited: &Edited, construct: Node<'_>) -> Option<Insertion> {
		let item = || {
			self
				.row_text(header_row(construct))
				.unwrap_or_default()
				.trim()
				.to_owned()
		};
		let attributes_only = edited.attributes_only();
		if let Some(attribute) = self.attachments(construct).into_iter().find(|attribute| {
			if attributes_only {
				return false;
			}
			if is_comment(*attribute)
				|| (self.language == SupportLang::Julia && string_statement(*attribute, self.code))
			{
				attribute.end_byte() <= edited.at && edited.at <= construct.start_byte()
			} else if matches!(
				attribute_owner(*attribute, self.code, self.language, &self.metadata_owners),
				AttributeOwner::Unknown
			) {
				attribute.start_byte() < edited.at && edited.at <= construct.end_byte()
			} else {
				edited.captures(*attribute)
			}
		}) {
			return Some(Insertion::DetachesAttribute {
				attribute: self.first_line_of(attribute),
				item:      item(),
			});
		}
		edited
			.ends_within(construct.start_byte())
			.then(|| Insertion::EndsConstruct { start: self.first_line_of(construct) })
	}

	/// Whether the edited source adds no syntax error around `construct`,
	/// which holds some already: no more errors touch the construct, none
	/// touches the inserted lines, and the rest of the file holds no more.
	fn adds_no_errors(&self, edited: &Edited, construct: Node<'_>) -> bool {
		let start = construct.start_byte().min(edited.at);
		let end = construct.end_byte();
		let (inside_before, outside_before) = error_counts(self.tree.root_node(), start, end);
		let (inside, outside) = error_counts(edited.tree.root_node(), start, end + edited.len);
		inside <= inside_before
			&& outside <= outside_before
			&& error_nodes(edited.tree.root_node(), edited.at, edited.at + edited.len).is_empty()
	}

	/// The source with `text` inserted before 0-based `row`, reparsed from
	/// this tree (a `row` past the last one appends).
	fn edited(&self, row: usize, text: &str) -> Result<Edited> {
		let (at, insert, appended) = match self.line_starts.get(row) {
			Some(start) if *start < self.code.len() || self.code.ends_with('\n') => {
				(*start, format!("{text}\n"), false)
			},
			_ => (self.code.len(), format!("\n{text}"), true),
		};
		let (source, tree) = self.reparse(at..at, &insert)?;
		let start = self.point_at(at);
		let rows = text.matches('\n').count() + 1;
		let first_row = if appended { start.row + 1 } else { start.row };
		let inserted = std::iter::once(at..at + insert.len()).collect();
		Ok(Edited {
			tree: Cow::Owned(tree),
			source: Cow::Owned(source),
			at,
			len: insert.len(),
			rows: first_row..first_row + rows,
			insert: Cow::Owned(insert),
			language: self.language,
			result_at: at,
			mapping: None,
			inserted: Cow::Owned(inserted),
			old_identities: Cow::Owned(RefCell::default()),
			new_identities: Cow::Owned(RefCell::default()),
			case_snapshot: Cow::Owned(CaseSnapshot::default()),
			data_content_growth: Cow::Owned(RefCell::default()),
			attachment_spans: Cow::Owned(OnceLock::new()),
			metadata_owners: Cow::Owned(RefCell::default()),
		})
	}

	/// Whether the edited source parses around `construct`: the construct
	/// and the inserted lines hold no syntax error, and the rest of the file
	/// no more than before.
	fn parses_locally(&self, edited: &Edited, construct: Node<'_>) -> bool {
		let start = construct.start_byte().min(edited.at);
		let end = construct.end_byte();
		let (_, outside_before) = error_counts(self.tree.root_node(), start, end);
		let (inside, outside) = error_counts(edited.tree.root_node(), start, end + edited.len);
		inside == 0 && outside <= outside_before
	}

	/// Kinds of the named nodes beginning on 0-based `row`.
	fn row_kinds(&self, row: usize) -> Vec<&'static str> {
		let Some(col) = self.row_text(row).and_then(content_column) else {
			return Vec::new();
		};
		let root = self.tree.root_node();
		let mut kinds = Vec::new();
		let mut current =
			root.named_descendant_for_point_range(Point::new(row, col), Point::new(row, col + 1));
		while let Some(node) =
			current.filter(|node| node.id() != root.id() && node.start_position().row == row)
		{
			kinds.push(node.kind());
			current = node.parent();
		}
		kinds
	}

	/// The first line of `node`'s text, trimmed.
	fn first_line_of(&self, node: Node<'_>) -> String {
		self.code[node.start_byte()..node.end_byte()]
			.lines()
			.next()
			.unwrap_or_default()
			.trim()
			.to_owned()
	}

	fn point_at(&self, byte: usize) -> Point {
		let row = self.line_starts.partition_point(|start| *start <= byte) - 1;
		Point::new(row, byte - self.line_starts[row])
	}
}

/// Where an anchored pure insertion goes (see
/// [`BlockIndex::anchored_insertion`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Insertion {
	/// 1-indexed line the inserted lines begin on.
	At(u32),
	/// Inserted right below the anchor, the lines would take over this
	/// attribute, decorator or annotation from the item it belongs to.
	DetachesAttribute { attribute: String, item: String },
	/// Inserted right below the anchor, the lines would end the construct
	/// whose first line is `start` (an attribute of a kind not recognized as
	/// one, or a header that ends where the lines begin).
	EndsConstruct { start: String },
	/// Neither right below the anchor nor at the top of the body (1-indexed
	/// `body`) of the construct whose header is `header` does the insertion
	/// parse with the construct kept whole.
	NeitherParses { body: u32, header: String },
	/// Inserted right below the anchor, the lines would push `displaced`,
	/// the first line of the body of the construct whose header is `header`,
	/// out of that construct (a brace-less `if`, a body starting right
	/// below the anchor).
	PushesOut { header: String, displaced: String, braces: bool },
	/// The construct whose header is `header` has syntax errors of its own,
	/// the first on 1-indexed `error_line`, and the insertion below the
	/// anchor does not settle its place apart from the top of its body.
	ConstructHasErrors { body: u32, header: String, error_line: u32 },
}

type OwnerIdentities = RefCell<HashMap<usize, (Option<&'static str>, usize)>>;
type DataGrowth = RefCell<HashMap<(usize, usize), bool>>;
type AttachmentSpans = OnceLock<Vec<(Range<usize>, bool)>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CaseUnitKind {
	Trivia,
	Label,
	Fallthrough,
}

#[derive(Clone)]
struct CaseUnit {
	range: Range<usize>,
	kind:  CaseUnitKind,
	owner: usize,
}

#[derive(Clone, Default)]
struct CaseUnits {
	units:      Vec<CaseUnit>,
	introduced: HashSet<usize>,
}

#[derive(Clone, Default)]
struct CaseSnapshot {
	units:     OnceLock<CaseUnits>,
	reachable: RefCell<HashMap<(usize, usize), bool>>,
}

struct FrameInsertionMapping {
	rows:                Vec<(usize, Option<usize>)>,
	inserted:            Vec<Range<usize>>,
	old_identities:      OwnerIdentities,
	new_identities:      OwnerIdentities,
	data_content_growth: DataGrowth,
	attachment_spans:    AttachmentSpans,
	case_snapshot:       CaseSnapshot,
}

/// A source with lines inserted, reparsed: the insertion's byte offset and
/// length and the rows the inserted lines take.
struct Edited<'a> {
	tree:                Cow<'a, Tree>,
	source:              Cow<'a, str>,
	at:                  usize,
	len:                 usize,
	rows:                Range<usize>,
	insert:              Cow<'a, str>,
	language:            SupportLang,
	result_at:           usize,
	mapping:             Option<&'a [(usize, Option<usize>)]>,
	inserted:            Cow<'a, [Range<usize>]>,
	old_identities:      Cow<'a, OwnerIdentities>,
	new_identities:      Cow<'a, OwnerIdentities>,
	case_snapshot:       Cow<'a, CaseSnapshot>,
	data_content_growth: Cow<'a, DataGrowth>,
	attachment_spans:    Cow<'a, AttachmentSpans>,
	metadata_owners:     Cow<'a, MetadataOwners>,
}

impl Edited<'_> {
	fn checked_metadata_depth(&self) -> Result<()> {
		let end = self.result_at + self.len;
		if self
			.metadata_owners
			.borrow()
			.depth_errors
			.iter()
			.any(|range| range.start < end && self.result_at < range.end)
		{
			return Err(anyhow!(DEPTH_REFUSAL));
		}
		Ok(())
	}

	fn wholly_inserted(&self, range: Range<usize>) -> bool {
		self
			.inserted
			.partition_point(|insert| insert.start <= range.start)
			.checked_sub(1)
			.is_some_and(|at| range.end <= self.inserted[at].end)
	}

	fn grows_data_content(&self, old: Node<'_>, new: Node<'_>, old_source: &str) -> bool {
		let key = (old.id(), new.id());
		if let Some(result) = self.data_content_growth.borrow().get(&key) {
			return *result;
		}
		let markup = self.language == SupportLang::Markdown
			&& old.kind() == new.kind()
			&& matches!(old.kind(), "paragraph" | "inline")
			&& !old.has_error()
			&& !new.has_error()
			&& self.shift(old.start_byte()) >= new.start_byte()
			&& self.shift(old.end_byte()) == new.end_byte()
			&& self
				.source
				.get(self.shift(old.start_byte())..self.shift(old.end_byte()))
				.is_some_and(|suffix| suffix == &old_source[old.byte_range()]);
		let opaque = old.named_child_count() == 0
			&& new.named_child_count() == 0
			&& !literal_owner(old, self.language)
			&& !literal_owner(new, self.language)
			&& old
				.parent()
				.is_some_and(|parent| incidental_list(parent, old_source, self.language))
			&& new
				.parent()
				.is_some_and(|parent| incidental_list(parent, &self.source, self.language))
			&& matches!(attachment_target(old, old_source, self.language), AttachmentTarget::Data)
			&& matches!(attachment_target(new, &self.source, self.language), AttachmentTarget::Data);
		let result = if markup {
			true
		} else if opaque {
			let mut old_cursor = old.walk();
			let mut new_cursor = new.walk();
			let mut candidates = new.children(&mut new_cursor).peekable();
			old.children(&mut old_cursor).all(|token| {
				let start = self.shift(token.start_byte());
				let end = self.shift(token.end_byte());
				while candidates
					.peek()
					.is_some_and(|now| now.start_byte() < start && now.end_byte() <= start)
				{
					candidates.next();
				}
				candidates.next().is_some_and(|now| {
					now.kind() == token.kind() && now.start_byte() == start && now.end_byte() == end
				})
			})
		} else {
			false
		};
		self.data_content_growth.borrow_mut().insert(key, result);
		result
	}

	/// Populate sibling identities in one cursor pass, independently for
	/// each tree. A displaced row never rescans its preceding siblings.
	fn identity(&self, node: Node<'_>, edited: bool) -> (Option<&'static str>, usize) {
		let identities = if edited {
			&self.new_identities
		} else {
			&self.old_identities
		};
		if let Some(identity) = identities.borrow().get(&node.id()) {
			return *identity;
		}
		let Some(parent) = node.parent() else {
			return (None, 0);
		};
		let mut identities = identities.borrow_mut();
		let mut counts = HashMap::new();
		let mut cursor = parent.walk();
		if cursor.goto_first_child() {
			loop {
				let child = cursor.node();
				if child.is_named() {
					let count = counts.entry(child.kind()).or_insert(0);
					identities.insert(child.id(), (cursor.field_name(), *count));
					if !edited
						|| !self.wholly_inserted(
							child.start_byte()
								..child.start_byte() + self.source[child.byte_range()].trim_end().len(),
						) || statement_container(child)
						&& matches!(
							parent.kind(),
							"if_statement"
								| "if_expression"
								| "conditional_statement"
								| "try_statement"
								| "try_expression"
						) {
						*count += 1;
					}
				}
				if !cursor.goto_next_sibling() {
					break;
				}
			}
		}
		identities.get(&node.id()).copied().unwrap_or((None, 0))
	}

	/// Byte offset in the edited source of an original byte offset.
	fn shift(&self, byte: usize) -> usize {
		if let Some(mapping) = self.mapping {
			let index = mapping.partition_point(|(start, _)| *start <= byte);
			return index
				.checked_sub(1)
				.and_then(|index| mapping[index].1.map(|at| at + byte - mapping[index].0))
				.unwrap_or(usize::MAX / 2);
		}
		if byte >= self.at {
			byte + self.len
		} else {
			byte
		}
	}

	/// The node of `kind` that begins at original byte `start`.
	fn find(&self, start: usize, kind: &str) -> Option<Node<'_>> {
		let start = self.shift(start);
		let mut current = self
			.tree
			.root_node()
			.descendant_for_byte_range(start, start);
		while let Some(node) = current {
			if node.is_named() && node.start_byte() == start && node.kind() == kind {
				return Some(node);
			}
			current = node.parent();
		}
		None
	}

	/// A transparent sequence keeps the same semantic enclosing owner.
	fn persistent_sequence_owner(&self, old: Node<'_>, now: Node<'_>, old_source: &str) -> bool {
		fn semantic_parent<'t>(
			mut node: Node<'t>,
			code: &str,
			language: SupportLang,
		) -> Option<Node<'t>> {
			loop {
				let parent = node.parent()?;
				if !incidental_list(parent, code, language) {
					return Some(parent);
				}
				node = parent;
			}
		}
		let Some(before) = semantic_parent(old, old_source, self.language) else {
			return false;
		};
		let Some(after) = semantic_parent(now, &self.source, self.language) else {
			return false;
		};
		before.kind() == after.kind()
			&& field_role(before) == field_role(after)
			&& (before.parent().is_none() && after.parent().is_none()
				|| after.start_byte() == self.shift(before.start_byte()))
			&& after.end_byte() == self.shift(before.end_byte())
	}

	/// Compare every row's complete named ancestry. Existing wrappers keep
	/// their starts; only tokenless wrappers may appear or disappear.
	fn keeps_chain(
		&self,
		original: Node<'_>,
		now: Node<'_>,
		old_source: &str,
		attributes_only: bool,
	) -> bool {
		fn chain(mut node: Node<'_>) -> Option<Vec<Node<'_>>> {
			let mut result = vec![node];
			while let Some(parent) = node.parent() {
				if result.len() > PROOF_DEPTH {
					return None;
				}
				result.push(parent);
				node = parent;
			}
			result.reverse();
			Some(result)
		}
		let (Some(before), Some(after)) = (chain(original), chain(now)) else {
			return false;
		};
		if after.iter().any(|owner| {
			is_case(*owner)
				&& owner.has_error()
				&& error_touches(*owner, self.result_at, self.result_at + self.len)
		}) {
			return false;
		}
		let (mut left, mut right) = (0, 0);
		while left < before.len() && right < after.len() {
			let (old, new) = (before[left], after[right]);
			if old.parent().is_none() && new.parent().is_none() && old.kind() == new.kind() {
				left += 1;
				right += 1;
				continue;
			}
			if attributes_only
				&& new.child_by_field_name("definition").is_some()
				&& (self.result_at..self.result_at + self.len).contains(&new.start_byte())
				&& old.kind() != new.kind()
			{
				right += 1;
				continue;
			}
			if is_case(old) && is_case(new) && self.case_transfer(old, new) {
				left += 1;
				right += 1;
				continue;
			}
			if old.kind() != new.kind() {
				if incidental_list(old, old_source, self.language)
					&& self.persistent_sequence_owner(old, new, old_source)
				{
					left += 1;
					continue;
				}
				if incidental_list(new, &self.source, self.language)
					&& self.persistent_sequence_owner(old, new, old_source)
				{
					right += 1;
					continue;
				}
				return false;
			}
			let new_role = if attributes_only
				&& new.parent().is_some_and(|parent| {
					parent
						.child_by_field_name("definition")
						.is_some_and(|definition| definition.id() == new.id())
						&& (self.result_at..self.result_at + self.len).contains(&parent.start_byte())
				}) {
				new.parent()
					.and_then(|parent| self.identity(parent, true).0)
			} else {
				self.identity(new, true).0
			};
			let old_identity = self.identity(old, false);
			if old_identity.0 != new_role {
				return false;
			}
			if new_role.is_none()
				&& old_identity.0.is_none()
				&& old_identity.1 != self.identity(new, true).1
				&& !(new.start_byte() == self.shift(old.start_byte())
					&& new.end_byte() == self.shift(old.end_byte())
					&& !(statement_container(new)
						&& new.parent().is_some_and(|parent| {
							matches!(
								parent.kind(),
								"if_statement"
									| "if_expression" | "conditional_statement"
									| "try_statement" | "try_expression"
							)
						}))) {
				return false;
			}
			let expected = self.shift(old.start_byte());
			let tokenless = incidental_list(old, old_source, self.language)
				&& incidental_list(new, &self.source, self.language)
				&& field_role(old) == field_role(new)
				&& self.persistent_sequence_owner(old, new, old_source);
			let case_sequence = old.kind() == new.kind()
				&& matches!(old.kind(), "statement_list" | "statements")
				&& incidental_list(old, old_source, self.language)
				&& incidental_list(new, &self.source, self.language)
				&& field_role(old) == field_role(new)
				&& old
					.parent()
					.zip(new.parent())
					.is_some_and(|(old, new)| self.case_transfer(old, new))
				&& old.byte_range().contains(&original.start_byte())
				&& new.byte_range().contains(&now.start_byte())
				&& new.end_byte() == self.shift(old.end_byte());
			// Opaque data content can gain an authored prefix without changing
			// its native kind, field, ordinal, parent ancestry or shifted end.
			if new.start_byte() != expected
				&& !case_sequence
				&& !(new.end_byte() == self.shift(old.end_byte())
					&& old.start_byte() >= self.at
					&& (self.result_at..self.result_at + self.len).contains(&new.start_byte())
					&& (attributes_only || tokenless || self.grows_data_content(old, new, old_source)))
			{
				return false;
			}
			left += 1;
			right += 1;
		}
		before[left..].iter().all(|node| {
			incidental_list(*node, old_source, self.language)
				&& self.persistent_sequence_owner(*node, now, old_source)
		}) && after[right..].iter().all(|node| {
			incidental_list(*node, &self.source, self.language)
				&& self.persistent_sequence_owner(original, *node, old_source)
		})
	}

	/// Every nonblank inserted byte belongs to an outer parsed attribute.
	/// Whitespace between stacked annotations is allowed, code wrappers are
	/// not. Reuses the chosen incremental tree without another parse.
	fn attributes_only(&self) -> bool {
		let spans = self.attachment_spans.get_or_init(|| {
			let mut spans = Vec::new();
			let mut stack = vec![self.tree.root_node()];
			while let Some(node) = stack.pop() {
				let next = self
					.inserted
					.partition_point(|range| range.end <= node.start_byte());
				if self
					.inserted
					.get(next)
					.is_none_or(|range| range.start > node.end_byte())
				{
					continue;
				}
				let attribute = is_attribute_like(node) || is_comment(node);
				if attribute {
					let safe = matches!(
						attribute_owner(node, &self.source, self.language, &self.metadata_owners),
						AttributeOwner::NextItem | AttributeOwner::EnclosingOwner
					);
					spans.push((node.byte_range(), safe));
					if is_comment(node) || self.language == SupportLang::Elixir && safe {
						continue;
					}
				} else if node.is_error()
					|| node.is_missing()
					|| node.is_named()
						&& matches!(
							attachment_target(node, &self.source, self.language),
							AttachmentTarget::Declaration
						) {
					spans.push((node.byte_range(), false));
				}
				let mut cursor = node.walk();
				stack.extend(node.children(&mut cursor));
			}
			spans.sort_unstable_by_key(|(range, _)| range.start);
			spans
		});
		let end = self.result_at + self.len;
		let first = spans.partition_point(|(range, _)| range.start < self.result_at);
		let ranges = spans[first..]
			.iter()
			.take_while(|(range, _)| range.start < end)
			.filter(|(range, _)| range.end <= end);
		let has_attribute = ranges.clone().any(|(_, attribute)| *attribute)
			&& ranges.clone().all(|(_, attribute)| *attribute);
		let mut ranges = ranges.peekable();
		let mut covered = self.result_at;
		has_attribute
			&& self
				.insert
				.char_indices()
				.filter(|(_, ch)| !ch.is_whitespace())
				.all(|(offset, _)| {
					let at = self.result_at + offset;
					while let Some((range, attribute)) =
						ranges.peek().filter(|(range, _)| range.start <= at)
					{
						if *attribute {
							covered = covered.max(range.end);
						}
						ranges.next();
					}
					at < covered
				})
	}

	/// Whether the construct that began at original byte `start` keeps its
	/// whole extent: it ends where it did, shifted by the insertion.
	fn keeps_whole(&self, construct: Node<'_>) -> bool {
		self
			.find(construct.start_byte(), construct.kind())
			.is_some_and(|edited| {
				let end = if self.mapping.is_some() {
					self.shift(construct.end_byte())
				} else {
					construct.end_byte() + self.len
				};
				edited.end_byte() == end
			})
	}

	/// One composed entry proof authorizes both native placement and the
	/// preserved statements receiving a newly stacked traditional label.
	fn new_sibling_parent(&self, statement: Node<'_>) -> bool {
		let Some(mut old) = native_case_owner(if is_case(statement) {
			statement.parent().unwrap_or(statement)
		} else {
			statement
		}) else {
			return false;
		};
		let Some(found) = self.find(statement.start_byte(), statement.kind()) else {
			return false;
		};
		let Some(mut new) = native_case_owner(if is_case(found) {
			found.parent().unwrap_or(found)
		} else {
			found
		}) else {
			return false;
		};
		while !self.introduced_case(new) {
			let Some(before) = old.parent().filter(|parent| is_case(*parent)) else {
				return false;
			};
			let Some(after) = new.parent().filter(|parent| is_case(*parent)) else {
				return false;
			};
			old = before;
			new = after;
		}
		self.case_transfer(old, new)
	}

	fn case_transfer(&self, old: Node<'_>, new: Node<'_>) -> bool {
		if !is_case(old) || !is_case(new) || !self.introduced_case(new) {
			return false;
		}
		let key = (old.id(), new.id());
		if let Some(result) = self.case_snapshot.reachable.borrow().get(&key) {
			return *result;
		}
		let result = self.case_entry_reaches(old, new);
		self
			.case_snapshot
			.reachable
			.borrow_mut()
			.insert(key, result);
		result
	}

	fn case_units(&self) -> &CaseUnits {
		self.case_snapshot.units.get_or_init(|| {
			let mut units = Vec::new();
			let mut introduced = HashSet::new();
			let mut stack = vec![self.tree.root_node()];
			while let Some(node) = stack.pop() {
				if is_comment(node) {
					units.push(CaseUnit {
						range: node.byte_range(),
						kind:  CaseUnitKind::Trivia,
						owner: 0,
					});
					continue;
				}
				if !node.has_error()
					&& begins_case_label(node)
					&& (is_case(node) || node.parent().is_some_and(is_case))
					&& let Some(range) = case_label_range(node)
					&& let Some(owner) = native_case_owner(node)
				{
					if self.wholly_inserted(range.clone()) {
						introduced.insert(owner.id());
					}
					units.push(CaseUnit { range, kind: CaseUnitKind::Label, owner: owner.id() });
				}
				let fallthrough = self.language == SupportLang::Go
					&& node.kind() == "fallthrough_statement"
					|| self.language == SupportLang::Swift
						&& node.kind() == "simple_identifier"
						&& node
							.parent()
							.is_some_and(|parent| parent.kind() == "statements")
						&& &self.source[node.byte_range()] == "fallthrough";
				if fallthrough {
					let end = node
						.next_sibling()
						.filter(|next| !next.is_named() && next.kind() == ";")
						.map_or_else(|| node.end_byte(), |next| next.end_byte());
					units.push(CaseUnit {
						range: node.start_byte()..end,
						kind:  CaseUnitKind::Fallthrough,
						owner: 0,
					});
					continue;
				}
				let mut cursor = node.walk();
				stack.extend(node.children(&mut cursor));
			}
			units.sort_unstable_by_key(|unit| (unit.range.start, unit.range.end, unit.owner));
			units.dedup_by(|left, right| {
				left.range == right.range && left.kind == right.kind && left.owner == right.owner
			});
			CaseUnits { units, introduced }
		})
	}

	fn introduced_case(&self, owner: Node<'_>) -> bool {
		if !is_case(owner) {
			return false;
		}
		self.wholly_inserted(owner.start_byte()..owner.start_byte().saturating_add(1))
			|| self.case_units().introduced.contains(&owner.id())
	}

	/// Explicitly contextualized work may remain in the counterfactual.
	/// Select the first preserved member that actually receives this label.
	fn case_first_receiver(&self, mut old: Node<'_>, receiving: Node<'_>) -> Option<Node<'_>> {
		let header = case_label_range(old)?;
		loop {
			let mut cursor = old.walk();
			let mut container = None;
			for member in old.named_children(&mut cursor) {
				if member.start_byte() < header.end
					|| is_comment(member)
					|| begins_case_label(member) && !(is_case(member) && member.kind() != "switch_label")
				{
					continue;
				}
				if matches!(member.kind(), "statement_list" | "statements") {
					container = Some(member);
					break;
				}
				let Some(mapped) = self.find(member.start_byte(), member.kind()) else {
					continue;
				};
				let Some(mut owner) = native_case_owner(mapped) else {
					continue;
				};
				loop {
					if owner.id() == receiving.id() {
						return Some(mapped);
					}
					let Some(parent) = owner.parent().filter(|parent| is_case(*parent)) else {
						break;
					};
					owner = parent;
				}
			}
			old = container?;
		}
	}

	fn case_entry_reaches(&self, old: Node<'_>, receiving: Node<'_>) -> bool {
		let explicit = matches!(self.language, SupportLang::Go | SupportLang::Swift);
		if !matches!(
			self.language,
			SupportLang::Go
				| SupportLang::Swift
				| SupportLang::C
				| SupportLang::Cpp
				| SupportLang::CSharp
				| SupportLang::Java
				| SupportLang::JavaScript
				| SupportLang::TypeScript
				| SupportLang::Tsx
				| SupportLang::Php
		) || old.has_error()
			|| receiving.has_error()
		{
			return false;
		}
		let entry = old
			.named_child(0)
			.filter(|label| begins_case_label(*label))
			.and_then(|label| self.find(label.start_byte(), label.kind()))
			.or_else(|| self.find(old.start_byte(), old.kind()));
		let Some(entry) = entry else {
			return false;
		};
		let Some(before_host) = native_case_host(old, self.language) else {
			return false;
		};
		let Some(after_host) = native_case_host(receiving, self.language) else {
			return false;
		};
		if before_host.kind() != after_host.kind()
			|| field_role(before_host) != field_role(after_host)
			|| after_host.start_byte() != self.shift(before_host.start_byte())
			|| after_host.end_byte() != self.shift(before_host.end_byte())
			|| native_case_host(entry, self.language).is_none_or(|host| host.id() != after_host.id())
		{
			return false;
		}
		let Some(first) = self.case_first_receiver(old, receiving) else {
			return false;
		};
		let Some(header) = case_label_range(entry) else {
			return false;
		};
		let prefix = header.end..first.start_byte();
		if prefix.start > prefix.end {
			return false;
		}
		let units = &self.case_units().units;
		let begin = units.partition_point(|unit| unit.range.start < prefix.start);
		let mut covered = prefix.start;
		let (mut labels, mut fallthroughs, mut previous) = (0, 0, None);
		for unit in units[begin..]
			.iter()
			.take_while(|unit| unit.range.start < prefix.end)
		{
			if unit.range.end > prefix.end
				|| !self.source[covered..covered.max(unit.range.start)]
					.chars()
					.all(char::is_whitespace)
			{
				return false;
			}
			match unit.kind {
				CaseUnitKind::Trivia => {},
				CaseUnitKind::Label => {
					if self.wholly_inserted(unit.range.clone()) {
						labels += 1;
						if explicit && previous != Some(CaseUnitKind::Fallthrough) {
							return false;
						}
					} else {
						let mut cursor = old.walk();
						let retained = old.named_children(&mut cursor).any(|label| {
							begins_case_label(label)
								&& case_label_range(label).is_some_and(|range| {
									self.shift(range.start) == unit.range.start
										&& self.shift(range.end) == unit.range.end
								})
						});
						if !retained {
							return false;
						}
					}
					previous = Some(CaseUnitKind::Label);
				},
				CaseUnitKind::Fallthrough => {
					if !explicit {
						return false;
					}
					fallthroughs += 1;
					previous = Some(CaseUnitKind::Fallthrough);
				},
			}
			covered = covered.max(unit.range.end);
		}
		(labels > 0
			&& (!explicit
				|| labels == 1 && fallthroughs == 1 && previous == Some(CaseUnitKind::Label))
			|| labels == 0
				&& !explicit
				&& native_case_owner(entry).is_some_and(|owner| owner.id() == receiving.id()))
			&& self.source[covered..prefix.end]
				.chars()
				.all(char::is_whitespace)
	}

	/// Whether the outermost node beginning at original byte `start` now ends
	/// inside the inserted lines.
	fn ends_within(&self, start: usize) -> bool {
		let start = self.shift(start);
		let root = self.tree.root_node();
		let mut outermost = None;
		let mut current = root.descendant_for_byte_range(start, start);
		while let Some(node) = current.filter(|node| node.id() != root.id()) {
			if node.start_byte() == start {
				outermost = Some(node);
			}
			current = node.parent();
		}
		outermost.is_some_and(|node| self.rows.contains(&content_end_row(node)))
	}

	/// Whether the original `attribute` now belongs to the inserted lines.
	fn captures(&self, attribute: Node<'_>) -> bool {
		if attribute.start_byte() >= self.at {
			return false;
		}
		self
			.find(attribute.start_byte(), attribute.kind())
			.and_then(|attribute| {
				attributed_content(attribute, &self.source, self.language, &self.metadata_owners)
			})
			.is_some_and(|content| self.rows.contains(&content.start_position().row))
	}

	/// Whether the inserted lines join `construct`'s header as a new part of
	/// a kind the anchor's line does not have, or split the construct from
	/// its body.
	fn grows_header(&self, construct: Node<'_>, kinds: &[&str]) -> bool {
		let Some(edited) = self.find(construct.start_byte(), construct.kind()) else {
			return true;
		};
		if edited.end_byte() != self.shift(construct.end_byte()) {
			return true;
		}
		let mut cursor = edited.walk();
		edited
			.children(&mut cursor)
			.enumerate()
			.any(|(index, child)| {
				child.is_named()
					&& child.start_byte() >= self.result_at
					&& child.end_byte() <= self.result_at + self.len
					&& !child.is_extra()
					&& !kinds.contains(&child.kind())
					&& edited.field_name_for_child(index as u32) != Some("body")
			})
	}
}

/// `ERROR` and `MISSING` nodes under `root` touching `[start, end]`, in
/// source order.
fn error_nodes(root: Node<'_>, start: usize, end: usize) -> Vec<Node<'_>> {
	let mut found = Vec::new();
	let mut stack = vec![root];
	while let Some(node) = stack.pop() {
		if node.end_byte() < start || node.start_byte() > end {
			continue;
		}
		if node.is_error() || node.is_missing() {
			found.push(node);
			continue;
		}
		if node.has_error() {
			let mut cursor = node.walk();
			let pushed = stack.len();
			stack.extend(node.children(&mut cursor));
			stack[pushed..].reverse();
		}
	}
	found
}

fn error_touches(root: Node<'_>, start: usize, end: usize) -> bool {
	let mut cursor = root.walk();
	loop {
		let node = cursor.node();
		if node.end_byte() >= start && node.start_byte() <= end {
			if node.is_error() || node.is_missing() {
				return true;
			}
			if node.has_error() && cursor.goto_first_child() {
				continue;
			}
		}
		while !cursor.goto_next_sibling() {
			if !cursor.goto_parent() {
				return false;
			}
		}
	}
}

/// `ERROR` and `MISSING` nodes under `root` touching `[start, end]`, and
/// those elsewhere.
fn error_counts(root: Node<'_>, start: usize, end: usize) -> (usize, usize) {
	let (mut inside, mut outside) = (0, 0);
	let mut stack = vec![root];
	while let Some(node) = stack.pop() {
		if node.is_error() || node.is_missing() {
			if node.start_byte() <= end && node.end_byte() >= start {
				inside += 1;
			} else {
				outside += 1;
			}
			continue;
		}
		if node.has_error() {
			let mut cursor = node.walk();
			stack.extend(node.children(&mut cursor));
		}
	}
	(inside, outside)
}

/// First outermost named node beginning at or after a byte gap. Comments
/// are not the statement whose ownership is load-bearing.
fn first_named_after<'t>(
	root: Node<'t>,
	at: usize,
	attachments: Option<(&str, SupportLang, &MetadataOwners)>,
) -> Option<Node<'t>> {
	let mut cursor = root.walk();
	loop {
		let node = cursor.node();
		let skip = attachments.is_some_and(|(code, language, owners)| {
			is_attribute_like(node)
				&& matches!(
					attribute_owner(node, code, language, owners),
					AttributeOwner::NextItem | AttributeOwner::EnclosingOwner
				)
		});
		if node.id() != root.id()
			&& node.is_named()
			&& !node.is_extra()
			&& !is_comment(node)
			&& (!statement_container(node)
				|| attachments.is_some_and(|(_, language, _)| {
					language == SupportLang::Hcl && node.kind() == "block"
				})) && !declaration_container(node)
			&& node.start_byte() >= at
			&& !skip
		{
			return Some(node);
		}
		if !skip
			&& node.end_byte() > at
			&& (cursor.goto_first_child_for_byte(at).is_some() || cursor.goto_first_child())
		{
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				return None;
			}
		}
	}
}

/// A body/list wrapper with no delimiters or keywords of its own. Statement
/// terminators (explicit or whitespace-consuming) do not bound a list.
fn incidental_list(node: Node<'_>, code: &str, language: SupportLang) -> bool {
	let unheaded_section = language == SupportLang::Markdown
		&& node.kind() == "section"
		&& !node.has_error()
		&& !node.is_missing()
		&& node
			.named_child(0)
			.is_some_and(|first| !matches!(first.kind(), "atx_heading" | "setext_heading"));
	if !(language.tokenless_sequence_kind(node.kind()) || unheaded_section)
		|| node.kind() == "block_node"
			&& node
				.named_child(0)
				.is_none_or(|child| !matches!(child.kind(), "block_mapping" | "block_sequence"))
	{
		return false;
	}
	let mut cursor = node.walk();
	node.named_child_count() > 0
		&& node.children(&mut cursor).all(|child| {
			child.is_named()
				|| child.is_extra()
				|| child.kind() == ";"
				|| code[child.byte_range()].trim().is_empty()
		})
}

fn field_role(node: Node<'_>) -> Option<&'static str> {
	let parent = node.parent()?;
	let mut cursor = parent.walk();
	cursor.goto_first_child_for_byte(node.start_byte())?;
	while cursor.node().id() != node.id() {
		if !cursor.goto_next_sibling() {
			return None;
		}
	}
	cursor.field_name()
}

fn declaration_container(node: Node<'_>) -> bool {
	matches!(node.kind(), "declarations" | "document")
}

fn statement_container(node: Node<'_>) -> bool {
	BODY_KINDS.contains(&node.kind())
		|| matches!(node.kind(), "statement_list" | "statements" | "body" | "indented_block")
}

fn else_on_row(node: Node<'_>, row: usize) -> bool {
	let mut cursor = node.walk();
	node.children(&mut cursor).any(|child| {
		!child.is_extra()
			&& child.child_count() == 0
			&& child.kind() == "else"
			&& child.start_position().row == row
	})
}

/// The body an anchor on an `else` line of `node` (beginning at `row`,
/// `col`) belongs to: the `else` block, an `else if`'s consequence, or the
/// bare statement standing as the `else` branch.
fn else_branch(node: Node<'_>, row: usize, _col: usize) -> Option<Node<'_>> {
	let on_else = else_on_row(node, row);
	let alternative = if node.kind() == "else_clause" {
		let mut cursor = node.walk();
		node
			.named_children(&mut cursor)
			.find(|child| !child.is_extra())?
	} else {
		if !on_else {
			return None;
		}
		node.child_by_field_name("alternative")?
	};
	if is_body(alternative) || alternative.start_position().row > row {
		return Some(alternative);
	}
	alternative
		.child_by_field_name("consequence")
		.filter(|body| body.start_position().row > row)
		.or_else(|| body_of(alternative))
}

/// Whether every non-blank line of `text` (at least one) starts with the
/// whitespace `base` and adds more: a tab-indented file's space-indented
/// line is no deeper than its tabs, whatever their widths.
fn deeper_than(text: &str, base: &str) -> bool {
	let mut lines = text
		.lines()
		.filter(|line| !line.trim().is_empty())
		.peekable();
	lines.peek().is_some()
		&& lines.all(|line| line.starts_with(base) && indentation(line) > base.len())
}

/// The width of `text`'s leading spaces and tabs.
fn indentation(text: &str) -> usize {
	text.len() - text.trim_start_matches([' ', '\t']).len()
}

fn sibling_after(node: Node<'_>, accepts: impl Fn(Node<'_>) -> bool) -> Option<Node<'_>> {
	let parent = node.parent()?;
	let mut cursor = parent.walk();
	cursor.goto_first_child_for_byte(node.start_byte())?;
	while cursor.node().id() != node.id() {
		if !cursor.goto_next_sibling() {
			return None;
		}
	}
	while cursor.goto_next_sibling() {
		let sibling = cursor.node();
		if accepts(sibling) {
			return Some(sibling);
		}
	}
	None
}

fn sibling_before(node: Node<'_>, accepts: impl Fn(Node<'_>) -> bool) -> Option<Node<'_>> {
	let parent = node.parent()?;
	let mut cursor = parent.walk();
	let mut previous = None;
	for sibling in parent.children(&mut cursor) {
		if sibling.id() == node.id() {
			break;
		}
		if accepts(sibling) {
			previous = Some(sibling);
		}
	}
	previous
}

/// A trailing sibling run, visited once in source order. Repeated
/// `prev_named_sibling` queries re-walk large tree-sitter child arrays.
fn preceding_run(node: Node<'_>, accepts: impl Fn(Node<'_>) -> bool) -> Vec<Node<'_>> {
	let Some(parent) = node.parent() else {
		return Vec::new();
	};
	let mut run = Vec::new();
	let mut cursor = parent.walk();
	for sibling in parent.named_children(&mut cursor) {
		if sibling.id() == node.id() {
			break;
		}
		if accepts(sibling) {
			run.push(sibling);
		} else {
			run.clear();
		}
	}
	run
}

/// The attributes, decorators and annotations of `construct`: its own (also
/// inside its `modifiers` or Odin `attributes`), those of a wrapper whose
/// definition it is, and those preceding it as siblings.
fn attributes_of(construct: Node<'_>) -> Vec<Node<'_>> {
	fn collect<'tree>(holder: Node<'tree>, attributes: &mut Vec<Node<'tree>>) {
		let mut cursor = holder.walk();
		for child in holder.named_children(&mut cursor) {
			if is_attribute_like(child) {
				attributes.push(child);
			} else if matches!(child.kind(), "modifiers" | "attributes") {
				let mut inner = child.walk();
				attributes.extend(
					child
						.named_children(&mut inner)
						.filter(|node| is_attribute_like(*node)),
				);
			}
		}
	}
	let mut attributes = Vec::new();
	collect(construct, &mut attributes);
	let holder = construct
		.parent()
		.filter(|parent| {
			parent
				.child_by_field_name("definition")
				.is_some_and(|definition| definition.id() == construct.id())
		})
		.unwrap_or(construct);
	if holder.id() != construct.id() {
		collect(holder, &mut attributes);
	}
	for sibling in preceding_run(holder, |sibling| is_attribute_like(sibling) || sibling.is_extra())
		.into_iter()
		.rev()
	{
		if is_attribute_like(sibling) {
			attributes.push(sibling);
		}
	}
	attributes
}

#[derive(Clone, Copy)]
enum AttributeOwner {
	NextItem,
	EnclosingOwner,
	DeclaredItem,
	Unknown,
}

#[derive(Default, Clone)]
struct MetadataCache {
	owners:       HashMap<usize, AttributeOwner>,
	depth_errors: Vec<Range<usize>>,
}

type MetadataOwners = RefCell<MetadataCache>;

fn attribute_owner(
	node: Node<'_>,
	code: &str,
	language: SupportLang,
	owners: &MetadataOwners,
) -> AttributeOwner {
	let category = attribute_category(node, code, language);
	if language != SupportLang::Elixir
		|| !is_attribute_like(node)
		|| !matches!(category, AttributeOwner::NextItem | AttributeOwner::EnclosingOwner)
	{
		return category;
	}
	if let Some(owner) = owners.borrow().owners.get(&node.id()) {
		return *owner;
	}
	let proof = metadata_payload_proof(node, code, language);
	let owner = if matches!(proof, MetadataCertainty::Safe) {
		category
	} else {
		AttributeOwner::Unknown
	};
	let mut cache = owners.borrow_mut();
	if matches!(proof, MetadataCertainty::TooDeep) {
		cache.depth_errors.push(node.byte_range());
	}
	cache.owners.insert(node.id(), owner);
	owner
}

#[derive(Clone, Copy)]
enum MetadataCertainty {
	Safe,
	Unknown,
	TooDeep,
}

#[derive(Clone, Copy)]
struct MetadataQuote {
	escapes: bool,
}

#[derive(Clone, Copy)]
enum MetadataMode {
	Evaluated,
	Quote(MetadataQuote),
	Options(MetadataQuote),
	OptionPair(MetadataQuote, bool),
	Quoted(bool),
}

fn elixir_call_child<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
	let mut cursor = node.walk();
	node
		.named_children(&mut cursor)
		.find(|child| child.kind() == kind)
}

fn elixir_operation(node: Node<'_>, code: &str, name: &str) -> bool {
	node.kind() == "call"
		&& node
			.child_by_field_name("target")
			.is_some_and(|target| target.kind() == "identifier" && &code[target.byte_range()] == name)
}

fn metadata_keyword<'code>(pair: Node<'_>, code: &'code str) -> Option<&'code str> {
	let key = pair.child_by_field_name("key")?;
	(key.kind() == "keyword")
		.then(|| code[key.byte_range()].trim())
		.and_then(|key| key.strip_suffix(':'))
}

fn metadata_boolean(
	mut node: Node<'_>,
	code: &str,
	mut depth: usize,
) -> std::result::Result<Option<bool>, MetadataCertainty> {
	loop {
		if depth > PROOF_DEPTH {
			return Err(MetadataCertainty::TooDeep);
		}
		if node.is_missing() || node.has_error() {
			return Err(MetadataCertainty::Unknown);
		}
		if node.kind() == "boolean" {
			return Ok(match &code[node.byte_range()] {
				"true" => Some(true),
				"false" => Some(false),
				_ => None,
			});
		}
		if node.kind() != "block" || node.named_child_count() != 1 {
			return Ok(None);
		}
		let Some(child) = node.named_child(0) else {
			return Ok(None);
		};
		node = child;
		depth += 1;
	}
}

fn metadata_quote(
	node: Node<'_>,
	code: &str,
	depth: usize,
) -> std::result::Result<MetadataQuote, MetadataCertainty> {
	let Some(arguments) = elixir_call_child(node, "arguments") else {
		return Ok(MetadataQuote { escapes: true });
	};
	let mut bound = false;
	let mut explicit = None;
	let mut groups = arguments.walk();
	for group in arguments.named_children(&mut groups) {
		let group = if group.kind() == "list" && group.named_child_count() == 1 {
			group.named_child(0).ok_or(MetadataCertainty::Unknown)?
		} else {
			group
		};
		if group.kind() != "keywords" {
			return Err(MetadataCertainty::Unknown);
		}
		let mut pairs = group.walk();
		for pair in group.named_children(&mut pairs) {
			if pair.kind() != "pair" {
				return Err(MetadataCertainty::Unknown);
			}
			let key = metadata_keyword(pair, code).ok_or(MetadataCertainty::Unknown)?;
			if key == "bind_quoted" {
				bound = true;
			} else if key == "unquote" {
				if explicit.is_some() {
					return Err(MetadataCertainty::Unknown);
				}
				let value = pair
					.child_by_field_name("value")
					.ok_or(MetadataCertainty::Unknown)?;
				let mut at = value;
				let mut value_depth = depth;
				while at.id() != node.id() {
					value_depth += 1;
					if value_depth > PROOF_DEPTH {
						return Err(MetadataCertainty::TooDeep);
					}
					at = at.parent().ok_or(MetadataCertainty::Unknown)?;
				}
				explicit =
					Some(metadata_boolean(value, code, value_depth)?.ok_or(MetadataCertainty::Unknown)?);
			}
		}
	}
	Ok(MetadataQuote { escapes: explicit.unwrap_or(!bound) })
}

/// Quoted bodies are data; quote options and enabled unquote arguments are
/// evaluated. A data ancestor cannot certify those evaluated expressions.
fn metadata_payload_proof(
	attribute: Node<'_>,
	code: &str,
	language: SupportLang,
) -> MetadataCertainty {
	if attribute.has_error() || attribute.is_missing() {
		return MetadataCertainty::Unknown;
	}
	let Some(call) = attribute
		.named_child(0)
		.filter(|node| node.kind() == "call")
	else {
		return MetadataCertainty::Unknown;
	};
	let Some(payload) = elixir_call_child(call, "arguments") else {
		return MetadataCertainty::Unknown;
	};
	let body = elixir_call_child(call, "do_block");
	// The installed grammar attaches a no-parentheses quote's block to the
	// metadata call. Only its sole native quote operand can own that block.
	let quote = payload.named_child(0).filter(|node| {
		payload.named_child_count() == 1
			&& (elixir_operation(*node, code, "quote")
				|| body.is_some() && node.kind() == "identifier" && &code[node.byte_range()] == "quote")
	});
	let root_quote = match quote {
		Some(quote) => match metadata_quote(quote, code, 3) {
			Ok(settings) => {
				if body.is_some() && elixir_call_child(quote, "do_block").is_some() {
					return MetadataCertainty::Unknown;
				}
				Some((quote.id(), settings))
			},
			Err(reason) => return reason,
		},
		None => None,
	};
	let signature = call
		.child_by_field_name("target")
		.is_some_and(|target| &code[target.byte_range()] == "spec")
		&& payload.named_child_count() == 1
		&& payload.named_child(0).is_some_and(|node| {
			node.kind() == "binary_operator" && {
				let mut cursor = node.walk();
				node
					.children(&mut cursor)
					.any(|operator| !operator.is_named() && &code[operator.byte_range()] == "::")
			}
		});
	let mut modes = [MetadataMode::Evaluated; PROOF_DEPTH + 1];
	let mut cursor = call.walk();
	let mut depth = 1; // attribute -> call; all native child edges count.
	loop {
		let node = cursor.node();
		if depth > PROOF_DEPTH {
			return MetadataCertainty::TooDeep;
		}
		if node.is_error() || node.is_missing() {
			return MetadataCertainty::Unknown;
		}
		let mut mode = modes[depth];
		if signature && node.id() == payload.id() {
			mode = MetadataMode::Quoted(true);
		} else if body.is_some_and(|body| body.id() == node.id())
			&& let Some((_, settings)) = root_quote
		{
			mode = MetadataMode::Quoted(settings.escapes);
		}
		let target = cursor.field_name() == Some("target")
			&& node.parent().is_some_and(|parent| parent.kind() == "call");
		let mut descend = !target;
		if node.is_named() && !target {
			mode = match mode {
				MetadataMode::Quote(settings) => match node.kind() {
					"arguments" => MetadataMode::Options(settings),
					"do_block" => MetadataMode::Quoted(settings.escapes),
					_ => return MetadataCertainty::Unknown,
				},
				MetadataMode::Options(settings) => match node.kind() {
					"arguments" | "keywords" | "list" => mode,
					"pair" => {
						MetadataMode::OptionPair(settings, metadata_keyword(node, code) == Some("do"))
					},
					_ => return MetadataCertainty::Unknown,
				},
				MetadataMode::OptionPair(settings, quoted) => match cursor.field_name() {
					Some("key") => {
						descend = false;
						mode
					},
					Some("value") if quoted => MetadataMode::Quoted(settings.escapes),
					Some("value") => MetadataMode::Evaluated,
					_ => return MetadataCertainty::Unknown,
				},
				_ => mode,
			};
			if matches!(mode, MetadataMode::Quoted(false)) {
				descend = false;
			} else if matches!(mode, MetadataMode::Quoted(true)) {
				if elixir_operation(node, code, "unquote")
					|| elixir_operation(node, code, "unquote_splicing")
				{
					mode = MetadataMode::Evaluated;
				}
			} else if matches!(mode, MetadataMode::Evaluated) && node.id() != call.id() {
				if let Some((_, settings)) = root_quote.filter(|(id, _)| *id == node.id()) {
					mode = MetadataMode::Quote(settings);
				} else if elixir_operation(node, code, "quote") {
					mode = match metadata_quote(node, code, depth) {
						Ok(settings) => MetadataMode::Quote(settings),
						Err(reason) => return reason,
					};
				} else if is_attribute_like(node)
					&& matches!(
						attribute_category(node, code, language),
						AttributeOwner::DeclaredItem | AttributeOwner::Unknown
					) || matches!(
					evaluated_attachment_target(node, code, language),
					AttachmentTarget::Declaration
				) || matches!(node.kind(), "call" | "identifier" | "binary_operator")
				{
					return MetadataCertainty::Unknown;
				}
			}
		}
		modes[depth] = mode;
		if descend && cursor.goto_first_child() {
			depth += 1;
			if depth <= PROOF_DEPTH {
				modes[depth] = mode;
			}
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				modes[depth] = modes[depth - 1];
				break;
			}
			if !cursor.goto_parent() {
				return MetadataCertainty::Safe;
			}
			depth -= 1;
		}
	}
}

fn attribute_category(node: Node<'_>, code: &str, language: SupportLang) -> AttributeOwner {
	if node.kind() == "inner_attribute_item"
		|| code[node.byte_range()].starts_with("#![")
		|| language == SupportLang::Rust
			&& is_comment(node)
			&& node.child_by_field_name("inner").is_some()
	{
		return AttributeOwner::EnclosingOwner;
	}
	if language == SupportLang::Elixir && is_attribute_like(node) {
		let name = code[node.byte_range()]
			.trim_start()
			.strip_prefix('@')
			.unwrap_or_default()
			.split(|ch: char| !ch.is_alphanumeric() && ch != '_')
			.next()
			.unwrap_or_default();
		return match name {
			"doc" | "typedoc" | "spec" | "impl" | "derive" => AttributeOwner::NextItem,
			"moduledoc" | "behaviour" | "behavior" | "compile" | "on_load" | "before_compile"
			| "after_compile" | "on_definition" | "external_resource" | "vsn" => {
				AttributeOwner::EnclosingOwner
			},
			"type" | "typep" | "opaque" | "callback" | "macrocallback" => AttributeOwner::DeclaredItem,
			_ => AttributeOwner::Unknown,
		};
	}
	if language == SupportLang::Erlang {
		return match node.kind() {
			"spec" => AttributeOwner::NextItem,
			"opaque" | "type_alias" => AttributeOwner::DeclaredItem,
			_ => AttributeOwner::Unknown,
		};
	}
	if language == SupportLang::CSharp
		&& code[node.byte_range()]
			.trim_start()
			.starts_with("[assembly:")
	{
		return AttributeOwner::EnclosingOwner;
	}
	if is_attribute_like(node) || is_comment(node) {
		AttributeOwner::NextItem
	} else {
		AttributeOwner::Unknown
	}
}

fn next_attachment_item<'t>(
	node: Node<'t>,
	code: &str,
	language: SupportLang,
	owners: &MetadataOwners,
) -> Option<Node<'t>> {
	sibling_after(node, |next| {
		next.is_named()
			&& !next.is_extra()
			&& (!is_attribute_like(next)
				|| matches!(
					attribute_owner(next, code, language, owners),
					AttributeOwner::DeclaredItem | AttributeOwner::Unknown
				))
	})
}

/// The item an attribute applies to: a declaration whose leading run holds
/// next-item metadata, the declared item itself, or its enclosing module.
fn attributed_item<'t>(
	attribute: Node<'t>,
	code: &str,
	language: SupportLang,
	owners: &MetadataOwners,
) -> Option<Node<'t>> {
	match attribute_owner(attribute, code, language, owners) {
		AttributeOwner::DeclaredItem => return Some(attribute),
		AttributeOwner::Unknown => return None,
		AttributeOwner::EnclosingOwner => {
			let mut owner = attribute.parent()?;
			loop {
				let module = matches!(
					owner.kind(),
					"mod_item"
						| "module" | "module_definition"
						| "module_declaration"
						| "internal_module"
						| "namespace_definition"
						| "namespace_declaration"
						| "file_scoped_namespace_declaration"
				) || language == SupportLang::Elixir
					&& owner
						.child_by_field_name("target")
						.is_some_and(|target| &code[target.byte_range()] == "defmodule");
				if module || owner.parent().is_none() {
					return Some(owner);
				}
				owner = owner.parent()?;
			}
		},
		AttributeOwner::NextItem => {},
	}
	let mut held = attribute;
	let mut owner = attribute.parent()?;
	while matches!(
		owner.kind(),
		"modifiers" | "attribute_list" | "attribute_declaration" | "attributes"
	) {
		held = owner;
		owner = owner.parent()?;
	}
	if owner.parent().is_none() || is_body(owner) {
		return next_attachment_item(attribute, code, language, owners);
	}
	let mut previous = held.prev_sibling();
	while let Some(sibling) = previous {
		let leading = is_attribute_like(sibling)
			|| sibling.is_extra()
			|| matches!(sibling.kind(), "modifiers" | "modifier");
		if !leading {
			return None;
		}
		previous = sibling.prev_sibling();
	}
	Some(owner)
}

/// The first node of the item `attribute` applies to that is not itself an
/// attribute or modifier list: the next sibling when the attribute stands in
/// a body or the file, otherwise the first such part of its owner.
fn attributed_content<'t>(
	attribute: Node<'t>,
	code: &str,
	language: SupportLang,
	owners: &MetadataOwners,
) -> Option<Node<'t>> {
	if !matches!(attribute_owner(attribute, code, language, owners), AttributeOwner::NextItem) {
		return attributed_item(attribute, code, language, owners);
	}
	let mut owner = attribute.parent()?;
	while owner.kind() == "modifiers" {
		owner = owner.parent()?;
	}
	if owner.parent().is_none() || is_body(owner) {
		return next_attachment_item(attribute, code, language, owners);
	}
	let mut cursor = owner.walk();
	owner
		.named_children(&mut cursor)
		.find(|child| !is_attribute_like(*child) && child.kind() != "modifiers" && !child.is_extra())
}

/// The row of `construct`'s header proper, past its attributes and their
/// modifier list.
fn header_row(construct: Node<'_>) -> usize {
	let header = construct.child_by_field_name("definition").or_else(|| {
		let mut cursor = construct.walk();
		construct.children(&mut cursor).find(|child| {
			let annotated_modifiers = matches!(child.kind(), "modifiers" | "attributes") && {
				let mut inner = child.walk();
				child
					.named_children(&mut inner)
					.any(|node| is_attribute_like(node))
			};
			!is_attribute_like(*child) && !child.is_extra() && !annotated_modifiers
		})
	});
	header.unwrap_or(construct).start_position().row
}

/// The ancestry after an opener's certified closing token contains only
/// closing punctuation and parsed trivia, even when comments span rows.
fn closing_tail(node: Node<'_>, top: Node<'_>) -> bool {
	let mut current = node;
	while current.id() != top.id() {
		let Some(parent) = current.parent() else {
			return false;
		};
		let mut cursor = parent.walk();
		let mut after = false;
		for sibling in parent.children(&mut cursor) {
			if sibling.id() == current.id() {
				after = true;
				continue;
			}
			if after
				&& !sibling.is_extra()
				&& !is_comment(sibling)
				&& (sibling.is_named() || !matches!(sibling.kind(), ")" | "]" | "}" | ";" | ","))
			{
				return false;
			}
		}
		current = parent;
	}
	true
}

/// Tokens closing a keyword-led construct.
const CLOSING_KEYWORDS: [&str; 12] = [
	"end",
	"fi",
	"done",
	"esac",
	"endif",
	"endwhile",
	"endfor",
	"endforeach",
	"endswitch",
	"endfunction",
	"endmodule",
	"endcase",
];

/// Start and end tags of markup elements.
const START_TAGS: [&str; 3] = ["start_tag", "STag", "jsx_opening_element"];
const END_TAGS: [&str; 3] = ["end_tag", "ETag", "jsx_closing_element"];

/// A node holding a construct's statements or members.
fn is_body(node: Node<'_>) -> bool {
	BODY_KINDS.contains(&node.kind())
		|| node
			.parent()
			.and_then(|parent| parent.child_by_field_name("body"))
			.is_some_and(|body| body.id() == node.id())
}

fn row_to_line(row: usize) -> u32 {
	row.saturating_add(1).min(u32::MAX as usize) as u32
}

/// Attribute, decorator and annotation lines that precede the item they
/// belong to as a separate node: Rust, C#, C/C++ (`[[…]]`), Python, Java and
/// TypeScript forms, and Swift's `@` attributes (an `attribute` node elsewhere
/// is member access or sits inside an attribute list). A Rust inner
/// attribute (`#![…]`) is recognized here; its enclosing ownership is
/// distinguished by `attribute_owner`.
fn is_attribute_like(node: Node<'_>) -> bool {
	match node.kind() {
		"attribute_item"
		| "inner_attribute_item"
		| "spec"
		| "attribute_list"
		| "attribute_declaration"
		| "decorator"
		| "annotation"
		| "marker_annotation" => true,
		"attribute_group" => node
			.parent()
			.is_some_and(|parent| parent.kind() == "attribute_list"),
		"attribute" | "unary_operator" => node
			.child(0)
			.is_some_and(|first| !first.is_named() && first.kind() == "@"),
		_ => false,
	}
}

/// A physical boundary candidate, not proof of an effective language splice.
///
/// Host phases and malformed Python boundaries may have horizontal whitespace
/// after the slash; lexical snapshots decide their actual obligation.
pub fn has_continuation_candidate(source: &str) -> bool {
	physical_continuation_boundaries(source).next().is_some()
}

fn physical_continuation_boundaries(source: &str) -> impl Iterator<Item = Range<usize>> + '_ {
	source
		.split_inclusive('\n')
		.scan(0, |start, row| {
			let end = *start + row.len();
			let tail = row.trim_end_matches(['\n', '\r', ' ', '\t']);
			let range =
				(row.ends_with('\n') && tail.ends_with('\\')).then(|| *start + tail.len() - 1..end);
			*start = end;
			Some(range)
		})
		.flatten()
}

fn python_statement(node: Node<'_>, parent: Option<Node<'_>>) -> Option<LogicalUnit> {
	if !node.is_named()
		|| node.is_extra()
		|| !(node.kind().ends_with("_statement")
			|| node.kind().ends_with("_definition")
			|| node.kind().ends_with("_clause"))
	{
		return None;
	}
	let construct = if node.kind() == "decorated_definition" {
		node.child_by_field_name("definition")?
	} else {
		node
	};
	let body = ["body", "consequence"]
		.into_iter()
		.find_map(|field| {
			construct
				.child_by_field_name(field)
				.filter(|body| body.kind() == "block")
		})
		.or_else(|| {
			let mut cursor = construct.walk();
			construct
				.named_children(&mut cursor)
				.find(|child| child.kind() == "block")
		});
	let statement = parent.is_some_and(|parent| matches!(parent.kind(), "module" | "block"))
		&& (node.kind().ends_with("_statement") || node.kind().ends_with("_definition"));
	let clause = node.kind().ends_with("_clause")
		&& body.is_some()
		&& parent.is_some_and(|parent| {
			parent.kind() == "block"
				|| parent.kind().ends_with("_statement")
				|| parent.kind().ends_with("_clause")
		});
	if !statement && !clause {
		return None;
	}
	let end = body.map_or_else(|| node.end_byte(), |body| body.start_byte());
	let certain = !node.is_missing()
		&& if body.is_some() {
			!error_touches(node, node.start_byte(), end.saturating_sub(1))
		} else {
			!node.has_error()
		};
	Some(LogicalUnit {
		range: node.start_byte()..end,
		language: SupportLang::Python,
		statement: Some(node.kind_id()),
		certain,
	})
}

fn code_continuations<'a>(
	source: &'a str,
	roles: &'a RoleSpans,
) -> impl Iterator<Item = Range<usize>> + 'a {
	let mut role = 0;
	source.match_indices('\\').filter_map(move |(at, _)| {
		let end = match source.as_bytes().get(at + 1..) {
			Some([b'\n', ..]) => at + 2,
			Some([b'\r', b'\n', ..]) => at + 3,
			_ => return None,
		};
		while role < roles.len() && roles[role].0.end <= at {
			role += 1;
		}
		if let Some((range, lexical)) = roles.get(role).filter(|(range, _)| range.contains(&at)) {
			let LexicalRole::Escape(dialect) = lexical else {
				return None;
			};
			if range.start != at
				|| range.end != end
				|| !matches!(
					literal_escape_policy(*dialect, roles.modes[dialect.mode].text(source)),
					LiteralEscapePolicy::ShellDouble
						| LiteralEscapePolicy::ShellUnquoted
						| LiteralEscapePolicy::ShellHeredoc,
				) {
				return None;
			}
		} else if source[..at]
			.bytes()
			.rev()
			.take_while(|byte| *byte == b'\\')
			.count()
			% 2 == 1
		{
			return None;
		}
		Some(at..end)
	})
}

fn lexical_roles(root: Node<'_>, source: &str, language: SupportLang) -> Option<RoleSpans> {
	let mut roles = raw_lexical_roles(root, source, language)?;
	if language == SupportLang::Python {
		for edge in physical_continuation_boundaries(source) {
			if !matches!(role_at(&roles, edge.start), LexicalRole::Code | LexicalRole::Unknown) {
				continue;
			}
			let certain = roles
				.continuations
				.binary_search_by_key(&edge.start, |range| range.start)
				.is_ok_and(|at| roles.continuations[at] == edge);
			if !certain {
				roles.uncertain_continuations.push(edge);
			}
		}
	}
	if matches!(language, SupportLang::C | SupportLang::Cpp) {
		for (at, _) in source.match_indices('\\') {
			let end = match source.as_bytes().get(at + 1..) {
				Some([b'\n', ..]) => at + 2,
				Some([b'\r', b'\n', ..]) => at + 3,
				_ => continue,
			};
			if let LexicalRole::Literal(dialect) = role_at(&roles, at)
				&& matches!(
					literal_escape_policy(dialect, roles.modes[dialect.mode].text(source)),
					LiteralEscapePolicy::Raw
				) {
				continue;
			}
			roles.continuations.push(at..end);
		}
	}
	if language != SupportLang::Bash || !(source.contains("\\\n") || source.contains("\\\r\n")) {
		return Some(roles);
	}
	// The shell removes code continuations before finding words/comments.
	// The raw grammar instead treats a following # as a fresh-row comment.
	let continuations = code_continuations(source, &roles).collect::<Vec<_>>();
	if continuations.is_empty() {
		return Some(roles);
	}
	let mut text = String::with_capacity(source.len());
	let mut projection = Vec::new();
	let mut start = 0;
	for continuation in &continuations {
		if start < continuation.start {
			let payload = text.len();
			text.push_str(&source[start..continuation.start]);
			projection
				.push(Projection { payload: payload..text.len(), source: start..continuation.start });
		}
		projection
			.push(Projection { payload: text.len()..text.len(), source: continuation.clone() });
		start = continuation.end;
	}
	if start < source.len() {
		let payload = text.len();
		text.push_str(&source[start..]);
		projection.push(Projection { payload: payload..text.len(), source: start..source.len() });
	}
	let tree = parse_cached(&text, language).ok().flatten()?;
	if tree.root_node().has_error() {
		return None;
	}
	let projected = raw_lexical_roles(tree.root_node(), &text, language)?;
	// Newly exposed continuations need another lexical frame: refuse rather
	// than recursively parsing progressively longer chains.
	if code_continuations(&text, &projected).next().is_some() {
		return None;
	}
	let source_range = 0..source.len();
	let original = |byte, end| projection_source_byte(&projection, &source_range, byte, end);
	let mut result = RoleSpans { continuations, ..RoleSpans::default() };
	let modes = result.import_modes(&projected, &text, source, original);
	result.import_words(&projected, original);
	result.import_code(&projected, &projection, original);
	let pairs = result.import_pairs(&projected, original);
	for (range, role) in projected.spans {
		let role = imported_role(role, &modes, &pairs);
		let at = projection.partition_point(|part| part.payload.end <= range.start);
		for part in projection[at..]
			.iter()
			.take_while(|part| part.payload.start < range.end)
			.filter(|part| !part.payload.is_empty())
		{
			let start = original(range.start.max(part.payload.start), false)?;
			let end = original(range.end.min(part.payload.end), true)?;
			if start < end {
				result.spans.push((start..end, role));
			}
		}
	}
	let mut phase_modes = HashMap::new();
	for continuation in &result.continuations {
		let quoted = match role_at(&roles, continuation.start) {
			LexicalRole::Escape(dialect) if !roles.modes[dialect.mode].text(source).is_empty() => {
				Some(dialect)
			},
			_ => None,
		};
		let prefix = quoted.map_or("", |dialect| roles.modes[dialect.mode].text(source));
		let mode = *phase_modes
			.entry(quoted.map(|dialect| dialect.mode))
			.or_insert_with(|| {
				result
					.modes
					.iter()
					.position(|mode| mode.text(source) == prefix)
					.unwrap_or_else(|| {
						let mode = result.modes.len();
						result
							.modes
							.push(quoted.map_or(LiteralPrefix::Source(0..0), |dialect| {
								roles.modes[dialect.mode].clone()
							}));
						mode
					})
			});
		result.spans.push((
			continuation.clone(),
			LexicalRole::Escape(LiteralDialect {
				language,
				kind: quoted.map_or(u16::MAX, |dialect| dialect.kind),
				mode,
				escape: b'\\',
			}),
		));
	}
	result.spans.sort_unstable_by_key(|(range, _)| range.start);
	result.sort_words();
	Some(result)
}

fn literal_content(kind: &str) -> bool {
	kind.ends_with("_content")
		|| kind.ends_with("_fragment")
		|| kind.ends_with("_text")
		|| kind.ends_with("_start")
		|| kind.ends_with("_end")
		|| kind.ends_with("_delimiter")
		|| kind.starts_with("raw_str_") && kind.ends_with("_part")
		|| matches!(
			kind,
			"regex_pattern"
				| "regex_flags"
				| "heredoc_body"
				| "nowdoc_body"
				| "nowdoc_string"
				| "string_start"
				| "string_end"
				| "string_open"
				| "string_close"
				| "sigil_name"
				| "content"
		)
}

fn literal_owner(node: Node<'_>, language: SupportLang) -> bool {
	let kind = node.kind();
	if language == SupportLang::Bash {
		if kind == "heredoc_body" {
			return true;
		}
		if matches!(
			kind,
			"heredoc_redirect" | "heredoc_start" | "heredoc_end" | "herestring_redirect"
		) {
			return false;
		}
	}
	!(literal_content(kind)
		|| kind.contains("escape")
		|| language == SupportLang::Dockerfile
			&& (matches!(kind, "heredoc_line" | "heredoc_marker")
				|| kind == "unquoted_string"
					&& node.parent().is_some_and(|parent| {
						parent
							.child_by_field_name("name")
							.is_some_and(|name| name.id() == node.id())
					})))
		&& (kind.contains("string")
			|| kind.contains("heredoc")
			|| kind.contains("nowdoc")
			|| kind == "block_scalar"
			|| language == SupportLang::Elixir && kind == "sigil"
			|| kind.contains("char") && kind.contains("literal")
			|| language == SupportLang::Yaml
				&& matches!(
					kind,
					"plain_scalar" | "block_scalar" | "double_quote_scalar" | "single_quote_scalar"
				) || language == SupportLang::Dockerfile && kind == "path"
			|| matches!(kind, "character" | "regex"))
}

fn literal_prefix(node: Node<'_>, source: &str, language: SupportLang) -> Option<Range<usize>> {
	if language == SupportLang::Bash && node.kind() == "heredoc_body" {
		let parent = node.parent()?;
		let mut cursor = parent.walk();
		let start = parent
			.named_children(&mut cursor)
			.find(|child| child.kind() == "heredoc_start")?;
		return Some(parent.start_byte()..start.end_byte());
	}
	let text = &source[node.byte_range()];
	let prefix = if language == SupportLang::Yaml && node.kind() == "plain_scalar"
		|| language == SupportLang::Bash && node.kind() == "word"
		|| language == SupportLang::Dockerfile && matches!(node.kind(), "path" | "unquoted_string")
	{
		""
	} else if language == SupportLang::CSharp && node.kind().contains("raw_string")
		|| matches!(language, SupportLang::Scala | SupportLang::Kotlin) && text.starts_with("\"\"\"")
	{
		let at = text.find('"')?;
		let end = at + text[at..].bytes().take_while(|byte| *byte == b'"').count();
		text.get(..end)?
	} else if language == SupportLang::Cpp && node.kind() == "raw_string_literal" {
		text.get(..text.find('(')? + 1)?
	} else if node.kind() == "block_scalar" {
		text.split_ascii_whitespace().next()?
	} else if text.starts_with("<<<") {
		text.get(..text.find(['\r', '\n']).unwrap_or(text.len()))?
	} else if language == SupportLang::Lua && text.starts_with('[') {
		let end = 1 + text[1..].bytes().take_while(|byte| *byte == b'=').count();
		if text.as_bytes().get(end) != Some(&b'[') {
			return None;
		}
		text.get(..end + 1)?
	} else if language == SupportLang::R && matches!(text.as_bytes().first(), Some(b'r' | b'R')) {
		text.get(..text.find(['(', '[', '{'])? + 1)?
	} else if text.starts_with('%') || language == SupportLang::Elixir && text.starts_with('~') {
		let start = if text.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic) {
			2
		} else {
			1
		};
		let opener = text.get(start..)?.chars().next()?;
		let triple = matches!(opener, '\'' | '"')
			&& text
				.as_bytes()
				.get(start..start + 3)
				.is_some_and(|bytes| bytes.iter().all(|byte| u32::from(*byte) == opener as u32));
		let end = start
			+ if triple {
				text[start..]
					.bytes()
					.take_while(|byte| u32::from(*byte) == opener as u32)
					.count()
			} else {
				opener.len_utf8()
			};
		text.get(..end)?
	} else {
		let at = text.find(['"', '\'', '`', '/'])?;
		let quote = text.as_bytes()[at];
		let count = text[at..].bytes().take_while(|byte| *byte == quote).count();
		let end = at
			+ if count >= 3 && matches!(quote, b'\'' | b'"') {
				count
			} else {
				1
			};
		text.get(..end)?
	};
	Some(node.start_byte()..node.start_byte() + prefix.len())
}

fn literal_dialect<'a>(
	node: Node<'_>,
	source: &'a str,
	language: SupportLang,
	modes: &mut Vec<LiteralPrefix>,
	intern: &mut HashMap<&'a str, usize>,
) -> Option<LiteralDialect> {
	let prefix = literal_prefix(node, source, language)?;
	let mode = *intern.entry(&source[prefix.clone()]).or_insert_with(|| {
		let mode = modes.len();
		modes.push(LiteralPrefix::Source(prefix));
		mode
	});
	let kind = if language == SupportLang::Yaml && node.kind() == "plain_scalar" {
		node.named_child(0)?.kind_id()
	} else {
		node.kind_id()
	};
	Some(LiteralDialect { language, kind, mode, escape: b'\\' })
}

#[derive(Clone, Copy)]
enum LiteralEscapePolicy {
	Unknown,
	Raw,
	Doubled(u8),
	Backslash,
	Restricted(u8, u8),
	QuotedRaw(u8),
	ShellDouble,
	ShellHeredoc,
	ShellUnquoted,
	PhpDouble,
	SwiftHashes(usize),
}

impl LiteralEscapePolicy {
	fn active(self, bytes: &[u8], at: usize) -> bool {
		match self {
			Self::Unknown | Self::Raw | Self::Doubled(_) => false,
			Self::Backslash | Self::ShellUnquoted => true,
			Self::Restricted(opener, closer) => bytes
				.get(at + 1)
				.is_none_or(|next| *next == b'\\' || *next == opener || *next == closer),
			Self::QuotedRaw(quote) => {
				bytes[at + 1..].iter().find(|byte| **byte != b'\\') == Some(&quote)
			},
			Self::PhpDouble => bytes.get(at + 1).is_none_or(|next| {
				matches!(
					*next,
					b'\\' | b'$' | b'"' | b'n' | b'r' | b't' | b'v' | b'e' | b'f' | b'x' | b'u' | b'0'
						..=b'7'
				)
			}),
			Self::ShellDouble => bytes.get(at + 1).is_none_or(|next| {
				matches!(*next, b'\\' | b'$' | b'`' | b'"' | b'\n')
					|| *next == b'\r' && bytes.get(at + 2) == Some(&b'\n')
			}),
			Self::ShellHeredoc => bytes.get(at + 1).is_none_or(|next| {
				matches!(*next, b'\\' | b'$' | b'`' | b'\n')
					|| *next == b'\r' && bytes.get(at + 2) == Some(&b'\n')
			}),
			Self::SwiftHashes(hashes) => {
				(1..=hashes).all(|offset| bytes.get(at + offset) == Some(&b'#'))
			},
		}
	}
}

fn literal_escape_policy(dialect: LiteralDialect, prefix: &str) -> LiteralEscapePolicy {
	let prefix = prefix.as_bytes();
	let first = prefix.first().copied().unwrap_or_default();
	let second = prefix.get(1).copied().unwrap_or_default();
	let opener = prefix.last().copied().unwrap_or_default();
	if matches!(dialect.language, SupportLang::Bash | SupportLang::Dockerfile) && prefix.is_empty() {
		return LiteralEscapePolicy::ShellUnquoted;
	}
	if dialect.language == SupportLang::Bash && prefix.starts_with(b"<<") {
		return if prefix
			.iter()
			.any(|byte| matches!(*byte, b'\'' | b'"' | b'\\'))
		{
			LiteralEscapePolicy::Raw
		} else {
			LiteralEscapePolicy::ShellHeredoc
		};
	}
	if dialect.language == SupportLang::Rust && (first == b'r' || first == b'b' && second == b'r')
		|| dialect.language == SupportLang::Cpp && prefix.windows(2).any(|pair| pair == b"R\"")
		|| dialect.language == SupportLang::Go && first == b'`'
		|| matches!(dialect.language, SupportLang::CSharp | SupportLang::Scala | SupportLang::Kotlin)
			&& prefix.ends_with(b"\"\"\"")
		|| dialect.language == SupportLang::Bash && first == b'\''
		|| dialect.language == SupportLang::Yaml && matches!(first, 0 | b'|' | b'>')
		|| dialect.language == SupportLang::R && matches!(first, b'r' | b'R')
		|| dialect.language == SupportLang::Lua && first == b'['
		|| dialect.language == SupportLang::Php
			&& prefix.starts_with(b"<<<")
			&& prefix[3..]
				.iter()
				.copied()
				.find(|byte| !byte.is_ascii_whitespace())
				== Some(b'\'')
		|| dialect.language == SupportLang::Elixir && first == b'~' && second == b'S'
	{
		return LiteralEscapePolicy::Raw;
	}
	if dialect.language == SupportLang::Julia && prefix.starts_with(b"raw\"") {
		return LiteralEscapePolicy::QuotedRaw(b'"');
	}
	if dialect.language == SupportLang::Julia && !matches!(first, b'"' | b'\'') {
		return LiteralEscapePolicy::Unknown;
	}
	if dialect.language == SupportLang::Php && (opener == b'"' || prefix.starts_with(b"<<<")) {
		return LiteralEscapePolicy::PhpDouble;
	}
	if dialect.language == SupportLang::Elixir && first == b'~' {
		return if second == b's' {
			LiteralEscapePolicy::Backslash
		} else {
			LiteralEscapePolicy::Unknown
		};
	}
	if dialect.language == SupportLang::Yaml && first == b'\'' {
		return LiteralEscapePolicy::Doubled(b'\'');
	}
	if dialect.language == SupportLang::CSharp && (first == b'@' || first == b'$' && second == b'@')
	{
		return LiteralEscapePolicy::Doubled(b'"');
	}
	if dialect.language == SupportLang::Swift && first == b'#' && opener == b'"' {
		return LiteralEscapePolicy::SwiftHashes(
			prefix.iter().take_while(|byte| **byte == b'#').count(),
		);
	}
	if dialect.language == SupportLang::Bash && opener == b'"' {
		return LiteralEscapePolicy::ShellDouble;
	}
	if dialect.language == SupportLang::Python
		&& (matches!(first, b'r' | b'R') || matches!(second, b'r' | b'R'))
		|| matches!(dialect.language, SupportLang::Ruby | SupportLang::Php) && first == b'\''
	{
		return LiteralEscapePolicy::Restricted(opener, opener);
	}
	if dialect.language == SupportLang::Ruby && first == b'%' && second == b'q' {
		let closer = match opener {
			b'(' => b')',
			b'[' => b']',
			b'{' => b'}',
			b'<' => b'>',
			other => other,
		};
		return LiteralEscapePolicy::Restricted(opener, closer);
	}
	if matches!(opener, b'\'' | b'"' | b'`' | b'/')
		|| dialect.language == SupportLang::Ruby && first == b'%' && second == b'Q'
	{
		LiteralEscapePolicy::Backslash
	} else {
		LiteralEscapePolicy::Unknown
	}
}

fn escape_end(
	text: &str,
	at: usize,
	dialect: LiteralDialect,
	policy: LiteralEscapePolicy,
) -> usize {
	let bytes = text.as_bytes();
	let mut end = at + 1;
	if let LiteralEscapePolicy::SwiftHashes(hashes) = policy {
		end += hashes;
	}
	if let Some(&next) = bytes.get(end) {
		end += 1;
		if matches!(
			policy,
			LiteralEscapePolicy::ShellDouble
				| LiteralEscapePolicy::ShellHeredoc
				| LiteralEscapePolicy::ShellUnquoted
				| LiteralEscapePolicy::QuotedRaw(_)
		) {
			if next == b'\r' && bytes.get(end) == Some(&b'\n') {
				end += 1;
			}
			while end < bytes.len() && !text.is_char_boundary(end) {
				end += 1;
			}
			return end;
		}
		if (b'0'..=b'7').contains(&next) {
			let limit = end + 2;
			while end < bytes.len() && end < limit && (b'0'..=b'7').contains(&bytes[end]) {
				end += 1;
			}
		} else if next == b'c' && dialect.language == SupportLang::Bash {
			if end < bytes.len() {
				end += 1;
				while end < bytes.len() && !text.is_char_boundary(end) {
					end += 1;
				}
			}
		} else if matches!(next, b'u' | b'x' | b'U') {
			if bytes.get(end) == Some(&b'{') {
				end += 1;
				while end < bytes.len() && bytes[end] != b'}' {
					end += 1;
				}
				end += usize::from(end < bytes.len());
			} else {
				let limit = end
					+ match next {
						b'u' => 4,
						b'U' => 8,
						_ => 2,
					};
				while end < bytes.len() && end < limit && bytes[end].is_ascii_hexdigit() {
					end += 1;
				}
			}
		} else {
			while end < bytes.len() && !text.is_char_boundary(end) {
				end += 1;
			}
		}
	}
	end
}

fn mark_literal(
	node: Node<'_>,
	range: Range<usize>,
	source: &str,
	dialect: LiteralDialect,
	modes: &[LiteralPrefix],
	mark: &mut impl FnMut(Range<usize>, LexicalRole),
) {
	if range.is_empty() {
		return;
	}
	let text = &source[range.clone()];
	let prefix_bytes = modes[dialect.mode].text(source).as_bytes();
	let policy = literal_escape_policy(dialect, modes[dialect.mode].text(source));
	if matches!(policy, LiteralEscapePolicy::Unknown) {
		mark(range, LexicalRole::Unknown);
		return;
	}
	if let LiteralEscapePolicy::Doubled(quote) = policy {
		let bytes = text.as_bytes();
		let whole = bytes.starts_with(prefix_bytes);
		let limit = bytes
			.len()
			.saturating_sub(usize::from(whole && bytes.last() == Some(&quote)));
		let mut at = if whole { prefix_bytes.len() } else { 0 };
		let mut start = 0;
		while at + 1 < limit {
			if bytes[at] == quote && bytes[at + 1] == quote {
				mark(range.start + start..range.start + at, LexicalRole::Literal(dialect));
				mark(range.start + at..range.start + at + 2, LexicalRole::Escape(dialect));
				at += 2;
				start = at;
			} else {
				at += 1;
			}
		}
		mark(range.start + start..range.end, LexicalRole::Literal(dialect));
		return;
	}
	if matches!(policy, LiteralEscapePolicy::Raw) {
		mark(range, LexicalRole::Literal(dialect));
		return;
	}
	if !text.as_bytes().contains(&dialect.escape) {
		mark(range, LexicalRole::Literal(dialect));
		return;
	}
	let owner = std::iter::successors(Some(node), |parent| parent.parent())
		.find(|parent| parent.kind_id() == dialect.kind);
	let limit = owner.map_or(range.end, |owner| owner.end_byte());
	let text = &source[range.start..limit];
	let mut start = 0;
	let mut at = 0;
	let bytes = text.as_bytes();
	while at < range.len() {
		if bytes[at] != dialect.escape || !policy.active(bytes, at) {
			at += 1;
			continue;
		}
		mark(range.start + start..range.start + at, LexicalRole::Literal(dialect));
		let end = escape_end(text, at, dialect, policy);
		mark(range.start + at..range.start + end, LexicalRole::Escape(dialect));
		at = end;
		start = end;
	}
	mark(range.start + start..range.end, LexicalRole::Literal(dialect));
}

/// Hidden grammar text still belongs to its positively identified lexical
/// owner. Children override it; code gaps do not require stored descriptors.
fn mark_owned_gap(
	owner: Node<'_>,
	range: Range<usize>,
	role: LexicalRole,
	source: &str,
	modes: &[LiteralPrefix],
	mark: &mut impl FnMut(Range<usize>, LexicalRole),
) {
	match role {
		LexicalRole::Literal(dialect) => mark_literal(owner, range, source, dialect, modes, mark),
		LexicalRole::Code => {},
		other => mark(range, other),
	}
}

/// Make assignment text is not shell-quoted: unescaped hashes start comments
/// even between quotes. Parsed references/functions are opaque to this rule.
fn make_assignment_comments(
	node: Node<'_>,
	source: &str,
	mark: &mut impl FnMut(Range<usize>, LexicalRole),
) {
	let mut cursor = node.walk();
	let mut children = node.named_children(&mut cursor);
	let mut child = children.next();
	let mut at = node.start_byte();
	let bytes = source.as_bytes();
	while at < node.end_byte() {
		while child.is_some_and(|child| child.end_byte() <= at) {
			child = children.next();
		}
		if let Some(next) = child.filter(|child| child.start_byte() <= at) {
			at = next.end_byte();
		} else if bytes[at] == b'\\' {
			at = (at + 2).min(node.end_byte());
		} else if bytes[at] == b'#' {
			let mut end = at;
			loop {
				end = source[end..node.end_byte()]
					.find('\n')
					.map_or_else(|| node.end_byte(), |newline| end + newline);
				let physical_end = end - usize::from(end > at && bytes[end - 1] == b'\r');
				let continued = source[at..physical_end]
					.bytes()
					.rev()
					.take_while(|byte| *byte == b'\\')
					.count() % 2
					== 1;
				if !continued || end == node.end_byte() {
					break;
				}
				end += 1;
			}
			mark(at..end, LexicalRole::Comment);
			at = end.saturating_add(1);
		} else {
			at += 1;
		}
	}
}

/// A delimiter is certified by an actual paired grammar construct. Its body
/// remains ordinary evaluated code, not an indivisible replacement unit.
fn interpolation_unit(
	node: Node<'_>,
	parent: Option<Node<'_>>,
	language: SupportLang,
) -> Option<InterpolationUnit> {
	if node.child_count() != 0 {
		return None;
	}
	let parent = parent?;
	if language == SupportLang::Php
		&& parent.kind() == "encapsed_string"
		&& matches!(node.kind(), "{" | "}")
	{
		let body = if node.kind() == "{" {
			node.next_named_sibling()?
		} else {
			node.prev_named_sibling()?
		};
		let open = body.prev_sibling()?;
		let close = body.next_sibling()?;
		if open.kind() != "{"
			|| close.kind() != "}"
			|| body.has_error()
			|| !(body.kind().contains("expression") || body.kind().contains("variable"))
		{
			return None;
		}
		return Some(InterpolationUnit {
			range: open.start_byte()..close.end_byte(),
			body:  body.byte_range(),
			kind:  parent.kind_id(),
		});
	}
	if !matches!(
		parent.kind(),
		"template_substitution"
			| "interpolation"
			| "interpolated_expression"
			| "string_interpolation"
			| "interpolation_expression"
			| "expansion"
			| "command_substitution"
			| "process_substitution"
	) || parent.has_error()
	{
		return None;
	}
	let mut cursor = parent.walk();
	let mut body: Option<Range<usize>> = None;
	for child in parent.named_children(&mut cursor) {
		if child.kind().ends_with("_start")
			|| child.kind().ends_with("_end")
			|| child.kind().ends_with("_delimiter")
		{
			continue;
		}
		match &mut body {
			Some(range) => range.end = child.end_byte(),
			None => body = Some(child.byte_range()),
		}
	}
	let body = body?;
	if node.end_byte() > body.start && node.start_byte() < body.end {
		return None;
	}
	Some(InterpolationUnit { range: parent.byte_range(), body, kind: parent.kind_id() })
}

/// Sorted, disjoint non-code spans. One tree/row walk records the closest
/// lexical extent; interpolated expressions override their string owner.
fn raw_lexical_roles(root: Node<'_>, source: &str, language: SupportLang) -> Option<RoleSpans> {
	let mut spans: Vec<(Range<usize>, LexicalRole)> = Vec::new();
	let mut modes: Vec<LiteralPrefix> = Vec::new();
	let mut intern = HashMap::new();
	let mut words = Vec::new();
	let mut code = Vec::new();
	let mut pairs = Vec::new();
	let mut pair_ids = HashMap::new();
	let mut continuations = Vec::new();
	let mut units = Vec::new();
	let mut mark = |mut range: Range<usize>, role| {
		if let Some((previous, LexicalRole::Escape(_) | LexicalRole::Comment)) = spans.last() {
			range.start = range.start.max(previous.end);
		}
		if role == LexicalRole::Code || range.is_empty() {
			return;
		}
		if let Some((previous, old_role)) = spans.last_mut()
			&& *old_role == role
			&& !matches!(role, LexicalRole::Escape(_))
			&& previous.end == range.start
		{
			previous.end = range.end;
		} else {
			spans.push((range, role));
		}
	};
	if language == SupportLang::Ini {
		let mut start = 0;
		for line in source.split_inclusive('\n') {
			let mut comment = false;
			let mut end = line.len();
			let mut has_code = false;
			for (at, ch) in line.char_indices() {
				if !comment
					&& language.line_comments().iter().any(|marker| {
						SupportLang::line_comment_marker_at(Some(language), marker, line, at)
					}) {
					comment = true;
					end = at;
				}
				if comment {
					mark(start + at..start + at + ch.len_utf8(), LexicalRole::Comment);
				} else {
					has_code |= !ch.is_whitespace();
				}
			}
			if has_code {
				code.push(CodeToken { range: start..start + end, language, kind: None, field: None });
			}
			start += line.len();
		}
		return Some(RoleSpans { spans, code, ..RoleSpans::default() });
	}
	let selected_escape = if language == SupportLang::Dockerfile {
		docker_escape(source).0
	} else {
		Some(b'\\')
	};
	let mut cursor = root.walk();
	let mut owners = vec![(root, LexicalRole::Code)];
	loop {
		let node = cursor.node();
		let &(owner, inherited) = owners.last()?;
		let parent = (owners.len() > 1).then_some(owner);
		let kind = node.kind();
		let leaf = node.child_count() == 0;
		if language == SupportLang::Dockerfile
			&& matches!(kind, "param" | "mount_param_param")
			&& !node.has_error()
			&& !node.is_missing()
		{
			let mut at = node.start_byte();
			let field = cursor.field_name();
			let mut add_gap = |range: Range<usize>| {
				if !leaf && !range.is_empty() {
					code.push(CodeToken { range, language, kind: Some(node.kind_id()), field });
				}
			};
			let mut children = node.walk();
			for child in node.children(&mut children) {
				add_gap(at..child.start_byte());
				at = child.end_byte();
			}
			add_gap(at..node.end_byte());
			units.push(node.byte_range());
		}
		if leaf && !matches!(kind, "ERROR" | "preproc_arg" | "raw_text") {
			code.push(CodeToken {
				range: node.byte_range(),
				language,
				kind: Some(node.kind_id()),
				field: cursor.field_name(),
			});
		}
		if language == SupportLang::Bash
			&& matches!(
				kind,
				"word" | "concatenation" | "string" | "raw_string" | "expansion" | "simple_expansion"
			) && parent.is_none_or(|parent| parent.kind() != "concatenation")
		{
			words.push(LogicalUnit {
				range: node.byte_range(),
				language,
				statement: None,
				certain: true,
			});
		}
		if language == SupportLang::Python {
			if let Some(statement) = python_statement(node, parent) {
				words.push(statement);
			}
			if kind == "line_continuation" && !node.is_missing() && !node.has_error() {
				continuations.push(node.byte_range());
			}
		}
		if language == SupportLang::Make
			&& (kind == "text"
				&& parent.is_some_and(|parent| {
					parent.kind() == "variable_assignment"
						&& parent
							.child_by_field_name("value")
							.is_some_and(|value| value.id() == node.id())
				}) || kind == "shell_command"
				&& parent.is_some_and(|parent| parent.kind() == "shell_assignment"))
		{
			make_assignment_comments(node, source, &mut mark);
		}
		let scalar = language == SupportLang::Yaml
			&& matches!(
				kind,
				"plain_scalar" | "block_scalar" | "double_quote_scalar" | "single_quote_scalar"
			);
		let literal_owner = literal_owner(node, language);
		let literal_prefix_node =
			language == SupportLang::Julia && cursor.field_name() == Some("prefix");
		let evaluated = !literal_prefix_node
			&& (kind.contains("expression")
				|| kind.contains("identifier")
				|| kind.contains("variable")
				|| kind.contains("interpolation")
				|| kind.contains("substitution")
				|| kind.split('_').any(|word| word == "expansion"));
		let escaped_evaluation = evaluated
			&& matches!(inherited, LexicalRole::Literal(dialect)
				if node.start_byte() > 0
					&& source.as_bytes()[..node.start_byte()]
						.iter()
						.rev()
						.take_while(|byte| **byte == dialect.escape)
						.count() % 2 == 1
					&& literal_escape_policy(dialect, modes[dialect.mode].text(source))
						.active(source.as_bytes(), node.start_byte() - 1));
		let delimiter = if escaped_evaluation {
			None
		} else {
			interpolation_unit(node, parent, language)
		};
		let paired = delimiter.and_then(|unit| {
			let dialect = owners
				.iter()
				.rev()
				.find_map(|(_, role)| {
					if let LexicalRole::Literal(dialect) = role {
						Some(*dialect)
					} else {
						None
					}
				})
				.or_else(|| {
					(language == SupportLang::Bash).then(|| {
						let mode = *intern.entry(&source[0..0]).or_insert_with(|| {
							let mode = modes.len();
							modes.push(LiteralPrefix::Source(0..0));
							mode
						});
						LiteralDialect { language, kind: unit.kind, mode, escape: b'\\' }
					})
				})?;
			let key = (unit.range.start, unit.range.end);
			let pair = *pair_ids.entry(key).or_insert_with(|| {
				let id = pairs.len();
				pairs.push(unit);
				id
			});
			Some(LexicalRole::Delimiter(dialect, pair))
		});
		let role = if let Some(delimiter) = paired {
			delimiter
		} else if is_comment(node) {
			LexicalRole::Comment
		} else if matches!(kind, "preproc_arg" | "raw_text") {
			LexicalRole::Unknown
		} else if kind.contains("escape") {
			match inherited {
				LexicalRole::Literal(dialect) => LexicalRole::Escape(dialect),
				other => other,
			}
		} else if literal_owner {
			literal_dialect(node, source, language, &mut modes, &mut intern)
				.and_then(|mut dialect| {
					dialect.escape = if kind == "json_string" {
						b'\\'
					} else {
						selected_escape?
					};
					Some(dialect)
				})
				.map_or(LexicalRole::Unknown, LexicalRole::Literal)
		} else if escaped_evaluation {
			inherited
		} else if evaluated {
			LexicalRole::Code
		} else if matches!(inherited, LexicalRole::Literal(_))
			&& node.is_named()
			&& !(literal_content(kind) || literal_prefix_node)
		{
			LexicalRole::Unknown
		} else {
			inherited
		};
		if language == SupportLang::Bash
			&& role == LexicalRole::Code
			&& kind == "word"
			&& source[node.byte_range()].contains('\\')
		{
			let dialect = literal_dialect(node, source, language, &mut modes, &mut intern)?;
			let mut at = node.start_byte();
			while at < node.end_byte() {
				if source.as_bytes()[at] == b'\\' {
					let end =
						at + escape_end(&source[at..], 0, dialect, LiteralEscapePolicy::ShellUnquoted);
					mark(at..end, LexicalRole::Escape(dialect));
					at = end;
				} else {
					at += 1;
				}
			}
		}
		if !scalar
			&& !escaped_evaluation
			&& !is_comment(node)
			&& !matches!(role, LexicalRole::Escape(_))
			&& cursor.goto_first_child()
		{
			owners.push((node, role));
			mark_owned_gap(
				node,
				node.start_byte()..cursor.node().start_byte(),
				role,
				source,
				&modes,
				&mut mark,
			);
			continue;
		}
		if let LexicalRole::Literal(dialect) = role {
			mark_literal(node, node.byte_range(), source, dialect, &modes, &mut mark);
		} else if let LexicalRole::Escape(dialect) = role {
			let owner = owners
				.iter()
				.rev()
				.map(|(parent, _)| *parent)
				.find(|parent| parent.kind_id() == dialect.kind);
			let limit = owner.map_or_else(|| node.end_byte(), |owner| owner.end_byte());
			let text = &source[node.start_byte()..limit];
			let policy = literal_escape_policy(dialect, modes[dialect.mode].text(source));
			if text.as_bytes().first() != Some(&dialect.escape) || !policy.active(text.as_bytes(), 0) {
				mark(
					node.byte_range(),
					if dialect.language == SupportLang::Dockerfile
						&& dialect.escape != b'\\'
						&& text.contains('$')
					{
						LexicalRole::Unknown
					} else {
						LexicalRole::Literal(dialect)
					},
				);
			} else {
				let end = node.start_byte() + escape_end(text, 0, dialect, policy);
				mark(node.start_byte()..end.max(node.end_byte()), role);
			}
		} else {
			mark(node.byte_range(), role);
		}
		loop {
			let end = cursor.node().end_byte();
			if cursor.goto_next_sibling() {
				let next = cursor.node();
				let (owner, role) = *owners.last()?;
				mark_owned_gap(owner, end..next.start_byte(), role, source, &modes, &mut mark);
				break;
			}
			if !cursor.goto_parent() {
				if !units.is_empty() {
					code.sort_unstable_by_key(|token| token.range.start);
				}
				let mut roles = RoleSpans {
					spans,
					modes,
					words,
					word_ends: Vec::new(),
					code,
					pairs,
					continuations,
					uncertain_continuations: Vec::new(),
					units,
				};
				roles.sort_words();
				return Some(roles);
			}
			let (_, role) = owners.pop()?;
			let parent = cursor.node();
			mark_owned_gap(parent, end..parent.end_byte(), role, source, &modes, &mut mark);
		}
	}
}

fn role_at(spans: &[(Range<usize>, LexicalRole)], byte: usize) -> LexicalRole {
	let at = spans.partition_point(|(range, _)| range.end <= byte);
	spans
		.get(at)
		.filter(|(range, _)| range.contains(&byte))
		.map_or(LexicalRole::Code, |(_, role)| *role)
}

fn retained_roles(
	old: &RoleSpans,
	new: &RoleSpans,
	source: &str,
	result: &str,
	change: Range<usize>,
	replacement_len: usize,
	independent_unknown: &[Range<usize>],
) -> bool {
	for range in [0..change.start, change.end..source.len()] {
		if range.is_empty() {
			continue;
		}
		let mut at = range.start;
		let mut left = old.partition_point(|(span, _)| span.end <= at);
		let new_at = |at: usize| {
			if range.end == change.start {
				at
			} else {
				at - change.end + change.start + replacement_len
			}
		};
		let mut right = new.partition_point(|(span, _)| span.end <= new_at(at));
		while at < range.end {
			let mapped = new_at(at);
			while left < old.len() && old[left].0.end <= at {
				left += 1;
			}
			while right < new.len() && new[right].0.end <= mapped {
				right += 1;
			}
			let extent =
				|spans: &[(Range<usize>, LexicalRole)], index: usize, at: usize, limit: usize| {
					spans
						.get(index)
						.map_or((LexicalRole::Code, limit), |(span, role)| {
							if span.start <= at {
								(*role, span.end.min(limit))
							} else {
								(LexicalRole::Code, span.start.min(limit))
							}
						})
				};
			let (before, end_old) = extent(old, left, at, range.end);
			let (after, end_new) = extent(new, right, mapped, mapped + range.end - at);
			let end = end_old.min(at + end_new - mapped);
			let end = old
				.code_boundary(at, end)
				.min(at + new.code_boundary(mapped, mapped + end - at) - mapped);
			let end = old
				.unit_boundary(at, end)
				.min(at + new.unit_boundary(mapped, mapped + end - at) - mapped);
			if let Some(unit) = old.unit_at(at) {
				let Some(next) = new.unit_at(mapped) else {
					return false;
				};
				if unit.start < change.end && unit.end > change.start
					|| new_at(unit.start) != next.start
					|| new_at(unit.end) != next.end
				{
					return false;
				}
			}
			let literal = matches!(
				before,
				LexicalRole::Literal(_)
					| LexicalRole::Escape(_)
					| LexicalRole::Delimiter(_, _)
					| LexicalRole::Unknown
			) || matches!(
				after,
				LexicalRole::Literal(_)
					| LexicalRole::Escape(_)
					| LexicalRole::Delimiter(_, _)
					| LexicalRole::Unknown
			);
			let unknown = before == LexicalRole::Unknown || after == LexicalRole::Unknown;
			let independent = unknown && before == after && {
				let index = independent_unknown.partition_point(|range| range.start <= at);
				index > 0 && end <= independent_unknown[index - 1].end
			};
			if unknown && !independent
				|| !independent
					&& !(LexicalView { roles: old, source }).equivalent_at(
						at,
						LexicalView { roles: new, source: result },
						mapped,
					) && (literal || !source[at..end].chars().all(char::is_whitespace))
			{
				return false;
			}
			if !independent
				&& !(LexicalView { roles: old, source }).same_word_boundaries(
					at,
					&range,
					LexicalView { roles: new, source: result },
					mapped,
					&(new_at(range.start)..new_at(range.end)),
				) {
				return false;
			}
			if matches!(before, LexicalRole::Escape(_) | LexicalRole::Delimiter(_, _)) {
				let original = &old[left].0;
				let candidate = &new[right].0;
				if original.start < change.end && original.end > change.start
					|| new_at(original.start) != candidate.start
					|| new_at(original.end) != candidate.end
					|| source[original.clone()] != result[candidate.clone()]
				{
					return false;
				}
			}
			if let (LexicalRole::Delimiter(_, old_pair), LexicalRole::Delimiter(_, new_pair)) =
				(before, after)
			{
				let old_pair = &old.pairs[old_pair];
				let new_pair = &new.pairs[new_pair];
				let start = if old_pair.range.start < change.start {
					Some(old_pair.range.start)
				} else if old_pair.range.start >= change.end {
					Some(old_pair.range.start - change.len() + replacement_len)
				} else {
					None
				};
				let stop = if old_pair.range.end <= change.start {
					Some(old_pair.range.end)
				} else if old_pair.range.end > change.end {
					Some(old_pair.range.end - change.len() + replacement_len)
				} else {
					None
				};
				if start.is_some_and(|at| at != new_pair.range.start)
					|| stop.is_some_and(|at| at != new_pair.range.end)
				{
					return false;
				}
			}
			at = end;
		}
	}
	true
}

/// Parsed comments, independent of documentation spelling or language.
fn is_comment(node: Node<'_>) -> bool {
	node
		.kind()
		.as_bytes()
		.windows(7)
		.any(|word| word.eq_ignore_ascii_case(b"comment"))
		|| node.kind() == "haddock"
}

fn function_value(mut node: Node<'_>) -> bool {
	loop {
		if SupportLang::function_value_kind(node.kind()) {
			return true;
		}
		if !matches!(node.kind(), "parenthesized_expression" | "parenthesized") {
			return false;
		}
		let Some(child) = node
			.named_child(0)
			.filter(|_| node.named_child_count() == 1)
		else {
			return false;
		};
		node = child;
	}
}
#[derive(Clone, Copy)]
enum AttachmentTarget {
	Declaration,
	Executable,
	Data,
	Unknown,
}

impl AttachmentTarget {
	const fn protects_docs(self) -> bool {
		matches!(self, Self::Declaration | Self::Unknown)
	}
}

fn attachment_target(node: Node<'_>, code: &str, language: SupportLang) -> AttachmentTarget {
	fn data_context(mut node: Node<'_>, code: &str, language: SupportLang) -> bool {
		loop {
			let quoted_call = |node: Node<'_>| {
				language == SupportLang::Elixir
					&& node.kind() == "call"
					&& node
						.child_by_field_name("target")
						.is_some_and(|head| &code[head.byte_range()] == "quote")
			};
			if language.quoted_value_kind(node.kind())
				|| node
					.parent()
					.is_some_and(|parent| language.quoted_value_kind(parent.kind()))
				|| quoted_call(node)
				|| node.kind() == "do_block" && node.parent().is_some_and(quoted_call)
				|| matches!(
					node.kind(),
					"object"
						| "object_expression"
						| "object_literal"
						| "array" | "array_expression"
						| "array_literal"
						| "dictionary"
						| "dictionary_literal"
						| "table_constructor"
						| "table" | "vector_lit"
						| "vec_lit" | "map_lit"
						| "set_lit"
				) {
				return true;
			}
			if node.parent().is_none()
				|| is_body(node)
				|| declaration_container(node)
				|| (language == SupportLang::Clojure && matches!(node.kind(), "list_lit" | "list"))
			{
				return false;
			}
			let Some(parent) = node.parent() else {
				return false;
			};
			node = parent;
		}
	}
	if data_context(node, code, language) {
		return AttachmentTarget::Data;
	}
	evaluated_attachment_target(node, code, language)
}

fn evaluated_attachment_target(
	mut node: Node<'_>,
	code: &str,
	language: SupportLang,
) -> AttachmentTarget {
	if matches!(
		node.kind(),
		"doctypedecl" | "elementdecl" | "AttlistDecl" | "NotationDecl" | "GEDecl" | "PEDecl"
	) {
		return AttachmentTarget::Declaration;
	}
	if matches!(
		language,
		SupportLang::Json
			| SupportLang::Yaml
			| SupportLang::Toml
			| SupportLang::Ini
			| SupportLang::Markdown
			| SupportLang::Html
			| SupportLang::Xml
	) {
		return AttachmentTarget::Data;
	}
	if is_attribute_like(node) {
		return if matches!(attribute_category(node, code, language), AttributeOwner::DeclaredItem) {
			AttachmentTarget::Declaration
		} else {
			AttachmentTarget::Unknown
		};
	}
	loop {
		let kind = node.kind();
		let mut cursor = node.walk();
		let binding = node
			.children(&mut cursor)
			.any(|child| !child.is_named() && matches!(&code[child.byte_range()], "=" | "<-" | "<<-"));
		if binding {
			let value = node
				.child_by_field_name("value")
				.or_else(|| node.child_by_field_name("right"))
				.or_else(|| node.child_by_field_name("rhs"))
				.or_else(|| node.child_by_field_name("expression"));
			if value.is_some_and(function_value) {
				return AttachmentTarget::Declaration;
			}
			if value.is_some_and(|value| language.attachment_executable_kind(value.kind())) {
				return AttachmentTarget::Data;
			}
		}
		if language.quoted_value_kind(kind) {
			return AttachmentTarget::Data;
		}
		let transparent = matches!(
			kind,
			"export_statement"
				| "decorated_definition"
				| "metadata"
				| "meta_lit"
				| "metadata_lit"
				| "declaration_statement"
				| "definition_statement"
		);
		if transparent {
			let inner = node
				.child_by_field_name("declaration")
				.or_else(|| node.child_by_field_name("definition"))
				.or_else(|| node.child_by_field_name("value"));
			if let Some(inner) = inner {
				node = inner;
				continue;
			}
			return AttachmentTarget::Unknown;
		}
		if language == SupportLang::Clojure && matches!(kind, "list_lit" | "list")
			|| language == SupportLang::Elixir && kind == "call"
		{
			let mut cursor = node.walk();
			let mut head = node
				.child_by_field_name("target")
				.or_else(|| node.child_by_field_name("function"))
				.or_else(|| node.child_by_field_name("value"))
				.or_else(|| {
					node
						.named_children(&mut cursor)
						.find(|child| !is_comment(*child))
				});
			while let Some(meta) =
				head.filter(|head| matches!(head.kind(), "meta_lit" | "metadata_lit" | "metadata"))
			{
				head = meta.child_by_field_name("value");
			}
			let Some(head) =
				head.filter(|head| matches!(head.kind(), "sym_lit" | "symbol" | "identifier"))
			else {
				return AttachmentTarget::Unknown;
			};
			let head = head.child_by_field_name("name").unwrap_or(head);
			let symbol = code[head.byte_range()]
				.trim()
				.rsplit(['/', '.'])
				.next()
				.unwrap_or_default();
			if matches!(
				symbol,
				"ns"
					| "def" | "defn"
					| "defn-" | "defp"
					| "defmacro"
					| "defmacrop"
					| "defmulti"
					| "defmethod"
					| "defprotocol"
					| "defrecord"
					| "deftype"
					| "definterface"
					| "defonce"
					| "defstruct"
					| "defmodule"
					| "defimpl"
					| "defguard"
					| "defguardp"
					| "defdelegate"
					| "defexception"
			) {
				return AttachmentTarget::Declaration;
			}
			if matches!(symbol, "quote" | "syntax-quote") {
				return AttachmentTarget::Data;
			}
			if language == SupportLang::Clojure
				&& matches!(
					symbol,
					"println"
						| "print" | "prn"
						| "str" | "inc"
						| "dec" | "+"
						| "-" | "*" | "/"
						| "identity"
				) {
				return AttachmentTarget::Executable;
			}
			return AttachmentTarget::Unknown;
		}
		if matches!(
			kind,
			"function_declaration"
				| "function_definition"
				| "method_declaration"
				| "method_definition"
				| "class_declaration"
				| "class_definition"
				| "struct_declaration"
				| "struct_definition"
				| "type_declaration"
				| "type_definition"
				| "variable_declaration"
				| "lexical_declaration"
				| "property_declaration"
				| "field_declaration"
				| "module_definition"
				| "mod_item"
				| "function_item"
				| "macro_definition"
				| "namespace_definition"
				| "namespace_declaration"
				| "bind" | "newtype"
				| "instance"
				| "fun_decl"
				| "declaration_command"
		) {
			return AttachmentTarget::Declaration;
		}
		if kind == "expression_statement" {
			let mut cursor = node.walk();
			let mut children = node
				.named_children(&mut cursor)
				.filter(|child| !is_comment(*child));
			if let Some(inner) = children.next().filter(|_| children.next().is_none()) {
				let mut cursor = inner.walk();
				let binding = inner.children(&mut cursor).any(|child| {
					!child.is_named() && matches!(&code[child.byte_range()], "=" | "<-" | "<<-")
				});
				if binding
					&& inner
						.child_by_field_name("right")
						.or_else(|| inner.child_by_field_name("value"))
						.is_some_and(function_value)
				{
					return AttachmentTarget::Declaration;
				}
			}
			return AttachmentTarget::Executable;
		}
		if language.attachment_executable_kind(kind)
			|| language == SupportLang::Sql
				&& kind == "statement"
				&& node
					.named_child(0)
					.is_some_and(|command| language.attachment_executable_kind(command.kind()))
		{
			return AttachmentTarget::Executable;
		}
		return AttachmentTarget::Unknown;
	}
}

fn string_statement(mut node: Node<'_>, code: &str) -> bool {
	loop {
		if node.kind() == "string_literal" && code[node.byte_range()].starts_with('"') {
			return true;
		}
		if !matches!(node.kind(), "parenthesized_expression" | "expression_statement") {
			return false;
		}
		let Some(child) = node
			.named_child(0)
			.filter(|_| node.named_child_count() == 1)
		else {
			return false;
		};
		node = child;
	}
}

fn is_docstring(statement: Node<'_>, code: &str, language: SupportLang) -> bool {
	if language != SupportLang::Python || statement.kind() != "expression_statement" {
		return false;
	}
	let Some(parent) = statement
		.parent()
		.filter(|parent| matches!(parent.kind(), "block" | "module"))
	else {
		return false;
	};
	if language == SupportLang::Python
		&& parent.kind() == "block"
		&& parent
			.parent()
			.is_none_or(|owner| !matches!(owner.kind(), "function_definition" | "class_definition"))
	{
		return false;
	}
	let mut cursor = parent.walk();
	if parent
		.named_children(&mut cursor)
		.find(|node| !is_comment(*node))
		.is_none_or(|first| first.id() != statement.id())
	{
		return false;
	}
	fn literal(node: Node<'_>, code: &str) -> bool {
		let mut cursor = node.walk();
		loop {
			let current = cursor.node();
			if current.is_named() && !is_comment(current) {
				match current.kind() {
					"string" => {
						if !code[current.byte_range()]
							.trim_start_matches(['r', 'R', 'u', 'U'])
							.starts_with(['\'', '"'])
						{
							return false;
						}
					},
					"parenthesized_expression" | "concatenated_string" => {
						if current.named_child_count() == 0 {
							return false;
						}
						if cursor.goto_first_child() {
							continue;
						}
					},
					_ => return false,
				}
			}
			while !cursor.goto_next_sibling() {
				if !cursor.goto_parent() {
					return true;
				}
			}
		}
	}
	statement
		.named_child(0)
		.is_some_and(|node| literal(node, code))
}

fn begins_case_label(mut node: Node<'_>) -> bool {
	while let Some(child) = node.child(0) {
		node = child;
	}
	(!node.is_named() && matches!(node.kind(), "case" | "default"))
		|| node.kind() == "default_keyword"
}

fn is_case(node: Node<'_>) -> bool {
	matches!(
		node.kind(),
		"switch_case"
			| "switch_default"
			| "case_statement"
			| "default_statement"
			| "switch_section"
			| "expression_case"
			| "default_case"
			| "switch_entry"
			| "switch_block_statement_group"
			| "switch_label"
	)
}

fn native_case_owner(mut node: Node<'_>) -> Option<Node<'_>> {
	loop {
		if is_case(node) && node.kind() != "switch_label" {
			return Some(node);
		}
		node = node.parent()?;
	}
}

fn native_case_host(mut node: Node<'_>, language: SupportLang) -> Option<Node<'_>> {
	loop {
		node = node.parent()?;
		let host = if language == SupportLang::Go {
			node.kind() == "expression_switch_statement"
		} else {
			matches!(node.kind(), "switch_statement" | "switch_expression")
		};
		if host {
			return Some(node);
		}
		if !(is_case(node)
			|| matches!(
				node.kind(),
				"switch_body"
					| "switch_block"
					| "compound_statement"
					| "block" | "statement_list"
					| "statements"
			)) {
			return None;
		}
	}
}

fn case_label_range(mut node: Node<'_>) -> Option<Range<usize>> {
	let start = node.start_byte();
	loop {
		if !begins_case_label(node) {
			return None;
		}
		let mut cursor = node.walk();
		if let Some(colon) = node
			.children(&mut cursor)
			.find(|child| !child.is_named() && child.kind() == ":")
		{
			return Some(start..colon.end_byte());
		}
		if node.kind() == "switch_label"
			&& let Some(colon) = node
				.next_sibling()
				.filter(|child| !child.is_named() && child.kind() == ":")
		{
			return Some(start..colon.end_byte());
		}
		node = node.child(0)?;
	}
}

/// Body-holding child kinds for grammars that expose no `body` field; their
/// first named child is a statement or member.
const BODY_KINDS: [&str; 9] = [
	"block",
	"statement_block",
	"compound_statement",
	"class_body",
	"declaration_list",
	"field_declaration_list",
	"body_statement",
	"do_block",
	"function_body",
];

/// Tokens that open a body on their own line.
const BODY_OPENERS: [&str; 5] = ["{", "do", ":", "begin", "then"];

/// Last row holding a content byte of `node` (see [`node_content_end_line`]).
fn content_end_row(node: Node<'_>) -> usize {
	let pos = node.end_position();
	if pos.column == 0 && pos.row > node.start_position().row {
		pos.row - 1
	} else {
		pos.row
	}
}

/// A chain companion cannot introduce another statement owner.
fn introduces_body(node: Node<'_>) -> bool {
	let mut cursor = node.walk();
	loop {
		let current = cursor.node();
		if statement_container(current)
			|| current.child_by_field_name("body").is_some()
			|| current.child_by_field_name("accessors").is_some()
		{
			return true;
		}
		if cursor.goto_first_child() {
			continue;
		}
		loop {
			if cursor.goto_next_sibling() {
				break;
			}
			if !cursor.goto_parent() {
				return false;
			}
		}
	}
}

/// The body of `node`: its `body` (or C# `accessors`) field or a body-like
/// child, or else the body of the construct an explicit wrapper holds: a
/// decorated or exported definition, a C++ template's declaration, a C
/// declaration's `struct`/`union`/`enum` type, an Odin procedure
/// declaration's procedure, a declaration's `value`, or
/// the single construct a statement wraps. Statement and member containers,
/// calls and preprocessor conditionals are no wrappers, so a later sibling's
/// or argument's body is never taken for this node's.
fn body_of(node: Node<'_>) -> Option<Node<'_>> {
	let mut current = node;
	for _ in 0..=PROOF_DEPTH {
		if current.named_child_count() == 0 {
			return None;
		}
		// A statement container is itself a body, not a construct holding one.
		if statement_container(current) {
			return None;
		}
		let body = ["body", "accessors"]
			.into_iter()
			.find_map(|field| current.child_by_field_name(field))
			.or_else(|| {
				let mut cursor = current.walk();
				current
					.named_children(&mut cursor)
					.find(|child| BODY_KINDS.contains(&child.kind()))
			});
		// An `if` whose consequence is a bare statement holds no body of its
		// own: its `else` block is never taken for one.
		if body.is_some_and(|body| {
			current
				.child_by_field_name("alternative")
				.is_some_and(|alternative| alternative.id() == body.id())
		}) {
			return current.child_by_field_name("consequence");
		}
		if body.is_some() {
			return body;
		}
		let wrapped = ["definition", "declaration", "value"]
			.into_iter()
			.find_map(|field| current.child_by_field_name(field));
		let mut cursor = current.walk();
		let mut children = current.named_children(&mut cursor);
		current = match current.kind() {
			"template_declaration" => wrapped.or_else(|| {
				children.by_ref().skip(1).find(|child| {
					["_definition", "_declaration", "_specifier"]
						.iter()
						.any(|suffix| child.kind().ends_with(suffix))
				})
			}),
			"declaration" | "type_definition" => current
				.child_by_field_name("type")
				.filter(|kind| kind.kind().ends_with("_specifier")),
			// Odin: `name :: proc() {…}`.
			"procedure_declaration" => children.find(|child| child.kind() == "procedure"),
			kind if kind.contains("call") => None,
			"labeled_statement" => current
				.child_by_field_name("body")
				.or_else(|| current.child_by_field_name("statement"))
				.or_else(|| {
					children
						.filter(|child| {
							!child.is_extra()
								&& !matches!(child.kind(), "label" | "statement_label" | "identifier")
						})
						.last()
				}),
			_ => wrapped.or_else(|| {
				let only = children.next()?;
				(children.next().is_none() && only.start_position().row == current.start_position().row)
					.then_some(only)
			}),
		}?;
	}
	None
}

/// Row where `body`'s content begins: the line after a real opening token,
/// or the first statement's line in a statement container. `None` for an
/// empty one-line body, an expression body, or one opening with anything
/// else (`=>`, `=`).
fn body_start(body: Node<'_>) -> Option<usize> {
	// A statement standing as the body (a `case` clause's first statement)
	// starts the body itself, whatever token it opens with.
	if body.kind().ends_with("_statement") && !BODY_KINDS.contains(&body.kind()) {
		return Some(body.start_position().row);
	}
	let first = body.child(0)?;
	let row = if first.is_named() && BODY_KINDS.contains(&body.kind()) {
		first.start_position().row
	} else if !first.is_named() && BODY_OPENERS.contains(&first.kind()) {
		content_end_row(first) + 1
	} else {
		return None;
	};
	(row <= content_end_row(body)).then_some(row)
}

/// 0-indexed row at which the top of `node`'s body begins, strictly below
/// `node`'s opening row.
fn body_insert_row(node: Node<'_>) -> Option<usize> {
	let anchor_row = node.start_position().row;
	let row = match body_of(node) {
		Some(body) => body_start(body)?,
		None => entries_row(node)?,
	};
	(row > anchor_row).then_some(row)
}

/// First entry row of a node made of a one-line header and entries.
fn entries_row(mut node: Node<'_>) -> Option<usize> {
	for depth in 0..=PROOF_DEPTH {
		let anchor_row = node.start_position().row;
		if content_end_row(node) == anchor_row {
			return None;
		}
		let mut cursor = node.walk();
		let mut children = node.named_children(&mut cursor);
		let header = children.next()?;
		let entries = match node.kind() {
			"section" if header.kind() == "atx_heading" => Some(content_end_row(header) + 1),
			"element" if matches!(header.kind(), "start_tag" | "STag") => {
				Some(content_end_row(header) + 1)
			},
			"jsx_element" if header.kind() == "jsx_opening_element" => {
				Some(content_end_row(header) + 1)
			},
			"table" | "table_array_element" if content_end_row(header) == anchor_row => {
				Some(anchor_row + 1)
			},
			"block_mapping_pair" => node
				.child_by_field_name("value")
				.map(|value| value.start_position().row),
			"block_sequence_item"
				if header.kind() == "block_node"
					&& header
						.named_child(0)
						.is_some_and(|value| value.kind() == "block_mapping") =>
			{
				Some(anchor_row)
			},
			"pair" => node
				.child_by_field_name("value")
				.filter(|value| matches!(value.kind(), "object" | "array"))
				.map(|value| value.start_position().row + 1),
			_ => None,
		};
		if entries.is_some() {
			return entries;
		}
		if depth == PROOF_DEPTH
			|| children.next().is_some()
			|| header.start_position().row != anchor_row
		{
			return None;
		}
		node = header;
		if let Some(body) = body_of(node) {
			return body_start(body).filter(|row| *row > anchor_row);
		}
	}
	None
}

/// Run `inspect` on the outermost named node beginning on `line` (see
/// [`block_range_at`]).
fn with_block_node<R>(
	code: &str,
	lang: Option<&str>,
	path: Option<&str>,
	line: u32,
	inspect: impl FnOnce(Node<'_>) -> R,
) -> Result<Option<R>> {
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang, path) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(code, row) else {
		return Ok(None);
	};

	let Some(tree) = parse_cached(code, language)? else {
		return Ok(None);
	};
	Ok(block_node(tree.root_node(), row, col).map(inspect))
}

/// The outermost named node beginning on `row` (whose first content byte is
/// at `col`) below `root`, unless its subtree holds a syntax error.
fn block_node(root: Node<'_>, row: usize, col: usize) -> Option<Node<'_>> {
	// Query a one-column-wide range over the first content character rather
	// than a zero-width point. Some grammars (e.g. tree-sitter-swift) insert a
	// zero-width separator node at the start of a statement that follows a
	// blank line. An empty point range at that node's start gets absorbed into
	// the invisible node, which has no children and is not "relevant", so
	// `named_descendant_for_point_range` bubbles back up to the last visible
	// ancestor (the enclosing body, or the file root). That made `replace
	// block` on a line like `var body: some View {` preceded by a blank line
	// resolve to the whole enclosing type body and then fail. Spanning the
	// first character skips the zero-width node (its end is < the range end)
	// and forces the descent into the node that begins on `row`.
	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let leaf = root.named_descendant_for_point_range(point, point_end)?;
	// A leaf whose own start row is earlier than `row` means `point` landed on
	// a continuation line or a closing delimiter of a block that opened earlier
	// — there is no block *beginning* on line N.
	if leaf.start_position().row != row {
		return None;
	}
	// Climb to the outermost named ancestor that still begins on `row`,
	// excluding the whole-file root. The first parent that starts before `row`
	// stops the climb, and so does a statement-sequence container: it begins
	// exactly where its first statement does, so adopting it would swallow
	// every following sibling statement.
	let mut node = leaf;
	while let Some(parent) = node.parent() {
		if parent.id() == root.id() {
			break;
		}
		if parent.start_position().row != row {
			break;
		}
		if is_statement_sequence(parent, node) {
			break;
		}
		node = parent;
	}
	// Refuse degenerate error-recovery spans: a missing brace can make
	// tree-sitter wrap a huge region in an ERROR node. Checking only the
	// resolved node's subtree (not the whole file) keeps an unrelated syntax
	// error elsewhere from disabling the feature.
	if node.has_error() {
		return None;
	}
	Some(node)
}

/// Is `parent` a statement-sequence container that `node` merely opens? These
/// nodes wrap the sibling statements or entries of a body without a token of
/// their own, so they begin exactly where their first child does: Go and
/// PowerShell `statement_list`, Python/Starlark/Lua `block`, Ruby
/// `body_statement`, Swift/Kotlin `statements`, HCL/CMake `body`, Scala
/// `indented_block`, YAML `block_mapping`/`block_sequence`, Kotlin
/// `import_list`, PowerShell `hash_literal_body`.
///
/// The container is matched by kind because grammars expose no uniform
/// structural marker: field-less prefix runs such as Java/Kotlin/Swift
/// `modifiers` (one annotation per line) look identical but must be climbed
/// through to reach the declaration. Braced `block`s never match because they
/// begin at `{`; requiring the next sibling to start a later row at `node`'s
/// column also rules out a leading label (`'a: {` in Rust). Extras (comments)
/// are skipped when looking for that next sibling, so `if … {} // note` and
/// comment-only lines — even dedented ones — still stop the climb. When only
/// extras follow `node`, the container merely adds those trailing comments to
/// `node`'s span, so the climb stops there too rather than swallowing them.
fn is_statement_sequence(parent: Node<'_>, node: Node<'_>) -> bool {
	if !matches!(
		parent.kind(),
		"statement_list"
			| "block"
			| "body_statement"
			| "statements"
			| "body"
			| "indented_block"
			| "block_mapping"
			| "block_sequence"
			| "import_list"
			| "hash_literal_body"
	) || parent.start_byte() != node.start_byte()
	{
		return false;
	}
	let end_row = node.end_position().row;
	let mut next = node.next_named_sibling();
	let mut skipped_extra = false;
	while let Some(sibling) = next.filter(|s| s.is_extra()) {
		skipped_extra = true;
		next = sibling.next_named_sibling();
	}
	match next {
		Some(next) => {
			let next_start = next.start_position();
			next_start.row > end_row && next_start.column == node.start_position().column
		},
		None => skipped_extra,
	}
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LineRange {
	/// 1-indexed inclusive first visible line.
	pub start_line: u32,
	/// 1-indexed inclusive last visible line.
	pub end_line:   u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnclosingBoundaryOptions {
	/// Source code to inspect.
	pub code:   String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:   Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:   Option<String>,
	/// 1-indexed inclusive visible line ranges (the lines actually shown).
	pub ranges: Vec<LineRange>,
}

/// Sort, drop invalid, and merge adjacent/overlapping ranges so visibility
/// tests can binary-search a non-overlapping list.
fn normalize_ranges(mut ranges: Vec<LineRange>) -> Vec<LineRange> {
	ranges.retain(|range| range.start_line > 0 && range.end_line >= range.start_line);
	ranges.sort_by(|a, b| {
		a.start_line
			.cmp(&b.start_line)
			.then(a.end_line.cmp(&b.end_line))
	});
	let mut merged: Vec<LineRange> = Vec::with_capacity(ranges.len());
	for range in ranges {
		if let Some(last) = merged.last_mut()
			&& range.start_line <= last.end_line.saturating_add(1)
		{
			last.end_line = last.end_line.max(range.end_line);
			continue;
		}
		merged.push(range);
	}
	merged
}

fn is_visible(merged: &[LineRange], line: u32) -> bool {
	merged
		.binary_search_by(|range| {
			if line < range.start_line {
				std::cmp::Ordering::Greater
			} else if line > range.end_line {
				std::cmp::Ordering::Less
			} else {
				std::cmp::Ordering::Equal
			}
		})
		.is_ok()
}

/// Does any visible line fall inside the inclusive line span `[start, end]`?
fn intersects_visible(merged: &[LineRange], start: u32, end: u32) -> bool {
	// `merged` is sorted and non-overlapping, so the first range that can
	// possibly overlap is the first one whose `end_line` reaches `start`.
	let idx = merged.partition_point(|range| range.end_line < start);
	merged.get(idx).is_some_and(|range| range.start_line <= end)
}

/// Depth-first walk collecting boundary lines from every multi-line named node
/// that straddles a visible-range edge. A single reused [`TreeCursor`] keeps
/// the traversal allocation-free.
fn collect_boundaries(cursor: &mut TreeCursor<'_>, merged: &[LineRange], out: &mut BTreeSet<u32>) {
	let node = cursor.node();
	// Prune whole subtrees that cannot contribute. A node contributes only when
	// one of its own endpoint lines is visible, and both of those lines lie
	// inside its raw row span; every descendant's span is contained in this
	// one, so a span holding no visible line rules out this node *and*
	// everything beneath it. Without the prune the walk is O(nodes in file)
	// even though the answer is bounded by the window size — which made the
	// traversal cost roughly twice the parse on a large file.
	let raw_start = node.start_position().row.saturating_add(1) as u32;
	let raw_end = node.end_position().row.saturating_add(1) as u32;
	if !intersects_visible(merged, raw_start, raw_end) {
		return;
	}
	// Skip the whole-file root: its only "boundary" is EOF, never a useful
	// matching line (mirrors `block_range_at` excluding the root).
	if node.is_named() && cursor.depth() > 0 {
		let start = node_start_line(node);
		let end = node_content_end_line(node);
		if end > start {
			let start_visible = is_visible(merged, start);
			let end_visible = is_visible(merged, end);
			// Opener shown, closer off-window → surface the closer (and vice
			// versa). A node fully inside or fully outside the window adds
			// nothing.
			if start_visible && !end_visible {
				out.insert(end);
			} else if end_visible && !start_visible {
				out.insert(start);
			}
		}
	}
	if cursor.goto_first_child() {
		loop {
			collect_boundaries(cursor, merged, out);
			if !cursor.goto_next_sibling() {
				break;
			}
		}
		cursor.goto_parent();
	}
}

/// Generalize "show the matching bracket" to every tree-sitter block: for each
/// multi-line named node whose span crosses the visible window, return the
/// boundary line sitting *outside* that window.
///
/// - node opens on a visible line but closes past the window → its closing line
/// - node closes on a visible line but opens before the window → its opening
///   line
///
/// Because the trigger is an endpoint *inside* the window, the result is
/// bounded by the window size (not nesting depth), exactly like a bracket scan
/// — but it also covers indentation languages (Python) and uses real syntactic
/// spans.
///
/// Returns `None` when the language is unrecognized or the source fails to
/// parse / carries a syntax error (caller falls back to a lexical bracket
/// scan); `Some(sorted unique boundary lines)` otherwise (possibly empty).
pub fn enclosing_block_boundaries(options: EnclosingBoundaryOptions) -> Result<Option<Vec<u32>>> {
	let EnclosingBoundaryOptions { code, lang, path, ranges } = options;
	let merged = normalize_ranges(ranges);
	if code.is_empty() || merged.is_empty() {
		return Ok(Some(Vec::new()));
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();
	// A file-level syntax error makes error-recovery spans unreliable; defer to
	// the lexical scanner rather than emit boundaries off a broken tree.
	if root.has_error() {
		return Ok(None);
	}

	let mut boundaries = BTreeSet::new();
	let mut cursor = root.walk();
	collect_boundaries(&mut cursor, &merged, &mut boundaries);
	Ok(Some(boundaries.into_iter().collect()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeSpan {
	/// 1-indexed inclusive first line of the node.
	pub start_line: u32,
	/// 1-indexed inclusive last content line of the node.
	pub end_line:   u32,
	/// Tree-sitter grammar node kind (e.g. `attribute_item`, `function_item`).
	pub kind:       String,
}

/// Named-node chain containing `options.line`, innermost-first, excluding the
/// whole-file root.
///
/// The chain descends through the line's first content character, so
/// single-line nodes beginning on the line (attributes, decorators, one-line
/// statements) come first, followed by every enclosing construct up to — but
/// not including — the file root. Callers use it to classify a line by grammar
/// node kind and to enumerate enclosing construct end lines.
///
/// ERROR and MISSING recovery nodes are skipped rather than failing the whole
/// chain: an unrelated syntax error elsewhere in the file leaves healthy
/// ancestors' spans meaningful.
///
/// Returns `None` when the language is unrecognized, the line is out of
/// range / blank, or the source fails to parse entirely.
pub fn node_chain_at(options: BlockRangeOptions) -> Result<Option<Vec<NodeSpan>>> {
	let BlockRangeOptions { code, lang, path, line } = options;
	if line == 0 || code.is_empty() {
		return Ok(None);
	}
	let Some(language) = resolve_language(lang.as_deref(), path.as_deref()) else {
		return Ok(None);
	};
	let row = (line - 1) as usize;
	let Some(col) = first_content_column(&code, row) else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&code, language)? else {
		return Ok(None);
	};
	let root = tree.root_node();
	// One-column-wide range for the same zero-width-node reason as
	// `block_range_at` above.
	let point = Point::new(row, col);
	let point_end = Point::new(row, col + 1);
	let Some(leaf) = root.named_descendant_for_point_range(point, point_end) else {
		return Ok(None);
	};
	let mut chain = Vec::new();
	let mut node = Some(leaf);
	while let Some(current) = node {
		if current.id() == root.id() {
			break;
		}
		if current.is_named() && !current.is_error() && !current.is_missing() {
			chain.push(NodeSpan {
				start_line: node_start_line(current),
				end_line:   node_content_end_line(current),
				kind:       current.kind().to_string(),
			});
		}
		node = current.parent();
	}
	Ok(Some(chain))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn resolve(code: &str, path: &str, line: u32) -> Option<BlockRange> {
		block_range_at(BlockRangeOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
			line,
		})
		.expect("block resolution succeeds")
	}

	fn chain(code: &str, path: &str, line: u32) -> Vec<NodeSpan> {
		node_chain_at(BlockRangeOptions {
			code: code.to_string(),
			lang: None,
			path: Some(path.to_string()),
			line,
		})
		.expect("chain resolution succeeds")
		.expect("language recognized and line non-blank")
	}

	const RUST_ANNOTATED: &str = "mod m {\n   impl S {\n      #[napi]\n      fn f(&self) -> u32 \
	                              {\n         1\n      }\n   }\n}\n";

	/// A consumer classifying an attribute row must find a single-line
	/// `attribute_item` in the chain at that line.
	#[test]
	fn chain_names_rust_attribute_row() {
		let spans = chain(RUST_ANNOTATED, "x.rs", 3);
		assert!(
			spans
				.iter()
				.any(|s| s.kind == "attribute_item" && s.start_line == 3 && s.end_line == 3),
			"{spans:?}"
		);
	}

	/// A consumer relocating past enclosing constructs needs the chain at a
	/// construct's opening line to carry every enclosing end line,
	/// innermost-first. Wrapper nodes (`block`, `declaration_list`) share end
	/// lines with their construct; consumers dedupe.
	#[test]
	fn chain_orders_enclosing_ends_innermost_first() {
		let spans = chain(RUST_ANNOTATED, "x.rs", 4);
		let mut ends: Vec<u32> = spans
			.iter()
			.filter(|s| s.end_line > 4)
			.map(|s| s.end_line)
			.collect();
		ends.dedup();
		// fn f ends on 6, impl on 7, mod on 8.
		assert_eq!(ends, vec![6, 7, 8]);
	}

	/// TypeScript decorators are children of the declaration they precede; the
	/// chain at the decorator line must still surface the single-line
	/// `decorator` node.
	#[test]
	fn chain_names_ts_decorator_row() {
		let code = "/** d */\n@Injectable()\nclass Service {}\n";
		let spans = chain(code, "x.ts", 2);
		assert!(
			spans
				.iter()
				.any(|s| s.kind == "decorator" && s.start_line == 2 && s.end_line == 2),
			"{spans:?}"
		);
	}

	/// Blank lines carry no chain; unknown languages resolve to `None`.
	#[test]
	fn chain_declines_blank_lines_and_unknown_languages() {
		let blank = node_chain_at(BlockRangeOptions {
			code: "a\n\nb\n".to_string(),
			lang: None,
			path: Some("x.ts".to_string()),
			line: 2,
		})
		.unwrap();
		assert_eq!(blank, None);
		let unknown = node_chain_at(BlockRangeOptions {
			code: "a\n".to_string(),
			lang: None,
			path: Some("x.unknownext".to_string()),
			line: 1,
		})
		.unwrap();
		assert_eq!(unknown, None);
	}

	const TS_EXAMPLE: &str = "function x() {\n  if (y) {\n  }\n}\n";

	#[test]
	fn resolves_inner_if_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_enclosing_function_block() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 1), Some(BlockRange { start_line: 1, end_line: 4 }));
	}

	#[test]
	fn lone_closing_brace_resolves_to_nothing() {
		// Line 3 is `  }` — the closing delimiter of a block that opened on an
		// earlier line, so no block *begins* there.
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 3), None);
	}

	#[test]
	fn blank_line_resolves_to_nothing() {
		let code = "function x() {\n\n  return 1;\n}\n";
		assert_eq!(resolve(code, "x.ts", 2), None);
	}

	#[test]
	fn out_of_range_line_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 99), None);
		assert_eq!(resolve(TS_EXAMPLE, "x.ts", 0), None);
	}

	#[test]
	fn unrecognized_extension_resolves_to_nothing() {
		assert_eq!(resolve(TS_EXAMPLE, "x.unknownext", 2), None);
	}

	#[test]
	fn resolves_zsh_if_block_in_extensionless_rc_file() {
		// Regression: an extensionless shell rc file (`zshrc`/`.zshrc`) must
		// infer the bash grammar so `replace block` / `insert after block`
		// works. Previously `Path::extension` returned `None`, leaving block
		// ops permanently unresolvable on these files.
		let code = "ZSH_COMPDUMP=x\nif [[ -f \"$ZSH_COMPDUMP\" ]]; then\n  compinit -C\nelse\n  \
		            compinit\nfi\n";
		let span = Some(BlockRange { start_line: 2, end_line: 6 });
		assert_eq!(resolve(code, "modules/zsh/zshrc", 2), span);
		assert_eq!(resolve(code, ".zshrc", 2), span);
		assert_eq!(resolve(code, "/home/u/.bashrc", 2), span);
	}

	#[test]
	fn resolves_top_level_python_def() {
		let code = "x = 1\ndef greet():\n    return 1\n";
		assert_eq!(resolve(code, "g.py", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn resolves_inner_python_block() {
		// Point at the `for` loop inside the function body. The suite's first
		// statement is `total = 0` (line 2), so the `for` at line 3 is not the
		// suite's first child and climbs only to the `for_statement`, not the
		// whole function suite.
		let code =
			"def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
		assert_eq!(resolve(code, "f.py", 3), Some(BlockRange { start_line: 3, end_line: 4 }));
	}

	#[test]
	fn go_leading_statement_excludes_following_siblings() {
		// tree-sitter-go wraps a block body in a `statement_list` that begins
		// exactly at its first statement; the leading `if` must not resolve to
		// the whole list and swallow the statements after it.
		let code = "package p\n\nfunc f() error {\n\tif err := step(); err != nil {\n\t\treturn \
		            err\n\t}\n\tother()\n\treturn nil\n}\n";
		assert_eq!(resolve(code, "x.go", 4), Some(BlockRange { start_line: 4, end_line: 6 }));
		assert_eq!(resolve(code, "x.go", 3), Some(BlockRange { start_line: 3, end_line: 9 }));
	}

	#[test]
	fn python_leading_statement_excludes_following_siblings() {
		let code = "def f(x):\n    if x:\n        return 1\n    y = 2\n    return y\n";
		assert_eq!(resolve(code, "f.py", 2), Some(BlockRange { start_line: 2, end_line: 3 }));
	}

	#[test]
	fn leading_statement_with_trailing_comment_excludes_following_siblings() {
		// A comment on the statement's last row is a named sibling; it must not
		// hide the next statement and let the climb swallow the whole body.
		let go = "package p\n\nfunc f() error {\n\tif err := step(); err != nil {\n\t\treturn \
		          err\n\t} // note\n\tother()\n\treturn nil\n}\n";
		assert_eq!(resolve(go, "x.go", 4), Some(BlockRange { start_line: 4, end_line: 6 }));
		let py = "def f(x):\n    y = 2  # note\n    z = 3\n    return y\n";
		assert_eq!(resolve(py, "f.py", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
	}

	#[test]
	fn leading_statement_with_dedented_comment_excludes_following_siblings() {
		// A comment-only line at a different column is still an extra between
		// statements; it must not hide the next statement and let the climb
		// swallow the whole body.
		let code = "def f(x):\n    y = 2\n# dedented\n    z = 3\n    return y\n";
		assert_eq!(resolve(code, "f.py", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
	}

	// Only comments follow the body's last statement: the container adds
	// nothing but those comments, so they must stay outside the block.
	#[test]
	fn python_last_statement_with_trailing_comments_excludes_them() {
		let one = "def f(x):\n    y = 2\n    # trailing\n";
		assert_eq!(resolve(one, "f.py", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
		let two = "def f(x):\n    y = 2\n    # one\n    # two\n";
		assert_eq!(resolve(two, "f.py", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
	}

	#[test]
	fn ruby_last_statement_with_trailing_comment_excludes_it() {
		let code = "def f\n  x = 1\n  # c\nend\n";
		assert_eq!(resolve(code, "f.rb", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
	}

	#[test]
	fn yaml_last_entry_with_trailing_comment_excludes_it() {
		let top = "a: 1\n# c\n";
		assert_eq!(resolve(top, "c.yml", 1), Some(BlockRange { start_line: 1, end_line: 1 }));
		let nested = "jobs:\n  build: 1\n  # c\nother: 2\n";
		assert_eq!(resolve(nested, "c.yml", 2), Some(BlockRange { start_line: 2, end_line: 2 }));
	}

	#[test]
	fn yaml_first_top_level_key_resolves_only_its_entry() {
		let code = "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  build: {}\n";
		assert_eq!(resolve(code, "ci.yml", 1), Some(BlockRange { start_line: 1, end_line: 1 }));
		assert_eq!(resolve(code, "ci.yml", 3), Some(BlockRange { start_line: 3, end_line: 4 }));
	}

	#[test]
	fn java_stacked_annotations_still_resolve_the_declaration() {
		// One annotation per line forms a `modifiers` run that also begins at
		// its first child; unlike a statement list it must be climbed through.
		let code = "class A {\n  @Override\n  @Deprecated\n  public void f() {\n    g();\n  }\n}\n";
		assert_eq!(resolve(code, "A.java", 2), Some(BlockRange { start_line: 2, end_line: 6 }));
	}

	#[test]
	fn resolves_nested_block_to_outermost_on_line() {
		// Point at the inner `if` line; it resolves the whole `if` block
		// (header through its closing brace), not just the call inside it.
		let code = "function f() {\n  if (a) {\n    g();\n  }\n}\n";
		assert_eq!(resolve(code, "f.ts", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}

	#[test]
	fn multi_statement_line_resolves_first_statement_node() {
		// `let a = 1; let b = 2;` — pointing at the line resolves the first
		// statement that begins at the line's first content column.
		let code = "let a = 1; let b = 2;\n";
		let range = resolve(code, "m.ts", 1);
		assert!(range.is_some(), "expected a block on a single-statement-bearing line");
		assert_eq!(range.unwrap().start_line, 1);
	}

	#[test]
	fn continuation_line_resolves_to_nothing() {
		// A bare argument-continuation line whose first content does not open a
		// new named node beginning on that row.
		let code = "foo(\n  a,\n  b,\n);\n";
		// Line 2 (`  a,`) is an argument — `a` is an identifier beginning on the
		// row, so it DOES resolve. Use the closing `);` line instead, which is
		// a continuation/closer of the call begun earlier.
		assert_eq!(resolve(code, "c.ts", 4), None);
	}

	#[test]
	fn error_subtree_resolves_to_nothing() {
		// Missing closing brace: the function's subtree carries an ERROR, so we
		// refuse to resolve a degenerate recovery span.
		let code = "function broken() {\n  if (y) {\n}\n";
		assert_eq!(resolve(code, "b.ts", 1), None);
	}

	#[test]
	fn resolves_rust_struct_block() {
		let code = "struct A;\nstruct B {\n    x: u32,\n}\n";
		assert_eq!(resolve(code, "r.rs", 2), Some(BlockRange { start_line: 2, end_line: 4 }));
	}

	#[test]
	fn resolves_swift_computed_property_after_blank_line() {
		// Regression: a block whose opening line is preceded by a blank line
		// (here the SwiftUI `var body: some View {` computed property) used to
		// resolve to nothing. tree-sitter-swift inserts a zero-width separator
		// node at the start of a statement that follows a blank line; a
		// zero-width point query at the first content column gets absorbed into
		// that invisible node and bubbles back up to the enclosing type body. A
		// one-column-wide query skips the zero-width node and descends into the
		// property that actually begins on the line.
		let code = "struct MenuBarUsage: View {\n    let metric: AccountMetric\n\n    var body: \
		            some View {\n        VStack {\n            Text(\"Usage\")\n        }\n    \
		            }\n}\n";
		assert_eq!(
			resolve(code, "MenuBarUsage.swift", 4),
			Some(BlockRange { start_line: 4, end_line: 8 })
		);
	}

	#[test]
	fn resolves_swift_top_level_decl_after_blank_line() {
		// Same zero-width-separator regression one level up: a top-level
		// declaration following a blank line. Without the fix the query
		// resolved to the whole `source_file` root and was rejected.
		let code = "import Foundation\n\nfunc greet() {\n    print(\"hi\")\n}\n";
		assert_eq!(resolve(code, "g.swift", 3), Some(BlockRange { start_line: 3, end_line: 5 }));
	}

	#[test]
	fn resolves_emacs_lisp_defun_block() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n";
		assert_eq!(resolve(code, "init.el", 1), Some(BlockRange { start_line: 1, end_line: 3 }));
	}
	#[test]
	fn resolves_emacs_lisp_dot_emacs_block() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n";
		assert_eq!(resolve(code, ".emacs", 1), Some(BlockRange { start_line: 1, end_line: 3 }));
	}

	#[test]
	fn resolves_emacs_lisp_macro_style_list_block() {
		let code = "(ert-deftest ogent-zen-test ()\n  \"Doc.\"\n  (should t))\n";
		assert_eq!(
			resolve(code, "test/ogent-zen-tests.el", 1),
			Some(BlockRange { start_line: 1, end_line: 3 })
		);
	}

	#[test]
	fn emacs_lisp_closing_paren_resolves_to_nothing() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name)\n)\n";
		assert_eq!(resolve(code, "init.el", 4), None);
	}

	#[test]
	fn emacs_lisp_visible_opener_surfaces_closer() {
		let code = "(defun greet (name)\n  \"Doc.\"\n  (let ((message (format \"Hello %s\" \
		            name)))\n    (message \"%s\" message))\n)\n";
		assert_eq!(boundaries(code, "init.el", &[(1, 1)]), Some(vec![5]));
	}

	#[test]
	fn emacs_lisp_top_level_macro_forms_resolve_as_single_sexprs() {
		let cases = [
			(
				"use-package",
				"(use-package magit\n  :commands (magit-status)\n  :config\n  (setq \
				 magit-save-repository-buffers nil))\n",
				4,
			),
			(
				"with-eval-after-load",
				"(with-eval-after-load 'org\n  (setq org-startup-indented t)\n  (add-hook \
				 'org-mode-hook #'visual-line-mode))\n",
				3,
			),
			(
				"pcase",
				"(pcase major-mode\n  ('emacs-lisp-mode\n   (message \"elisp\"))\n  (_\n   (message \
				 \"other\")))\n",
				5,
			),
		];

		for (name, code, end_line) in cases {
			assert_eq!(
				resolve(code, "init.el", 1),
				Some(BlockRange { start_line: 1, end_line }),
				"{name}"
			);
		}
	}

	#[test]
	fn resolves_emacs_lisp_explicit_language_block() {
		let result = block_range_at(BlockRangeOptions {
			code: "(defun greet (name)\n  \"Doc.\"\n  (message \"Hello %s\" name))\n".to_string(),
			lang: Some("emacs-lisp".to_string()),
			path: None,
			line: 1,
		})
		.expect("block resolution succeeds");
		assert_eq!(result, Some(BlockRange { start_line: 1, end_line: 3 }));
	}

	fn boundaries(code: &str, path: &str, ranges: &[(u32, u32)]) -> Option<Vec<u32>> {
		enclosing_block_boundaries(EnclosingBoundaryOptions {
			code:   code.to_string(),
			lang:   None,
			path:   Some(path.to_string()),
			ranges: ranges
				.iter()
				.map(|&(start_line, end_line)| LineRange { start_line, end_line })
				.collect(),
		})
		.expect("boundary resolution succeeds")
	}

	const TS_FN: &str = "function outer() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  \
	                     return a + b + c;\n}\nafter();\n";

	#[test]
	fn surfaces_closing_brace_for_visible_opener() {
		// Window is the opening line only; its block closes on line 6.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), Some(vec![6]));
	}

	#[test]
	fn surfaces_opening_brace_for_visible_closer() {
		// Window is the closing line only; its block opens on line 1.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
	}

	#[test]
	fn interior_only_window_adds_no_boundary() {
		// Neither the opener (1) nor the closer (6) is visible, so the bracket
		// scan would add nothing — and neither do we.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
	}

	#[test]
	fn whole_file_window_adds_no_boundary() {
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 7)]), Some(vec![]));
	}

	#[test]
	fn python_indentation_block_uses_syntactic_span() {
		// Python has no closing delimiter — the def's span ends at the last
		// body line. Showing the `def` header surfaces that end line.
		let code = "def greet(name):\n    a = 1\n    b = 2\n    return a + b\n";
		assert_eq!(boundaries(code, "g.py", &[(1, 1)]), Some(vec![4]));
	}

	#[test]
	fn syntax_error_falls_back_to_none() {
		let code = "function broken() {\n  if (y) {\n";
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None);
	}

	#[test]
	fn unrecognized_language_falls_back_to_none() {
		assert_eq!(boundaries(TS_FN, "x.unknownext", &[(1, 1)]), None);
	}

	const MD_DOC: &str = "# H1\nintro\n\n## H2 alpha\nbody a\nmore a\n\n### H3 deep\ndeep \
	                      body\n\n## H2 beta\nbody b\n";

	#[test]
	fn resolves_markdown_h2_to_whole_section() {
		// tree-sitter-md nests the heading and its body (including deeper
		// subsections) in one `section` node, so anchoring the `## H2 alpha`
		// line (4) resolves the whole section — heading through the nested
		// `### H3 deep` and its trailing blank, up to the next `## H2 beta`.
		assert_eq!(resolve(MD_DOC, "plan.md", 4), Some(BlockRange { start_line: 4, end_line: 10 }));
	}

	#[test]
	fn resolves_markdown_h3_to_its_subsection() {
		// A deeper heading resolves only its own subsection, not the enclosing
		// `## H2` — the `### H3 deep` section spans line 8 through its body.
		assert_eq!(resolve(MD_DOC, "plan.md", 8), Some(BlockRange { start_line: 8, end_line: 10 }));
	}

	#[test]
	fn resolves_markdown_h1_to_whole_document_section() {
		// The top-level heading owns every nested section, so `# H1` resolves
		// the entire document body.
		assert_eq!(resolve(MD_DOC, "plan.md", 1), Some(BlockRange { start_line: 1, end_line: 12 }));
	}

	#[test]
	fn markdown_blank_line_resolves_to_nothing() {
		// A blank separator line opens no section.
		assert_eq!(resolve(MD_DOC, "plan.md", 3), None);
	}

	// ── parse cache ───────────────────────────────────────────────────────────
	//
	// These cover the process-global cache end to end. The cache is shared with
	// the rest of this crate's suite running in parallel, so nothing here
	// asserts on occupancy or counters — only on boundary values, which must
	// come out identical no matter what else happens to be resident. Occupancy,
	// eviction, and LRU order are asserted deterministically on private `Cache`
	// instances in `parse_cache::tests`.

	use crate::parse_cache::{MAX_ENTRIES, clear_parse_cache};

	#[test]
	fn repeat_query_yields_identical_boundaries() {
		clear_parse_cache();
		let first = boundaries(TS_FN, "x.ts", &[(1, 1)]);
		let second = boundaries(TS_FN, "x.ts", &[(1, 1)]);

		assert_eq!(first, Some(vec![6]));
		assert_eq!(second, first, "identical input must yield identical boundaries");

		// A different window over the same bytes must still be answered per
		// window: the cache holds the tree, not the boundary list, which is why
		// a result cache would not have worked.
		assert_eq!(boundaries(TS_FN, "x.ts", &[(6, 6)]), Some(vec![1]));
		assert_eq!(boundaries(TS_FN, "x.ts", &[(3, 4)]), Some(vec![]));
		assert_eq!(boundaries(TS_FN, "x.ts", &[(1, 1)]), first);
	}

	#[test]
	fn same_bytes_under_two_languages_do_not_share_a_tree() {
		// Valid Python, a syntax error as TypeScript. If the language were not
		// part of the cache key, whichever call ran first would answer for both.
		let code = "def greet(name):\n    a = 1\n    return a\n";

		clear_parse_cache();
		let py_cold = boundaries(code, "x.py", &[(1, 1)]);
		clear_parse_cache();
		let ts_cold = boundaries(code, "x.ts", &[(1, 1)]);
		assert_eq!(py_cold, Some(vec![3]));
		assert_eq!(ts_cold, None);

		clear_parse_cache();
		assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
		assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);

		// Reverse order, to rule out an order-dependent answer.
		clear_parse_cache();
		assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), ts_cold);
		assert_eq!(boundaries(code, "x.py", &[(1, 1)]), py_cold);
	}

	#[test]
	fn single_byte_difference_yields_different_boundaries() {
		// Equal length, one byte apart: the second form replaces the newline
		// after `a()` with `;`, folding four lines into three. The `len` field in
		// the cache key cannot separate these — only the content hash and the
		// verified byte comparison can.
		let four_lines = "function f() {\n  a()\n  b()\n}\n";
		let three_lines = "function f() {\n  a();  b()\n}\n";
		assert_eq!(four_lines.len(), three_lines.len(), "fixtures must be equal length");
		assert_eq!(
			four_lines
				.bytes()
				.zip(three_lines.bytes())
				.filter(|(a, b)| a != b)
				.count(),
			1,
			"fixtures must differ by exactly one byte"
		);

		clear_parse_cache();
		assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
		assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
		// Again with both resident, in the opposite order.
		assert_eq!(boundaries(three_lines, "x.ts", &[(1, 1)]), Some(vec![3]));
		assert_eq!(boundaries(four_lines, "x.ts", &[(1, 1)]), Some(vec![4]));
	}

	#[test]
	fn syntax_error_stays_none_across_repeat_calls() {
		// The error tree *is* cached, so repeated "does this parse" probes get
		// the speedup too; `None` comes from the caller's own `has_error()` check
		// reading that tree, not from refusing to cache it.
		let code = "function broken() {\n  if (y) {\n";
		clear_parse_cache();
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "first call");
		assert_eq!(boundaries(code, "b.ts", &[(1, 1)]), None, "second call");
		assert_eq!(boundaries(code, "b.ts", &[(1, 2)]), None, "different window, still none");
	}

	#[test]
	fn cached_error_tree_matches_uncached_verdicts_for_both_callers() {
		// `enclosing_block_boundaries` rejects any file-level error;
		// `block_range_at` rejects only errors inside the resolved subtree. Both
		// now read that verdict off one shared cached tree, so each must still
		// reach the answer it reached from its own cold parse.
		let code = "function ok() {\n  a();\n}\nfunction broken( {\n";

		clear_parse_cache();
		let cold_boundaries = boundaries(code, "x.ts", &[(1, 1)]);
		clear_parse_cache();
		let cold_range = resolve(code, "x.ts", 1);
		assert_eq!(cold_boundaries, None, "a file-level error disables boundaries");

		clear_parse_cache();
		for pass in 0..2 {
			assert_eq!(boundaries(code, "x.ts", &[(1, 1)]), cold_boundaries, "pass {pass}");
			assert_eq!(resolve(code, "x.ts", 1), cold_range, "pass {pass}");
		}
	}

	#[test]
	fn keys_evicted_past_the_cache_bound_still_answer_correctly() {
		// `f{i}` with `i + 1` body lines closes on line `i + 3`, so the expected
		// boundary for a window on line 1 is a function of `i` — a neighbouring
		// entry's tree would produce a visibly wrong answer.
		let sources: Vec<String> = (0..MAX_ENTRIES * 2)
			.map(|i| format!("function f{i}() {{\n{}}}\n", "  step();\n".repeat(i + 1)))
			.collect();
		let expect = |i: usize| Some(vec![i as u32 + 3]);

		clear_parse_cache();
		for (i, source) in sources.iter().enumerate() {
			assert_eq!(boundaries(source, "x.ts", &[(1, 1)]), expect(i), "cold pass {i}");
		}

		// Source 0 was evicted well before the loop ended (twice `MAX_ENTRIES`
		// distinct sources went through a cache holding `MAX_ENTRIES`), so this
		// re-parses. It must answer correctly rather than serve a survivor.
		assert_eq!(boundaries(&sources[0], "x.ts", &[(1, 1)]), expect(0), "evicted key");
		// And the tail, still resident, must not have been disturbed.
		let last = sources.len() - 1;
		assert_eq!(boundaries(&sources[last], "x.ts", &[(1, 1)]), expect(last), "resident key");
	}

	// ── prune equivalence ─────────────────────────────────────────────────────
	//
	// `collect_boundaries` skips subtrees whose raw line span holds no visible
	// line. That is argued to be exact, but the output feeds hashline block
	// resolution, so a silently dropped line corrupts edits rather than just
	// degrading display. The argument is therefore backed by a differential
	// against the pre-prune traversal over the repository's own sources, not by
	// hand-written expectations.

	use std::path::{Path, PathBuf};

	/// The pre-prune traversal, kept verbatim as the differential reference: it
	/// visits every node in the tree.
	fn collect_boundaries_unpruned(
		cursor: &mut TreeCursor<'_>,
		merged: &[LineRange],
		out: &mut BTreeSet<u32>,
	) {
		let node = cursor.node();
		if node.is_named() && node.parent().is_some() {
			let start = node_start_line(node);
			let end = node_content_end_line(node);
			if end > start {
				let start_visible = is_visible(merged, start);
				let end_visible = is_visible(merged, end);
				if start_visible && !end_visible {
					out.insert(end);
				} else if end_visible && !start_visible {
					out.insert(start);
				}
			}
		}
		if cursor.goto_first_child() {
			loop {
				collect_boundaries_unpruned(cursor, merged, out);
				if !cursor.goto_next_sibling() {
					break;
				}
			}
			cursor.goto_parent();
		}
	}

	/// [`enclosing_block_boundaries`] with the unpruned walk substituted in.
	/// Every early return is reproduced in the same order, so the differential
	/// also covers the empty-code, empty-range, unresolved-language and
	/// `has_error` paths.
	fn boundaries_unpruned(code: &str, path: &str, ranges: &[(u32, u32)]) -> Option<Vec<u32>> {
		let merged = normalize_ranges(
			ranges
				.iter()
				.map(|&(start_line, end_line)| LineRange { start_line, end_line })
				.collect(),
		);
		if code.is_empty() || merged.is_empty() {
			return Some(Vec::new());
		}
		let language = resolve_language(None, Some(path))?;
		let tree = parse_cached(code, language).expect("grammar loads")?;
		let root = tree.root_node();
		if root.has_error() {
			return None;
		}
		let mut boundaries = BTreeSet::new();
		let mut cursor = root.walk();
		collect_boundaries_unpruned(&mut cursor, &merged, &mut boundaries);
		Some(boundaries.into_iter().collect())
	}

	/// Range shapes exercised per file: head, middle, tail, a single interior
	/// line, three disjoint windows, the whole file visible, a window entirely
	/// past EOF, and the empty range list.
	fn window_shapes(lines: u32) -> Vec<Vec<(u32, u32)>> {
		let last = lines.max(1);
		let mid = (lines / 2).max(1);
		let tail_start = lines.saturating_sub(20).max(1);
		vec![
			vec![(1, 40.min(last))],
			vec![(mid, (mid + 20).min(last))],
			vec![(tail_start, last)],
			vec![(mid, mid)],
			vec![(1, 5.min(last)), (mid, (mid + 5).min(last)), (tail_start, last)],
			vec![(1, last)],
			vec![(last + 10, last + 20)],
			vec![],
		]
	}

	/// Compare pruned against unpruned output for exact `Option<Vec<u32>>`
	/// equality across every shape. Returns (comparisons, `None` verdicts).
	fn assert_prune_equivalent(code: &str, path: &str) -> (usize, usize) {
		let lines = code.split('\n').count() as u32;
		let mut comparisons = 0;
		let mut none_verdicts = 0;
		for shape in window_shapes(lines) {
			let pruned = boundaries(code, path, &shape);
			let unpruned = boundaries_unpruned(code, path, &shape);
			assert_eq!(pruned, unpruned, "{path} ranges={shape:?}");
			if pruned.is_none() {
				none_verdicts += 1;
			}
			comparisons += 1;
		}
		(comparisons, none_verdicts)
	}

	/// Repository `.ts` / `.py` / `.rs` sources, sorted for determinism. With a
	/// budget, files are taken on a stride so the sample spans the whole tree
	/// instead of one directory, skipping anything over 64 KiB.
	fn repo_files(byte_budget: Option<usize>) -> Vec<PathBuf> {
		let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		// Cargo leaves the manifest root available at runtime. Bazel bakes an
		// ephemeral execroot into CARGO_MANIFEST_DIR, so use the workspace
		// runfiles root where the target's hermetic corpus is declared as data.
		// Runfiles leaves are symlinks, so `Path::is_file` below must follow them.
		let root = if manifest_root.join("Cargo.toml").is_file() {
			manifest_root
		} else {
			PathBuf::from(".")
		};
		let mut files: Vec<PathBuf> = ignore::WalkBuilder::new(&root)
			.build()
			.filter_map(Result::ok)
			.filter(|entry| entry.path().is_file())
			.map(ignore::DirEntry::into_path)
			.filter(|path| {
				matches!(path.extension().and_then(std::ffi::OsStr::to_str), Some("ts" | "py" | "rs"))
			})
			.collect();
		files.sort();
		let Some(budget) = byte_budget else {
			return files;
		};
		let stride = (files.len() / 240).max(1);
		let mut picked = Vec::new();
		let mut used = 0;
		for path in files.iter().step_by(stride) {
			let Ok(meta) = std::fs::metadata(path) else {
				continue;
			};
			let len = meta.len() as usize;
			if len == 0 || len > 64 * 1024 {
				continue;
			}
			if used + len > budget {
				break;
			}
			used += len;
			picked.push(path.clone());
		}
		picked
	}

	fn sweep_corpus(files: &[PathBuf]) -> (usize, usize) {
		let mut comparisons = 0;
		let mut none_verdicts = 0;
		for path in files {
			let Ok(code) = std::fs::read_to_string(path) else {
				continue; // non-UTF-8 source; nothing to compare
			};
			let (n, nones) = assert_prune_equivalent(&code, path.to_str().expect("utf-8 path"));
			comparisons += n;
			none_verdicts += nones;
		}
		(comparisons, none_verdicts)
	}

	#[test]
	fn pruned_walk_matches_unpruned_on_repo_corpus_sample() {
		// Sandboxed runners (bazel test) stage only this crate's declared inputs,
		// so the repository corpus this sweep samples is absent (or a symlink
		// farm the walker cannot see through). Both surface as an empty scan —
		// skip then. Whenever the scan finds anything, the evidence assert below
		// still guards against a broken/undersized sample.
		let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
		if !root.join("packages").is_dir() {
			eprintln!("skipping: repository corpus unavailable at {}", root.display());
			return;
		}
		let files = repo_files(Some(768 * 1024));
		if files.is_empty() {
			eprintln!("skipping: repository corpus scan found no sources at {}", root.display());
			return;
		}
		assert!(files.len() > 40, "corpus sample too small to be evidence: {}", files.len());
		let (comparisons, _) = sweep_corpus(&files);
		assert!(comparisons > 300, "expected a broad sweep, got {comparisons} comparisons");
	}

	#[test]
	#[ignore = "full repository sweep; run with `cargo nextest run --release -p pi-ast \
	            --run-ignored ignored-only`"]
	fn pruned_walk_matches_unpruned_on_full_repo_corpus() {
		let files = repo_files(None);
		assert!(files.len() > 3000, "expected the whole corpus, got {}", files.len());
		let (comparisons, _) = sweep_corpus(&files);
		println!("full corpus: {} files, {comparisons} comparisons", files.len());
	}

	#[test]
	fn pruned_walk_matches_unpruned_on_error_and_degenerate_inputs() {
		// The corpus is mostly valid source, so pin the `has_error`,
		// empty-code, empty-range and unresolved-language paths explicitly.
		let cases: &[(&str, &str)] = &[
			("", "x.ts"),
			("\n", "x.ts"),
			("\n\n\n", "x.py"),
			("function broken() {\n  if (y) {\n", "b.ts"),
			("def broken(:\n    pass\n", "b.py"),
			("fn broken( {\n", "b.rs"),
			("function ok() {\n  a();\n}\nfunction broken( {\n", "x.ts"),
			(TS_FN, "x.unknownext"),
		];
		let mut none_verdicts = 0;
		for (code, path) in cases {
			let (_, nones) = assert_prune_equivalent(code, path);
			none_verdicts += nones;
		}
		assert!(none_verdicts > 0, "error / unknown-language cases must exercise the None path");
	}

	/// Large file with a five-level nest in the middle, so a window on the
	/// opening lines has a long chain of closers to surface and the prune has
	/// most of the file to skip. Returns the source and the 1-indexed line of
	/// `function deep() {`.
	fn nested_fixture(pad: usize) -> (String, u32) {
		use std::fmt::Write as _;

		let mut code = String::new();
		for i in 0..pad {
			writeln!(code, "export const pad{i} = {i};").expect("write to String");
		}
		let nest = pad as u32 + 1;
		code.push_str("function deep() {\n");
		code.push_str("\tif (a) {\n");
		code.push_str("\t\twhile (b) {\n");
		code.push_str("\t\t\tfor (;;) {\n");
		code.push_str("\t\t\t\tif (c) {\n");
		code.push_str("\t\t\t\t\tbody();\n");
		code.push_str("\t\t\t\t}\n");
		code.push_str("\t\t\t}\n");
		code.push_str("\t\t}\n");
		code.push_str("\t}\n");
		code.push_str("}\n");
		for i in 0..pad {
			writeln!(code, "export const tail{i} = {i};").expect("write to String");
		}
		(code, nest)
	}

	#[test]
	fn window_deep_inside_nesting_still_returns_the_whole_chain() {
		let (code, nest) = nested_fixture(200);

		// Window covers all five opening lines, which are deep inside a
		// ~411-line file: each construct opens visibly and closes off-window, so
		// the full chain of five closers must come back.
		let openers = [(nest, nest + 4)];
		assert_eq!(
			boundaries(&code, "nested.ts", &openers),
			Some(vec![nest + 6, nest + 7, nest + 8, nest + 9, nest + 10]),
			"closers for every enclosing construct"
		);
		assert_eq!(
			boundaries(&code, "nested.ts", &openers),
			boundaries_unpruned(&code, "nested.ts", &openers)
		);

		// Mirror image: the five closing lines surface the five openers.
		let closers = [(nest + 6, nest + 10)];
		assert_eq!(
			boundaries(&code, "nested.ts", &closers),
			Some(vec![nest, nest + 1, nest + 2, nest + 3, nest + 4])
		);
		assert_eq!(
			boundaries(&code, "nested.ts", &closers),
			boundaries_unpruned(&code, "nested.ts", &closers)
		);

		// A window strictly interior to the nest surfaces nothing — every
		// enclosing node straddles it, so no endpoint is visible. The prune must
		// still descend through those straddling ancestors, which is what the
		// differential over every shape checks.
		assert_eq!(boundaries(&code, "nested.ts", &[(nest + 5, nest + 5)]), Some(vec![]));
		assert_prune_equivalent(&code, "nested.ts");
	}

	/// Count named nodes whose content end line differs from their raw end row,
	/// i.e. nodes ending immediately after a newline.
	fn nodes_with_content_end_before_raw_end(code: &str, path: &str) -> usize {
		let language = resolve_language(None, Some(path)).expect("known language");
		let tree = parse_cached(code, language)
			.expect("grammar loads")
			.expect("tree");
		let mut count = 0;
		let mut stack = vec![tree.root_node()];
		while let Some(node) = stack.pop() {
			let raw_end = node.end_position().row.saturating_add(1) as u32;
			if node.is_named() && node_content_end_line(node) != raw_end {
				count += 1;
			}
			for index in 0..node.child_count() {
				stack.push(node.child(index).expect("child in range"));
			}
		}
		count
	}

	#[test]
	fn content_end_line_before_raw_end_is_still_surfaced() {
		// The inner `def` ends right after `return value\n`, so tree-sitter puts
		// its end position at column 0 of the blank line: raw end row 5, content
		// end line 4. The prune tests the *raw* span, so the node survives a
		// window on either line.
		let code = "def outer():\n    def inner():\n        value = 1\n        return value\n\n    \
		            return inner\n";
		assert!(
			nodes_with_content_end_before_raw_end(code, "x.py") > 0,
			"fixture must actually contain a node whose content end precedes its raw end"
		);

		// Only the content end line is visible: the inner def and its block both
		// close there, so both openers come back.
		assert_eq!(boundaries(code, "x.py", &[(4, 4)]), Some(vec![2, 3]));
		assert_eq!(boundaries(code, "x.py", &[(4, 4)]), boundaries_unpruned(code, "x.py", &[(4, 4)]));

		// And the raw end line (the blank one) on its own.
		assert_eq!(boundaries(code, "x.py", &[(5, 5)]), boundaries_unpruned(code, "x.py", &[(5, 5)]));
		assert_prune_equivalent(code, "x.py");
	}

	fn index<'a>(code: &'a str, path: &str) -> BlockIndex<'a> {
		BlockIndex::new(code, path)
			.expect("grammar loads")
			.expect("known language")
	}

	/// The body start of the construct an insertion below 1-indexed `line`
	/// may belong to.
	fn body_start_below(code: &str, path: &str, line: u32) -> Option<u32> {
		index(code, path)
			.insertion_construct(
				line as usize - 1,
				content_column(code.lines().nth(line as usize - 1)?)?,
			)
			.map(|(_, start)| row_to_line(start))
	}

	/// The top of a block's body lies below the line holding the body's
	/// opening token, or on its first statement, never inside a multi-line
	/// signature; a header-only line yields the next line, and a line opening
	/// no block yields nothing.
	#[test]
	fn body_start_skips_signatures_and_opening_tokens() {
		let at = body_start_below;
		let allman = "class A\n{\n    void F()\n    {\n        x = 1;\n    }\n}\n";
		assert_eq!(at(allman, "x.cs", 3), Some(5));
		let signature = "def f(\n    a,\n):\n    return a\n";
		assert_eq!(at(signature, "x.py", 1), Some(4));
		let jsx = "function Button({\n  label,\n}) {\n  return null;\n}\n";
		assert_eq!(at(jsx, "x.jsx", 1), Some(4));
		let ruby = "def fetch\n  get(url)\nrescue Timeout::Error\n  retry\nend\n";
		assert_eq!(at(ruby, "x.rb", 1), Some(2));
		assert_eq!(at("[deps]\nserde = 1\n", "x.toml", 1), Some(2));
		assert_eq!(at("x = 1\ny = 2\n", "x.py", 1), None);
		assert!(
			BlockIndex::new("plain\ntext\n", "x.txt")
				.expect("no grammar")
				.is_none()
		);
		// Wrapped constructs and accessor bodies; bodies that open with no
		// real token or end on their opening line yield nothing, and neither
		// do a call's arguments.
		let template = "template <typename T>\nT add(T a, T b) {\n    return a + b;\n}\n";
		assert_eq!(at(template, "x.cpp", 1), Some(3));
		let property =
			"class C\n{\n    public int Count\n    {\n        get { return 1; }\n    }\n}\n";
		assert_eq!(at(property, "x.cs", 3), Some(5));
		let arrow = "class C\n{\n    public int Compute(int a)\n        => a + 1;\n}\n";
		assert_eq!(at(arrow, "x.cs", 3), None);
		assert_eq!(at("function f(\n  a,\n) {}\n", "x.js", 1), None);
		assert_eq!(at("<div\n  class=\"a\"\n>\n  <p>x</p>\n</div>\n", "x.html", 1), Some(4));
		let component = "const Button = ({ label }) => {\n  return <b>{label}</b>;\n};\n";
		assert_eq!(at(component, "x.jsx", 1), Some(2));
		assert_eq!(at("fun greet(name: String) {\n    println(name)\n}\n", "x.kt", 1), Some(2));
		let callback = "app.get('/x',\n  auth,\n  (req, res) => {\n    res.send();\n  });\n";
		assert_eq!(at(callback, "x.js", 1), None);
		assert_eq!(at(callback, "x.js", 2), None);
		assert_eq!(at("items.map(\n  (x) =>\n    x * 2,\n);\n", "x.js", 2), None);
		assert_eq!(at("## Usage\n\n## License\n\nMIT\n", "x.md", 1), Some(2));
		// A line inside a construct's header, or an attribute line above it,
		// resolves to that construct's body; a line inside a body resolves to
		// nothing, whatever follows it.
		let attributed =
			"class C\n{\n    [Fact]\n    public void Test()\n    {\n        Run();\n    }\n}\n";
		assert_eq!(at(attributed, "C.cs", 4), Some(6));
		let annotated = "class A {\n    @Override\n    public void configure(\n            \
		                 HttpSecurity http) {\n        http.csrf();\n    }\n}\n";
		assert_eq!(at(annotated, "A.java", 3), Some(5));
		let derive = "#[derive(Debug)]\nstruct Foo {\n    a: i32,\n}\n";
		assert_eq!(at(derive, "s.rs", 1), Some(3));
		let members = "class Config:\n    debug = False\n\n    def load(self):\n        pass\n";
		assert_eq!(at(members, "t.py", 2), None);
		let fields =
			"class A {\n    private int count;\n\n    void run() {\n        go();\n    }\n}\n";
		assert_eq!(at(fields, "A.java", 2), None);
		let guard = "#ifndef FOO_H\n#define FOO_H\n\nstruct foo {\n    int a;\n};\n\n#endif\n";
		assert_eq!(at(guard, "foo.h", 2), None);
		let access = "CHOICES = [\n    Color.RED,\n    Color.GREEN,\n]\n";
		assert_eq!(at(access, "c.py", 3), None);
	}

	/// A block is a node holding a body or entries, or closing on its last
	/// line what its first line opens (`}`, `end`, an end tag); an attribute
	/// line takes the region of the item it attributes. A multi-line call,
	/// list or attribute closing with `)` or `]`, or a setext heading, bounds
	/// nothing.
	#[test]
	fn scope_range_follows_bodies_closers_and_attributes() {
		let at = |code: &str, path: &str, line: u32| {
			let column = code
				.lines()
				.nth((line - 1) as usize)
				.map_or(0, |text| text.len() - text.trim_start().len());
			index(code, path)
				.scope_range(line, column, column)
				.map(|range| (range.start_line, range.end_line))
		};
		assert_eq!(at("def f():\n    return 1\n\nx = 1\n", "x.py", 1), Some((1, 2)));
		let decorated = "@cached(\n    size=1,\n)\ndef f(a):\n    return a\n";
		assert_eq!(at(decorated, "x.py", 1), Some((1, 5)));
		assert_eq!(at("Intro\n\nInstall\n=======\n\nrun it\n", "g.md", 3), None);
		assert_eq!(at("# A\ntext\n# B\nmore\n", "g.md", 1), Some((1, 2)));
		let attribute = "#[derive(\n    Debug,\n)]\nstruct Foo {\n    a: i32,\n}\n";
		assert_eq!(at(attribute, "s.rs", 1), Some((1, 6)));
		let sibling = "#[cfg(test)]\nmod tests {\n    fn a() {}\n}\n\nmod bench {}\n";
		assert_eq!(at(sibling, "lib.rs", 1), Some((1, 4)));
		let member = "class P {\n  @Input()\n  open(): void {\n    go();\n  }\n}\n";
		assert_eq!(at(member, "p.ts", 2), Some((2, 5)));
		let inner = "#![allow(dead_code)]\nfn helper() -> u32 {\n    1\n}\n";
		assert_eq!(at(inner, "main.rs", 1), None);
		let call = "def main():\n    parser = argparse.ArgumentParser(\n        \
		            description=\"tool\",\n    )\n    return parser\n";
		assert_eq!(at(call, "cli.py", 2), None);
		assert_eq!(at("x = [\n    1,\n]\ny = 2\n", "x.py", 1), None);
		let json = "{\n  \"a\": {\n    \"b\": 1\n  },\n  \"c\": 2\n}\n";
		assert_eq!(at(json, "x.json", 2), Some((2, 4)));
		let go = "package m\n\ntype A struct {\n\tName string\n}\n";
		assert_eq!(at(go, "m.go", 3), Some((3, 5)));
		let steps = "steps:\n  - name: Cache\n    with:\n      path: ~/.cache\n  - name: Upload\n";
		assert_eq!(at(steps, "ci.yml", 2), Some((2, 4)));
		let xml = "<project>\n  <deps>\n    <v>1</v>\n  </deps>\n  <x>1</x>\n</project>\n";
		assert_eq!(at(xml, "pom.xml", 2), Some((2, 4)));
		let ruby = "def run\n  if ready\n    go\n  end\n  if done\n    go\n  end\nend\n";
		assert_eq!(at(ruby, "f.rb", 2), Some((2, 4)));
		let kotlin = "fun run() {\n    if (ready) {\n        go()\n    }\n    stop()\n}\n";
		assert_eq!(at(kotlin, "f.kt", 2), Some((2, 4)));
		let swift = "func run() {\n    if ready {\n        go()\n    }\n    stop()\n}\n";
		assert_eq!(at(swift, "f.swift", 2), Some((2, 4)));
		let effect =
			"function App() {\n  useEffect(() => {\n    go(id);\n  }, [id]);\n  stop();\n}\n";
		assert_eq!(at(effect, "App.jsx", 2), Some((2, 4)));
		let shell = "if [ -f x ]; then\n  run\nfi\necho done\n";
		assert_eq!(at(shell, "d.sh", 1), Some((1, 3)));
		// An attribute line takes only its item's region, also when it is
		// itself `}`-closed or not the first of the item's attributes.
		let decorator = "class C {\n  @Api({\n    d: 'x',\n  })\n  all() {\n    go();\n  }\n}\n";
		assert_eq!(at(decorator, "c.ts", 2), Some((2, 7)));
		let annotated =
			"@Info(a = 1)\n@Types({\n    @Type(b = 2),\n})\nclass Animal {\n    void f();\n}\n";
		assert_eq!(at(annotated, "A.java", 2), Some((2, 7)));
		let second =
			"class T {\n    @Test\n    @Name(\"a\")\n    void a() {\n        go();\n    }\n}\n";
		assert_eq!(at(second, "T.java", 3), Some((3, 6)));
		let listed =
			"class T\n{\n    [Theory]\n    [Data(1)]\n    void A()\n    {\n        Go();\n    }\n}\n";
		assert_eq!(at(listed, "T.cs", 4), Some((4, 8)));
		// A start tag over several lines, an inner node closing on its last
		// line, and a keyword closing a construct that opens with a header.
		let bean = "<beans>\n  <bean id=\"a\"\n        class=\"b\">\n    <p/>\n  </bean>\n</beans>\n";
		assert_eq!(at(bean, "b.xml", 2), Some((2, 5)));
		// The whole modifier chain includes .padding(), but no sibling HStack.
		let chain =
			"struct ContentView: View {\n    var body: some View {\n        VStack {\n            \
			 Text(\"Title\")\n                .font(.headline)\n        }\n        .padding()\n        \
			 HStack {\n            Text(\"Title\")\n                .font(.headline)\n        }\n        \
			 .padding()\n    }\n}\n";
		assert_eq!(at(chain, "V.swift", 3), Some((3, 7)));
		let simple =
			"struct V {\n  var body: some View {\n    VStack {\n      Text(\"a\")\n    }\n    \
			 .padding()\n  }\n}\n";
		assert_eq!(at(simple, "V.swift", 3), Some((3, 6)));
		let verilog = "module a (input x, output y);\n  assign y = x;\nendmodule\n";
		assert_eq!(at(verilog, "top.v", 1), Some((1, 3)));
		let script = "<script id=\"a\"\n        type=\"module\">\n  init();\n</script>\n<p>x</p>\n";
		assert_eq!(at(script, "x.html", 1), Some((1, 4)));
		// A node whose last line opens what follows it there closes nothing:
		// a JSX argument, a promise chain's first callback.
		assert_eq!(at("render(a,\n  <b>\n    x\n  </b>);\n", "x.jsx", 1), None);
		let promise = "db.save(user).then(() => {\n  ok();\n}).catch(() => {\n  fail();\n});\n";
		assert_eq!(at(promise, "s.js", 1), None);
		let one_row_callback = "db.save(user).then(() => {\n  ok();\n}).catch(() => { fail(); });\n";
		assert_eq!(at(one_row_callback, "s.js", 1), None);
		// A declaration's own header line under its attributes, also when it
		// starts with a keyword, bounds that declaration.
		let header =
			"class T {\n    @Test\n    @Name(\"a\")\n    void a() {\n        go();\n    }\n}\n";
		assert_eq!(at(header, "T.java", 4), Some((4, 6)));
		let keyword = "class T {\n    @Test\n    public void a() {\n        go();\n    }\n}\n";
		assert_eq!(at(keyword, "T.java", 3), Some((3, 5)));
		let kotlin = "class T {\n    @Test\n    fun a() {\n        go()\n    }\n}\n";
		assert_eq!(at(kotlin, "T.kt", 3), Some((3, 5)));
		assert_eq!(at(listed, "T.cs", 5), Some((5, 8)));
		// Grouped PHP attributes and Odin attributes past the first.
		let php =
			"<?php\nclass C\n{\n    #[A]\n    #[B(1)]\n    public function a()\n    {\n        \
			 return 1;\n    }\n}\n";
		assert_eq!(at(php, "C.php", 5), Some((5, 9)));
		let odin =
			"package p\n\n@(private)\n@(require_results)\nfoo :: proc() -> int {\n\treturn 1\n}\n";
		assert_eq!(at(odin, "x.odin", 4), Some((4, 7)));
		assert_eq!(at(odin, "x.odin", 5), Some((5, 7)));
		assert_eq!(
			at(
				"class A {\n    @Value(\"x\")\n    private List<String> names = List.of(\n        \
				 \"a\");\n}\n",
				"A.java",
				3
			),
			None
		);
		assert_eq!(
			at("class T {\n    @Test\n    void a() {\n        x = = 1;\n    }\n}\n", "T.java", 3),
			None
		);
		let linked = "db.save(user).then(() => {\n  ok();\n})\n.catch(() => {\n  fail();\n});\n";
		assert_eq!(at(linked, "s.js", 1), Some((1, 6)));
	}

	/// An anchored insertion goes right below the anchor unless the parse
	/// says otherwise: it moves to the top of the body when below the anchor
	/// it breaks the parse or joins the header as a new part, and only when
	/// the top of the body keeps the construct whole; it is refused when it
	/// would take over an attribute or end the construct, when neither
	/// position parses, and when the construct's own errors leave the
	/// choice open.
	#[test]
	fn anchored_insertion_follows_the_parse() {
		let at = |code: &str, path: &str, line: u32, text: &str| {
			index(code, path)
				.anchored_insertion(
					line,
					content_column(code.lines().nth(line as usize - 1).unwrap()).unwrap(),
					text,
				)
				.expect("grammar loads")
		};
		assert_eq!(at("#[test] fn f() {}", "lib.rs", 1, "fn g() {}"), Insertion::At(2));
		let allman = "class C\n{\n    public void Test()\n    {\n        Run();\n    }\n}\n";
		assert_eq!(at(allman, "C.cs", 3, "        Setup();"), Insertion::At(5));
		assert!(matches!(at(allman, "C.cs", 3, "        if (x == 1) {"), Insertion::NeitherParses {
			body: 5,
			..
		}));
		// A construct with errors of its own: a clean line below the anchor is
		// taken, anything else names the construct and its first error.
		let broken = "class C\n{\n    public void Test(int a,\n        int b)\n    {\n        x = = \
		              1;\n    }\n}\n";
		assert_eq!(at(broken, "C.cs", 4, "        Setup();"), Insertion::ConstructHasErrors {
			body:       6,
			header:     "public void Test(int a,".to_owned(),
			error_line: 6,
		});
		assert_eq!(at(broken, "C.cs", 3, "        int c,"), Insertion::At(4));
		let elsewhere =
			"class A\n{\n    void F()\n    {\n        x = 1;\n    }\n    void G( {\n    }\n}\n";
		assert_eq!(at(elsewhere, "t.cs", 3, "        y = 0;"), Insertion::At(5));
		let tests = "fn f() {}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n";
		assert_eq!(at(tests, "lib.rs", 3, "    use std::fmt;"), Insertion::DetachesAttribute {
			attribute: "#[cfg(test)]".to_owned(),
			item:      "mod tests {".to_owned(),
		});
		assert_eq!(
			at("int main()\n{\n    return 0;\n}\n", "m.c", 1, "    int x = 0;"),
			Insertion::At(3)
		);
		// The top of the body must keep the construct whole: a brace-less
		// loop body is never pushed out of the loop.
		let skip =
			"function f(s, i) {\n  while (i < s.length &&\n         s[i] === ' ')\n    i++;\n}\n";
		assert!(matches!(at(skip, "s.js", 2, "    n++;"), Insertion::NeitherParses { .. }));
		// Attributes of every recognized kind, with or without a body below.
		for (code, path, text) in [
			("@MainActor\nclass Model {\n    var x = 1\n}\n", "f.swift", "class Helper {}"),
			("[[nodiscard]]\nint f(int a) {\n    return a;\n}\n", "m.cpp", "int g(int b);"),
			("struct C {\n    #[serde(default)]\n    a: u32,\n}\n", "s.rs", "    b: u64,"),
			("class A {\n    @Autowired\n    private U u;\n}\n", "A.java", "    private C c;"),
		] {
			let line = if path == "s.rs" || path == "A.java" {
				2
			} else {
				1
			};
			assert!(
				matches!(at(code, path, line, text), Insertion::DetachesAttribute { .. }),
				"{path}"
			);
		}
		// Lines ending the construct beginning on the anchor's line: body
		// content indented deeper goes to the top of the body when that keeps
		// the construct whole, a sibling at the anchor's depth is refused.
		let template = "template <typename T>\nT add(T a, T b) {\n    return a + b;\n}\n";
		assert_eq!(at(template, "t.cpp", 1, "    static int calls = 0;"), Insertion::At(3));
		assert!(matches!(at(template, "t.cpp", 1, "int g();"), Insertion::EndsConstruct { .. }));
		let allman = "function f(xs) {\n  for (const x of xs)\n  {\n    use(x);\n  }\n}\n";
		assert_eq!(at(allman, "s.js", 2, "    log(x);"), Insertion::At(4));
		// Depth counts from the header's first line, not a deeper continuation.
		let wrapped = "function f(xs) {\n  for (const x of\n       xs)\n  {\n    use(x);\n  }\n}\n";
		assert_eq!(at(wrapped, "s.js", 3, "    log(x);"), Insertion::At(5));
		// Header growth with no body alternative, and a part of the anchor's
		// own kind, stay right below the anchor.
		let initializer =
			"class Foo : Base\n{\n    public Foo(int x)\n    {\n        Init();\n    }\n}\n";
		assert_eq!(at(initializer, "F.cs", 3, "        : base(x)"), Insertion::At(4));
		let route = "@app.route(\"/\")\ndef index():\n    return render()\n";
		assert_eq!(at(route, "r.py", 1, "@login_required"), Insertion::At(2));
		assert_eq!(at("def f():\n    return 1\n", "x.py", 1, "    x = 1"), Insertion::At(2));
		assert!(matches!(
			at(route, "r.py", 1, "def health():\n    return \"ok\""),
			Insertion::DetachesAttribute { .. }
		));
	}

	#[test]
	fn positional_scope_excludes_earlier_constructs_and_repeated_occurrences() {
		let source = "function f() { if (ready) {\n  run();\n}\nother();\n}\n";
		let at = source.find("if (ready)").unwrap();
		let range = index(source, "s.js").scope_range(1, at, at).unwrap();
		assert_eq!((range.start_line, range.end_line), (1, 3));
		let repeated = "if (ready) { if (ready) {\n  run();\n}}\n";
		let last = repeated.rfind("if (ready)").unwrap();
		assert!(index(repeated, "s.js").scope_range(1, 0, last).is_none());
		let php = "<?php\nouter:\nwhile ($ready) {\n  run();\n}\nother();\n";
		let range = index(php, "s.php").scope_range(2, 0, 0).unwrap();
		assert_eq!((range.start_line, range.end_line), (2, 5));
		let unicode = "/* lead */\u{a0}if (ready) {\n  run();\n}\nother();\n";
		let range = index(unicode, "s.js").scope_range(1, 0, 0).unwrap();
		assert_eq!((range.start_line, range.end_line), (1, 3));
		let broken = "db.then(() => {\n run();\n}).catch(() => {\n broken = = 1;\n});\n";
		assert!(index(broken, "s.js").scope_range(1, 0, 0).is_none());
	}
}
