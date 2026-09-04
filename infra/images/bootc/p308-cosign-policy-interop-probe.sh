#!/usr/bin/env bash
# P-308 / D-287 — does a COSIGN-produced signature actually verify under the containers
# `sigstoreSigned` policy our image ships?
#
# D-279 proved the policy mechanism works using skopeo's OWN signer on the `dir:` transport.
# That is NOT the shipping path. The shipping path is: cosign signs at build time, bootc pulls
# over the `docker:` transport, and containers/image verifies. Those differ in two ways that
# each silently break verification, and BOTH were live in the artifacts P-306 shipped:
#
#   1. use-sigstore-attachments — on the docker: transport containers/image does not even LOOK
#      for a cosign signature unless the registry is listed in /etc/containers/registries.d/
#      with `use-sigstore-attachments: true`. Without it a correctly signed image is refused
#      with "A signature was required, but no signature exists" — the SAME string an unsigned
#      image produces, so the misconfiguration is indistinguishable from an unsigned artifact.
#   2. signedIdentity — `cosign sign` on a DIGEST reference records
#      critical.identity.docker-reference as the BARE REPOSITORY, and has no --sign-identity
#      flag to change it. So `matchRepoDigestOrExact` — which release-signature-policy.json
#      used to specify — REJECTS our own correctly signed image.
#
# The probe therefore asserts the four refusal/accept outcomes are DISTINGUISHABLE, because the
# whole failure class here is two different causes wearing the same error message.
#
#   A  signed + attachments on  + matchRepository        -> ACCEPT (0)
#   B  UNSIGNED (its own digest), same config            -> REJECT, "no signature exists"
#   C  signed, WRONG public key                          -> REJECT, "cryptographic ... failed"
#   D  signed, attachments NOT configured                -> REJECT, "no signature exists"  ← the trap
#   E  signed + attachments on + matchRepoDigestOrExact  -> REJECT, "identity ... not accepted"
#
# A is the positive control: without it every other probe would "pass" against a policy that
# rejects everything. D and E are the two defects this probe was written to catch.
#
# Key-based throughout, `--tlog-upload=false`: D-249 requires a key-based path because keyless
# cosign records signer identity in Rekor, which is wrong for air-gapped use. No transparency
# log is contacted.
#
# Costs nothing and reaches no cloud beyond image pulls: a throwaway local registry:2.
#
# Usage:  sudo -n bash infra/images/bootc/p308-cosign-policy-interop-probe.sh
# Exit:   0 = every probe matched expectation; 1 = a probe disagreed; 2 = setup failed.

set -u

BASE="${P308_BASE_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
COSIGN_IMG="${P308_COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
REG_IMG="${P308_REGISTRY_IMAGE:-docker.io/library/registry:2}"
PORT="${P308_PORT:-5099}"
P="${P308_WORKDIR:-/tmp/p308-cosign-probe}"
CTR="p308probe-reg"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

cleanup() { "${PODMAN[@]}" rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

REG="127.0.0.1:$PORT"
REPO="$REG/papercusp/workspace-host"

cleanup
rm -rf "$P" 2>/dev/null || "${PODMAN[@]}" unshare rm -rf "$P" 2>/dev/null || true
mkdir -p "$P/signed-ctx" "$P/unsigned-ctx" || { echo "SETUP FAILED: workdir"; exit 2; }

echo "### setup 1/4 — local registry on $REG"
"${PODMAN[@]}" pull -q "$REG_IMG" >/dev/null 2>&1 || { echo "SETUP FAILED: pull registry"; exit 2; }
"${PODMAN[@]}" run -d --rm --name "$CTR" -p "127.0.0.1:$PORT:5000" "$REG_IMG" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: start registry"; exit 2; }
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] && break
  sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] \
  || { echo "SETUP FAILED: registry never answered"; exit 2; }

echo "### setup 2/4 — push two images with DIFFERENT content"
# Different content is load-bearing: byte-identical images share a digest, so signing one would
# sign the other's digest too and the negative control would silently measure the signed image.
echo p308-signed   > "$P/signed-ctx/hi"
echo p308-unsigned > "$P/unsigned-ctx/hi"
printf 'FROM scratch\nCOPY hi /hi\n' | tee "$P/signed-ctx/Containerfile" > "$P/unsigned-ctx/Containerfile"
"${PODMAN[@]}" build -q -t "$REPO:signed"     "$P/signed-ctx"   >/dev/null 2>&1 || { echo "SETUP FAILED: build"; exit 2; }
"${PODMAN[@]}" build -q -t "$REPO:unsigned"   "$P/unsigned-ctx" >/dev/null 2>&1 || { echo "SETUP FAILED: build"; exit 2; }
"${PODMAN[@]}" push --tls-verify=false "$REPO:signed"   >/dev/null 2>&1 || { echo "SETUP FAILED: push"; exit 2; }
"${PODMAN[@]}" push --tls-verify=false "$REPO:unsigned" >/dev/null 2>&1 || { echo "SETUP FAILED: push"; exit 2; }

# Resolve digests from the REGISTRY, never from `podman image inspect`. Measured 2026-09-04:
# the local RepoDigests value differed from the registry's manifest digest (push-time manifest
# conversion) AND, because the two images were identical at the time, resolved to the OTHER
# repository's entry. cosign accepted that bogus digest and wrote a signature for an object the
# registry does not have; the later pull then failed with "manifest unknown". A digest read from
# a local store is a claim about the local store.
reg_digest() {
  "${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$BASE" \
    inspect --tls-verify=false --format '{{.Digest}}' "docker://$1" 2>/dev/null
}
D_SIGNED="$(reg_digest "$REPO:signed")"
D_UNSIGNED="$(reg_digest "$REPO:unsigned")"
echo "D_SIGNED=$D_SIGNED"
echo "D_UNSIGNED=$D_UNSIGNED"
case "$D_SIGNED" in sha256:*) ;; *) echo "SETUP FAILED: no registry digest"; exit 2;; esac
[ "$D_SIGNED" != "$D_UNSIGNED" ] \
  || { echo "SETUP FAILED: the two images share a digest — the negative control would measure the signed image"; exit 2; }

echo "### setup 3/4 — key-based cosign keypair (no Rekor, D-249)"
# The sigstore image runs as a NON-ROOT uid, so it cannot write into a root-owned bind mount.
# This chmod must precede keygen: without it cosign fails with "open cosign.key: permission
# denied" during SETUP, which exits 2 (setup failed) rather than 1 — deliberately not a probe
# verdict, because an instrument that never ran has not measured anything.
chmod -R a+rwX "$P" 2>/dev/null || true
"${PODMAN[@]}" run --rm --network host -v "$P":/work -w /work -e COSIGN_PASSWORD= \
  "$COSIGN_IMG" generate-key-pair >/dev/null 2>&1 || { echo "SETUP FAILED: keygen"; exit 2; }
# A second, unrelated key — the wrong-key control in probe C.
"${PODMAN[@]}" run --rm --network host -v "$P":/work -w /work -e COSIGN_PASSWORD= \
  "$COSIGN_IMG" generate-key-pair --output-key-prefix wrong >/dev/null 2>&1 \
  || { echo "SETUP FAILED: wrong-keygen"; exit 2; }

echo "### setup 4/4 — cosign sign the REGISTRY-TRUTH digest, tlog-upload=false"
"${PODMAN[@]}" run --rm --network host -v "$P":/work -w /work -e COSIGN_PASSWORD= \
  "$COSIGN_IMG" sign --key cosign.key --tlog-upload=false --yes \
  --allow-insecure-registry "$REPO@$D_SIGNED" >/dev/null 2>&1 || { echo "SETUP FAILED: sign"; exit 2; }
echo "SIGN=ok"

echo "$D_SIGNED"   > "$P/d_signed.txt"
echo "$D_UNSIGNED" > "$P/d_unsigned.txt"
chmod -R a+rwX "$P" 2>/dev/null || true

"${PODMAN[@]}" run --rm -i --network host -v "$P":/work:z --entrypoint /bin/bash "$BASE" -s <<INNER
set -u
REPO="$REPO"; REG="$REG"
INNER_MARKER=1
D_SIGNED=\$(cat /work/d_signed.txt); D_UNSIGNED=\$(cat /work/d_unsigned.txt)
fail=0
# Seeded so that \`set -u\` cannot turn a mis-sequenced call into an "unbound variable" read of
# a stale-looking exit code. RC=99/LAST are deliberately NOT a passing verdict: if any probe
# ever reports RC=99 it means \`run\` did not execute, which is a broken instrument, not a pass.
RC=99; LAST=""; MSG=""

printf '[[registry]]\nlocation = "%s"\ninsecure = true\n' "\$REG" >> /etc/containers/registries.conf

mkpol() { # \$1 outfile  \$2 keyPath  \$3 signedIdentity
  cat > /work/\$1 <<POL
{ "default": [{"type":"reject"}],
  "transports": { "docker": {
    "\$REPO": [{"type":"sigstoreSigned","keyPath":"\$2","signedIdentity":{"type":"\$3"}}]
  } } }
POL
}

# A refusal must be a POLICY refusal, not any old non-zero exit. skopeo exits 1 when policy
# rejects and 2 when it could not even fetch the manifest — and an earlier revision of this
# probe pulled a repository that did not exist, so its negative control died with "manifest
# unknown" (exit 2) while `[ \$RC -ne 0 ]` happily read that as "correctly rejected" and the
# whole run reported PASS. A control that errored has measured NOTHING; assert the verdict.
expect_reject() { # \$1 label  \$2 expected substring
  if [ "\$RC" -eq 0 ]; then
    echo "\$1_UNEXPECTED: FAIL-OPEN — the image was ACCEPTED"; fail=1; return
  fi
  case "\$LAST" in
    *"\$2"*) ;;
    *) echo "\$1_UNEXPECTED: exit \$RC but not the expected policy refusal — this control measured NOTHING (got: \$LAST)"; fail=1;;
  esac
}
mkpol pol-repo.json     /work/cosign.pub "matchRepository"
mkpol pol-wrongkey.json /work/wrong.pub  "matchRepository"
mkpol pol-strictid.json /work/cosign.pub "matchRepoDigestOrExact"

attach_on()  { mkdir -p /etc/containers/registries.d
               printf 'docker:\n  %s:\n    use-sigstore-attachments: true\n' "\$REG" \
                 > /etc/containers/registries.d/papercusp-release.yaml; }
attach_off() { rm -f /etc/containers/registries.d/papercusp-release.yaml; }

run() { # \$1 label  \$2 policy  \$3 ref -> echoes exit + last message
  rm -rf /work/out-\$1
  MSG=\$(skopeo --policy /work/\$2 copy "docker://\$3" dir:/work/out-\$1 2>&1); RC=\$?
  LAST=\$(echo "\$MSG" | tail -1 | sed 's/.*msg=//')
}

attach_on
echo "=== PROBE A: cosign-signed, attachments ON, matchRepository (expect ACCEPT) ==="
run A pol-repo.json "\$REPO@\$D_SIGNED"; echo "A_EXIT=\$RC"
[ "\$RC" -eq 0 ] || { echo "A_UNEXPECTED: our own signed image is refused: \$LAST"; fail=1; }

echo "=== PROBE B: UNSIGNED, same config (expect REJECT / no signature exists) ==="
# Same REPOSITORY, different DIGEST — the policy scope above is keyed to \$REPO, so a separate
# repository would not be covered by it at all and would fail for the wrong reason.
run B pol-repo.json "\$REPO@\$D_UNSIGNED"; echo "B_EXIT=\$RC"; echo "B_MSG=\$LAST"
expect_reject B "no signature exists"

echo "=== PROBE C: signed but WRONG public key (expect REJECT / cryptographic failure) ==="
run C pol-wrongkey.json "\$REPO@\$D_SIGNED"; echo "C_EXIT=\$RC"; echo "C_MSG=\$LAST"
expect_reject C "cryptographic signature verification failed"

echo "=== PROBE D: signed, but use-sigstore-attachments NOT configured (expect REJECT) ==="
attach_off
run D pol-repo.json "\$REPO@\$D_SIGNED"; echo "D_EXIT=\$RC"; echo "D_MSG=\$LAST"
attach_on
expect_reject D "no signature exists"
[ "\$RC" -ne 0 ] && echo "D_CONFIRMS: the misconfiguration is INDISTINGUISHABLE from an unsigned image (same string as B)"

echo "=== PROBE E: matchRepoDigestOrExact against a cosign signature (expect REJECT) ==="
run E pol-strictid.json "\$REPO@\$D_SIGNED"; echo "E_EXIT=\$RC"; echo "E_MSG=\$LAST"
if [ "\$RC" -eq 0 ]; then
  echo "E_NOTE: matchRepoDigestOrExact now ACCEPTS — cosign may have gained a way to record a full"
  echo "        repo@digest identity. Re-read D-287 before tightening release-signature-policy.json."
else
  expect_reject E "is not accepted"
  echo "E_CONFIRMS: signedIdentity must stay matchRepository (D-287)"
fi

echo "PROBE_RESULT=\$( [ \$fail -eq 0 ] && echo PASS || echo FAIL )"
exit \$fail
INNER
rc=$?
echo "### probe exit: $rc"
exit $rc
