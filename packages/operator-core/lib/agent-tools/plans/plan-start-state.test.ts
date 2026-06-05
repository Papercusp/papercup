/**
 * plan-start-state.test.ts — the cross-store invariant that a plan can never
 * be operationally `started`/`paused` (the harness_plans.op_status column,
 * folded from the retired harness_plan_status table) while its frontmatter is
 * terminal (shipped/superseded).
 *
 * Pure-function coverage for isTerminalPlanStatus + reconcileStartStatus (the
 * read-time self-heal), plus a mocked-DB check that clearStartedForTerminalPlan
 * issues the right scoped UPDATE and reports whether an active row was cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    txCalls: { strings: readonly string[]; values: unknown[] }[];
    txResult: unknown[];
  } = { txCalls: [], txResult: [] };
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    return Promise.resolve(state.txResult);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

import {
  isTerminalPlanStatus,
  reconcileStartStatus,
  clearStartedForTerminalPlan,
  TERMINAL_PLAN_STATUSES,
} from './plan-start-state';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';

beforeEach(() => {
  H.state.txCalls = [];
  H.state.txResult = [];
});

describe('isTerminalPlanStatus', () => {
  it('is true only for shipped + superseded', () => {
    expect(TERMINAL_PLAN_STATUSES).toEqual(['shipped', 'superseded']);
    expect(isTerminalPlanStatus('shipped')).toBe(true);
    expect(isTerminalPlanStatus('superseded')).toBe(true);
  });

  it('is false for every live/draft status and for null/undefined', () => {
    for (const s of ['draft', 'ready', 'active', 'blocked', '', 'SHIPPED']) {
      expect(isTerminalPlanStatus(s)).toBe(false);
    }
    expect(isTerminalPlanStatus(null)).toBe(false);
    expect(isTerminalPlanStatus(undefined)).toBe(false);
  });
});

describe('reconcileStartStatus (read-time self-heal)', () => {
  it('demotes a stale started/paused row on a terminal plan to done', () => {
    expect(reconcileStartStatus('started', 'shipped')).toBe('done');
    expect(reconcileStartStatus('started', 'superseded')).toBe('done');
    expect(reconcileStartStatus('paused', 'shipped')).toBe('done');
    expect(reconcileStartStatus('paused', 'superseded')).toBe('done');
  });

  it('leaves started/paused untouched on a non-terminal plan', () => {
    expect(reconcileStartStatus('started', 'ready')).toBe('started');
    expect(reconcileStartStatus('started', 'active')).toBe('started');
    expect(reconcileStartStatus('started', 'draft')).toBe('started');
    expect(reconcileStartStatus('started', null)).toBe('started');
    expect(reconcileStartStatus('paused', 'ready')).toBe('paused');
  });

  it('passes done / null through unchanged regardless of lifecycle', () => {
    expect(reconcileStartStatus('done', 'shipped')).toBe('done');
    expect(reconcileStartStatus('done', 'ready')).toBe('done');
    expect(reconcileStartStatus(null, 'shipped')).toBeNull();
    expect(reconcileStartStatus(null, 'ready')).toBeNull();
  });
});

describe('clearStartedForTerminalPlan', () => {
  it('issues a scoped UPDATE → done guarded to started/paused rows only', async () => {
    H.state.txResult = [{ plan_slug: 'p' }]; // one active row cleared
    const res = await clearStartedForTerminalPlan('myharn', 'my-plan-2026-06-02');

    expect(H.state.txCalls).toHaveLength(1);
    const { strings, values } = H.state.txCalls[0];
    const sql = strings.join('§');
    // PG-canonical: op_status now lives on the harness_plans row itself, not a
    // separate harness_plan_status table.
    expect(sql).toContain('UPDATE harness_shared.harness_plans');
    expect(sql).toContain("SET op_status = 'done'");
    // Only an active row is touched — a done/missing row is never resurrected.
    expect(sql).toContain("op_status IN ('started', 'paused')");
    // Params: [op_updated_at, workspace_id, harness_slug, plan_slug].
    expect(values[1]).toBe(DEFAULT_WORKSPACE_ID);
    expect(values[2]).toBe('myharn');
    expect(values[3]).toBe('my-plan-2026-06-02');
    expect(res).toEqual({ cleared: true });
  });

  it('reports cleared:false when no active row matched (idempotent no-op)', async () => {
    H.state.txResult = [];
    const res = await clearStartedForTerminalPlan('myharn', 'never-started');
    expect(res).toEqual({ cleared: false });
  });
});
