/**
 * R-12 (expensive-verification-loops-2026-09-29, P-007): plan lifecycle reports each item's
 * attempts-until-pass and its failed attempts split into product, harness and environment.
 */
import { describe, expect, it } from 'vitest';
import type { WorkItemAttempt } from './attempt-ledger';
import {
  auditFailureClasses,
  classifyFailure,
  formatIterationMetric,
  iterationMetric,
  parseIterationBudget,
  readIterationMetrics,
} from './plan-iteration-metrics';

let clock = 0;
function attempt(outcome: WorkItemAttempt['outcome'], fingerprint: string | null, structured: WorkItemAttempt['structured'] = null): WorkItemAttempt {
  clock += 60_000;
  return {
    taskId: `t${clock}`,
    taskClass: 'drill',
    title: 'hive-git drill',
    startedAt: new Date(Date.UTC(2026, 8, 29) + clock).toISOString(),
    endedAt: outcome === 'running' ? null : new Date(Date.UTC(2026, 8, 29) + clock + 30_000).toISOString(),
    durationMs: outcome === 'running' ? null : 300_000,
    outcome,
    fingerprint,
    label: fingerprint,
    source: structured ? 'structured' : 'log',
    commandFingerprint: 'cmd',
    structured,
  };
}

const note = (postedAt: string, body: string) => ({ postedAt, body });

describe('failure classification', () => {
  it('an [attempt-audit] line naming a fingerprint and one class word assigns it; later notes win', () => {
    const classes = auditFailureClasses(
      [
        note('2026-09-29T10:00:00Z', '[attempt-audit]\nfp-ssh: environment (VM clock skew)\nfp-merge: product'),
        note('2026-09-29T11:00:00Z', '[attempt-audit]\nfp-ssh: harness — the producer never exits, not the rig'),
        note('2026-09-29T12:00:00Z', 'fp-merge is harness (not an audit note, ignored)'),
        note('2026-09-29T12:30:00Z', '[attempt-audit]\nfp-merge: product or harness? unsure'),
      ],
      ['fp-ssh', 'fp-merge', 'fp-none'],
    );
    expect(Object.fromEntries(classes)).toEqual({ 'fp-ssh': 'harness', 'fp-merge': 'product' });
  });

  it('falls back to the structured reason code, and never guesses', () => {
    const none = new Map();
    const s = (phase: string, reasonCode: string) => ({ fingerprint: 'x', structured: { phase, reasonCode } });
    expect(classifyFailure(s('D', 'harness:observe-single-read'), none)).toBe('harness');
    expect(classifyFailure(s('D', 'env:vm-trust-tier'), none)).toBe('environment');
    expect(classifyFailure(s('D', 'product:merge-lost-edit'), none)).toBe('product');
    expect(classifyFailure(s('preflight', 'rig-down'), none)).toBe('environment');
    expect(classifyFailure(s('B', 'guard-rail:p505-vm-git-sync-locks'), none)).toBe('environment');
    expect(classifyFailure(s('B', 'tier-gate:code-changed'), none)).toBe('harness');
    expect(classifyFailure(s('B', 'exit-1'), none)).toBe('unclassified');
    expect(classifyFailure({ fingerprint: null, structured: null }, none)).toBe('unclassified');
    // The audit tag outranks the reason code.
    expect(classifyFailure(s('D', 'product:x'), new Map([['x', 'harness' as const]]))).toBe('harness');
  });
});

describe('iteration metric', () => {
  it('counts attempts until the first pass and splits every failed attempt by class', () => {
    const attempts = [
      attempt('fail', 'fp-ssh'),
      attempt('cancelled', null),
      attempt('fail', 'fp-a', { phase: 'preflight', reasonCode: 'rig-down' }),
      attempt('fail', 'fp-merge'),
      attempt('pass', null),
      attempt('fail', 'fp-late', { phase: 'E', reasonCode: 'product:regression' }),
      attempt('running', null),
    ];
    const m = iterationMetric('P-003', ['WI-2', 'WI-1'], [...attempts].reverse(), new Map([['fp-ssh', 'harness' as const]]));
    expect(m).toEqual({
      itemId: 'P-003',
      workItemIds: ['WI-1', 'WI-2'],
      attempts: 5,
      attemptsUntilPass: 4,
      passed: true,
      failed: { product: 1, harness: 1, environment: 1, unclassified: 1 },
      cancelled: 1,
      running: 1,
      budget: null,
      overBudget: false,
    });
    expect(formatIterationMetric(m)).toBe('P-003 4 attempt(s) to pass · failed: 1 product, 1 harness, 1 environment, 1 unclassified · 1 running');
  });

  it('an item that has not passed reports null attempts-until-pass, not its attempt count', () => {
    const m = iterationMetric('P-004', ['WI-3'], [attempt('fail', 'a'), attempt('fail', 'b')], new Map());
    expect(m.attemptsUntilPass).toBeNull();
    expect(m.passed).toBe(false);
    expect(formatIterationMetric(m)).toBe('P-004 2 attempt(s), not passed · failed: 2 unclassified');
  });
});

describe('declared iteration budget', () => {
  it('parses attempt-cost and iteration-budget keywords from the item text; neither → null', () => {
    expect(parseIterationBudget('Drill passes attempt-cost:1.5h iteration-budget:4')).toEqual({
      attemptCostMs: 5_400_000,
      iterations: 4,
      totalCostMs: 21_600_000,
    });
    expect(parseIterationBudget('attempt-cost: 90s')).toEqual({ attemptCostMs: 90_000, iterations: null, totalCostMs: null });
    expect(parseIterationBudget('costs a lot, budget unknown')).toBeNull();
    expect(parseIterationBudget('iteration-budget:0')).toBeNull();
    expect(parseIterationBudget('xattempt-cost:5m')).toBeNull();
    expect(parseIterationBudget(undefined)).toBeNull();
  });

  it('over budget = passed only after more attempts than budgeted, or every budgeted attempt used without a pass', () => {
    const budget = { attemptCostMs: null, iterations: 2, totalCostMs: null };
    const passedInBudget = iterationMetric('P-1', [], [attempt('fail', 'a'), attempt('pass', null)], new Map(), budget);
    const passedLate = iterationMetric('P-2', [], [attempt('fail', 'a'), attempt('fail', 'b'), attempt('pass', null)], new Map(), budget);
    const oneLeft = iterationMetric('P-3', [], [attempt('fail', 'a')], new Map(), budget);
    const spent = iterationMetric('P-4', [], [attempt('fail', 'a'), attempt('fail', 'b')], new Map(), budget);
    expect([passedInBudget, passedLate, oneLeft, spent].map((m) => m.overBudget)).toEqual([false, true, false, true]);
  });
});

describe('readIterationMetrics', () => {
  it('merges every work item linked to an item (done ones included) and omits items with no slow attempts', async () => {
    const byWi: Record<string, WorkItemAttempt[]> = {
      'WI-1': [attempt('fail', 'fp-ssh'), attempt('fail', 'fp-ssh')],
      'WI-2': [attempt('pass', null)],
      'WI-9': [],
    };
    const metrics = await readIterationMetrics(
      { workspaceId: 'w', planSlug: 'p', itemIds: ['P-001', 'P-002', 'P-003'] },
      {
        sql: {} as never,
        listLinked: async () => [
          { workItemId: 'WI-1', itemIds: ['P-001'] },
          { workItemId: 'WI-2', itemIds: ['P-001'] },
          { workItemId: 'WI-9', itemIds: ['P-002'] },
        ],
        listAttempts: async ({ workItemId }) => byWi[workItemId] ?? [],
        readNotes: async (id) => (id === 'WI-1' ? [note('2026-09-29T10:00:00Z', '[attempt-audit] fp-ssh: environment')] : null),
      },
    );
    expect(metrics).toEqual([
      {
        itemId: 'P-001',
        workItemIds: ['WI-1', 'WI-2'],
        attempts: 3,
        attemptsUntilPass: 3,
        passed: true,
        failed: { product: 0, harness: 0, environment: 2, unclassified: 0 },
        cancelled: 0,
        running: 0,
        budget: null,
        overBudget: false,
      },
    ]);
  });

  it('reports an item that declares a budget before its first attempt, and flags a spent budget', async () => {
    const metrics = await readIterationMetrics(
      {
        workspaceId: 'w',
        planSlug: 'p',
        itemIds: ['P-001', 'P-002', 'P-003'],
        itemTexts: {
          'P-001': 'Physical drill phase E passes attempt-cost:20m iteration-budget:2',
          'P-002': 'Headless UI check iteration-budget:3',
          'P-003': 'No declaration here',
        },
      },
      {
        sql: {} as never,
        listLinked: async () => [{ workItemId: 'WI-1', itemIds: ['P-001'] }],
        listAttempts: async () => [attempt('fail', 'a'), attempt('fail', 'b')],
        readNotes: async () => null,
      },
    );
    expect(metrics?.map((m) => [m.itemId, m.attempts, m.overBudget, m.budget])).toEqual([
      ['P-001', 2, true, { attemptCostMs: 1_200_000, iterations: 2, totalCostMs: 2_400_000 }],
      ['P-002', 0, false, { attemptCostMs: null, iterations: 3, totalCostMs: null }],
    ]);
    expect(formatIterationMetric(metrics![0]!)).toBe(
      'P-001 2 attempt(s), not passed · failed: 2 unclassified · budget 2 attempt(s) × 20m each — OVER BUDGET',
    );
  });

  it('a failed read is "not measured" (null), never an empty list', async () => {
    const r = await readIterationMetrics(
      { workspaceId: 'w', planSlug: 'p', itemIds: ['P-001'] },
      { sql: {} as never, listLinked: async () => { throw new Error('db down'); } },
    );
    expect(r).toBeNull();
    expect(await readIterationMetrics({ workspaceId: 'w', planSlug: 'p', itemIds: [] })).toEqual([]);
  });
});
