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
# ACLs, the three machine-local roots, and the sshd drop-in are applied ON EVERY
# BOOT by `papercusp-host-prepare.service`, not baked. That is not a stylistic
# choice — see the header of `papercusp-host-prepare.sh` for the two measured
# reasons (POSIX ACLs do not survive a container commit; `/srv` and `/home` are
# symlinks into machine-local `/var` on this base).
#
# EVERY boot, not first: `bootc upgrade` reboots into a NEW deployment root, and
# the ACLs on /opt/papercusp went with the OLD one while /var persisted. A
# first-boot stamp file would therefore skip precisely the hosts that took an
# update — every file present and correctly sized, owned by the right names,
# and unreadable by the identity that needs them, with the host reporting
# healthy throughout.

FROM quay.io/centos-bootc/centos-bootc:stream9

# The image records the base it was built FROM, because a BOOTED host cannot
# otherwise answer that question about itself: `bootc status` reports the ref
# the host booted (this image), never what that image derives from, and image
# LABELs need a local copy of the image to inspect. Writing it under /usr makes
# it image content — read-only on a running bootc host, replaced atomically by
# an upgrade — so the attested `bootc-base-image` check is reading a fact the
# image carries rather than one the host was told.
ARG PAPERCUSP_BASE_IMAGE=quay.io/centos-bootc/centos-bootc:stream9
RUN install -d -m 0755 /usr/lib/papercusp \
 && printf '%s\n' "${PAPERCUSP_BASE_IMAGE}" > /usr/lib/papercusp/base-image \
 && chmod 0644 /usr/lib/papercusp/base-image

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
    `# Scrub dnf/subscription-manager residue from /var and /run.` \
    `# Not tidiness. bootc container lint fails three separate checks on it` \
    `# (var-log, var-tmpfiles, nonempty-run-tmp) and the reason is structural:` \
    `# /var is MACHINE-LOCAL state on a bootc host, seeded once, so image content` \
    `# there is not image content in any useful sense — it is either discarded or` \
    `# it shadows the host's own state. A dnf repo cache baked into /var/lib/dnf is` \
    `# the "looks present, is not deployed" class this port keeps running into.` \
    && rm -rf /var/cache/dnf /var/lib/dnf /var/log/dnf.* /var/log/hawkey.log \
              /var/log/rhsm /var/lib/rhsm /run/rhsm /var/cache/ldconfig

# ── Layer 2: the three identities (D-043 / D-248 / D-251) ─────────────────────
#
# Replaces the groupadd/useradd/usermod block of `harden-os` with a sysusers.d
# declaration. See `papercusp-sysusers.conf` for why the uid/gid numbers are
# PINNED there rather than allocated by `useradd` — in short, `useradd` counts
# down from 999 in package install order, `/var` persists across `bootc upgrade`
# while `/etc/passwd` comes from the image, and a renumbering upgrade therefore
# orphans the agent's credential home while every signal still reads healthy.
#
# The third identity is the load-bearing one: it exists so exactly one account
# both reads the signed runtime and holds the agent credentials, and that account
# is NOT the customer's SSH login. Do not collapse it back into the workspace user
# — that is the D-246 regression D-248 exists to undo.
#
# `systemd-sysusers` is invoked explicitly so the entries exist in THIS image
# rather than only on first boot; the file stays in /usr/lib/sysusers.d so systemd
# also re-applies it on the deployed host.
#
# The `if` guards assert the two memberships the bootstrap REFUSES, so a bad edit
# fails the BUILD instead of shipping a host with the isolation contract quietly
# inverted. $SERVICE_GROUP would hand the agent runtime $STATE_ROOT (embedded PG
# plus every delivered credential); $WORKSPACE_GROUP would let the SSH account
# reach the agent's 0700 credential home through the group bits.
#
# ⚠ That is why this block carries no inline `# …` shell comments the way layer 1
# does. A Containerfile RUN collapses to ONE line, so a backtick-comment is a
# command substitution expanding to nothing — harmless between words in a package
# list, but placed before a compound statement it leaves `<empty> if …` with no
# separator and the shell fails to parse. Keep prose for this layer up here.
COPY papercusp-sysusers.conf /usr/lib/sysusers.d/papercusp.conf
RUN set -eux; \
    systemd-sysusers /usr/lib/sysusers.d/papercusp.conf; \
    getent passwd "$PAPERCUSP_SERVICE_USER" "$PAPERCUSP_WORKSPACE_USER" "$PAPERCUSP_AGENT_USER"; \
    test "$(id -u "$PAPERCUSP_SERVICE_USER")"   = 910; \
    test "$(id -g "$PAPERCUSP_SERVICE_USER")"   = 910; \
    test "$(id -u "$PAPERCUSP_AGENT_USER")"     = 911; \
    test "$(id -g "$PAPERCUSP_AGENT_USER")"     = 911; \
    test "$(id -u "$PAPERCUSP_WORKSPACE_USER")" = 1500; \
    test "$(id -g "$PAPERCUSP_WORKSPACE_USER")" = 1500; \
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
# to establish and `/etc/pki/papercusp/release-signing.pub` is populated from the
# public half of P-308's signing key. A specialised build refuses to proceed unless
# both are present; an unspecialised build keeps the non-matching namespace and no
# key, so it refuses a release rather than accepting an unsigned one.
# ⛔ The policy is INERT WITHOUT the registries.d fragment beside it (D-287). On the
# docker: transport containers/image does not LOOK for a cosign signature unless the
# registry carries `use-sigstore-attachments: true`, and without it a correctly signed
# image is refused with the SAME message an unsigned one gets ("A signature was
# required, but no signature exists"). Fail-closed, and totally opaque. Ship both.
#
# P-307 substitutes `<RELEASE_REGISTRY_NAMESPACE>` HERE, at build time, from a build arg —
# the files stay templates in the repo so the DEFAULT build still fails closed exactly as
# D-262 condition 1 requires (and `p306-image-build-probe.sh` still asserts the placeholder
# survives an unparameterised build).
#
# MEASURED by `p307-registries-d-scope-probe.sh` (2026-09-04), which decides the two rules
# below. Both were open questions this layer used to get wrong:
#
#   * ONE STRING SERVES BOTH FILES. containers-registries.d(5) keys accept the same scope
#     ladder policy.json uses — the probe accepted a repository path (A), a repository
#     namespace (A2) and a bare host (B). The claim previously carried in
#     release-registries.d.yaml, that this file "takes only the host part", is FALSE, and
#     acting on it would have split one value across two files for no reason.
#   * THE PORT IS PART OF THE SCOPE. A port-less hostname does NOT match a registry reached
#     on an explicit port (probe D) — and the resulting refusal is BYTE-IDENTICAL to the
#     unsigned-image message ("A signature was required, but no signature exists"). So a
#     value that drops a non-default port produces an image that cannot pull its own
#     release and blames the signature for it. Pass the port if the registry uses one.
#
# The substitution is all-or-nothing across BOTH files. A half-substituted image is the
# worst outcome available here: the policy would name the real registry while registries.d
# still named the placeholder, so containers/image would never look for the attachment and
# would refuse every upgrade with that same unsigned-looking string. Checking it at BUILD
# time turns an opaque runtime failure into a loud one.
ARG RELEASE_REGISTRY_NAMESPACE=
ARG RELEASE_STORAGE_DRIVER=
ARG RELEASE_SIGNING_PUBKEY_B64=
COPY release-signature-policy.json /etc/containers/policy.json
COPY release-registries.d.yaml /etc/containers/registries.d/papercusp-release.yaml
RUN set -eu; \
    POL=/etc/containers/policy.json; \
    RD=/etc/containers/registries.d/papercusp-release.yaml; \
    PUB=/etc/pki/papercusp/release-signing.pub; \
    install -d -m 0755 /etc/pki/papercusp; \
    if [ -n "${RELEASE_REGISTRY_NAMESPACE}" ]; then \
      case "${RELEASE_REGISTRY_NAMESPACE}" in \
        *'<'*|*'>'*|*' '*|*'"'*) \
          echo "FATAL: RELEASE_REGISTRY_NAMESPACE='${RELEASE_REGISTRY_NAMESPACE}' is not a registry scope" >&2; exit 1;; \
        */) echo "FATAL: RELEASE_REGISTRY_NAMESPACE must not end in '/'" >&2; exit 1;; \
        *.*|*:*|localhost*) ;; \
        *) echo "FATAL: RELEASE_REGISTRY_NAMESPACE='${RELEASE_REGISTRY_NAMESPACE}' has no registry host — a bare repository name is not a scope" >&2; exit 1;; \
      esac; \
      case "${RELEASE_STORAGE_DRIVER}" in \
        ''|*[!A-Za-z0-9_-]*) echo "FATAL: RELEASE_STORAGE_DRIVER is required and must name one containers/storage graph driver" >&2; exit 1;; \
      esac; \
      [ -n "${RELEASE_SIGNING_PUBKEY_B64}" ] || { \
        echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 is required when RELEASE_REGISTRY_NAMESPACE is set" >&2; exit 1; }; \
      sed -i "s|<RELEASE_REGISTRY_NAMESPACE>|${RELEASE_REGISTRY_NAMESPACE}|g" "$POL" "$RD"; \
      CS_SCOPE="[${RELEASE_STORAGE_DRIVER}@/var/lib/containers/storage]${RELEASE_REGISTRY_NAMESPACE}"; \
      POL_TMP="$(mktemp)"; \
      jq --arg scope "$CS_SCOPE" \
        '.transports["containers-storage"] = {($scope): [{"type":"insecureAcceptAnything"}]}' \
        "$POL" > "$POL_TMP"; \
      install -m 0644 "$POL_TMP" "$POL"; \
      rm -f "$POL_TMP"; \
      jq -e --arg scope "$CS_SCOPE" \
        '.transports["containers-storage"][$scope][0].type == "insecureAcceptAnything"' \
        "$POL" >/dev/null || { echo "FATAL: scoped containers-storage policy was not installed" >&2; exit 1; }; \
      printf '%s' "${RELEASE_SIGNING_PUBKEY_B64}" | base64 -d > "$PUB" \
        || { echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 is not valid base64" >&2; exit 1; }; \
      [ -s "$PUB" ] && openssl pkey -pubin -in "$PUB" -noout >/dev/null 2>&1 \
        || { echo "FATAL: RELEASE_SIGNING_PUBKEY_B64 does not encode a valid public key" >&2; exit 1; }; \
      chmod 0644 "$PUB"; \
      for f in "$POL" "$RD"; do \
        if grep -qF '<RELEASE_REGISTRY_NAMESPACE>' "$f"; then \
          echo "FATAL: placeholder survived substitution in $f" >&2; exit 1; \
        fi; \
        if ! grep -qF "${RELEASE_REGISTRY_NAMESPACE}" "$f"; then \
          echo "FATAL: $f does not name the release registry after substitution" >&2; exit 1; \
        fi; \
      done; \
      install -d -m 0755 /usr/lib/papercusp; \
      printf '%s\n' "${RELEASE_REGISTRY_NAMESPACE}" > /usr/lib/papercusp/release-registry-namespace; \
    else \
      if [ -n "${RELEASE_STORAGE_DRIVER}" ] || [ -n "${RELEASE_SIGNING_PUBKEY_B64}" ]; then \
        echo "FATAL: release storage driver/public key require RELEASE_REGISTRY_NAMESPACE" >&2; exit 1; \
      fi; \
      for f in "$POL" "$RD"; do \
        grep -qF '<RELEASE_REGISTRY_NAMESPACE>' "$f" || { \
          echo "FATAL: $f lost its fail-closed placeholder without a substitution value" >&2; exit 1; }; \
      done; \
    fi; \
    chmod 0644 "$POL" "$RD"

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
#
# ⚠ The ruleset is NOT syntax-checked here, and cannot be: `nft --check` still
# initializes a netlink cache, which the build sandbox denies
# (`cache initialization failed: Operation not permitted`) — a build container has
# no CAP_NET_ADMIN. Requiring `podman build --cap-add=NET_ADMIN` would push that
# onto P-307's pipeline as an easily-forgotten flag.
#
# It is checked in TWO places instead, and the second is the one that matters:
#   * `p306-image-build-probe.sh` runs `nft --check` with a negative control, so a
#     malformed ruleset fails the probe;
#   * `papercusp-host-prepare.sh` asserts on the BOOTED host that the table is
#     actually loaded.
# The boot-time assertion is not redundant. If nftables.service fails to start,
# a default-deny design does not fail closed — it loads NO rules at all and the
# host is wide open, while sshd and the service still come up healthy. Syntax was
# never the risk worth guarding; "the rules are absent" is.
COPY papercusp-firewall.nft /etc/nftables/papercusp-workspace-host.nft
RUN set -eux; \
    printf 'include "/etc/nftables/papercusp-workspace-host.nft"\n' \
      > /etc/sysconfig/nftables.conf; \
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
