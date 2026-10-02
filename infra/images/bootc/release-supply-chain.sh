#!/usr/bin/env bash
# P-308 — the release supply-chain step for the bootc workspace-host image.
#
# This is the CALLABLE step, not a probe. P-307's `bootc-image-builder` pipeline invokes it after
# it has built and pushed an image; it signs, attests and scans that image, then VERIFIES its own
# work back out of the registry before reporting success. The probes beside it
# (p308-cosign-policy-interop-probe.sh, p308-cosign-attest-digest-probe.sh, p308-sbom-scan-probe.sh)
# prove the mechanism; this is the mechanism in the pipeline.
#
# It encodes the rulings rather than restating them, so they cannot be forgotten at a call site:
#
#   D-288  DIGEST, NEVER A TAG. A tag reference is resolved to a digest FIRST, from the REGISTRY,
#          and every cosign call is passed `repo@sha256:…`. Attesting a tag binds the attestation
#          to whatever digest the tag named at that instant; the next tag move orphans it, and the
#          resulting verification failure is byte-identical to "never attested". Measured.
#   D-287  The digest comes from the REGISTRY (skopeo), never `podman image inspect` — a local
#          RepoDigests value was measured resolving to a DIFFERENT repository's entry, and cosign
#          signed an object the registry does not hold.
#   D-249  KEY-BASED, `--tlog-upload=false`. Keyless cosign records signer identity in Rekor,
#          which is wrong for air-gapped use. No transparency log is contacted.
#   D-289  Never emit a bare vulnerability count as a verdict. The gate is scoped to
#          Critical/High WITH A FIX, because that is the only population a rebase can act on.
#
# VERIFY-AFTER-WRITE is the load-bearing habit here: every signature and attestation is read back
# out of the registry by digest before this script exits 0. A cosign command exiting 0 means it
# uploaded something; it does not mean a puller can verify it. Those came apart twice during
# P-308 (a missing `use-sigstore-attachments`, and an unsatisfiable `signedIdentity`), each time
# producing a green build over an artifact no host would accept.
#
# Usage:
#   release-supply-chain.sh --image <repo[:tag|@digest]> --key <cosign.key> [options]
#
#   --image REF          image to sign/attest/scan. A tag is accepted and resolved to a digest.
#   --key PATH           cosign private key (COSIGN_PASSWORD is read from the environment).
#   --pubkey PATH        public key for verify-back (default: --key with .key -> .pub).
#   --out DIR            artifact directory (default: ./.supply-chain-out).
#   --insecure-registry  plain-HTTP / self-signed registry (local testing only).
#   --fail-on-vulns      exit non-zero when Critical/High-with-a-fix is non-empty (default: report).
#   --skip-scan          sign + attest provenance only; no SBOM, no grype.
#   --min-packages N     refuse an SBOM with fewer than N packages (default 50). This is the
#                        "the scanner read nothing" guard: an empty SBOM yields an empty CVE list,
#                        which is indistinguishable from a clean image. 50 suits a full OS image;
#                        lower it deliberately for a genuinely minimal target, never to get past
#                        a refusal you have not explained.
#
# Exit: 0 all steps succeeded AND verified back; 1 a step or its verification failed;
#       2 usage/setup error; 3 the vulnerability gate refused the image (--fail-on-vulns).

set -uo pipefail

IMAGE=""; KEY=""; PUBKEY=""; OUTDIR="./.supply-chain-out"
INSECURE=0; FAIL_ON_VULNS=0; SKIP_SCAN=0; MIN_PKGS=50

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2;;
    --key) KEY="${2:-}"; shift 2;;
    --pubkey) PUBKEY="${2:-}"; shift 2;;
    --out) OUTDIR="${2:-}"; shift 2;;
    --insecure-registry) INSECURE=1; shift;;
    --fail-on-vulns) FAIL_ON_VULNS=1; shift;;
    --skip-scan) SKIP_SCAN=1; shift;;
    --min-packages) MIN_PKGS="${2:-50}"; shift 2;;
    -h|--help) sed -n '2,45p' "$0"; exit 0;;
    *) echo "usage error: unknown argument $1" >&2; exit 2;;
  esac
done

[ -n "$IMAGE" ] || { echo "usage error: --image is required" >&2; exit 2; }
[ -n "$KEY" ]   || { echo "usage error: --key is required" >&2; exit 2; }
[ -f "$KEY" ]   || { echo "usage error: key not found: $KEY" >&2; exit 2; }
[ -n "$PUBKEY" ] || PUBKEY="${KEY%.key}.pub"
[ -f "$PUBKEY" ] || { echo "usage error: public key not found: $PUBKEY (pass --pubkey)" >&2; exit 2; }

COSIGN_IMG="${COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
SKOPEO_IMG="${SKOPEO_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
SYFT="${SYFT_BIN:-$(command -v syft || true)}"
GRYPE="${GRYPE_BIN:-$(command -v grype || true)}"

PODMAN=(podman)
[ "$(id -u)" -ne 0 ] && PODMAN=(sudo -n podman)

mkdir -p "$OUTDIR" || { echo "setup error: cannot create $OUTDIR" >&2; exit 2; }
OUTDIR="$(cd "$OUTDIR" && pwd)"
KEYDIR="$(cd "$(dirname "$KEY")" && pwd)"
KEYFILE="$(basename "$KEY")"
PUBFILE="$(basename "$PUBKEY")"

TLS_ARGS=(); COSIGN_INSECURE=()
if [ "$INSECURE" -eq 1 ]; then
  TLS_ARGS=(--tls-verify=false)
  COSIGN_INSECURE=(--allow-insecure-registry)
fi

step() { printf '\n=== %s ===\n' "$1"; }
die()  { echo "FAILED: $1" >&2; echo "SUPPLY_CHAIN_RESULT=FAIL"; exit "${2:-1}"; }

# The cosign image's default user is `nonroot` (uid 65532). A release key is rightly 0600 in a
# 0700 directory owned by whoever runs this script, so that default user cannot open it and
# signing dies with "reading key: open /keys/cosign.key: permission denied" after the whole
# image build has already been paid for (measured 2026-10-02, WI-10005606). Run cosign as the
# CALLER's uid:gid instead: it owns the key and $OUTDIR, so nothing needs loosening, and the
# files cosign writes under /out stay owned by the caller rather than by root or 65532.
# HOME points at /tmp because the caller's uid has no passwd entry in the distroless image.
COSIGN_USER="$(id -u):$(id -g)"
cosign_run() {
  "${PODMAN[@]}" run --rm --network host --user "$COSIGN_USER" -e HOME=/tmp \
    -v "$KEYDIR":/keys -v "$OUTDIR":/out -w /out \
    -e COSIGN_PASSWORD="${COSIGN_PASSWORD-}" "$COSIGN_IMG" "$@"
}

# ---------------------------------------------------------------------------------------------
step "1/6  resolve the DIGEST from the registry (D-288 / D-287)"
# A tag is a NAME. Everything downstream must be pinned to the object, so the tag is resolved
# exactly once, here, against the registry — not against the local store, which is a claim about
# the local store and was measured pointing at another repository's manifest entry.
# ⚠ A PORT'S COLON IS NOT A TAG'S COLON. The obvious `REPO="${REPO%:*}"` strips the shortest
# `:*` suffix, so on a ported registry it eats the port AND the whole path:
#   127.0.0.1:5096/papercusp/workspace-host  ->  127.0.0.1
# cosign then resolved that as a Docker Hub repo (`index.docker.io/v2/library/127.0.0.1`) and
# failed with UNAUTHORIZED — an auth error that names a registry nobody asked for, so it reads
# as a credentials problem rather than a parsing one. Measured 2026-09-04 by P-307's end-to-end
# bake, the first run to point this script at a registry with a port.
# A tag's colon is always in the LAST path segment; a port's colon is always before a `/`.
REPO="${IMAGE%@*}"
case "${REPO##*/}" in *:*) REPO="${REPO%:*}";; esac
DIGEST=""
case "$IMAGE" in
  *@sha256:*) DIGEST="${IMAGE#*@}"; echo "input was already digest-pinned";;
  *)          echo "input is a TAG — resolving to a digest before anything is signed";;
esac

if [ -z "$DIGEST" ]; then
  DIGEST="$("${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$SKOPEO_IMG" \
    inspect "${TLS_ARGS[@]}" --format '{{.Digest}}' "docker://$IMAGE" 2>"$OUTDIR/skopeo.err")"
fi
case "$DIGEST" in
  sha256:*) ;;
  *) echo "could not resolve a registry digest for $IMAGE"; sed -n '1,5p' "$OUTDIR/skopeo.err" 2>/dev/null
     die "digest resolution" 2;;
esac
REF="$REPO@$DIGEST"
echo "REPO=$REPO"
echo "DIGEST=$DIGEST"
echo "REF=$REF   <- every cosign call below uses THIS, never the tag"

# ---------------------------------------------------------------------------------------------
step "2/6  cosign sign (key-based, no transparency log — D-249)"
cosign_run sign --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" "$REF" \
  > "$OUTDIR/sign.log" 2>&1 || { tail -5 "$OUTDIR/sign.log"; die "cosign sign"; }
echo "signed $REF"

# ---------------------------------------------------------------------------------------------
step "3/6  SLSA v1 provenance predicate"
# Recorded from the build environment. `sourceCheckout` is the checkout state at build time — it
# is provenance about the BUILD, not an authorship claim; on this shared, sweep-committed tree a
# commit's author and subject say nothing reliable about a change (see the repo guide).
SRC_SHA="$(git -C "$(dirname "$0")" rev-parse HEAD 2>/dev/null || echo unknown)"
BASE_IMG="$(sed -n 's/^ARG PAPERCUSP_BASE_IMAGE=//p' "$(dirname "$0")/workspace-host.Containerfile" 2>/dev/null | head -1)"
[ -n "$BASE_IMG" ] || BASE_IMG="unknown"
cat > "$OUTDIR/provenance.json" <<PRED
{
  "buildDefinition": {
    "buildType": "https://papercusp.dev/bootc/workspace-host/v1",
    "externalParameters": {
      "containerfile": "infra/images/bootc/workspace-host.Containerfile",
      "image": "$REPO",
      "baseImage": "$BASE_IMG"
    },
    "internalParameters": { "sourceCheckout": "$SRC_SHA" },
    "resolvedDependencies": [ { "uri": "$BASE_IMG" } ]
  },
  "runDetails": {
    "builder": { "id": "https://papercusp.dev/builders/bootc-image-builder" },
    "metadata": { "invocationId": "$DIGEST", "startedOn": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
  }
}
PRED
chmod a+r "$OUTDIR/provenance.json" 2>/dev/null || true
echo "base image: $BASE_IMG"

step "4/6  cosign attest --type slsaprovenance1, bound to the DIGEST"
cosign_run attest --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" \
  --type slsaprovenance1 --predicate provenance.json "$REF" \
  > "$OUTDIR/attest-provenance.log" 2>&1 \
  || { tail -5 "$OUTDIR/attest-provenance.log"; die "cosign attest (provenance)"; }
echo "attested provenance to $REF"

# ---------------------------------------------------------------------------------------------
if [ "$SKIP_SCAN" -eq 1 ]; then
  step "5/6  SBOM + scan SKIPPED (--skip-scan)"
  SBOM_PKGS="skipped"; ACTIONABLE="skipped"
else
  [ -n "$SYFT" ] && [ -x "$SYFT" ]   || die "syft not found (set SYFT_BIN)" 2
  [ -n "$GRYPE" ] && [ -x "$GRYPE" ] || die "grype not found (set GRYPE_BIN)" 2

  step "5/6  SBOM (syft) + vulnerability scan (grype), then attest the SBOM to the same digest"
  # grype must be proven to HAVE a database first: a missing DB yields zero matches, which is
  # indistinguishable from a clean image and is the one result this step must never fabricate.
  "$GRYPE" db status > "$OUTDIR/grype-db.txt" 2>&1
  grep -qi 'Status:.*valid' "$OUTDIR/grype-db.txt" \
    || { cat "$OUTDIR/grype-db.txt"; die "grype has no valid DB — a scan now would report a FALSE CLEAN" 2; }

  # Scan the registry object by DIGEST, so the SBOM describes the artifact being signed rather
  # than whatever the local store happens to hold under that name.
  SYFT_SRC="registry:$REF"
  [ "$INSECURE" -eq 1 ] && export SYFT_REGISTRY_INSECURE_USE_HTTP=true
  "$SYFT" "$SYFT_SRC" -o "spdx-json=$OUTDIR/sbom.spdx.json" -o "syft-json=$OUTDIR/sbom.syft.json" \
    > "$OUTDIR/syft.log" 2>&1 || { tail -5 "$OUTDIR/syft.log"; die "syft"; }
  [ -s "$OUTDIR/sbom.syft.json" ] || die "syft produced an EMPTY SBOM — nothing was measured"

  SBOM_PKGS=$(jq '.artifacts | length' "$OUTDIR/sbom.syft.json")
  echo "SBOM_PACKAGES=$SBOM_PKGS"
  [ "$SBOM_PKGS" -ge "$MIN_PKGS" ] || die "only $SBOM_PKGS packages (floor $MIN_PKGS) — syft did not read the image; this measured NOTHING"

  "$GRYPE" "sbom:$OUTDIR/sbom.syft.json" -o json > "$OUTDIR/vulns.json" 2> "$OUTDIR/grype.log" \
    || { tail -5 "$OUTDIR/grype.log"; die "grype"; }

  TOTAL=$(jq '.matches | length' "$OUTDIR/vulns.json")
  # EL9 kernels are vendor-maintained RPMs. An `nvd:cpe` match against one of those RPMs
  # compares its vendor version with an upstream kernel fixed version and therefore cannot
  # establish that the vendor package is vulnerable: the fix may already be backported. Keep
  # vendor-namespace matches actionable, but exclude only this unsupported generic-CPE shape.
  # The package/type/EL9 guard prevents an unrelated artifact whose name happens to contain
  # "kernel" from silently leaving the gate population.
  GENERIC_KERNEL_CPE_EXCLUDED=$(jq '
    def generic_kernel_cpe:
      ((.artifact.name // "") | ascii_downcase | test("(^|-)kernel($|-)"))
      and ((.artifact.type // "") | ascii_downcase) == "rpm"
      and ((.artifact.version // "") | ascii_downcase | test("(^|[.-])el9([._-]|$)"))
      and ((.vulnerability.namespace // "") | ascii_downcase) == "nvd:cpe";
    [.matches[]
      | select(.vulnerability.fix.state=="fixed")
      | select(.vulnerability.severity=="Critical" or .vulnerability.severity=="High")
      | select(generic_kernel_cpe)] | length
  ' "$OUTDIR/vulns.json")
  ACTIONABLE=$(jq '
    def generic_kernel_cpe:
      ((.artifact.name // "") | ascii_downcase | test("(^|-)kernel($|-)"))
      and ((.artifact.type // "") | ascii_downcase) == "rpm"
      and ((.artifact.version // "") | ascii_downcase | test("(^|[.-])el9([._-]|$)"))
      and ((.vulnerability.namespace // "") | ascii_downcase) == "nvd:cpe";
    [.matches[]
      | select(.vulnerability.fix.state=="fixed")
      | select(.vulnerability.severity=="Critical" or .vulnerability.severity=="High")
      | select(generic_kernel_cpe | not)] | length
  ' "$OUTDIR/vulns.json")
  # ⛔ D-289: the raw total is not a verdict. Measured on the P-306 image, 4 kernel RPMs each
  # reported an IDENTICAL 5,395 matches — one kernel's CVE set counted four times under four
  # names — so ~95% of a 29,872 headline was a single component counted repeatedly. Print the
  # dominating component beside the total so the number is never quoted bare.
  echo "GRYPE_MATCHES_RAW=$TOTAL   (matches, NOT distinct vulnerabilities — do not quote bare)"
  echo "GRYPE_TOP_COMPONENT=$(jq -r '.matches | group_by(.artifact.name) | max_by(length) | "\(.[0].artifact.name)=\(length)"' "$OUTDIR/vulns.json")"
  echo "GRYPE_GENERIC_KERNEL_CPE_EXCLUDED=$GENERIC_KERNEL_CPE_EXCLUDED   (EL9 upstream CPE matches; vendor namespaces remain actionable)"
  echo "GRYPE_ACTIONABLE_CRIT_HIGH_WITH_FIX=$ACTIONABLE   <- the gate population"

  # The SBOM travels WITH the image, attested to the same digest, so a consumer can obtain it
  # without trusting a build-log artifact store.
  cp "$OUTDIR/sbom.spdx.json" "$OUTDIR/sbom-attest.json"
  chmod a+r "$OUTDIR/sbom-attest.json" 2>/dev/null || true
  cosign_run attest --key "/keys/$KEYFILE" --tlog-upload=false --yes "${COSIGN_INSECURE[@]}" \
    --type spdxjson --predicate sbom-attest.json "$REF" \
    > "$OUTDIR/attest-sbom.log" 2>&1 \
    || { tail -5 "$OUTDIR/attest-sbom.log"; die "cosign attest (sbom)"; }
  echo "attested SBOM to $REF"
fi

# ---------------------------------------------------------------------------------------------
step "6/6  VERIFY BACK from the registry — a cosign exit 0 is not a verifiable artifact"
V=0
cosign_run verify --key "/keys/$PUBFILE" --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" \
  > "$OUTDIR/verify-sig.log" 2>&1 \
  && echo "VERIFY_SIGNATURE=ok" || { echo "VERIFY_SIGNATURE=FAILED"; tail -3 "$OUTDIR/verify-sig.log"; V=1; }

cosign_run verify-attestation --key "/keys/$PUBFILE" --type slsaprovenance1 \
  --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" > "$OUTDIR/verify-prov.json" 2>"$OUTDIR/verify-prov.err" \
  && echo "VERIFY_PROVENANCE=ok" || { echo "VERIFY_PROVENANCE=FAILED"; tail -3 "$OUTDIR/verify-prov.err"; V=1; }

# The binding itself: the in-toto subject digest must BE this image's digest. This is the check
# that a tag-bound attestation silently fails (D-288), so it is asserted rather than assumed.
if [ -s "$OUTDIR/verify-prov.json" ]; then
  SUBJ=$(jq -r 'select(.payload) | .payload' "$OUTDIR/verify-prov.json" 2>/dev/null | head -1 \
         | base64 -d 2>/dev/null | jq -r '.subject[0].digest.sha256 // "MISSING"' 2>/dev/null)
  if [ "sha256:$SUBJ" = "$DIGEST" ]; then
    echo "VERIFY_SUBJECT_BINDING=ok  (in-toto subject == $DIGEST)"
  else
    echo "VERIFY_SUBJECT_BINDING=FAILED  (subject=$SUBJ expected=$DIGEST)"; V=1
  fi
fi

if [ "$SKIP_SCAN" -eq 0 ]; then
  cosign_run verify-attestation --key "/keys/$PUBFILE" --type spdxjson \
    --insecure-ignore-tlog "${COSIGN_INSECURE[@]}" "$REF" > "$OUTDIR/verify-sbom.json" 2>"$OUTDIR/verify-sbom.err" \
    && echo "VERIFY_SBOM_ATTESTATION=ok" || { echo "VERIFY_SBOM_ATTESTATION=FAILED"; tail -3 "$OUTDIR/verify-sbom.err"; V=1; }
fi

[ "$V" -eq 0 ] || die "verify-back — the artifact was published but a puller could NOT verify it"

cat > "$OUTDIR/supply-chain-summary.json" <<SUM
{
  "repository": "$REPO",
  "digest": "$DIGEST",
  "reference": "$REF",
  "signed": true,
  "provenanceAttested": true,
  "sbomAttested": $( [ "$SKIP_SCAN" -eq 0 ] && echo true || echo false ),
  "sbomPackages": "$SBOM_PKGS",
  "actionableCriticalHighWithFix": "$ACTIONABLE",
  "verifiedFromRegistry": true
}
SUM
echo; echo "artifacts in $OUTDIR (summary: supply-chain-summary.json)"

if [ "$SKIP_SCAN" -eq 0 ] && [ "$FAIL_ON_VULNS" -eq 1 ] && [ "$ACTIONABLE" -gt 0 ]; then
  echo "SUPPLY_CHAIN_RESULT=VULN_GATE_REFUSED"
  echo "  $ACTIONABLE Critical/High findings HAVE A FIX AVAILABLE. Rebase the base image."
  exit 3
fi

echo "SUPPLY_CHAIN_RESULT=PASS"
exit 0
