/**
 * Tests for the active-routines recurrence guard (EI-2224 P-2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateActiveRoutines, enforceActiveRoutines } from './validate-active-routines';

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

    // 1st call = the validator's SELECT; 2nd call = enforce's UPDATE ... RETURNING (1 row).
    const mockSql = vi
      .fn()
      .mockResolvedValueOnce(mockRoutines)
      .mockResolvedValueOnce([{ name: 'git-sync' }]);
    mockOrgPgSql(vi.mocked(dbOrg.getOrgPg), mockSql);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject).mockResolvedValueOnce(null); // unregistered

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.ok).toBe(false); // the scan still found a violation this pass
    expect(result.autoDeactivated).toEqual([{ installSlug: 'ei665-verify-x1', routineName: 'git-sync' }]);
    expect(mockSql).toHaveBeenCalledTimes(2); // SELECT, then exactly one UPDATE

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
      .mockResolvedValueOnce([]); // another worker won the race — 0 rows updated
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
    vi.mocked(harnessCore.resolveProject).mockResolvedValue({ slug: 'papercusp' } as any);
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
    consoleSpy.mockRestore();
  });
});
