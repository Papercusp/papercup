/**
 * scout-tick-install-slug-resolution.test.ts — regression guard for EI-19329929546171597.
 *
 * The defect: `success-metrics.ts` read Scout ticks under a HARDCODED `SCOUT_TICK_INSTALL_SLUG`
 * ('@singleton'), while `scheduler.ts`'s `recordTick` (the writer) already computed the install
 * slug dynamically from `workspaceBrainScopeKey(workspaceId, harnessSlug, isWorkspaceCoordinationOn())`.
 * The 2026-08-02 owner-attended WORKSPACE_COORDINATION graduation (default-ON) flipped the writer
 * from '@singleton' to the workspace sentinel — and the reader, still pinned to the constant, went
 * permanently blind: `blender:success-metrics` saw 0 ticks despite a healthy, actively-ticking
 * pipeline, pinning three release bars 'unknown' forever (blender-release-readiness PERMANENT NO-GO).
 *
 * These tests pin `resolveScoutTickInstallSlug` (the read-side mirror of the writer's own
 * computation) and `programSuccessReadScopes`'s wiring of its result, in isolation from PG, so a
 * future re-hardcoding of the install slug — or a writer/reader divergence on the flag read —
 * fails a fast unit test instead of silently blinding the release gate again.
 */
import { describe, expect, it, vi } from 'vitest';

const { isWorkspaceCoordinationOnMock } = vi.hoisted(() => ({
  isWorkspaceCoordinationOnMock: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../workspace-brain-scope', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isWorkspaceCoordinationOn: isWorkspaceCoordinationOnMock };
});

import { programSuccessReadScopes, resolveScoutTickInstallSlug, SCOUT_TICK_INSTALL_SLUG } from './success-metrics';

describe('resolveScoutTickInstallSlug — mirrors scheduler.ts recordTick exactly', () => {
  it('WORKSPACE_COORDINATION ON + a workspaceId ⇒ the workspace sentinel (post-graduation write key)', async () => {
    isWorkspaceCoordinationOnMock.mockResolvedValue(true);
    await expect(resolveScoutTickInstallSlug('papercusp-workspace')).resolves.toBe('papercusp-workspace');
  });

  it('WORKSPACE_COORDINATION OFF + a workspaceId ⇒ the legacy @singleton slug (pre-graduation write key)', async () => {
    isWorkspaceCoordinationOnMock.mockResolvedValue(false);
    await expect(resolveScoutTickInstallSlug('papercusp-workspace')).resolves.toBe(SCOUT_TICK_INSTALL_SLUG);
  });

  it('no workspaceId ⇒ always the legacy constant regardless of the flag (matches the writer\'s own fallback: opts.workspaceId ? workspaceBrainScopeKey(...) : harnessSlug)', async () => {
    isWorkspaceCoordinationOnMock.mockResolvedValue(true);
    await expect(resolveScoutTickInstallSlug(undefined)).resolves.toBe(SCOUT_TICK_INSTALL_SLUG);
    isWorkspaceCoordinationOnMock.mockResolvedValue(false);
    await expect(resolveScoutTickInstallSlug(undefined)).resolves.toBe(SCOUT_TICK_INSTALL_SLUG);
  });
});

describe('programSuccessReadScopes — resolvedTickInstallSlug wiring (EI-19329929546171597)', () => {
  it('uses the resolved writer slug for BOTH ticks and routed ideas under workspace coordination', async () => {
    isWorkspaceCoordinationOnMock.mockResolvedValue(true);
    const resolved = await resolveScoutTickInstallSlug('papercusp-workspace');
    const scopes = programSuccessReadScopes({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      nowMs: Date.now(),
      resolvedTickInstallSlug: resolved,
    });
    expect(scopes.cadence.tickInstallSlug).toBe('papercusp-workspace');
    expect(scopes.cadence.harnessSlug).toBe('papercusp-workspace');
    // su-ideate remains a per-harness partition; only the Scout-origin cadence partition
    // follows the workspace-brain writer key.
    expect(scopes.suIdeate.harnessSlug).toBe('papercusp');
  });

  it('falls back to the legacy constant when no resolved slug is supplied — byte-identical pre-fix behavior for existing callers', () => {
    const scopes = programSuccessReadScopes({ nowMs: Date.now() });
    expect(scopes.cadence.tickInstallSlug).toBe(SCOUT_TICK_INSTALL_SLUG);
  });
});
