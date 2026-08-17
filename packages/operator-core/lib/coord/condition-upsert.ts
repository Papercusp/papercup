/**
 * condition-upsert.ts — WI-39594: the detector/seeder filing upsert.
 *
 * A recurring DETECTOR EMISSION (a seeder re-pass, a gate RED, a sweep finding)
 * must refresh the ONE open work-item that owns its condition, not file a
 * sibling per emission. Migration 741's partial unique index
 * (`work_items_condition_key_uq` on (workspace_id, harness_slug, condition_key)
 * WHERE condition_key IS NOT NULL) already makes that race-proof; this module is
 * the thin filing seam that lets an ORDINARY create site use it without joining
 * the condition-bridge's reconciler lifecycle.
 *
 * HOW IT DIFFERS FROM `acquireConditionOwner` (condition-bridge.ts) — deliberately:
 *   • no opt-in catalog: the bridge's ACTIONABLE_CONDITIONS gates which WATCHDOG
 *     conditions may mint items on the reconciler tick; a filing site that calls
 *     THIS function has already decided to file — the key is its identity, not a
 *     policy question.
 *   • REFRESH on adopt: the bridge adopts an incumbent silently (its tick has no
 *     new reading). A detector emission IS a new reading, so the incumbent's
 *     title/summary refresh to it and an occurrence counter bumps — the
 *     queue-audit-2026-08-17 ruling ("the NEWEST item per condition is kept open").
 *   • no auto-settle marker: these items close when someone fixes them, not when
 *     a condition clears; nothing here participates in releaseConditionOwner's
 *     settle path.
 *
 * ⚠ KEY DESIGN: the caller's key should embed everything that makes the
 * condition unique WITHIN A WORKSPACE (e.g. `spec-triad:<harness>/<plan>`).
 * Ownership reads here are workspace-scoped and deliberately NOT harness-scoped:
 * `createWorkItem` → `createIssue` normalizes a member harness to its Pot home
 * slug before the row lands, so a harness-scoped read with the caller's slug can
 * miss the very row a previous call stored (the measured oddsmith→oddsmith-hive
 * re-mint loop, EI-19407969585168294). A workspace-scoped read of a
 * workspace-unique key cannot.
 *
 * ⚠ Do NOT use this for a producer whose rows FEDERATE IN from other machines
 * (e.g. the episodic-ei detectors): two machines minting the same key
 * independently is resolved there by the duplicate-collapse retirement pass, and
 * a hard unique claim on the ingest path is the wrong tool. This seam is for
 * single-host system filers (routines, gates, seeders).
 */
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem, setWorkItemState, type CreateWorkItemInput } from '../work-items';
import { claimConditionKey, findConditionKeyHolder, releaseStaleConditionKeys } from './condition-bridge';

/** Lifecycle actor for the lost-race stand-down close (see CONDITION_BRIDGE_ACTOR
 *  for why an anonymous terminal transition is refused by the completion gate). */
export const CONDITION_UPSERT_ACTOR = 'system:condition-upsert' as const;

/** Payload key stamping occurrence state on the owning row. */
export const CONDITION_UPSERT_MARKER = '_conditionUpsert';

export interface ConditionUpsertResult {
  conditionKey: string;
  /** The work-item that owns the condition after this call. */
  id: string | null;
  /** True when THIS call created the row; false = refreshed an incumbent. */
  created: boolean;
  /** Set when a lost claim race left our optimistically-minted row open. */
  duplicateLeftOpen?: string;
}

/**
 * Refresh the incumbent with the newest reading: bump the occurrence counter,
 * stamp lastSeenAt, and replace title/summary. Returns false when the row
 * vanished between the read and the write (caller treats it as a miss).
 */
async function refreshIncumbent(
  id: string,
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId'>,
): Promise<boolean> {
  const sql = getOrgPg().sql;
  const marker = CONDITION_UPSERT_MARKER;
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET title = ${input.title},
           summary = COALESCE(${input.summary ?? null}::text, summary),
           updated_ts = (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
           payload = jsonb_set(
             COALESCE(payload, '{}'::jsonb),
             ARRAY[${marker}::text],
             jsonb_build_object(
               'conditionKey', ${conditionKey}::text,
               'occurrences', COALESCE((payload -> ${marker}::text ->> 'occurrences')::int, 1) + 1,
               'lastSeenAt', to_jsonb(now())
             ),
             true
           )
     WHERE feature_id = ${id}
       AND condition_key = ${conditionKey}
       AND (${input.workspaceId ?? null}::text IS NULL OR workspace_id = ${input.workspaceId ?? null})
    RETURNING feature_id`;
  return rows.length > 0;
}

/**
 * ADOPT half (exported for the WI-39604 tool-path leg): self-heal a wedged key,
 * then refresh-and-return the open incumbent holding `conditionKey` — or null
 * when no adoptable incumbent exists (including the row vanishing between the
 * holder read and the refresh write, which a caller must treat as a miss and
 * mint fresh rather than returning a dangling id).
 */
export async function adoptConditionIncumbent(
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId'>,
): Promise<string | null> {
  const key = conditionKey.trim();
  if (!key) throw new Error('adoptConditionIncumbent: empty conditionKey');
  // Self-heal a missed key release so a settled row can never wedge the key.
  await releaseStaleConditionKeys(key, input.workspaceId);
  // Adopt-and-refresh the incumbent. Workspace-scoped on purpose — see header.
  const holder = await findConditionKeyHolder(key, { workspaceId: input.workspaceId });
  if (!holder) return null;
  const refreshed = await refreshIncumbent(holder, key, input);
  return refreshed ? holder : null;
}

/** Outcome of claiming `conditionKey` for a freshly-minted row. */
export type ConditionClaimSettlement =
  | { won: true }
  | { won: false; winnerId: string | null; duplicateLeftOpen?: string };

/**
 * CLAIM half (exported for the WI-39604 tool-path leg): claim `conditionKey`
 * for the row this caller just minted. On a lost race the incumbent winner is
 * refreshed with this reading and the caller's own row is settled (dropped);
 * a failed stand-down is reported as `duplicateLeftOpen`, never swallowed.
 */
export async function settleConditionClaim(
  itemId: string,
  conditionKey: string,
  input: Pick<CreateWorkItemInput, 'title' | 'summary' | 'workspaceId' | 'harness'>,
): Promise<ConditionClaimSettlement> {
  const key = conditionKey.trim();
  const won = await claimConditionKey(itemId, key, input.workspaceId);
  if (won) return { won: true };

  // A peer won the race: refresh THEIR row with this reading, settle ours.
  const winner = await findConditionKeyHolder(key, { workspaceId: input.workspaceId });
  if (winner) await refreshIncumbent(winner, key, input);
  let droppedOk = false;
  try {
    await setWorkItemState(itemId, 'dropped', {
      harness: input.harness,
      by: CONDITION_UPSERT_ACTOR,
      completionRef: `superseded by ${winner ?? 'the concurrent owner'} — lost the condition-key claim race for '${key}'`,
    });
    droppedOk = true;
  } catch {
    // Reported, never swallowed silently — the caller can see the duplicate.
  }
  return { won: false, winnerId: winner ?? null, ...(droppedOk ? {} : { duplicateLeftOpen: itemId }) };
}

/**
 * File-or-refresh the work-item owning `conditionKey`.
 *
 * Idempotent under re-fire and race-proof under concurrent filers: create is
 * optimistic (mint, then claim the key); the 741 unique index serializes the
 * winner, and the loser settles its own row and adopts the incumbent — the same
 * shape `acquireConditionOwner` proves out, minus catalog and lifecycle.
 * Composed from the two exported halves above so the tool path (`work_items:
 * create { conditionKey }`, WI-39604) and this module-level filer cannot drift.
 */
export async function upsertConditionWorkItem(
  conditionKey: string,
  input: CreateWorkItemInput,
): Promise<ConditionUpsertResult> {
  const key = conditionKey.trim();
  if (!key) throw new Error('upsertConditionWorkItem: empty conditionKey');

  const incumbent = await adoptConditionIncumbent(key, input);
  if (incumbent) return { conditionKey: key, id: incumbent, created: false };

  // Mint, then claim. Optimistic on purpose — a check-then-act "is there one
  // already?" is the exact shape that raced 40-of-88 rows into duplicates
  // (WI-6986); the unique index needs no check at all.
  const item = await createWorkItem({
    ...input,
    payload: {
      ...((input.payload as Record<string, unknown> | undefined) ?? {}),
      [CONDITION_UPSERT_MARKER]: {
        conditionKey: key,
        occurrences: 1,
        lastSeenAt: new Date().toISOString(),
      },
    },
  });

  const settled = await settleConditionClaim(item.id, key, input);
  if (settled.won) return { conditionKey: key, id: item.id, created: true };
  return {
    conditionKey: key,
    id: settled.winnerId ?? item.id,
    created: false,
    ...(settled.duplicateLeftOpen ? { duplicateLeftOpen: settled.duplicateLeftOpen } : {}),
  };
}
