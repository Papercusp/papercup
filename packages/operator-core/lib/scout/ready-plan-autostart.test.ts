/**
 * ready-plan-autostart.test.ts — WI-1574: the missing consumer of the Queen↔Scout
 * review loop's `ready` terminal. Covers the pure deciders, the kill switch, the
 * start-and-promote core (fake sql + mocked promotePlanItems — asserting the
 * hive-own-workspace scoping and the flag-off surfacing), and the draft template's
 * seeded P-001 (tooth #2: an itemless draft can never start).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const promoteMock = vi.fn();
vi.mock('../plan-workitem-promotion-run', () => ({
  promotePlanItems: (...args: unknown[]) => promoteMock(...args),
}));

import {
  partitionReadyCandidates,
  scoutReadyAutostartEnabled,
  startReadyScoutPlan,
  type ScoutReadyCandidate,
} from './ready-plan-autostart';
import { buildScoutPlanTemplate } from './scout-plan-draft';
import type { Sql } from 'postgres';

const cand = (planSlug: string, hasOpenItems: boolean): ScoutReadyCandidate => ({
  planSlug,
  title: planSlug,
  hasOpenItems,
});

describe('partitionReadyCandidates (pure)', () => {
  it('splits startable (has items) from itemless', () => {
    const { startable, itemless } = partitionReadyCandidates([
      cand('a', true),
      cand('b', false),
      cand('c', true),
    ]);
    expect(startable.map((c) => c.planSlug)).toEqual(['a', 'c']);
    expect(itemless.map((c) => c.planSlug)).toEqual(['b']);
  });

  it('handles the empty set', () => {
    const { startable, itemless } = partitionReadyCandidates([]);
    expect(startable).toEqual([]);
    expect(itemless).toEqual([]);
  });
});

describe('scoutReadyAutostartEnabled (kill switch)', () => {
  const prev = process.env.PAPERCUSP_SCOUT_READY_AUTOSTART;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_SCOUT_READY_AUTOSTART;
    else process.env.PAPERCUSP_SCOUT_READY_AUTOSTART = prev;
  });

  it('is on by default and off at =0', () => {
    delete process.env.PAPERCUSP_SCOUT_READY_AUTOSTART;
    expect(scoutReadyAutostartEnabled()).toBe(true);
    process.env.PAPERCUSP_SCOUT_READY_AUTOSTART = '0';
    expect(scoutReadyAutostartEnabled()).toBe(false);
  });
});

describe('startReadyScoutPlan', () => {
  beforeEach(() => promoteMock.mockReset());

  /** A tagged-template `sql` fake that records interpolated values and returns rows. */
  function fakeSql(rows: unknown[]): { sql: Sql; values: () => unknown[] } {
    const captured: unknown[] = [];
    const fn = (_strings: TemplateStringsArray, ...vals: unknown[]) => {
      captured.push(...vals);
      return Promise.resolve(rows);
    };
    return { sql: fn as unknown as Sql, values: () => captured };
  }

  const args = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp', planSlug: 'scout-x-2026-07-02' };

  it('starts a never-started plan in the HIVE-OWN workspace and promotes its items there', async () => {
    const { sql, values } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 2, skipped: 0 });

    const r = await startReadyScoutPlan(sql, args);

    expect(r).toEqual({ transitioned: true, promoted: 2, flagOff: false });
    // The workspace nuance WI-1574 exists for: the UPDATE must scope to the hive's
    // OWN workspace (plans:start pins DEFAULT and misses scout rows).
    expect(values()).toContain('papercusp-workspace');
    expect(promoteMock).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      planSlug: 'scout-x-2026-07-02',
      createdBy: 'scout-ready-autostart',
    });
  });

  it('is a no-op (no promotion) when the plan was already started — race-safe', async () => {
    const { sql } = fakeSql([{ prev_op_status: 'started' }]);
    const r = await startReadyScoutPlan(sql, args);
    expect(r.transitioned).toBe(false);
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('surfaces a flag-off promotion no-op instead of hiding it', async () => {
    const { sql } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 0, skipped: 0, flagOff: true });
    const r = await startReadyScoutPlan(sql, args);
    expect(r).toEqual({ transitioned: true, promoted: 0, flagOff: true });
  });
});

describe('buildScoutPlanTemplate seeds a startable item (WI-1574 tooth #2)', () => {
  it('emits an open P-001 checkbox so a ratified draft has something to promote', () => {
    const body = buildScoutPlanTemplate({
      slug: 'scout-x-2026-07-02',
      title: 'Close the loop',
      date: '2026-07-02',
    });
    expect(body).toContain('- [ ] P-001 Close the loop');
    expect(body).toContain('origin: scout');
  });
});
