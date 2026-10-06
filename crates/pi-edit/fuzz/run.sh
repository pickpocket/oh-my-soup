#!/usr/bin/env bash
# Hashline fuzzing driver for crates/pi-edit (cargo-fuzz + libFuzzer).
#
# Prerequisites (every platform): `cargo install cargo-fuzz`, the
# repo-pinned nightly from rust-toolchain.toml (picked up automatically) with
# its `rust-src` component — cargo-fuzz passes -Zbuild-std by default, which
# rebuilds std with the sanitizer (`rustup component add rust-src
# --toolchain nightly-2026-08-12`) — and a C++ compiler, since libfuzzer-sys
# compiles libFuzzer itself. Native Windows MSVC (Git Bash) also needs Visual
# Studio's "C++ AddressSanitizer" component with the MSVC ASan runtime DLL
# directory on PATH (Rust Fuzz Book, "Fuzzing on Windows"). FUZZ_FLAGS
# forwards cargo-fuzz flags before the target name. Keep the default ASan
# on Windows; FUZZ_FLAGS="-s none" can fail to link sanitizer coverage.
#
# Targets:
#   hashline_semantic  generated-valid cases + reference-model oracle
#                      (../tests/support/semantic_case.rs)
#   hashline_stream    arbitrary payloads through parse, streamed argument
#                      projection, preview, apply (support/stream_case.rs)
#
# Invocation: `bash crates/pi-edit/fuzz/run.sh <command> ...` from the repo
# root, or `bash ./run.sh <command> ...` inside crates/pi-edit/fuzz. Always
# go through `bash` (Git Bash on Windows): the file's executable bit is not
# guaranteed in every checkout.
#
# Commands (shown as `run.sh`):
#   run.sh seeds                           regenerate seeds/<target>/ from tests/fixtures/hashline
#   run.sh sample <target> [flags]         deterministic stage_succeeded sampling, uninstrumented
#                                          (flags: --trials N --cases N --seed S | --corpus DIR)
#   run.sh smoke [runs]                    seeds + samples + bounded libFuzzer run of both targets
#   run.sh fuzz <target> [seconds] [libFuzzer flags...]
#                                          coverage-guided campaign, bounded to a positive
#                                          [seconds] (default 600 when omitted or when the first
#                                          extra argument is a `-flag`); libFuzzer prints the real
#                                          instrumented coverage as `cov:` (edges) / `ft:` (features)
#   run.sh replay <target> [inputs...]     execute corpus + seeds + regressions (or inputs) once
#   run.sh tmin <target> <artifact>        libFuzzer minimization (cargo fuzz tmin)
#   run.sh reduce <target> <artifact> [--out FILE] [--budget N]
#                                          shrink a violation; semantic also exports
#                                          a runnable behavioral .fixture.json
#   run.sh keep <target> <input>           persist .min bytes for replay and semantic
#                                          JSON under fixtures/<target>/ for promotion
#   run.sh coverage <target>               llvm-cov profile of the corpus (cargo fuzz coverage)
#
# Paths: input paths (artifacts, inputs, --corpus DIR) resolve against the
# directory run.sh was invoked from; an input missing there falls back to
# crates/pi-edit, so `fuzz/artifacts/...` paths printed by cargo-fuzz work
# as-is. Output paths (--out FILE) always resolve against the invoking
# directory. Example from the repo root:
#   bash crates/pi-edit/fuzz/run.sh reduce semantic \
#     crates/pi-edit/fuzz/artifacts/hashline_semantic/crash-<hash>
#
# Layout (under crates/pi-edit/fuzz): seeds/ are generated on demand from
# fixtures and gitignored; regressions/ persist minimized bytes for replay;
# fixtures/ persist behavioral JSON to merge into tests/fixtures/hashline/;
# corpus/, artifacts/, coverage/, target/ are gitignored.
set -euo pipefail

CALLER_DIR="$PWD"
FUZZ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$(dirname "$FUZZ_DIR")"
cd "$CRATE_DIR"

# shellcheck disable=SC2206 # intentional word splitting of user flags
CARGO_FUZZ_FLAGS=(--fuzz-dir fuzz ${FUZZ_FLAGS:-})

die() {
	echo "run.sh: $*" >&2
	exit 2
}

target_name() {
	case "${1:-}" in
		semantic | hashline_semantic) echo hashline_semantic ;;
		stream | hashline_stream) echo hashline_stream ;;
		*) die "unknown target '${1:-}' (hashline_semantic | hashline_stream)" ;;
	esac
}

# libFuzzer -max_len per target: hashline_stream ignores inputs above its
# MAX_INPUT_BYTES (8 KiB); check_case decodes only a bounded prefix (~200
# bytes), so longer semantic inputs would carry ignored tail bytes.
max_len() {
	case "$1" in
		hashline_semantic) echo 1024 ;;
		hashline_stream) echo 8192 ;;
	esac
}

# Writable corpus first (libFuzzer adds new units there), then read-only
# seed and regression directories that exist.
corpus_dirs() {
	mkdir -p "fuzz/corpus/$1"
	local dirs=("fuzz/corpus/$1")
	for dir in "fuzz/seeds/$1" "fuzz/regressions/$1"; do
		[[ -d "$dir" ]] && dirs+=("$dir")
	done
	echo "${dirs[@]}"
}

tool() {
	local bin="$1"
	shift
	cargo run --quiet --release --manifest-path fuzz/Cargo.toml -p pi-edit-fuzz-tools --bin "$bin" -- "$@"
}

ensure_seeds() {
	[[ -d "fuzz/seeds/$1" ]] || tool seed_corpus
}

is_absolute() {
	[[ "$1" == /* || "$1" =~ ^[A-Za-z]:[\\/] ]]
}

# Output path: relative to the invoking directory.
caller_path() {
	if is_absolute "$1"; then
		echo "$1"
	else
		echo "$CALLER_DIR/$1"
	fi
}

# Input path: relative to the invoking directory when it exists there,
# otherwise relative to crates/pi-edit (cargo-fuzz's `fuzz/artifacts/...`).
input_path() {
	local caller
	caller="$(caller_path "$1")"
	if [[ ! -e "$caller" ]] && ! is_absolute "$1" && [[ -e "$CRATE_DIR/$1" ]]; then
		echo "$CRATE_DIR/$1"
	else
		echo "$caller"
	fi
}

cmd="${1:-help}"
shift || true
case "$cmd" in
	seeds)
		tool seed_corpus
		;;
	sample)
		target="$(target_name "${1:-}")"
		shift
		args=()
		while [[ $# -gt 0 ]]; do
			if [[ "$1" == --corpus && $# -ge 2 ]]; then
				args+=("$1" "$(input_path "$2")")
				shift 2
			else
				args+=("$1")
				shift
			fi
		done
		tool sample "$target" ${args[@]+"${args[@]}"}
		;;
	smoke)
		runs="${1:-20000}"
		tool seed_corpus
		for target in hashline_semantic hashline_stream; do
			tool sample "$target" --trials 3 --cases 300 --seed 1
			tool sample "$target" --corpus "fuzz/seeds/$target"
			# shellcheck disable=SC2046 # corpus_dirs yields separate paths
			cargo fuzz run "${CARGO_FUZZ_FLAGS[@]}" "$target" $(corpus_dirs "$target") -- \
				-runs="$runs" -max_len="$(max_len "$target")" -print_final_stats=1
		done
		;;
	fuzz)
		target="$(target_name "${1:-}")"
		shift
		seconds=600
		if [[ $# -gt 0 && "$1" != -* ]]; then
			[[ "$1" =~ ^0*[1-9][0-9]*$ ]] || die "fuzz duration must be a positive number of seconds, got '$1'"
			seconds="$1"
			shift
		fi
		ensure_seeds "$target"
		# shellcheck disable=SC2046
		cargo fuzz run "${CARGO_FUZZ_FLAGS[@]}" "$target" $(corpus_dirs "$target") -- \
			-max_total_time="$seconds" -max_len="$(max_len "$target")" -print_final_stats=1 "$@"
		;;
	replay)
		target="$(target_name "${1:-}")"
		shift
		if [[ $# -eq 0 ]]; then
			ensure_seeds "$target"
			# shellcheck disable=SC2046
			set -- $(corpus_dirs "$target")
		else
			inputs=()
			for input in "$@"; do
				inputs+=("$(input_path "$input")")
			done
			set -- "${inputs[@]}"
		fi
		cargo fuzz run "${CARGO_FUZZ_FLAGS[@]}" "$target" "$@" -- -runs=0 -max_len="$(max_len "$target")"
		;;
	tmin)
		target="$(target_name "${1:-}")"
		artifact="$(input_path "${2:-}")"
		[[ -n "${2:-}" && -f "$artifact" ]] || die "tmin needs an artifact file, got '${2:-}'"
		cargo fuzz tmin "${CARGO_FUZZ_FLAGS[@]}" "$target" "$artifact"
		;;
	reduce)
		target="$(target_name "${1:-}")"
		input="$(input_path "${2:-}")"
		[[ -n "${2:-}" && -f "$input" ]] || die "reduce needs an input file, got '${2:-}'"
		shift 2
		args=()
		while [[ $# -gt 0 ]]; do
			if [[ "$1" == --out && $# -ge 2 ]]; then
				args+=("$1" "$(caller_path "$2")")
				shift 2
			else
				args+=("$1")
				shift
			fi
		done
		tool reduce "$target" "$input" ${args[@]+"${args[@]}"}
		;;
	keep)
		target="$(target_name "${1:-}")"
		input="$(input_path "${2:-}")"
		[[ -n "${2:-}" && -f "$input" ]] || die "keep needs an input file, got '${2:-}'"
		mkdir -p "fuzz/regressions/$target"
		dest="fuzz/regressions/$target/$(cksum <"$input" | cut -d' ' -f1)"
		cp "$input" "$dest"
		echo "persisted $dest"
		if [[ "$target" == hashline_semantic ]]; then
			# Mirrors reduce's `<out>.with_extension("fixture.json")`.
			base="$(basename "$input")"
			source_fixture="$(dirname "$input")/${base%.*}.fixture.json"
			if [[ -f "$source_fixture" ]]; then
				mkdir -p "fuzz/fixtures/$target"
				fixture_dest="fuzz/fixtures/$target/$(basename "$dest").json"
				cp "$source_fixture" "$fixture_dest"
				echo "behavioral fixture: $fixture_dest"
			fi
		fi
		;;
	coverage)
		target="$(target_name "${1:-}")"
		ensure_seeds "$target"
		# shellcheck disable=SC2046
		cargo fuzz coverage "${CARGO_FUZZ_FLAGS[@]}" "$target" $(corpus_dirs "$target")
		echo "profile: fuzz/coverage/$target/coverage.profdata (render with llvm-cov show/report)"
		;;
	help | -h | --help)
		# The leading comment block (after the shebang) is the manual.
		awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$FUZZ_DIR/run.sh"
		;;
	*)
		die "unknown command '$cmd' (see: bash crates/pi-edit/fuzz/run.sh help)"
		;;
esac
