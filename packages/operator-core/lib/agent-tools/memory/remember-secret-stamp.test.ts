/**
 * remember-secret-stamp.test.ts — EI-10371 stage 1: memory:remember must FLAG
 * credential-shaped content (metadata.possible_secret) without altering or
 * refusing it, and must stamp BEFORE journaling so an outage-parked row
 * replays with the flag intact.
 *
 * Fixtures are assembled at runtime (`j(...)`) so this file never contains a
 * literal credential shape — the repo's secrets-guard would rightly flag one.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/remember-secret-stamp.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
  markJournalCommitted: vi.fn(async () => {}),
}));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (def: unknown) => def }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('../../memory/memory-pause', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../memory/memory-pause')>();
  return { ...actual, isMemoryPaused: vi.fn(async () => false) };
});

import remember from './remember';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { journalPendingWrite } from '../../memory/write-journal';

const j = (...parts: string[]) => parts.join('');
const CONN = j('postgres://', 'app_user', ':', 's3cretpw', '@localhost:5432/prod');

type Handler = { handler: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
const call = (args: Record<string, unknown>) =>
  (remember as unknown as Handler).handler(args, { principal: { workspaceId: 'ws-1' } });
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

const fakeBackend = () => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: ['m1'] })),
  search: vi.fn(async () => []),
});

let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({ id: 'user-1', display_name: 'Test' } as never);
  backend = fakeBackend();
  vi.mocked(getMemoryBackend).mockReturnValue(backend as never);
});

describe('memory:remember — credential flag (EI-10371 stage 1)', () => {
  it('stores credential-shaped content UNCHANGED with metadata.possible_secret', async () => {
    const out = parse(await call({ content: `DB dsn is ${CONN}`, kind: 'reference' }));
    expect(out.ok).toBe(true);
    const [text, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(text).toBe(`DB dsn is ${CONN}`); // flag, don't touch
    const meta = opts.metadata as Record<string, unknown>;
    expect(meta.possible_secret).toBe(true);
    expect(meta.possible_secret_classes).toEqual(['url-with-password']);
  });

  it('returns a legible warning so the agent can tell the user', async () => {
    const out = parse(await call({ content: CONN, kind: 'reference' }));
    expect(out).toMatchObject({
      ok: true,
      possible_secret: true,
      possible_secret_classes: ['url-with-password'],
    });
    expect(out.warning).toMatch(/credential/i);
    expect(out.warning).toContain('url-with-password');
  });

  it('stamps BEFORE journaling — an outage-parked row replays flagged', async () => {
    await call({ content: CONN, kind: 'reference' });
    const journalArgs = vi.mocked(journalPendingWrite).mock.calls[0][0];
    const meta = journalArgs.metadata as Record<string, unknown>;
    expect(meta.possible_secret).toBe(true);
    expect(meta.possible_secret_classes).toEqual(['url-with-password']);
  });

  it('leaves clean content unstamped and unwarned', async () => {
    const out = parse(await call({ content: 'the user prefers dark mode', kind: 'user' }));
    expect(out.ok).toBe(true);
    expect(out.possible_secret).toBeUndefined();
    expect(out.warning).toBeUndefined();
    const [, opts] = backend.remember.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const meta = opts.metadata as Record<string, unknown>;
    expect('possible_secret' in meta).toBe(false);
    expect('possible_secret_classes' in meta).toBe(false);
  });
});
