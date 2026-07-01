/**
 * sentinel-deep-delegate-deps — the real-substrate wiring of DeepDelegateDeps
 * (voice-unified-sentinel-pipeline-2026-07-01, P-006). Kept SEPARATE from the
 * dispatch core (sentinel-deep-delegate.ts) so the core unit-tests against
 * injected deps with no PG/spawn machinery — the same split the handoff lane
 * uses (operator-sentinel-handoff-deps.ts).
 *
 * Each dep maps onto an EXISTING substrate primitive — reuse, don't rebuild:
 *   - countOpenDelegations → one SQL count over engineer_issues keyed on the
 *                            payload.deep_delegation stamp (the durable marker).
 *   - createWorkItem       → work-items.createWorkItem (kind=`task`, issue-family
 *                            ON PURPOSE: a feature-family item would enter the
 *                            Queen's placement frontier and double-execute
 *                            alongside our direct spawn). Tagged
 *                            `deep-delegation` (the landing gate) + stamped
 *                            payload.deep_delegation.
 *   - spawn                → fleet/operator-spawn.spawnAgentInHarness with a
 *                            pre-minted spawn id + work-items.claimWorkItem (the
 *                            same reserve-claim-launch order fleet:spawn uses),
 *                            role `bee` (the generic brief-driven worker) at the
 *                            `deep` tier.
 */
import { randomUUID } from 'node:crypto';
import type { DeepDelegateDeps } from './sentinel-deep-delegate';
import { DEEP_DELEGATION_LABEL } from './sentinel-deep-delegate';

/** Default harness the background agent spawns into when the caller gave none:
 *  the hive home (where the sentinel itself lives), else the workspace default
 *  resolution inside spawnAgentInHarness (single-harness workspaces). */
function defaultSpawnHarness(): string | null {
  return process.env.PAPERCUSP_HIVE_HOME_SLUG?.trim() || null;
}

export function defaultDeepDelegateDeps(): DeepDelegateDeps {
  return {
    async countOpenDelegations(workspaceId) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM harness_shared.engineer_issues
           WHERE workspace_id = ${workspaceId}
             AND state = 'open'
             AND payload->>'deep_delegation' = 'true'
        `;
        return rows[0]?.n ?? 0;
      } catch (err) {
        console.warn('[deep-delegate] open-count failed:', (err as Error).message);
        return 0;
      }
    },

    async createWorkItem(input) {
      try {
        const { createWorkItem } = await import('../work-items');
        const wi = await createWorkItem({
          kind: 'task',
          title: input.title,
          summary: input.summary,
          harness: input.harness ?? undefined,
          workspaceId: input.workspaceId,
          topics: [DEEP_DELEGATION_LABEL],
          createdBy: 'sentinel-deep',
          payload: { deep_delegation: true },
        });
        return { id: wi.id };
      } catch (err) {
        console.warn('[deep-delegate] work_item create failed:', (err as Error).message);
        return null;
      }
    },

    async spawn({ workItemId, harness, brief }) {
      try {
        const [{ spawnAgentInHarness }, { claimWorkItem }, { activeWorkspaceId }] =
          await Promise.all([
            import('../fleet/operator-spawn'),
            import('../work-items'),
            import('../workspace-registry'),
          ]);
        const spawnHarness = harness ?? defaultSpawnHarness();
        // Reserve → claim → launch, the same order fleet:spawn uses, so the item
        // never looks unowned between the create and the boot.
        const spawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const claim = await claimWorkItem(workItemId, spawnId, {
          harness: spawnHarness ?? undefined,
        });
        if (!claim) return { ok: false, error: `could not claim ${workItemId} for the spawn` };
        const out = await spawnAgentInHarness({
          workspaceId: activeWorkspaceId(),
          harness: spawnHarness,
          role: 'bee',
          spawnId,
          brief,
          tier: 'deep',
        });
        if (!out.ok) return { ok: false, spawnId: out.spawnId ?? spawnId, error: out.error ?? 'spawn failed' };
        return { ok: true, spawnId: out.spawnId ?? spawnId };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    },

    log: (msg) => console.log(`[deep-delegate] ${msg}`),
  };
}
