/**
 * redundancy-two-swarm.integration.test.ts — P-007 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: BOINC redundancy with TWO swarm
 * identities on the hermetic composition rig (flag-ON shape).
 *
 * What runs REAL here: the redundancy marker federating A→B (the dispatch
 * columns ride the wire — audit P-068), claim_next SKIPPING the high-stakes
 * item (excludeRedundant), the mig-195 replica store's per-slot atomic
 * claim/steal/record on real PG, the deterministic winner pick, the injected
 * zero-LLM judge (`judgeRedundancyGroup` with a fake `llmCall` — the gym
 * pattern), the winner adoption settling the item, and the settled status
 * federating back to the other swarm.
 *
 * ## Composition finding (recorded as the plan's D-009)
 * `work_item_replicas` is LOCAL-ONLY: no capture trigger (not federated) and
 * no authority-op routing (unlike work_item_claims) — so on two separate-PG
 * swarms the replica fan-out never meets: each swarm would claim slot 0 of
 * its OWN table and each judge would see one replica ('insufficient-
 * replicas'). Cross-swarm redundancy therefore requires the replica store to
 * be AUTHORITY-HOMED (or federated). This test models that intended shape —
 * both swarm identities operate on the authority cell's store — which is
 * exactly what an authority-op routing layer (the work-item-claims pattern)
 * would produce. Building that routing is the production follow-up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import {
  claimReplicaSlot,
  judgeRedundancyGroup,
  listReplicas,
  recordReplicaResult,
} from '../work-item-redundancy';
import type { JudgeLlmCall } from '../gym/primitives';

vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('./cell-scope');
  return {
    ...actual,
    getOrgPg: () => {
      const sql = currentCellSql();
      if (!sql) throw new Error('getOrgPg outside cell scope — wrap the call in rig.runAsCell()');
      return { sql };
    },
  };
});

let rig: CompositionRig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

/** Deterministic zero-LLM judge: a trace carrying GOLD outscores the rest. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const blob = opts.messages.map((m) => m.content).join('\n');
  const c = blob.includes('GOLD-STANDARD') ? 9 : 5;
  return {
    text: JSON.stringify({ d1: c, d2: c, d3: c, rationale: `fake redundancy judge (score ${c})` }),
    costUsd: 0,
    inputTokens: 10,
    outputTokens: 10,
  };
};

describe('P-007 — redundancy E2E across two swarm identities (authority-homed replica store)', () => {
  it(
    'redundancy marker federates; claim_next skips it; two swarms hold distinct slots; judge adopts the deterministic winner; adoption federates; a crashed holder is stolen',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-red' });
      const { a, b } = rig.cells;
      const HARNESS = 'shl-red';

      // ── Seed: one high-stakes item (redundancy=2) + one normal item. ──
      await rig.seedBacklog(a, [{ id: 'F-401', redundancy: 2 }, { id: 'F-402' }]);
      expect((await rig.converge()).fixedPoint).toBe(true);

      // The redundancy marker FEDERATED (dispatch-columns tripwire #2): B's PG
      // must see redundancy=2, or B's claim_next would exactly-once-claim it.
      const bRed = await b.sql<Array<{ redundancy: number | null }>>`
        SELECT redundancy FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${HARNESS} AND feature_id = 'F-401'`;
      expect(bRed[0]?.redundancy, 'redundancy marker did not federate to swarm B').toBe(2);

      // ── claim_next on B SKIPS the high-stakes item (it fans out instead). ──
      const cb = await rig.claimNext(b);
      expect(cb?.item.id).toBe('F-402');
      await rig.runFakePipeline(b, 'F-402');

      // ── Replica fan-out: both swarm identities claim DISTINCT slots on the
      //    authority-homed store (cell a's PG — see header re D-009). ──
      const slotA = await rig.runAsCell(a, () =>
        claimReplicaSlot({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-401',
          owner: a.owner,
          holderPubkey: a.electionPubkey,
        }),
      );
      const slotB = await rig.runAsCell(a, () =>
        claimReplicaSlot({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-401',
          owner: b.owner,
          holderPubkey: b.electionPubkey,
        }),
      );
      expect(slotA).toMatchObject({ ok: true, reused: false, replica: { replicaIndex: 0, owner: a.owner } });
      expect(slotB).toMatchObject({ ok: true, reused: false, replica: { replicaIndex: 1, owner: b.owner } });
      // Idempotent re-claim returns the held slot; a third swarm is refused.
      const again = await rig.runAsCell(a, () =>
        claimReplicaSlot({ workspaceId: rig!.workspaceId, harnessSlug: HARNESS, workItemId: 'F-401', owner: b.owner }),
      );
      expect(again).toMatchObject({ ok: true, reused: true, replica: { replicaIndex: 1 } });
      const third = await rig.runAsCell(a, () =>
        claimReplicaSlot({ workspaceId: rig!.workspaceId, harnessSlug: HARNESS, workItemId: 'F-401', owner: 'swarm-c' }),
      );
      expect(third).toMatchObject({ ok: false, reason: 'all-slots-held' });

      // ── Both record results; the judge adopts the deterministic winner. ──
      const recA = await rig.runAsCell(a, () =>
        recordReplicaResult({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-401',
          replicaIndex: 0,
          owner: a.owner,
          result: { text: 'replica A: adequate solution' },
        }),
      );
      const recB = await rig.runAsCell(a, () =>
        recordReplicaResult({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-401',
          replicaIndex: 1,
          owner: b.owner,
          result: { text: 'replica B: GOLD-STANDARD solution' },
        }),
      );
      expect(recA?.status).toBe('complete');
      expect(recB?.status).toBe('complete');

      const judged = await rig.runAsCell(a, () =>
        judgeRedundancyGroup(
          { workspaceId: rig!.workspaceId, harness: HARNESS, workItemId: 'F-401' },
          { llmCall: fakeJudge },
        ),
      );
      expect(judged.ok).toBe(true);
      if (judged.ok) {
        expect(judged.winner).toMatchObject({ replicaIndex: 1, owner: b.owner });
        expect(judged.scores).toHaveLength(2);
      }
      const rows = await rig.runAsCell(a, () => listReplicas('F-401', { harness: HARNESS, workspaceId: rig!.workspaceId }));
      expect(rows.map((r) => [r.replicaIndex, r.status])).toEqual([
        [0, 'loser'],
        [1, 'winner'],
      ]);

      // ── Adoption federates: the settled status reaches swarm B's PG. ──
      expect((await rig.converge()).fixedPoint).toBe(true);
      const settledOnB = await b.sql<Array<{ status: string }>>`
        SELECT status FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${HARNESS} AND feature_id = 'F-401'`;
      expect(settledOnB[0]?.status).toBe('passed');

      // ── Crash-survival: a holder dies un-recorded → its slot lapses and is
      //    STOLEN; the recovered swarm takes the other slot; judging proceeds. ──
      await rig.seedBacklog(a, [{ id: 'F-403', redundancy: 2 }]);
      const crash = await rig.runAsCell(a, () =>
        claimReplicaSlot({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-403',
          owner: a.owner,
          ttlSec: 1, // crashes immediately — the 1s lease lapses on the PG clock
        }),
      );
      expect(crash).toMatchObject({ ok: true, replica: { replicaIndex: 0 } });
      await new Promise((r) => setTimeout(r, 1_200)); // PG clock_timestamp governs the lapse
      const stolen = await rig.runAsCell(a, () =>
        claimReplicaSlot({ workspaceId: rig!.workspaceId, harnessSlug: HARNESS, workItemId: 'F-403', owner: b.owner }),
      );
      expect(stolen, 'the lapsed un-recorded slot must be stealable').toMatchObject({
        ok: true,
        replica: { replicaIndex: 0, owner: b.owner },
      });
      // The crashed swarm's late record is REFUSED (its claim was superseded).
      const lateRecord = await rig.runAsCell(a, () =>
        recordReplicaResult({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-403',
          replicaIndex: 0,
          owner: a.owner,
          result: { text: 'zombie record after crash' },
        }),
      );
      expect(lateRecord).toBeNull();
      // The recovered swarm takes the remaining slot; both record; judge settles.
      const recovered = await rig.runAsCell(a, () =>
        claimReplicaSlot({ workspaceId: rig!.workspaceId, harnessSlug: HARNESS, workItemId: 'F-403', owner: a.owner }),
      );
      expect(recovered).toMatchObject({ ok: true, replica: { replicaIndex: 1, owner: a.owner } });
      await rig.runAsCell(a, () =>
        recordReplicaResult({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-403',
          replicaIndex: 0,
          owner: b.owner,
          result: { text: 'survivor replica: GOLD-STANDARD' },
        }),
      );
      await rig.runAsCell(a, () =>
        recordReplicaResult({
          workspaceId: rig!.workspaceId,
          harnessSlug: HARNESS,
          workItemId: 'F-403',
          replicaIndex: 1,
          owner: a.owner,
          result: { text: 'recovered replica: adequate' },
        }),
      );
      const judged2 = await rig.runAsCell(a, () =>
        judgeRedundancyGroup(
          { workspaceId: rig!.workspaceId, harness: HARNESS, workItemId: 'F-403' },
          { llmCall: fakeJudge },
        ),
      );
      expect(judged2.ok).toBe(true);
      if (judged2.ok) expect(judged2.winner).toMatchObject({ replicaIndex: 0, owner: b.owner });
    },
    180_000,
  );
});
