/**
 * EI-18752496371939475 — recurrence guard for the THIRD direction of the
 * handler/registration cross-check: a system action that is registered correctly and has NO
 * `harness_shared.routines` row, so it never fires.
 *
 * The bug this exists to stop is not a crash — it is GREEN CODE DOING NOTHING. `gc-dead-loops`
 * shipped fully built, 12/12 against real PG, handler correctly imported, and had never
 * executed once because the seed script that creates its row was never run. Every test in the
 * tree passed the whole time, because a seed script that is written but never RUN is invisible
 * to all of them.
 *
 * Each test below names the specific wrong behaviour it would catch, because several of the
 * failure modes here produce a CLEAN-LOOKING result (an empty offender list) rather than an
 * error — which is exactly how this class hides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateActiveRoutines } from './validate-active-routines';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));

vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn() }));

// Stub both dynamically-imported registry modules so the test controls exactly which handlers
// count as registered, and loads none of the ~100-module action graph.
const { standingRef, registeredRef } = vi.hoisted(() => ({
  standingRef: { current: [] as string[] },
  registeredRef: { current: new Set<string>() },
}));
vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/system-actions', () => ({
  getSystemAction: (name: string) => (registeredRef.current.has(name) ? () => undefined : undefined),
  listStandingSystemActions: () => standingRef.current,
}));

import * as dbOrg from '@papercusp/db-org';
import * as harnessCore from '../harness-core';
import * as workspaceRegistry from '../workspace-registry';
import { mockOrgPgSql } from '../testing/mock-org-pg';

const WS = 'ws-test';

/**
 * A `sql` tag that answers the two DIFFERENT queries the validator issues, keyed on the text
 * of the statement rather than on call order. Order-keyed fakes silently mis-answer the moment
 * a statement is added anywhere above them, which is how a fake starts testing nothing.
 */
function makeSql(opts: { activeRoutines?: unknown[]; targetRoles?: string[] }) {
  return vi.fn((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (text.includes('SELECT DISTINCT target_role')) {
      return Promise.resolve((opts.targetRoles ?? []).map((r) => ({ target_role: r })));
    }
    return Promise.resolve(opts.activeRoutines ?? []);
  }) as unknown as Parameters<typeof mockOrgPgSql>[1];
}

function arrange(opts: {
  standing: string[];
  targetRoles?: string[];
  activeRoutines?: unknown[];
}): void {
  standingRef.current = opts.standing;
  registeredRef.current = new Set(opts.standing);
  mockOrgPgSql(
    vi.mocked(dbOrg.getOrgPg),
    makeSql({ activeRoutines: opts.activeRoutines, targetRoles: opts.targetRoles }),
  );
  vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(WS);
  vi.mocked(harnessCore.resolveProject).mockResolvedValue({ slug: 'papercusp' } as any);
}

describe('unscheduled system actions (EI-18752496371939475, direction 3)', () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // `hostExecutesRoutines` gates the check; make this host one that does.
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    delete process.env.PAPERCUSP_DISABLE_BACKGROUND_WORKERS;
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    vi.restoreAllMocks();
  });

  it('reports a registered standing action that has NO routine row', async () => {
    // The whole point: `gc-dead-loops` is registered and green, and no row targets it.
    arrange({ standing: ['gc-dead-loops', 'git-sync'], targetRoles: ['system:git-sync'] });

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledCheckApplicable).toBe(true);
    expect(res.unscheduledSystemActions).toEqual(['gc-dead-loops']);
    // If this stayed true, the boot caller would print "startup validation passed" over the
    // top of a dead routine — the precise shape of the original bug.
    expect(res.ok).toBe(false);
  });

  it('does NOT report an action whose row exists but is INACTIVE', async () => {
    // Existence-only, deliberately. `enforceActiveRoutines` auto-pauses rows, so treating an
    // inactive row as unscheduled would make this guard re-flag its own sibling's remedy
    // forever. The active-state question belongs to bespoke-active-seeds-check.
    arrange({
      standing: ['template-gym'],
      targetRoles: ['system:template-gym'], // present in the table; active=false
      activeRoutines: [], // ...and therefore absent from the ACTIVE query
    });

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledSystemActions).toEqual([]);
    expect(res.unscheduledCheckApplicable).toBe(true);
  });

  it('does NOT report an action declared scheduling:"on-demand"', async () => {
    // `listStandingSystemActions()` is what applies the declaration, so an on-demand action
    // never reaches this check. Per-object actions (goal-start, blueprint-run, plan-run…)
    // legitimately have zero rows in a workspace that has no such objects yet.
    arrange({ standing: [], targetRoles: [] });

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledSystemActions).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('reports NOT-APPLICABLE (never a clean pass) on a host that does not execute routines', async () => {
    // WI-39810's three-case rule. Such a host is reading a different process's registry, so
    // an empty offender list here means "we did not look" — a caller that reads it as "healthy"
    // would clear a TRUE finding written by the host that does run routines.
    arrange({ standing: ['gc-dead-loops'], targetRoles: [] });
    process.env.PAPERCUSP_DISABLE_BACKGROUND_WORKERS = '1';
    delete process.env.PAPERCUSP_BACKGROUND_WORKERS;

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledCheckApplicable).toBe(false);
    expect(res.unscheduledSystemActions).toEqual([]);
  });

  it('reports NOT-APPLICABLE when the registry comes back EMPTY, instead of flagging everything', async () => {
    // The registry is a module-scoped Map, so a module-record split (or a half-loaded import)
    // yields an empty registry rather than an error. Without this guard the check would report
    // "every action is unscheduled" with total confidence — a false positive so large it would
    // permanently discredit the report.
    arrange({ standing: [], targetRoles: ['system:git-sync'] });

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledCheckApplicable).toBe(false);
    expect(res.unscheduledSystemActions).toEqual([]);
  });

  it('names the offender and the remedy in the emitted report', async () => {
    // A FATAL line nobody can act on gets ignored. The message must say which action is dead
    // AND what to do about it, since the fix is a seed run or a scheduling declaration —
    // neither of which is guessable from the action name alone.
    arrange({ standing: ['doc-anchor-reconcile'], targetRoles: [] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await validateActiveRoutines(WS);

    const line = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('doc-anchor-reconcile');
    expect(line).toMatch(/seed-<action>-routine|seed script/);
    expect(line).toContain("scheduling: 'on-demand'");
  });

  it('sorts offenders so a recurring report is byte-stable across boots', async () => {
    // The recurrence-aging machinery compares offender SETS between boots. An unstable order
    // makes an unchanged set look like a new transition every time, which is what turns a
    // FATAL into background noise.
    arrange({ standing: ['zzz-action', 'aaa-action'], targetRoles: [] });

    const res = await validateActiveRoutines(WS, { silent: true });

    expect(res.unscheduledSystemActions).toEqual(['aaa-action', 'zzz-action']);
  });
});
