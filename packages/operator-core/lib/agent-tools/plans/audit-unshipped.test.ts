import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  run: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
  operatorHomeHarnessSlug: vi.fn(() => 'papercusp'),
}));

vi.mock('../../unshipped-plans-audit', () => ({
  runUnshippedPlansAudit: M.run,
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: M.activeWorkspaceId,
}));
vi.mock('../../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: M.operatorHomeHarnessSlug,
}));

import tool from './audit-unshipped';

const ctx = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  role: 'operator',
} as never;

function result() {
  return {
    manifest: {
      generatedAt: '2026-08-20T12:00:01.000Z',
      scope: { classifierRevision: 2 },
      rows: [
        { slug: 'retire-me', category: 'supersede-documented' },
        { slug: 'blocked-stale', category: 'typed-blocker-stale-hint' },
        { slug: 'protected', category: 'ongoing-protected' },
      ],
      bands: {
        protected: 1,
        closeoutOrReconcile: 0,
        supersedeOrRetire: 1,
        blockerClaims: 1,
        unblockedPartial: 0,
        catalogResidue: 0,
      },
      blockerEvidence: { typedCurrent: 0, typedWithStaleHint: 1, textOnly: 0 },
    },
    artifacts: {
      harness: 'papercusp',
      json: 'reports/unshipped-plans-audit/latest.json',
      html: 'reports/unshipped-plans-audit/latest.html',
    },
  };
}

function parse(output: { data?: Record<string, unknown>; content?: Array<{ text: string }> }) {
  return output.data ?? JSON.parse(output.content![0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  M.run.mockReset();
  M.run.mockResolvedValue(result());
  M.activeWorkspaceId.mockClear();
  M.operatorHomeHarnessSlug.mockClear();
});

describe('plans:audit-unshipped', () => {
  it('uses the active workspace and operator-home harness by default', async () => {
    const output = parse(await tool.handler({}, ctx) as never);

    expect(M.run).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'papercusp-workspace',
      artifactHarness: 'papercusp',
    });
    expect(output).toMatchObject({
      ok: true,
      manual: true,
      scheduled: false,
      readOnlyLifecycle: true,
      classifierRevision: 2,
      rows: 3,
      documentedSupersession: ['retire-me'],
      staleBlockers: ['blocked-stale'],
    });
    expect(output.next).toMatch(/re-read live ownership/i);
  });

  it('allows only the artifact owner harness to be overridden; scope stays workspace-wide', async () => {
    const output = parse(await tool.handler({ harness: 'operator-home' }, ctx) as never);

    expect(M.run).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'papercusp-workspace',
      artifactHarness: 'operator-home',
    });
    expect(M.operatorHomeHarnessSlug).not.toHaveBeenCalled();
    expect(output).toMatchObject({ workspace: 'papercusp-workspace', manual: true, scheduled: false });
  });

  it('advertises the manual/read-only boundary in the registered tool contract', () => {
    expect(tool.name).toBe('plans:audit-unshipped');
    expect(tool.description).toMatch(/read-only/i);
    expect(tool.description).toMatch(/does not create or arm a schedule/i);
    expect(tool.rolesQuota).toEqual({ operator: { perRun: 5 } });
  });
});
