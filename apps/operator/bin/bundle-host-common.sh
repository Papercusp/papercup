#!/usr/bin/env bash
# Shared inputs for the plain-node esbuild recipes used by the development host
# and the packaged desktop sidecar. Callers retain their output paths,
# platform externals, and native-package copy strategy.

if [[ "${PAPERCUSP_BUNDLE_HOST_COMMON_LOADED:-}" == "1" ]]; then
  return 0
fi
PAPERCUSP_BUNDLE_HOST_COMMON_LOADED=1

# Resolve the selected source, never an enclosing checkout's identity.
# Print an unreferenced commit whose tree byte-equals <repo>'s working tree,
# recursing depth-first into initialized submodules (WI-6554700010048234).
# Writes loose objects only: no ref, real index or working-tree file changes.
# A clean repository returns HEAD; the fixed identity and date make the commit
# content-addressed, so the same bytes always yield the same SHA.
bundle_host_snapshot_commit() { # <repo dir>
  local repo="$1" head status index_dir real_index entry mode path sub_sha tree rc=0
  local -a gitlinks=()
  head="$(git -C "$repo" rev-parse --verify --quiet 'HEAD^{commit}')" || return 1
  status="$(git -C "$repo" status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" || return 1
  if [[ -z "$status" ]]; then printf '%s\n' "$head"; return 0; fi
  while IFS= read -r -d '' entry; do
    mode="${entry%% *}"
    path="${entry#*$'\t'}"
    # An uninitialized submodule keeps its recorded gitlink.
    [[ "$mode" == 160000 && -e "$repo/$path/.git" ]] || continue
    sub_sha="$(bundle_host_snapshot_commit "$repo/$path")" || return 1
    gitlinks+=("160000,$sub_sha,$path")
  done < <(git -C "$repo" ls-files --stage -z)
  index_dir="$(mktemp -d "${TMPDIR:-/tmp}/bundle-host-snapshot.XXXXXX")" || return 1
  # Start from a copy of the real index for its stat cache; else from HEAD.
  real_index="$(git -C "$repo" rev-parse --path-format=absolute --git-path index 2>/dev/null)" || real_index=""
  if [[ -z "$real_index" ]] || ! cp -- "$real_index" "$index_dir/index" 2>/dev/null; then
    GIT_INDEX_FILE="$index_dir/index" git -C "$repo" read-tree "$head" || rc=1
  fi
  (( rc == 0 )) && { GIT_INDEX_FILE="$index_dir/index" git -C "$repo" add -A >/dev/null 2>&1 || rc=1; }
  for entry in "${gitlinks[@]}"; do
    (( rc == 0 )) || break
    GIT_INDEX_FILE="$index_dir/index" git -C "$repo" update-index --cacheinfo "$entry" || rc=1
  done
  (( rc == 0 )) && { tree="$(GIT_INDEX_FILE="$index_dir/index" git -C "$repo" write-tree)" || rc=1; }
  rm -rf -- "$index_dir"
  (( rc == 0 )) || return 1
  # The parent's committer date keeps the sha content-addressed (same tree + parent → same sha).
  # A fixed @0 did too, but host-code-staleness-from-ledger ages a serving sha by its commit
  # time, so @0 read as ~56 years stale (peer su-respawn-fd123e64, WI-6554700010048963).
  local parent_date
  parent_date="$(git -C "$repo" show -s --format=%ct "$head")" || return 1
  GIT_AUTHOR_NAME='bundle-host snapshot' GIT_AUTHOR_EMAIL='bundle-host-snapshot@invalid' \
    GIT_COMMITTER_NAME='bundle-host snapshot' GIT_COMMITTER_EMAIL='bundle-host-snapshot@invalid' \
    GIT_AUTHOR_DATE="@${parent_date} +0000" GIT_COMMITTER_DATE="@${parent_date} +0000" \
    git -C "$repo" commit-tree --no-gpg-sign "$tree" -p "$head" -m 'bundle-host working-tree snapshot'
}

bundle_host_source_sha() { # <canonical source root> [node command...]
  local repo_root="$1"
  shift
  local -a source_node=("${@:-node}")
  if [[ -f "$repo_root/.verifier-source.json" ]]; then
    "${source_node[@]}" --input-type=module - "$repo_root" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
// Use the final bundle fence's independent receipt reader before any compiler
// work. The archive marker alone cannot qualify a network-capable host build.
const { readVerifierSourceReceiptSync } = await import(pathToFileURL(join(root, 'libs/test-config/src/verifier-source.ts')));
const receipt = readVerifierSourceReceiptSync(root);
if (!receipt.gitCheckout) throw new Error('archive bundle requires independently verified Git checkout');
// Preserve the additional planned-input checks for operator-api archives.
if (receipt.operatorApiInputs) {
  const { verifyVerifierSourceSync } = await import(pathToFileURL(join(root, 'packages/operator-core/lib/verifier-source.ts')));
  verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
}
process.stdout.write(receipt.sourceCommit.slice(0, 12));
NODE
  elif [[ -n "${VERIFY_TAURI_SOURCE_RECEIPT:-}" ]]; then
    echo 'bundle-host.sh: pinned source receipt requires its archive marker' >&2
    return 78
  elif [[ "$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || true)" == "$repo_root" ]]; then
    local source_sha status
    source_sha="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || true)"
    [[ -n "$source_sha" ]] || return 0
    # The build can include working-tree bytes that HEAD does not identify.
    # Use the same conservative source-tree rule as bundle-host-freshness:
    # preserve availability, but make the resulting artifact unattributable.
    if ! status="$(git -C "$repo_root" status --porcelain=v1 --untracked-files=all --ignore-submodules=none 2>/dev/null)"; then
      printf '%s+dirty' "$source_sha"
    elif [[ -n "$status" ]]; then
      # Opt-in (the working-tree operator-API route only): name the exact
      # bytes with a content-addressed snapshot commit instead of HEAD. A
      # snapshot failure keeps the artifact unattributable, never relabelled.
      local snapshot=""
      if [[ "${PAPERCUSP_BUNDLE_SNAPSHOT_DIRTY:-}" == 1 ]] \
        && snapshot="$(bundle_host_snapshot_commit "$repo_root")" \
        && snapshot="$(git -C "$repo_root" rev-parse --short "$snapshot")" && [[ -n "$snapshot" ]]; then
        printf '%s' "$snapshot"
      else
        printf '%s+dirty' "$source_sha"
      fi
    else
      printf '%s' "$source_sha"
    fi
  fi
}

# Keep one prior attempt: systemd can retry before anyone reads a killed build's
# journal. Rotate before truncating, and refuse to discard evidence if it fails.
bundle_host_init_step_log() { # <step log>
  local step_log="$1"
  if [[ -e "$step_log" || -L "$step_log" ]]; then
    [[ -f "$step_log" ]] || return 1
    mv -fT -- "$step_log" "$step_log.previous" || return 1
  fi
  : > "$step_log"
}

# Keep step boundaries outside redirected compiler logs. A killed parent cannot
# print those logs afterward; the private builder reads this retained journal.
# Packaging callers without a journal keep the same command/exit contract.
bundle_host_run_step() { # <fixed step name> <command> [args...]
  local step="$1" step_rc=0
  shift
  if [[ -n "${BUNDLE_HOST_STEP_LOG:-}" ]]; then
    printf '{"at":%s,"pid":%s,"step":"%s","event":"start"}\n' \
      "$EPOCHREALTIME" "$BASHPID" "$step" >> "$BUNDLE_HOST_STEP_LOG" || return 1
  fi
  "$@" || step_rc=$?
  if [[ -n "${BUNDLE_HOST_STEP_LOG:-}" ]]; then
    printf '{"at":%s,"pid":%s,"step":"%s","event":"end","status":%s}\n' \
      "$EPOCHREALTIME" "$BASHPID" "$step" "$step_rc" >> "$BUNDLE_HOST_STEP_LOG" || return 1
  fi
  return "$step_rc"
}

# Resolve the pinned tool once per build instead of paying npm's package
# resolution on every worker. A shell binding is local to this sourced recipe;
# an inherited path is not evidence of the requested compiler.
BUNDLE_HOST_ESBUILD_PATH=""
bundle_host_cached_package() { # <repo root> <command> [args...]
  local repo_root="$1"
  shift
  if declare -F run_sidecar_cached_package >/dev/null 2>&1; then
    # Frozen desktop targets retain their existing cache-lease API adapter.
    run_sidecar_cached_package "$@"
  else
    local -a run_node=("${COMMITTED_NODE[@]:-node}")
    "${run_node[@]}" "$repo_root/scripts/npm-install-safe.mjs" \
      --repo-root "$repo_root" --exec-under-cache-lock -- "$@"
  fi
}

bundle_host_prepare_esbuild() { # <repo root>
  if [[ -n "${BUNDLE_HOST_BG_BUILD_CONTEXT:-}" ]]; then
    # The whole maintained recipe resolves its supplied original contexts before
    # its first compile. A rejected BG context must never acquire an npm compiler.
    local -a guarded_node=("${COMMITTED_NODE[@]:-node}")
    "${guarded_node[@]}" "$1/scripts/source-preview.mjs" bg-compiler \
      --context "$BUNDLE_HOST_BG_BUILD_CONTEXT" --check
    return $?
  fi
  [[ -z "$BUNDLE_HOST_ESBUILD_PATH" ]] || return 0
  local compiler
  compiler="$(bundle_host_cached_package "$1" npx --yes --package=esbuild@0.25.0 -c 'command -v esbuild')" || return 1
  if [[ "$compiler" != /* || ! -x "$compiler" ]]; then
    echo "ERROR: pinned esbuild resolver did not return an executable absolute path: $compiler" >&2
    return 1
  fi
  BUNDLE_HOST_ESBUILD_PATH="$compiler"
}

# Reuse the shared compiler door for both host and desktop. The source-byte
# witness is measured around the actual compile, never reconstructed at boot.
bundle_host_replay_identity_define() { # <repo root>
  local -a identity_node=("${COMMITTED_NODE[@]:-node}")
  "${identity_node[@]}" --input-type=module - "$1" <<'NODE'
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
// The checkout's helper, exactly as the snapshot compile runs it: a script-snapshot launch runs
// this file from a private temp copy, so never resolve the helper beside it.
const snapshotHelper = resolve(root, 'apps/operator/bin/bundle-host-snapshot-esbuild.mjs');
const manifest = resolve(root, 'packages/operator-core/lib/retained-replay-sources.json');
const implementation = resolve(root, 'packages/operator-core/lib/retained-replay-identity.ts');
// Historical exact-source targets can predate replay identity entirely. They
// have no implementation to attest; never import current product bytes there.
// A partial feature (only one file missing) still fails closed below.
if (!existsSync(manifest) && !existsSync(implementation)) {
  process.stdout.write('--define:__PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__=undefined');
  process.exit(0);
}
// EI-28801967408009808: one file without the other is a partial feature, never a digest.
if (!existsSync(manifest) || !existsSync(implementation)) {
  throw new Error(`retained replay identity is partial: need both ${manifest} and ${implementation}`);
}
// A snapshot-labelled compile reads the label's blobs (WI-6554700010048234): attest those bytes.
// Resolve them through the compile's own gitlink-aware index: a manifest path inside a submodule
// (libs/test-config/...) is invisible to a superproject `git show <snapshot>:<path>`.
const snapshot = process.env.BUNDLE_HOST_SNAPSHOT_SOURCE_SHA;
let blobIndex;
if (snapshot) {
  const { snapshotBlobIndex } = await import(pathToFileURL(snapshotHelper).href);
  blobIndex = snapshotBlobIndex(resolve(root), snapshot); // index keys are absolute paths
}
const bytes = path => {
  if (!blobIndex) return readFileSync(resolve(root, path));
  const entry = blobIndex.get(resolve(root, path));
  if (!entry) throw new Error(`retained replay source ${path} is not in snapshot ${snapshot}`);
  return execFileSync('git', ['-C', entry.repo, 'cat-file', 'blob', entry.blob], { maxBuffer: 64 * 1024 * 1024 });
};
// Data only: the builder must not execute working-tree TypeScript under its
// committed-source loader. The regression compares this with the runtime reader.
// The bundle bakes the snapshot's manifest, so the file LIST comes from the same bytes.
const files = JSON.parse(bytes('packages/operator-core/lib/retained-replay-sources.json').toString('utf8'));
const sources = files.map(path => [path, createHash('sha256').update(bytes(path)).digest('hex')]);
const identity = createHash('sha256').update(JSON.stringify({ version: 1, sources })).digest('hex');
process.stdout.write('--define:__PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__=' +
  JSON.stringify(identity));
NODE
}

bundle_host_esbuild() { # <repo root> [compiler args...]
  local repo_root="$1"
  shift
  local replay_identity_define replay_identity_after compiler_rc=0
  replay_identity_define="$(bundle_host_run_step replay-identity-before bundle_host_replay_identity_define "$repo_root")" || return 78
  if [[ -n "${BUNDLE_HOST_BG_BUILD_CONTEXT:-}" ]]; then
    # BG preparation supplies an ORIGINAL per-invocation record and a private
    # pinned compiler. Never fall through to npx on a custody refusal.
    local -a guarded_node=("${COMMITTED_NODE[@]:-node}")
    bundle_host_run_step compiler-private-call "${guarded_node[@]}" "$repo_root/scripts/source-preview.mjs" bg-compiler \
      --context "$BUNDLE_HOST_BG_BUILD_CONTEXT" -- "$@" "$replay_identity_define" || compiler_rc=$?
  else
    bundle_host_prepare_esbuild "$repo_root" || return 1
    if [[ -n "${BUNDLE_HOST_SNAPSHOT_SOURCE_SHA:-}" ]]; then
      # WI-6554700010048234: a snapshot-labelled compile reads the label's git blobs, never the
      # live shared tree, through the same pinned compiler and lease. Plain node, like the fence:
      # this route exists to build uncommitted bytes. The helper refuses an off-recipe switch.
      bundle_host_run_step compiler-cache-call bundle_host_cached_package "$repo_root" \
        node "$repo_root/apps/operator/bin/bundle-host-snapshot-esbuild.mjs" "$repo_root" \
        "$BUNDLE_HOST_ESBUILD_PATH" 0.25.0 "$BUNDLE_HOST_SNAPSHOT_SOURCE_SHA" \
        "${BUNDLE_HOST_SNAPSHOT_SERVED_RECEIPT:--}" -- "$@" "$replay_identity_define" || compiler_rc=$?
    elif [[ -n "${BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT:-}" ]]; then
      # The same pinned compiler/cache door, using its API so the first plugin
      # can hand esbuild exact retained buffers and fence native resolution.
      local -a witness_node=("${COMMITTED_NODE[@]:-node}")
      bundle_host_run_step compiler-cache-call bundle_host_cached_package "$repo_root" \
        "${witness_node[@]}" "$repo_root/scripts/lib/testing-core-witness.mjs" prepare \
        "$repo_root" "$BUNDLE_HOST_ESBUILD_PATH" "$BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT" -- \
        "$@" "$replay_identity_define" || compiler_rc=$?
    else
    # Each use holds the maintained cache lease through version validation AND
    # compilation. Cache cleanup between uses can remove the memoized path; that
    # fails closed instead of substituting the installed (possibly newer) tool.
    bundle_host_run_step compiler-cache-call bundle_host_cached_package "$repo_root" bash -c '
      compiler="$1"; shift
      version="$("$compiler" --version)" || exit 78
      if [[ "$version" != 0.25.0 ]]; then
        echo "ERROR: host bundle requires esbuild 0.25.0; resolved $version" >&2
        exit 78
      fi
      exec "$compiler" "$@"
    ' bundle-host-esbuild "$BUNDLE_HOST_ESBUILD_PATH" "$@" "$replay_identity_define" || compiler_rc=$?
    fi
  fi
  (( compiler_rc == 0 )) || return "$compiler_rc"
  replay_identity_after="$(bundle_host_run_step replay-identity-after bundle_host_replay_identity_define "$repo_root")" || return 78
  if [[ "$replay_identity_after" != "$replay_identity_define" ]]; then
    echo 'ERROR: replay implementation sources changed during compilation; refusing the bundle' >&2
    return 78
  fi
}

# ESM output needs Node's CJS compatibility bindings. The dummy module keeps
# library CLI guards (`require.main === module`) from firing inside a bundle.
# The generated marker is intentional: content-lint must route any false-positive
# prose hits back to this generator, rather than quarantining an uneditable bundle.
HOST_BANNER="/* @generated by apps/operator/bin/bundle-host.sh - do not edit */ import{createRequire as __pcr}from'module';import{fileURLToPath as __pftu}from'url';import{dirname as __pdn}from'path';const require=__pcr(import.meta.url);const __pc_filename=__pftu(import.meta.url);const __pc_dirname=__pdn(__pc_filename);const module={exports:{}};const exports=module.exports;"
# The banner's path bindings use banner-PRIVATE names, and every esbuild call that takes
# HOST_BANNER must also pass HOST_BANNER_DEFINES. esbuild never sees banner text, so a bare
# `const __dirname` here collided with any module-level `__dirname` that esbuild left
# un-renamed. That happens whenever the graph has no FREE `__dirname` reference reserving the
# name (WI-10005299: the embed sidecar crash-looped on "Identifier '__dirname' has already been
# declared" once plugin-host-runtime.ts's own `const __dirname` kept its name). --define
# rewrites only FREE references, so CJS-style code still gets the banner's value, while a
# module's own declaration is a bound identifier that --define never touches.
HOST_BANNER_DEFINES=(--define:__dirname=__pc_dirname --define:__filename=__pc_filename)

# Release bundles share the desktop's name-preserving compaction. DBOS registers
# workflows and steps by function name, so never add --minify-identifiers here.
HOST_RELEASE_COMPACTION_ARGS=(--minify-whitespace --minify-syntax)
# HOST externalizes the optional viem client, including every package subpath.
# Resolve its official ESM utility exports so esbuild can tree-shake the pure
# helpers instead of loading whole utility/accounts/chains barrels at boot.
# Desktop already bundles these dependencies and does not need these aliases.
bundle_host_viem_aliases() {
  "$1" --input-type=module - "$2" <<'NODE'
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const require = createRequire(resolve(process.argv[2], 'packages/operator-core/package.json'));
const manifest = require.resolve('viem/package.json');
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
for (const subpath of ['utils', 'accounts', 'chains']) {
  const target = pkg.exports?.['./' + subpath]?.import;
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error('viem has no ESM export for ' + subpath);
  }
  console.log('--alias:viem/' + subpath + '=' + resolve(dirname(manifest), target));
}
NODE
}

# Prepare the worker BEFORE a parent embeds its independent expectation. Keep
# that binding in this build's shell; a running host never learns its expected
# digest from the sibling it is being asked to execute.
BUNDLE_HOST_TESTING_CORE_UNWITNESSED='unwitnessed:helper-not-committed'
# EI-28752668992567658: the producing witness binds the worker's whole input and
# resolution interval. A LIVE shared tree (dozens of concurrent editors) cannot
# hold that interval across a multi-minute host build. WI-6554700010048604:
# `testing-core-witness.mjs prepare` therefore compiles from a private,
# content-addressed copy of the consumed closure, which no peer can write, so a
# witnessed attempt no longer races live-tree churn. This degrade remains the
# fallback for a genuine refusal. A refusal must cost only the testing
# core, never the whole host rebuild: the worker is rebuilt UNWITNESSED, so the
# bundled testing core fails closed (testing_core_missing_witness, or an artifact
# mismatch when the parent already embedded the witness) while every other host
# module still ships current code instead of a stale last-known-good bundle.
# The fallback is loud (WARN line + build-steps journal); it never lets an
# unwitnessed testing core RUN, which is the property the witness protects.
BUNDLE_HOST_TESTING_CORE_DEGRADED='unwitnessed:custody-refused'
# EI-28774020156533677: bundle-host-fallback.test.ts drives the real bundle-host.sh
# against the real repo root to exercise the HOST fallback contract, not the testing
# core, yet the producing witness walks the whole input universe (node_modules
# included) on every call: measured >=65s of a ~110s case. This opt-in builds the
# worker UNWITNESSED instead, which is the fail-closed state (the bundled testing core
# refuses to run), so it can never forge a witness. Both keys are required: VITEST
# keeps a stray export of the opt-in from silently degrading a live host build.
BUNDLE_HOST_TESTING_CORE_FIXTURE='unwitnessed:vitest-fixture'
bundle_host_testing_core_fixture_opt_in() {
  [[ -n "${VITEST:-}" && "${PAPERCUSP_BUNDLE_HOST_UNWITNESSED_TESTING_CORE:-}" == 1 ]]
}
BUNDLE_HOST_TESTING_CORE_WORKER_ARGS=()
bundle_host_degrade_testing_core() { # <repo root> <reason>
  echo "WARN(EI-28752668992567658): $2; building testing-core.worker.mjs UNWITNESSED — the bundled testing core refuses to run until a witnessed rebuild succeeds." >&2
  (( ${#BUNDLE_HOST_TESTING_CORE_WORKER_ARGS[@]} > 0 )) || return 78
  bundle_host_esbuild "$1" "${BUNDLE_HOST_TESTING_CORE_WORKER_ARGS[@]}" >&2 || return 1
  BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE='--define:__PAPERCUSP_TESTING_CORE_WITNESS__=undefined'
  BUNDLE_HOST_TESTING_CORE_BINDING="$BUNDLE_HOST_TESTING_CORE_DEGRADED"
}
bundle_host_prepare_testing_core() { # <repo root> <out dir> [parent boundary args...]
  local repo_root="$1" out_dir="$2" argument native_pkg
  shift 2
  local receipt="$out_dir/testing-core.worker.witness.json"
  if [[ "${BUNDLE_HOST_TESTING_CORE_RECEIPT:-}" == "$receipt" && -n "${BUNDLE_HOST_TESTING_CORE_BINDING:-}" ]]; then
    bundle_host_verify_testing_core "$repo_root"
    return $?
  fi
  local -a boundary=("${HOST_COMMON_EXTERNALS[@]}")
  for native_pkg in "${NATIVE_PKGS[@]}"; do boundary+=("--external:$native_pkg"); done
  if declare -p HOST_EXTERNALS >/dev/null 2>&1; then boundary=("${HOST_EXTERNALS[@]}"); fi
  for argument in "$@"; do
    case "$argument" in --external:*|--alias:*|--minify-whitespace|--minify-syntax|--keep-names) boundary+=("$argument");; esac
  done
  local -a worker_args=(
    "$repo_root/packages/operator-core/lib/agent-tools/testing/testing-core.worker.ts"
    --bundle --platform=node --format=esm --target=node22
    --define:__PAPERCUSP_BUNDLED_SIDECAR__=true
    --banner:js="$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" "${boundary[@]}"
    --outfile="$out_dir/testing-core.worker.mjs" --metafile="$out_dir/testing-core.worker.mjs.meta.json"
  )
  BUNDLE_HOST_TESTING_CORE_WORKER_ARGS=("${worker_args[@]}")
  if bundle_host_testing_core_fixture_opt_in; then
    echo 'WARN(EI-28774020156533677): VITEST fixture opt-in; building testing-core.worker.mjs UNWITNESSED (the bundled testing core fails closed).' >&2
    bundle_host_esbuild "$repo_root" "${worker_args[@]}" >&2 || return 1
    BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE='--define:__PAPERCUSP_TESTING_CORE_WITNESS__=undefined'
    BUNDLE_HOST_TESTING_CORE_RECEIPT="$receipt"
    BUNDLE_HOST_TESTING_CORE_BINDING="$BUNDLE_HOST_TESTING_CORE_FIXTURE"
    return 0
  fi
  # WI-6554700010048115: COMMITTED_NODE refuses a helper with no committed
  # version, while this script itself runs from the working tree. Until the
  # witness helper is committed, compile the worker WITHOUT a producing witness
  # (HEAD semantics: the bundled testing core refuses testing_core_missing_witness)
  # instead of failing every host rebuild back to a stale last-known-good bundle.
  if ! git -C "$repo_root" cat-file -e "HEAD:scripts/lib/testing-core-witness.mjs" 2>/dev/null; then
    echo "WARN(WI-6554700010048115): scripts/lib/testing-core-witness.mjs has no committed version; building testing-core.worker.mjs UNWITNESSED until it is committed." >&2
    bundle_host_esbuild "$repo_root" "${worker_args[@]}" >&2 || return 1
    BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE='--define:__PAPERCUSP_TESTING_CORE_WITNESS__=undefined'
    BUNDLE_HOST_TESTING_CORE_RECEIPT="$receipt"
    BUNDLE_HOST_TESTING_CORE_BINDING="$BUNDLE_HOST_TESTING_CORE_UNWITNESSED"
    return 0
  fi
  local binding define
  local -a witness_node=("${COMMITTED_NODE[@]:-node}")
  # WI-6554700010048806: resolve the pinned compiler in THIS shell. The witnessed compile below
  # runs inside "$(...)", a subshell, so a resolution made there is lost and every later
  # compile paid a second npx package-cache lookup.
  if [[ -z "${BUNDLE_HOST_BG_BUILD_CONTEXT:-}" ]]; then
    bundle_host_prepare_esbuild "$repo_root" || return 1
  fi
  if binding="$(BUNDLE_HOST_TESTING_CORE_PREPARE_RECEIPT="$receipt" bundle_host_esbuild "$repo_root" \
      "${worker_args[@]}")" && define="$("${witness_node[@]}" \
      "$repo_root/scripts/lib/testing-core-witness.mjs" define "$receipt" "$binding")"; then
    BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE="$define"
    BUNDLE_HOST_TESTING_CORE_RECEIPT="$receipt"
    BUNDLE_HOST_TESTING_CORE_BINDING="$binding"
    return 0
  fi
  BUNDLE_HOST_TESTING_CORE_RECEIPT="$receipt"
  bundle_host_degrade_testing_core "$repo_root" 'the producing witness refused the worker build (see its error above)'
}

bundle_host_verify_testing_core() { # <repo root>
  [[ -n "${BUNDLE_HOST_TESTING_CORE_RECEIPT:-}" && -n "${BUNDLE_HOST_TESTING_CORE_BINDING:-}" ]] || return 78
  if [[ "$BUNDLE_HOST_TESTING_CORE_BINDING" == "$BUNDLE_HOST_TESTING_CORE_UNWITNESSED" ]]; then
    echo 'WARN(WI-6554700010048115): testing-core witness verification skipped (helper not committed).' >&2
    return 0
  fi
  if [[ "$BUNDLE_HOST_TESTING_CORE_BINDING" == "$BUNDLE_HOST_TESTING_CORE_DEGRADED" ]]; then
    echo 'WARN(EI-28752668992567658): testing-core witness verification skipped (worker already built unwitnessed).' >&2
    return 0
  fi
  if [[ "$BUNDLE_HOST_TESTING_CORE_BINDING" == "$BUNDLE_HOST_TESTING_CORE_FIXTURE" ]]; then
    echo 'WARN(EI-28774020156533677): testing-core witness verification skipped (VITEST fixture build).' >&2
    return 0
  fi
  local -a witness_node=("${COMMITTED_NODE[@]:-node}")
  "${witness_node[@]}" "$1/scripts/lib/testing-core-witness.mjs" verify \
    "$BUNDLE_HOST_TESTING_CORE_RECEIPT" "$BUNDLE_HOST_TESTING_CORE_BINDING" && return 0
  # The witnessed worker may already be published beside a parent that embeds
  # its expectation. Replacing it unwitnessed makes that pair fail closed.
  bundle_host_degrade_testing_core "$1" 'the producing testing-core interval changed after the witnessed worker build'
}

bundle_host_select_profile() {
  HOST_MINIFY_ARGS=()
  case "${1:-development}" in
    # Resident source text costs memory in every host. Preserve identifiers and
    # leave syntax rewrites to the release profile.
    development) HOST_MINIFY_ARGS=(--minify-whitespace) ;;
    release) HOST_MINIFY_ARGS=("${HOST_RELEASE_COMPACTION_ARGS[@]}") ;;
    *) echo "ERROR: host bundle profile must be development or release" >&2; return 78 ;;
  esac
}

# Packages with native addons, platform binaries, or runtime template imports
# that esbuild cannot safely inline. The desktop sidecar closure-copies these;
# the development host resolves them from workspace node_modules.
NATIVE_PKGS=(
  sodium-native udx-native rocksdb-native quickbit-native rabin-native
  simdle-native fs-native-extensions
  bare-fs bare-os bare-url bare-inspect bare-type
  better-sqlite3
  # Trusted handler bootstrap uses the maintained native FFI boundary. Keep
  # its package loader and target addon together in host and desktop builds.
  koffi
  ssh2
  onnxruntime-node
  onnxruntime-web
  "@huggingface/transformers"
  sharp
  esbuild
  # Playwright resolves browser descriptors and injected scripts relative to its
  # package, and lazily loads the separately installed Chromium BiDi mapper.
  # Inlining it resolves that optional branch even in a scoped install without
  # BiDi. Preserve its Node loader and assets; the desktop copies this package
  # through the same runtime dependency closure as the other entries here.
  playwright-core
)

# Shared optional/runtime-only externals. Callers append platform-specific
# packages (notably embedded-postgres) before invoking esbuild.
HOST_COMMON_EXTERNALS=(
  --external:@lydell/*
  --external:bufferutil
  --external:utf-8-validate
  --external:fsevents
  --external:cpu-features
  --external:@opentelemetry/context-async-hooks
  --external:@opentelemetry/core
  --external:@opentelemetry/resources
  # Keep the SDK and its CommonJS core dependency on the same runtime boundary.
  --external:@opentelemetry/sdk-trace
  --external:@opentelemetry/sdk-trace-base
  --external:@opentelemetry/sdk-trace-node
  --external:@opentelemetry/sdk-logs
  --external:@opentelemetry/sdk-metrics
  --external:@opentelemetry/exporter-trace-otlp-proto
  --external:@opentelemetry/exporter-logs-otlp-proto
  --external:@opentelemetry/exporter-metrics-otlp-proto
)

# The host, packaged desktop and current-build rig execute the same worker
# graph. Keep its complete sibling set here; a successful build must not
# silently substitute inline work or omit compaction/sentinel workers.
HOST_WORKER_OUTPUTS=(
  local-embedder-worker.script.mjs
  cpu-task-worker.script.mjs
  local-reranker-worker.script.mjs
  event-loop-sentinel.worker.mjs
  snapshot-fold.worker.mjs
  mutation-probe-closure.worker.mjs
  admission-jobs.worker.mjs
  precision-bench-worker.mjs
  first-party-callers.worker.mjs
  role-codex-home.worker.mjs
  warm-cochange-index.worker.mjs
  testing-core.worker.mjs
)

# Dependency-free on-disk scripts that the bundled host resolves as SIBLINGS of
# its entry module (dirname(import.meta.url) collapses to the bundle's own dir),
# so they can never be inlined: git execs git-ext-bridge.mjs as the pot-git
# `ext::` transport, and systemd-scope.ts execs systemd-scope-env-runner.mjs.
# Every builder must stage ALL of them. Repo-relative sources; the output name
# is the basename. worker-scripts-bundled.test.ts reads THIS list, so a new
# sibling added here is enforced on every bundler automatically. (The
# current-build rig once staged only the runner, so every same-box hive-git
# fetch died "Cannot find module .../git-ext-bridge.mjs" — WI-10003976.)
HOST_RUNTIME_SIBLING_SOURCES=(
  packages/operator-core/lib/systemd-scope-env-runner.mjs
  packages/operator-core/lib/sync/pot-git/git-ext-bridge.mjs
)
HOST_RUNTIME_SIBLING_OUTPUTS=()
for __pc_sibling in "${HOST_RUNTIME_SIBLING_SOURCES[@]}"; do
  HOST_RUNTIME_SIBLING_OUTPUTS+=("${__pc_sibling##*/}")
done
unset __pc_sibling

bundle_host_runtime_siblings() { # <repo root> <out dir>
  local repo_root="$1" out_dir="$2" source output tmp
  mkdir -p "$out_dir" || return 1
  for source in "${HOST_RUNTIME_SIBLING_SOURCES[@]}"; do
    output="${source##*/}"
    [ -s "$repo_root/$source" ] || { echo "FATAL: missing runtime sibling $repo_root/$source" >&2; return 1; }
    tmp="$out_dir/$output.new.$$"
    cp "$repo_root/$source" "$tmp" && mv -f "$tmp" "$out_dir/$output" || return 1
  done
}

# On failure, BUNDLE_HOST_WORKER_FAILED_SOURCE / _OUTPUT name the worker that
# stopped the run (empty for a failure not tied to one worker). Every publish is
# tmp-then-rename, so a failed worker leaves its previous output byte-intact —
# bundle-host.sh relies on that to boot a supervisor on last-known-good
# (WI-10005087). Packaging callers ignore both and stay strict.

# P-011: maintained spawner entry, sharing the caller's exact external/define
# boundary. It is a sibling artifact, never a second source launcher.
bundle_host_spawner() { # <repo root> <out dir> [esbuild boundary args...]
  local repo_root="$1" out_dir="$2"
  shift 2
  local output="$out_dir/spawner-sidecar.mjs" tmp meta stamp
  mkdir -p "$out_dir" || return 1
  tmp="$output.new.$$"
  meta="$tmp.meta.json"
  stamp="$tmp.probe.json"
  # WI-10005802: bundle-host.sh defines COMMITTED_NODE so these helpers run their committed
  # bytes before its restricted-hold gate; other callers (release packaging) keep plain node.
  local -a run_node=("${COMMITTED_NODE[@]:-node}")
  if ! bundle_host_run_step spawner-probe-wait "${run_node[@]}" "$repo_root/scripts/mutation-probe-window-gate.mjs" wait --root "$repo_root" \
      --stamp-file "$stamp" ||
     ! bundle_host_run_step spawner-compile bundle_host_esbuild "$repo_root" "$repo_root/apps/operator/bin/spawner-sidecar.ts" \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile="$tmp" --metafile="$meta" --banner:js="$HOST_BANNER" \
      "${HOST_BANNER_DEFINES[@]}" --define:__PAPERCUSP_BUNDLED_SIDECAR__=true "$@" ||
     ! bundle_host_run_step spawner-probe-verify "${run_node[@]}" "$repo_root/scripts/mutation-probe-window-gate.mjs" verify --root "$repo_root" --stamp-file "$stamp" ||
     ! bundle_host_run_step spawner-cli-guard "${run_node[@]}" "$repo_root/scripts/check-bundled-cli-entry-guards.mjs" --metafile "$meta" --base-dir "$repo_root/apps/operator"; then
    rm -f "$tmp" "$meta" "$stamp"
    return 1
  fi
  if ! bundle_host_run_step spawner-ascii-and-syntax "${run_node[@]}" "$repo_root/apps/operator/bin/ascii-escape-bundle.mjs" "$tmp" --check; then
    rm -f "$tmp" "$meta" "$stamp"
    return 1
  fi
  mv -f "$tmp" "$output" || return 1
  mv -f "$meta" "$output.meta.json" || return 1
  rm -f "$stamp"
}

# The installed PRIMARY and launcher recipes are shared with disposable setup.
# Callers retain their platform boundary and version/dogfood defines.
bundle_host_primary() { # <repo root> <out dir> [esbuild boundary args...]
  local repo_root="$1" out_dir="$2"
  shift 2
  local output="$out_dir/serve.mjs" tmp="$out_dir/serve.new.mjs"
  mkdir -p "$out_dir" || return 1
  bundle_host_run_step primary-testing-core bundle_host_prepare_testing_core "$repo_root" "$out_dir" "$@" || return 1
  bundle_host_run_step primary-compile bundle_host_esbuild "$repo_root" "$repo_root/apps/operator/bin/serve.ts" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$tmp" --metafile="$output.meta.json" --banner:js="$HOST_BANNER" \
    "${HOST_BANNER_DEFINES[@]}" "$BUNDLE_HOST_TESTING_CORE_WITNESS_DEFINE" "$@" || return 1
  local -a run_node=("${COMMITTED_NODE[@]:-node}")
  bundle_host_run_step primary-ascii-and-syntax "${run_node[@]}" "$repo_root/apps/operator/bin/ascii-escape-bundle.mjs" "$tmp" --check || return 1
  bundle_host_run_step primary-testing-core-verify bundle_host_verify_testing_core "$repo_root" || return 1
  mv -f "$tmp" "$output"
}

bundle_host_launcher() { # <repo root> <output> <source stem> [compaction args...]
  local repo_root="$1" output="$2" stem="$3"
  shift 3
  mkdir -p "$(dirname "$output")" || return 1
  # These ARE the CLI entrypoints; never suppress isCliEntry() here.
  bundle_host_run_step "launcher-$stem" bundle_host_esbuild "$repo_root" "$repo_root/apps/operator/scripts/$stem.mjs" \
    --bundle --platform=node --format=esm --target=node22 \
    --outfile="$output" --metafile="$output.meta.json" --banner:js="$HOST_BANNER" \
    "${HOST_BANNER_DEFINES[@]}" --external:@lydell/* --external:@iarna/toml "$@"
}

bundle_host_handler_bootstrap() { # <repo root> <out dir>
  local repo_root="$1" out_dir="$2" tmp
  local source="$repo_root/packages/plugin-loader/src/daemon/handler-bootstrap.ts"
  mkdir -p "$out_dir" || return 1
  tmp="$out_dir/handler-bootstrap.cjs.new.$$"
  # A standalone guest entry: no host ESM banner, host defines or host imports.
  # Koffi's Node loader and native addon are copied by the runtime closure stage.
  if ! bundle_host_esbuild "$repo_root" "$source" \
      --bundle --platform=node --format=cjs --target=node22 --external:koffi --outfile="$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$out_dir/handler-bootstrap.cjs"
}

bundle_host_workers() {
  local repo_root="$1" out_dir="$2" source output tmp
  # WI-6554700010048806: create the output directory before the testing-core prepare. That
  # prepare writes its witness receipt and compiled core into "$out_dir", so a fresh
  # destination made the witness refuse and degrade before any worker was written.
  mkdir -p "$out_dir" || return 1
  # Reuse the generation prepared before the parent, rather than compiling a
  # different worker after its independent expectation has already been baked.
  bundle_host_prepare_testing_core "$repo_root" "$out_dir" || return 1
  bundle_host_handler_bootstrap "$repo_root" "$out_dir" || return 1
  # A private dependency snapshot still shares npx's package cache with every
  # checkout. The repo install lease cannot protect it from cache maintenance.
  local -a sources=(
    "${3:-$repo_root/libs/generic/memory/src/local-embedder-worker.script.mjs}"
    "$repo_root/packages/operator-core/lib/cpu-task-worker.script.mjs"
    "$repo_root/libs/generic/rerank/src/local-reranker-worker.script.mjs"
  )
  local index=0
  BUNDLE_HOST_WORKER_FAILED_SOURCE=""
  BUNDLE_HOST_WORKER_FAILED_OUTPUT=""
  # EI-24917607035361603: never rely on the caller having created the gate's meta dir. A
  # git-sync sweep can commit a caller that sets the variable without its mkdir (candidate
  # 75e965a93682 did), and the first append below then failed the whole worker step.
  if [ -n "${BUNDLE_HOST_GATE_META_DIR:-}" ] && ! mkdir -p "$BUNDLE_HOST_GATE_META_DIR"; then
    echo "FATAL: cannot create the restricted-hold gate meta dir $BUNDLE_HOST_GATE_META_DIR" >&2
    return 1
  fi
  if [ -n "${BUNDLE_HOST_GATE_META_DIR:-}" ]; then
    cp "$out_dir/testing-core.worker.mjs.meta.json" "$BUNDLE_HOST_GATE_META_DIR/testing-core.worker.mjs.meta.json" || {
      echo "FATAL: cannot record testing-core.worker.mjs.meta.json in $BUNDLE_HOST_GATE_META_DIR for the restricted-hold gate" >&2
      return 1
    }
  fi
  for source in "${sources[@]}"; do
    output="${HOST_WORKER_OUTPUTS[$index]}"
    BUNDLE_HOST_WORKER_FAILED_SOURCE="$source"
    BUNDLE_HOST_WORKER_FAILED_OUTPUT="$output"
    [ -s "$source" ] || { echo "FATAL: missing runtime worker $source" >&2; return 1; }
    tmp="$out_dir/$output.new.$$"
    if [ "$output" = "cpu-task-worker.script.mjs" ]; then
      # Package the evidence guard's parser for installed sidecars as well as dev.
      local -a cpu_meta_args=()
      if [ -n "${BUNDLE_HOST_GATE_META_DIR:-}" ]; then
        cpu_meta_args=(--metafile="$BUNDLE_HOST_GATE_META_DIR/$output.meta.json")
      fi
      bundle_host_run_step "worker-$output" bundle_host_esbuild "$repo_root" "$source" \
        --bundle --platform=node --format=esm --target=node22 \
        --banner:js="import{createRequire as __cpuRequire}from'node:module';import{fileURLToPath as __cpuFile}from'node:url';import{dirname as __cpuDir}from'node:path';const require=__cpuRequire(import.meta.url),__filename=__cpuFile(import.meta.url),__dirname=__cpuDir(__filename);" \
        --outfile="$tmp" "${cpu_meta_args[@]}" || return 1
      mv -f "$tmp" "$out_dir/$output" || return 1
    else
      cp "$source" "$tmp" && mv -f "$tmp" "$out_dir/$output" || return 1
    fi
    # WI-10005745: bundle-host.sh's restricted-hold gate needs every input it published.
    if [ -n "${BUNDLE_HOST_GATE_META_DIR:-}" ]; then
      printf '%s\n' "$source" >> "$BUNDLE_HOST_GATE_META_DIR/copied-sources.txt" || {
        echo "FATAL: cannot record $source in $BUNDLE_HOST_GATE_META_DIR/copied-sources.txt for the restricted-hold gate" >&2
        return 1
      }
    fi
    index=$((index + 1))
  done
  local -a meta_args
  # EI-24812987867215907 fix (a), widened 2026-10-06: a TS worker whose import
  # graph reaches the operator cone (precision-bench-worker.ts -> precision-monitor
  # -> sync-sse / @papercusp/db-org reaches @dbos-inc/dbos-sdk telemetry, ssh2 and
  # onnxruntime-node .node binaries) must externalize EXACTLY what the host entry
  # externalizes, or esbuild cannot resolve them and bg-host refuses to start.
  # Prefer the caller's full HOST_EXTERNALS (bundle-host.sh / build-desktop-sidecar.sh
  # define it as HOST_COMMON_EXTERNALS + native packages + runtime-resolved deps);
  # fall back to the shared optional externals + native packages (both defined in
  # THIS file) for a caller that does not, e.g. worker-scripts-bundled.test.ts.
  local -a worker_externals=("${HOST_COMMON_EXTERNALS[@]}")
  local native_pkg
  for native_pkg in "${NATIVE_PKGS[@]}"; do worker_externals+=("--external:$native_pkg"); done
  if declare -p HOST_EXTERNALS >/dev/null 2>&1; then
    worker_externals=("${HOST_EXTERNALS[@]}")
  fi
  for source in \
    "$repo_root/packages/operator-core/lib/event-loop-sentinel.worker.ts" \
    "$repo_root/packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.ts" \
    "$repo_root/packages/operator-core/lib/agent-tools/testing/mutation-probe-closure.worker.ts" \
    "$repo_root/packages/operator-core/lib/release/admission-jobs.worker.ts" \
    "$repo_root/packages/operator-core/lib/memory/bench/precision-bench-worker.ts" \
    "$repo_root/packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts" \
    "$repo_root/packages/operator-core/lib/role-codex-home.worker.ts" \
    "$repo_root/packages/operator-core/lib/code-intelligence/warm-cochange-index.worker.ts"; do
    output="${HOST_WORKER_OUTPUTS[$index]}"
    BUNDLE_HOST_WORKER_FAILED_SOURCE="$source"
    BUNDLE_HOST_WORKER_FAILED_OUTPUT="$output"
    [ -s "$source" ] || { echo "FATAL: missing runtime worker $source" >&2; return 1; }
    tmp="$out_dir/$output.new.$$.mjs"
    meta_args=()
    [ -n "${BUNDLE_HOST_GATE_META_DIR:-}" ] && meta_args=(--metafile="$BUNDLE_HOST_GATE_META_DIR/$output.meta.json")
    if ! bundle_host_run_step "worker-$output" bundle_host_esbuild "$repo_root" "$source" \
      --bundle --platform=node --format=esm --target=node22 \
      --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
      "${worker_externals[@]}" \
      --external:sodium-native --external:esbuild --banner:js="$HOST_BANNER" "${HOST_BANNER_DEFINES[@]}" --outfile="$tmp" --log-limit=5 \
      "${meta_args[@]}"; then
      rm -f "$tmp"
      echo "FATAL: failed to bundle runtime worker $source" >&2
      return 1
    fi
    [ -s "$tmp" ] && mv -f "$tmp" "$out_dir/$output" || return 1
    index=$((index + 1))
  done
  BUNDLE_HOST_WORKER_FAILED_SOURCE=""
  BUNDLE_HOST_WORKER_FAILED_OUTPUT=""
  for output in "${HOST_WORKER_OUTPUTS[@]}"; do
    [ -s "$out_dir/$output" ] || { echo "FATAL: missing bundled worker $output" >&2; return 1; }
  done
  # precision-bench-worker resolves corpus/gold-set data from fixtures/ next to
  # its emitted bundle. esbuild includes the loader code but not these JSON files.
  local fixtures_dir="$out_dir/fixtures" fixture_name fixture fixture_output
  mkdir -p "$fixtures_dir" || {
    echo "FATAL: cannot create precision benchmark fixture directory $fixtures_dir" >&2
    return 1
  }
  for fixture_name in corpus.v1.json gold-set.v1.json; do
    fixture="$repo_root/packages/operator-core/lib/memory/bench/fixtures/$fixture_name"
    fixture_output="$fixtures_dir/$fixture_name"
    tmp="$fixture_output.new.$$"
    [ -s "$fixture" ] || {
      echo "FATAL: missing precision benchmark runtime fixture $fixture" >&2
      return 1
    }
    if ! cp "$fixture" "$tmp" || ! mv -f "$tmp" "$fixture_output"; then
      rm -f "$tmp"
      echo "FATAL: failed to stage precision benchmark runtime fixture $fixture into $fixtures_dir" >&2
      return 1
    fi
    [ -s "$fixture_output" ] || {
      echo "FATAL: staged precision benchmark runtime fixture is empty: $fixture_output" >&2
      return 1
    }
  done
}
