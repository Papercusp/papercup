#!/usr/bin/bash
#
# P-306 — workspace-host preparation, run on EVERY boot by
# `papercusp-host-prepare.service`.
#
# This is the half of the generated bootstrap's `harden-os` phase that CANNOT
# become an image layer. Everything else moved into
# `workspace-host.Containerfile`. Two measured reasons put these lines here and
# not there, and neither is a style preference:
#
#  1. POSIX ACLs DO NOT SURVIVE A CONTAINER COMMIT (WI-2143115). A `setfacl` in a
#     Containerfile succeeds, `getfacl` in the very next RUN confirms it, and the
#     ACL is gone from the committed layer. Every surrounding signal reads
#     healthy. Since the D-043/D-248 identity separation is expressed ENTIRELY in
#     ACLs, baking them yields a host whose isolation contract is silently absent.
#
#  2. `/srv` AND `/home` ARE SYMLINKS INTO MACHINE-LOCAL `/var` on this base
#     (measured 2026-09-04 against centos-bootc:stream9: `srv -> var/srv`,
#     `home -> var/home`). Content written there in a layer is not image content
#     and does not reach a deployed host at all.
#
# ── Why EVERY boot rather than first ──────────────────────────────────────────
# `/opt` is image content. After `bootc upgrade` the host reboots into a new
# deployment, and the ACLs on `/opt/papercusp` went with the deployment that
# carried them. `/var` and `/srv` are machine-local and persist. So the ACL work
# has to re-run after every update; the directory work is idempotent and cheap.
# Making this once-only would break precisely the hosts that take an update.
#
# ── Source of truth ───────────────────────────────────────────────────────────
# Every path, mode, owner and ACL below is transcribed from the `harden-os` phase
# of `libs/generic/deployment-driver/src/workspace-host-bootstrap.ts`. When that
# changes, this changes. It is a PIN, not a derivation — the bootc host model's
# equivalent of the check-evidence map, and it drifts if nobody looks.

set -euo pipefail

SERVICE_USER=papercusp
SERVICE_GROUP=papercusp
WORKSPACE_USER=papercusp-workspace
WORKSPACE_GROUP=papercusp-workspace
AGENT_USER=papercusp-agent
AGENT_GROUP=papercusp-agent

RUNTIME_ROOT=/opt/papercusp
STATE_ROOT=/var/lib/papercusp
WORKSPACE_ROOT=/srv/papercusp/workspaces
AGENT_HOME="/home/$AGENT_USER"

# Each line is a distinct greppable assertion on the serial console, which is the
# only channel a converted cloud disk image offers before SSH is up. Same shape as
# p303-boot-proof.service, deliberately: the boot test greps for these.
say() { echo "PAPERCUSP-HOST-PREPARE: $*"; }
die() { echo "PAPERCUSP-HOST-PREPARE: FATAL $*" >&2; exit 1; }

say "start os=$(. /etc/os-release; echo "$ID-$VERSION_ID") kernel=$(uname -r)"

# ── 0. The assertion this whole file exists to make loud ──────────────────────
#
# Is the runtime root actually IMAGE content on the deployed host?
#
# `/opt` is a real directory in the image, and the base's tmpfiles dropin
# (`rpm-ostree-0-integration-opt-usrlocal.conf`) says in its own comment that it
# "implements the old model", where `/opt` is a link to `/var/opt`. Those two
# facts disagree, and no container-level probe can settle which one the DEPLOYED
# host follows — a container always shows the image's view.
#
# If the deployed host resolves `/opt` to machine-local storage, the release tree
# baked into the image is ABSENT, the host has no runtime at all, and without this
# check it would keep booting and report healthy. Fail closed and say which of the
# two models the host actually implements, because that answer is what P-305 owes
# a booted assertion for and what decides whether the baked-release design holds.
if [[ -L /opt ]]; then
  die "/opt is a SYMLINK to $(readlink -f /opt) on this deployment — the base's" \
      "'old model'. A release tree baked into the image does NOT reach this host." \
      "The bootc port's baked-runtime design does not hold here; see" \
      "infra/images/bootc/workspace-host.Containerfile layer 7."
fi
if [[ ! -d "$RUNTIME_ROOT" ]]; then
  die "$RUNTIME_ROOT is absent on the booted deployment although the image" \
      "created it — /opt did not survive as image content."
fi
say "runtime-root-is-image-content PASS ($RUNTIME_ROOT present, /opt is a real directory)"

# ── 1. Machine-local roots ────────────────────────────────────────────────────
# Baked equivalents would be discarded: /var is machine-local state on a bootc
# host and /srv + /home are symlinks into it.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$STATE_ROOT" "$STATE_ROOT/embedded-pg"
install -d -o root -g "$SERVICE_GROUP" -m 0750 /etc/papercusp
install -d -o root -g root -m 0711 /srv/papercusp
install -d -o root -g root -m 0770 "$WORKSPACE_ROOT"
install -d -o "$WORKSPACE_USER" -g "$WORKSPACE_GROUP" -m 0700 "/home/$WORKSPACE_USER"
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$AGENT_HOME"
say "machine-local-roots PASS"

# ── 2. Runtime root ownership + the agent's read ACL ──────────────────────────
# The image already created these with this owner and mode; re-asserted because a
# fresh deployment after `bootc upgrade` brings the image's copy back and the ACL
# below has to be re-applied to it regardless.
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"

# D-248: the agent identity reads the signed runtime; the SSH account does not.
# This single ACL is the entire mechanism behind `runtimeReadableByAgentUser: true`
# alongside `runtimeReadableByWorkspaceUser: false` in the attestation.
setfacl -m "u:$AGENT_USER:r-x" "$RUNTIME_ROOT" "$RUNTIME_ROOT/releases"

# Assert rather than assume: this is the exact property that a container commit
# silently drops, so on a booted host it is worth one grep to prove it took.
getfacl -p "$RUNTIME_ROOT" 2>/dev/null | grep -q "^user:$AGENT_USER:r-x" \
  || die "runtime-root ACL did not take effect (u:$AGENT_USER:r-x on $RUNTIME_ROOT)"
say "runtime-acl PASS"

# ── 3. Workspace root: the three-way shared ACL ───────────────────────────────
# Cleared first so a re-run cannot accumulate stale entries from an earlier image.
setfacl --remove-all "$WORKSPACE_ROOT"
setfacl --remove-default "$WORKSPACE_ROOT"
# Service, SSH account and agent all read/write the scoped workspace root, and the
# default ACL makes new files inherit that — which is what lets the customer edit
# over SSH what the agent wrote, with neither side chown-ing. `o::---` keeps
# everyone else out; the mask must be rwx or it clamps the named entries.
setfacl    -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"
setfacl -d -m "u:$SERVICE_USER:rwx,u:$WORKSPACE_USER:rwx,u:$AGENT_USER:rwx,m::rwx,o::---" "$WORKSPACE_ROOT"

getfacl -p "$WORKSPACE_ROOT" 2>/dev/null | grep -q "^default:user:$AGENT_USER:rwx" \
  || die "workspace-root DEFAULT ACL did not take effect; files created there" \
         "would not be shared between the SSH account and the agent identity"
say "workspace-acl PASS"

# ── 4. Negative membership, re-asserted on the booted host ────────────────────
# The image build already refuses these, but the check is cheap and the property
# is the one that decides whether platform credentials are exposed to the
# customer's SSH login. A host that somehow acquired the membership should refuse
# to present itself as healthy.
if id -nG "$WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$SERVICE_GROUP" >/dev/null; then
  die "workspace SSH user belongs to the runtime service group"
fi
say "identity-separation PASS"

say "complete"
