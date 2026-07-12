/**
 * memory-pause.test.ts — EI-10355: the user's "stop remembering things about
 * me" switch. The memory surface already covers see/edit/delete/export; this
 * is the restriction/object right — the ability to stop NEW memories being
 * written, which previously required an operator-wide env var + restart.
 *
 * The route must: report the current state on the envelope the settings page
 * already fetches, flip it, validate the body, and — the load-bearing one —
 * keep working while the STORE IS DOWN (a pause is a statement of consent, not
 * a store operation; refusing it during an outage denies the one control that
 * matters most when things are broken).
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-pause.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (def: unknown) => def }));
vi.mock('../../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  registeredMemoryBackends: vi.fn(() => ['mem0']),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
vi.mock('../../../memory/backend-selection', () => ({
  currentMemoryBackendChoice: vi.fn(() => 'mem0'),
  writeMemoryBackendChoice: vi.fn(async () => {}),
}));
vi.mock('../../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => 'journal-1'),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../../memory/list-user-memories', () => ({ listUserMemories: vi.fn(async () => []) }));
vi.mock('../../../memory/feedback', () => ({ recordFeedback: vi.fn(async () => {}) }));
vi.mock('../../../memory/claude-hygiene', () => ({ readClaudeHygiene: vi.fn(async () => null) }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) }));
vi.mock('../../../memory/memory-pause', () => ({
  isMemoryPaused: vi.fn(async () => false),
  setMemoryPaused: vi.fn(async (_u: string, p: boolean) => p),
}));

import routes from './memory';
import { getMemoryBackend } from '../../../memory/backend';
import { isMemoryPaused, setMemoryPaused } from '../../../memory/memory-pause';

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const all = routes as unknown as Route[];
const getPause = all.find((r) => r.method === 'GET' && r.path === '/user/memory/pause')!;
const setPauseRoute = all.find((r) => r.method === 'POST' && r.path === '/user/memory/pause')!;
const backendInfo = all.find((r) => r.method === 'GET' && r.path === '/user/memory/backend')!;

const getReq = (): Request => new Request('http://localhost/api/user/memory/pause', { method: 'GET' });
const postReq = (body: unknown, raw?: string): Request =>
  new Request('http://localhost/api/user/memory/pause', {
    method: 'POST',
    body: raw !== undefined ? raw : JSON.stringify(body),
  });

const fakeBackend = (available = true) => ({
  name: 'fake',
  available: vi.fn(async () => (available ? { ok: true } : { ok: false, reason: 'mem0_unavailable' })),
});
const useBackend = (b: unknown): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as ReturnType<typeof getMemoryBackend>);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isMemoryPaused).mockResolvedValue(false);
  vi.mocked(setMemoryPaused).mockImplementation(async (_u: string, p: boolean) => p);
  useBackend(fakeBackend(true));
});

describe('GET/POST /user/memory/pause — restriction-of-processing (EI-10355)', () => {
  it('registers both the read and the write route', () => {
    expect(getPause).toBeTruthy();
    expect(setPauseRoute).toBeTruthy();
  });

  it('GET reports the current pause state for the calling user', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    const res = await getPause.handler(getReq());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ paused: true });
    expect(isMemoryPaused).toHaveBeenCalledWith('user-1');
  });

  it('POST { paused: true } pauses memory for the calling user', async () => {
    const res = await setPauseRoute.handler(postReq({ paused: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, paused: true });
    expect(setMemoryPaused).toHaveBeenCalledWith('user-1', true);
  });

  it('POST { paused: false } resumes memory', async () => {
    const res = await setPauseRoute.handler(postReq({ paused: false }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, paused: false });
    expect(setMemoryPaused).toHaveBeenCalledWith('user-1', false);
  });

  it('rejects a non-boolean / missing `paused` rather than guessing', async () => {
    const bad = await setPauseRoute.handler(postReq({ paused: 'yes' }));
    expect(bad.status).toBe(400);
    const missing = await setPauseRoute.handler(postReq({}));
    expect(missing.status).toBe(400);
    const notJson = await setPauseRoute.handler(postReq(null, 'not json'));
    expect(notJson.status).toBe(400);
    expect(setMemoryPaused).not.toHaveBeenCalled();
  });

  it('a user can still PAUSE while the memory store is DOWN', async () => {
    // The control that matters most when things are broken must not depend on
    // the broken thing. A pause is consent state, not a store write.
    useBackend(fakeBackend(false));
    const res = await setPauseRoute.handler(postReq({ paused: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, paused: true });
    expect(setMemoryPaused).toHaveBeenCalledWith('user-1', true);
  });

  it('the settings-page envelope carries `paused` (no extra round-trip)', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    const res = await backendInfo.handler(new Request('http://localhost/api/user/memory/backend'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ paused: true, userId: 'user-1' });
  });
});
