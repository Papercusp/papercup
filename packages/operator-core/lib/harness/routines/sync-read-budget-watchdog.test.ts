/**
 * EI-19457924854150358 — the sync-read budget watchdog's decider.
 *
 * The whole reason this audit went unrun for so long is that exercising it needed
 * "a live, populated operator". `evaluateSyncReadBudget` is deliberately pure so
 * the decisions that matter are testable with no operator at all.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateSyncReadBudget,
  syncReadBudgetBlindAfterSec,
  type SyncReadBudgetRow,
} from './sync-read-budget-watchdog';

const NOW = 1_700_000_000_000;
const BLIND_AFTER = 2 * 24 * 60 * 60 * 1000;

function row(over: Partial<SyncReadBudgetRow> & { name: string }): SyncReadBudgetRow {
  return {
    bytes: 999_999,
    byteCeil: 500_000,
    overBytes: true,
    allowlisted: false,
    ...over,
  };
}

function base(over: Partial<Parameters<typeof evaluateSyncReadBudget>[0]> = {}) {
  return evaluateSyncReadBudget({
    computedAtMs: NOW - 60_000,
    nowMs: NOW,
    blindAfterMs: BLIND_AFTER,
    violations: [],
    ratchetRegressions: [],
    ...over,
  });
}

describe('evaluateSyncReadBudget: the BLIND leg (the instrument itself died)', () => {
  it('reports BLIND when no snapshot has ever been produced', () => {
    const v = base({ computedAtMs: null });
    expect(v.state).toBe('blind');
    // Must NOT read as healthy — "nothing measured" is the original defect, not an all-clear.
    expect(v.reason).toMatch(/never produced/i);
  });

  it('reports BLIND when the snapshot is older than the blind threshold', () => {
    const v = base({ computedAtMs: NOW - (BLIND_AFTER + 60_000) });
    expect(v.state).toBe('blind');
    expect(v.reason).toMatch(/stopped producing/i);
  });

  it('carries the producer error into the blind reason when the last refresh failed', () => {
    const v = base({ computedAtMs: null, producerError: 'resolveNamedQueryV2 exploded' });
    expect(v.reason).toContain('resolveNamedQueryV2 exploded');
  });

  it('does NOT report blind while the snapshot is inside the threshold', () => {
    const v = base({ computedAtMs: NOW - (BLIND_AFTER - 60_000) });
    expect(v.state).toBe('healthy');
  });
});

describe('evaluateSyncReadBudget: the BREACH leg', () => {
  it('is healthy on a fresh snapshot with both buckets empty', () => {
    expect(base().state).toBe('healthy');
  });

  it('pages on a ratchet regression', () => {
    const v = base({ ratchetRegressions: [row({ name: 'plans.list', allowlisted: true })] });
    expect(v.state).toBe('breach');
    expect(v).toMatchObject({ ratchetRegressions: ['plans.list'] });
  });

  it('pages on an unallowlisted violation', () => {
    const v = base({ violations: [row({ name: 'agentRuns.bySlug' })] });
    expect(v.state).toBe('breach');
    expect(v).toMatchObject({ violations: ['agentRuns.bySlug'] });
  });

  it('LEADS with ratchet regressions — they are the ones someone already measured', () => {
    const v = base({
      violations: [row({ name: 'newly.fat' })],
      ratchetRegressions: [row({ name: 'rotted.ceiling', allowlisted: true })],
    });
    expect(v.state).toBe('breach');
    const r = v.reason;
    expect(r.indexOf('RATCHET')).toBeGreaterThanOrEqual(0);
    // Ordering is load-bearing: the rotted-ratchet case must not be buried behind
    // a list of ordinary violations.
    expect(r.indexOf('RATCHET')).toBeLessThan(r.indexOf('unallowlisted'));
  });

  it('keeps the two buckets DISJOINT (collapsing them is the WI-7084 defect)', () => {
    const v = base({
      violations: [row({ name: 'a' })],
      ratchetRegressions: [row({ name: 'b', allowlisted: true })],
    });
    expect(v).toMatchObject({ violations: ['a'], ratchetRegressions: ['b'] });
  });
});

describe('evaluateSyncReadBudget: latency must never page (bytes-only)', () => {
  // SyncReadAuditReport.host documents that `ms` is load-DEPENDENT while `bytes`
  // is not: on a loaded box `plans.attentionCounts` measured 103 bytes in 442ms,
  // and three of four ratchetRegressions on that run were flagged on latency
  // alone. Paging on that axis sends a reader chasing queue time.
  it('does NOT page a row that busted ONLY the latency axis', () => {
    const v = base({
      ratchetRegressions: [row({ name: 'plans.attentionCounts', bytes: 103, overBytes: false })],
      violations: [row({ name: 'dev.toolFormatAdoption', bytes: 121, overBytes: false })],
    });
    expect(v.state).toBe('healthy');
  });

  it('CONTROL: the same rows DO page once the byte axis is the one that busted', () => {
    // Without this control the test above could pass because the decider ignores
    // both buckets entirely, rather than because it filters on the byte axis.
    const v = base({
      ratchetRegressions: [row({ name: 'plans.attentionCounts', overBytes: true })],
    });
    expect(v.state).toBe('breach');
  });

  it('treats a MISSING overBytes flag as not-a-breach, never as a breach', () => {
    // An unknown axis must fail toward silence: a watchdog that invents breaches
    // from absent data trains its readers to ignore it.
    const v = base({
      violations: [{ name: 'x', bytes: 1, byteCeil: 2 } as unknown as SyncReadBudgetRow],
    });
    expect(v.state).toBe('healthy');
  });
});

describe('syncReadBudgetBlindAfterSec', () => {
  it('defaults to 2 days when unset', () => {
    delete process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC;
    expect(syncReadBudgetBlindAfterSec()).toBe(2 * 24 * 60 * 60);
  });

  it('honours the kill switch (<= 0 disables the sweep)', () => {
    process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC = '0';
    expect(syncReadBudgetBlindAfterSec()).toBe(0);
    delete process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC;
  });

  it('falls back to the default on unparseable input rather than disabling itself', () => {
    process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC = 'not-a-number';
    expect(syncReadBudgetBlindAfterSec()).toBe(2 * 24 * 60 * 60);
    delete process.env.PAPERCUSP_SYNC_READ_BUDGET_BLIND_AFTER_SEC;
  });
});
