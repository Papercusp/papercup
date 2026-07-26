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

import * as dbOrg from '@papercusp/db-org';
import * as harnessCore from '../harness-core';
import * as workspaceRegistry from '../workspace-registry';

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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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

    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
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

    const mockSql = vi.fn().mockResolvedValueOnce(mockRoutines);
    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await enforceActiveRoutines();

    expect(result.autoDeactivated).toEqual([]);
    expect(mockSql).toHaveBeenCalledTimes(1); // only the SELECT — no UPDATE attempted
    const logged = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.startsWith('[routine-validation] FATAL'))).toBe(true);

    consoleSpy.mockRestore();
  });
});
