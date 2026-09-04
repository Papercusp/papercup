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
# D-286 added three more, which establish that the RENDER's assertion is about the right file:
#
#   PROBE D  [insecureAcceptAnything, sigstoreSigned] + unsigned -> expect REJECT (scope arrays
#            are ALL-of, so "has a sigstoreSigned entry" is a sufficient check), with a signed
#            positive control so D cannot pass against a reject-everything policy.
#   PROBE E  no --policy flag, /etc/containers/policy.json swapped -> ACCEPT then REJECT, which
#            is what proves THAT file is the one gating the pull.
#   PROBE F  a valid permissive policy at another path             -> expect REJECT (ignored).
#
# D-F are why `WORKSPACE_HOST_CONTAINERS_POLICY_PATH` is an equality check and not a
# SAFE_ABSOLUTE_PATH check: F is the failure that looks exactly like success.
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


# ── D-286: the two properties the RENDER's policy assertion rests on ──────────────────────────
# The render asserts (a) the policy at \$SIGNATURE_POLICY_PATH contains a sigstoreSigned entry for
# the release repo, and (b) attests that path. Both are green over nothing unless:
#   D  a co-present insecureAcceptAnything does NOT weaken a sigstoreSigned entry in the same
#      scope array — otherwise "at least one sigstoreSigned entry" is not a sufficient check.
#   E  the file at /etc/containers/policy.json is the one a pull actually consults.
#   F  a valid policy at ANY OTHER path is ignored — the failure that looks like success.

cat > /work/pol-mixed.json <<POL
{
  "default": [{"type": "reject"}],
  "transports": {
    "dir": {
      "": [
        {"type": "insecureAcceptAnything"},
        {
          "type": "sigstoreSigned",
          "keyPath": "/work/relkey.pub",
          "signedIdentity": {"type": "exactReference", "dockerReference": "$IDENT"}
        }
      ]
    }
  }
}
POL

echo "=== PROBE D: UNSIGNED under [insecureAcceptAnything, sigstoreSigned] (expect REJECT) ==="
skopeo --policy /work/pol-mixed.json copy dir:/work/unsigned dir:/work/out-mixed-unsigned >/dev/null 2>&1
d=\$?; echo "D_EXIT=\$d"
[ "\$d" -ne 0 ] || { echo "D_UNEXPECTED: scope-array requirements are ANY-of, not ALL-of — the render's 'has a sigstoreSigned entry' check is INSUFFICIENT and must also reject weakening entries"; fail=1; }
# Positive control for D: the same mixed policy must still ACCEPT a correctly signed image, or D
# would 'pass' against a policy that rejects everything.
skopeo --policy /work/pol-mixed.json copy dir:/work/signed dir:/work/out-mixed-signed >/dev/null 2>&1
dc=\$?; echo "D_CONTROL_SIGNED_EXIT=\$dc"
[ "\$dc" -eq 0 ] || { echo "D_CONTROL_UNEXPECTED: the mixed policy rejects even a signed image, so PROBE D measured nothing"; fail=1; }

echo "=== PROBE E: /etc/containers/policy.json is what a NO-FLAG pull consults (expect ACCEPT then REJECT) ==="
skopeo copy dir:/work/unsigned dir:/work/out-noflag-permissive >/dev/null 2>&1
e1=\$?; echo "E_PERMISSIVE_EXIT=\$e1"
cp /etc/containers/policy.json /work/orig-policy.json
printf '{"default":[{"type":"reject"}]}\n' > /etc/containers/policy.json
skopeo copy dir:/work/unsigned dir:/work/out-noflag-reject >/dev/null 2>&1
e2=\$?; echo "E_REJECT_EXIT=\$e2"
[ "\$e1" -eq 0 ] && [ "\$e2" -ne 0 ] || { echo "E_UNEXPECTED: replacing /etc/containers/policy.json did not change the verdict of an identical no-flag copy — that file is not the one gating the pull, and WORKSPACE_HOST_CONTAINERS_POLICY_PATH is wrong"; fail=1; }

echo "=== PROBE F: a VALID permissive policy at another path is IGNORED (expect REJECT) ==="
# /etc/containers/policy.json is still reject-all from E. If a correct policy elsewhere could
# rescue this copy, the render could assert a file that gates nothing and be green.
cp /work/orig-policy.json /work/elsewhere-permissive.json
skopeo copy dir:/work/unsigned dir:/work/out-elsewhere >/dev/null 2>&1
f=\$?; echo "F_EXIT=\$f"
[ "\$f" -ne 0 ] || { echo "F_UNEXPECTED: a policy outside /etc/containers/policy.json affected the pull — the path pin is not the whole story"; fail=1; }
cp /work/orig-policy.json /etc/containers/policy.json

echo "=== bootc exposes no policy override (expect 0 matches) ==="
echo "BOOTC_POLICY_FLAGS=\$(bootc upgrade --help 2>&1 | grep -ci 'policy')"

echo "PROBE_RESULT=\$( [ \$fail -eq 0 ] && echo PASS || echo FAIL )"
exit \$fail
INNER
rc=$?
echo "### probe exit: $rc"
exit $rc
