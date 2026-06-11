/**
 * hive-publish.ts — the announce-on-publish adapter for the hive directory
 * (p2p-hive-directory-2026-06-06 P-004).
 *
 * P-004: "Hive create/edit surface carries title + description; creating (or
 * opting-in) a hive announces it. Opt-in flag per hive — private hives never
 * announce." The directory service (hive-directory.ts) already owns
 * register + announce; this is the thin adapter the create/edit surface calls to
 * map a saved hive's METADATA + the local OWNER identity into the directory's
 * `LocalHiveDescriptor`, then register + (when public/invite) announce it.
 *
 * Pure over the injected directory — unit-testable without a swarm. The actual
 * STORAGE of the hive metadata (title/description/visibility on the hive record)
 * + the create/edit FORM are the UI surface that calls this; the live broadcast
 * requires the substrate boot-join + transport (see hive-directory-deps.ts).
 */

import type { HiveDirectory } from './hive-directory';
import type { HiveVisibility } from './sync/hyperbee/hive-announce';

/** The directory-relevant metadata a hive carries (set on the create/edit surface). */
export interface HiveDirectoryMeta {
  hiveId: string;
  title: string;
  description: string;
  /** public = announce to the global topic; invite = invite-scoped topic only;
   *  private = never announce. Default for a directory-created hive: public. */
  visibility: HiveVisibility;
  /** Member harness swarm-topics (hex) — the display signal (how many harnesses). */
  memberTopics: string[];
  /**
   * The Hive's Ed25519 identity pubkey (raw-32-byte base64) — carried on the
   * announce so peers can DIAL this Hive for cross-Hive (P-006). Sourced at the
   * publish call-site from `loadHivePubkey(ws, hiveId)` (the `hives.public_key`
   * column); NOT persisted in the registry meta (it lives in the hives table).
   */
  hivePubkey?: string;
  /** Full `papercusp://harness?...` join links per member harness (one-click join). */
  memberLinks?: string[];
  /**
   * Member upstream repos, encoded `<owner>/<repo>[#<id>]` (hive-announce.ts) —
   * the repo→Hive binding signal (P-003). Derived FRESH at publish time via
   * `deriveHiveMemberRepoRefs` (like `hivePubkey`); NOT persisted in the
   * registry meta, so member additions surface on the next publish/boot.
   */
  memberRepos?: string[];
  /** Epoch-ms the hive was created (stable; for display + ordering). */
  createdAt: number;
  /** Required when visibility === 'invite' — the secret whose topic invitees join. */
  inviteSecret?: string;
}

/** The local device + GitHub identity that signs + owns the announce. */
export interface HiveOwnerIdentity {
  githubLogin: string;
  githubUserId: number;
  /** Raw 32-byte Ed25519 device pubkey, base64 (the binding convention). */
  devicePubkey: string;
  /** The P-011 device-attestation gist id (the channel-2 anchor browsers verify). */
  attestationGistId: string;
}

export interface PublishHiveResult {
  registered: boolean;
  announced: boolean;
  visibility: HiveVisibility;
}

/**
 * Register a hive this peer owns with the directory and announce it per its
 * visibility: `public` → the global topic, `invite` → its invite topic,
 * `private` → registered (so an edit→public re-announces) but NEVER announced.
 * Call this from the hive create/edit surface after saving metadata, and again
 * on any metadata change so the directory converges (P-003 "re-announce on hive
 * metadata change").
 */
export async function publishHiveToDirectory(
  dir: HiveDirectory,
  meta: HiveDirectoryMeta,
  owner: HiveOwnerIdentity,
): Promise<PublishHiveResult> {
  if (meta.visibility === 'invite' && !meta.inviteSecret) {
    throw new Error(`publishHiveToDirectory: hive ${meta.hiveId} is invite-visibility but has no inviteSecret`);
  }
  dir.registerLocalHive({
    hiveId: meta.hiveId,
    title: meta.title,
    description: meta.description,
    memberTopics: [...meta.memberTopics],
    ...(meta.hivePubkey ? { hivePubkey: meta.hivePubkey } : {}),
    ...(meta.memberLinks ? { memberLinks: [...meta.memberLinks] } : {}),
    ...(meta.memberRepos ? { memberRepos: [...meta.memberRepos] } : {}),
    visibility: meta.visibility,
    createdAt: meta.createdAt,
    ownerGithubLogin: owner.githubLogin,
    ownerGithubUserId: owner.githubUserId,
    ownerDevicePubkey: owner.devicePubkey,
    attestationGistId: owner.attestationGistId,
    ...(meta.inviteSecret ? { inviteSecret: meta.inviteSecret } : {}),
  });
  // private never announces (announceLocalHive returns null for it).
  const frame = await dir.announceLocalHive(meta.hiveId);
  return { registered: true, announced: frame !== null, visibility: meta.visibility };
}

/**
 * Stop announcing a hive (visibility flipped to `private`, or the hive deleted):
 * drop it from the owned set so the re-announce timer no longer broadcasts it.
 * (Discovered peers age out of others' directories via the TTL — there is no
 * un-announce frame; ceasing to re-announce is the withdrawal.)
 */
export function unpublishHiveFromDirectory(dir: HiveDirectory, hiveId: string): void {
  dir.unregisterLocalHive(hiveId);
}
