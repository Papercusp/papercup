#!/usr/bin/env bash
# P-307 — the shipped signature policy blocks the image's OWN installation. Which repair is
# narrowest?
#
# `bootc install to-filesystem` (which bootc-image-builder invokes) reads its source through the
# `containers-storage:` transport, but release-signature-policy.json declares rules only under
# `transports.docker`, so a containers-storage source falls through to `default: reject`:
#
#   Running image containers-storage:[...] is rejected by policy.
#
# and NO disk can ever be rendered. A `containers-storage` entry is therefore REQUIRED. The open
# question is its SCOPE, and the two candidates differ in how much of the host they open up:
#
#   (a) blanket  containers-storage: { "": [ { "type": "insecureAcceptAnything" } ] }
#       Every locally-resident image becomes installable, including one an attacker merely got
#       into local storage. Known to work.
#   (b) scoped   containers-storage: { "<RELEASE_REGISTRY_NAMESPACE>": [ ... ] }
#       Only images under OUR namespace are installable. Reuses the SAME substituted string the
#       docker: rule already takes (see p307-registries-d-scope-probe: one string serves both
#       files). Narrower — IF containers-storage honours a namespace scope at all.
#
# THE CLAIM THIS PROBE EXISTS TO FALSIFY: that (b) is actually narrower than (a) in practice, not
# just in appearance. A scoped entry that silently matched everything, or that matched nothing,
# would look exactly like a careful choice while behaving like (a) or like no fix at all.
#
# Seven arms, because a passing render alone would not settle either scope boundary:
#   A  shipped policy (docker: only)      + OUR image      => expect REJECT
#      The positive control. Without it, B "passing" could just mean the probe cannot observe a
#      rejection at all — the failure mode that made an earlier attempt at this measurement
#      worthless (both arms died on a mount-permission error BEFORE policy evaluation; it needs
#      --privileged).
#   B  scoped containers-storage entry    + OUR image      => expect ACCEPT
#      Option (b) admits what it must.
#   C  scoped containers-storage entry    + a FOREIGN image => expect REJECT
#      ⭐ The arm that carries the whole decision: it is the only one that shows (b) is genuinely
#      narrower than (a). If C ACCEPTS, the scope is decorative and (b) is (a) wearing a costume.
#   D  blanket containers-storage entry   + that same FOREIGN image => expect ACCEPT
#      Proves C's rejection is attributable to the SCOPE and not to something incidental about
#      the foreign image (unreadable layers, a storage quirk). Without D, C is unfalsifiable.
#   E  bare namespace scope                + OUR image       => expect LOAD_ERROR
#      Proves the store specifier is structural, not optional decoration.
#   F  exact osbuild storage2 graph root   + OUR image ID    => expect ACCEPT
#      Reproduces osbuild's private-store/additional-store reference shape. The repository name
#      is deliberately absent because osbuild hands bootc only a local image ID.
#   G  a different private graph root      + that same ID    => expect REJECT
#      Proves F is attributable to the exact graph root, not an accidental transport default.
#
# `transports.docker` keeps its sigstoreSigned rule UNCHANGED in every arm — that is the upgrade
# path and the whole point of D-262; this probe must not be read as relaxing it.
#
# Everything is local: no registry is contacted, no cloud, nothing billable. Images already in
# local storage are read, never written.
#
# Usage:  sudo -n bash infra/images/bootc/p307-containers-storage-scope-probe.sh
# Exit:   0 = every arm matched expectation; 1 = an arm disagreed; 2 = setup failed.

set -u

BASE="${P307_BASE_IMAGE:-quay.io/centos-bootc/centos-bootc:stream9}"
P="${P307_WORKDIR:-/tmp/p307-cs-scope-probe}"
STORAGE="${P307_STORAGE_ROOT:-/var/lib/containers/storage}"

PODMAN=(podman)
if [ "$(id -u)" -ne 0 ]; then PODMAN=(sudo -n podman); fi

rm -rf "$P"; mkdir -p "$P" || exit 2

# --- subjects -----------------------------------------------------------------------------
# OURS: an image under the release namespace. FOREIGN: any locally-resident image outside it.
# Both must ALREADY be in local storage; this probe pulls and builds nothing.
OURS="${P307_OURS_IMAGE:-}"
FOREIGN="${P307_FOREIGN_IMAGE:-}"

if [ -z "$OURS" ]; then
  OURS="$("${PODMAN[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
          | grep -E '^127\.0\.0\.1:5096/papercusp/workspace-host:[^<]' | head -1)"
fi
if [ -z "$FOREIGN" ]; then
  FOREIGN="$("${PODMAN[@]}" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
             | grep -E '^localhost/' | grep -v '/papercusp/' | head -1)"
fi

[ -n "$OURS" ]    || { echo "SETUP FAILED: no 127.0.0.1:5096/papercusp/workspace-host image in local storage"; exit 2; }
[ -n "$FOREIGN" ] || { echo "SETUP FAILED: no foreign localhost/ image in local storage"; exit 2; }

# The namespace the docker: rule is substituted with, and that (b) reuses verbatim.
NAMESPACE="${P307_NAMESPACE:-127.0.0.1:5096/papercusp}"

echo "PROBE_OURS=$OURS"
echo "PROBE_FOREIGN=$FOREIGN"
echo "PROBE_NAMESPACE=$NAMESPACE"

# --- policies -----------------------------------------------------------------------------
# The docker: block is byte-identical in all three: sigstoreSigned, keyPath, matchRepository.
docker_block() {
  cat <<EOF
    "docker": {
      "$NAMESPACE": [
        {
          "type": "sigstoreSigned",
          "keyPath": "/etc/pki/papercusp/release-signing.pub",
          "signedIdentity": { "type": "matchRepository" }
        }
      ]
    }
EOF
}

# A: shipped shape — docker: only, no containers-storage at all.
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block; echo '  }'; echo '}'; } > "$P/shipped.json"

# B/C: option (b) — containers-storage scoped to OUR namespace.
#
# ⚠ The scope is NOT the same string the docker: rule takes. containers/image's
# storageTransport.ValidatePolicyConfigurationScope REQUIRES a leading store specifier: a bare
# `127.0.0.1:5096/papercusp` is refused at LOAD time as `Unknown key`, taking the whole policy
# with it (arm E measures exactly this). Use the SHORT official driver+graph-root form:
#   [<driver>@<graphroot>]<namespace>
# It matched a live reference that also carried runroot + overlay options. The tempting longer
# form with runroot but without those live options rejected our image, as did graph-root-only;
# copying a partially observed full spec into policy is therefore less portable, not more exact.
STORAGE_DRIVER="${P307_STORAGE_DRIVER:-$("${PODMAN[@]}" info --format '{{.Store.GraphDriverName}}' 2>/dev/null)}"
case "$STORAGE_DRIVER" in
  ''|*[!A-Za-z0-9_-]*) echo "SETUP FAILED: invalid storage driver '$STORAGE_DRIVER'"; exit 2;;
esac
STORE_SPEC="${P307_STORE_SPEC:-[$STORAGE_DRIVER@/var/lib/containers/storage]}"
OSBUILD_STORE_SPEC='[overlay@/run/osbuild/containers/storage2]'
OSBUILD_WRONG_STORE_SPEC='[overlay@/run/osbuild/containers/not-storage2]'
OURS_ID="$("${PODMAN[@]}" image inspect --format '{{.Id}}' "$OURS" 2>/dev/null | sed 's/^sha256://')"
case "$OURS_ID" in
  *[!0-9a-f]*|'') echo "SETUP FAILED: invalid image ID '$OURS_ID' for $OURS"; exit 2;;
esac
if [ "${#OURS_ID}" -ne 64 ]; then
  echo "SETUP FAILED: image ID for $OURS has ${#OURS_ID} characters, expected 64"
  exit 2
fi
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block
  echo '    ,"containers-storage": {'
  echo "      \"$STORE_SPEC$NAMESPACE\": [ { \"type\": \"insecureAcceptAnything\" } ]"
  echo '    }'
  echo '  }'; echo '}'; } > "$P/scoped.json"

# E: option (b) AS ORIGINALLY CONCEIVED — reuse the docker: string verbatim, no store specifier.
# Expected to fail at policy LOAD, not at evaluation: that is the whole reason (b) is not a
# drop-in reuse of one substituted string.
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block
  echo '    ,"containers-storage": {'
  echo "      \"$NAMESPACE\": [ { \"type\": \"insecureAcceptAnything\" } ]"
  echo '    }'
  echo '  }'; echo '}'; } > "$P/bare-scope.json"

# F: the exact full-store scope containers/image derives from osbuild's full reference. The
# runroot and additionalimagestore option are intentionally absent from the POLICY key:
# PolicyConfigurationIdentity canonicalizes them away and retains driver + graph root.
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block
  echo '    ,"containers-storage": {'
  echo "      \"$OSBUILD_STORE_SPEC\": [ { \"type\": \"insecureAcceptAnything\" } ]"
  echo '    }'
  echo '  }'; echo '}'; } > "$P/osbuild-scoped.json"

# G: valid policy, wrong graph root. It must reject the identical osbuild-shaped reference.
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block
  echo '    ,"containers-storage": {'
  echo "      \"$OSBUILD_WRONG_STORE_SPEC\": [ { \"type\": \"insecureAcceptAnything\" } ]"
  echo '    }'
  echo '  }'; echo '}'; } > "$P/osbuild-wrong-root.json"

# D: option (a) — blanket containers-storage.
{ echo '{'; echo '  "default": [{ "type": "reject" }],'; echo '  "transports": {'; docker_block
  echo '    ,"containers-storage": {'
  echo '      "": [ { "type": "insecureAcceptAnything" } ]'
  echo '    }'
  echo '  }'; echo '}'; } > "$P/blanket.json"

for f in shipped scoped blanket bare-scope osbuild-scoped osbuild-wrong-root; do
  python3 -c "import json,sys; json.load(open('$P/$f.json'))" \
    || { echo "SETUP FAILED: $f.json is not valid JSON"; exit 2; }
done

# --- runner -------------------------------------------------------------------------------
# skopeo comes from the bootc base image, so this exercises the SAME containers/image version
# bootc install uses. --privileged is required: without it the storage mount fails and BOTH arms
# die before policy is ever evaluated (an earlier attempt at this measurement did exactly that
# and proved nothing).
run_arm() {
  # NB: separate `local` statements — bash makes every name in one `local` local BEFORE assigning,
  # so `log="$P/$name.log"` on the same line reads an unset `name` (and aborts under `set -u`).
  local name="$1" policy="$2" image="$3"
  local log="$P/$name.log"
  "${PODMAN[@]}" run --rm --privileged \
    -v "$P":/p:ro \
    -v "$STORAGE":/var/lib/containers/storage \
    --entrypoint skopeo "$BASE" \
    --policy "/p/$policy" copy "containers-storage:$image" "dir:/tmp/out-$name" \
    >"$log" 2>&1
  echo $?
}

# Match the reference bootc-image-builder emitted in the real failed render. The primary graph
# root is osbuild's empty private storage2 directory; the already-verified image is found by ID
# through its read-only additional store. That separation is why the earlier repository-scoped
# /var/lib rule cannot match this second handoff.
run_osbuild_arm() {
  local name="$1" policy="$2"
  local log="$P/$name.log"
  local graphroot=/run/osbuild/containers/storage2
  local runroot=/run/containers/storage
  local additional=/run/osbuild/containers/storage
  local ref="[overlay@$graphroot+$runroot:additionalimagestore=$additional]$OURS_ID"
  "${PODMAN[@]}" run --rm --privileged \
    -v "$P":/p:ro \
    -v "$STORAGE":"$additional":ro \
    --entrypoint skopeo "$BASE" \
    --policy "/p/$policy" copy "containers-storage:$ref" "dir:/tmp/out-$name" \
    >"$log" 2>&1
  echo $?
}

verdict() { # log -> ACCEPT | REJECT | LOAD_ERROR | OTHER
  # LOAD_ERROR is kept DISTINCT from REJECT on purpose: a policy that fails to parse refuses
  # every image, so folding the two together would let an unparseable policy read as a working
  # fail-closed one — the exact confusion the `_comment` defect survived four runs behind.
  local log="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then echo ACCEPT
  elif grep -qi 'Error loading trust policy' "$log"; then echo LOAD_ERROR
  elif grep -qi 'rejected by policy' "$log"; then echo REJECT
  else echo OTHER; fi
}

FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  $1: $3 (expected $2) ok"
  else echo "  $1: $3 (expected $2) MISMATCH"; FAIL=1; fi
}

echo
echo "### A  shipped policy (docker: only)      + OURS     — expect REJECT"
rc=$(run_arm A shipped.json "$OURS");    A=$(verdict "$P/A.log" "$rc"); check A REJECT "$A"
echo "### B  scoped containers-storage          + OURS     — expect ACCEPT"
rc=$(run_arm B scoped.json "$OURS");     B=$(verdict "$P/B.log" "$rc"); check B ACCEPT "$B"
echo "### C  scoped containers-storage          + FOREIGN  — expect REJECT  ⭐ decides (a) vs (b)"
rc=$(run_arm C scoped.json "$FOREIGN");  C=$(verdict "$P/C.log" "$rc"); check C REJECT "$C"
echo "### D  blanket containers-storage         + FOREIGN  — expect ACCEPT"
rc=$(run_arm D blanket.json "$FOREIGN"); D=$(verdict "$P/D.log" "$rc"); check D ACCEPT "$D"
echo "### E  BARE namespace scope (no store spec) + OURS — expect LOAD_ERROR"
rc=$(run_arm E bare-scope.json "$OURS"); E=$(verdict "$P/E.log" "$rc"); check E LOAD_ERROR "$E"
echo "### F  exact osbuild storage2 scope          + OUR ID — expect ACCEPT"
rc=$(run_osbuild_arm F osbuild-scoped.json); F=$(verdict "$P/F.log" "$rc"); check F ACCEPT "$F"
echo "### G  wrong osbuild graph root              + OUR ID — expect REJECT"
rc=$(run_osbuild_arm G osbuild-wrong-root.json); G=$(verdict "$P/G.log" "$rc"); check G REJECT "$G"

echo
echo "A_VERDICT=$A B_VERDICT=$B C_VERDICT=$C D_VERDICT=$D E_VERDICT=$E F_VERDICT=$F G_VERDICT=$G"
if [ "$B" = ACCEPT ] && [ "$C" = REJECT ] && [ "$D" = ACCEPT ]; then
  echo "SCOPED_IS_NARROWER=YES   — option (b) admits ours and refuses a foreign image the blanket admits"
else
  echo "SCOPED_IS_NARROWER=NO    — (b) is not measurably narrower than (a); do not claim it is"
fi
if [ "$E" = LOAD_ERROR ]; then
  echo "BARE_SCOPE_USABLE=NO     — the docker: string cannot be reused verbatim; a store specifier is mandatory"
else
  echo "BARE_SCOPE_USABLE=YES    — a bare namespace scope loads after all; revisit the decision"
fi
if [ "$F" = ACCEPT ] && [ "$G" = REJECT ]; then
  echo "OSBUILD_SCOPE_EXACT=YES — storage2 admits the ID handoff and a different graph root does not"
else
  echo "OSBUILD_SCOPE_EXACT=NO — the private-store exception is not proven exact; do not ship it"
fi
[ "$FAIL" -eq 0 ] && { echo "PROBE_RESULT=PASS"; exit 0; }
echo "PROBE_RESULT=FAIL"; exit 1
