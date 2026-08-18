/**
 * Tests for the active-routines recurrence guard (EI-2224 P-2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateActiveRoutines,
  enforceActiveRoutines,
  hostExecutesRoutines,
} from './validate-active-routines';

// Mock the dependencies
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(),
}));

vi.mock('../harness-core', () => ({
  resolveProject: vi.fn(),
}));

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(),
}));

// EI-19367772473246483: the unregistered-system-action check populates the registry via a
// side-effect import of ~100 action modules. Stub both dynamically-imported modules so the
// test controls exactly which handlers count as registered (and loads none of that graph).
const { registeredRef } = vi.hoisted(() => ({ registeredRef: { current: new Set<string>() } }));
vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/system-actions', () => ({
  getSystemAction: (name: string) => (registeredRef.current.has(name) ? () => undefined : undefined),
}));

import * as dbOrg from '@papercusp/db-org';
import * as harnessCore from '../harness-core';
import * as workspaceRegistry from '../workspace-registry';
import { mockOrgPgSql } from '../testing/mock-org-pg';

/**
 * The SQL text of every statement the mocked `sql` tag was called with.
 *
 * The "issues no UPDATE" tests below used to assert `mockSql` was called exactly N times.
 * That counts STATEMENTS when the property they mean is "no row was PAUSED" — so adding any
 * unrelated statement (EI-18685043834332306 added four for recurrence aging) broke them while
 * the property they guard was never in question. Assert the property directly instead: it
 * still fails loudly if a pause UPDATE ever appears, and no longer fails when it does not.
 */
/**
 * Stub `resolveProject` for rows whose `install_slug` is fine, so the harness leg passes and
 * the leg actually under test is the only thing that can fail. The validator only reads this
 * value for truthiness, so a slug-only stand-in is faithful — the cast lives here ONCE rather
 * than at each call site (`lint:mock-cast-escape` is a shrink-only ratchet).
 */
function stubResolvedProject(slug: string): void {
  vi.mocked(harnessCore.resolveProject).mockResolvedValue({ slug } as any);
}

/**
 * How many statements PAUSED a row. The count-of-all-statements form broke a third time in
 * WI-39810 (which added a resolved-mark clear), for the reason the comment above gives.
 */
function pauseUpdateCount(mockSql: { mock: { calls: unknown[][] } }): number {
  return mockSql.mock.calls.filter((c) =>
    /SET\s+active\s*=\s*false/i.test(Array.isArray(c[0]) ? c[0].join(' ? ') : String(c[0])),
  ).length;
}

function pausedARow(mockSql: { mock: { calls: unknown[][] } }): boolean {
  return mockSql.mock.calls.some((c) =>
    /SET\s+active\s*=\s*false/i.test(Array.isArray(c[0]) ? c[0].join(' ? ') : String(c[0])),
  );
}

describe('validateActiveRoutines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should pass when all active routines target registered projects', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [
      { install_slug: 'papercusp', name: 'improvement-implement', workspace_id: mockWs },
      { install_slug: 'other-hive', name: 'git-sync', workspace_id: mockWs },
    ];

    const mockSql = vi.fn().mockResolvedValue(mockRoutines);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject)
      .mockResolvedValueOnce({ slug: 'papercusp' } as any)
      .mockResolvedValueOnce({ slug: 'other-hive' } as any);

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(true);
    expect(result.activeRoutineCount).toBe(2);
    expect(result.activeRoutineNames).toEqual(['improvement-implement@papercusp', 'git-sync@other-hive']);
    expect(result.unregisteredHarnesses.size).toBe(0);
    expect(result.problematicRoutines).toHaveLength(0);
  });

  it('should detect routines targeting unregistered harnesses', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [
      { install_slug: 'papercup', name: 'improvement-implement', workspace_id: mockWs },
      { install_slug: 'papercusp', name: 'git-sync', workspace_id: mockWs },
    ];

    const mockSql = vi.fn().mockResolvedValue(mockRoutines);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    // Only papercusp resolves; papercup returns null (unregistered)
    vi.mocked(harnessCore.resolveProject)
      .mockResolvedValueOnce(null) // papercup → unregistered
      .mockResolvedValueOnce({ slug: 'papercusp' } as any); // papercusp → OK

    // Mock console.error to suppress FATAL log
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(false);
    expect(result.activeRoutineCount).toBe(2);
    expect(result.unregisteredHarnesses.size).toBe(1);
    expect(Array.from(result.unregisteredHarnesses)).toContain('papercup');
    expect(result.problematicRoutines).toHaveLength(1);
    expect(result.problematicRoutines[0]).toMatchObject({
      installSlug: 'papercup',
      routineName: 'improvement-implement',
    });
    // Verify FATAL error was logged
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[routine-validation] FATAL'));

    consoleSpy.mockRestore();
  });

  it('accepts reserved singleton and workspace hosts without registry lookups', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [
      {
        install_slug: '@singleton',
        name: 'bp-singleton-scout-0',
        workspace_id: mockWs,
      },
      {
        install_slug: mockWs,
        name: 'workspace-learning-pulse',
        workspace_id: mockWs,
      },
    ];

    const mockSql = vi.fn().mockResolvedValue(mockRoutines);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(true);
    expect(result.activeRoutineCount).toBe(2);
    expect(result.activeRoutineNames).toEqual([
      'bp-singleton-scout-0@@singleton',
      `workspace-learning-pulse@${mockWs}`,
    ]);
    expect(result.problematicRoutines).toHaveLength(0);
    expect(harnessCore.resolveProject).not.toHaveBeenCalled();
  });

  it('should handle empty routine list', async () => {
    const mockWs = 'papercusp-workspace';
    const mockSql = vi.fn().mockResolvedValue([]);

    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(true);
    expect(result.activeRoutineCount).toBe(0);
    expect(result.activeRoutineNames).toEqual([]);
    expect(result.problematicRoutines).toHaveLength(0);
  });

  it('should detect empty slug as problematic', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [{ install_slug: '', name: 'broken-routine', workspace_id: mockWs }];

    const mockSql = vi.fn().mockResolvedValue(mockRoutines);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    // Mock console.error to suppress FATAL log
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(false);
    expect(result.problematicRoutines).toHaveLength(1);
    // Empty slug is recorded as '<empty>' to distinguish from unset
    expect(result.problematicRoutines[0].installSlug).toBe('<empty>');
    // Verify FATAL error was logged
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[routine-validation] FATAL'));

    consoleSpy.mockRestore();
  });
});

describe('enforceActiveRoutines (EI-18678269428596559 recurrence guard P-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('auto-deactivates an active routine targeting an unregistered harness, and logs AUTO-DEACTIVATED (not FATAL)', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [{ install_slug: 'ei665-verify-x1', name: 'git-sync', workspace_id: mockWs }];

    // 1st call = the validator's SELECT; 2nd = enforce's UPDATE ... RETURNING (1 row);
    // 3rd = WI-39810's resolved-mark clear (no system-action offenders in this fixture).
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce(mockRoutines)
      .mockResolvedValueOnce([{ name: 'git-sync' }])
      .mockResolvedValue([]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject).mockResolvedValueOnce(null); // unregistered

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.ok).toBe(false); // the scan still found a violation this pass
    expect(result.autoDeactivated).toEqual([{ installSlug: 'ei665-verify-x1', routineName: 'git-sync' }]);
    expect(pauseUpdateCount(mockSql)).toBe(1); // exactly one row-pausing UPDATE

    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('[routine-validation] AUTO-DEACTIVATED'))).toBe(true);
    // The validator's own FATAL is suppressed (silent:true) — enforce does its own logging.
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(false);

    consoleSpy.mockRestore();
  });

  it('logs nothing for a routine a concurrent process already paused (UPDATE affects 0 rows)', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [{ install_slug: 'ei665-verify-x1', name: 'green-checkpoint', workspace_id: mockWs }];

    const mockSql = vi
      .fn()
      .mockResolvedValueOnce(mockRoutines)
      .mockResolvedValueOnce([]) // another worker won the race — 0 rows updated
      .mockResolvedValue([]); // WI-39810's resolved-mark clear — nothing to clear
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject).mockResolvedValueOnce(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.autoDeactivated).toEqual([]);
    // No AUTO-DEACTIVATED (we didn't do it) and no FATAL (it's not our problem to report —
    // this is exactly the dedup that stops ~15 concurrent workers each logging the same thing).
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('never auto-heals a blank install_slug — keeps logging FATAL, issues no UPDATE', async () => {
    const mockWs = 'papercusp-workspace';
    const mockRoutines = [{ install_slug: '', name: 'broken-routine', workspace_id: mockWs }];

    // The SELECT, then `[]` for every recurrence-aging statement — which drives the
    // fail-OPEN branch (nothing claimed the wave and no peer mark appeared), so the FATAL
    // must still be emitted. Losing the alarm here would be the worst outcome.
    const mockSql = vi.fn().mockResolvedValueOnce(mockRoutines).mockResolvedValue([]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.autoDeactivated).toEqual([]);
    expect(pausedARow(mockSql)).toBe(false); // no UPDATE attempted — a blank slug is never auto-healed
    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(true);

    consoleSpy.mockRestore();
  });
});

/**
 * EI-19367772473246483 — an ACTIVE `system:<action>` routine whose handler was never
 * registered fires forever into `no handler registered … skipping` while this validator
 * reported "startup validation passed" and NAMED it in the resolving list.
 *
 * Live cost of the gap: WI-6639's `sweep-stalled-loops` (the guard that disarms/escalates
 * stalled engine loops) ticked hourly as a NO-OP because nothing imported its action module —
 * so the very mechanism meant to escalate a silently-halted loop was itself silently halted.
 */
describe('validateActiveRoutines — unregistered system-action handlers (EI-19367772473246483)', () => {
  const mockWs = 'papercusp-workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    registeredRef.current = new Set<string>();
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    // These rows carry a real install_slug, so the harness leg must pass for the
    // system-action leg to be the only thing under test.
    stubResolvedProject('papercusp');
  });
  afterEach(() => vi.clearAllMocks());

  it('flags an active system: routine whose handler is NOT registered, and fails ok', async () => {
    registeredRef.current = new Set(['git-sync']); // sweep-stalled-loops deliberately absent
    const mockSql = vi.fn().mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'sweep-stalled-loops',
        workspace_id: mockWs,
        target_role: 'system:sweep-stalled-loops',
        reschedule_interval_sec: null,
        target_owner_id: null,
      },
    ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    expect(result.unregisteredSystemActions).toEqual([
      {
        installSlug: 'papercusp',
        routineName: 'sweep-stalled-loops',
        action: 'sweep-stalled-loops',
        workspaceId: mockWs,
      },
    ]);
    // `ok` must go false — this is what stops the boot log printing the reassuring
    // "startup validation passed — N active routine(s) resolve" line over a dead routine.
    expect(result.ok).toBe(false);
    // Kept OUT of problematicRoutines: that bucket is what enforceActiveRoutines PAUSES,
    // and pausing is the wrong remedy for a missing import.
    expect(result.problematicRoutines).toHaveLength(0);
    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('NO REGISTERED HANDLER'))).toBe(true);
    consoleSpy.mockRestore();
  });

  it('passes when the handler IS registered', async () => {
    registeredRef.current = new Set(['sweep-stalled-loops']);
    const mockSql = vi.fn().mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'sweep-stalled-loops',
        workspace_id: mockWs,
        target_role: 'system:sweep-stalled-loops',
        reschedule_interval_sec: null,
        target_owner_id: null,
      },
    ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const result = await validateActiveRoutines();

    expect(result.unregisteredSystemActions).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('NEVER flags an inline loop fire — it bypasses the registry by dispatch precedence', async () => {
    // The false-positive that matters: measured live, 36 of 155 active `system:%` routines are
    // `system:loop-wake` engine loops handled INLINE by fireLoopWake(). `system:%` alone would
    // flag every one of them, against a guard whose sibling auto-pauses what it flags.
    registeredRef.current = new Set<string>(); // empty registry — the harshest case
    const mockSql = vi.fn().mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'loop-su-7854d874',
        workspace_id: mockWs,
        target_role: 'system:loop-wake',
        reschedule_interval_sec: 900,
        target_owner_id: 'su-7854d874',
      },
    ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const result = await validateActiveRoutines();

    expect(result.unregisteredSystemActions).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('still flags a system: routine that has an interval but NO bound owner (not a loop fire)', async () => {
    // Guards the exemption's precision: dispatch requires BOTH an interval and an owner to
    // take the inline path, so an interval alone must not buy an exemption.
    registeredRef.current = new Set<string>();
    const mockSql = vi.fn().mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'some-cadenced-action',
        workspace_id: mockWs,
        target_role: 'system:some-cadenced-action',
        reschedule_interval_sec: 600,
        target_owner_id: null,
      },
    ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    expect(result.unregisteredSystemActions).toHaveLength(1);
    expect(result.unregisteredSystemActions[0].action).toBe('some-cadenced-action');
    consoleSpy.mockRestore();
  });

  it('enforceActiveRoutines REPORTS an unregistered handler but issues no UPDATE', async () => {
    registeredRef.current = new Set<string>();
    const mockSql = vi.fn().mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'sweep-stalled-loops',
        workspace_id: mockWs,
        target_role: 'system:sweep-stalled-loops',
        reschedule_interval_sec: null,
        target_owner_id: null,
      },
    ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.autoDeactivated).toEqual([]);
    expect(pausedARow(mockSql)).toBe(false); // the row is correct, the code is not — never pause it
    // enforce passes silent:true, so it must re-emit the report itself or the boot caller
    // (which logs only on `ok`) prints nothing at all.
    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('NO REGISTERED HANDLER'))).toBe(true);
    // EI-18685043834332306: a first sighting is still FATAL, and now carries the facts that
    // let a reader tell it apart from the ten-thousandth.
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(true);
    expect(logged.some((l) => l.includes('[CHANGED: 1 NEW'))).toBe(true);
    consoleSpy.mockRestore();
  });
});

/**
 * EI-18685043834332306 — the two FATALs whose remedy is a human or code change fired
 * identically on their first occurrence and their ten-thousandth, which teaches every reader
 * to filter the line out (exactly how EI-10733 rotted for 30 days behind a working detector).
 *
 * The property under test is the TRANSITION rule: FATAL is reserved for a change in the SET of
 * offenders, and an identical recurrence collapses to one chronic line that still carries the
 * full evidence. Evidence is de-escalated, never dropped.
 */
describe('routine-validation FATAL recurrence aging (EI-18685043834332306)', () => {
  const mockWs = 'papercusp-workspace';
  const OFFENDER = {
    install_slug: 'papercusp',
    name: 'sweep-stalled-loops',
    workspace_id: mockWs,
    target_role: 'system:sweep-stalled-loops',
    reschedule_interval_sec: null,
    target_owner_id: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registeredRef.current = new Set<string>(); // the handler is missing — the row itself is fine
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    stubResolvedProject('papercusp');
  });
  afterEach(() => vi.clearAllMocks());

  it('collapses an UNCHANGED offender set to one chronic warn instead of a fresh FATAL', async () => {
    const now = Date.now();
    const mockSql = vi
      .fn()
      // 1. the active-routines SELECT
      .mockResolvedValueOnce([OFFENDER])
      // 2. readRoutineValidationMarks — this offender is already marked, i.e. chronic
      .mockResolvedValueOnce([
        {
          install_slug: 'papercusp',
          name: 'sweep-stalled-loops',
          mark: { firstSeenMs: now - 7_200_000, lastSeenMs: now - 90_000, occurrences: 41 },
        },
      ])
      // 3. claimRoutineValidationWave — we win the wave, so we own the report
      .mockResolvedValueOnce([{ name: 'sweep-stalled-loops' }])
      // 4. clearRoutineValidationMarks — nothing resolved, so the set did NOT shrink
      .mockResolvedValueOnce([]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enforceActiveRoutines();

    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    // The word FATAL itself has to flip, not just the suffix — otherwise the line still READS
    // as fatal at a glance and the whole "distinguishable" ask fails.
    expect(warned.some((l) => l.startsWith('[routine-validation] CHRONIC'))).toBe(true);
    expect(warned.some((l) => l.includes('42nd consecutive check'))).toBe(true);
    // Evidence is de-escalated, never dropped: the chronic line still names the condition.
    expect(warned.some((l) => l.includes('NO REGISTERED HANDLER'))).toBe(true);
    expect(errorSpy.mock.calls.map((c) => String(c[0]))).not.toContain(
      expect.stringContaining('[routine-validation] FATAL'),
    );
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('stays SILENT when a peer worker in the same boot wave already claimed the report', async () => {
    // The ~15-identical-lines-per-second complaint in this file's header. The pause path
    // solves its half with predicate serialization; this is the same trick for a condition
    // that has no naturally self-limiting predicate.
    const now = Date.now();
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([OFFENDER])
      .mockResolvedValueOnce([])
      // claim matches 0 rows — a peer got there first
      .mockResolvedValueOnce([])
      // the disambiguating re-read: a mark INSIDE the wave window proves the peer is reporting
      .mockResolvedValueOnce([
        {
          install_slug: 'papercusp',
          name: 'sweep-stalled-loops',
          mark: { firstSeenMs: now - 1_000, lastSeenMs: now - 1_000, occurrences: 7 },
        },
      ]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enforceActiveRoutines();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('FAILS OPEN: a lost wave with NO peer mark re-emits the un-aged FATAL', async () => {
    // 0 rows from the wave gate is ambiguous — a peer won, OR the row never matched at all
    // (identity drift, row deleted mid-boot). Only the first means someone else is reporting.
    // Read the second as "silent" and the alarm vanishes with no error anywhere.
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([OFFENDER])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // claim lost
      .mockResolvedValueOnce([]); // ...and no peer mark appeared
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enforceActiveRoutines();

    const logged = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(true);
    expect(logged.some((l) => l.includes('NO REGISTERED HANDLER'))).toBe(true);
    // It says so, rather than inventing recurrence facts it does not have.
    expect(logged.some((l) => l.includes('episode row not matchable'))).toBe(true);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('FAILS OPEN: a storage fault re-emits the un-aged FATAL rather than losing the alarm', async () => {
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce([OFFENDER])
      .mockRejectedValue(new Error('relation "harness_shared.routines" does not exist'));
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enforceActiveRoutines();

    const logged = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(true);
    expect(logged.some((l) => l.includes('aging unavailable'))).toBe(true);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('recurrence aging unavailable'))).toBe(true);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

/**
 * WI-39810 — the unregistered-handler check must only run on a host that DISPATCHES routines.
 *
 * The live failure: `papercup-dev-api` boots request-only (`PAPERCUSP_BACKGROUND_WORKERS=0`)
 * out of the RELEASE checkout, which lagged `staging` by four `import './<x>-action'` lines
 * while `main` sat behind a red gate. It reported `consult-expiry-sweep`, `coverage-census`,
 * `idle-backend-reaper` and `project-history-refresh` as having NO REGISTERED HANDLER, and the
 * marks reached 210+ occurrences — while bg-host was demonstrably executing all four on
 * cadence out of `staging`. `routines:list` rendered a live routine as SILENTLY DEAD and told
 * the reader to add an import that was already present in the tree being edited.
 *
 * The property: a host whose registry is not the dispatching one reports NOTHING, and stays
 * distinguishable from a host that looked and found nothing (`systemActionCheckApplicable`).
 */
describe('unregistered-handler check is scoped to the routine-dispatching host (WI-39810)', () => {
  const mockWs = 'papercusp-workspace';

  /** The routine row the EXISTING suite above proves IS flagged on a dispatching host. */
  const deadRoutineRow = {
    install_slug: 'papercusp',
    name: 'sweep-stalled-loops',
    workspace_id: mockWs,
    target_role: 'system:sweep-stalled-loops',
    reschedule_interval_sec: null,
    target_owner_id: null,
  };

  /** Did any statement CLEAR persisted validation marks? (`clearRoutineValidationMarks`) */
  function clearedMarks(mockSql: { mock: { calls: unknown[][] } }): boolean {
    return mockSql.mock.calls.some((c) =>
      /jsonb_exists\(metadata->'validation'/i.test(
        Array.isArray(c[0]) ? c[0].join(' ? ') : String(c[0]),
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    registeredRef.current = new Set<string>(); // EMPTY registry — flags everything on a dispatching host
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    stubResolvedProject('papercusp');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe('hostExecutesRoutines', () => {
    it('is FALSE for a request-only host — the topology that produced the false positives', () => {
      expect(hostExecutesRoutines({ PAPERCUSP_BACKGROUND_WORKERS: '0' })).toBe(false);
    });

    it('is TRUE for the background-workers host that actually dispatches routines', () => {
      expect(hostExecutesRoutines({ PAPERCUSP_BACKGROUND_WORKERS: '1' })).toBe(true);
    });

    it('is FALSE for the :3170 staging host, which boots request-only by default', () => {
      expect(hostExecutesRoutines({ PAPERCUSP_HONO_PORT: '3170' })).toBe(false);
    });

    it('IGNORES the VITEST short-circuit, so this guard is never vacuously green in its own suite', () => {
      // `backgroundWorkersEnabled` returns false under VITEST so unit tests never start real
      // background work. Honouring that clause here would skip the check in every case below,
      // and they would all pass while asserting nothing.
      expect(hostExecutesRoutines({ VITEST: 'true' })).toBe(true);
    });
  });

  it('SKIPS the check on a request-only host — the same input a dispatching host flags', async () => {
    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
    const mockSql = vi.fn().mockResolvedValue([deadRoutineRow]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    // CALIBRATION: this exact row + empty registry yields one offender on a dispatching host
    // (the case immediately below). Here it must yield none — so a pass cannot be explained
    // by the input being harmless.
    expect(result.unregisteredSystemActions).toHaveLength(0);
    expect(result.systemActionCheckApplicable).toBe(false);
    expect(result.ok).toBe(true);
    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('NO REGISTERED HANDLER'))).toBe(false);
    consoleSpy.mockRestore();
  });

  it('RUNS the check on the dispatching host, and says so', async () => {
    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '1');
    const mockSql = vi.fn().mockResolvedValue([deadRoutineRow]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await validateActiveRoutines();

    expect(result.systemActionCheckApplicable).toBe(true);
    expect(result.unregisteredSystemActions).toHaveLength(1);
    expect(result.ok).toBe(false);
    consoleSpy.mockRestore();
  });

  it('enforce CLEARS a stale mark once every handler resolves on the dispatching host', async () => {
    // Before WI-39810 the clear lived only inside `ageFatalClass`, which is reached only when
    // the offender set is NON-empty — so a mark outlived the defect that caused it and
    // `routines:list` kept rendering an already-fixed routine as SILENTLY DEAD, forever.
    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '1');
    registeredRef.current = new Set(['sweep-stalled-loops']); // now registered
    const mockSql = vi.fn().mockResolvedValue([deadRoutineRow]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const result = await enforceActiveRoutines();

    expect(result.unregisteredSystemActions).toHaveLength(0);
    expect(result.systemActionCheckApplicable).toBe(true);
    expect(clearedMarks(mockSql)).toBe(true);
  });

  it('enforce does NOT clear on a request-only host — that mark belongs to the dispatching host', async () => {
    // The dangerous inverse: dev-api boots, cannot see the registry, and must not erase a TRUE
    // finding bg-host wrote. "No offenders" and "did not look" must not collapse.
    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
    registeredRef.current = new Set(['sweep-stalled-loops']);
    const mockSql = vi.fn().mockResolvedValue([deadRoutineRow]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);

    const result = await enforceActiveRoutines();

    expect(result.systemActionCheckApplicable).toBe(false);
    expect(clearedMarks(mockSql)).toBe(false);
  });
});
