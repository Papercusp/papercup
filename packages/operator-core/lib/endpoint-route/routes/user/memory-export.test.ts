/**
 * memory-export.test.ts — EI-10350: GET /api/user/memory/export downloads the
 * session user's OWN memories as a structured JSON file (data portability /
 * GDPR Art. 20). It must: package listUserMemories(user.id) under a stable
 * schema envelope, set a Content-Disposition attachment header so a browser
 * downloads it, and degrade to 503 (not a broken download) when the store is down.
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-export.test.ts
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

import routes from './memory';
import { getMemoryBackend } from '../../../memory/backend';
import { listUserMemories } from '../../../memory/list-user-memories';

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const exportRoute = (routes as unknown as Route[]).find(
  (r) => r.method === 'GET' && r.path === '/user/memory/export',
)!;

const req = (): Request => new Request('http://localhost/api/user/memory/export', { method: 'GET' });

const fakeBackend = (available = true) => ({
  name: 'fake',
  available: vi.fn(async () => (available ? { ok: true } : { ok: false, reason: 'mem0_unavailable' })),
});
const useBackend = (b: unknown): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as ReturnType<typeof getMemoryBackend>);
};

beforeEach(() => vi.clearAllMocks());

describe('GET /user/memory/export — data portability (EI-10350)', () => {
  it('is registered as a GET at /user/memory/export', () => {
    expect(exportRoute).toBeTruthy();
    expect(exportRoute.method).toBe('GET');
  });

  it('downloads the user OWN memories under a stable schema envelope + attachment header', async () => {
    const mems = [
      { id: 'm1', text: 'my dog is Rex', kind: 'user', scope: 'user', created_at: '2026-07-01T00:00:00Z' },
      { id: 'm2', text: 'prefers terse replies', kind: 'feedback', scope: 'user' },
    ];
    vi.mocked(listUserMemories).mockResolvedValue(mems as never);
    useBackend(fakeBackend(true));

    const res = await exportRoute.handler(req());
    expect(res.status).toBe(200);
    // Browser must DOWNLOAD, not render.
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="papercusp-memories-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(body).toMatchObject({
      schema: 'papercusp.memory.export/v1',
      userId: 'user-1',
      count: 2,
      memories: mems,
    });
    expect(typeof body.exportedAt).toBe('string');
    // Scoped to the caller's own id — not the whole store.
    expect(listUserMemories).toHaveBeenCalledWith('user-1');
  });

  it('exports an empty set cleanly (count 0) rather than erroring', async () => {
    vi.mocked(listUserMemories).mockResolvedValue([] as never);
    useBackend(fakeBackend(true));
    const res = await exportRoute.handler(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ count: 0, memories: [] });
  });

  it('a DOWN store is a 503, not a broken/empty download', async () => {
    useBackend(fakeBackend(false));
    const res = await exportRoute.handler(req());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: 'mem0_unavailable' });
    expect(listUserMemories).not.toHaveBeenCalled();
  });
});
