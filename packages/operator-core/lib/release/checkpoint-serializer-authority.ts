/**
 * The exact D-012/D-013 quiescence + D-016 serializer fence for the manual
 * green-checkpoint lever.
 *
 * The paused-gate watchdog originally owned this predicate only as an alarm
 * suppression rule. That left the write side unenforced: a non-serializer could
 * pass `force:true` to release:checkpoint-run while the same durable hold was
 * active and start a pre-admission run. Keep one typed interpretation of the
 * existing routine pause + work-item hold and reuse it on both sides.
 */
import { getOrgPg } from '@papercusp/db-org';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { activeWorkspaceId } from '../workspace-registry';

export const CHECKPOINT_QUIESCENCE_PAUSE_MARKER = 'D-012/D-013 live quiescence hold under ';
export const CHECKPOINT_SERIALIZER_HOLD_REASON_PREFIX = 'D-016 sole serializer hold:';

export interface CheckpointSerializerAuthorityEvidence {
  active: boolean | null;
  groupSlug: string | null;
  targetRole: string | null;
  pauseReason: string | null;
  serializerItemId: string | null;
  serializerClaimHold: boolean | null;
  serializerOwner: string | null;
  serializerHoldReason: string | null;
}

export type CheckpointSerializerAuthority =
  | {
      status: 'held';
      itemId: string;
      ownerId: string;
      pauseReason: string;
      holdReason: string;
    }
  | {
      status: 'none';
      reason:
        | 'routine-not-paused'
        | 'not-release-checkpoint'
        | 'pause-not-quiescence'
        | 'serializer-item-mismatch'
        | 'claim-hold-absent'
        | 'serializer-owner-absent'
        | 'serializer-reason-mismatch'
        | 'routine-not-found';
    }
  | { status: 'unreadable'; error: string };

export function checkpointQuiescenceItemId(pauseReason: string | null): string | null {
  if (!pauseReason?.startsWith(CHECKPOINT_QUIESCENCE_PAUSE_MARKER)) return null;
  return pauseReason.slice(CHECKPOINT_QUIESCENCE_PAUSE_MARKER.length).match(/^((?:WI|EI)-\d+):/)?.[1] ?? null;
}

/** Pure classification shared by the paused watchdog and the launch guard. */
export function classifyCheckpointSerializerAuthority(
  evidence: CheckpointSerializerAuthorityEvidence,
): CheckpointSerializerAuthority {
  if (evidence.active !== false) return { status: 'none', reason: 'routine-not-paused' };
  if (evidence.groupSlug !== 'release' || evidence.targetRole !== 'system:green-checkpoint') {
    return { status: 'none', reason: 'not-release-checkpoint' };
  }
  const itemId = checkpointQuiescenceItemId(evidence.pauseReason);
  if (!itemId) return { status: 'none', reason: 'pause-not-quiescence' };
  if (evidence.serializerItemId !== itemId) return { status: 'none', reason: 'serializer-item-mismatch' };
  if (evidence.serializerClaimHold !== true) return { status: 'none', reason: 'claim-hold-absent' };
  if (!evidence.serializerOwner) return { status: 'none', reason: 'serializer-owner-absent' };
  if (!evidence.serializerHoldReason?.startsWith(CHECKPOINT_SERIALIZER_HOLD_REASON_PREFIX)) {
    return { status: 'none', reason: 'serializer-reason-mismatch' };
  }
  return {
    status: 'held',
    itemId,
    ownerId: evidence.serializerOwner,
    pauseReason: evidence.pauseReason!,
    holdReason: evidence.serializerHoldReason,
  };
}

type AuthorityRow = {
  active: boolean | null;
  group_slug: string | null;
  target_role: string | null;
  pause_reason: string | null;
  serializer_item_id: string | null;
  serializer_claim_hold: boolean | null;
  serializer_owner: string | null;
  serializer_hold_reason: string | null;
};

/**
 * Read the current operator-home serializer fence. Fail closed on an unreadable
 * store: a verification run cannot produce a trustworthy release verdict while
 * the store that owns its exclusive authority is unavailable.
 */
export async function readCheckpointSerializerAuthority(
  opts: {
    installSlug?: string;
    workspaceId?: string;
  } = {},
): Promise<CheckpointSerializerAuthority> {
  const installSlug = opts.installSlug?.trim() || operatorHomeHarnessSlug();
  const workspaceId = opts.workspaceId?.trim() || activeWorkspaceId();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<AuthorityRow[]>`
      SELECT r.active,
             r.group_slug,
             r.target_role,
             r.metadata->'pause'->>'reason' AS pause_reason,
             serializer.feature_id AS serializer_item_id,
             serializer.claim_hold AS serializer_claim_hold,
             serializer.held_open_by AS serializer_owner,
             serializer.held_open_reason AS serializer_hold_reason
        FROM harness_shared.routines r
        LEFT JOIN LATERAL (
          SELECT wi.feature_id,
                 (wi.payload->>'_claimHold') = 'true' AS claim_hold,
                 wi.payload->>'held_open_by' AS held_open_by,
                 wi.payload->>'held_open_reason' AS held_open_reason
            FROM harness_shared.work_items wi
           WHERE wi.workspace_id = r.workspace_id
             AND wi.harness_slug = r.install_slug
             AND wi.feature_id = substring(
                   r.metadata->'pause'->>'reason'
                   FROM '^D-012/D-013 live quiescence hold under ((WI|EI)-[0-9]+):'
                 )
           ORDER BY wi.updated_ts DESC NULLS LAST
           LIMIT 1
        ) serializer ON true
       WHERE r.workspace_id = ${workspaceId}
         AND r.install_slug = ${installSlug}
         AND r.name = 'green-checkpoint'
         AND r.group_slug = 'release'
         AND r.target_role = 'system:green-checkpoint'
       LIMIT 1`;
    const row = rows[0];
    if (!row) return { status: 'none', reason: 'routine-not-found' };
    return classifyCheckpointSerializerAuthority({
      active: row.active,
      groupSlug: row.group_slug,
      targetRole: row.target_role,
      pauseReason: row.pause_reason,
      serializerItemId: row.serializer_item_id,
      serializerClaimHold: row.serializer_claim_hold,
      serializerOwner: row.serializer_owner,
      serializerHoldReason: row.serializer_hold_reason,
    });
  } catch (err) {
    return {
      status: 'unreadable',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    };
  }
}
