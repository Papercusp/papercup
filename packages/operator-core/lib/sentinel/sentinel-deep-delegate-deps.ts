/**
 * sentinel-deep-delegate-deps — the real-substrate wiring of DeepDelegateDeps
 * (voice-unified-sentinel-pipeline-2026-07-01, P-006). Kept SEPARATE from the
 * dispatch core (sentinel-deep-delegate.ts) so the core unit-tests against
 * injected deps with no PG/spawn machinery — the same split the handoff lane
 * uses (operator-sentinel-handoff-deps.ts).
 *
 * Each dep maps onto an EXISTING substrate primitive — reuse, don't rebuild:
 *   - countOpenDelegations → one SQL count over engineer_issues keyed on the
 *                            feature-family row stamp (the durable marker).
 *   - createWorkItem       → work-items.createWorkItem (kind=`task`, tagged
 *                            tagged `deep-delegation` (the landing gate) +
 *                            stamped payload.deep_delegation, landing ALREADY
 *                            claimed by the pre-minted spawn id.
 *   - spawn                → fleet/operator-spawn.spawnAgentInHarness with a
 *                            pre-minted spawn id, role `bee` (the generic
 *                            brief-driven worker) at the `deep` tier; if launch
 *                            is refused before the nursery takes ownership, the
 *                            reserved claim is released back to the pool.
 */
import type { DeepDelegateDeps } from './sentinel-deep-delegate';
import { DEEP_DELEGATION_LABEL } from './sentinel-deep-delegate';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/** Default harness the background agent spawns into when the caller gave none:
 *  the operator HOME harness (where the sentinel itself lives) via the canonical
 *  resolver — env PAPERCUSP_HIVE_HOME_SLUG when set, else the standing default.
 *  Raw-env-only resolution left the staging process (no env) unable to mint the
 *  deep-delegation task at all ("no harness resolved", live 2026-07-01). */
function defaultSpawnHarness(): string | null {
  return operatorHomeHarnessSlug() || null;
}

export function defaultDeepDelegateDeps(): DeepDelegateDeps {
  return {
    async countOpenDelegations(workspaceId) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId}
             AND item_kind = 'task'
             AND status <> ALL(ARRAY['passed', 'deprecated', 'resolved', 'closed']::text[])
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
        const harness = input.harness ?? defaultSpawnHarness();
        if (!harness) {
          console.warn('[deep-delegate] no harness resolved for deep-delegation task create');
          return null;
        }
        const wi = await createWorkItem({
          kind: 'task',
          title: input.title,
          summary: input.summary,
          harness,
          workspaceId: input.workspaceId,
          topics: [DEEP_DELEGATION_LABEL],
          createdBy: 'sentinel-deep',
          payload: { deep_delegation: true },
          assignee: input.assignee,
        });
        return { id: wi.id, harness };
      } catch (err) {
        console.warn('[deep-delegate] work_item create failed:', (err as Error).message);
        return null;
      }
    },

    async spawn({ spawnId, workItemId, harness, brief, timeoutMs }) {
      try {
        const [{ spawnAgentInHarness }, { activeWorkspaceId }, { releaseWorkItem }] =
          await Promise.all([
            import('../fleet/operator-spawn'),
            import('../workspace-registry'),
            import('../work-items'),
          ]);
        const out = await spawnAgentInHarness({
          workspaceId: activeWorkspaceId(),
          harness,
          role: 'cup',
          spawnId,
          brief,
          tier: 'deep',
          timeoutMs,
          featureId: workItemId,
          itemId: workItemId,
        });
        if (!out.ok) {
          await releaseWorkItem(workItemId, { harness }).catch(() => {});
          return { ok: false, spawnId: out.spawnId ?? spawnId, error: out.error ?? 'spawn failed' };
        }
        return { ok: true, spawnId: out.spawnId ?? spawnId };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
      }
    },

    log: (msg) => console.log(`[deep-delegate] ${msg}`),
  };
}
