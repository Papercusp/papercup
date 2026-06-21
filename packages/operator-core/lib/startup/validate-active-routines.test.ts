/**
 * Tests for the active-routines recurrence guard (EI-2224 P-2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateActiveRoutines } from './validate-active-routines';

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

  it('should handle empty routine list', async () => {
    const mockWs = 'papercusp-workspace';
    const mockSql = vi.fn().mockResolvedValue([]);

    vi.mocked(dbOrg.getOrgPg).mockReturnValue({ sql: mockSql } as any);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);

    const result = await validateActiveRoutines();

    expect(result.ok).toBe(true);
    expect(result.activeRoutineCount).toBe(0);
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
