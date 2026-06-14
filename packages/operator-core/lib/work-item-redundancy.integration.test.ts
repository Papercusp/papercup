/**
 * work-item-redundancy.integration.test.ts — BOINC redundancy against real Postgres
 * (decentralized-dispatch-scaling-2026-06-08 P-014).
 *
 * Drives the redundancy store + the judge→adopt flow against a fresh testcontainer schema
 * carrying migration 195's `work_item_replicas` + a minimal `harness_features_consolidated`
 * (just the columns the redundancy path reads/writes). `./work-items` (getWorkItem /
 * setWorkItemState) is mocked so the judge→adopt flow is tested without the full
 * feature/issue/coord schema; the LLM judge is a fake (no network). Proves:
 *   - claimReplicaSlot: N distinct Swarms get distinct slots; same owner reuses; lapsed-steal;
 *     all-slots-held ceiling; not-redundant / item-not-found refusals.
 *   - recordReplicaResult: owner-checked, no double-record.
 *   - setItemRedundancy / getItemRedundancy round-trip (opt-in marker).
 *   - judgeRedundancyGroup: judges each complete replica, persists verdicts, picks the
 *     highest composite, marks winner/losers, and ADOPTS (settles the item to done).
 *   - claim_next's excludeRedundant filter skips high-stakes items.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type { JudgeLlmCall } from './gym/primitives';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

// Keep the REAL work-items module (so claimNextWorkItem is exercised for real) but override
// the two functions the redundancy path calls for the per-item marker + winner adoption
// (getWorkItem to learn family/title, setWorkItemState to settle the winner) — so the
// judge→adopt flow is tested off the full feature/issue/coord schema.
const wm = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  setWorkItemState: vi.fn(),
}));
vi.mock('./work-items', async () => {
  const actual = await vi.importActual<typeof import('./work-items')>('./work-items');
  return { ...actual, getWorkItem: wm.getWorkItem, setWorkItemState: wm.setWorkItemState };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  setItemRedundancy,
  getItemRedundancy,
  claimReplicaSlot,
  recordReplicaResult,
  heartbeatReplica,
  releaseReplica,
  listReplicas,
  judgeRedundancyGroup,
  sweepLapsedReplicas,
} = await import('./work-item-redundancy');
const { claimNextWorkItem } = await import('./work-items');

const WS = 'default';
const HARNESS = 'h1';

// Minimal feature table — just the columns the redundancy path + claim_next read/write.
const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text, summary text, status text DEFAULT 'todo',
    item_kind text DEFAULT 'feature',
    taken_by text, taken_at timestamptz,
    parent_id text, payload jsonb,
    assignee_rank integer, rank_writer text, rank_updated_at timestamptz,
    swarm_affinity text, feature_order integer,
    redundancy integer,
    origin text NOT NULL DEFAULT 'local', audit_verdict text,
    created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;

const REPLICAS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_replicas (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    replica_index integer NOT NULL,
    redundancy integer NOT NULL,
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL,
    owner_label text,
    holder_pubkey text,
    ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    status text DEFAULT 'claimed' NOT NULL,
    result jsonb,
    judge_composite double precision, judge_rationale text, judge_model text,
    rubric_hash text, judge_cost_usd double precision, judged_ts timestamptz,
    created_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    updated_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_replicas_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id, replica_index),
    CONSTRAINT work_item_replicas_status_check CHECK (status IN ('claimed','complete','winner','loser')))`;

async function insertFeature(id: string, redundancy: number | null): Promise<void> {
  await h.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, redundancy, created_ts, updated_ts)
    VALUES (${WS}, ${HARNESS}, ${id}, ${'T ' + id}, ${'summary ' + id}, 'todo', 'feature', ${redundancy}, ${Date.now()}, ${Date.now()})`;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-redundancy');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(REPLICAS_DDL);
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  wm.getWorkItem.mockReset();
  wm.setWorkItemState.mockReset();
  await db.sql`DELETE FROM harness_shared.work_item_replicas`;
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
});

describe('per-item redundancy marker (opt-in)', () => {
  it('setItemRedundancy round-trips; clearing (n=1) → exactly-once', async () => {
    await insertFeature('F-001', null);
    wm.getWorkItem.mockResolvedValue({ id: 'F-001', family: 'feature', harness: HARNESS, title: 'T', summary: 's' });

    expect(await getItemRedundancy('F-001', { harness: HARNESS })).toBe(1); // NULL → 1
    const set = await setItemRedundancy('F-001', 2, { harness: HARNESS });
    expect(set).toMatchObject({ id: 'F-001', redundancy: 2 });
    expect(await getItemRedundancy('F-001', { harness: HARNESS })).toBe(2);

    const cleared = await setItemRedundancy('F-001', 1, { harness: HARNESS });
    expect(cleared).toMatchObject({ redundancy: 1 });
    expect(await getItemRedundancy('F-001', { harness: HARNESS })).toBe(1);
  });

  it('getItemRedundancy → null for a missing item', async () => {
    expect(await getItemRedundancy('F-404', { harness: HARNESS })).toBeNull();
  });

  it('setItemRedundancy → null for an issue-family item (no redundancy column)', async () => {
    wm.getWorkItem.mockResolvedValue({ id: 'WI-9', family: 'issue', harness: HARNESS });
    expect(await setItemRedundancy('WI-9', 2, { harness: HARNESS })).toBeNull();
  });
});

describe('claimReplicaSlot — N distinct slots of the same item', () => {
  it('two Swarms get distinct slots; a third hits the ceiling; same owner reuses', async () => {
    await insertFeature('F-010', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-010', owner: 'su-a' });
    const b = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-010', owner: 'su-b' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect([a.replica.replicaIndex, b.replica.replicaIndex].sort()).toEqual([0, 1]);
    expect(a.reused).toBe(false);

    // Third distinct owner → all slots held.
    const c = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-010', owner: 'su-c' });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('all-slots-held');

    // su-a re-claims → reuses its existing slot, not a new one.
    const aAgain = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-010', owner: 'su-a' });
    expect(aAgain.ok).toBe(true);
    if (aAgain.ok) {
      expect(aAgain.reused).toBe(true);
      expect(aAgain.replica.replicaIndex).toBe(a.replica.replicaIndex);
    }
  });

  it('refuses a non-redundant item (redundancy ≤ 1)', async () => {
    await insertFeature('F-011', 1);
    const r = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-011', owner: 'su-a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-redundant');
  });

  it('refuses a missing item', async () => {
    const r = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-404', owner: 'su-a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('item-not-found');
  });

  it('STEALS a lapsed (un-recorded) slot — work-stealing a dead Swarms replica', async () => {
    await insertFeature('F-012', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-012', owner: 'su-a' });
    const b = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-012', owner: 'su-b' });
    expect(a.ok && b.ok).toBe(true);
    // Lapse su-a's slot.
    await db.sql`UPDATE harness_shared.work_item_replicas SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-012' AND owner = 'su-a'`;
    // A new Swarm steals the lapsed slot (the other live slot is held by su-b).
    const d = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-012', owner: 'su-d' });
    expect(d.ok).toBe(true);
    if (d.ok && a.ok) {
      expect(d.replica.replicaIndex).toBe(a.replica.replicaIndex); // re-took su-a's freed slot
      expect(d.replica.owner).toBe('su-d');
    }
  });

  it('never steals a COMPLETE slot (a recorded replica keeps its slot)', async () => {
    await insertFeature('F-013', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-013', owner: 'su-a' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-013', replicaIndex: a.replica.replicaIndex, owner: 'su-a', result: { text: 'done' } });
    // Even after lapsing, a complete slot must NOT be stolen.
    await db.sql`UPDATE harness_shared.work_item_replicas SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-013'`;
    const b = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-013', owner: 'su-b' });
    // su-b gets the OTHER free slot, not su-a's completed one.
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.replica.replicaIndex).not.toBe(a.replica.replicaIndex);
  });
});

describe('recordReplicaResult — owner-checked, no double-record', () => {
  it('records a held slot → complete; rejects a second record + a non-holder', async () => {
    await insertFeature('F-020', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-020', owner: 'su-a' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const idx = a.replica.replicaIndex;
    const rec = await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-020', replicaIndex: idx, owner: 'su-a', result: { text: 'my result' } });
    expect(rec?.status).toBe('complete');
    // A second record on the now-complete slot → null (status is no longer 'claimed').
    expect(await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-020', replicaIndex: idx, owner: 'su-a', result: { text: 'again' } })).toBeNull();
    // A non-holder cannot record.
    await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-020', owner: 'su-b' });
    expect(await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-020', replicaIndex: idx, owner: 'su-b', result: { text: 'steal' } })).toBeNull();
  });
});

describe('heartbeat / release', () => {
  it('heartbeat renews; release frees the slot', async () => {
    await insertFeature('F-030', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-030', owner: 'su-a', ttlSec: 60 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const hb = await heartbeatReplica({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-030', replicaIndex: a.replica.replicaIndex, claimId: a.replica.claimId, owner: 'su-a', ttlSecOverride: 3600 });
    expect(hb.renewed).toBe(true);
    const rel = await releaseReplica({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-030', replicaIndex: a.replica.replicaIndex, claimId: a.replica.claimId, owner: 'su-a' });
    expect(rel).toBe(true);
    expect(await listReplicas('F-030', { harness: HARNESS, workspaceId: WS })).toHaveLength(0);
  });
});

describe('judgeRedundancyGroup — judge each replica, pick + adopt the winner', () => {
  // A fake judge: the trace containing 'STRONG' scores high (composite 8.5), else low (3.5).
  const fakeLlm: JudgeLlmCall = async ({ messages }) => {
    const strong = /STRONG/.test(messages.map((m) => m.content).join('\n'));
    return {
      text: '',
      json: { d1: strong ? 9 : 3, d2: strong ? 8 : 4, d3: strong ? 8 : 4, rationale: strong ? 'strong' : 'weak' },
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 10,
    };
  };

  it('judges 2 complete replicas, marks winner/loser, adopts (settles to done)', async () => {
    await insertFeature('F-040', 2);
    wm.getWorkItem.mockResolvedValue({ id: 'F-040', family: 'feature', harness: HARNESS, title: 'Do the thing', summary: 'an important item' });
    wm.setWorkItemState.mockResolvedValue({ id: 'F-040', state: 'passed' });

    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-040', owner: 'su-a' });
    const b = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-040', owner: 'su-b' });
    if (!a.ok || !b.ok) throw new Error('claims failed');
    // su-a (slot from a) records a weak result; su-b records a STRONG one.
    await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-040', replicaIndex: a.replica.replicaIndex, owner: 'su-a', result: { text: 'a weak attempt' } });
    await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-040', replicaIndex: b.replica.replicaIndex, owner: 'su-b', result: { text: 'a STRONG attempt' } });

    const res = await judgeRedundancyGroup({ workspaceId: WS, harness: HARNESS, workItemId: 'F-040' }, { llmCall: fakeLlm });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.winner.replicaIndex).toBe(b.replica.replicaIndex);
    expect(res.winner.owner).toBe('su-b');
    expect(res.winner.composite).toBeGreaterThan(res.scores.find((s) => s.replicaIndex === a.replica.replicaIndex)!.composite);

    // Replica statuses persisted: winner / loser.
    const replicas = await listReplicas('F-040', { harness: HARNESS, workspaceId: WS });
    const byIdx = Object.fromEntries(replicas.map((r) => [r.replicaIndex, r]));
    expect(byIdx[b.replica.replicaIndex].status).toBe('winner');
    expect(byIdx[a.replica.replicaIndex].status).toBe('loser');
    // Verdicts persisted on each row.
    expect(byIdx[b.replica.replicaIndex].judgeComposite).not.toBeNull();
    expect(byIdx[a.replica.replicaIndex].judgeRationale).toBe('weak');

    // Adopted: the item settled to done (alias → passed for feature-family).
    expect(wm.setWorkItemState).toHaveBeenCalledWith('F-040', 'done', { harness: HARNESS });
  });

  it('refuses with < 2 complete replicas', async () => {
    await insertFeature('F-041', 2);
    wm.getWorkItem.mockResolvedValue({ id: 'F-041', family: 'feature', harness: HARNESS, title: 'x', summary: 'y' });
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-041', owner: 'su-a' });
    if (!a.ok) throw new Error('claim failed');
    await recordReplicaResult({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-041', replicaIndex: a.replica.replicaIndex, owner: 'su-a', result: { text: 'only one' } });

    const res = await judgeRedundancyGroup({ workspaceId: WS, harness: HARNESS, workItemId: 'F-041' }, { llmCall: fakeLlm });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('insufficient-replicas');
      expect(res.completeCount).toBe(1);
    }
    expect(wm.setWorkItemState).not.toHaveBeenCalled();
  });
});

describe('claim_next excludeRedundant filter (the dispatch gate)', () => {
  it('skips high-stakes items when excludeRedundant; takes them when not', async () => {
    await insertFeature('F-050', 3); // high-stakes
    await insertFeature('F-051', null); // normal

    // With excludeRedundant, claim_next must skip F-050 and take the normal F-051.
    const skip = await claimNextWorkItem({ harness: HARNESS, assignee: 'su-x', excludeRedundant: true });
    expect(skip?.id).toBe('F-051');

    // Reset claim, then WITHOUT excludeRedundant (flag off) the redundant item is claimable.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET taken_by = NULL WHERE feature_id = 'F-051'`;
    const take = await claimNextWorkItem({ harness: HARNESS, assignee: 'su-y', excludeRedundant: false });
    expect(['F-050', 'F-051']).toContain(take?.id);
  });

  it('sweepLapsedReplicas GCs lapsed un-recorded slots', async () => {
    await insertFeature('F-060', 2);
    const a = await claimReplicaSlot({ workspaceId: WS, harnessSlug: HARNESS, workItemId: 'F-060', owner: 'su-a' });
    expect(a.ok).toBe(true);
    await db.sql`UPDATE harness_shared.work_item_replicas SET expires_ts = clock_timestamp() - interval '1 minute' WHERE work_item_id = 'F-060'`;
    expect(await sweepLapsedReplicas(WS)).toBe(1);
  });
});
