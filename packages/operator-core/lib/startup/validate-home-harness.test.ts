/**
 * Tests for the home-harness startup validation (EI-2224).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateHomeHarnessResolution } from './validate-home-harness';

// Mock the dependencies
vi.mock('../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: vi.fn(),
}));

vi.mock('../harness-core', () => ({
  resolveProject: vi.fn(),
}));

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(),
}));

import * as homeHarness from '../harness/operator-home-harness';
import * as harnessCore from '../harness-core';
import * as workspaceRegistry from '../workspace-registry';

describe('validateHomeHarnessResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should pass when home harness slug resolves to a registered project', async () => {
    const mockSlug = 'papercusp';
    const mockWs = 'papercusp-workspace';
    const mockProject = { slug: 'papercusp', path: '/some/path' };

    vi.mocked(homeHarness.operatorHomeHarnessSlug).mockReturnValue(mockSlug);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject).mockResolvedValue(mockProject as any);

    // Should not throw
    await expect(validateHomeHarnessResolution()).resolves.toBeUndefined();

    expect(harnessCore.resolveProject).toHaveBeenCalledWith(mockSlug, mockWs);
  });

  it('should throw when home harness slug is empty', async () => {
    vi.mocked(homeHarness.operatorHomeHarnessSlug).mockReturnValue('');

    await expect(validateHomeHarnessResolution()).rejects.toThrow(
      /STARTUP VALIDATION FAILED.*empty slug/
    );
  });

  it('should throw when home harness slug does not resolve', async () => {
    const mockSlug = 'papercup';
    const mockWs = 'papercusp-workspace';

    vi.mocked(homeHarness.operatorHomeHarnessSlug).mockReturnValue(mockSlug);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    vi.mocked(harnessCore.resolveProject).mockResolvedValue(null);

    await expect(validateHomeHarnessResolution()).rejects.toThrow(
      /does not resolve to a registered project/
    );

    expect(harnessCore.resolveProject).toHaveBeenCalledWith(mockSlug, mockWs);
  });

  it('should catch slug mismatch between papercup and papercusp', async () => {
    const mockSlug = 'papercup'; // Old slug
    const mockWs = 'papercusp-workspace';

    vi.mocked(homeHarness.operatorHomeHarnessSlug).mockReturnValue(mockSlug);
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue(mockWs);
    // Registry only has papercusp, not papercup
    vi.mocked(harnessCore.resolveProject).mockResolvedValue(null);

    await expect(validateHomeHarnessResolution()).rejects.toThrow(
      /fire-paths.*404/
    );
  });
});
