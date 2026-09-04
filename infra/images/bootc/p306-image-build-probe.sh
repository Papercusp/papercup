#!/usr/bin/env bash
#
# P-306 — the falsifier for the product workspace-host bootc image.
#
#   sudo -n bash infra/images/bootc/p306-image-build-probe.sh
#
# Builds `workspace-host.Containerfile` and asserts the properties the port
# claims. Committed so the claim is re-runnable rather than a one-off transcript
# line, in the same spirit as `p306-signature-policy-probe.sh` (D-279) and
# `verify-rpm-equivalents.sh` (P-304).
#
# ── What it establishes, and what it deliberately does NOT ────────────────────
#
# ESTABLISHES (container-level, zero cloud spend):
#   * the image BUILDS from the verified RPM package set;
#   * `bootc container lint` adds ZERO regressions against the bare base — the
#     base's own warning count is measured in the same run as a CONTROL, so
#     "clean" is a comparison rather than an absolute nobody can check;
#   * the three identities exist with their PINNED uid/gid, and the two refused
#     group memberships are absent;
#   * the signature policy, firewall ruleset, sysusers file and both units are
#     present and enabled;
#   * the firewall ruleset PARSES, with a negative control proving the check can
#     fail (a syntax check that cannot reject anything proves nothing).
#
# DOES NOT ESTABLISH — do not read a pass here as any of these:
#   * that `/opt` survives as image content on a BOOTED host. That is the open
#     question in layer 7 of the Containerfile, it decides whether the baked
#     runtime design holds at all, and no container-level probe can answer it —
#     a container always shows the image's own view. `papercusp-host-prepare.sh`
#     asserts it at boot; P-305 owes the booted run.
#   * that ACLs apply correctly on the real image filesystem. They are applied at
#     boot, on purpose (they do not survive a container commit — WI-2143115).
#   * that a mis-signed image is refused by a booted `bootc upgrade`. D-279
#     proved the enforcement path; the booted hop remains an inference.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="quay.io/centos-bootc/centos-bootc:stream9"
TAG="papercusp/workspace-host:p306-probe"
FAILURES=0

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; FAILURES=$((FAILURES + 1)); }
sect() { echo; echo "== $* =="; }

in_image() { podman run --rm --entrypoint /bin/bash "$TAG" -c "$1" 2>/dev/null; }

echo "P306_IMAGE_BUILD_PROBE start $(date -u +%FT%TZ)"

sect "1. build"
if podman build -f "$HERE/workspace-host.Containerfile" -t "$TAG" "$HERE" >/tmp/p306-build.log 2>&1; then
  pass "image builds ($(grep -c '^STEP' /tmp/p306-build.log) steps)"
else
  fail "image build FAILED — see /tmp/p306-build.log"
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=FAIL (build)"
  exit 1
fi

sect "2. bootc container lint — against the base as a CONTROL"
# An absolute warning count is unreadable: the base ships its own. What matters is
# whether THIS image adds any, so both are measured in the same run.
base_warn=$(podman run --rm --entrypoint /usr/bin/bootc "$BASE" container lint 2>&1 \
              | sed -n 's/^Warnings: *//p' | tail -1)
ours_warn=$(podman run --rm --entrypoint /usr/bin/bootc "$TAG" container lint 2>&1 \
              | sed -n 's/^Warnings: *//p' | tail -1)
base_pass=$(podman run --rm --entrypoint /usr/bin/bootc "$BASE" container lint 2>&1 \
              | sed -n 's/^Checks passed: *//p' | tail -1)
ours_pass=$(podman run --rm --entrypoint /usr/bin/bootc "$TAG" container lint 2>&1 \
              | sed -n 's/^Checks passed: *//p' | tail -1)
if [[ -z "$base_warn" || -z "$ours_warn" ]]; then
  fail "could not read a lint verdict (base='$base_warn' ours='$ours_warn') — instrument broken, NOT a pass"
elif (( ours_warn > base_warn )); then
  fail "image adds lint warnings: base=$base_warn ours=$ours_warn"
elif (( ours_pass < base_pass )); then
  fail "image loses lint checks: base passed=$base_pass ours passed=$ours_pass"
else
  pass "no lint regression (warnings base=$base_warn ours=$ours_warn; passed base=$base_pass ours=$ours_pass)"
fi

sect "3. identities — PINNED ids, and the two refused memberships"
# The ids are a contract, not an implementation detail: /var persists across
# `bootc upgrade` while /etc/passwd comes from the image, so a renumbering
# upgrade orphans the agent's credential home. See papercusp-sysusers.conf.
while read -r who want_uid want_gid; do
  [[ -n "$who" ]] || continue
  got_uid="$(in_image "id -u $who")"
  got_gid="$(in_image "id -g $who")"
  if [[ "$got_uid" == "$want_uid" && "$got_gid" == "$want_gid" ]]; then
    pass "$who uid:gid = $got_uid:$got_gid (pinned)"
  else
    fail "$who uid:gid = '$got_uid:$got_gid', expected $want_uid:$want_gid"
  fi
done <<'IDS'
papercusp 910 910
papercusp-agent 911 911
papercusp-workspace 1500 1500
IDS
for u in papercusp-workspace papercusp-agent; do
  if [[ -z "$(in_image "id -nG $u | tr ' ' '\n' | grep -Fx papercusp")" ]]; then
    pass "$u is NOT in the runtime service group"
  else
    fail "$u IS in the runtime service group — isolation contract inverted"
  fi
done
if [[ "$(in_image 'getent passwd papercusp-workspace | cut -d: -f7')" == "/bin/bash" ]]; then
  pass "workspace user has a real shell (it is the customer's SSH login)"
else
  fail "workspace user shell is not /bin/bash"
fi

sect "4. packages — the substitutions and the SONAME providers"
# ufw and unattended-upgrades are NOT-IN-REPOS; minisign is EPEL-only. Their
# replacements are what the port claims, so assert the replacements are THERE
# rather than that the originals are absent.
for p in minisign nftables dnf-automatic zstd acl sudo openssh-server jq curl; do
  if [[ -n "$(in_image "rpm -q --qf '%{NAME}' $p 2>/dev/null | grep -Fx $p")" ]]; then
    pass "installed: $p"
  else
    fail "MISSING: $p"
  fi
done
for p in alsa-lib libatomic libgcc libstdc++ openssl-libs lz4-libs zlib libzstd; do
  if [[ -n "$(in_image "rpm -q --qf '%{NAME}' $p 2>/dev/null | grep -Fx $p")" ]]; then
    pass "SONAME provider installed: $p"
  else
    fail "MISSING SONAME provider: $p (RPM-EQUIVALENCE.md §D)"
  fi
done

sect "5. shipped files and enabled units"
for f in /etc/containers/policy.json \
         /etc/nftables/papercusp-workspace-host.nft \
         /usr/lib/sysusers.d/papercusp.conf \
         /usr/libexec/papercusp/host-prepare.sh \
         /usr/lib/systemd/system/papercusp-host-prepare.service \
         /usr/lib/papercusp/base-image; do
  if [[ "$(in_image "test -e $f && echo y")" == "y" ]]; then pass "present: $f"
  else fail "MISSING: $f"; fi
done
# P-306 half B / D-284: the attested `bootc-base-image` check compares the booted host's
# recorded base against the expected one, and a BOOTED host cannot answer that question any
# other way — `bootc status` reports the ref the host booted, never what that image derives
# from, and image LABELs need a local copy of the image to inspect. So the file is the only
# source, and it must contain the ref this Containerfile actually built FROM. Compared against
# the FROM line rather than a literal, so the two cannot drift apart silently.
want_base="$(awk '/^FROM /{print $2; exit}' "$HERE/workspace-host.Containerfile")"
got_base="$(in_image "cat /usr/lib/papercusp/base-image 2>/dev/null")"
if [[ -n "$want_base" && "$got_base" == "$want_base" ]]; then
  pass "base-image provenance records the FROM base ($got_base)"
else
  fail "base-image provenance is '$got_base' but the Containerfile builds FROM '$want_base' —"\
       "the attested bootc-base-image check would compare against the wrong base"
fi
# D-262 condition 1: the policy must be the fail-closed template, not a stub.
if [[ -n "$(in_image "grep -F '<RELEASE_REGISTRY_NAMESPACE>' /etc/containers/policy.json")" ]]; then
  pass "policy.json is the fail-closed template (placeholder namespace intact)"
else
  fail "policy.json has no <RELEASE_REGISTRY_NAMESPACE> placeholder — either already"\
       "specialized by P-307, or replaced by something that may not fail closed"
fi
if [[ -n "$(in_image "grep -E '^\s*\"default\"' -A3 /etc/containers/policy.json | grep -F 'reject'")" ]]; then
  pass "policy.json default is reject"
else
  fail "policy.json default is NOT reject — it does not fail closed"
fi
for u in papercusp-host-prepare.service nftables.service dnf-automatic.timer; do
  if [[ -n "$(in_image "systemctl is-enabled $u 2>/dev/null | grep -Fx enabled")" ]]; then
    pass "enabled: $u"
  else
    fail "NOT enabled: $u"
  fi
done
# The OS half of unattended upgrades belongs to `bootc upgrade`, not dnf: applying
# package updates in place would write to a read-only /usr and desynchronize the
# deployment from the image it claims to be.
if [[ -n "$(in_image "grep -Fx 'apply_updates = no' /etc/dnf/automatic.conf")" ]]; then
  pass "dnf-automatic is download-only (apply_updates = no)"
else
  fail "dnf-automatic would APPLY updates in place — wrong on an image-based host"
fi

sect "6. firewall ruleset parses — WITH a negative control"
# `nft --check` cannot run in the image build (no CAP_NET_ADMIN there), so it runs
# here. The negative control is the point: a checker that accepts everything would
# pass the positive case too, and prove nothing.
nftcheck() {
  podman run --rm --cap-add=NET_ADMIN -v "$1:/r.nft:ro,Z" \
    --entrypoint /usr/sbin/nft "$BASE" --check --file /r.nft >/dev/null 2>&1
}
if nftcheck "$HERE/papercusp-firewall.nft"; then
  pass "papercusp-firewall.nft parses"
else
  fail "papercusp-firewall.nft does NOT parse"
fi
BROKEN="$(mktemp /tmp/p306-broken.XXXXXX.nft)"
sed 's/policy drop;/policy bogus;/' "$HERE/papercusp-firewall.nft" > "$BROKEN"
if nftcheck "$BROKEN"; then
  fail "NEGATIVE CONTROL FAILED: a malformed ruleset was ACCEPTED — this check"\
       "cannot reject anything, so its pass above means nothing"
else
  pass "negative control: malformed ruleset is rejected"
fi
rm -f "$BROKEN"
for rule in 'policy drop' 'ct state established,related accept' 'iif lo accept' 'tcp dport 22 accept'; do
  if grep -qF "$rule" "$HERE/papercusp-firewall.nft"; then pass "rule present: $rule"
  else fail "rule MISSING: $rule"; fi
done

sect "7. host-prepare runs, and its last guard can actually fail"
# Run the real unit script in a privileged container. Everything up to
# identity-separation must pass; the firewall guard must FAIL, because a container
# has no nftables table loaded. That failure is the point — it is the paired
# negative control for the one assertion that protects an OPEN host, and a guard
# that passes here would be a rubber stamp.
#
# This stage is why the `install -d '/srv': File exists` bug was found at all:
# /srv is a symlink to machine-local /var/srv, and `install -d` will not descend a
# dangling one. Without the fix the unit died on EVERY boot.
prep_out="$(podman run --rm --privileged \
  --entrypoint /usr/libexec/papercusp/host-prepare.sh "$TAG" 2>&1)"
for stage in runtime-root-is-image-content machine-local-roots runtime-acl \
             workspace-acl identity-separation; do
  if grep -qF "$stage PASS" <<<"$prep_out"; then pass "host-prepare: $stage"
  else fail "host-prepare: $stage did NOT pass — output: $(grep -F "$stage" <<<"$prep_out" || echo '<absent>')"; fi
done
if grep -qF "FATAL firewall table" <<<"$prep_out"; then
  pass "host-prepare: firewall guard FIRED in a container (negative control)"
else
  fail "host-prepare: firewall guard did NOT fire without a loaded ruleset —"\
       "it cannot detect an unprotected host, so its pass on a real host is worthless"
fi

sect "8. the frozen P-303 spike is untouched"
# The spike artifacts booted on real GCP. The product image is written ALONGSIDE
# them; an edit to them invalidates that proof.
if grep -q "P-303 gate spike" "$HERE/Containerfile"; then
  pass "Containerfile is still the P-303 spike (not overwritten by the product image)"
else
  fail "Containerfile no longer looks like the P-303 spike — the boot proof is invalidated"
fi

echo
if (( FAILURES == 0 )); then
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=PASS"
  exit 0
else
  echo "P306_IMAGE_BUILD_PROBE PROBE_RESULT=FAIL failures=$FAILURES"
  exit 1
fi
