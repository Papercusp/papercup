#!/usr/bin/env bash
# Build the minimal headless P2P witness and its deterministic identity manifest.
# The witness reuses the canonical serve.ts host graph but omits the Vite SPA and
# desktop shell. Optional model/capability packs are copied and hashed separately.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PAPERCUSP_REPO_ROOT:-$(cd "$HERE/.." && pwd)}"
OUT="${PAPERCUSP_WITNESS_OUT:-$ROOT/papercusp-desktop/artifacts/p2p-witness}"
MODEL_PACK="${PAPERCUSP_WITNESS_MODEL_PACK:-}"
CAPABILITY_PACK="${PAPERCUSP_WITNESS_CAPABILITY_PACK:-}"

[[ -d "$ROOT/apps/operator" ]] || { echo "ERROR: repository root has no apps/operator: $ROOT" >&2; exit 2; }
[[ ! -e "$OUT" || "${PAPERCUSP_WITNESS_REPLACE:-0}" == "1" ]] || {
  echo "ERROR: witness output already exists; set PAPERCUSP_WITNESS_REPLACE=1 to replace it" >&2
  exit 2
}

# A cross-filesystem mv copies directly into OUT and exposes its manifest before
# runtime dependencies arrive. Keep the private stage beside OUT so publication
# is one rename regardless of TMPDIR's filesystem.
mkdir -p "$(dirname "$OUT")"
OUT_PARENT="$(cd "$(dirname "$OUT")" && pwd -P)"
OUT="$OUT_PARENT/$(basename "$OUT")"
STAGE="$(mktemp -d "$OUT_PARENT/.papercusp-p2p-witness.XXXXXX")"
cleanup() {
  local status=$?
  if [[ "$status" != 0 ]]; then
    echo "ERROR: witness build failed; retained staging directory: $STAGE" >&2
  else
    rm -rf "$STAGE"
  fi
}
trap cleanup EXIT
mkdir -p "$STAGE/packs" "$STAGE/build-meta" "$STAGE/build-state"

source "$ROOT/apps/operator/bin/bundle-host-common.sh"
BUNDLE_HOST_STEP_LOG="$STAGE/build-steps.jsonl"
HOST_EXTERNALS=(
  "${HOST_COMMON_EXTERNALS[@]}"
  --external:@embedded-postgres/darwin-arm64
  --external:@embedded-postgres/darwin-x64
  --external:@embedded-postgres/linux-arm
  --external:@embedded-postgres/linux-arm64
  --external:@embedded-postgres/linux-ia32
  --external:@embedded-postgres/linux-ppc64
  --external:@embedded-postgres/windows-x64
  --external:@papercusp/embedded-postgres-server
)
for native_package in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=("--external:$native_package"); done

echo "→ bundling headless P2P witness"
(cd "$ROOT/apps/operator" && npx --yes esbuild@0.25.0 bin/serve.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --minify-whitespace --minify-syntax \
  --outfile="$STAGE/serve.mjs" \
  --metafile="$STAGE/build-meta/serve.meta.json" \
  --banner:js="$HOST_BANNER" \
  "${HOST_BANNER_DEFINES[@]}" \
  --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
  "${HOST_EXTERNALS[@]}")

# External imports must resolve from the produced tree, not the build checkout.
# Reuse the production copier and its nested/optional dependency policy.
REPO_ROOT="$ROOT"
WEB_DIR="$ROOT/apps/operator"
SIDECAR_DIR="$STAGE"
TARGET_OS="$(node -p 'process.platform')"
TARGET_ARCH="$(node -p 'process.arch')"
_bare_node_platform="$TARGET_OS"
_bare_node_arch="$TARGET_ARCH"
nat_copied=0
nat_missing=0
_seen="|"
source "$ROOT/papercusp-desktop/bin/lib/transformers-models.sh"
source "$ROOT/papercusp-desktop/bin/lib/host-runtime-closure.sh"
mkdir -p "$STAGE/node_modules"
bundle_host_run_step runtime-closure copy_host_external_closures
bundle_host_run_step runtime-opaque-closure copy_host_runtime_require_closures
# Qualify the real default provider before classifying DBOS's legacy lazy
# telemetry imports. The shared census refuses to infer this from source alone.
bundle_host_run_step runtime-trace-context assert_host_default_trace_context "$STAGE"
# Resolve wildcard externals from the compiler's actual import graph using the
# production census, including its required-versus-optional loader policy.
bundle_host_run_step runtime-import-census write_host_graph_dependency_census "$STAGE" > "$STAGE/graph-packages.tsv"
while IFS=$'\t' read -r dependency_kind dependency_name; do
  if [[ "$dependency_kind" == required ]] || resolve_pkg_source "$dependency_name" '' >/dev/null 2>&1; then
    bundle_host_run_step "closure-import:$dependency_name" copy_pkg_closure "$dependency_name"
  fi
done < "$STAGE/graph-packages.tsv"
[[ "$nat_missing" == 0 ]] || { echo "ERROR: witness runtime dependencies are incomplete" >&2; exit 1; }
bundle_host_run_step runtime-closure-check assert_runtime_dependency_closure "$STAGE"

if [[ -n "$MODEL_PACK" ]]; then
  [[ -e "$MODEL_PACK" ]] || { echo "ERROR: model pack does not exist: $MODEL_PACK" >&2; exit 2; }
  cp -a "$MODEL_PACK" "$STAGE/packs/model"
fi
if [[ -n "$CAPABILITY_PACK" ]]; then
  [[ -e "$CAPABILITY_PACK" ]] || { echo "ERROR: capability pack does not exist: $CAPABILITY_PACK" >&2; exit 2; }
  cp -a "$CAPABILITY_PACK" "$STAGE/packs/capability"
fi

SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SUBMODULE_SHA="$(git -C "$ROOT/libs/papercusp" rev-parse HEAD)"
node "$ROOT/scripts/p2p-witness-manifest.mjs" \
  --repo-root "$ROOT" --output-dir "$STAGE" \
  --source-sha "$SOURCE_SHA" --submodule-sha "$SUBMODULE_SHA" \
  ${MODEL_PACK:+--model-pack "$STAGE/packs/model"} \
  ${CAPABILITY_PACK:+--capability-pack "$STAGE/packs/capability"}

mkdir -p "$(dirname "$OUT")"
if [[ -e "$OUT" ]]; then rm -rf "$OUT"; fi
mv "$STAGE" "$OUT"
trap - EXIT
echo "P2P witness ready: $OUT"
