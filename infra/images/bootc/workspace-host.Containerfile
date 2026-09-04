# P-306 — the PRODUCT workspace-host bootc image (OS layer).
#
# This is the port. It replaces the `harden-os` phase of the generated bootstrap
# (`libs/generic/deployment-driver/src/workspace-host-bootstrap.ts`) — the
# `apt-get update` + `apt-get install` + `useradd` + `ufw` + `unattended-upgrades`
# sequence — with image layers.
#
# ⛔ NOT the P-303 spike. `Containerfile` in this directory is the frozen gate-spike
#    artifact that booted on real GCP; it is byte-identical to the copy that booted
#    and must stay that way. This file is written ALONGSIDE it, deliberately.
#
# ── Where the package set comes from ──────────────────────────────────────────
# `RPM-EQUIVALENCE.md` in this directory, which is a RE-DERIVATION from the RPM
# package DB (`dnf provides`) against this exact base — not a translation of the
# apt names. `WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES`' own comment forbids
# translating that list by guesswork, and the SONAME half of it is a readelf union
# over the release bundle. Every name below traces to a row in that table.
#
# Re-verify the table against the live base before editing this list:
#   sudo -n podman run --rm -i --entrypoint /bin/bash \
#     quay.io/centos-bootc/centos-bootc:stream9 -s < verify-rpm-equivalents.sh
# (the `-i` is load-bearing: without it the container exits 0 having run NOTHING.)
#
# ── What is NOT here, and why ─────────────────────────────────────────────────
# ACLs, the three machine-local roots, and the sshd drop-in are applied at FIRST
# BOOT by `papercusp-firstboot.service`, not baked. That is not a stylistic
# choice — see the header of `papercusp-firstboot.sh` for the two measured
# reasons (POSIX ACLs do not survive a container commit; `/srv` and `/home` are
# symlinks into machine-local `/var` on this base).

FROM quay.io/centos-bootc/centos-bootc:stream9

# Identity names are BUILD-TIME on the bootc model, where the generated bootstrap
# took them as per-host input. An image is one artifact shared by every host, so
# the names it bakes are fixed for all of them; a per-host name would have to be
# applied after deploy, which defeats the point of baking the identities at all.
# These defaults mirror DEFAULT_WORKSPACE_HOST_{SERVICE,WORKSPACE,AGENT}_USER.
ARG PAPERCUSP_SERVICE_USER=papercusp
ARG PAPERCUSP_SERVICE_GROUP=papercusp
ARG PAPERCUSP_WORKSPACE_USER=papercusp-workspace
ARG PAPERCUSP_WORKSPACE_GROUP=papercusp-workspace
ARG PAPERCUSP_AGENT_USER=papercusp-agent
ARG PAPERCUSP_AGENT_GROUP=papercusp-agent

# ── Layer 1: packages ─────────────────────────────────────────────────────────
#
# Replaces:
#   apt-get install -y --no-install-recommends $WORKSPACE_HOST_BOOTSTRAP_APT_PACKAGES
#
# `--setopt=install_weak_deps=False` is the dnf analogue of `--no-install-recommends`.
# Without it the two are not equivalent and the image silently gains a large
# recommends closure.
#
# EPEL carries exactly ONE package here: minisign. It is a TRANSITIONAL trust
# widening, not a permanent dependency — D-262 condition 4 forbids removing
# minisign until P-306 AND P-308 have both landed, because the bootstrap's whole
# trust story (`signatureVerified: true` in the attestation) rests on it and
# removing it first yields a host that verifies nothing while still attesting
# that it did. When P-308's registry signing is live and the tarball path is
# retired, minisign AND this EPEL repo are removed together, in that order.
# `cosign` is deliberately NOT the substitute here: it is not in base repos or
# EPEL (measured, RPM-EQUIVALENCE.md §G) — it is a Go binary used at BUILD time
# by P-308, which is a different machine and a different trust question.
RUN dnf -y install --setopt=install_weak_deps=False epel-release \
    && dnf -y install --setopt=install_weak_deps=False \
         `# system packages — WORKSPACE_HOST_BOOTSTRAP_SYSTEM_APT_PACKAGES` \
         acl \
         ca-certificates \
         curl \
         jq \
         openssh-server \
         sudo \
         shadow-utils \
         policycoreutils \
         `# ufw is NOT-IN-REPOS; nftables replaces it (see layer 4)` \
         nftables \
         `# unattended-upgrades is NOT-IN-REPOS; dnf-automatic replaces it (layer 5)` \
         dnf-automatic \
         `# minisign is NOT-IN-REPOS; EPEL 9 carries it (see note above)` \
         minisign \
         `# the bootstrap apt-get installs zstd ON DEMAND at runtime because stock` \
         `# Ubuntu ships no unzstd. Baking it removes that imperative install.` \
         zstd \
         `# native SONAME providers — WORKSPACE_HOST_BOOTSTRAP_NATIVE_RUNTIME_APT_PACKAGES,` \
         `# mapped through RPM-EQUIVALENCE.md §D. All 8 are kept: §F measured that only 4` \
         `# are load-bearing for r19 but explicitly refuses to act on that, because readelf` \
         `# sees link-time DT_NEEDED only and a runtime dlopen() is invisible to it.` \
         `# Over-installing is harmless; under-installing fails on a customer VM.` \
         alsa-lib      `# libasound.so.2  <- libasound2t64` \
         libatomic     `# libatomic.so.1  <- libatomic1` \
         libgcc        `# libgcc_s.so.1   <- libgcc-s1` \
         libstdc++     `# libstdc++.so.6  <- libstdc++6` \
         openssl-libs  `# libssl.so.3     <- libssl3` \
         lz4-libs      `# liblz4.so.1     <- liblz4-1` \
         zlib          `# libz.so.1       <- zlib1g` \
         libzstd       `# libzstd.so.1    <- libzstd1` \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# ── Layer 2: the three identities (D-043 / D-248 / D-251) ─────────────────────
#
# Replaces the groupadd/useradd/usermod block of `harden-os`. Baked because
# uid/gid assignments DO survive the ostree commit (unlike ACLs) and a fixed uid
# across every host is strictly better than one that varies with package install
# order.
#
# The third identity is the load-bearing one: it exists so exactly one account
# both reads the signed runtime and holds the agent credentials, and that account
# is NOT the customer's SSH login. Do not collapse it back into the workspace user
# — that is the D-246 regression D-248 exists to undo.
#
# The two `if` guards at the end assert the memberships the bootstrap REFUSES, so
# a bad edit to this file fails the BUILD instead of shipping a host with the
# isolation contract quietly inverted. $SERVICE_GROUP would hand the agent runtime
# $STATE_ROOT (embedded PG plus every delivered credential); $WORKSPACE_GROUP would
# let the SSH account reach the agent's 0700 credential home through the group bits.
#
# ⚠ Those guards are why this block carries no inline `# …` shell comments the way
# layer 1 does. A Containerfile RUN collapses to ONE line, so a backtick-comment is
# a command substitution expanding to nothing — harmless between words in a package
# list, but placed before a compound statement it leaves `<empty> if …` with no
# separator and the shell fails to parse. Keep prose for this layer up here.
RUN set -eux; \
    groupadd --system "$PAPERCUSP_SERVICE_GROUP"; \
    useradd  --system --gid "$PAPERCUSP_SERVICE_GROUP" \
             --home-dir /var/lib/papercusp --no-create-home \
             --shell /usr/sbin/nologin "$PAPERCUSP_SERVICE_USER"; \
    usermod  --lock --shell /usr/sbin/nologin "$PAPERCUSP_SERVICE_USER"; \
    groupadd "$PAPERCUSP_WORKSPACE_GROUP"; \
    useradd  --gid "$PAPERCUSP_WORKSPACE_GROUP" \
             --home-dir "/home/$PAPERCUSP_WORKSPACE_USER" --no-create-home \
             --shell /bin/bash "$PAPERCUSP_WORKSPACE_USER"; \
    usermod  --lock --gid "$PAPERCUSP_WORKSPACE_GROUP" --groups "" \
             --home "/home/$PAPERCUSP_WORKSPACE_USER" --shell /bin/bash \
             "$PAPERCUSP_WORKSPACE_USER"; \
    groupadd --system "$PAPERCUSP_AGENT_GROUP"; \
    useradd  --system --gid "$PAPERCUSP_AGENT_GROUP" \
             --home-dir "/home/$PAPERCUSP_AGENT_USER" --no-create-home \
             --shell /usr/sbin/nologin "$PAPERCUSP_AGENT_USER"; \
    usermod  --lock --gid "$PAPERCUSP_AGENT_GROUP" --groups "" \
             --home "/home/$PAPERCUSP_AGENT_USER" --shell /usr/sbin/nologin \
             "$PAPERCUSP_AGENT_USER"; \
    if id -nG "$PAPERCUSP_WORKSPACE_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_SERVICE_GROUP"; then \
      echo 'FATAL: workspace SSH user must not belong to the runtime service group' >&2; exit 1; \
    fi; \
    if id -nG "$PAPERCUSP_AGENT_USER" | tr ' ' '\n' | grep -Fx "$PAPERCUSP_SERVICE_GROUP"; then \
      echo 'FATAL: agent user must not belong to the runtime service group' >&2; exit 1; \
    fi

# ── Layer 3: the container signature policy (D-262 condition 1) ───────────────
#
# `release-signature-policy.json` is PROVEN enforced and fail-closed on this base
# (D-279: paired probe, signed ACCEPT / unsigned REJECT / base-default ACCEPT).
# This layer is what puts it on the host, which is the half that was missing —
# the policy existed as an artifact and was installed nowhere.
#
# It is a TEMPLATE and it fails CLOSED: `<RELEASE_REGISTRY_NAMESPACE>` is P-307's
# to establish and `/etc/pki/papercusp/release-signing.pub` is what P-308's
# signing key populates. Neither placeholder can match, so an image built before
# those land refuses to pull a release rather than accepting an unsigned one.
COPY release-signature-policy.json /etc/containers/policy.json
RUN chmod 0644 /etc/containers/policy.json \
    && install -d -m 0755 /etc/pki/papercusp

# ── Layer 4: firewall — ufw is NOT-IN-REPOS, nftables replaces it ─────────────
#
# The bootstrap's five ufw invocations are a POLICY, not a package name, so this
# is a behavioural rewrite (RPM-EQUIVALENCE.md §G says so explicitly). The policy
# being reproduced, verbatim from `harden-os`:
#     ufw default deny incoming
#     ufw default allow outgoing
#     ufw allow 22/tcp
#     ufw --force enable
#
# nftables over firewalld, deliberately: nftables is already INSTALLED in the base
# (firewalld is only AVAILABLE), it needs no dbus/polkit running, and it takes a
# declarative ruleset file — which is the right shape for an immutable image,
# where a sequence of imperative `firewall-cmd` calls has nowhere correct to run.
# The established connection clause is not in the ufw list because ufw supplies it
# implicitly; stated explicitly here, a default-deny input chain without it drops
# the replies to the host's own outbound traffic and the host is unreachable.
COPY papercusp-firewall.nft /etc/nftables/papercusp-workspace-host.nft
RUN set -eux; \
    printf 'include "/etc/nftables/papercusp-workspace-host.nft"\n' \
      > /etc/sysconfig/nftables.conf; \
    nft --check --file /etc/nftables/papercusp-workspace-host.nft; \
    systemctl enable nftables.service

# ── Layer 5: unattended security updates ──────────────────────────────────────
#
# Replaces `systemctl enable --now unattended-upgrades.service`.
#
# ⚠ Scope narrowed on purpose, and this is a real behavioural difference from the
# Ubuntu host rather than a rename. On a bootc host the OS is an image: applying
# package updates in place would write to `/usr`, which is read-only, and would
# put the running system out of step with the image it claims to be. The OS half
# of "unattended upgrades" belongs to `bootc upgrade` (the update path this port
# introduces), not to dnf. dnf-automatic is configured for DOWNLOAD-ONLY so that
# metadata and the security feed stay warm without mutating the deployment.
RUN set -eux; \
    sed -i 's/^upgrade_type *=.*/upgrade_type = security/' /etc/dnf/automatic.conf; \
    sed -i 's/^download_updates *=.*/download_updates = yes/' /etc/dnf/automatic.conf; \
    sed -i 's/^apply_updates *=.*/apply_updates = no/'       /etc/dnf/automatic.conf; \
    grep -q '^apply_updates = no' /etc/dnf/automatic.conf; \
    systemctl enable dnf-automatic.timer

# ── Layer 6: per-boot host preparation ────────────────────────────────────────
#
# Everything that CANNOT be baked. See `papercusp-host-prepare.sh` for what and why.
#
# ⚠ It runs on EVERY boot, not just the first, and that is not belt-and-braces.
# After a `bootc upgrade` the host reboots into a NEW deployment root, so the
# ACLs applied to `/opt/papercusp` are gone with the deployment that carried
# them — while `/var` and `/srv` state persists. A once-only unit would leave
# every host that ever takes an update with an unreadable runtime root, and the
# update path is the whole point of this port.
COPY papercusp-host-prepare.sh /usr/libexec/papercusp/host-prepare.sh
COPY papercusp-host-prepare.service /usr/lib/systemd/system/papercusp-host-prepare.service
RUN chmod 0755 /usr/libexec/papercusp/host-prepare.sh \
    && systemctl enable papercusp-host-prepare.service

# ── Layer 7: runtime root ─────────────────────────────────────────────────────
#
# `/opt` is a REAL directory on this base while `/srv` and `/home` are symlinks
# into machine-local `/var` (measured 2026-09-04). That is the "new model" the
# base's own tmpfiles dropin describes, in which OSTree commit content is allowed
# in `/opt` — and it is what makes baking the release tree here possible at all.
#
# ⚠ NOT PROVEN AT CONTAINER LEVEL, and the first-boot unit asserts it rather than
# assuming it: that same dropin
# (`/usr/lib/tmpfiles.d/rpm-ostree-0-integration-opt-usrlocal.conf`) says in its
# own comment that it "implements the old model", where `/opt` is a link to
# `/var/opt`. If the deployed host resolves `/opt` to machine-local storage, a
# release tree baked here is simply ABSENT after deploy — and every container-level
# signal, this build included, still reads healthy. That is the same shape as
# WI-2143115 (ACLs silently dropped by the container commit). The booted
# assertion belongs to P-305, which already has to boot a VM for D-279's
# `bootc upgrade` refusal.
RUN install -d -o root -g "$PAPERCUSP_SERVICE_GROUP" -m 0750 \
      /opt/papercusp /opt/papercusp/releases

# ── Lint ──────────────────────────────────────────────────────────────────────
# `bootc container lint` validates that this image can actually be deployed as a
# host (kernel + bootloader shape, ostree-incompatible layout). It catches the
# common errors at BUILD time rather than at install time on a customer VM.
RUN bootc container lint
