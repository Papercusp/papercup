/**
 * memory-secret-stamp.test.ts — EI-10371 stage 1 on the settings-page write
 * paths: POST /user/memory stamps metadata.possible_secret on credential-
 * shaped text (and says so in the response); PATCH /user/memory re-stamps
 * both ways so editing a secret out clears the flag. Content is never
 * altered or refused — flag, don't touch.
 *
 * Fixtures are assembled at runtime (`j(...)`) so this file never contains a
 * literal credential shape — the repo's secrets-guard would rightly flag one.
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-secret-stamp.test.ts
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
vi.mock('../../../memory/recall-canary-envelope', () => ({
  recallCanaryForEnvelope: vi.fn(async () => null),
}));

import routes from './memory';
import { getMemoryBackend } from '../../../memory/backend';
import { journalPendingWrite } from '../../../memory/write-journal';

const j = (...parts: string[]) => parts.join('');
const CONN = j('postgres://', 'app_user', ':', 's3cretpw', '@localhost:5432/prod');

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const route = (method: string, path: string) =>
  (routes as unknown as Route[]).find((r) => r.method === method && r.path === path)!;

const jsonReq = (method: string, body: unknown): Request =>
  new Request('http://localhost/api/user/memory', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fakeBackend = () => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['m1'] })),
  update: vi.fn(async () => undefined),
  get: vi.fn(async () => ({ text: 'old', kind: 'reference' })),
});

let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  vi.clearAllMocks();
  backend = fakeBackend();
  vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
});

describe('POST /user/memory — credential flag (EI-10371 stage 1)', () => {
  it('stamps metadata.possible_secret, stores the text unchanged, and warns in the response', async () => {
    const res = await route('POST', '/user/memory').handler(jsonReq('POST', { text: `dsn: ${CONN}` }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, possible_secret: true });
    expect(out.warning).toContain('url-with-password');

    const [text, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(text).toBe(`dsn: ${CONN}`);
    const meta = opts.metadata as Record<string, unknown>;
    expect(meta.possible_secret).toBe(true);
    expect(meta.possible_secret_classes).toEqual(['url-with-password']);

    // Stamped BEFORE journaling — an outage-parked row replays flagged.
    const journalMeta = vi.mocked(journalPendingWrite).mock.calls[0][0].metadata as Record<string, unknown>;
    expect(journalMeta.possible_secret).toBe(true);
  });

  it('leaves clean text unstamped and unwarned', async () => {
    const res = await route('POST', '/user/memory').handler(jsonReq('POST', { text: 'prefers dark mode' }));
    const out = await res.json();
    expect(out).toMatchObject({ ok: true });
    expect(out.possible_secret).toBeUndefined();
    expect(out.warning).toBeUndefined();
    const [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect('possible_secret' in (opts.metadata as Record<string, unknown>)).toBe(false);
  });
});

describe('PATCH /user/memory — credential flag re-stamp (EI-10371 stage 1)', () => {
  const VID = '550e8400-e29b-41d4-a716-446655440000';

  it('flags a credential-shaped edit and warns in the response', async () => {
    const res = await route('PATCH', '/user/memory').handler(jsonReq('PATCH', { id: VID, text: CONN }));
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, possible_secret: true });
    expect(backend.update).toHaveBeenCalledWith(VID, {
      text: CONN,
      metadata: { possible_secret: true, possible_secret_classes: ['url-with-password'] },
    });
  });

  it('clears the flag when the secret is edited OUT', async () => {
    const res = await route('PATCH', '/user/memory').handler(
      jsonReq('PATCH', { id: VID, text: 'dsn moved to the env config' }),
    );
    const out = await res.json();
    expect(out).toMatchObject({ ok: true });
    expect(out.possible_secret).toBeUndefined();
    expect(backend.update).toHaveBeenCalledWith(VID, {
      text: 'dsn moved to the env config',
      metadata: { possible_secret: false, possible_secret_classes: [] },
    });
  });
});
