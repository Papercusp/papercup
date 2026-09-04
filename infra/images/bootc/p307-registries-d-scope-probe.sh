#!/usr/bin/env bash
# P-307 — what shape must `<RELEASE_REGISTRY_NAMESPACE>` take in EACH of the two files that
# carry it, and what silently breaks when the choice is wrong?
#
# P-307 owns substituting that placeholder in BOTH:
#   infra/images/bootc/release-signature-policy.json   transports.docker.<KEY>
#   infra/images/bootc/release-registries.d.yaml       docker.<KEY>
#
# THE CARRIED CLAIM THIS PROBE WAS WRITTEN TO FALSIFY. release-registries.d.yaml's own comment
# asserts "The registry key here is a HOST[:PORT], not a repository path, so when P-307
# substitutes it, this file takes only the host part of that namespace." If that were true the
# two files would need DIFFERENT substitutions and one string pasted into both would silently
# break one. containers-registries.d(5) says otherwise — `docker` keys may be "individual
# registries ... or namespaces and individual images within these registries", the same scope
# ladder policy.json uses. Documentation is not measurement; probes A/B settle it on the real
# containers/image implementation.
#
# The man page also names two hazards that outrank the one the comment worried about, BOTH of
# which fail in D-287's indistinguishable direction ("no signature exists" = the unsigned
# string), and both of which are reachable by an ordinary, reasonable-looking substitution:
#
#   C  SHADOWING — "only the configuration for the most-precisely matching scope is used;
#      configuration using more general scopes is ignored." A host-level entry carrying
#      use-sigstore-attachments:true is IGNORED ENTIRELY once any more precise entry matches,
#      even one that says nothing about attachments. Verification then fails closed with the
#      unsigned string. Adding an unrelated per-repo setting later is enough to trip it.
#   D  PORT IS PART OF THE SCOPE — "if a registry is accessed using a hostname+port
#      configuration, the port-less hostname is not used as parent scope." A substitution that
#      drops a non-default port produces a file that matches NOTHING.
#
# A is the positive control. Without it C and D would "pass" against a config that rejects
# everything, which is the failure mode this probe's sibling (p308-cosign-policy-interop-probe)
# was itself rewritten to remove.
#
# Key-based cosign with --tlog-upload=false throughout (D-249: no Rekor, air-gapped path). The
# registry is local; no cloud is reached beyond base-image pulls. Nothing here is billable.
#
# Usage:  sudo -n bash infra/images/bootc/p307-registries-d-scope-probe.sh
# Exit:   0 = every probe matched expectation; 1 = a probe disagreed; 2 = setup failed.

set -u

BASE="${P307_BASE_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
COSIGN_IMG="${P307_COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
REG_IMG="${P307_REGISTRY_IMAGE:-docker.io/library/registry:2}"
PORT="${P307_PORT:-5097}"
P="${P307_WORKDIR:-/tmp/p307-scope-probe}"
CTR="p307probe-reg"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

cleanup() { "${PODMAN[@]}" rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

REG="127.0.0.1:$PORT"
NAMESPACE="$REG/papercusp"
REPO="$NAMESPACE/workspace-host"

rm -rf "$P" 2>/dev/null || "${PODMAN[@]}" unshare rm -rf "$P" 2>/dev/null || true
mkdir -p "$P/signed-ctx" "$P/unsigned-ctx" || { echo "SETUP FAILED: workdir"; exit 2; }

echo "### setup 1/4 — local registry on $REG"
"${PODMAN[@]}" pull -q "$REG_IMG" >/dev/null 2>&1 || { echo "SETUP FAILED: pull registry"; exit 2; }
"${PODMAN[@]}" run -d --rm --name "$CTR" -p "127.0.0.1:$PORT:5000" "$REG_IMG" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: start registry (is $PORT already held?)"; exit 2; }
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] && break
  sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] \
  || { echo "SETUP FAILED: registry never answered"; exit 2; }

echo "### setup 2/4 — push two images with DIFFERENT content"
# Different content is load-bearing: byte-identical images share a digest, so signing one would
# sign the other's too and the negative control would silently measure the SIGNED image.
echo p307-signed   > "$P/signed-ctx/hi"
echo p307-unsigned > "$P/unsigned-ctx/hi"
printf 'FROM scratch\nCOPY hi /hi\n' | tee "$P/signed-ctx/Containerfile" > "$P/unsigned-ctx/Containerfile"
"${PODMAN[@]}" build -q -t "$REPO:signed"   "$P/signed-ctx"   >/dev/null 2>&1 || { echo "SETUP FAILED: build"; exit 2; }
"${PODMAN[@]}" build -q -t "$REPO:unsigned" "$P/unsigned-ctx" >/dev/null 2>&1 || { echo "SETUP FAILED: build"; exit 2; }
"${PODMAN[@]}" push --tls-verify=false "$REPO:signed"   >/dev/null 2>&1 || { echo "SETUP FAILED: push"; exit 2; }
"${PODMAN[@]}" push --tls-verify=false "$REPO:unsigned" >/dev/null 2>&1 || { echo "SETUP FAILED: push"; exit 2; }

# Resolve digests from the REGISTRY, never from `podman image inspect` — a digest read from a
# local store is a claim about the local store (D-288's method, and the trap it was written on).
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
  || { echo "SETUP FAILED: both images share a digest — the negative control would measure the signed image"; exit 2; }

echo "### setup 3/4 — key-based cosign keypair (no Rekor, D-249)"
chmod -R a+rwX "$P" 2>/dev/null || true
cosign_run() { "${PODMAN[@]}" run --rm --network host -v "$P":/work -w /work -e COSIGN_PASSWORD= "$COSIGN_IMG" "$@"; }
cosign_run generate-key-pair >/dev/null 2>&1 || { echo "SETUP FAILED: keygen"; exit 2; }

echo "### setup 4/4 — cosign sign the REGISTRY-TRUTH digest, tlog-upload=false"
cosign_run sign --key cosign.key --tlog-upload=false --yes \
  --allow-insecure-registry "$REPO@$D_SIGNED" >/dev/null 2>&1 || { echo "SETUP FAILED: sign"; exit 2; }
echo "SIGN=ok"
chmod -R a+rwX "$P" 2>/dev/null || true

# QUOTED heredoc: the inner script crosses verbatim; values cross as ENVIRONMENT VARIABLES via
# podman -e, never by string interpolation (p308 sibling documents why).
"${PODMAN[@]}" run --rm -i --network host -v "$P":/work:z \
  -e "REPO=$REPO" -e "REG=$REG" -e "NAMESPACE=$NAMESPACE" \
  -e "D_SIGNED=$D_SIGNED" -e "D_UNSIGNED=$D_UNSIGNED" \
  --entrypoint /bin/bash "$BASE" -s <<'INNER'
set -u
: "${REPO:?}" "${REG:?}" "${NAMESPACE:?}" "${D_SIGNED:?}" "${D_UNSIGNED:?}"
fail=0
RC=99; LAST=""; MSG=""
RD=/etc/containers/registries.d

printf '[[registry]]\nlocation = "%s"\ninsecure = true\n' "$REG" >> /etc/containers/registries.conf

# The POLICY is held CONSTANT at the repository scope across every probe. Only the registries.d
# key shape varies, so any difference in outcome is attributable to that key alone.
cat > /work/pol.json <<POL
{ "default": [{"type":"reject"}],
  "transports": { "docker": {
    "$REPO": [{"type":"sigstoreSigned","keyPath":"/work/cosign.pub","signedIdentity":{"type":"matchRepository"}}]
  } } }
POL

# Write registries.d as a SINGLE file per case. containers-registries.d(5): "there can be at
# most one instance of any key under the docker section" across ALL files, so cases must
# replace the fragment rather than accumulate.
rd_reset() { rm -rf "$RD"; mkdir -p "$RD"; }
rd_key()   { # $1 = the scope key to carry use-sigstore-attachments:true
  rd_reset
  printf 'docker:\n  %s:\n    use-sigstore-attachments: true\n' "$1" \
    > "$RD/papercusp-release.yaml"
}

run() { # $1 label  $2 ref
  rm -rf "/work/out-$1"
  MSG=$(skopeo --policy /work/pol.json copy "docker://$2" "dir:/work/out-$1" 2>&1); RC=$?
  LAST=$(printf '%s' "$MSG" | tail -1 | sed 's/.*msg=//')
}

# A refusal must be a POLICY refusal, not any old non-zero exit: skopeo exits 1 on policy
# rejection and 2 when it cannot fetch the manifest at all. A control that errored has measured
# NOTHING — assert the verdict, never the sign of the exit code.
expect_reject() { # $1 label  $2 expected substring
  if [ "$RC" -eq 0 ]; then
    echo "$1_UNEXPECTED: FAIL-OPEN — the image was ACCEPTED"; fail=1; return
  fi
  case "$LAST" in
    *"$2"*) ;;
    *) echo "$1_UNEXPECTED: exit $RC but not the expected policy refusal — this control measured NOTHING (got: $LAST)"; fail=1;;
  esac
}
expect_accept() { # $1 label
  [ "$RC" -eq 0 ] || { echo "$1_UNEXPECTED: expected ACCEPT, got exit $RC: $LAST"; fail=1; }
}

echo "=== PROBE A: registries.d keyed on the FULL REPOSITORY PATH (expect ACCEPT) ==="
# The falsifier for "this file takes only the host part". Same string as the policy scope.
rd_key "$REPO"
run A "$REPO@$D_SIGNED"; echo "A_EXIT=$RC"; echo "A_MSG=$LAST"
expect_accept A
A_RC=$RC

echo "=== PROBE A2: registries.d keyed on the REPOSITORY NAMESPACE (expect ACCEPT) ==="
rd_key "$NAMESPACE"
run A2 "$REPO@$D_SIGNED"; echo "A2_EXIT=$RC"; echo "A2_MSG=$LAST"
expect_accept A2

echo "=== PROBE B: registries.d keyed on HOST:PORT only (expect ACCEPT) ==="
# The shape the file ships today. If A and B BOTH accept, the two files may carry the SAME
# string and the 'must split' claim is falsified.
rd_key "$REG"
run B "$REPO@$D_SIGNED"; echo "B_EXIT=$RC"; echo "B_MSG=$LAST"
expect_accept B
B_RC=$RC

echo "=== PROBE Bneg: UNSIGNED image, host key (expect REJECT / no signature exists) ==="
# Pins the reference string that every silent-failure case below is compared against.
run Bneg "$REPO@$D_UNSIGNED"; echo "Bneg_EXIT=$RC"; echo "Bneg_MSG=$LAST"
expect_reject Bneg "no signature exists"
UNSIGNED_MSG="$LAST"

echo "=== PROBE C: SHADOWING — host key has attachments, a MORE PRECISE repo key does not ==="
# Both keys in one file (distinct keys, so the one-instance-per-key rule is satisfied). The
# repo entry carries an unrelated setting and says NOTHING about attachments.
rd_reset
cat > "$RD/papercusp-release.yaml" <<YAML
docker:
  $REG:
    use-sigstore-attachments: true
  $REPO:
    lookaside-staging: file:///work/staging
YAML
run C "$REPO@$D_SIGNED"; echo "C_EXIT=$RC"; echo "C_MSG=$LAST"
if [ "$RC" -eq 0 ]; then
  echo "C_RESULT=no-shadowing — the host-level entry still applied; scopes MERGE here."
else
  expect_reject C "no signature exists"
  echo "C_RESULT=SHADOWED — a more precise entry silently disabled the host-level attachments."
  if [ "$LAST" = "$UNSIGNED_MSG" ]; then
    echo "C_INDISTINGUISHABLE=YES — byte-identical to the UNSIGNED refusal (Bneg)."
  else
    echo "C_INDISTINGUISHABLE=NO"
  fi
fi

echo "=== PROBE D: port-less hostname as the key, registry accessed WITH a port ==="
rd_key "${REG%%:*}"
run D "$REPO@$D_SIGNED"; echo "D_EXIT=$RC"; echo "D_MSG=$LAST"
if [ "$RC" -eq 0 ]; then
  echo "D_RESULT=port-less-host MATCHED — the port is not part of the scope here."
else
  expect_reject D "no signature exists"
  echo "D_RESULT=NO-MATCH — the port-less hostname is NOT a parent scope; the port is REQUIRED."
  if [ "$LAST" = "$UNSIGNED_MSG" ]; then
    echo "D_INDISTINGUISHABLE=YES — byte-identical to the UNSIGNED refusal (Bneg)."
  else
    echo "D_INDISTINGUISHABLE=NO"
  fi
fi

echo "=== VERDICT for P-307's substitution ==="
if [ "${A_RC:-1}" -eq 0 ] && [ "${B_RC:-1}" -eq 0 ]; then
  echo "SPLIT_REQUIRED=NO — registries.d accepted BOTH a repository path and a bare host, so the"
  echo "  two files may carry the SAME substituted string. The shipped file's comment claiming"
  echo "  'HOST[:PORT], not a repository path' is FALSE and must be corrected."
else
  echo "SPLIT_REQUIRED=YES — the two files need different shapes (A_EXIT=${A_RC:-?} B_EXIT=${B_RC:-?})."
fi

echo "PROBE_RESULT=$( [ $fail -eq 0 ] && echo PASS || echo FAIL )"
exit $fail
INNER
rc=$?
echo "### probe exit: $rc"
echo "REAL_EXIT=$rc"
