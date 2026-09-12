#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"

NATIVES_PACKAGE="$ROOT_DIR/packages/natives/package.json"
NATIVES_PACKAGE_INITIAL="$WORK_DIR/natives-package.initial.json"
cp "$NATIVES_PACKAGE" "$NATIVES_PACKAGE_INITIAL"
restore_workspace() {
   cp "$NATIVES_PACKAGE_INITIAL" "$NATIVES_PACKAGE"
   rm -rf "$WORK_DIR"
}
trap restore_workspace EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

smoke_cli() {
   local oms_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$oms_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$oms_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$oms_bin" stats --summary >/dev/null
   # Spawns bundled workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for npm/compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$oms_bin" --smoke-test
}

find_tarball() {
   local pattern="$1"
   local matches=()
   shopt -s nullglob
   matches=("$pattern")
   shopt -u nullglob

   if [ "${#matches[@]}" -ne 1 ]; then
      echo "Expected exactly one tarball matching: $pattern"
      exit 1
   fi

   echo "${matches[0]}"
}

align_native_manifest() {
   local addon_version=""
   local addon
   local candidate_version
   local candidates=()
   shopt -s nullglob
   candidates=("$ROOT_DIR"/packages/natives/native/pi_natives.*.node)
   shopt -u nullglob

   if [ "${#candidates[@]}" -eq 0 ]; then
      echo "No native addon found for install smoke" >&2
      exit 1
   fi
   for addon in "${candidates[@]}"; do
      candidate_version="$(bun "$ROOT_DIR/scripts/install-tests/native-version.ts" "$addon")" || exit 1
      if [ -z "$addon_version" ]; then
         addon_version="$candidate_version"
      elif [ "$addon_version" != "$candidate_version" ]; then
         echo "Native addon version mismatch: $addon_version vs $candidate_version ($addon)" >&2
         exit 1
      fi
   done

   local declared_version
   declared_version="$(jq -r '.version' "$NATIVES_PACKAGE")"
   if [ "$declared_version" = "$addon_version" ]; then return; fi

   echo "Aligning install smoke native manifest $declared_version → $addon_version"
   jq --arg version "$addon_version" '.version = $version' "$NATIVES_PACKAGE" > "$WORK_DIR/natives-package.aligned.json"
   mv "$WORK_DIR/natives-package.aligned.json" "$NATIVES_PACKAGE"
}
section "Binary install smoke"
if [ "${OMS_INSTALL_TEST_SKIP_NATIVE_BUILD:-0}" != "1" ]; then
   bun --cwd=packages/natives run build
fi
align_native_manifest
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/oms "$BINARY_DIR/oms"
(
   export PI_CODING_AGENT_DIR="$WORK_DIR/binary-agent"
   "$BINARY_DIR/oms" setup objdump
   "$BINARY_DIR/oms" setup objdump --check
   smoke_cli "$BINARY_DIR/oms"
)

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
   export BUN_INSTALL="$SOURCE_BUN_HOME"
   export PI_CODING_AGENT_DIR="$WORK_DIR/source-agent"
   export PATH="$BUN_INSTALL/bin:$PATH"
   bun --cwd="$ROOT_DIR/packages/coding-agent" link
   sh "$ROOT_DIR/scripts/link-oms.sh"
   "$BUN_INSTALL/bin/oms" setup objdump --check
   smoke_cli "$BUN_INSTALL/bin/oms"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
host_tag="$(bun -e "process.stdout.write(\`\${process.platform}-\${process.arch}\`)")"

# Native addon split: the published core ships only the loader (no `.node`); the
# prebuilt binary lives in a per-platform leaf package pulled in as an optional
# dependency. Reproduce that exact published topology so this smoke proves the
# installed core resolves its addon through the leaf, not a bundled binary.

# 1. Generate + pack the host-platform leaf (carries the built `.node`).
bun --cwd=packages/natives run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/natives/npm/$host_tag"
   bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
)

# 2. Pack the core with its *published* manifest: the same rewrite release uses
#    drops `.node` from `files` and adds the leaf `optionalDependencies`. Always
#    restore the working-tree manifest so local runs aren't left mutated.
natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/natives/package.json" "$natives_pkg_backup"
core_rc=0
{
   bun -e 'import { prepareNativeCorePackage } from "./scripts/ci-release-publish.ts"; await prepareNativeCorePackage("packages/natives", true);' &&
      (cd "$ROOT_DIR/packages/natives" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/natives/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

# 3. Pack the remaining workspace packages (natives core and coding-agent
#    handled separately). `collab-web` is private but still packed here so its
#    prepack build and tarball file list stay release-safe.
for pkg in utils wire omstype hashline catalog ai mnemopi snapcompact agent tui stats collab-web; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
   )
done

# 4. Pack the coding agent with its *published* manifest: release swaps
#    `bin.oms` from `src/cli.ts` to `dist/cli.js` and adds consumer postinstall.
#    The repository manifest keeps source links usable before bundling and
#    workspace installation safe before build:native. Reproduce both overrides
#    to exercise the installed CLI and its dependency setup lifecycle.
#    Always restore the working-tree manifest.
agent_pkg_backup="$WORK_DIR/coding-agent-package.json.orig"
cp "$ROOT_DIR/packages/coding-agent/package.json" "$agent_pkg_backup"
agent_rc=0
{
   bun -e 'import { applyPublishRuntime } from "./scripts/ci-release-publish.ts"; await applyPublishRuntime("packages/coding-agent", true);' &&
      (cd "$ROOT_DIR/packages/coding-agent" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || agent_rc=$?
cp "$agent_pkg_backup" "$ROOT_DIR/packages/coding-agent/package.json"
[ "$agent_rc" -eq 0 ] || exit "$agent_rc"

utils_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-utils-*.tgz)"
wire_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-wire-*.tgz)"
omstype_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-omstype-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-natives-[0-9]*.tgz)"
natives_leaf_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-natives-"$host_tag"-*.tgz)"
hashline_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-hashline-*.tgz)"
catalog_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-catalog-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-ai-*.tgz)"
mnemopi_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-mnemopi-*.tgz)"
snapcompact_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-snapcompact-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-oms-stats-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-pi-coding-agent-*.tgz)"
collab_web_tgz="$(find_tarball "$TARBALL_DIR"/oh-my-soup-collab-web-*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   export PI_CODING_AGENT_DIR="$WORK_DIR/tarball-agent"
   bun init -y >/dev/null

   # Write overrides so bun resolves inter-package deps from tarballs, not the registry
   # (the version under test has not necessarily been published yet).
   node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.trustedDependencies = [...new Set([...(pkg.trustedDependencies ?? []), '@oh-my-soup/pi-coding-agent'])];
		pkg.overrides = {
			'@oh-my-soup/pi-utils': '$utils_tgz',
			'@oh-my-soup/pi-wire': '$wire_tgz',
			'@oh-my-soup/omstype': '$omstype_tgz',
			'@oh-my-soup/pi-natives': '$natives_tgz',
			'@oh-my-soup/pi-natives-$host_tag': '$natives_leaf_tgz',
			'@oh-my-soup/hashline': '$hashline_tgz',
			'@oh-my-soup/pi-ai': '$ai_tgz',
			'@oh-my-soup/pi-catalog': '$catalog_tgz',
			'@oh-my-soup/pi-mnemopi': '$mnemopi_tgz',
			'@oh-my-soup/snapcompact': '$snapcompact_tgz',
			'@oh-my-soup/pi-agent-core': '$agent_tgz',
			'@oh-my-soup/pi-tui': '$tui_tgz',
			'@oh-my-soup/oms-stats': '$stats_tgz',
			'@oh-my-soup/pi-coding-agent': '$coding_agent_tgz',
			'@oh-my-soup/collab-web': '$collab_web_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

   bun add "$utils_tgz" "$wire_tgz" "$omstype_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$coding_agent_tgz" "$collab_web_tgz"
   # The platform leaf must arrive through the core's optionalDependencies +
   # override, not as a direct dependency — assert it landed before smoking so a
   # resolution regression is distinguishable from a runtime loader bug.
   leaf_dir="node_modules/@oh-my-soup/pi-natives-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }
   ./node_modules/.bin/oms setup objdump --check
   wire_proto="$(bun -e 'import { COLLAB_PROTO } from "@oh-my-soup/pi-wire"; process.stdout.write(String(COLLAB_PROTO));')"
   [ "$wire_proto" = "3" ] || {
      echo "Unexpected @oh-my-soup/pi-wire COLLAB_PROTO: $wire_proto"
      exit 1
   }
   omstype_probe="$(bun -e '
      import { type } from "@oh-my-soup/omstype";
      import { Type } from "@oh-my-soup/omstype/typebox";
      const root = type({ name: "string", enabled: "boolean = false" }).assert({ name: "oms" });
      const typebox = Type.Object({ name: Type.String() }).assert({ name: "tb" });
      process.stdout.write(`${root.name}:${root.enabled}:${typebox.name}`);
   ')"
   [ "$omstype_probe" = "oms:false:tb" ] || {
      echo "Unexpected @oh-my-soup/omstype probe result: $omstype_probe"
      exit 1
   }
   [ -f "node_modules/@oh-my-soup/collab-web/dist/index.html" ] || {
      echo "Collab web tarball did not install built dist/index.html"
      exit 1
   }
   smoke_cli ./node_modules/.bin/oms
)

echo ""
echo "All install method smoke tests passed"
