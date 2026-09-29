/**
 * grinding-lifecycle.test.ts — expensive-verification-loops-2026-09-29 P-002, R-3:
 * plan lifecycle marks a plan item GRINDING while its work item has an unaudited loop
 * trigger, and stops marking it once a qualifying audit note is on the item.
 */
import { describe, expect, it } from 'vitest';
import type { ItemStatus, PlanItem } from '@papercusp/plan-parser';
import { derivePlanLifecycleForRead } from '../agent-tools/plans/plan-lifecycle-derivation';
import type { WorkItemAttempt } from './attempt-ledger';
import { ATTEMPT_AUDIT_MARKER, type AttemptAuditNote } from './loop-gate';
import { markGrindingItems, readGrindingItems, type LinkedWorkItem } from './plan-grinding';

const T0 = Date.parse('2026-09-29T10:00:00Z');
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const NOW = T0 + 24 * 60 * 60_000;

let seq = 0;
function failed(startMin: number, fingerprint: string): WorkItemAttempt {
  seq += 1;
  return {
    taskId: `t${seq}`,
    taskClass: 'bash-job',
    title: 'drill',
    startedAt: at(startMin),
    endedAt: at(startMin + 10),
    durationMs: 10 * 60_000,
    outcome: 'fail',
    fingerprint,
    label: null,
    source: 'log',
    commandFingerprint: 'cmd',
  };
}

const item = (id: string, storedStatus: ItemStatus): PlanItem => ({
  id,
  text: `${id} body`,
  storedStatus,
  importance: 'normal',
  riskTier: null,
  authority: 'system',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id} body`,
});

/** WI-LOOP (P-002) is looping; WI-OK (P-003) has one failure only. */
function world(notes: Record<string, AttemptAuditNote[] | null> = {}) {
  const linked: LinkedWorkItem[] = [
    { workItemId: 'WI-LOOP', itemIds: ['P-002'] },
    { workItemId: 'WI-OK', itemIds: ['P-003'] },
  ];
  const attempts: Record<string, WorkItemAttempt[]> = {
    'WI-LOOP': [failed(0, 'log:aaa'), failed(20, 'log:bbb')],
    'WI-OK': [failed(0, 'log:ccc')],
  };
  const asked: string[][] = [];
  return {
    asked,
    deps: {
      listLinked: async (q: { itemIds: readonly string[] }) => {
        asked.push([...q.itemIds]);
        return linked.filter((l) => l.itemIds.some((id) => q.itemIds.includes(id)));
      },
      listAttempts: async (q: { workItemId: string }) => attempts[q.workItemId] ?? [],
      readNotes: async (wi: string) => (wi in notes ? notes[wi] : []),
      now: () => NOW,
    },
  };
}

const plan = [item('P-001', 'done'), item('P-002', 'wip'), item('P-003', 'todo'), item('P-004', 'dropped')];
const signals = {
  workspaceId: 'ws',
  planSlug: 'p',
  now: new Date(NOW).toISOString(),
  planUpdatedAt: new Date(NOW).toISOString(),
  readAcceptance: async () => new Map<string, string>(),
};

describe('readGrindingItems', () => {
  it('marks the item whose work item tripped the loop rule, and only that one', async () => {
    const w = world();
    const marks = await readGrindingItems({ workspaceId: 'ws', planSlug: 'p', itemIds: ['P-002', 'P-003'] }, w.deps);
    expect(marks).toEqual([
      { itemId: 'P-002', workItemId: 'WI-LOOP', triggers: ['distinct-failures'], fingerprints: expect.any(Array) },
    ]);
    expect(marks?.[0].fingerprints.sort()).toEqual(['log:aaa', 'log:bbb']);
  });

  it('clears the mark once a qualifying audit note is on the work item', async () => {
    const w = world({ 'WI-LOOP': [{ postedAt: at(35), body: `${ATTEMPT_AUDIT_MARKER} log:aaa and log:bbb fixed` }] });
    expect(await readGrindingItems({ workspaceId: 'ws', planSlug: 'p', itemIds: ['P-002'] }, w.deps)).toEqual([]);
  });

  it('keeps the mark when the audit leaves a fingerprint unnamed', async () => {
    const w = world({ 'WI-LOOP': [{ postedAt: at(35), body: `${ATTEMPT_AUDIT_MARKER} log:aaa only` }] });
    const marks = await readGrindingItems({ workspaceId: 'ws', planSlug: 'p', itemIds: ['P-002'] }, w.deps);
    expect(marks?.map((m) => m.itemId)).toEqual(['P-002']);
  });

  it('reports "not measured" (null), not an empty list, when the link read fails', async () => {
    const marks = await readGrindingItems(
      { workspaceId: 'ws', planSlug: 'p', itemIds: ['P-002'] },
      {
        listLinked: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(marks).toBeNull();
  });
});

describe('plan lifecycle shows the grinding mark (R-3)', () => {
  it('asks only about open items and returns the marks beside the verdict', async () => {
    const w = world();
    const r = await derivePlanLifecycleForRead({
      items: plan,
      storedStatus: 'active',
      signals,
      readGrinding: (q) => readGrindingItems(q, w.deps),
    });
    expect(w.asked).toEqual([['P-002', 'P-003']]);
    expect(r.grinding?.map((m) => `${m.itemId}:${m.workItemId}`)).toEqual(['P-002:WI-LOOP']);
    const live = markGrindingItems(r.derived.liveItems, r.grinding);
    expect(live.find((it) => it.id === 'P-002')).toMatchObject({
      grinding: { workItemId: 'WI-LOOP', triggers: ['distinct-failures'] },
    });
    expect(live.find((it) => it.id === 'P-003')).not.toHaveProperty('grinding');
  });

  it('carries no grinding field when the caller does not opt in (not measured)', async () => {
    const r = await derivePlanLifecycleForRead({ items: plan, storedStatus: 'active', signals });
    expect(r).not.toHaveProperty('grinding');
    expect(markGrindingItems(r.derived.liveItems, r.grinding)).toEqual(r.derived.liveItems);
  });
});
