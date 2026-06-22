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
const { writeMock, readMock, listResumableSessionsMock, readCodexHomeDiagnosticsMock } = vi.hoisted(() => ({
  writeMock: vi.fn(async (cfg: unknown) => cfg),
  readMock: vi.fn(async () => ({ backend: 'claude-code', cmd: '', models: {}, backends: {}, surfaceModels: {}, tiers: [], tierCeilings: {} })),
  listResumableSessionsMock: vi.fn<(_limit?: number) => Promise<unknown[]>>(async () => []),
  readCodexHomeDiagnosticsMock: vi.fn((sessionKey: unknown) => ({
    codexHome: `/codex/session-${sessionKey}`,
    exists: true,
    agentsPath: `/codex/session-${sessionKey}/AGENTS.md`,
    agentsExists: true,
    configPath: `/codex/session-${sessionKey}/config.toml`,
    configExists: true,
    hooksPath: `/codex/session-${sessionKey}/hooks.json`,
    hooksExists: true,
    promptsPath: `/codex/session-${sessionKey}/prompts`,
    promptsExists: true,
    authPath: `/codex/session-${sessionKey}/auth.json`,
    authExists: true,
    diagnosticsPath: `/codex/session-${sessionKey}/papercusp-diagnostics.json`,
    diagnosticsExists: true,
    diagnostics: { lockEnforcement: 'soft-hooks-configured', requiresExplicitPapercuspLocks: true },
    latestRolloutId: 'rollout-1',
    latestRolloutPath: `/codex/session-${sessionKey}/sessions/rollout-1.jsonl`,
    resumeStrategy: 'codex-resume-last-in-code-home',
    resumeCommand: `CODEX_HOME='/codex/session-${sessionKey}' codex resume --last`,
    error: null,
  })),
}));
vi.mock('../../agent-config', async () => {
  const actual = await vi.importActual<typeof import('../../agent-config')>('../../agent-config');
  return { ...actual, readAgentConfig: readMock, writeAgentConfig: writeMock };
});
vi.mock('../../agent-bin-detect', () => ({
  detectBinaries: () => ({ claude: '/usr/bin/claude', codex: '/usr/bin/codex', omp: null, pi: null }),
}));
vi.mock('../../adv-sessions', () => ({
  listResumableSessions: (limit?: number) => listResumableSessionsMock(limit),
}));
vi.mock('../../role-codex-home', () => ({
  readCodexHomeDiagnostics: (sessionKey: string | number) => readCodexHomeDiagnosticsMock(sessionKey),
}));

async function callGet(): Promise<Response> {
  const mod = await import('../routes/agent-config');
  const route = (mod.default as unknown as Array<{ method: string; handler: (req: Request) => Promise<Response> }>)
    .find((r) => r.method === 'GET')!;
  return route.handler(new Request('http://localhost:3070/api/agent-config', { method: 'GET' }));
}

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
  readMock.mockResolvedValue({ backend: 'claude-code', cmd: '', models: {}, backends: {}, surfaceModels: {}, tiers: [], tierCeilings: {} });
  listResumableSessionsMock.mockResolvedValue([] as unknown[]);
});

describe('GET /agent-config diagnostics', () => {
  it('returns codex binary detection and the latest tracked Codex CODEX_HOME diagnostics', async () => {
    listResumableSessionsMock.mockResolvedValue([
      { id: 40, agent: 'claude', coordOwnerId: 'su-c', startedAt: '2026-06-21T00:00:00.000Z', endedAt: null },
      { id: 77, agent: 'codex', coordOwnerId: 'su-x', startedAt: '2026-06-21T01:00:00.000Z', endedAt: null },
    ] as unknown[]);
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(listResumableSessionsMock).toHaveBeenCalledWith(50);
    expect(readCodexHomeDiagnosticsMock).toHaveBeenCalledWith(77);
    const json = await res.json();
    expect(json.binaries.codex).toBe('/usr/bin/codex');
    expect(json.codexDiagnostics.sessionId).toBe(77);
    expect(json.codexDiagnostics.ownerId).toBe('su-x');
    expect(json.codexDiagnostics.home.codexHome).toBe('/codex/session-77');
    expect(json.codexDiagnostics.home.resumeCommand).toContain('codex resume --last');
  });

  it('returns null codexDiagnostics when no tracked Codex session exists yet', async () => {
    listResumableSessionsMock.mockResolvedValue([
      { id: 40, agent: 'claude', coordOwnerId: 'su-c', startedAt: '2026-06-21T00:00:00.000Z', endedAt: null },
    ] as unknown[]);
    const json = await (await callGet()).json();
    expect(json.codexDiagnostics).toBeNull();
    expect(readCodexHomeDiagnosticsMock).not.toHaveBeenCalled();
  });
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
