/**
 * POST /api/agent-config strict-save guard: a body whose entries the parsers
 * would silently drop (invalid tier row, dangling ceiling, unknown surface
 * key) is REJECTED with 422 instead of persisting a gutted config — silent
 * normalization is how /settings/agent edits got wiped on reload
 * (owner bug 2026-06-11). Valid bodies persist verbatim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// writeAgentConfig hits PG + process.env — mock the write, keep the real
// parsers (they ARE the subject under test via the route's drop detection).
const { writeMock } = vi.hoisted(() => ({
  writeMock: vi.fn(async (cfg: unknown) => cfg),
}));
vi.mock('../../agent-config', async () => {
  const actual = await vi.importActual<typeof import('../../agent-config')>('../../agent-config');
  return { ...actual, writeAgentConfig: writeMock };
});
vi.mock('../../agent-bin-detect', () => ({
  detectBinaries: () => ({ claude: '/usr/bin/claude', omp: null, pi: null }),
}));

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('../routes/agent-config');
  const route = (mod.default as unknown as Array<{ method: string; handler: (req: Request) => Promise<Response> }>)
    .find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route.handler(req);
}

const VALID_BODY = {
  backend: 'claude-code',
  cmd: 'claude -p',
  models: { worker: 'haiku' },
  backends: { oracle: 'claude-code' },
  surfaceModels: { oracle: 'opus' },
  tiers: [{ name: 'fast', spec: 'haiku' }, { name: 'smart', spec: 'opus:high', when: 'hard work' }],
  tierCeilings: { bee: 'fast' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /agent-config strict save', () => {
  it('persists a fully valid body verbatim', async () => {
    const res = await callPost(VALID_BODY);
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0] as typeof VALID_BODY;
    expect(written.tiers).toHaveLength(2);
    expect(written.tierCeilings).toEqual({ bee: 'fast' });
  });

  it('rejects (422, no write) a tier row the parser would drop', async () => {
    const res = await callPost({ ...VALID_BODY, tiers: [{ name: 'fast', spec: 'has space' }] });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/tiers/);
  });

  it('rejects a ceiling naming a tier absent from a non-empty menu', async () => {
    const res = await callPost({ ...VALID_BODY, tierCeilings: { bee: 'nonexistent' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/tierCeilings/);
  });

  it('rejects an unknown surface key instead of dropping it', async () => {
    const res = await callPost({ ...VALID_BODY, surfaceModels: { nope: 'opus' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('rejects an empty per-role model value instead of dropping it', async () => {
    const res = await callPost({ ...VALID_BODY, models: { worker: '' } });
    expect(res.status).toBe(422);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('accepts ceilings naming default tiers while the menu is default ([])', async () => {
    const res = await callPost({ ...VALID_BODY, tiers: [], tierCeilings: { bee: 'deep' } });
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});
