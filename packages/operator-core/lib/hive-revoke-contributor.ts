/**
 * hive-revoke-contributor — OWNER revocation of a Hive contributor
 * (shared-hive-federation-2026-06-08 P-006, D-004). The Hive-scope generalization
 * of substrate:revoke_contributor.
 *
 * Like the per-harness revoke (sync/hyperbee/revoke-contributor.ts), revocation is
 * the only blocklist: the owner adds the TARGET's device pubkeys to the OWNER's OWN
 * hive_members row's revoked_pubkeys (single-writer), and the admission union
 * (loadRevokedHivePubkeys) denies the target on every peer's next admission pass.
 *
 * AUTHORITY — Hive-native, not gh-repo-admin. A Hive is keypair-identified (D-002)
 * and may be repo-less (pots default repo-less), so the harness model's gh-repo-admin
 * gate doesn't fit. The Hive owner is the Swarm that HOLDS the Hive private key
 * (identity/hive-keypair.ts) — `loadHivePubkey` returns non-null only there. That is
 * the natural owner gate and reuses the Phase-0 keypair.
 *
 * FEDERATION — the PG write (addRevokedHivePubkeys) is the LOCAL effect; replicating
 * the owner's row over the Hive peer-log is the substrate's job (P-004). The
 * `publishRevocation` seam is where the P-004 wiring adds the peer-log publish; the
 * default does the PG write so the local admission union is correct immediately.
 *
 * All collaborators-with-PG seams are injectable for hermetic unit tests.
 */

import { loadHivePubkey } from './identity/hive-keypair';
import { loadHiveMemberDevicePubkeys, addRevokedHivePubkeys } from './hive-membership-store';

export type RevokeHiveContributorResult =
  | {
      ok: true;
      /** The target device pubkeys added to the Hive's revoked set. */
      revokedPubkeys: string[];
      /** True when a booted Hive handle applied the revoke live; false when only
       *  the PG row write happened (effective on the next admission union load). */
      live: boolean;
    }
  | { ok: false; code: 'bad_target' | 'not_owner' | 'no_owner_identity' | 'no_target' | 'no_owner_row' | 'revoke_failed'; detail?: string };

export interface RevokeHiveContributorInput {
  workspaceId: string;
  /** The Hive's home_slug (its hives PK handle). */
  hiveHomeSlug: string;
  /** Numeric GitHub user id of the contributor to revoke. Positive integer. */
  githubUserId: number;
}

export interface RevokeHiveContributorSeams {
  /** Is THIS Swarm the Hive owner (holds the Hive private key)? Default: loadHivePubkey != null. */
  isOwningSwarm?: (workspaceId: string, hiveHomeSlug: string) => Promise<boolean>;
  /** The local owner's numeric GitHub id (whose row holds the revoked set). */
  resolveOwnerGithubUserId?: () => Promise<number | null>;
  /** The target member's device pubkeys (the things to revoke). */
  loadTargetPubkeys?: (workspaceId: string, hiveHomeSlug: string, githubUserId: number) => Promise<string[]>;
  /** Add `pubkeys` to the owner's own row + (P-004) federate. Throws if the owner has no row. */
  publishRevocation?: (
    workspaceId: string,
    hiveHomeSlug: string,
    ownerGithubUserId: number,
    pubkeys: string[],
  ) => Promise<{ live: boolean }>;
}

export async function revokeHiveContributor(
  input: RevokeHiveContributorInput,
  seams: RevokeHiveContributorSeams = {},
): Promise<RevokeHiveContributorResult> {
  if (!Number.isInteger(input.githubUserId) || input.githubUserId <= 0) {
    return { ok: false, code: 'bad_target', detail: 'githubUserId must be a positive integer' };
  }

  const {
    isOwningSwarm = (ws, slug) => loadHivePubkey(ws, slug).then((pk) => pk !== null),
    resolveOwnerGithubUserId = realResolveOwnerGithubUserId,
    loadTargetPubkeys = loadHiveMemberDevicePubkeys,
    publishRevocation = realPublishRevocation,
  } = seams;

  // 1. Owner gate: only the Swarm that holds the Hive secret may revoke.
  if (!(await isOwningSwarm(input.workspaceId, input.hiveHomeSlug))) {
    return { ok: false, code: 'not_owner' };
  }

  // 2. Resolve the local owner identity (whose row carries the revoked set).
  const ownerGithubUserId = await resolveOwnerGithubUserId();
  if (ownerGithubUserId == null) return { ok: false, code: 'no_owner_identity' };

  // 3. Resolve the target's device pubkeys.
  let pubkeys: string[];
  try {
    pubkeys = await loadTargetPubkeys(input.workspaceId, input.hiveHomeSlug, input.githubUserId);
  } catch (err: unknown) {
    return { ok: false, code: 'revoke_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (pubkeys.length === 0) return { ok: false, code: 'no_target' };

  // 4. Publish: add to the owner's own row (federates via the Hive peer-log, P-004).
  try {
    const { live } = await publishRevocation(
      input.workspaceId,
      input.hiveHomeSlug,
      ownerGithubUserId,
      pubkeys,
    );
    return { ok: true, revokedPubkeys: pubkeys, live };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/no.*row/i.test(detail)) return { ok: false, code: 'no_owner_row', detail };
    return { ok: false, code: 'revoke_failed', detail };
  }
}

// ─── real default seams ───────────────────────────────────────────────────────

async function realResolveOwnerGithubUserId(): Promise<number | null> {
  const { resolveLocalGithubIdentity } = await import('./identity/resolve-local-github-identity');
  const identity = await resolveLocalGithubIdentity();
  return identity.kind === 'ok' ? identity.githubUserId : null;
}

async function realPublishRevocation(
  workspaceId: string,
  hiveHomeSlug: string,
  ownerGithubUserId: number,
  pubkeys: string[],
): Promise<{ live: boolean }> {
  const row = await addRevokedHivePubkeys(workspaceId, hiveHomeSlug, ownerGithubUserId, pubkeys);
  if (!row) {
    throw new Error('owner has no hive_members row — join the Hive before revoking');
  }
  // PG row written (local admission union is now correct). The Hive peer-log publish
  // that replicates it to peers is wired by the P-004 substrate re-key.
  return { live: false };
}
