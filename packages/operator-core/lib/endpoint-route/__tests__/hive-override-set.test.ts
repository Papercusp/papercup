/**
 * Unit tests for POST /api/agent-mcp/pot-override-set (domain-generic-hive-architecture
 * -2026-06-18 P-015). Mocks the IO deps (workspace-registry / hive-settings-store /
 * sync-sse) but uses the REAL scout/config parser so the scout validation feedback
 * (accepted / resolved / dropped) is exercised for real. Asserts: the loopback guard,
 * body validation, prompt set/clear, config set/clear, and the scout dropped-keys report.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const setPromptMock = vi.fn(async (..._a: unknown[]) => {});
const deletePromptMock = vi.fn(async (..._a: unknown[]) => true);
const setConfigMock = vi.fn(async (..._a: unknown[]) => {});
const deleteConfigMock = vi.fn(async (..._a: unknown[]) => true);
const invalidateMock = vi.fn(async (..._a: unknown[]) => {});

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'w' }));
vi.mock('../../hive-settings-store', () => ({
  setHiveInstancePromptOverride: (...a: unknown[]) => setPromptMock(...a),
  deleteHiveInstancePromptOverride: (...a: unknown[]) => deletePromptMock(...a),
  setHiveLocalBlueprintConfig: (...a: unknown[]) => setConfigMock(...a),
  deleteHiveLocalBlueprintConfig: (...a: unknown[]) => deleteConfigMock(...a),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: (...a: unknown[]) => invalidateMock(...a) }));

const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };

async function callPost(body: unknown, opts?: { loopback?: boolean }): Promise<Response> {
  const mod = await import('../routes/agent-mcp/hive-override-set');
  const def = mod.default as unknown;
  const route = (Array.isArray(def) ? def.find((r: { method: string }) => r.method === 'POST') : def) as {
    handler: (r: Request, c: RouteContext) => Promise<Response>;
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // x-forwarded-for=127.0.0.1 makes isLoopbackRequest pass without relying on the
  // (undici-stripped) Host header; omit it to exercise the forbidden branch.
  if (opts?.loopback !== false) headers['x-forwarded-for'] = '127.0.0.1';
  const req = new Request('http://localhost:3070/api/agent-mcp/pot-override-set', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return route.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  deletePromptMock.mockResolvedValue(true);
  deleteConfigMock.mockResolvedValue(true);
});

describe('POST /agent-mcp/pot-override-set', () => {
  it('rejects a non-loopback request', async () => {
    const res = await callPost({ hiveSlug: 'h', kind: 'prompt', name: 'su', value: 'x' }, { loopback: false });
    expect(res.status).toBe(403);
    expect(setPromptMock).not.toHaveBeenCalled();
  });

  it('400s on missing hiveSlug / kind / name', async () => {
    expect((await callPost({ kind: 'prompt', name: 'su', value: 'x' })).status).toBe(400);
    expect((await callPost({ hiveSlug: 'h', name: 'su', value: 'x' })).status).toBe(400);
    expect((await callPost({ hiveSlug: 'h', kind: 'prompt', value: 'x' })).status).toBe(400);
  });

  it('sets a prose role override + invalidates hive.overrides', async () => {
    const res = await callPost({ hiveSlug: 'h', kind: 'prompt', name: 'mug', value: 'be bold' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body).toMatchObject({ ok: true, cleared: false });
    expect(setPromptMock).toHaveBeenCalledWith('w', 'h', 'mug', 'be bold');
    expect(deletePromptMock).not.toHaveBeenCalled();
    expect(invalidateMock).toHaveBeenCalledWith('hive.overrides', { hiveSlug: 'h' });
  });

  it('clears a prose override when the value is empty', async () => {
    const res = await callPost({ hiveSlug: 'h', kind: 'prompt', name: 'mug', value: '   ' });
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body).toMatchObject({ ok: true, cleared: true });
    expect(deletePromptMock).toHaveBeenCalledWith('w', 'h', 'mug');
    expect(setPromptMock).not.toHaveBeenCalled();
  });

  it('sets a scout config + reports accepted/dropped via the real parser', async () => {
    const res = await callPost({
      hiveSlug: 'h',
      kind: 'config',
      name: 'scout',
      value: { buckets: { maxMoonshots: 3 }, bogusKey: 1 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dropped: string[]; accepted: Record<string, unknown>; resolved: unknown };
    expect(body.ok).toBe(true);
    // The RAW value is stored (the loop re-parses defensively); validation is feedback.
    expect(setConfigMock).toHaveBeenCalledWith('w', 'h', 'scout', { buckets: { maxMoonshots: 3 }, bogusKey: 1 });
    // The real parseScoutConfigBlock accepts `buckets` and drops the unknown key.
    expect(body.dropped).toContain('bogusKey');
    expect(body.accepted).toMatchObject({ buckets: { maxMoonshots: 3 } });
    expect(body.resolved).toBeTruthy();
  });

  it('clears a config section when the value is null', async () => {
    const res = await callPost({ hiveSlug: 'h', kind: 'config', name: 'scout', value: null });
    const body = (await res.json()) as { ok: boolean; cleared: boolean };
    expect(body).toMatchObject({ ok: true, cleared: true });
    expect(deleteConfigMock).toHaveBeenCalledWith('w', 'h', 'scout');
    expect(setConfigMock).not.toHaveBeenCalled();
  });

  it('400s a config value that is not an object', async () => {
    const res = await callPost({ hiveSlug: 'h', kind: 'config', name: 'scout', value: [1, 2, 3] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe('config_value_must_be_object');
    expect(setConfigMock).not.toHaveBeenCalled();
  });
});
