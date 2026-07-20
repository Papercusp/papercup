/**
 * Tests for the home-harness startup validation (EI-2224).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateHomeHarnessResolution,
  homeHarnessValidationFatal,
  isLikelyFreshInstallGap,
} from './validate-home-harness';

// Mock the dependencies
vi.mock('../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: vi.fn(),
  HOME_HARNESS_ENV: 'PAPERCUSP_POT_HOME_SLUG',
}));

vi.mock('../harness-core', () => ({
  resolveProject: vi.fn(),
}));

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(),
}));

vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(),
}));

import * as homeHarness from '../harness/operator-home-harness';
import * as harnessCore from '../harness-core';
import * as workspaceRegistry from '../workspace-registry';
import * as harnessRegistry from '../harness-registry';

describe('validateHomeHarnessResolution', () => {
  const ORIGINAL_ENV_VALUE = process.env.PAPERCUSP_POT_HOME_SLUG;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCUSP_POT_HOME_SLUG;
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (ORIGINAL_ENV_VALUE === undefined) delete process.env.PAPERCUSP_POT_HOME_SLUG;
    else process.env.PAPERCUSP_POT_HOME_SLUG = ORIGINAL_ENV_VALUE;
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

  // EI-18189651437540304: a hermetic no-home-hive operator instance (e.g. the gym's
  // spawned gym-operator, boot-spec.ts) EXPLICITLY blanks PAPERCUSP_POT_HOME_SLUG to
  // declare "no home harness at all" — this must be a silent no-op, not a validation
  // failure against the legacy-default slug ('papercusp', which of course isn't
  // registered in an isolated hermetic workspace).
  it('is a no-op when PAPERCUSP_POT_HOME_SLUG is explicitly set to the empty string', async () => {
    process.env.PAPERCUSP_POT_HOME_SLUG = '';

    await expect(validateHomeHarnessResolution()).resolves.toBeUndefined();

    // Never even asked operatorHomeHarnessSlug()/resolveProject() to resolve anything —
    // the whole check is skipped, not merely tolerant of a null resolution.
    expect(homeHarness.operatorHomeHarnessSlug).not.toHaveBeenCalled();
    expect(harnessCore.resolveProject).not.toHaveBeenCalled();
  });

  it('still validates (and can still fail) when the env var is simply UNSET — only an explicit empty string is a no-op', async () => {
    // process.env.PAPERCUSP_POT_HOME_SLUG is deleted by the outer beforeEach (unset,
    // not ''), so operatorHomeHarnessSlug()'s own legacy-default fallback still governs
    // and validation still runs.
    vi.mocked(homeHarness.operatorHomeHarnessSlug).mockReturnValue('papercusp');
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue('some-workspace');
    vi.mocked(harnessCore.resolveProject).mockResolvedValue(null);

    await expect(validateHomeHarnessResolution()).rejects.toThrow(
      /does not resolve to a registered project/
    );
  });
});

describe('homeHarnessValidationFatal (EI-2633 — boot non-fatal by default)', () => {
  // The crash: re-throwing a failed validation in host-bootstrap's fire-and-forget IIFE was an
  // unhandled rejection → Node exit → embedded-PG down → dead on EVERY fresh packaged install.
  // This pins that the policy stays non-fatal unless explicitly opted in.
  it('is NON-FATAL by default (env unset) — a fresh packaged install must not crash on boot', () => {
    expect(homeHarnessValidationFatal({})).toBe(false);
  });

  it('hard-fails ONLY when explicitly opted in (PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL === "1")', () => {
    expect(homeHarnessValidationFatal({ PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL: '1' })).toBe(true);
  });

  it('treats any non-"1" value as non-fatal (0 / true / empty)', () => {
    expect(homeHarnessValidationFatal({ PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL: '0' })).toBe(false);
    expect(homeHarnessValidationFatal({ PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL: 'true' })).toBe(false);
    expect(homeHarnessValidationFatal({ PAPERCUSP_HOME_HARNESS_VALIDATION_FATAL: '' })).toBe(false);
  });
});

describe('isLikelyFreshInstallGap (EI-9919 — soften the fresh-install false alarm)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceRegistry.activeWorkspaceId).mockReturnValue('default');
  });

  it('is true when the workspace has ZERO registered projects (the fresh-install signature)', async () => {
    vi.mocked(harnessRegistry.loadHarnessRegistry).mockResolvedValue({ projects: [] } as any);

    await expect(isLikelyFreshInstallGap()).resolves.toBe(true);
    expect(harnessRegistry.loadHarnessRegistry).toHaveBeenCalledWith('default');
  });

  it('is false when other projects ARE registered — that is real drift, not a fresh install', async () => {
    vi.mocked(harnessRegistry.loadHarnessRegistry).mockResolvedValue({
      projects: [{ slug: 'some-other-project' }],
    } as any);

    await expect(isLikelyFreshInstallGap()).resolves.toBe(false);
  });

  it('uses an explicit workspaceId over the active one when given', async () => {
    vi.mocked(harnessRegistry.loadHarnessRegistry).mockResolvedValue({ projects: [] } as any);

    await isLikelyFreshInstallGap('some-workspace');

    expect(harnessRegistry.loadHarnessRegistry).toHaveBeenCalledWith('some-workspace');
  });

  it('conservatively reports false (NOT a fresh install) when the registry read throws', async () => {
    vi.mocked(harnessRegistry.loadHarnessRegistry).mockRejectedValue(new Error('registry unreadable'));

    await expect(isLikelyFreshInstallGap()).resolves.toBe(false);
  });
});
