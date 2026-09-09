#!/usr/bin/env bash
# P-307 / D-253 / D-254 — the ONE bake path. Build the workspace-host bootc image once, sign and
# attest it once, then render it to every cloud's disk format from THAT ONE DIGEST.
#
# WHAT THIS REPLACES. `infra/images/workspace-host.pkr.hcl` declares exactly one Packer source
# (`googlecompute`), while `operator-core/lib/workspace-host/` carries three independent
# publishers (gcp-image-family, aws-ami-release, azure-compute-gallery-release). So "one image,
# three clouds" was one image on ONE cloud plus three registration paths that could drift with
# nothing to notice. This collapses the BAKE; the per-cloud PUBLISH adapters stay exactly as they
# are, because each cloud's image registry genuinely differs and D-253 keeps them.
#
# ⛔ THE PROPERTY THIS SCRIPT EXISTS TO ENFORCE — every cloud disk is rendered from the SAME
# image digest, and that is ASSERTED, not assumed. Handing `bootc-image-builder` a TAG three
# times is the obvious way to write this and it is silently wrong: a tag move between two
# invocations yields disks built from different content while all three exit 0 and the build log
# reads clean. That is D-288's orphaned-attestation defect one level up — same cause (a mutable
# reference resolved more than once), same signature (nothing errors), and the same repair
# (resolve the digest ONCE, from the registry, and pass `repo@sha256:…` everywhere after).
# `bake_one` therefore refuses any ref that is not digest-pinned.
#
# ⛔ AND THE SUPPLY CHAIN RUNS BEFORE ANY DISK IS CUT. release-supply-chain.sh was built by P-308
# and, until this script, was invoked by NOTHING — no release signed or attested. Rendering disks
# from an image that failed signing wastes the expensive half of the pipeline on bytes that must
# not ship, so the gate goes first and a failure there stops the bake.
#
# Usage:
#   bake-cloud-images.sh --registry <host[:port]/namespace> --key <cosign.key> [options]
#
#   --registry REF       registry namespace to publish the image to, e.g. reg.example.com/papercusp.
#                        ⚠ INCLUDE THE PORT if the registry uses one: it is part of the signature
#                        scope, and dropping it makes the host refuse its own release with a
#                        message byte-identical to "unsigned" (p307-registries-d-scope-probe.sh).
#   --key PATH           cosign private key; COSIGN_PASSWORD is read from the environment.
#   --pubkey PATH        matching public key (default: --key with .key replaced by .pub).
#   --tag TAG            image tag to publish (default: papercusp-workspace-host-<date>).
#   --clouds LIST        comma-separated subset of gcp,aws,azure (default: all three).
#   --out DIR            artifact directory (default: ./.bake-out).
#   --release-root DIR   extracted vm-release tree to bake into the optional P-305 image target.
#   --release-version V  version directory name for --release-root (both options are required
#                        together; omitting both preserves the P-306/P-307 OS-only image).
#   --source-image REF   reuse an already-verified local image instead of rebuilding it. The
#                        source is retagged and pushed, then the normal registry-digest,
#                        supply-chain and render gates still run. Mutually exclusive with the
#                        release-root options because those inputs are already baked into REF.
#   --insecure-registry  plain-HTTP / self-signed registry (local testing only).
#   --dry-run            resolve and PLAN every step, run no build and no bake. Prints the same
#                        digest-pinned refs the real run would use.
#
# Exit: 0 all requested clouds rendered; 1 a step failed; 2 usage/setup error;
#       3 the supply-chain gate refused the image (nothing was baked).

# EI-22355025813361885 — freeze the entrypoint before Bash can lazily parse a
# compound body. A long bake must keep executing the bytes it passed at startup;
# an in-place editor can otherwise replace the inode while Bash is between the
# early setup commands and a later function body. Re-exec the validated copy so
# the mutable checkout is never the interpreter's live input.
if [ "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT:-0}" != "1" ] &&
   [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _BAKE_SOURCE_PATH="${BASH_SOURCE[0]}"
  _BAKE_SOURCE_DIR="$(cd "$(dirname "$_BAKE_SOURCE_PATH")" && pwd -P)" || {
    echo "FATAL: cannot resolve bake script directory: $_BAKE_SOURCE_PATH" >&2
    exit 2
  }
  _BAKE_SOURCE_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/papercusp-bake-cloud-images.XXXXXX.sh")" || {
    echo "FATAL: cannot create an immutable bake script snapshot" >&2
    exit 2
  }
  # The parent trap covers copy/validation failures. The re-exec'd child installs
  # its own trap because exec replaces this shell before an EXIT trap can run.
  trap 'rm -f -- "$_BAKE_SOURCE_SNAPSHOT"' EXIT
  if ! cp -- "$_BAKE_SOURCE_PATH" "$_BAKE_SOURCE_SNAPSHOT" ||
     ! bash -n -- "$_BAKE_SOURCE_SNAPSHOT"; then
    echo "FATAL: bake script snapshot is not a valid Bash program" >&2
    exit 2
  fi
  export PAPERCUSP_BAKE_SOURCE_SNAPSHOT=1
  export PAPERCUSP_BAKE_SOURCE_DIR="$_BAKE_SOURCE_DIR"
  export PAPERCUSP_BAKE_SOURCE_SNAPSHOT_PATH="$_BAKE_SOURCE_SNAPSHOT"
  exec bash "$_BAKE_SOURCE_SNAPSHOT" "$@" || exit 2
fi
if [ "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT:-0}" = "1" ]; then
  trap 'rm -f -- "${PAPERCUSP_BAKE_SOURCE_SNAPSHOT_PATH:-}"' EXIT
fi

set -uo pipefail

if [ -n "${PAPERCUSP_BAKE_SOURCE_DIR:-}" ]; then
  HERE="$PAPERCUSP_BAKE_SOURCE_DIR"
else
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
BUILD_HEALTH="$HERE/p307-build-health.sh"

# bootc-image-builder's output type per cloud, and the disk file it produces. This table is the
# whole per-cloud surface of the bake — three rows instead of three pipelines.
declare -A CLOUD_TYPE=( [gcp]=gce      [aws]=ami       [azure]=vhd )
declare -A CLOUD_FILE=( [gcp]=image/disk.raw [aws]=image/disk.raw [azure]=vhd/disk.vhd )
declare -A CLOUD_SHA=() CLOUD_BYTES=()

REGISTRY=""; KEY=""; PUBKEY=""; TAG=""; CLOUDS="gcp,aws,azure"; OUT="./.bake-out"
RELEASE_ROOT=""; RELEASE_VERSION=""; SOURCE_IMAGE=""
INSECURE=0; DRY_RUN=0
BIB_IMG="${BOOTC_IMAGE_BUILDER:-quay.io/centos-bootc/bootc-image-builder:latest}"
SKOPEO_IMG="${SKOPEO_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"

die() { echo "FATAL: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="${2:-}"; shift 2;;
    --key) KEY="${2:-}"; shift 2;;
    --pubkey) PUBKEY="${2:-}"; shift 2;;
    --tag) TAG="${2:-}"; shift 2;;
    --clouds) CLOUDS="${2:-}"; shift 2;;
    --out) OUT="${2:-}"; shift 2;;
    --release-root) RELEASE_ROOT="${2:-}"; shift 2;;
    --release-version) RELEASE_VERSION="${2:-}"; shift 2;;
    --source-image) SOURCE_IMAGE="${2:-}"; shift 2;;
    --insecure-registry) INSECURE=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '1,45p' "$0"; exit 0;;
    *) die "unknown argument '$1'";;
  esac
done

[ -n "$REGISTRY" ] || die "--registry is required"
[ "$DRY_RUN" -eq 1 ] || [ -n "$KEY" ] || die "--key is required (or use --dry-run)"
if [ -n "$RELEASE_ROOT" ] || [ -n "$RELEASE_VERSION" ]; then
  [ -n "$RELEASE_ROOT" ] && [ -n "$RELEASE_VERSION" ] \
    || die "--release-root and --release-version must be supplied together"
  [ -d "$RELEASE_ROOT" ] || die "--release-root is not a directory: $RELEASE_ROOT"
  RELEASE_ROOT="$(cd "$RELEASE_ROOT" && pwd -P)" \
    || die "cannot resolve --release-root: $RELEASE_ROOT"
  case "$RELEASE_VERSION" in
    [A-Za-z0-9]*) ;;
    *) die "--release-version must start with an alphanumeric";;
  esac
  case "$RELEASE_VERSION" in
    *[!A-Za-z0-9._+-]*) die "--release-version contains unsafe characters";;
  esac
  [ "${#RELEASE_VERSION}" -le 128 ] \
    || die "--release-version must be at most 128 characters"
fi
[ -z "$SOURCE_IMAGE" ] || { [ -z "$RELEASE_ROOT" ] && [ -z "$RELEASE_VERSION" ]; } \
  || die "--source-image is mutually exclusive with --release-root/--release-version"
case "$REGISTRY" in
  *' '*|*'<'*) die "--registry '$REGISTRY' is not a registry namespace";;
  */) die "--registry must not end in '/'";;
  *.*|*:*|localhost*) ;;
  *) die "--registry '$REGISTRY' has no registry host";;
esac
TAG="${TAG:-papercusp-workspace-host-$(date -u +%Y%m%d)}"
REPO="$REGISTRY/workspace-host"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi
TLS=(); [ "$INSECURE" -eq 1 ] && TLS=(--tls-verify=false)

# EI-22752400853032697 — bootc-image-builder creates host-visible loop
# partitions while it renders a disk. A desktop UDisks client can automount
# those partitions behind osbuild's back: the first root filesystem then stays
# mounted under /media, and the exporter phase fails when it mounts the copied
# filesystem with the same XFS UUID. Ubuntu/Debian ship this maintained helper
# specifically for installers; reuse it instead of open-coding a UDisks rule.
#
# The helper owns one global /run/udev rule, so serialize all callers around it.
# Without the lock, the first of two concurrent renders to exit removes the rule
# while the other is still creating loop partitions. Headless builders without
# UDisks keep the original direct Podman path.
UDISKS2_INHIBIT="${UDISKS2_INHIBIT_BIN:-}"
if [ -z "$UDISKS2_INHIBIT" ]; then
  for candidate in /usr/libexec/udisks2/udisks2-inhibit /usr/lib/udisks2/udisks2-inhibit; do
    if [ -x "$candidate" ]; then UDISKS2_INHIBIT="$candidate"; break; fi
  done
fi
UDISKS2_INHIBIT_LOCK="${PAPERCUSP_UDISKS2_INHIBIT_LOCK:-/run/lock/papercusp-bootc-bake-udisks2-inhibit.lock}"
case "$UDISKS2_INHIBIT_LOCK" in
  /*) ;;
  *) die "PAPERCUSP_UDISKS2_INHIBIT_LOCK must be an absolute path";;
esac
RENDER_PODMAN=("${PODMAN[@]}")
if [ -n "$UDISKS2_INHIBIT" ]; then
  command -v flock >/dev/null 2>&1 || die "'flock' not found; cannot serialize the UDisks inhibitor"
  if [ "$(id -u)" -eq 0 ]; then
    RENDER_PODMAN=(flock --wait 21600 "$UDISKS2_INHIBIT_LOCK" "$UDISKS2_INHIBIT" podman)
  else
    RENDER_PODMAN=(sudo -n flock --wait 21600 "$UDISKS2_INHIBIT_LOCK" "$UDISKS2_INHIBIT" podman)
  fi
  echo "BAKE_UDISKS2_INHIBIT=$UDISKS2_INHIBIT"
  echo "BAKE_UDISKS2_INHIBIT_LOCK=$UDISKS2_INHIBIT_LOCK"
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet udisks2.service 2>/dev/null; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY_RUN: WARNING udisks2 is active but udisks2-inhibit is unavailable — the real render would refuse"
  else
    die "udisks2 is active but udisks2-inhibit is unavailable; refusing an automount-racy disk render"
  fi
else
  echo "BAKE_UDISKS2_INHIBIT=not-required"
fi

# A specialised image must contain the public half of the key that signs it. Merely pointing
# policy.json at a future path produces a host that fails closed but can never upgrade, and the
# first real P-307 render proved that this path had never been populated. Resolve and validate it
# BEFORE the expensive build. The key is public; base64 is only a quoting-safe build-arg encoding.
if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$KEY" ] || die "private key not found: $KEY"
  [ -n "$PUBKEY" ] || PUBKEY="${KEY%.key}.pub"
  [ -f "$PUBKEY" ] || die "public key not found: $PUBKEY (pass --pubkey)"
  PUBKEY_B64="$(base64 -w0 < "$PUBKEY")"
  [ -n "$PUBKEY_B64" ] || die "public key is empty: $PUBKEY"
  STORAGE_DRIVER="${RELEASE_STORAGE_DRIVER:-$("${PODMAN[@]}" info --format '{{.Store.GraphDriverName}}' 2>/dev/null)}"
else
  PUBKEY_B64=""
  STORAGE_DRIVER="${RELEASE_STORAGE_DRIVER:-overlay}"
fi
case "$STORAGE_DRIVER" in
  ''|*[!A-Za-z0-9_-]*) die "could not determine a valid containers/storage graph driver";;
esac

mkdir -p "$OUT" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd)" || die "cannot resolve artifact directory"
[ -x "$BUILD_HEALTH" ] || die "build health helper is missing or not executable: $BUILD_HEALTH"

# Run one potentially long-lived rootful container operation while the companion
# detector samples its process tree and build log. The operation's own exit code
# remains authoritative: health findings are diagnostics, never an implicit
# timeout or a changed bake verdict. Keep stdout live with a separate tail while
# preserving the complete log for post-failure inspection.
run_monitored() { # $1 log path, remaining args are the command
  local log="$1" health_log="${1}.health" command_pid="" health_pid="" tail_pid="" rc
  shift
  : > "$log" || return 1
  : > "$health_log" || return 1
  "$@" >"$log" 2>&1 &
  command_pid=$!
  tail -n +1 -f "$log" &
  tail_pid=$!
  if [ "${P307_BUILD_HEALTH_DISABLE:-0}" != "1" ]; then
    bash "$BUILD_HEALTH" \
      --pid "$command_pid" \
      --log "$log" \
      --interval-sec "${P307_BUILD_HEALTH_INTERVAL_SEC:-15}" \
      --stalled-after-sec "${P307_BUILD_HEALTH_STALLED_AFTER_SEC:-120}" \
      >"$health_log" 2>&1 &
    health_pid=$!
  fi
  wait "$command_pid"
  rc=$?
  if [ -n "$tail_pid" ]; then
    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true
  fi
  if [ -n "$health_pid" ]; then
    kill "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
  fi
  if [ -s "$health_log" ]; then
    echo "P307_BUILD_HEALTH_LOG=$health_log"
    cat "$health_log"
  fi
  return "$rc"
}

# Requested clouds are validated UP FRONT, before the expensive build. A typo'd cloud name that
# is only noticed in the render loop has already paid for a build and a supply-chain pass.
IFS=',' read -r -a WANT <<< "$CLOUDS"
[ "${#WANT[@]}" -gt 0 ] || die "--clouds selected nothing"
for c in "${WANT[@]}"; do
  [ -n "${CLOUD_TYPE[$c]:-}" ] || die "unknown cloud '$c' (known: ${!CLOUD_TYPE[*]})"
done

echo "BAKE_REPO=$REPO:$TAG"
echo "BAKE_CLOUDS=${WANT[*]}"

# ── 0. Preflight the SUPPLY-CHAIN toolchain, BEFORE the expensive half ────────────────────────
# release-supply-chain.sh resolves syft/grype off PATH and documents SYFT_BIN/GRYPE_BIN as the
# override seam — but nothing propagated them, and this script drives podman against ROOT
# storage, so it is invoked under sudo. sudo's secure_path DISCARDS a per-user ~/.local/bin,
# which is exactly where syft and grype install by default. Measured on the first end-to-end
# run: build, push, registry digest resolve, cosign sign and the provenance attest ALL
# succeeded, and the chain then died on "syft not found" — the expensive half spent for a
# binary that was knowably missing at second 0. Resolve them here and refuse before building.
#
# PATH wins. A release host installs these system-wide and never reaches the sudo branch.
resolve_tool() { # $1 tool name  $2 caller-supplied override
  local name="$1" override="${2-}" p="" home=""
  if [ -n "$override" ]; then printf '%s' "$override"; return 0; fi
  p="$(command -v "$name" 2>/dev/null || true)"
  if [ -z "$p" ] && [ -n "${SUDO_USER-}" ]; then
    home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    [ -n "$home" ] && [ -x "$home/.local/bin/$name" ] && p="$home/.local/bin/$name"
  fi
  printf '%s' "$p"
}

need_tool() { # $1 name  $2 resolved path
  local name="$1" path="${2-}" upper
  upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  if [ -n "$path" ] && [ -x "$path" ]; then
    echo "BAKE_TOOL_$upper=$path"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY_RUN: WARNING '$name' not found — the real run would refuse before building"
    return 0
  fi
  die "'$name' not found. The supply-chain gate runs BEFORE the bake and needs it; install it system-wide or pass ${upper}_BIN=/path/to/$name"
}

SYFT_RESOLVED="$(resolve_tool syft "${SYFT_BIN-}")"
GRYPE_RESOLVED="$(resolve_tool grype "${GRYPE_BIN-}")"
need_tool syft  "$SYFT_RESOLVED"
need_tool grype "$GRYPE_RESOLVED"
export SYFT_BIN="$SYFT_RESOLVED" GRYPE_BIN="$GRYPE_RESOLVED"

# ── 1. Establish the image ONCE ───────────────────────────────────────────────────────────────
# The registry namespace is substituted into policy.json + registries.d INSIDE the build (layer
# 3), all-or-nothing, so an image either names the real registry in both files or fails closed
# in both. Passing it here is what makes the built image able to verify its own upgrades.
if [ -n "$SOURCE_IMAGE" ] && [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would require local source image=$SOURCE_IMAGE, retag it as $REPO:$TAG, and push it"
elif [ -n "$SOURCE_IMAGE" ]; then
  echo "### 1/4 reuse verified local image (no rebuild)"
  "${PODMAN[@]}" image exists "$SOURCE_IMAGE" \
    || { echo "BAKE_RESULT=FAILED source image absent from local storage: $SOURCE_IMAGE"; exit 1; }
  "${PODMAN[@]}" tag "$SOURCE_IMAGE" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED retag source image"; exit 1; }
  "${PODMAN[@]}" push "${TLS[@]}" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED push"; exit 1; }
elif [ "$DRY_RUN" -eq 1 ]; then
  if [ -n "$RELEASE_ROOT" ]; then
    echo "DRY_RUN: would include release root=$RELEASE_ROOT version=$RELEASE_VERSION via target=workspace-host-release"
  fi
  echo "DRY_RUN: would podman build with registry=$REGISTRY storage-driver=$STORAGE_DRIVER and the release public key -t $REPO:$TAG"
else
  echo "### 1/4 build (one image, all clouds)"
  build_args=(
    --build-arg "RELEASE_REGISTRY_NAMESPACE=$REGISTRY" \
    --build-arg "RELEASE_STORAGE_DRIVER=$STORAGE_DRIVER" \
    --build-arg "RELEASE_SIGNING_PUBKEY_B64=$PUBKEY_B64" \
    -f "$HERE/workspace-host.Containerfile" -t "$REPO:$TAG"
  )
  if [ -n "$RELEASE_ROOT" ]; then
    build_args+=(
      --target workspace-host-release
      --build-context "papercusp-release=$RELEASE_ROOT"
      --build-arg "PAPERCUSP_RELEASE_VERSION=$RELEASE_VERSION"
    )
  fi
  build_args+=("$HERE")
  run_monitored "$OUT/image-build.log" "${PODMAN[@]}" build "${build_args[@]}"
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    echo "BAKE_RESULT=FAILED build"
    exit 1
  fi
  "${PODMAN[@]}" push "${TLS[@]}" "$REPO:$TAG" \
    || { echo "BAKE_RESULT=FAILED push"; exit 1; }
fi

# ── 2. Resolve the digest from the REGISTRY, once ─────────────────────────────────────────────
# From the registry, never `podman image inspect`: a local RepoDigests value was measured
# resolving to a DIFFERENT repository's entry (D-287), and everything downstream — the signature,
# the attestation, and all three disks — is bound to whatever this returns.
if [ "$DRY_RUN" -eq 1 ]; then
  DIGEST="sha256:${DRY_RUN_DIGEST:-0000000000000000000000000000000000000000000000000000000000000000}"
  echo "DRY_RUN: would resolve $REPO:$TAG from the registry"
else
  echo "### 2/4 resolve digest from the registry"
  DIGEST="$("${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$SKOPEO_IMG" \
    inspect $([ "$INSECURE" -eq 1 ] && echo --tls-verify=false) \
    --format '{{.Digest}}' "docker://$REPO:$TAG" 2>/dev/null)"
fi
case "$DIGEST" in
  sha256:*) ;;
  *) echo "BAKE_RESULT=FAILED no registry digest for $REPO:$TAG"; exit 1;;
esac
PINNED="$REPO@$DIGEST"
echo "BAKE_DIGEST=$DIGEST"
echo "BAKE_PINNED_REF=$PINNED"

# ── 3. Supply chain BEFORE any disk is cut ────────────────────────────────────────────────────
# P-308's release-supply-chain.sh: sign -> SLSA provenance attest -> SBOM -> grype -> attest the
# SBOM -> VERIFY EVERY ARTIFACT BACK OUT OF THE REGISTRY. Until this call existed it was invoked
# by nothing, so no release was signed or attested at all.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY_RUN: would run release-supply-chain.sh --image $PINNED"
else
  echo "### 3/4 supply chain (sign, attest, SBOM, scan, verify-back)"
  sc_args=(--image "$PINNED" --key "$KEY" --pubkey "$PUBKEY" --out "$OUT/supply-chain")
  [ "$INSECURE" -eq 1 ] && sc_args+=(--insecure-registry)
  bash "$HERE/release-supply-chain.sh" "${sc_args[@]}"
  sc_rc=$?
  if [ "$sc_rc" -ne 0 ]; then
    echo "BAKE_RESULT=REFUSED supply chain exited $sc_rc — nothing was baked"
    exit 3
  fi
fi

# ── 3b. Make the PINNED DIGEST resolvable in LOCAL storage ────────────────────────────────────
# bake_one hands bootc-image-builder `--local`, which reads ONLY local container storage, while
# the digest everything is pinned to was resolved from the REGISTRY. Those two do not have to
# agree, and measured on this box they did not: after `podman push`, local storage recorded
# RepoDigest sha256:1908e66d… while the registry served sha256:bf60322b… for that same tag, so
# `podman image exists <repo>@<registry digest>` was FALSE while the tag resolved fine (probe
# positive-controlled against the tag and against the local digest, so this is a real divergence
# and not a broken lookup). bib would then fail to find an image we had just built and pushed.
#
# Pull the pinned digest BACK so local storage provably holds exactly the bytes that were
# signed, then ASSERT it — an unresolvable ref must not reach bib as a vague "image not found".
if [ "$DRY_RUN" -eq 0 ]; then
  echo "### 3b/4 materialise $PINNED into local storage"
  "${PODMAN[@]}" pull "${TLS[@]}" "$PINNED" >/dev/null 2>&1 || true
  "${PODMAN[@]}" image exists "$PINNED" || {
    echo "BAKE_RESULT=FAILED $PINNED absent from local storage; bootc-image-builder --local cannot render it"
    exit 1
  }
fi

# ── 4. Render each cloud from the SAME pinned digest ──────────────────────────────────────────
bake_one() { # $1 cloud  $2 pinned ref
  local cloud="$1" ref="$2" type="${CLOUD_TYPE[$1]}" dest="$OUT/$1"
  # The guard that makes the one-digest property real rather than intended. Every caller today
  # passes $PINNED; this refuses the future edit that "simplifies" it back to a tag.
  case "$ref" in
    *@sha256:*) ;;
    *) echo "  $cloud: REFUSED — '$ref' is not digest-pinned; a tag can move between renders"
       return 1;;
  esac
  mkdir -p "$dest"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  $cloud: DRY_RUN would render --type $type from $ref -> $dest/${CLOUD_FILE[$cloud]}"
    CLOUD_SHA[$cloud]="$(printf '0%.0s' {1..64})"
    CLOUD_BYTES[$cloud]=0
    return 0
  fi
  # Output belongs to one render. Refuse an earlier disk/archive so an exit-0
  # renderer that emits nothing cannot accidentally validate stale artifacts.
  if [ -e "$dest/${CLOUD_FILE[$cloud]}" ] || [ -e "$dest/gce/image.tar.gz" ]; then
    echo "  $cloud: REFUSED — output already contains an artifact; use a fresh --out directory"
    return 1
  fi
  # No `-it`: this runs unattended from the release pipeline and from probes, where there is no
  # TTY and `-t` fails outright.
  run_monitored "$dest/build.log" "${RENDER_PODMAN[@]}" run --rm --privileged --pull=newer \
    --security-opt label=type:unconfined_t \
    -v "$dest":/output -v /var/lib/containers/storage:/var/lib/containers/storage \
    "$BIB_IMG" --type "$type" --local "$ref"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  $cloud: FAILED (exit $rc) — see $dest/build.log"
    return 1
  fi
  # The GCE exporter writes gce/image.tar.gz with a sparse disk.raw member.
  # Normalize only that member to the raw path consumed by the publish adapter.
  if [ "$cloud" = gcp ] && [ -s "$dest/gce/image.tar.gz" ]; then
    mkdir -p "$dest/image" || return 1
    tar --extract --gzip --sparse --file "$dest/gce/image.tar.gz" \
      --directory "$dest/image" --no-same-owner --no-same-permissions -- disk.raw || {
      echo "  $cloud: FAILED — GCE archive did not yield disk.raw"
      return 1
    }
  fi
  # An exit 0 from a renderer that wrote nothing is the empty-SBOM defect in another costume:
  # a confident success whose artifact does not exist. Assert the disk before believing it.
  if [ ! -s "$dest/${CLOUD_FILE[$cloud]}" ] || [ ! -f "$dest/${CLOUD_FILE[$cloud]}" ] \
    || [ -L "$dest/${CLOUD_FILE[$cloud]}" ]; then
    echo "  $cloud: FAILED — exited 0 but produced no disk at ${CLOUD_FILE[$cloud]}"
    return 1
  fi
  CLOUD_BYTES[$cloud]="$(stat -c%s "$dest/${CLOUD_FILE[$cloud]}")"
  CLOUD_SHA[$cloud]="$(sha256sum "$dest/${CLOUD_FILE[$cloud]}" | cut -d' ' -f1)"
  echo "  $cloud: ok (${CLOUD_BYTES[$cloud]} bytes; sha256:${CLOUD_SHA[$cloud]})"
  return 0
}

echo "### 4/4 render ${#WANT[@]} cloud image(s) from $DIGEST"
failed=0; rendered=()
for c in "${WANT[@]}"; do
  if bake_one "$c" "$PINNED"; then rendered+=("$c"); else failed=1; fi
done

# The bake manifest the per-cloud PUBLISH adapters consume. It names ONE digest for every cloud,
# which is what lets a publisher verify it is registering the same bytes its siblings registered
# instead of taking that on faith.
{
  echo "{"
  echo "  \"contractVersion\": \"papercusp-bootc-bake-v1\","
  echo "  \"image\": \"$REPO\","
  echo "  \"tag\": \"$TAG\","
  echo "  \"digest\": \"$DIGEST\","
  echo "  \"pinnedRef\": \"$PINNED\","
  echo "  \"registryNamespace\": \"$REGISTRY\","
  echo "  \"dryRun\": $( [ "$DRY_RUN" -eq 1 ] && echo true || echo false ),"
  printf '  "clouds": ['
  for i in "${!rendered[@]}"; do
    [ "$i" -gt 0 ] && printf ', '
    printf '{"cloud":"%s","type":"%s","artifact":"%s","sha256":"%s","sizeBytes":%s}' \
      "${rendered[$i]}" "${CLOUD_TYPE[${rendered[$i]}]}" "$OUT/${rendered[$i]}/${CLOUD_FILE[${rendered[$i]}]}" \
      "${CLOUD_SHA[${rendered[$i]}]}" "${CLOUD_BYTES[${rendered[$i]}]}"
  done
  echo "]"
  echo "}"
} > "$OUT/bake-manifest.json"

echo "BAKE_MANIFEST=$OUT/bake-manifest.json"
echo "BAKE_RENDERED=${rendered[*]:-none}"
echo "BAKE_RESULT=$( [ $failed -eq 0 ] && echo PASS || echo FAILED )"
exit $failed
