use std::{cell::RefCell, collections::HashMap, iter, iter::Peekable, rc::Rc, str::Chars};

#[derive(Debug, Clone, PartialEq)]
enum Tok {
	Num(f64),
	Id(String),
	Str(String),
	P(char),
}

fn take_while(cs: &mut Peekable<Chars<'_>>, f: impl Fn(char) -> bool) -> String {
	iter::from_fn(|| cs.next_if(|&c| f(c))).collect()
}

fn hex_escape(cs: &mut Peekable<Chars<'_>>) -> Option<u32> {
	let digits: String = if cs.next_if_eq(&'{').is_some() {
		let h = take_while(cs, |c| c != '}');
		cs.next();
		h
	} else {
		cs.by_ref().take(4).collect()
	};
	u32::from_str_radix(&digits, 16).ok()
}

/// \uXXXX or \u{X..}, gluing UTF-16 surrogate pairs back into one char.
fn unicode_escape(cs: &mut Peekable<Chars<'_>>) -> char {
	let Some(hi) = hex_escape(cs) else {
		return '\u{FFFD}';
	};
	if (0xd800..=0xdbff).contains(&hi) {
		let mut ahead = cs.clone(); // two-char lookahead, the cheap way
		if ahead.next() == Some('\\') && ahead.next() == Some('u') {
			if let Some(lo @ 0xdc00..=0xdfff) = hex_escape(&mut ahead) {
				*cs = ahead;
				return char::from_u32(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00))
					.unwrap_or('\u{FFFD}');
			}
		}
	}
	char::from_u32(hi).unwrap_or('\u{FFFD}')
}

fn string_body(cs: &mut Peekable<Chars<'_>>, quote: char) -> String {
	let mut s = String::new();
	while let Some(ch) = cs.next() {
		match ch {
			_ if ch == quote => break,
			'\\' => match cs.next() {
				Some('n') => s.push('\n'),
				Some('t') => s.push('\t'),
				Some('r') => s.push('\r'),
				Some('b') => s.push('\u{8}'),
				Some('f') => s.push('\u{C}'),
				Some('v') => s.push('\u{B}'),
				Some('0') => s.push('\0'),
				Some('x') => {
					let h: String = cs.by_ref().take(2).collect();
					s.push(
						u32::from_str_radix(&h, 16)
							.ok()
							.and_then(char::from_u32)
							.unwrap_or('\u{FFFD}'),
					)
				},
				Some('u') => s.push(unicode_escape(cs)),
				Some('\n') => {},             // line continuation
				Some(other) => s.push(other), // \" \' \\ \/ and friends
				None => break,
			},
			_ => s.push(ch),
		}
	}
	s
}

fn lex(src: &str) -> Vec<Tok> {
	let mut cs = src.chars().peekable();
	let mut out = vec![];
	while let Some(&c) = cs.peek() {
		match c {
			_ if c.is_whitespace() => {
				cs.next();
			},
			_ if c.is_ascii_digit() => out.push(Tok::Num(
				take_while(&mut cs, |c| c.is_ascii_digit() || c == '.')
					.parse()
					.unwrap_or(f64::NAN),
			)),
			_ if c.is_alphabetic() || c == '_' || c == '$' => {
				out.push(Tok::Id(take_while(&mut cs, |c| c.is_alphanumeric() || c == '_' || c == '$')))
			},
			'`' | '\'' | '"' => {
				cs.next();
				out.push(Tok::Str(string_body(&mut cs, c)));
			},
			'&' | '|' => {
				// `&&` / `||` collapse into a single P token.
				// lone bitwise `&` `|` get read as logical too (for now)
				cs.next();
				cs.next_if_eq(&c);
				out.push(Tok::P(c));
			},
			_ => {
				cs.next();
				out.push(Tok::P(c));
			},
		}
	}
	out
}

pub enum Expr {
	Num(f64),
	Str(Rc<str>),
	Bool(bool),
	Null,
	Undef,
	Var(String),
	Arr(Vec<Expr>),
	Obj(Vec<(String, Expr)>),
	Bin(char, Box<Expr>, Box<Expr>),
	Logic(char, Box<Expr>, Box<Expr>), // '&' is &&, '|' is ||, both short-circuit
	Assign(Box<Expr>, Box<Expr>),
	Member(Box<Expr>, String),
	Index(Box<Expr>, Box<Expr>),
	Call(Box<Expr>, Vec<Expr>),
	Func(Rc<[String]>, Rc<[Stmt]>),
}

pub enum Stmt {
	Let(String, Expr),
	Expr(Expr),
	Return(Expr),
	If(Expr, Vec<Stmt>, Vec<Stmt>),
	Try(Vec<Stmt>, String, Vec<Stmt>),
}

type PResult<T> = Result<T, String>;
struct Parser {
	t: Vec<Tok>,
	i: usize,
}

impl Parser {
	fn peek(&self) -> Option<&Tok> {
		self.t.get(self.i)
	}

	fn bump(&mut self) -> Option<Tok> {
		self.i += 1;
		self.t.get(self.i - 1).cloned()
	}

	fn eat_if(&mut self, f: impl Fn(&Tok) -> bool) -> bool {
		let hit = self.peek().is_some_and(f);
		self.i += hit as usize;
		hit
	}

	fn eat(&mut self, p: char) -> bool {
		self.eat_if(|t| *t == Tok::P(p))
	}

	fn kw(&mut self, k: &str) -> bool {
		self.eat_if(|t| matches!(t, Tok::Id(s) if s == k))
	}

	fn expect(&mut self, p: char) -> PResult<()> {
		self.eat(p).then_some(()).ok_or(format!("expected `{p}`"))
	}

	fn ident(&mut self) -> PResult<String> {
		match self.bump() {
			Some(Tok::Id(s)) => Ok(s),
			t => Err(format!("expected ident, got {t:?}")),
		}
	}

	fn list<T>(&mut self, close: char, f: fn(&mut Self) -> PResult<T>) -> PResult<Vec<T>> {
		let mut v = vec![];
		while !self.eat(close) {
			v.push(f(self)?);
			self.eat(',');
		}
		Ok(v)
	}

	fn program(&mut self) -> PResult<Vec<Stmt>> {
		iter::from_fn(|| (self.i < self.t.len()).then(|| self.stmt())).collect()
	}

	fn block(&mut self) -> PResult<Vec<Stmt>> {
		self.expect('{')?;
		let mut v = vec![];
		while !self.eat('}') {
			v.push(self.stmt()?);
		}
		Ok(v)
	}

	/// `{ ... }` or a single braceless statement, as in `if (x) foo();`
	fn body(&mut self) -> PResult<Vec<Stmt>> {
		if self.peek() == Some(&Tok::P('{')) {
			self.block()
		} else {
			Ok(vec![self.stmt()?])
		}
	}

	fn stmt(&mut self) -> PResult<Stmt> {
		let s = if self.kw("let") || self.kw("const") || self.kw("var") {
			let name = self.ident()?;
			self.expect('=')?;
			Stmt::Let(name, self.expr()?)
		} else if self.kw("return") {
			Stmt::Return(self.expr()?)
		} else if self.kw("if") {
			self.expect('(')?;
			let cond = self.expr()?;
			self.expect(')')?;
			let then = self.body()?;
			let alt = if self.kw("else") {
				self.body()?
			} else {
				vec![]
			};
			Stmt::If(cond, then, alt)
		} else if self.kw("try") {
			let body = self.block()?;
			if !self.kw("catch") {
				return Err("expected catch".into());
			}
			self.expect('(')?;
			let e = self.ident()?;
			self.expect(')')?;
			Stmt::Try(body, e, self.block()?)
		} else {
			Stmt::Expr(self.expr()?)
		};
		self.eat(';');
		Ok(s)
	}

	fn expr(&mut self) -> PResult<Expr> {
		self.bp(0)
	}

	fn bp(&mut self, min: u8) -> PResult<Expr> {
		let mut lhs = self.postfix()?;
		loop {
			let Some(Tok::P(op)) = self.peek().cloned() else {
				break;
			};
			let (l, r) = match op {
				'=' => (2, 1),
				'|' => (3, 4),
				'&' => (5, 6),
				'+' | '-' => (7, 8),
				'*' | '/' | '%' => (9, 10),
				_ => break,
			};
			if l < min {
				break;
			}
			self.i += 1;
			let rhs = self.bp(r)?;
			lhs = match op {
				'=' => Expr::Assign(lhs.into(), rhs.into()),
				'&' | '|' => Expr::Logic(op, lhs.into(), rhs.into()),
				_ => Expr::Bin(op, lhs.into(), rhs.into()),
			};
		}
		Ok(lhs)
	}

	fn postfix(&mut self) -> PResult<Expr> {
		let mut e = self.primary()?;
		loop {
			e = if self.eat('.') {
				Expr::Member(e.into(), self.ident()?)
			} else if self.eat('[') {
				let key = self.expr()?;
				self.expect(']')?;
				Expr::Index(e.into(), key.into())
			} else if self.eat('(') {
				Expr::Call(e.into(), self.list(')', Self::expr)?)
			} else {
				return Ok(e);
			};
		}
	}

	/// one `key: value` inside an object literal. keys: ident, string, or number
	fn prop(&mut self) -> PResult<(String, Expr)> {
		let key = match self.bump() {
			Some(Tok::Id(s) | Tok::Str(s)) => s,
			Some(Tok::Num(n)) => n.to_string(),
			t => return Err(format!("expected property key, got {t:?}")),
		};
		self.expect(':')?;
		Ok((key, self.expr()?))
	}

	fn primary(&mut self) -> PResult<Expr> {
		Ok(match self.bump().ok_or("unexpected EOF")? {
			Tok::Num(n) => Expr::Num(n),
			Tok::Str(s) => Expr::Str(s.into()),
			Tok::Id(k) => match k.as_str() {
				"function" => {
					if let Some(Tok::Id(_)) = self.peek() {
						self.i += 1
					} // optional name, ignored
					self.expect('(')?;
					let ps = self.list(')', Self::ident)?;
					Expr::Func(ps.into(), self.block()?.into())
				},
				"true" => Expr::Bool(true),
				"false" => Expr::Bool(false),
				"null" => Expr::Null,
				"undefined" => Expr::Undef,
				_ => Expr::Var(k),
			},
			Tok::P('(') => {
				let e = self.expr()?;
				self.expect(')')?;
				e
			},
			// no bare blocks in this grammar, so `{` in expression position is
			// always an object
			Tok::P('[') => Expr::Arr(self.list(']', Self::expr)?),
			Tok::P('{') => Expr::Obj(self.list('}', Self::prop)?),
			Tok::P('-') => Expr::Bin('-', Expr::Num(0.0).into(), self.postfix()?.into()),
			t => return Err(format!("unexpected {t:?}")),
		})
	}
}

#[derive(Clone)]
pub enum Val {
	Num(f64),
	Str(Rc<str>),
	Bool(bool),
	Null,
	Undef,
	Doc,
	Arr(Rc<RefCell<Vec<Val>>>),
	Obj(Rc<RefCell<Vec<(String, Val)>>>), // Vec, not HashMap: JS keeps insertion order, so do we
	Func(Rc<[String]>, Rc<[Stmt]>, Env),
	Native(fn(&[Val]) -> Res<Val>),
	Elem(Rc<RefCell<Vec<html::Node>>>),
	Probe(Rc<str>, Rc<Host>),
}

/// stand-in for every host global we don't actually implement (`window`, `DDG`,
/// `DDH`, `nrj`, ...): reads hand out probes, writes and calls get recorded.
#[derive(Default)]
pub struct Host {
	pub writes: RefCell<HashMap<String, Val>>,
	pub calls:  RefCell<Vec<(String, Vec<Val>)>>,
}

impl Host {
	/// an undeclared global: whatever the script last assigned to it, else a
	/// probe.
	fn global(self: &Rc<Self>, k: &str) -> Val {
		let written = self.writes.borrow().get(k).cloned();
		written.unwrap_or_else(|| Val::Probe(k.into(), self.clone()))
	}
}

impl Val {
	fn num(&self) -> f64 {
		match self {
			Val::Num(n) => *n,
			Val::Bool(b) => *b as u8 as f64,
			Val::Null => 0.0,
			Val::Str(s) => s.trim().parse().unwrap_or(f64::NAN),
			_ => f64::NAN,
		}
	}

	fn str(&self) -> String {
		match self {
			Val::Num(n) => n.to_string(),
			Val::Str(s) => s.to_string(),
			Val::Bool(b) => b.to_string(),
			Val::Null => "null".into(),
			Val::Undef => "undefined".into(),
			Val::Arr(a) => a
				.borrow()
				.iter()
				.map(|v| match v {
					Val::Null | Val::Undef => String::new(),
					v => v.str(),
				})
				.collect::<Vec<_>>()
				.join(","),
			Val::Obj(_) => "[object Object]".into(),
			_ => "[object]".into(),
		}
	}

	fn truthy(&self) -> bool {
		match self {
			Val::Num(n) => *n != 0.0 && !n.is_nan(),
			Val::Str(s) => !s.is_empty(),
			Val::Bool(b) => *b,
			Val::Null | Val::Undef => false,
			_ => true,
		}
	}
}

fn obj_set(props: &mut Vec<(String, Val)>, k: &str, v: Val) {
	match props.iter_mut().find(|(key, _)| key == k) {
		Some((_, slot)) => *slot = v,
		None => props.push((k.into(), v)),
	}
}

pub enum Ctl {
	Ret(Val),
	Throw(String),
}
type Res<T> = Result<T, Ctl>;
fn throw<T>(m: impl Into<String>) -> Res<T> {
	Err(Ctl::Throw(m.into()))
}

impl ToString for Ctl {
	fn to_string(&self) -> String {
		match self {
			Ctl::Throw(e) => e.clone(),
			Ctl::Ret(_) => "returned".into(),
		}
	}
}

pub struct Scope {
	vars: RefCell<HashMap<String, Val>>,
	up:   Up,
}
pub type Env = Rc<Scope>;

enum Up {
	Scope(Env),
	/// the global scope, where (like a browser's `window`) every name exists
	Host(Rc<Host>),
}

impl Scope {
	/// global scope: `vars` are real bindings, every other name resolves through
	/// `host`.
	pub fn global(host: Rc<Host>, vars: impl IntoIterator<Item = (String, Val)>) -> Env {
		Rc::new(Scope { vars: RefCell::new(vars.into_iter().collect()), up: Up::Host(host) })
	}

	fn child(up: &Env) -> Env {
		Rc::new(Scope { vars: Default::default(), up: Up::Scope(up.clone()) })
	}

	fn def(&self, k: &str, v: Val) {
		self.vars.borrow_mut().insert(k.into(), v);
	}

	fn get(&self, k: &str) -> Res<Val> {
		if let Some(v) = self.vars.borrow().get(k) {
			return Ok(v.clone());
		}
		match &self.up {
			Up::Scope(up) => up.get(k),
			Up::Host(host) => Ok(host.global(k)),
		}
	}

	fn set(&self, k: &str, v: Val) -> Res<()> {
		if let Some(slot) = self.vars.borrow_mut().get_mut(k) {
			*slot = v;
			return Ok(());
		}
		match &self.up {
			Up::Scope(up) => up.set(k, v),
			// sloppy-mode assignment to an undeclared name creates a global
			Up::Host(host) => {
				host.writes.borrow_mut().insert(k.into(), v);
				Ok(())
			},
		}
	}
}

// ═══════════════════════════════════════════════════════════════
//  eval
// ═══════════════════════════════════════════════════════════════

fn exec(stmts: &[Stmt], env: &Env) -> Res<()> {
	stmts.iter().try_for_each(|s| match s {
		Stmt::Let(k, e) => Ok(env.def(k, eval(e, env)?)),
		Stmt::Expr(e) => eval(e, env).map(drop),
		Stmt::Return(e) => Err(Ctl::Ret(eval(e, env)?)),
		Stmt::If(cond, then, alt) => {
			let branch = if eval(cond, env)?.truthy() { then } else { alt };
			exec(branch, &Scope::child(env))
		},
		Stmt::Try(body, name, handler) => match exec(body, &Scope::child(env)) {
			Err(Ctl::Throw(msg)) => {
				let s = Scope::child(env);
				s.def(name, Val::Str(msg.into()));
				exec(handler, &s)
			},
			r => r,
		},
	})
}

fn eval(e: &Expr, env: &Env) -> Res<Val> {
	Ok(match e {
		Expr::Num(n) => Val::Num(*n),
		Expr::Str(s) => Val::Str(s.clone()),
		Expr::Bool(b) => Val::Bool(*b),
		Expr::Null => Val::Null,
		Expr::Undef => Val::Undef,
		Expr::Var(k) => env.get(k)?,
		Expr::Arr(items) => Val::Arr(Rc::new(RefCell::new(
			items
				.iter()
				.map(|e| eval(e, env))
				.collect::<Res<Vec<_>>>()?,
		))),
		Expr::Obj(props) => {
			let mut o = vec![];
			for (k, e) in props {
				obj_set(&mut o, k, eval(e, env)?) // duplicate keys: last one wins, like JS
			}
			Val::Obj(Rc::new(RefCell::new(o)))
		},
		Expr::Func(ps, body) => Val::Func(ps.clone(), body.clone(), env.clone()),
		Expr::Bin(op, a, b) => binop(*op, eval(a, env)?, eval(b, env)?)?,
		Expr::Logic(op, a, b) => {
			let l = eval(a, env)?;
			// &&: continue only if truthy.  ||: continue only if falsy
			if l.truthy() == (*op == '&') {
				eval(b, env)?
			} else {
				l
			}
		},
		Expr::Member(o, k) => get_prop(&eval(o, env)?, k)?,
		Expr::Index(o, k) => get_prop(&eval(o, env)?, &eval(k, env)?.str())?,
		Expr::Call(f, args) => {
			let f = eval(f, env)?;
			let args = args.iter().map(|a| eval(a, env)).collect::<Res<Vec<_>>>()?;
			call(&f, &args)?
		},
		Expr::Assign(target, v) => {
			let v = eval(v, env)?;
			match &**target {
				Expr::Var(k) => env.set(k, v.clone())?,
				Expr::Member(o, k) => set_prop(&eval(o, env)?, k, &v)?,
				Expr::Index(o, k) => set_prop(&eval(o, env)?, &eval(k, env)?.str(), &v)?,
				_ => return throw("SyntaxError: invalid assignment target"),
			}
			v
		},
	})
}

fn binop(op: char, a: Val, b: Val) -> Res<Val> {
	let stringy = |v: &Val| matches!(v, Val::Str(_) | Val::Arr(_) | Val::Obj(_));
	if op == '+' && (stringy(&a) || stringy(&b)) {
		return Ok(Val::Str(format!("{}{}", a.str(), b.str()).into()));
	}
	let (x, y) = (a.num(), b.num());
	Ok(Val::Num(match op {
		'+' => x + y,
		'-' => x - y,
		'*' => x * y,
		'/' => x / y,
		'%' => x % y,
		_ => return throw(format!("unknown op {op}")),
	}))
}

pub fn call(f: &Val, args: &[Val]) -> Res<Val> {
	match f {
		Val::Native(f) => f(args),
		Val::Func(params, body, env) => {
			let scope = Scope::child(env);
			params
				.iter()
				.zip(args.iter().cloned().chain(iter::repeat(Val::Undef)))
				.for_each(|(p, a)| scope.def(p, a));
			match exec(body, &scope) {
				Err(Ctl::Ret(v)) => Ok(v),
				r => r.map(|()| Val::Undef),
			}
		},
		Val::Probe(path, host) => {
			host
				.calls
				.borrow_mut()
				.push((path.to_string(), args.to_vec()));
			Ok(Val::Undef)
		},
		_ => throw("TypeError: not a function"),
	}
}

fn create_element(_: &[Val]) -> Res<Val> {
	Ok(Val::Elem(Default::default()))
}

fn get_prop(o: &Val, k: &str) -> Res<Val> {
	Ok(match (o, k) {
		(Val::Doc, "createElement") => Val::Native(create_element),
		(Val::Elem(kids), "innerHTML") => Val::Str(
			kids
				.borrow()
				.iter()
				.map(html::Node::html)
				.collect::<String>()
				.into(),
		),
		(Val::Str(s), "length") => Val::Num(s.encode_utf16().count() as f64), /* JS length = */
		// UTF-16 units
		(Val::Arr(a), "length") => Val::Num(a.borrow().len() as f64),
		(Val::Arr(a), _) => k
			.parse::<usize>()
			.ok()
			.and_then(|i| a.borrow().get(i).cloned())
			.unwrap_or(Val::Undef),
		(Val::Obj(props), _) => props
			.borrow()
			.iter()
			.find(|(key, _)| key == k)
			.map_or(Val::Undef, |(_, v)| v.clone()),
		(Val::Probe(path, host), _) => {
			let full = format!("{path}.{k}");
			let hit = host.writes.borrow().get(&full).cloned();
			hit.unwrap_or_else(|| Val::Probe(full.into(), host.clone()))
		},
		(Val::Undef | Val::Null, _) => {
			return throw(format!("TypeError: cannot read '{k}' of {}", o.str()));
		},
		_ => Val::Undef,
	})
}

fn set_prop(o: &Val, k: &str, v: &Val) -> Res<()> {
	match (o, k) {
		(Val::Elem(kids), "innerHTML") => Ok(*kids.borrow_mut() = html::parse(&v.str())),
		(Val::Obj(props), _) => Ok(obj_set(&mut props.borrow_mut(), k, v.clone())),
		(Val::Arr(a), _) => {
			if let Ok(i) = k.parse::<usize>() {
				let mut a = a.borrow_mut();
				if i >= a.len() {
					a.resize(i + 1, Val::Undef)
				}
				a[i] = v.clone();
			}
			Ok(())
		},
		(Val::Probe(path, host), _) => {
			host
				.writes
				.borrow_mut()
				.insert(format!("{path}.{k}"), v.clone());
			Ok(())
		},
		(Val::Undef | Val::Null, _) => throw(format!("TypeError: cannot set '{k}' of {}", o.str())),
		_ => Ok(()),
	}
}

mod html {
	pub enum Node {
		El(String, Vec<Node>),
		Text(String),
	}

	const VOID: &str = "area base br col embed hr img input link meta source track wbr";
	const SCOPE: &str = "applet caption html table td th marquee object template";
	const CLOSES_P: &str = "address article aside blockquote center details dialog dir div dl \
	                        fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup \
	                        hr li dd dt listing main menu nav ol p pre search section summary \
	                        table ul xmp";
	const SPECIAL: &str = "address applet area article aside base blockquote body br button \
	                       caption center col colgroup dd details dir div dl dt embed fieldset \
	                       figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr \
	                       html iframe img input li link listing main marquee menu meta nav \
	                       noscript object ol p pre script section select style summary table \
	                       tbody td template textarea tfoot th thead title tr ul wbr xmp";

	fn is(set: &str, tag: &str) -> bool {
		set.split_whitespace().any(|t| t == tag)
	}

	enum Tok {
		Open(String),
		Close(String),
		Text(String),
	}

	fn tokens(mut rest: &str) -> Vec<Tok> {
		let mut out = vec![];
		while let Some(c) = rest.chars().next() {
			if let Some(tag) = rest.strip_prefix('<') {
				let (close, body) = tag.strip_prefix('/').map_or((false, tag), |b| (true, b));
				if body.starts_with(|c: char| c.is_ascii_alphabetic()) {
					let Some(end) = body.find('>') else { break }; // EOF inside a tag: it just evaporates
					let name = body[..end]
						.split(|c: char| c.is_whitespace() || c == '/')
						.next()
						.unwrap_or("")
						.to_ascii_lowercase();
					out.push(if close {
						Tok::Close(name)
					} else {
						Tok::Open(name)
					});
					rest = &body[end + 1..];
					continue;
				}
			}
			let n = rest[c.len_utf8()..]
				.find('<')
				.map_or(rest.len(), |i| i + c.len_utf8());
			out.push(Tok::Text(rest[..n].into()));
			rest = &rest[n..];
		}
		out
	}

	/// stack of open elements. a pop folds the frame into its parent,
	/// so the tree assembles itself bottom-up, no &mut-into-tree gymnastics.
	struct Tree(Vec<(String, Vec<Node>)>);

	impl Tree {
		fn open(&self) -> impl Iterator<Item = &str> + '_ {
			self.0[1..].iter().rev().map(|(n, _)| n.as_str())
		}

		fn top(&self) -> &str {
			&self.0.last().unwrap().0
		}

		fn push(&mut self, t: &str) {
			self.0.push((t.into(), vec![]))
		}

		fn pop(&mut self) {
			let (t, kids) = self.0.pop().unwrap();
			self.0.last_mut().unwrap().1.push(Node::El(t, kids));
		}

		fn in_scope(&self, t: &str, extra: &str) -> bool {
			self
				.open()
				.find(|n| *n == t || is(SCOPE, n) || is(extra, n))
				== Some(t)
		}

		fn close(&mut self, t: &str) {
			// caller guarantees t is open
			while self.top() != t {
				self.pop()
			}
			self.pop();
		}

		fn close_list_item(&mut self, kin: &[&str]) {
			let hit = self
				.open()
				.find(|n| kin.contains(n) || (is(SPECIAL, n) && !matches!(*n, "address" | "div" | "p")))
				.filter(|n| kin.contains(n))
				.map(str::to_owned);
			if let Some(n) = hit {
				self.close(&n)
			}
		}

		fn start(&mut self, t: &str) {
			match t {
				"li" => self.close_list_item(&["li"]),
				"dd" | "dt" => self.close_list_item(&["dd", "dt"]),
				_ => {},
			}
			if is(CLOSES_P, t) && self.in_scope("p", "button") {
				self.close("p")
			}
			self.push(t);
			if is(VOID, t) {
				self.pop()
			}
		}

		fn end(&mut self, t: &str) {
			match t {
				"p" => {
					if !self.in_scope("p", "button") {
						self.push("p")
					}
					self.close("p")
				},
				"li" => {
					if self.in_scope("li", "ol ul") {
						self.close("li")
					}
				},
				"br" => self.start("br"), // yes, </br> means <br>. the spec is like that (´・ω・`)
				_ => {
					if self.in_scope(t, "") {
						self.close(t)
					}
				},
			}
		}

		fn text(&mut self, s: &str) {
			let kids = &mut self.0.last_mut().unwrap().1;
			match kids.last_mut() {
				Some(Node::Text(t)) => t.push_str(s),
				_ => kids.push(Node::Text(s.into())),
			}
		}
	}

	pub fn parse(src: &str) -> Vec<Node> {
		let mut t =
			tokens(src)
				.into_iter()
				.fold(Tree(vec![("#ctx".into(), vec![])]), |mut t, tok| {
					match tok {
						Tok::Open(n) => t.start(&n),
						Tok::Close(n) => t.end(&n),
						Tok::Text(s) => t.text(&s),
					}
					t
				});
		while t.0.len() > 1 {
			t.pop()
		}
		t.0.pop().map(|(_, kids)| kids).unwrap_or_default()
	}

	impl Node {
		pub fn html(&self) -> String {
			match self {
				Node::Text(s) => s
					.chars()
					.map(|c| match c {
						'&' => "&amp;".into(),
						'<' => "&lt;".into(),
						'>' => "&gt;".into(),
						c => c.to_string(),
					})
					.collect(),
				Node::El(t, _) if is(VOID, t) => format!("<{t}>"),
				Node::El(t, kids) => {
					format!("<{t}>{}</{t}>", kids.iter().map(Node::html).collect::<String>())
				},
			}
		}
	}
}

pub fn run(src: &str, global: &Env) -> Result<(), Ctl> {
	let prog = Parser { t: lex(src), i: 0 }
		.program()
		.map_err(|e| Ctl::Throw(e))?;

	exec(&prog, &global)
}
