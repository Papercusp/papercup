#!/usr/bin/env bash
# P-308 — `cosign attest --type slsaprovenance1` bound to the image DIGEST, never a tag.
#
# The sibling probe (p308-cosign-policy-interop-probe.sh, D-287) proved cosign SIGNATURES verify
# under the containers sigstoreSigned policy. This one covers the other half of P-308's first
# clause: the SLSA provenance ATTESTATION, and specifically the item's "never a tag" rule.
#
# "Never a tag" is normally shipped as a style rule. It is not a style rule — it is a silent
# failure with a SUCCESSFUL build log, and probe E measures it:
#
#   `cosign attest <repo>:<tag>` resolves the tag to whatever digest it names AT THAT MOMENT and
#   stores the attestation under THAT digest. Re-point the tag — a rebuild, a promotion, a
#   `latest` move — and the attestation is not updated and not deleted: it is ORPHANED. The image
#   the tag now names has no provenance, while the old attestation still verifies perfectly
#   against the old digest. Nothing errors. The release you ship is unattested and the build that
#   "attested" it exited 0.
#
# The probe asserts the outcomes stay DISTINGUISHABLE, because a gate whose refusals are
# ambiguous cannot be operated even when it is correct (the D-287 lesson):
#
#   A  attested by DIGEST, correct key, --type slsaprovenance1   -> ACCEPT  (positive control)
#      + the decoded in-toto subject digest EQUALS the image digest   <- the binding itself
#      + predicateType is exactly https://slsa.dev/provenance/v1
#   B  a digest that was never attested                          -> REJECT
#   C  attested by digest, WRONG public key                      -> REJECT
#   D  attested by digest, asked for the WRONG predicate --type  -> REJECT  (type is a real
#                                                                   discriminator, so an SBOM
#                                                                   cannot pass as provenance)
#   E  THE TAG TRAP, in three measurements:
#      E1 attest BY TAG, verify by that tag                      -> ACCEPT (looks fine)
#      E2 move the tag to other content, verify by that tag      -> REJECT (ship is unattested)
#      E3 verify the ORIGINAL digest                             -> ACCEPT (orphaned, not gone)
#
# A is the positive control: without it every rejection below would "pass" against an
# attestation that never existed.
#
# Key-based with `--tlog-upload=false` / `--insecure-ignore-tlog` throughout: D-249 requires a
# key-based path because keyless cosign records signer identity in Rekor, which is wrong for
# air-gapped use. No transparency log is contacted. The registry is local; no cloud is reached
# beyond image pulls.
#
# Usage:  sudo -n bash infra/images/bootc/p308-cosign-attest-digest-probe.sh
# Exit:   0 = every probe matched expectation; 1 = a probe disagreed; 2 = setup failed.

set -u

BASE="${P308_BASE_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
COSIGN_IMG="${P308_COSIGN_IMAGE:-ghcr.io/sigstore/cosign/cosign:v2.4.1}"
REG_IMG="${P308_REGISTRY_IMAGE:-docker.io/library/registry:2}"
PORT="${P308_ATTEST_PORT:-5098}"
P="${P308_ATTEST_WORKDIR:-/tmp/p308-cosign-attest-probe}"
CTR="p308attest-reg"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

cleanup() { "${PODMAN[@]}" rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

REG="127.0.0.1:$PORT"
REPO="$REG/papercusp/workspace-host"
PRED_TYPE="https://slsa.dev/provenance/v1"
fail=0

rm -rf "$P" 2>/dev/null || "${PODMAN[@]}" unshare rm -rf "$P" 2>/dev/null || true
mkdir -p "$P/ctx-a" "$P/ctx-b" "$P/ctx-c" || { echo "SETUP FAILED: workdir"; exit 2; }

echo "### setup 1/5 — local registry on $REG"
"${PODMAN[@]}" pull -q "$REG_IMG" >/dev/null 2>&1 || { echo "SETUP FAILED: pull registry"; exit 2; }
"${PODMAN[@]}" run -d --rm --name "$CTR" -p "127.0.0.1:$PORT:5000" "$REG_IMG" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: start registry (is $PORT already held?)"; exit 2; }
for _ in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] && break
  sleep 0.5
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://$REG/v2/")" = "200" ] \
  || { echo "SETUP FAILED: registry never answered"; exit 2; }

echo "### setup 2/5 — push THREE images with different content"
# Distinct content is load-bearing twice over: byte-identical images share a digest, so the
# never-attested control (B) would silently measure the ATTESTED image, and the tag-trap (E)
# would move a tag onto the same digest it started at and measure nothing at all.
echo p308-attested-by-digest > "$P/ctx-a/hi"
echo p308-never-attested     > "$P/ctx-b/hi"
echo p308-attested-by-tag    > "$P/ctx-c/hi"
printf 'FROM scratch\nCOPY hi /hi\n' | tee "$P/ctx-a/Containerfile" "$P/ctx-b/Containerfile" > "$P/ctx-c/Containerfile"
for t in a:v1 b:v2 c:moving; do
  d="${t%%:*}"; tag="${t##*:}"
  "${PODMAN[@]}" build -q -t "$REPO:$tag" "$P/ctx-$d" >/dev/null 2>&1 || { echo "SETUP FAILED: build $tag"; exit 2; }
  "${PODMAN[@]}" push --tls-verify=false "$REPO:$tag" >/dev/null 2>&1 || { echo "SETUP FAILED: push $tag"; exit 2; }
done

# Digests come from the REGISTRY, never from `podman image inspect`. Measured 2026-09-04: the
# local RepoDigests value differed from the registry's manifest digest and resolved to another
# repository's entry; cosign then happily signed an object the registry does not hold. A digest
# read from a local store is a claim about the LOCAL STORE, not about what you are shipping.
reg_digest() {
  "${PODMAN[@]}" run --rm --network host --entrypoint skopeo "$BASE" \
    inspect --tls-verify=false --format '{{.Digest}}' "docker://$1" 2>/dev/null
}
D_A="$(reg_digest "$REPO:v1")"
D_B="$(reg_digest "$REPO:v2")"
D_C="$(reg_digest "$REPO:moving")"
echo "D_A=$D_A"; echo "D_B=$D_B"; echo "D_C=$D_C"
for v in "$D_A" "$D_B" "$D_C"; do
  case "$v" in sha256:*) ;; *) echo "SETUP FAILED: no registry digest"; exit 2;; esac
done
if [ "$D_A" = "$D_B" ] || [ "$D_A" = "$D_C" ] || [ "$D_B" = "$D_C" ]; then
  echo "SETUP FAILED: digests collide — the controls would measure the wrong image"; exit 2
fi

echo "### setup 3/5 — key-based cosign keypair (no Rekor, D-249)"
# The sigstore image runs as a NON-ROOT uid and cannot write into a root-owned bind mount. This
# chmod must precede keygen; without it cosign fails "permission denied" during SETUP, which
# exits 2, not 1 — an instrument that never ran has not measured anything.
chmod -R a+rwX "$P" 2>/dev/null || true
cosign_run() { "${PODMAN[@]}" run --rm --network host -v "$P":/work -w /work -e COSIGN_PASSWORD= "$COSIGN_IMG" "$@"; }
cosign_run generate-key-pair >/dev/null 2>&1 || { echo "SETUP FAILED: keygen"; exit 2; }
cosign_run generate-key-pair --output-key-prefix wrong >/dev/null 2>&1 || { echo "SETUP FAILED: wrong-keygen"; exit 2; }

echo "### setup 4/5 — SLSA v1 predicate"
cat > "$P/provenance.json" <<PRED
{
  "buildDefinition": {
    "buildType": "https://papercusp.dev/bootc/workspace-host/v1",
    "externalParameters": {
      "containerfile": "infra/images/bootc/workspace-host.Containerfile",
      "baseImage": "$BASE"
    },
    "internalParameters": {},
    "resolvedDependencies": [ { "uri": "$BASE" } ]
  },
  "runDetails": {
    "builder": { "id": "https://papercusp.dev/builders/p308-attest-probe" },
    "metadata": { "invocationId": "p308-attest-probe" }
  }
}
PRED
chmod -R a+rwX "$P" 2>/dev/null || true

echo "### setup 5/5 — attest BY DIGEST (probe A..D) and BY TAG (probe E)"
cosign_run attest --key cosign.key --tlog-upload=false --yes --allow-insecure-registry \
  --type slsaprovenance1 --predicate provenance.json "$REPO@$D_A" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: attest by digest"; exit 2; }
# Deliberately the WRONG way round — this is probe E's subject, not an oversight.
cosign_run attest --key cosign.key --tlog-upload=false --yes --allow-insecure-registry \
  --type slsaprovenance1 --predicate provenance.json "$REPO:moving" >/dev/null 2>&1 \
  || { echo "SETUP FAILED: attest by tag"; exit 2; }
echo "ATTEST=ok"
chmod -R a+rwX "$P" 2>/dev/null || true

# ---------------------------------------------------------------------------------------------
RC=99; OUT=""; ERRTAIL=""
verify() { # $1 keyfile  $2 type  $3 ref   -> RC, OUT (stdout DSSE), ERRTAIL (last stderr line)
  local err="$P/verify.err"
  OUT=$(cosign_run verify-attestation --key "$1" --type "$2" \
          --insecure-ignore-tlog --allow-insecure-registry "$3" 2>"$err"); RC=$?
  ERRTAIL=$(tail -3 "$err" | tr '\n' ' ' | sed 's/  */ /g')
}

# A refusal must be a REAL refusal, not any old non-zero exit. An earlier revision of the sibling
# probe pulled a repository that did not exist; skopeo died with "manifest unknown" and a bare
# `[ $RC -ne 0 ]` read that as "correctly rejected", so the run reported PASS with the control
# having measured nothing. Assert the message, never the sign of the exit code.
expect_reject() { # $1 label  $2 expected substring
  if [ "$RC" -eq 0 ]; then
    echo "$1_UNEXPECTED: FAIL-OPEN — the attestation was ACCEPTED"; fail=1; return
  fi
  case "$ERRTAIL" in
    *"$2"*) ;;
    *) echo "$1_UNEXPECTED: exit $RC but not the expected refusal — this control measured NOTHING (got: $ERRTAIL)"; fail=1;;
  esac
}

echo "=== PROBE A: attested by DIGEST, correct key, slsaprovenance1 (expect ACCEPT) ==="
verify cosign.pub slsaprovenance1 "$REPO@$D_A"; echo "A_EXIT=$RC"
if [ "$RC" -ne 0 ]; then
  echo "A_UNEXPECTED: our own attested image is refused: $ERRTAIL"; fail=1
else
  # The BINDING is the whole point of the item's "never a tag" clause, so measure it directly:
  # decode the DSSE payload and assert the in-toto subject digest IS this image's digest.
  STMT=$(printf '%s' "$OUT" | jq -r 'select(.payload) | .payload' | head -1 | base64 -d 2>/dev/null)
  GOT_TYPE=$(printf '%s' "$STMT" | jq -r '.predicateType // "MISSING"')
  GOT_SUBJ=$(printf '%s' "$STMT" | jq -r '.subject[0].digest.sha256 // "MISSING"')
  echo "A_PREDICATE_TYPE=$GOT_TYPE"
  echo "A_SUBJECT_SHA256=$GOT_SUBJ"
  [ "$GOT_TYPE" = "$PRED_TYPE" ] \
    || { echo "A_UNEXPECTED: predicateType is not $PRED_TYPE"; fail=1; }
  [ "sha256:$GOT_SUBJ" = "$D_A" ] \
    && echo "A_CONFIRMS: the attestation subject IS the image digest — bound to the artifact, not to a name" \
    || { echo "A_UNEXPECTED: subject digest != image digest ($GOT_SUBJ vs $D_A)"; fail=1; }
fi

echo "=== PROBE B: a digest that was never attested (expect REJECT) ==="
verify cosign.pub slsaprovenance1 "$REPO@$D_B"; echo "B_EXIT=$RC"; echo "B_MSG=$ERRTAIL"
expect_reject B "no matching attestations"
B_MSG="$ERRTAIL"

echo "=== PROBE C: attested by digest, WRONG public key (expect REJECT) ==="
verify wrong.pub slsaprovenance1 "$REPO@$D_A"; echo "C_EXIT=$RC"; echo "C_MSG=$ERRTAIL"
# Assert the SUFFIX, not the shared "no matching attestations" prefix. Measured 2026-09-04: a
# wrong key and a wholly absent attestation both open with that prefix, and only C carries
# "accepted signatures do not match threshold". Asserting the prefix alone would let a future
# cosign that dropped the suffix pass this control while making a crypto failure look identical
# to "nothing was ever attested" — the D-287 failure class exactly.
expect_reject C "accepted signatures do not match threshold"
C_MSG="$ERRTAIL"

echo "=== PROBE D: attested by digest, WRONG predicate --type (expect REJECT) ==="
verify cosign.pub spdxjson "$REPO@$D_A"; echo "D_EXIT=$RC"; echo "D_MSG=$ERRTAIL"
expect_reject D "none of the attestations matched the predicate type"

echo "=== PROBE E: THE TAG TRAP — why the item says DIGEST, never a tag ==="
echo "--- E1: attested BY TAG, verified by that same tag (expect ACCEPT) ---"
verify cosign.pub slsaprovenance1 "$REPO:moving"; echo "E1_EXIT=$RC"
[ "$RC" -eq 0 ] || { echo "E1_UNEXPECTED: tag attestation does not even verify before the move: $ERRTAIL"; fail=1; }

echo "--- E2: move :moving onto DIFFERENT content, verify by tag (expect REJECT) ---"
# Exactly what a rebuild or a promotion does. Nothing is deleted; the tag simply names something
# else now. cosign is not consulted and no error is produced anywhere in this step.
"${PODMAN[@]}" tag "$REPO:v2" "$REPO:moving" >/dev/null 2>&1 || { echo "SETUP FAILED: retag"; exit 2; }
"${PODMAN[@]}" push --tls-verify=false "$REPO:moving" >/dev/null 2>&1 || { echo "SETUP FAILED: repush"; exit 2; }
D_MOVED="$(reg_digest "$REPO:moving")"
echo "E2_TAG_NOW=$D_MOVED (was $D_C)"
[ "$D_MOVED" != "$D_C" ] || { echo "SETUP FAILED: the tag did not actually move"; exit 2; }
verify cosign.pub slsaprovenance1 "$REPO:moving"; echo "E2_EXIT=$RC"; echo "E2_MSG=$ERRTAIL"
expect_reject E2 "no matching attestations"
E2_MSG="$ERRTAIL"

echo "--- E3: the ORIGINAL digest still verifies (expect ACCEPT — orphaned, not deleted) ---"
verify cosign.pub slsaprovenance1 "$REPO@$D_C"; echo "E3_EXIT=$RC"
if [ "$RC" -eq 0 ]; then
  echo "E3_CONFIRMS: the tag attestation SURVIVES and verifies — against an artifact the tag no"
  echo "             longer names. Attesting a tag binds to a digest SNAPSHOT: after any tag move"
  echo "             the shipped image is unattested while the build that attested it exited 0."
else
  echo "E3_UNEXPECTED: the original digest lost its attestation ($ERRTAIL) — re-read this probe"
  echo "               before concluding anything about tag safety"; fail=1
fi

echo "=== DISTINGUISHABILITY — can an operator tell these refusals apart? ==="
# The probe's real product is not PASS/FAIL but whether the refusals can be ACTED ON. A gate whose
# failures are ambiguous cannot be operated even when it is perfectly correct.
if [ "$C_MSG" = "$B_MSG" ]; then
  echo "DISTINGUISH_C_vs_B=NO — a WRONG KEY is byte-identical to NOTHING WAS ATTESTED"; fail=1
else
  echo "DISTINGUISH_C_vs_B=yes — a crypto failure names the signature threshold; absence does not"
fi
if [ "$E2_MSG" = "$B_MSG" ]; then
  echo "DISTINGUISH_E2_vs_B=NO  <- THIS IS THE FINDING, NOT A DEFECT IN THIS PROBE."
  echo "  An image whose tag MOVED AWAY from its attestation is byte-identical to one that was"
  echo "  never attested at all. Both say 'no matching attestations'. So a tag-bound attestation"
  echo "  does not degrade loudly — at verification time the orphaned case is indistinguishable"
  echo "  from the never-signed case, and the operator is sent to debug a signer that worked."
  echo "  There is no message to improve here: bind to the DIGEST so the case cannot arise."
else
  echo "DISTINGUISH_E2_vs_B=differs — cosign gained a distinct message for an orphaned tag;"
  echo "  re-read this probe's header before relaxing the digest rule on the strength of it."
fi

echo "P308_ATTEST_PROBE PROBE_RESULT=$( [ $fail -eq 0 ] && echo PASS || echo FAIL )"
exit $fail
