# Papercusp workspace-host VM image — the canonical build template.
#
# This is the template `WorkspaceHostBuildManifest.builder.templatePath` names and
# `builder.templateSha256` pins. It is deliberately IN-REPO and content-addressed: a manifest
# that pins a template living outside the repository cannot be reproduced from the revision it
# claims to describe, so `normalizeWorkspaceHostBuildManifestInput` refuses an absolute or
# traversing path (see libs/generic/deployment-driver/src/workspace-host-build-manifest.ts).
#
# ── What this template is responsible for ────────────────────────────────────────────────────
# It produces ONE quarantined candidate image. It never publishes into a production image
# family: `executeGcpImageFamilyRelease` requires the candidate to be family-INVISIBLE until it
# has passed scan, inspection, and a clean-room boot, so `image_family` is intentionally unset
# and must stay that way (packages/operator-core/lib/workspace-host/gcp-image-family.ts —
# `validateInspection` fails a candidate whose `family` is anything but undefined).
#
# ── Why the release is baked in, not fetched at first boot ───────────────────────────────────
# The generated v2 bootstrap (WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION =
# 'papercusp-workspace-host-bootstrap-v2') skips extraction when
# `/opt/papercusp/releases/$RELEASE_VERSION` already exists, and asserts every release
# entrypoint is executable before it will install. Baking the verified release here moves that
# assertion from FIRST BOOT to BUILD TIME: a bundle missing an entrypoint fails this build
# instead of producing an image that boots, reports healthy, and then fails every workspace
# initialization at the far end (the exact failure recorded as EI-21546829012278002). It is also
# what makes an image inspectably v2: a pre-v2 host is identifiable by an EMPTY /opt/papercusp
# and a missing `papercusp-workspace` account, which is how pc-p046-canary-02 was diagnosed.
#
# The bootstrap still re-downloads and re-verifies the bundle at first boot. That is not
# redundant: this build proves the bytes were good when the image was cut, and the bootstrap
# proves the signature again on the host that will actually run them.
#
# ── Guest-tool versions are INPUTS, not discoveries ──────────────────────────────────────────
# `GcpImageFamilyReleaseAdapter.inspectImage` must report each required guest tool WITH its
# version, and the Compute Engine image API cannot enumerate installed packages. So the exact
# dpkg version of every required tool is a pinned build parameter, asserted against the guest
# after install and recorded in the image description below. Pinning rather than discovering
# also makes the build reproducible: the same inputs must yield the same package set.
#
# ── The provenance document ──────────────────────────────────────────────────────────────────
# `image_description` carries a single-line JSON provenance document. It is the surface
# `inspectImage` parses, because GCP label VALUES cannot hold what has to be recorded here — a
# label value is limited to 63 characters and to `[a-z0-9_-]`, which excludes a 64-character
# SHA-256 digest, a `sha256:` prefix, and any dotted release version. Labels below are a
# best-effort search aid only; the description is authoritative.
#
# Schema (contract `papercusp-gcp-image-family-release-v1`):
#   { contractVersion, buildManifestIdentity, releaseVersion, releaseSha256,
#     baseImage: { reference, sha256 }, architecture,
#     guestTools: [ { name, version } ], sourceCandidateImageId? }
#
# ── Building ─────────────────────────────────────────────────────────────────────────────────
#   packer init   infra/images/workspace-host.pkr.hcl
#   packer build  -var-file=<generated.pkrvars.hcl> infra/images/workspace-host.pkr.hcl
#
# The build VM runs with NO external IP by default, so the subnetwork it is given MUST provide
# egress through Cloud NAT (the bundle download and apt both need it). Set `omit_external_ip` to
# false only for a network that genuinely has no NAT, and never for a production cut.

packer {
  required_version = ">= 1.11.0"

  required_plugins {
    googlecompute = {
      # Pinned exactly: an image build whose builder plugin floats is not reproducible.
      version = "= 1.1.6"
      source  = "github.com/hashicorp/googlecompute"
    }
  }
}

# ── Identity of the build ────────────────────────────────────────────────────────────────────

variable "project_id" {
  type        = string
  description = "GCP project that owns the candidate image."
}

variable "zone" {
  type        = string
  description = "Zone the ephemeral build VM runs in."
}

variable "subnetwork" {
  type        = string
  description = "Subnetwork for the build VM. Must have Cloud NAT egress when omit_external_ip is true."
}

variable "service_account_email" {
  type        = string
  description = "Service account the build VM runs as. Needs only what the build itself performs."
}

variable "candidate_image_name" {
  type        = string
  description = "Name of the quarantined candidate image. Never a production family member name."

  validation {
    condition     = can(regex("^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$", var.candidate_image_name))
    error_message = "The candidate_image_name must be a GCP resource name."
  }
}

variable "build_manifest_identity" {
  type        = string
  description = "WorkspaceHostBuildManifest.manifestIdentity, as sha256:<64 hex>."

  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.build_manifest_identity))
    error_message = "The build_manifest_identity must be sha256:<64 lowercase hex>."
  }
}

# ── The base image ───────────────────────────────────────────────────────────────────────────

variable "source_image" {
  type        = string
  description = "Immutable source image, projects/<project>/global/images/<name>. Never a family alias."

  validation {
    condition     = can(regex("^projects/[^/]+/global/images/[^/]+$", var.source_image))
    error_message = "The source_image must be an immutable projects/<project>/global/images/<name> reference; family aliases are forbidden."
  }
}

variable "base_image_sha256" {
  type        = string
  description = "WorkspaceHostBuildManifest.baseImage.sha256, recorded in the provenance document."

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.base_image_sha256))
    error_message = "The base_image_sha256 must be a lowercase 64-character SHA-256 hex digest."
  }
}

variable "architecture" {
  type        = string
  default     = "x86_64"
  description = "Must equal WorkspaceHostBuildManifest.baseImage.architecture; validateInspection compares them."
}

variable "machine_type" {
  type        = string
  default     = "e2-standard-2"
  description = "Build VM shape. Does not affect the produced image."
}

variable "disk_size_gb" {
  type        = number
  default     = 32
  description = "Boot disk size of the produced image."
}

# ── The release baked into the image ─────────────────────────────────────────────────────────

variable "release_version" {
  type        = string
  description = "WorkspaceHostImageArtifact.image.version. Extracted to /opt/papercusp/releases/<version>."
}

variable "release_bundle_url" {
  type        = string
  description = "Content-addressed HTTPS URL of server.tgz, as pinned by the manifest."

  validation {
    condition     = can(regex("^https://", var.release_bundle_url))
    error_message = "The release_bundle_url must be an HTTPS URL."
  }
}

variable "release_bundle_sha256" {
  type        = string
  description = "SHA-256 of the release bundle. Verified inside the build before extraction."

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.release_bundle_sha256))
    error_message = "The release_bundle_sha256 must be a lowercase 64-character SHA-256 hex digest."
  }
}

variable "release_signature_url" {
  type        = string
  description = "Detached minisign signature URL; must be release_bundle_url suffixed with .minisig."

  validation {
    condition     = can(regex("\\.minisig$", var.release_signature_url))
    error_message = "The release_signature_url must end in .minisig."
  }
}

variable "release_signing_public_key" {
  type        = string
  description = "Minisign PUBLIC verification key. Never a private signing key."
}

variable "release_signing_key_sha256" {
  type        = string
  description = "SHA-256 of release_signing_public_key, pinning the exact trust root."

  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.release_signing_key_sha256))
    error_message = "The release_signing_key_sha256 must be a lowercase 64-character SHA-256 hex digest."
  }
}

# ── Guest tools ──────────────────────────────────────────────────────────────────────────────

variable "guest_tool_versions" {
  type        = map(string)
  description = <<-EOT
    Exact dpkg version for every tool in GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS, keyed by package
    name. Every entry is installed at that exact version and then re-asserted against the guest,
    so a repository that has moved on fails the build instead of silently producing an image
    whose inspection report is a lie.
  EOT

  # ⛔ Do NOT reach for `setsubtract` here. It is the obvious Terraform way to write
  # "every required package is present" and Packer DOES NOT HAVE IT: Packer's HCL2
  # function table ships setintersection/setunion but no setsubtract, so the expression
  # below was previously `length(setsubtract(required, keys(...))) == 0` and every build
  # died with `Call to unknown function ... there is no function named "setsubtract"`.
  # `packer validate -syntax-only` does NOT catch this — it parses the file without
  # evaluating expressions, so the release preflight passed and the failure surfaced only
  # at billable `packer build` time (EI-21762126059344308 / EI-21751634175352001).
  # Verified present in Packer v1.16.0 against a known-bad control: alltrue, contains, keys.
  validation {
    condition = alltrue([
      for pkg in [
        "acl",
        "ca-certificates",
        "curl",
        "google-guest-agent",
        "jq",
        "minisign",
        "openssh-server",
        "ufw",
        "unattended-upgrades",
      ] : contains(keys(var.guest_tool_versions), pkg)
    ])
    error_message = "The guest_tool_versions must pin every package in GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS."
  }
}

# ── Network posture ──────────────────────────────────────────────────────────────────────────

variable "omit_external_ip" {
  type        = bool
  default     = true
  description = "Build without a public IPv4. Requires Cloud NAT on the subnetwork."
}

variable "use_iap" {
  type        = bool
  default     = true
  description = "Reach the build VM over the IAP tunnel rather than a public address."
}

# ── Derived values ───────────────────────────────────────────────────────────────────────────

locals {
  required_guest_tools = [
    "acl",
    "ca-certificates",
    "curl",
    "google-guest-agent",
    "jq",
    "minisign",
    "openssh-server",
    "ufw",
    "unattended-upgrades",
  ]

  # Mirrors DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS in
  # libs/generic/deployment-driver/src/workspace-host-bootstrap.ts. The guard test
  # workspace-host-image-template.test.ts fails if the two lists diverge.
  release_entrypoints = [
    "bin/papercusp-install",
    "bin/papercusp-rollback",
    "bin/node",
    "bin/papercusp-migrate",
    "bin/papercusp-server",
    "bin/papercusp-health",
    "bin/psu",
    "bin/claude",
    "bin/codex",
    "bin/omp",
    "bin/papercusp-remote-initializer",
  ]

  image_provenance = jsonencode({
    contractVersion       = "papercusp-gcp-image-family-release-v1"
    buildManifestIdentity = var.build_manifest_identity
    releaseVersion        = var.release_version
    releaseSha256         = var.release_bundle_sha256
    baseImage = {
      reference = var.source_image
      sha256    = var.base_image_sha256
    }
    architecture = var.architecture
    guestTools = [
      for tool in local.required_guest_tools : {
        name    = tool
        version = var.guest_tool_versions[tool]
      }
    ]
  })
}

source "googlecompute" "workspace_host" {
  project_id            = var.project_id
  zone                  = var.zone
  subnetwork            = var.subnetwork
  service_account_email = var.service_account_email
  scopes                = ["https://www.googleapis.com/auth/cloud-platform"]

  source_image = var.source_image
  machine_type = var.machine_type
  disk_size    = var.disk_size_gb
  disk_type    = "pd-balanced"

  # No public address on the builder, and no project-wide SSH keys reaching it.
  omit_external_ip = var.omit_external_ip
  use_internal_ip  = var.omit_external_ip
  use_iap          = var.use_iap

  ssh_username = "packer"
  use_os_login = true

  metadata = {
    block-project-ssh-keys = "TRUE"
    enable-oslogin         = "TRUE"
  }

  # image_family is deliberately NOT set. A candidate that is family-discoverable can be selected
  # before it is green, which is precisely the ordering executeGcpImageFamilyRelease enforces:
  # scan -> inspect -> clean-room boot -> publish. validateInspection rejects a candidate whose
  # family is set.
  image_name        = var.candidate_image_name
  image_description = local.image_provenance
  image_labels = {
    papercusp-artifact     = "workspace-host"
    papercusp-contract     = "papercusp-gcp-image-family-release-v1"
    papercusp-state        = "candidate"
    papercusp-architecture = replace(var.architecture, ".", "_")
    papercusp-release      = replace(replace(lower(var.release_version), ".", "-"), "+", "-")
  }
}

build {
  name    = "papercusp-workspace-host"
  sources = ["source.googlecompute.workspace_host"]

  # 1. Do not race cloud-init: an apt run started underneath it deadlocks on the dpkg lock.
  provisioner "shell" {
    inline = [
      "set -Eeuo pipefail",
      "cloud-init status --wait",
    ]
  }

  # 2. The host contract: Ubuntu 24.04 exactly. The bootstrap dies on anything else, so an image
  #    built on the wrong base must fail here rather than at a customer's first boot.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    inline = [
      "set -Eeuo pipefail",
      ". /etc/os-release",
      "[ \"$${ID:-}\" = ubuntu ] || { echo 'base image is not Ubuntu' >&2; exit 1; }",
      "[ \"$${VERSION_ID:-}\" = '24.04' ] || { echo 'base image is not Ubuntu 24.04' >&2; exit 1; }",
    ]
  }

  # 3. Install every required guest tool at its pinned version, then re-assert it. dpkg reports
  #    what is actually installed, so a repository that served a different version than requested
  #    is caught here instead of being described inaccurately by the image provenance.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
      "PINNED_TOOLS=${join(" ", [for tool in local.required_guest_tools : "${tool}=${var.guest_tool_versions[tool]}"])}",
    ]
    inline = [
      "set -Eeuo pipefail",
      "apt-get update -qq",
      "apt-get install -y --no-install-recommends $PINNED_TOOLS",
      "for pin in $PINNED_TOOLS; do",
      "  name=\"$${pin%%=*}\"",
      "  want=\"$${pin#*=}\"",
      "  have=\"$(dpkg-query -W -f='$${Version}' \"$name\")\"",
      "  [ \"$have\" = \"$want\" ] || { echo \"guest tool $name is $have, not the pinned $want\" >&2; exit 1; }",
      "done",
    ]
  }

  # 4. Bake the identities and directory skeleton the v2 bootstrap expects. The bootstrap creates
  #    these itself and is idempotent, so this is not a substitute for it — it makes the image
  #    itself inspectably v2. A pre-v2 host is recognised by exactly the absence of these: an
  #    empty /opt/papercusp and no papercusp-workspace account.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    inline = [
      "set -Eeuo pipefail",
      "umask 027",
      "getent group papercusp >/dev/null || groupadd --system papercusp",
      "id -u papercusp >/dev/null 2>&1 || useradd --system --gid papercusp --home-dir /var/lib/papercusp --create-home --shell /usr/sbin/nologin papercusp",
      "usermod --lock --shell /usr/sbin/nologin papercusp",
      "getent group papercusp-workspace >/dev/null || groupadd papercusp-workspace",
      "id -u papercusp-workspace >/dev/null 2>&1 || useradd --gid papercusp-workspace --home-dir /home/papercusp-workspace --create-home --shell /bin/bash papercusp-workspace",
      "usermod --lock --gid papercusp-workspace --groups '' --home /home/papercusp-workspace --shell /bin/bash papercusp-workspace",
      # The interactive SSH identity must never gain the runtime service group; that separation is
      # the whole point of having two accounts, and the bootstrap dies if it is violated.
      "if id -nG papercusp-workspace | tr ' ' '\\n' | grep -Fx papercusp >/dev/null; then echo 'workspace user must not be in the service group' >&2; exit 1; fi",
      "install -d -o papercusp -g papercusp -m 0750 /var/lib/papercusp /var/lib/papercusp/embedded-pg",
      "install -d -o root -g papercusp -m 0750 /opt/papercusp /opt/papercusp/releases /etc/papercusp",
      "install -d -o root -g root -m 0711 /srv/papercusp",
      "install -d -o root -g root -m 0770 /srv/papercusp/workspaces",
      "install -d -o papercusp-workspace -g papercusp-workspace -m 0700 /home/papercusp-workspace",
    ]
  }

  # 5. Verify and bake the release. Digest first, then signature, then extraction — and only then
  #    the entrypoint assertion, which is the check that converts a silently incomplete bundle
  #    into a failed build.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    environment_vars = [
      "RELEASE_VERSION=${var.release_version}",
      "BUNDLE_URL=${var.release_bundle_url}",
      "BUNDLE_SHA256=${var.release_bundle_sha256}",
      "SIGNATURE_URL=${var.release_signature_url}",
      "SIGNING_PUBLIC_KEY=${var.release_signing_public_key}",
      "SIGNING_KEY_SHA256=${var.release_signing_key_sha256}",
      "RELEASE_ENTRYPOINTS=${join(" ", local.release_entrypoints)}",
    ]
    inline = [
      "set -Eeuo pipefail",
      "umask 027",
      "WORK_DIR=\"$(mktemp -d /var/tmp/papercusp-image.XXXXXX)\"",
      "trap 'rm -rf -- \"$WORK_DIR\"' EXIT",
      "BUNDLE_PATH=\"$WORK_DIR/server.tgz\"",
      "SIGNATURE_PATH=\"$WORK_DIR/server.tgz.minisig\"",
      "PUBLIC_KEY_PATH=\"$WORK_DIR/release-public.key\"",
      "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \"$BUNDLE_URL\" --output \"$BUNDLE_PATH\"",
      "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \"$SIGNATURE_URL\" --output \"$SIGNATURE_PATH\"",
      "printf '%s  %s\\n' \"$BUNDLE_SHA256\" \"$BUNDLE_PATH\" | sha256sum --check --strict -",
      "printf '%s' \"$SIGNING_PUBLIC_KEY\" > \"$PUBLIC_KEY_PATH\"",
      "printf '%s  %s\\n' \"$SIGNING_KEY_SHA256\" \"$PUBLIC_KEY_PATH\" | sha256sum --check --strict -",
      "minisign -Vm \"$BUNDLE_PATH\" -x \"$SIGNATURE_PATH\" -p \"$PUBLIC_KEY_PATH\" >/dev/null",
      "RELEASE_DIR=\"/opt/papercusp/releases/$RELEASE_VERSION\"",
      "STAGE_DIR=\"$(mktemp -d \"/opt/papercusp/releases/.$${RELEASE_VERSION}.XXXXXX\")\"",
      "tar --extract --gzip --file \"$BUNDLE_PATH\" --directory \"$STAGE_DIR\" --no-same-owner --no-same-permissions",
      "mv -T \"$STAGE_DIR\" \"$RELEASE_DIR\"",
      "chown -R root:papercusp \"$RELEASE_DIR\"",
      "chmod -R g-w,o-rwx \"$RELEASE_DIR\"",
      "find \"$RELEASE_DIR\" -type d -exec chmod g+rx {} +",
      "find \"$RELEASE_DIR\" -type f -exec chmod g+r {} +",
      "for entrypoint in $RELEASE_ENTRYPOINTS; do",
      "  [ -x \"$RELEASE_DIR/$entrypoint\" ] || { echo \"release bundle is missing executable entrypoint $entrypoint\" >&2; exit 1; }",
      "done",
      # `current` is deliberately NOT linked here. The atomic swap belongs to the bootstrap, after
      # it has run the database migration; linking it at build time would present an unmigrated
      # release as the live one.
      "[ ! -e /opt/papercusp/current ] || { echo '/opt/papercusp/current must not exist in a built image' >&2; exit 1; }",
    ]
  }

  # 6. Record the provenance inside the image as well as in its description, so a booted host can
  #    answer "which build am I?" without a Compute Engine API call.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    environment_vars = [
      "IMAGE_PROVENANCE=${base64encode(local.image_provenance)}",
    ]
    inline = [
      "set -Eeuo pipefail",
      "printf '%s' \"$IMAGE_PROVENANCE\" | base64 --decode > /etc/papercusp/image-provenance.json",
      "chown root:papercusp /etc/papercusp/image-provenance.json",
      "chmod 0640 /etc/papercusp/image-provenance.json",
      "jq -e . /etc/papercusp/image-provenance.json >/dev/null",
    ]
  }

  # 7. Leave nothing build-specific behind. A machine-id baked into an image is shared by every
  #    host cut from it, and a stale apt cache is dead weight in every future boot disk.
  provisioner "shell" {
    execute_command = "sudo -E bash -c '{{ .Vars }} {{ .Path }}'"
    inline = [
      "set -Eeuo pipefail",
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
      "cloud-init clean --logs --seed",
      "truncate -s 0 /etc/machine-id",
      "rm -f /var/lib/dbus/machine-id",
      "find /var/log -type f -exec truncate -s 0 {} +",
      "rm -rf /root/.ssh /home/packer 2>/dev/null || true",
      "sync",
    ]
  }
}
