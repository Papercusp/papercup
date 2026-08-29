/**
 * Argument construction for the clean-room instance, split out of
 * papercusp-gcp-clean-room.mjs so it can be unit-tested.
 *
 * The binary itself ends in a top-level `await main(...)`, so importing it from a test
 * would execute the CLI. Keeping the argv builder in this side-effect-free module is what
 * makes the flags assertable without booting a VM — and a plumbed-but-unread field is
 * otherwise invisible until it costs a real cloud boot (EI-21744781090863686).
 */

export const DEFAULT_CLEAN_ROOM_MACHINE_TYPE =
  process.env.PAPERCUSP_CLEAN_ROOM_MACHINE_TYPE?.trim() || 'e2-standard-2';

/** GCP resource labels accept lowercase letters, digits, `-` and `_`, up to 63 chars. */
function labelValue(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 63);
}

/**
 * Build the argv for `gcloud compute instances create` for a clean-room boot.
 *
 * `subnetwork` is REQUIRED and load-bearing. `--no-address` gives the instance no external
 * IP, so its ONLY route off the box is Cloud NAT on the subnetwork it lands in. Omitting
 * `--subnet` silently places it on the project's `default` network, which has no NAT and no
 * Private Google Access — leaving the fixture's bootstrap.sh with zero egress for its
 * `apt-get install` and its ~273MB bundle + detached-signature download from the public
 * Cupboard URL. `WorkspaceHostBootstrapRelease` mandates PUBLIC HTTPS bundle/signature URLs
 * and offers no local-file source, so that egress is inherent to the contract, not a
 * configuration preference.
 *
 * This does NOT weaken the gate. The property the canary asserts is
 * `publicIpv4Assigned === false` — no public INGRESS. Cloud NAT is egress-only and leaves
 * that property exactly as it was.
 *
 * `role` labels WHICH private-VM run created the instance, because two different subjects
 * share this argv: the post-build canary (`clean-room`, boots the built image) and the
 * pre-build bootstrap acceptance run (`bootstrap-acceptance`, boots stock Ubuntu). They are
 * indistinguishable in the GCP console otherwise, which matters precisely when auditing a
 * leaked instance to find out which run failed to tear itself down.
 */
export function buildCleanRoomInstanceCreateArgs({
  instanceName,
  projectId,
  zone,
  imageName,
  imageProject,
  subnetwork,
  fixtureId,
  machineType = DEFAULT_CLEAN_ROOM_MACHINE_TYPE,
  role = 'clean-room',
}) {
  if (typeof subnetwork !== 'string' || subnetwork.trim() === '') {
    throw new Error(
      'subnetwork is required to build clean-room instance args: --no-address without a ' +
        'NAT-backed subnet leaves the guest with no egress for the bootstrap download',
    );
  }
  return [
    'compute',
    'instances',
    'create',
    instanceName,
    `--project=${projectId}`,
    `--zone=${zone}`,
    `--machine-type=${machineType}`,
    `--image=${imageName}`,
    `--image-project=${imageProject}`,
    `--subnet=${subnetwork.trim()}`,
    '--no-address',
    '--no-service-account',
    '--no-scopes',
    '--metadata=enable-oslogin=TRUE',
    `--labels=papercusp-artifact=workspace-host,papercusp-role=${labelValue(role)},papercusp-fixture=${labelValue(fixtureId)}`,
    '--quiet',
  ];
}
