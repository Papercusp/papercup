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

// P-070: the retirement gate is read through this module. Mocked so the unit tier
// never reaches the real flag store, and so "omitting deps still consults the
// gate" is assertable rather than assumed.
const axisEnabledMock = vi.fn<() => Promise<boolean>>();
const maintenanceScopesMock = vi.fn<
  () => Promise<Array<{ workspaceId: string; installSlug: string }>>
>();
vi.mock('../pot/started', () => ({
  mugKettleSystemEnabled: () => axisEnabledMock(),
  listBlenderMaintenanceScopes: () => maintenanceScopesMock(),
}));

import {
  partitionReadyCandidates,
  scoutReadyAutostartSweep,
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

describe('scoutReadyAutostartSweep population', () => {
  it('consults registered Blender scopes rather than the retired started-pot bit', async () => {
    maintenanceScopesMock.mockReset().mockResolvedValueOnce([]);

    await expect(scoutReadyAutostartSweep()).resolves.toEqual([]);

    expect(maintenanceScopesMock).toHaveBeenCalledTimes(1);
  });
});

describe('startReadyScoutPlan', () => {
  beforeEach(() => {
    promoteMock.mockReset();
    axisEnabledMock.mockReset();
    // Default the mocked gate to the DELIVERED state (retired). A test that means
    // to exercise the live path says so explicitly.
    axisEnabledMock.mockResolvedValue(false);
  });

  /** A tagged-template `sql` fake that records interpolated values AND the query
   *  text, and returns rows. The text matters for P-070: "the retired branch does
   *  not write" is a claim about which STATEMENT was issued, and asserting it on
   *  the returned value alone would pass just as happily against an UPDATE. */
  function fakeSql(rows: unknown[]): { sql: Sql; values: () => unknown[]; queries: () => string[] } {
    const captured: unknown[] = [];
    const texts: string[] = [];
    const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => {
      captured.push(...vals);
      texts.push(strings.join('?'));
      return Promise.resolve(rows);
    };
    return { sql: fn as unknown as Sql, values: () => captured, queries: () => texts };
  }

  /** The gate answer as an explicit dep — what the sweep passes (it resolves the
   *  flag once per sweep rather than once per plan). */
  const axis = (live: boolean) => ({ mugKettleSystemEnabledFn: async () => live });

  // WI-6978: the field is `planStorageSlug`, NOT `installSlug`. harness_plans is
  // Hive-scoped — the write path collapses a member harness to its Hive home — so this
  // function is handed the slug plans are STORED under, resolved once by the sweep via
  // routineStorageSlug. The rename is deliberate: it is what makes a raw installSlug
  // arriving here a compile error rather than a silent zero-row read.
  // (Here they coincide: 'papercusp' IS the platform Pot home, which is exactly why
  // the bug was invisible in this workspace.)
  const args = {
    workspaceId: 'papercusp-workspace',
    planStorageSlug: 'papercusp',
    planSlug: 'scout-x-2026-07-02',
  };

  it('starts a never-started plan in the HIVE-OWN workspace and promotes its items there', async () => {
    const { sql, values, queries } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 2, skipped: 0 });

    const r = await startReadyScoutPlan(sql, args, axis(true));

    expect(r).toEqual({ outcome: 'started', promoted: 2, flagOff: false, axisWritten: true });
    expect(queries().join('\n')).toMatch(/SET\s+op_status\s*=\s*'started'/);
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
    const r = await startReadyScoutPlan(sql, args, axis(true));
    expect(r.outcome).toBe('already-started');
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('surfaces a flag-off promotion no-op instead of hiding it', async () => {
    const { sql } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 0, skipped: 0, flagOff: true });
    const r = await startReadyScoutPlan(sql, args, axis(true));
    expect(r).toEqual({ outcome: 'started', promoted: 0, flagOff: true, axisWritten: true });
  });

  // ── P-070: the op_status axis retires with the Mug/Kettle tier ──────────────

  it('RETIRED: promotes the items but never writes op_status', async () => {
    const { sql, queries } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 3, skipped: 0 });

    const r = await startReadyScoutPlan(sql, args, axis(false));

    // The promotion half is the su-SERVING half and must survive the retirement
    // (the P-044 lesson) — this is what closes WI-1574's dead end.
    expect(promoteMock).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ outcome: 'promoted', promoted: 3, flagOff: false, axisWritten: false });
    // The claim that actually matters: no statement issued in this branch puts the
    // plan onto the axis. Asserted against the SQL text, because `axisWritten:
    // false` is only the function's own report of itself.
    expect(queries().join('\n')).not.toMatch(/SET\s+op_status/);
  });

  it('RETIRED: reports `promoted`, not `started` — a status the row does not carry', async () => {
    // The WI-5825 shape, one layer up: announcing a start that never happened is
    // exactly what the outcome type exists to make unsayable.
    const { sql } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 1, skipped: 0 });
    const r = await startReadyScoutPlan(sql, args, axis(false));
    expect(r.outcome).not.toBe('started');
    expect(r.axisWritten).toBe(false);
  });

  it('RETIRED: a row already on the axis is left alone, not re-promoted', async () => {
    // A plan started BEFORE the flag flipped already promoted its items at start
    // time; re-promoting it every quiet-window expiry would be pure churn.
    const { sql } = fakeSql([{ prev_op_status: 'started' }]);
    const r = await startReadyScoutPlan(sql, args, axis(false));
    expect(r.outcome).toBe('already-started');
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('reports plan-not-found rather than promoting a row it never read', async () => {
    const { sql } = fakeSql([]);
    const r = await startReadyScoutPlan(sql, args, axis(true));
    expect(r.outcome).toBe('plan-not-found');
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('consults the gate even when the caller passes no deps — the default is not an open door', async () => {
    // The bypass this forecloses: a future caller omits `deps` and silently gets
    // an UNGATED write. Omitting it must fall through to the real predicate
    // (whose own catch resolves an unreadable flag to retired).
    const { sql, queries } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 1, skipped: 0 });
    axisEnabledMock.mockResolvedValueOnce(false);

    const r = await startReadyScoutPlan(sql, args);

    expect(axisEnabledMock).toHaveBeenCalledTimes(1);
    expect(r.axisWritten).toBe(false);
    expect(queries().join('\n')).not.toMatch(/SET\s+op_status/);
  });
});

describe('buildScoutPlanTemplate seeds a startable item (WI-1574 tooth #2)', () => {
  it('emits an open canonical P-001 item so a ratified draft has something to promote', () => {
    const body = buildScoutPlanTemplate({
      slug: 'scout-x-2026-07-02',
      title: 'Close the loop',
      date: '2026-07-02',
    });
    // Canonical plans:add-item syntax (verified live): `- **P-001** \`todo\` <text>` —
    // this is what readScoutReadyCandidates' has_open_items regex matches.
    expect(body).toContain('- **P-001** `todo` Close the loop');
    expect(body).toContain('origin: scout');
  });
});
