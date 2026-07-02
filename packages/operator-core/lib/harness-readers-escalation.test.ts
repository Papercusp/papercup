import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { rows: Array<{ escalation: string; mtime_ms: number }>; artifact: string | null } = {
    rows: [],
    artifact: null,
  };
  const sql = (..._args: unknown[]) => Promise.resolve(state.rows);
  const resolvePhasedProject = vi.fn(async () => ({ slug: 'papercusp', path: '/tmp/papercusp-escalation' }));
  return { state, sql, resolvePhasedProject };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: H.sql }) };
});

vi.mock('./harness-core', async (orig) => {
  const actual = await orig<typeof import('./harness-core')>();
  return {
    ...actual,
    resolvePhasedProject: H.resolvePhasedProject,
    safeRead: () => null,
  };
});

vi.mock('./text-artifacts', () => ({
  loadTextArtifact: vi.fn(async (_slug: string, relPath: string) => (relPath === 'escalation.md' ? H.state.artifact : null)),
}));

vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

import { getEscalation } from './harness-readers';

beforeEach(() => {
  H.state.rows = [];
  H.state.artifact = null;
  H.resolvePhasedProject.mockClear();
});

describe('getEscalation', () => {
  it('uses the exact requested phase when reading harness_escalations rows', async () => {
    H.state.rows = [{ escalation: '{"kind":"git-sync-content-error"}', mtime_ms: 42 }];

    const res = await getEscalation('papercusp', 'git-sync-content');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(H.resolvePhasedProject).toHaveBeenCalledWith('papercusp', 'staging');
    expect(res.data.escalation).toContain('git-sync-content-error');
    expect(res.data.mtimeMs).toBe(42);
  });

  it('falls back to the newest row when no phase is requested', async () => {
    H.state.rows = [{ escalation: '{"kind":"git-sync-watchdog"}', mtime_ms: 99 }];

    const res = await getEscalation('papercusp');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(H.resolvePhasedProject).toHaveBeenCalledWith('papercusp', 'staging');
    expect(res.data.escalation).toContain('git-sync-watchdog');
  });

  it('falls back to escalation.md only when PG has no matching row', async () => {
    H.state.rows = [];
    H.state.artifact = 'from artifact';

    const res = await getEscalation('papercusp', 'git-sync-content');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.escalation).toBe('from artifact');
  });
});
