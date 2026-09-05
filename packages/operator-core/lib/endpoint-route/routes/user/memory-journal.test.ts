/**
 * memory-journal.test.ts — WI-4208: the SETTINGS-PAGE memory writes
 * (POST/PATCH /api/user/memory) must ride the write-ahead journal, exactly
 * like the `memory:remember` / `memory:update` MCP verbs
 * (memory-write-journal-auto-recovery-2026-07-11 P-002).
 *
 * The bug: the page probed `available()`, 503'd on a down store, and called
 * `remember`/`update` unguarded — so an embedder outage (or the saturated-
 * sidecar shape: healthz green, every embed multi-second) LOST the text a
 * human had just typed. Worse than the agent case the journal was built for:
 * a person staring at a failure toast has no session transcript to recover
 * the fact from.
 *
 * The contract now: park the fact in the journal (a plain PG INSERT, no
 * embedder on that path) BEFORE any embedder-dependent step; bound the store
 * write with the tool deadline; and on EVERY failure branch answer with
 * { journaled, will_retry, journal_id } so the UI can say "saved, pending
 * indexing" instead of "failed". The 5-min drain replays it.
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-journal.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def }));
vi.mock('../../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  registeredMemoryBackends: vi.fn(() => ['mem0']),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
// Spread the real module: memory/configure.ts calls `initMemoryBackendSelection()`
// at module scope, so a bare factory strands this file at collection. The init is
// overridden with a no-op so no PG I/O runs under the unit test.
vi.mock('../../../memory/backend-selection', async (orig) => ({
  ...(await orig<typeof import('../../../memory/backend-selection')>()),
  currentMemoryBackendChoice: vi.fn(() => 'mem0'),
  writeMemoryBackendChoice: vi.fn(async () => {}),
  initMemoryBackendSelection: vi.fn(async () => {}),
}));
vi.mock('../../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => 'journal-1'),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../../memory/list-user-memories', () => ({ listUserMemories: vi.fn(async () => []) }));
vi.mock('../../../memory/feedback', () => ({ recordFeedback: vi.fn(async () => {}) }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()), loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) }));

import routes from './memory';
import { getMemoryBackend, MemoryUnavailableError } from '../../../memory/backend';
import { journalPendingWrite, markJournalCommitted } from '../../../memory/write-journal';
import { MemoryTimeoutError } from '../../../memory/op-deadline';

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const byMethod = (m: string): Route =>
  (routes as unknown as Route[]).find((r) => r.method === m && r.path === '/user/memory')!;

const create = byMethod('POST');
const patch = byMethod('PATCH');

const req = (method: string, body: unknown): Request =>
  new Request('http://localhost/api/user/memory', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fakeBackend = () => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['mem-1'] })),
  update: vi.fn(async () => undefined),
  get: vi.fn(async () => ({ id: 'mem-1', text: 'prior', kind: 'user', scope: 'user-1' })),
});
const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(journalPendingWrite).mockResolvedValue('journal-1');
});

describe('POST /user/memory — write-ahead journal (WI-4208)', () => {
  it('journals the fact BEFORE the store write, then closes the row on success', async () => {
    const b = fakeBackend();
    useBackend(b);
    const res = await create.handler(req('POST', { text: 'my dog is named Rex', kind: 'user' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, ids: ['mem-1'] });
    expect(journalPendingWrite).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'user-1', kind: 'user', content: 'my dog is named Rex', verbatim: true }),
    );
    // Journal INSERT precedes the embed-dependent store write.
    expect(vi.mocked(journalPendingWrite).mock.invocationCallOrder[0]).toBeLessThan(
      b.remember.mock.invocationCallOrder[0],
    );
    expect(markJournalCommitted).toHaveBeenCalledWith('journal-1', 'mem-1');
  });

  it('a DOWN store parks the fact: 503 + journaled/will_retry (the write is NOT lost)', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'mem0_unavailable' } as { ok: boolean });
    useBackend(b);
    const res = await create.handler(req('POST', { text: 'a fact typed during an outage' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'mem0_unavailable',
      journaled: true,
      will_retry: true,
      journal_id: 'journal-1',
    });
    // The fact was journaled even though the store never accepted it.
    expect(journalPendingWrite).toHaveBeenCalledTimes(1);
    expect(markJournalCommitted).not.toHaveBeenCalled();
  });

  it('a SATURATED embedder (write times out) parks the fact instead of 500-ing it away', async () => {
    const b = fakeBackend();
    b.remember.mockRejectedValue(new MemoryTimeoutError('memory:remember timed out'));
    useBackend(b);
    const res = await create.handler(req('POST', { text: 'typed while the sidecar was wedged' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'memory_timeout',
      journaled: true,
      will_retry: true,
    });
    expect(markJournalCommitted).not.toHaveBeenCalled();
  });

  it('a mid-flight MemoryUnavailableError parks it too, with its clean reason', async () => {
    const b = fakeBackend();
    b.remember.mockRejectedValue(new MemoryUnavailableError('mem0_unavailable'));
    useBackend(b);
    const res = await create.handler(req('POST', { text: 'x' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'mem0_unavailable', journaled: true });
  });

  it('a MALFORMED request is a 400 and is NEVER journaled (nothing to replay)', async () => {
    const b = fakeBackend();
    useBackend(b);
    const res = await create.handler(req('POST', { text: '   ' }));
    expect(res.status).toBe(400);
    expect(journalPendingWrite).not.toHaveBeenCalled();
    expect(b.remember).not.toHaveBeenCalled();
  });

  it('journaling itself being degraded (null id) still lets the write through — never a new failure mode', async () => {
    vi.mocked(journalPendingWrite).mockResolvedValue(null);
    const b = fakeBackend();
    useBackend(b);
    const res = await create.handler(req('POST', { text: 'still stored' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(markJournalCommitted).not.toHaveBeenCalled();
  });

  it('a harness-scoped write journals under the harness pool, not the user pool', async () => {
    const b = fakeBackend();
    useBackend(b);
    await create.handler(req('POST', { text: 'team convention', harness_slug: 'papercup' }));
    expect(journalPendingWrite).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'harness:papercup' }),
    );
  });
});

describe('PATCH /user/memory — journaled text edits (WI-4208)', () => {
  it('journals the edit as an UPDATE-of row, then closes it on success', async () => {
    const b = fakeBackend();
    useBackend(b);
    const res = await patch.handler(req('PATCH', { id: 'mem-1', text: 'corrected text' }));
    expect(res.status).toBe(200);
    expect(journalPendingWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'corrected text',
        metadata: expect.objectContaining({ __journal_update_of: 'mem-1' }),
      }),
    );
    expect(markJournalCommitted).toHaveBeenCalledWith('journal-1', 'mem-1');
  });

  it('an outage parks the EDIT (503 + journaled) — the correction is not lost', async () => {
    const b = fakeBackend();
    b.update.mockRejectedValue(new MemoryTimeoutError('timed out'));
    useBackend(b);
    const res = await patch.handler(req('PATCH', { id: 'mem-1', text: 'corrected text' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'memory_timeout',
      journaled: true,
      will_retry: true,
    });
    expect(markJournalCommitted).not.toHaveBeenCalled();
  });

  it('an unknown id is a clean 404 and CLOSES the journal row — the drain must never resurrect it', async () => {
    const b = fakeBackend();
    b.update.mockRejectedValue(new Error('Memory with ID mem-x not found'));
    useBackend(b);
    const res = await patch.handler(req('PATCH', { id: 'mem-x', text: 'edit of a ghost' }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' });
    expect(markJournalCommitted).toHaveBeenCalledWith('journal-1', null);
  });
});
