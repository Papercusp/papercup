import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlUnsafe = vi.fn(async () => []);
const appendTextArtifact = vi.fn(async () => {});
const loadTextArtifact = vi.fn(async () => 'notes from pg');
const deleteTextArtifact = vi.fn(async () => {});
const resolvePhasedProject = vi.fn(async () => ({ slug: 'papercusp', path: '/tmp/papercusp-route' }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: { unsafe: sqlUnsafe } }) };
});

vi.mock('../../harness-core', async (orig) => {
  const actual = await orig<typeof import('../../harness-core')>();
  return {
    ...actual,
    resolvePhasedProject,
    harnessDir: () => '/tmp/papercusp-route/.papercusp',
    safeRead: () => null,
  };
});

vi.mock('../../text-artifacts', () => ({
  appendTextArtifact,
  loadTextArtifact,
  deleteTextArtifact,
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

import type { RouteContext } from '../define-route';

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: { slug: 'papercusp' },
  log: () => {},
  signal: new AbortController().signal,
};

type Route = {
  method: string;
  path: string;
  handler: (req: Request, ctx: RouteContext) => Promise<Response>;
};

async function route(): Promise<Route> {
  const mod = await import('../routes/harness/supervisor-actions');
  const r = (mod.default as Route[]).find((x) => x.method === 'POST' && x.path === '/harness/:slug/escalation/resolve');
  if (!r) throw new Error('resolve route not registered');
  return r;
}

beforeEach(() => {
  sqlUnsafe.mockClear();
  appendTextArtifact.mockClear();
  loadTextArtifact.mockClear();
  deleteTextArtifact.mockClear();
  resolvePhasedProject.mockClear();
});

describe('POST /harness/:slug/escalation/resolve', () => {
  it('updates the exact requested harness_escalations phase row for non-lifecycle phases', async () => {
    const r = await route();
    const res = await r.handler(
      new Request('http://localhost/api/harness/papercusp/escalation/resolve?phase=git-sync-content', {
        method: 'POST',
        body: JSON.stringify({ response: 'fixed by owner', action: 'clear' }),
        headers: { 'content-type': 'application/json' },
      }),
      CTX,
    );

    expect(resolvePhasedProject).toHaveBeenCalledWith('papercusp', 'staging');
    expect(appendTextArtifact).toHaveBeenCalled();
    expect(deleteTextArtifact).toHaveBeenCalledWith('papercusp', 'escalation.md');
    expect(sqlUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE harness_shared.harness_escalations'),
      expect.arrayContaining(['ws-test', 'papercusp']),
    );
    // The single non-green-checkpoint phase is NOT fanned out — targetPhases stays a
    // 1-element array containing just the requested phase.
    const [, params] = sqlUnsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[2]).toEqual(['git-sync-content']);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, cleared: true, supervisorNotes: 'notes from pg' });
  });

  it('EI-9205: fans a green-checkpoint-* triage out to BOTH sibling phases in one call', async () => {
    const r = await route();
    const res = await r.handler(
      new Request('http://localhost/api/harness/papercusp/escalation/resolve?phase=green-checkpoint-watchdog', {
        method: 'POST',
        body: JSON.stringify({ response: 'still stalled, keeping open', action: 'keep' }),
        headers: { 'content-type': 'application/json' },
      }),
      CTX,
    );

    expect(sqlUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE harness_shared.harness_escalations'),
      expect.anything(),
    );
    const [, params] = sqlUnsafe.mock.calls[0] as unknown as [string, unknown[]];
    // Both green-checkpoint escalation phases get targeted by a single triage call —
    // this is the fix for EI-9197 → EI-9203 (annotating one phase left the sibling
    // free to re-fire a near-duplicate unresolved-escalation work-item).
    expect(params[2]).toEqual(['green-checkpoint-stall', 'green-checkpoint-watchdog']);
    expect(res.status).toBe(200);
  });

  it('does not fan out a phase unrelated to the green-checkpoint pair', async () => {
    const r = await route();
    await r.handler(
      new Request('http://localhost/api/harness/papercusp/escalation/resolve?phase=git-sync-watchdog', {
        method: 'POST',
        body: JSON.stringify({ response: 'unrelated stall', action: 'keep' }),
        headers: { 'content-type': 'application/json' },
      }),
      CTX,
    );
    const [, params] = sqlUnsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[2]).toEqual(['git-sync-watchdog']);
  });
});
