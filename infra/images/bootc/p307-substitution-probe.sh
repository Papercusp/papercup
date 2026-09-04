#!/usr/bin/env bash
# P-307 — does `<RELEASE_REGISTRY_NAMESPACE>` actually get substituted into BOTH shipped files,
# and does the build REFUSE the ways of getting it wrong?
#
# The substitution happens in workspace-host.Containerfile layer 3 and it decides whether a
# booted host can verify its own upgrades. Every way it can go wrong fails in D-287's
# indistinguishable direction — the host refuses its release with "A signature was required, but
# no signature exists", the exact message an UNSIGNED image produces — so none of these are
# visible at pull time. They have to be caught at BUILD time, which is what this probe asserts.
#
#   A  no build arg          -> BOTH files keep the placeholder; image builds. This is the
#                               fail-closed default D-262 condition 1 requires, and the state
#                               p306-image-build-probe.sh asserts. An image built before the
#                               registry is known must refuse a release, never accept an
#                               unsigned one.
#   B  a real namespace      -> substituted in BOTH files, SAME string, placeholder gone from
#                               both, and the value recorded for the booted host to report.
#   C  a bare repository name-> the BUILD FAILS. "papercusp" has no registry host, so it can
#                               match no scope; shipping it would produce an image that cannot
#                               pull its own release.
#   D  the port SURVIVES     -> measured explicitly because it is the one that looks harmless.
#                               p307-registries-d-scope-probe.sh probe D showed a port-less key
#                               matches NOTHING when the registry is reached on a port, and
#                               refuses byte-identically to an unsigned image.
#
# B is also the positive control: without it, C "passing" would be consistent with a build that
# refuses every value, which measures nothing.
#
# Usage:  sudo -n bash infra/images/bootc/p307-substitution-probe.sh
# Exit:   0 = every case matched expectation; 1 = a case disagreed; 2 = setup failed.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NS="${P307_NAMESPACE:-reg.example.com:5000/papercusp}"
LOG="${P307_BUILD_LOG:-/tmp/p307-substitution-probe.log}"
: > "$LOG"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

fail=0
pass() { echo "  PASS: $*"; }
bad()  { echo "  FAIL: $*"; fail=1; }

build() { # $1 tag  $2... extra args
  local tag="$1"; shift
  echo "=== build $tag $* ===" >> "$LOG"
  "${PODMAN[@]}" build "$@" -f "$HERE/workspace-host.Containerfile" -t "$tag" "$HERE" >>"$LOG" 2>&1
}

# Read a value OUT of the built image. Reading the repo files instead would measure the
# templates, not what the image actually carries — the whole question here is what shipped.
in_image() { "${PODMAN[@]}" run --rm --entrypoint /bin/bash "$1" -c "$2" 2>/dev/null; }

POL=/etc/containers/policy.json
RD=/etc/containers/registries.d/papercusp-release.yaml

echo "### A — no build arg: the fail-closed template must survive in BOTH files"
if build p307-subst-none; then
  a_pol="$(in_image p307-subst-none "grep -cF '<RELEASE_REGISTRY_NAMESPACE>' $POL")"
  a_rd="$(in_image p307-subst-none "grep -cF '<RELEASE_REGISTRY_NAMESPACE>' $RD")"
  [ "${a_pol:-0}" -gt 0 ] && pass "policy.json keeps the placeholder" \
    || bad "policy.json lost its placeholder — an unparameterised build must fail CLOSED"
  [ "${a_rd:-0}" -gt 0 ] && pass "registries.d keeps the placeholder" \
    || bad "registries.d lost its placeholder — the policy would be inert (D-287)"
else
  bad "the unparameterised build failed; it is the shipped default and must succeed"
fi

echo "### B — a real namespace: substituted into BOTH files, identically"
if build p307-subst-set --build-arg "RELEASE_REGISTRY_NAMESPACE=$NS"; then
  b_pol="$(in_image p307-subst-set "grep -cF '<RELEASE_REGISTRY_NAMESPACE>' $POL")"
  b_rd="$(in_image p307-subst-set "grep -cF '<RELEASE_REGISTRY_NAMESPACE>' $RD")"
  [ "${b_pol:-1}" -eq 0 ] && pass "policy.json has no placeholder left" \
    || bad "policy.json still carries the placeholder after substitution"
  [ "${b_rd:-1}" -eq 0 ] && pass "registries.d has no placeholder left" \
    || bad "registries.d still carries the placeholder — half-substituted is the worst outcome"
  # Both files must name the SAME scope. A half-substitution is invisible at runtime: the
  # policy would demand a signature the registries.d fragment never tells it to look for.
  b_pol_has="$(in_image p307-subst-set "grep -cF '$NS' $POL")"
  b_rd_has="$(in_image p307-subst-set "grep -cF '$NS' $RD")"
  if [ "${b_pol_has:-0}" -gt 0 ] && [ "${b_rd_has:-0}" -gt 0 ]; then
    pass "both files name the same scope ($NS)"
  else
    bad "the two files disagree about the release scope (policy=$b_pol_has regd=$b_rd_has)"
  fi
  b_rec="$(in_image p307-subst-set "cat /usr/lib/papercusp/release-registry-namespace 2>/dev/null")"
  [ "$b_rec" = "$NS" ] && pass "the image records its release namespace ($b_rec)" \
    || bad "recorded namespace is '$b_rec', expected '$NS'"
else
  bad "a legitimate namespace was refused — this is the positive control, nothing below counts"
fi

echo "### C — a bare repository name: the BUILD must FAIL"
if build p307-subst-bad --build-arg "RELEASE_REGISTRY_NAMESPACE=papercusp"; then
  bad "FAIL-OPEN — 'papercusp' has no registry host and was accepted anyway"
else
  # Assert the REASON, not the non-zero exit: any build error would otherwise read as the
  # guard working. This is the same rule the sibling probes apply to policy refusals.
  if grep -qF "has no registry host" "$LOG"; then
    pass "refused, and the message names the field that is wrong"
  else
    bad "the build failed for some OTHER reason — this case measured nothing (see $LOG)"
  fi
fi

echo "### D — the PORT survives substitution"
case "$NS" in
  *:[0-9]*)
    d_rd="$(in_image p307-subst-set "grep -oE '[a-z0-9.-]+:[0-9]+' $RD | head -1")"
    [ -n "$d_rd" ] && pass "registries.d kept the port ($d_rd)" \
      || bad "the port was dropped — a port-less scope matches NOTHING and refuses like unsigned"
    ;;
  *) echo "  SKIP: P307_NAMESPACE carries no port, so this case cannot be measured";;
esac

echo "PROBE_RESULT=$( [ $fail -eq 0 ] && echo PASS || echo FAIL )"
echo "REAL_EXIT=$fail"
exit $fail
