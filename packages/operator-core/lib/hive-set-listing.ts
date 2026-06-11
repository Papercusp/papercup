/**
 * hive-set-listing — the one create/edit/visibility-flip composition for a
 * hive's directory listing (p2p-hive-directory P-004 + hive-from-github-url
 * P-015), shared by the `discovery:set_hive` MCP tool and the
 * `POST /api/discovery/set-hive` HTTP route (the hive header strip's flip).
 *
 *   save meta → private: withdraw (stop re-announce + Cupboard unlist)
 *             → public/invite: full publish set via republishHiveAfterMemberAdd
 *               (announce w/ pubkey + member_repos + links; Cupboard rows for
 *               public — existing rows count as rowsExisted; local bindings)
 */

import { saveOwnedHiveMeta } from './hive-directory-meta';
import type { HiveDirectoryMeta } from './hive-publish';
import { getHiveDirectory } from './hive-directory-deps';

export interface SetHiveListingInput {
  hiveId: string;
  title: string;
  description?: string;
  visibility: HiveDirectoryMeta['visibility'];
  memberTopics?: string[];
  memberLinks?: string[];
  inviteSecret?: string;
  createdAt?: number;
}

export interface SetHiveListingResult {
  ok: true;
  hiveId: string;
  visibility: HiveDirectoryMeta['visibility'];
  saved: true;
  announced: boolean;
  withdrawn?: boolean;
  cupboardUnlist?: Record<string, unknown>;
  publish?: Record<string, unknown>;
  announceError?: string;
}

export async function setHiveListing(
  input: SetHiveListingInput,
  workspaceId: string,
): Promise<SetHiveListingResult> {
  const meta: HiveDirectoryMeta = {
    hiveId: input.hiveId,
    title: input.title,
    description: input.description ?? '',
    workspaceId, // P-004: the announce-build enricher derives against this
    visibility: input.visibility,
    memberTopics: input.memberTopics ?? [],
    ...(input.memberLinks ? { memberLinks: input.memberLinks } : {}),
    createdAt: input.createdAt ?? Date.now(),
    ...(input.inviteSecret ? { inviteSecret: input.inviteSecret } : {}),
  };

  // Persist the listing (durable — survives restart, read by the boot-join).
  await saveOwnedHiveMeta(meta, workspaceId);

  // P-015: visibility:private is the WITHDRAWAL flip — stop re-announcing
  // (peers age the listing out via TTL) and unlist the member-repo Cupboard
  // rows. Both best-effort.
  if (meta.visibility === 'private') {
    let unlist: Record<string, unknown> | undefined;
    try {
      const { unpublishHiveFromDirectory } = await import('./hive-publish');
      unpublishHiveFromDirectory(getHiveDirectory(), meta.hiveId);
    } catch {
      /* directory not wired — nothing was announcing */
    }
    try {
      const { unlistHiveCupboardRows } = await import('./cupboard/unlist-hive-rows');
      unlist = (await unlistHiveCupboardRows({
        workspaceId,
        hiveSlug: meta.hiveId,
      })) as unknown as Record<string, unknown>;
    } catch (e) {
      unlist = { failed: true, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      ok: true,
      hiveId: meta.hiveId,
      visibility: 'private',
      saved: true,
      announced: false,
      withdrawn: true,
      ...(unlist ? { cupboardUnlist: unlist } : {}),
    };
  }

  // public/invite: the FULL publish set (P-007/P-015) rides
  // republishHiveAfterMemberAdd — pubkey + member_repos enrichment, the
  // directory announce, per-member-repo Cupboard rows (public; existing rows
  // count as rowsExisted) + local binding rows. Lazily wire the transport
  // first (a box that gh-authed after boot).
  let announced = false;
  let publishOutcome: Record<string, unknown> | undefined;
  let announceError: string | undefined;
  try {
    const { ensureHiveDirectoryWired } = await import('./hive-directory-boot');
    await ensureHiveDirectoryWired(workspaceId).catch(() => null);
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const res = await republishHiveAfterMemberAdd({ workspaceId, hiveSlug: meta.hiveId });
    if ('skipped' in res) {
      announceError = `publish skipped: ${res.skipped}`;
    } else {
      announced = res.announced;
      publishOutcome = res as unknown as Record<string, unknown>;
    }
  } catch (e) {
    announceError = e instanceof Error ? e.message : String(e);
  }

  return {
    ok: true,
    hiveId: meta.hiveId,
    visibility: meta.visibility,
    saved: true,
    announced,
    ...(publishOutcome ? { publish: publishOutcome } : {}),
    ...(announceError ? { announceError } : {}),
  };
}
