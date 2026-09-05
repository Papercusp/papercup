/**
 * ready-plan-autostart.test.ts — WI-1574: the missing consumer of the Queen↔Scout
 * review loop's `ready` terminal. Covers the pure deciders, the kill switch, the
 * start-and-promote core (fake sql + mocked promotePlanItems — asserting the
 * hive-own-workspace scoping and the flag-off surfacing), and the draft template's
 * seeded P-001 (tooth #2: an itemless draft can never start).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const promoteMock = vi.fn();
const sweepMocks = vi.hoisted(() => ({
  sql: vi.fn(),
  resolveMugOwner: vi.fn(),
  routineStorageSlug: vi.fn(),
  deliverScoutNudge: vi.fn(),
  claimWatchdogFire: vi.fn(),
  recentWatchdogFires: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sweepMocks.sql }),
}));

vi.mock('../plan-workitem-promotion-run', () => ({
  promotePlanItems: (...args: unknown[]) => promoteMock(...args),
}));

vi.mock('../pot-membership', () => ({
  routineStorageSlug: (...args: unknown[]) => sweepMocks.routineStorageSlug(...args),
}));

vi.mock('../pot/placement-watchdog', () => ({
  resolveMugOwner: (...args: unknown[]) => sweepMocks.resolveMugOwner(...args),
}));

vi.mock('../pot/watchdog', () => ({
  claimWatchdogFire: (...args: unknown[]) => sweepMocks.claimWatchdogFire(...args),
  recentWatchdogFires: (...args: unknown[]) => sweepMocks.recentWatchdogFires(...args),
}));

vi.mock('./nudge-recipient', () => ({
  deliverScoutNudge: (...args: unknown[]) => sweepMocks.deliverScoutNudge(...args),
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
import {
  configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource,
} from '../agent-tools/plans/plan-admission-gate';
import type { Sql } from 'postgres';

// P-004: this sweep is an admission door, so it now asks the plan-admission gate
// before promoting anything. Default the POLICY seam to "this pot has not opted in",
// which is the state of every existing pot and keeps these cases about the sweep's
// own behaviour. Left unconfigured, the gate's default source would reach the real
// hive-policy store through this file's fake `sql` — which is not a governance
// answer, just an unreachable dependency. The opt-in path has its own case below.
beforeEach(() => {
  configurePlanAdmissionPolicySource(async () => null);
});
afterEach(() => {
  configurePlanAdmissionPolicySource(null);
  configurePlanAdmissionCertificateSource(null);
});

const cand = (planSlug: string, hasOpenItems: boolean, hasAnyItems = hasOpenItems): ScoutReadyCandidate => ({
  planSlug,
  title: planSlug,
  hasOpenItems,
  hasAnyItems,
});

describe('partitionReadyCandidates (pure)', () => {
  it('splits startable (has items) from itemless', () => {
    const { startable, itemless, finished } = partitionReadyCandidates([
      cand('a', true),
      cand('b', false),
      cand('c', true),
      cand('d', false, true),
    ]);
    expect(startable.map((c) => c.planSlug)).toEqual(['a', 'c']);
    expect(itemless.map((c) => c.planSlug)).toEqual(['b']);
    expect(finished.map((c) => c.planSlug)).toEqual(['d']);
  });

  it('handles the empty set', () => {
    const { startable, itemless, finished } = partitionReadyCandidates([]);
    expect(startable).toEqual([]);
    expect(itemless).toEqual([]);
    expect(finished).toEqual([]);
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

  /**
   * THE SILENT-NO-OP PROBE (D-074). This sweep was the ONE of five retained Blender
   * consumers that early-returned bare on an empty scope list — caught by an independent
   * acceptance grade, not by this suite, because "returns []" is exactly what a healthy
   * sweep with no candidates also does. The distinguishing question is whether eligible
   * work EXISTS while nothing was evaluated, so that is what these two cases pin.
   */
  it('ALARMS when the scope list is empty but ready scout plans are eligible', async () => {
    maintenanceScopesMock.mockReset().mockResolvedValueOnce([]);
    // The operator-visible half of the alarm is the console line, so assert it rather
    // than merely silencing it (this suite fails on an unasserted console.warn).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const results = await scoutReadyAutostartSweep({
      listBlenderMaintenanceWorkspaceIds: () => ['papercusp-workspace', 'other-ws'],
      countEligibleReadyPlans: async (ws) => (ws === 'papercusp-workspace' ? 2 : 1),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ workspaceId: '*', installSlug: '*', outcome: 'error' });
    expect(results[0].reason).toContain('3 ready scout plan(s)');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[scout-ready-autostart] ALERT');
    warn.mockRestore();
  });

  it('stays SILENT when the scope list is empty and nothing is eligible — absence of work is not an alarm', async () => {
    maintenanceScopesMock.mockReset().mockResolvedValueOnce([]);

    await expect(
      scoutReadyAutostartSweep({
        listBlenderMaintenanceWorkspaceIds: () => ['papercusp-workspace'],
        countEligibleReadyPlans: async () => 0,
      }),
    ).resolves.toEqual([]);
  });

  /** A probe that cannot read must not manufacture an alarm, nor fail the sweep it audits. */
  it('fails SILENT when the eligibility probe throws', async () => {
    maintenanceScopesMock.mockReset().mockResolvedValueOnce([]);

    await expect(
      scoutReadyAutostartSweep({
        listBlenderMaintenanceWorkspaceIds: () => ['papercusp-workspace'],
        countEligibleReadyPlans: async () => {
          throw new Error('pg unreachable');
        },
      }),
    ).resolves.toEqual([]);
  });

  it('nudges the steward with the missing legs and repair item when promotion is triad-blocked', async () => {
    maintenanceScopesMock.mockReset().mockResolvedValueOnce([
      { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' },
    ]);
    axisEnabledMock.mockReset().mockResolvedValueOnce(true);
    sweepMocks.routineStorageSlug.mockReset().mockResolvedValueOnce('papercusp');
    sweepMocks.resolveMugOwner.mockReset().mockResolvedValueOnce('steward-1');
    sweepMocks.deliverScoutNudge.mockReset().mockResolvedValueOnce({ kind: 'su', ownerId: 'steward-1' });
    sweepMocks.sql
      .mockReset()
      .mockResolvedValueOnce([{ plan_slug: 'scout-gate-resilience', title: 'Gate resilience', has_open_items: true }])
      // P-004: startReadyScoutPlan reads the plan's revision hash through this same
      // `sql` before asking the admission gate, so the sequence has three queries.
      .mockResolvedValueOnce([{ content_hash: 'rev-1' }])
      .mockResolvedValueOnce([{ prev_op_status: null }]);
    promoteMock.mockReset().mockResolvedValueOnce({
      promoted: 0,
      skipped: 1,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'EI-TRIAD-REPAIR',
    });

    const results = await scoutReadyAutostartSweep();

    expect(results).toEqual([
      {
        workspaceId: 'papercusp-workspace',
        installSlug: 'papercusp',
        outcome: 'spec-triad-blocked',
        planSlug: 'scout-gate-resilience',
        promoted: 0,
        reason: 'promotion refused by spec triad (missing: requirements, design); repair EI-TRIAD-REPAIR',
      },
    ]);
    expect(sweepMocks.deliverScoutNudge).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'papercusp-workspace',
        mugOwner: 'steward-1',
        source: 'scout-ready-spec-triad',
        harnessSlug: 'papercusp',
        summary: expect.stringContaining('scout-gate-resilience'),
        payload: {
          kind: 'scout-ready-spec-triad-blocked',
          planSlug: 'scout-gate-resilience',
          missing: ['requirements', 'design'],
          repairWorkItem: 'EI-TRIAD-REPAIR',
        },
      }),
    );
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

  // P-004 (WI-2146077). This sweep is the one admission door with no human in front
  // of it: it turns a `ready` flip into claimable work on its own schedule, so an
  // unadmitted revision here becomes work the whole fleet picks up. It reaches no
  // plan-start-gate entrypoint, so the gate wired into checkPlanStartable cannot
  // cover it — these two cases are what prove its OWN call runs.
  it('REFUSES an unadmitted plan before promoting or writing the axis', async () => {
    // A pot that HAS opted into governance but has no certificate source is refused,
    // never passed — the fail-closed rule.
    configurePlanAdmissionPolicySource(async () => ({
      policyVersion: 3,
      quorumBps: 5_000,
      approvalBps: 6_667,
      ratificationWindowSec: 3_600,
      materiality: { maxChangedLines: 200, maxChangedItems: 3 },
    }));
    const { sql, queries } = fakeSql([{ content_hash: 'rev-1', prev_op_status: null }]);

    const r = await startReadyScoutPlan(sql, args, axis(true));

    expect(r.outcome).toBe('not-admitted');
    expect(r.promoted).toBe(0);
    expect(r.axisWritten).toBe(false);
    expect(r.admission?.code).toBe('missing-certificate');
    // The refusal must precede BOTH side effects, not merely report after them.
    expect(promoteMock).not.toHaveBeenCalled();
    expect(queries().join('\n')).not.toMatch(/SET\s+op_status/);
  });

  it('CONTROL: the same plan starts normally once the pot has not opted in', async () => {
    // The falsifier for the case above — without it, a refusal that fired
    // unconditionally would look identical to a working gate.
    const { sql } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({ promoted: 2, skipped: 0 });

    const r = await startReadyScoutPlan(sql, args, axis(true));

    expect(r.outcome).toBe('started');
    expect(promoteMock).toHaveBeenCalledTimes(1);
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

  it('carries the spec-triad refusal details to the ready-plan sweep', async () => {
    const { sql } = fakeSql([{ prev_op_status: null }]);
    promoteMock.mockResolvedValueOnce({
      promoted: 0,
      skipped: 1,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'EI-TRIAD-REPAIR',
    });

    await expect(startReadyScoutPlan(sql, args, axis(false))).resolves.toMatchObject({
      outcome: 'promoted',
      promoted: 0,
      flagOff: false,
      axisWritten: false,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'EI-TRIAD-REPAIR',
    });
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
