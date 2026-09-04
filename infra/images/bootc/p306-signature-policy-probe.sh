#!/usr/bin/env bash
# P-306 / D-262 — is a containers `sigstoreSigned` policy actually ENFORCED, and does it
# FAIL CLOSED, on the bootc base we ship?
#
# D-262 fixed the REQUIREMENT (the image must ship a signature policy) but explicitly did not
# assert the proof, recording as NOT ESTABLISHED "whether a sigstoreSigned policy against our
# registry actually passes end-to-end". This script is that proof, and it is deliberately a
# PAIRED probe with a positive control — a policy that rejects everything would "pass" a
# rejection-only test while being useless, so PROBE A must ACCEPT for PROBE B to mean anything.
#
#   PROBE A  our policy + a correctly signed image   -> expect ACCEPT (exit 0)
#   PROBE B  our policy + the SAME image unsigned    -> expect REJECT (exit non-zero)
#   PROBE C  the base's SHIPPED policy + unsigned    -> expect ACCEPT — this is D-262's trap,
#                                                       and C accepting is what proves the
#                                                       verification is OFF by default.
#
# Costs nothing and reaches no cloud: no registry, no network signing service, no cosign on the
# host. The signing and verification both run inside the bootc base image, using the skopeo it
# already carries (the same skopeo `bootc` itself shells out to — `rpm -q --requires bootc`
# lists skopeo, and the bootc binary embeds containers-image-proxy, which spawns
# `skopeo experimental-image-proxy`).
#
# Usage:  sudo -n bash infra/images/bootc/p306-signature-policy-probe.sh
# Exit:   0 = all three probes matched expectation; 1 = a probe disagreed; 2 = setup failed.

set -u

BASE="${P306_BASE_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
P="${P306_WORKDIR:-/tmp/p306-sigprobe}"
# The reference the signature is bound to. Any stable ref works for the probe; it only has to
# match the policy's signedIdentity, which is the property under test.
IDENT="${P306_SIGN_IDENTITY:-quay.io/papercusp/workspace-host:probe}"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

rm -rf "$P" || true
mkdir -p "$P/ctx" || { echo "SETUP FAILED: cannot create $P"; exit 2; }
echo "p306" > "$P/ctx/hi"
printf 'FROM scratch\nCOPY hi /hi\n' > "$P/ctx/Containerfile"

echo "### setup 1/2 — build a tiny local image (a few KB, so the copies below are instant)"
"${PODMAN[@]}" build -q -t localhost/p306-probe:v1 "$P/ctx" >/dev/null || { echo "SETUP FAILED: build"; exit 2; }

echo "### setup 2/2 — export it UNSIGNED to a dir: transport"
"${PODMAN[@]}" push --remove-signatures localhost/p306-probe:v1 dir:"$P/unsigned" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: push"; exit 2; }
chmod -R a+rX "$P"

# Everything below runs INSIDE the base image. `-i` is load-bearing: without it podman does not
# attach stdin, the heredoc is never delivered, and the container exits 0 having run NOTHING —
# a green result from an instrument that measured nothing.
"${PODMAN[@]}" run --rm -i -v "$P":/work:z --entrypoint /bin/bash "$BASE" -s <<INNER
set -u
echo "-- base:   $BASE"
echo "-- skopeo: \$(skopeo --version 2>&1)"
echo "-- bootc:  \$(bootc --version 2>&1)  (requires: \$(rpm -q --requires bootc 2>/dev/null | grep -cx skopeo) skopeo)"

cd /work
: > /work/pass.txt
skopeo generate-sigstore-key --output-prefix /work/relkey --passphrase-file /work/pass.txt >/dev/null 2>&1 \
  || { echo "SETUP FAILED: keygen"; exit 2; }
echo "KEYGEN=ok"

skopeo copy --sign-by-sigstore-private-key /work/relkey.private \
  --sign-passphrase-file /work/pass.txt --sign-identity "$IDENT" \
  dir:/work/unsigned dir:/work/signed >/dev/null 2>&1 \
  || { echo "SETUP FAILED: sign"; exit 2; }
echo "SIGN=ok (signature artifact: \$(ls /work/signed | grep -c '^signature-'))"

cat > /work/policy.json <<POL
{
  "default": [{"type": "reject"}],
  "transports": {
    "dir": {
      "": [{
        "type": "sigstoreSigned",
        "keyPath": "/work/relkey.pub",
        "signedIdentity": {"type": "exactReference", "dockerReference": "$IDENT"}
      }]
    }
  }
}
POL

fail=0

echo "=== PROBE A: SIGNED under our policy (expect ACCEPT) ==="
skopeo --policy /work/policy.json copy dir:/work/signed dir:/work/out-signed >/dev/null 2>&1
a=\$?; echo "A_EXIT=\$a"
[ "\$a" -eq 0 ] || { echo "A_UNEXPECTED: our policy rejected a correctly signed image"; fail=1; }

echo "=== PROBE B: UNSIGNED under the SAME policy (expect REJECT) ==="
bmsg=\$(skopeo --policy /work/policy.json copy dir:/work/unsigned dir:/work/out-unsigned 2>&1)
b=\$?; echo "B_EXIT=\$b"
echo "\$bmsg" | tail -1
[ "\$b" -ne 0 ] || { echo "B_UNEXPECTED: FAIL-OPEN — an unsigned image passed our policy"; fail=1; }

echo "=== PROBE C: UNSIGNED under the base's SHIPPED policy (expect ACCEPT — D-262's trap) ==="
skopeo --policy /etc/containers/policy.json copy dir:/work/unsigned dir:/work/out-default >/dev/null 2>&1
c=\$?; echo "C_EXIT=\$c"
[ "\$c" -eq 0 ] || echo "C_NOTE: the base no longer accepts unsigned by default — D-262's premise may have changed upstream; re-read /etc/containers/policy.json before relying on this file."

echo "PROBE_RESULT=\$( [ \$fail -eq 0 ] && echo PASS || echo FAIL )"
exit \$fail
INNER
rc=$?
echo "### probe exit: $rc"
exit $rc
