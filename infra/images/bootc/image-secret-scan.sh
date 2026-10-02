#!/usr/bin/env bash
# WI-10005624 — the SECRET-SCAN evidence class for a bootc workspace-host image.
#
# `evaluateArtifactTrust` requires five evidence classes (signature, sbom, vulnerability-scan,
# secret-scan, provenance-attestation). release-supply-chain.sh produces four of them for the
# bootc image and never produced the fifth, so no bootc release could ever be trusted. This is
# the fifth: it exports the image's root filesystem BY DIGEST and runs the same release auditor
# the server bundle ships through (papercusp-desktop/bin/audit-release-bundle.py --scan-dir),
# then writes a machine-readable record beside the log.
#
# Why the release auditor and not gitleaks: the question is "does this image carry anything that
# must never leave this machine" — this build box's identity literals, the known sensitive
# identities, and credential values. That is exactly the auditor's policy, and the server bundle
# is already gated on it. A second, differently-tuned scanner would answer a different question.
#
# Why the scan runs as THIS user over an exported copy: the auditor resolves its identity
# literals (build user, home path, hostname) from the process that runs it. Under sudo the user
# is root and the home is /root, both of which it deliberately skips — the scan would silently
# stop looking for the one identity that matters. So root only EXPORTS; the user scans.
#
# Usage:
#   image-secret-scan.sh --image <repo@sha256:…> --out <dir> [--insecure-registry]
#                        [--auditor <path>] [--min-files N] [--keep-tree]
#
# Output (in --out): secret-scan.log (the auditor's own output) and secret-scan.json:
#   { image, digest, tool: { name, version }, exitCode, verdict, coverageFiles, scannedAt }
# The assembler (apps/operator/lib/release/bootc-image-release-request-cli.ts) re-reads the log
# rather than trusting the verdict field alone.
#
# Exit: 0 clean · 1 findings · 2 usage/setup error or an unscannable image.

set -uo pipefail

IMAGE=""; OUTDIR=""; INSECURE=0; MIN_FILES=5000; KEEP_TREE=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDITOR="$HERE/../../../papercusp-desktop/bin/audit-release-bundle.py"

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2;;
    --out) OUTDIR="${2:-}"; shift 2;;
    --insecure-registry) INSECURE=1; shift;;
    --auditor) AUDITOR="${2:-}"; shift 2;;
    --min-files) MIN_FILES="${2:-}"; shift 2;;
    --keep-tree) KEEP_TREE=1; shift;;
    -h|--help) sed -n '2,30p' "$0"; exit 0;;
    *) echo "usage error: unknown argument $1" >&2; exit 2;;
  esac
done

die() { echo "FAILED: $1" >&2; echo "SECRET_SCAN_RESULT=FAIL"; exit "${2:-2}"; }

[ -n "$IMAGE" ] || die "--image is required"
[ -n "$OUTDIR" ] || die "--out is required"
# Digest, never a tag (release-supply-chain.sh D-288): a tag names whatever it names NOW, so a
# scan of a tag is evidence about some image, not about the one being released.
case "$IMAGE" in *@sha256:*) ;; *) die "--image must be digest-pinned (repo@sha256:…), got $IMAGE";; esac
DIGEST="${IMAGE#*@}"
case "$DIGEST" in sha256:[0-9a-f]*) [ "${#DIGEST}" -eq 71 ] || die "malformed digest $DIGEST";; *) die "malformed digest $DIGEST";; esac
[ -f "$AUDITOR" ] || die "release auditor not found: $AUDITOR"
case "$MIN_FILES" in ''|*[!0-9]*) die "--min-files must be a whole number";; esac
[ "$(id -u)" -ne 0 ] || die "run as the build user, not root: the auditor's identity literals come from the running user"

mkdir -p "$OUTDIR" || die "cannot create $OUTDIR"
OUTDIR="$(cd "$OUTDIR" && pwd)"
TREE="$OUTDIR/secret-scan-rootfs"
LOG="$OUTDIR/secret-scan.log"
REC="$OUTDIR/secret-scan.json"
rm -f "$LOG" "$REC"

PODMAN=(sudo -n podman)
TLS=(); [ "$INSECURE" -eq 1 ] && TLS=(--tls-verify=false)

CTR=""
cleanup() {
  [ -n "$CTR" ] && "${PODMAN[@]}" rm -f "$CTR" >/dev/null 2>&1
  [ "$KEEP_TREE" -eq 1 ] || rm -rf "$TREE"
}
trap cleanup EXIT

echo "=== create a stopped container from $IMAGE ==="
CTR="$("${PODMAN[@]}" create --pull=missing "${TLS[@]}" "$IMAGE" /bin/true 2>"$OUTDIR/secret-scan-create.err")" \
  || { sed -n '1,5p' "$OUTDIR/secret-scan-create.err" >&2; CTR=""; die "podman create"; }
# Bind the container to the digest we were asked to scan; a local-store name collision must not
# substitute a different image under the same reference.
GOT="$("${PODMAN[@]}" inspect --format '{{.ImageDigest}}' "$CTR" 2>/dev/null)"
[ "$GOT" = "$DIGEST" ] || die "container image digest $GOT is not the requested $DIGEST"

echo "=== export the root filesystem to $TREE (as $(id -un)) ==="
rm -rf "$TREE"; mkdir -p "$TREE"
# Device nodes cannot be created unprivileged and carry no content; everything else is extracted
# readable by this user (--no-same-permissions applies the umask), so mode-000 files like
# /etc/shadow are still READ rather than skipped.
"${PODMAN[@]}" export "$CTR" \
  | tar -x -C "$TREE" --no-same-owner --no-same-permissions --exclude='./dev/*' --exclude='dev/*' 2>"$OUTDIR/secret-scan-tar.err"
TAR_RC=("${PIPESTATUS[@]}")
[ "${TAR_RC[0]}" -eq 0 ] || die "podman export exited ${TAR_RC[0]}"
if [ "${TAR_RC[1]}" -ne 0 ]; then
  # tar exits 2 on per-file errors. Tolerate ONLY special-file creation failures; anything else
  # means part of the tree never reached the scan.
  if grep -v -E 'Cannot mknod|Exiting with failure status due to previous errors' "$OUTDIR/secret-scan-tar.err" | grep -q .; then
    sed -n '1,8p' "$OUTDIR/secret-scan-tar.err" >&2
    die "tar extraction failed (exit ${TAR_RC[1]})"
  fi
fi
chmod -R u+rX "$TREE" 2>/dev/null || true
FILES="$(find "$TREE" -type f | wc -l)"
echo "extracted regular files: $FILES (floor $MIN_FILES)"
[ "$FILES" -ge "$MIN_FILES" ] || die "only $FILES files extracted (floor $MIN_FILES) — the scan would measure almost nothing"

echo "=== audit-release-bundle.py --scan-dir ==="
python3 "$AUDITOR" --scan-dir "$TREE" >"$LOG" 2>&1
RC=$?
AUDITOR_SHA="$(sha256sum "$AUDITOR" | cut -d' ' -f1)"
COVERAGE="$(sed -n 's/^ *coverage: \([0-9,]*\) file(s).*/\1/p' "$LOG" | head -1 | tr -d ,)"
case "$RC" in
  0) VERDICT=clean;;
  1) VERDICT=findings;;
  *) VERDICT=unscannable;;
esac
cat >"$REC" <<JSON
{
  "image": "$IMAGE",
  "digest": "$DIGEST",
  "tool": { "name": "papercusp-audit-release-bundle.py", "version": "sha256:$AUDITOR_SHA" },
  "exitCode": $RC,
  "verdict": "$VERDICT",
  "coverageFiles": ${COVERAGE:-0},
  "extractedFiles": $FILES,
  "scannedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
tail -n 5 "$LOG"
echo "SECRET_SCAN_RECORD=$REC"
case "$RC" in
  0) echo "SECRET_SCAN_RESULT=CLEAN"; exit 0;;
  1) echo "SECRET_SCAN_RESULT=FINDINGS"; exit 1;;
  *) echo "SECRET_SCAN_RESULT=UNSCANNABLE"; exit 2;;
esac
