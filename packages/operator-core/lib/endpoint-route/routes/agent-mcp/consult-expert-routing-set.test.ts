/**
 * Unit tests for POST /api/agent-mcp/consult-expert-routing-set
 * (consult-expert-routing-2026-09-22 P-006).
 *
 * The load-bearing case is the MERGE. `writeConsultExpertRoutingSettings` takes a
 * `Partial<ConsultExpertRoutingSettings>` but normalizes a MISSING field to the
 * SEED, not to the stored value — so a handler that simply forwarded the request
 * body would let an edit touching only the half-life silently reset the owner's
 * whole ranked allowlist to fable/opus/sol/astra. That partial shape is
 * deliberate upstream (it is what makes every read total on the consult dispatch
 * path), so this route is the layer that must read-then-write. These tests pin
 * that, in both directions, plus the positional-rank contract (D-004: order is
 * the policy, carried exactly once on the wire).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const isLoopbackRequestMock = vi.fn((_h: unknown) => true);
const readSettingsMock = vi.fn();
const writeSettingsMock = vi.fn();
const notifySyncInvalidateMock = vi.fn(async (_name: string) => {});

vi.mock('../../../superuser-token', () => ({
  isLoopbackRequest: (h: unknown) => isLoopbackRequestMock(h),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws1' }));
vi.mock('../../../consult/expert-routing-settings', () => ({
  readConsultExpertRoutingSettings: (...a: unknown[]) => readSettingsMock(...a),
  writeConsultExpertRoutingSettings: (...a: unknown[]) => writeSettingsMock(...a),
}));
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: (name: string) => notifySyncInvalidateMock(name),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const STORED = {
  allowlist: [
    { rank: 1, agent: 'codex' as const, model: 'sol' },
    { rank: 2, agent: 'claude' as const, model: 'opus' },
  ],
  recencyHalfLifeDays: 45,
};

async function callPost(body: unknown, raw?: string): Promise<Response> {
  const mod = await import('./consult-expert-routing-set');
  const route = mod.default as unknown as {
    handler: (r: Request, c: RouteContext) => Promise<Response>;
  };
  const req = new Request('http://localhost:3070/api/agent-mcp/consult-expert-routing-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return route.handler(req, CTX);
}

/** The full value the route handed the writer. */
function written(): { allowlist: Array<{ rank: number; agent: string; model: string }>; recencyHalfLifeDays: number } {
  return writeSettingsMock.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  isLoopbackRequestMock.mockReturnValue(true);
  readSettingsMock.mockResolvedValue(structuredClone(STORED));
  // The real writer returns the NORMALIZED stored value; echoing the input is
  // enough for these tests, which assert on what the route PASSED it.
  writeSettingsMock.mockImplementation(async (next: unknown) => next);
});

describe('POST /api/agent-mcp/consult-expert-routing-set', () => {
  it('a half-life-only patch PRESERVES the stored allowlist (does not reset it to the seed)', async () => {
    const res = await callPost({ recencyHalfLifeDays: 7 });
    expect(res.status).toBe(200);

    const sent = written();
    expect(sent.recencyHalfLifeDays).toBe(7);
    // The whole point: the stored ranks survive an edit that never mentioned them.
    expect(sent.allowlist.map((e) => e.model)).toEqual(['sol', 'opus']);
    expect(sent.allowlist.map((e) => e.agent)).toEqual(['codex', 'claude']);
  });

  it('an allowlist-only patch PRESERVES the stored half-life', async () => {
    await callPost({ allowlist: [{ agent: 'claude', model: 'fable' }] });
    const sent = written();
    expect(sent.recencyHalfLifeDays).toBe(45);
    expect(sent.allowlist.map((e) => e.model)).toEqual(['fable']);
  });

  it('assigns rank from ARRAY POSITION and ignores a client-sent rank', async () => {
    await callPost({
      allowlist: [
        { agent: 'claude', model: 'fable', rank: 99 },
        { agent: 'codex', model: 'sol', rank: 1 },
        { agent: 'claude', model: 'opus', rank: 50 },
      ],
    });
    // Order on the wire is the policy; a disagreeing rank field has no authority.
    expect(written().allowlist).toEqual([
      { rank: 1, agent: 'claude', model: 'fable' },
      { rank: 2, agent: 'codex', model: 'sol' },
      { rank: 3, agent: 'claude', model: 'opus' },
    ]);
  });

  it('forwards an EMPTY allowlist rather than treating it as absent', async () => {
    // Presence, not truthiness: an empty array is a sent value, and the store's
    // documented behaviour (replace with the seed) is what should decide it —
    // not this route silently keeping the old list.
    const res = await callPost({ allowlist: [] });
    expect(res.status).toBe(200);
    expect(written().allowlist).toEqual([]);
  });

  it('forwards a zero half-life rather than treating it as absent', async () => {
    await callPost({ recencyHalfLifeDays: 0 });
    // 0 is out of band; clamping/rejecting it is normalizeRecencyHalfLifeDays's
    // job, and it only gets that job if the route passes it through.
    expect(written().recencyHalfLifeDays).toBe(0);
  });

  it('invalidates the page query by NAME only', async () => {
    await callPost({ recencyHalfLifeDays: 30 });
    expect(notifySyncInvalidateMock).toHaveBeenCalledTimes(1);
    // An args-scoped emit would never match a no-args subscription.
    expect(notifySyncInvalidateMock).toHaveBeenCalledWith('consult.expertRouting');
  });

  it('400s an empty patch instead of rewriting the row with defaults', async () => {
    const res = await callPost({});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'empty_patch' });
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it('400s a non-array allowlist', async () => {
    const res = await callPost({ allowlist: 'fable' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_allowlist' });
    expect(writeSettingsMock).not.toHaveBeenCalled();
  });

  it('400s invalid JSON', async () => {
    const res = await callPost(undefined, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'invalid_json' });
  });

  it('403s a non-loopback caller and never touches the store', async () => {
    isLoopbackRequestMock.mockReturnValue(false);
    const res = await callPost({ recencyHalfLifeDays: 7 });
    expect(res.status).toBe(403);
    expect(readSettingsMock).not.toHaveBeenCalled();
    expect(writeSettingsMock).not.toHaveBeenCalled();
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });

  it('reports a write failure as 400 rather than throwing', async () => {
    writeSettingsMock.mockRejectedValue(new Error('pg down'));
    const res = await callPost({ recencyHalfLifeDays: 7 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'pg down' });
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });

  it('scopes both the read and the write to the active workspace', async () => {
    await callPost({ recencyHalfLifeDays: 7 });
    expect(readSettingsMock).toHaveBeenCalledWith('ws1');
    expect(writeSettingsMock.mock.calls[0][1]).toBe('ws1');
  });
});
