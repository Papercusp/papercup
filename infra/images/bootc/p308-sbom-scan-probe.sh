#!/usr/bin/env bash
# P-308 — syft/grype over the REAL workspace-host bootc image, and an honest accounting of what
# the supply-chain artifact actually became.
#
# ⚠ READ THIS BEFORE QUOTING ANY NUMBER THIS PROBE PRINTS.
#
# P-308's work-item says the win is "the artifact SHRINKING (scanning a thin host instead of a
# 3.6 GB node_modules tree), not the tool swap". The first half of that is measured here and the
# framing needs one correction, because the uncorrected version will be falsified by P-307:
#
#   The node_modules tree does NOT disappear. It MOVES INSIDE.
#
# Today the bootc image is host-only: `hostModel === 'bootc-image'` takes `bootcReleaseLines()`
# and the whole bundle leg — curl, sha256, `minisign -Vm`, `tar --extract` — is the ELSE branch
# (workspace-host-bootstrap.ts, the ternary at the BUNDLE_PATH block). So no release tarball is
# fetched and no npm package is on the host. But the bootc arm also asserts
# `"$RUNTIME_ROOT/current is absent from the booted image — the release layer (P-307) has not
# been baked into this image"`. P-307 bakes the release IN. When it lands, the npm dependency
# surface — and its vulnerabilities — become part of this image.
#
# So NPM_IN_IMAGE below is deliberately a TRIPWIRE, not a boast. It is 0 today. The moment P-307
# lands it becomes non-zero, this probe says so by name, and whoever is holding P-307 has to
# re-run the scan and re-state the size claim rather than inheriting a number that quietly
# stopped being true.
#
# What the change genuinely buys — and this survives P-307 — is not a smaller byte count:
#   - ONE digest-addressed artifact, instead of (VM image + out-of-band tarball + a detached
#     minisign signature) that no single hash covers.
#   - ENUMERABILITY. `minisign -Vm bundle.tgz` proves the tarball is the one that was built. It
#     says NOTHING about what is inside it. An SBOM over the image lists every package, so a CVE
#     question is answerable without unpacking and guessing.
#   - The SBOM and the SLSA attestation bind to the SAME digest the policy admits at pull time
#     (see p308-cosign-attest-digest-probe.sh), so the thing scanned is provably the thing run.
#
# Positive controls matter here more than usual: a scanner that reads NOTHING reports a clean
# result, which is indistinguishable from a clean artifact. Both legs assert a non-empty read.
#
# Usage:  bash infra/images/bootc/p308-sbom-scan-probe.sh      <- as YOUR user, NOT under sudo
# Exit:   0 = all assertions held; 1 = an assertion failed; 2 = setup failed.
#
# ⚠ Run this as yourself. It elevates only for podman. Running the WHOLE probe under `sudo`
# repoints $HOME at /root, where grype has no vulnerability DB — it would then try to fetch one
# and, offline, report zero matches. That is an ABSENT result wearing a clean one's clothes,
# which is the single failure this file is most obliged not to produce.

set -u

IMAGE="${P308_SCAN_IMAGE:-localhost/papercusp/workspace-host:p306-probe}"
OUT="${P308_SCAN_OUTDIR:-/tmp/p308-scan}"
SYFT="${SYFT_BIN:-$(command -v syft || echo "$HOME/.local/bin/syft")}"
GRYPE="${GRYPE_BIN:-$(command -v grype || echo "$HOME/.local/bin/grype")}"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi
fail=0

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  echo "SETUP FAILED: run this probe as your own user, not under sudo — grype's DB lives in the"
  echo "  invoking user's ~/.cache/grype and is unreachable as root. See the usage note above."
  exit 2
fi

[ -x "$SYFT" ]  || { echo "SETUP FAILED: syft not found (set SYFT_BIN)";  exit 2; }
[ -x "$GRYPE" ] || { echo "SETUP FAILED: grype not found (set GRYPE_BIN)"; exit 2; }
mkdir -p "$OUT" || { echo "SETUP FAILED: outdir"; exit 2; }

# grype must be asserted to HAVE a database before anything is scanned. A missing DB yields zero
# matches and exit 0 on some paths — indistinguishable from a clean image.
"$GRYPE" db status > "$OUT/grype-db.txt" 2>&1
if ! grep -qi 'Status:.*valid' "$OUT/grype-db.txt"; then
  echo "SETUP FAILED: grype has no valid vulnerability DB — a scan now would report a FALSE CLEAN"
  cat "$OUT/grype-db.txt"; exit 2
fi
echo "GRYPE_DB_BUILT=$(awk '/^Built:/{print $2}' "$OUT/grype-db.txt")"

"${PODMAN[@]}" image exists "$IMAGE" 2>/dev/null \
  || { echo "SETUP FAILED: image $IMAGE is not in the root podman store — build it with p306-image-build-probe.sh"; exit 2; }

IMG_BYTES="$("${PODMAN[@]}" image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null)"
case "$IMG_BYTES" in ''|*[!0-9]*) echo "SETUP FAILED: no image size"; exit 2;; esac
echo "IMAGE=$IMAGE"
echo "IMAGE_BYTES=$IMG_BYTES"
echo "IMAGE_GIB=$(awk -v b="$IMG_BYTES" 'BEGIN{printf "%.2f", b/1073741824}')"

echo "### 1/3 — export the image, then syft the ARCHIVE (~2 GiB; it is not fast)"
# Export rather than scanning `podman:` directly. Two reasons, both load-bearing:
#   - the image lives in the ROOT store, and this probe deliberately does not run as root;
#   - an archive is what a CI pipeline actually scans, and it pins the scan to ONE exported
#     object instead of whatever the local store resolves the name to at read time. Same lesson
#     as the digest rule in the sibling attest probe: a local store is not the artifact.
ARCHIVE="$OUT/workspace-host.oci"
rm -f "$ARCHIVE"
"${PODMAN[@]}" save --format oci-archive -o "$ARCHIVE" "$IMAGE" > "$OUT/save.log" 2>&1 \
  || { echo "SETUP FAILED: podman save"; tail -5 "$OUT/save.log"; exit 2; }
"${PODMAN[@]}" unshare chown "$(id -u):$(id -g)" "$ARCHIVE" 2>/dev/null \
  || sudo -n chown "$(id -u):$(id -g)" "$ARCHIVE" 2>/dev/null || true
[ -r "$ARCHIVE" ] || { echo "SETUP FAILED: exported archive is not readable as $(id -un)"; exit 2; }

"$SYFT" "oci-archive:$ARCHIVE" -o "syft-json=$OUT/host-sbom.json" -o "table=$OUT/host-sbom.txt" \
  > "$OUT/syft.log" 2>&1 || { echo "SETUP FAILED: syft (see $OUT/syft.log)"; tail -5 "$OUT/syft.log"; exit 2; }

[ -s "$OUT/host-sbom.json" ] || { echo "SETUP FAILED: syft wrote an EMPTY SBOM — nothing was measured"; exit 2; }

TOTAL=$(jq '.artifacts | length' "$OUT/host-sbom.json")
echo "SBOM_PACKAGES=$TOTAL"
# Positive control. A scanner that reads nothing produces a clean, confident, empty result — the
# same shape as a genuinely clean artifact. A real OS image has hundreds of packages.
if [ "$TOTAL" -lt 50 ]; then
  echo "UNEXPECTED: only $TOTAL packages — syft almost certainly did not read the image. This"
  echo "            measured NOTHING; do not read the vulnerability count below as reassurance."
  fail=1
fi

echo "--- package count by ecosystem ---"
jq -r '.artifacts | group_by(.type)[] | "\(length)\t\(.[0].type)"' "$OUT/host-sbom.json" | sort -rn

NPM_IN_IMAGE=$(jq '[.artifacts[] | select(.type=="npm")] | length' "$OUT/host-sbom.json")
echo "NPM_IN_IMAGE=$NPM_IN_IMAGE"
if [ "$NPM_IN_IMAGE" -eq 0 ]; then
  echo "NPM_TRIPWIRE=armed — the release layer is NOT in this image yet (P-307 bakes it in)."
  echo "  Today's host carries no npm dependency surface. Do NOT quote this as 'the node_modules"
  echo "  tree went away' — it has not been added yet. When P-307 lands, this count goes"
  echo "  non-zero and the size/scan claim must be re-measured and re-stated."
else
  echo "NPM_TRIPWIRE=FIRED — the image now contains $NPM_IN_IMAGE npm packages (P-307 landed)."
  echo "  ⚠ Any P-308 statement about a 'thin host' was measured BEFORE this and is now stale."
  echo "  Re-run grype below and re-state the artifact-size claim on these numbers."
fi

echo "### 2/3 — grype over that SBOM"
# Scan the SBOM, not the image again: it is the same evidence the attestation will carry, and it
# cannot silently scan a different build than the one syft enumerated.
if ! "$GRYPE" "sbom:$OUT/host-sbom.json" -o json > "$OUT/host-vulns.json" 2> "$OUT/grype.log"; then
  if grep -qiE 'no such file|db|database|download|network' "$OUT/grype.log"; then
    echo "GRYPE=unavailable — vulnerability DB could not be loaded (offline?). This is NOT a"
    echo "  clean result; it is an absent one. See $OUT/grype.log"
    tail -3 "$OUT/grype.log"
    fail=1
  else
    echo "SETUP FAILED: grype"; tail -5 "$OUT/grype.log"; exit 2
  fi
else
  MATCHES=$(jq '.matches | length' "$OUT/host-vulns.json")
  echo "GRYPE_MATCHES=$MATCHES"
  echo "--- by severity ---"
  jq -r '.matches | group_by(.vulnerability.severity)[] | "\(length)\t\(.[0].vulnerability.severity)"' \
    "$OUT/host-vulns.json" | sort -rn
  echo "GRYPE_DB_STATUS=$(jq -r '.descriptor.db.status // "unknown"' "$OUT/host-vulns.json" 2>/dev/null)"
fi

echo "### 3/3 — what the OLD model put on the host, for the comparison"
# The ubuntu-release-bundle arm curl'd a release tarball and `tar --extract`ed it onto the VM.
# There is no such bundle on this box to weigh, so this reports the checked-out release tree as
# an UPPER BOUND (it includes devDependencies, which the shipped bundle does not) and says so.
# Derived, never hardcoded: the release checkout is a SIBLING of this repo root, so resolve it
# from the script's own location. A literal home path is wrong on every machine but the one it
# was written on, and it reds the green-checkpoint identity-lint leg for the whole fleet.
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
REL="${P308_RELEASE_TREE:-$(dirname "$REPO_ROOT")/papercup-release/node_modules}"
if [ -d "$REL" ]; then
  REL_H=$(du -sh "$REL" 2>/dev/null | cut -f1)
  echo "OLD_HOST_NODE_MODULES=$REL_H  (at $REL)"
  echo "  ⚠ UPPER BOUND, not the shipped figure: this is a DEV checkout and includes"
  echo "    devDependencies. The shipped bundle is production-only. Quote it as a bound."
else
  echo "OLD_HOST_NODE_MODULES=unmeasurable here (no release tree at $REL)"
fi
echo "  Note the structural difference that does NOT depend on either number: the old host"
echo "  verified that tree with 'minisign -Vm bundle.tgz' — a whole-file hash that proves"
echo "  provenance of the TARBALL and enumerates nothing inside it. The SBOM above enumerates"
echo "  every package, and binds to the digest the pull policy admits."

echo "P308_SBOM_SCAN_PROBE PROBE_RESULT=$( [ $fail -eq 0 ] && echo PASS || echo FAIL )"
exit $fail
