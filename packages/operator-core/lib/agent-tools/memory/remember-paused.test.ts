/**
 * remember-paused.test.ts — EI-10355: memory:remember must REFUSE while the
 * user has paused memory.
 *
 * The load-bearing assertion is not "it returns an error" — it is that the
 * refusal happens BEFORE journalPendingWrite(). The write-ahead journal exists
 * so that a fact which fails to embed is replayed later by the drain; if the
 * pause gate sat after it, pausing would merely DEFER the memory and the drain
 * would faithfully store it on resume. A pause that defers is not a pause, so
 * that ordering is the feature.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/remember-paused.test.ts
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
  // Keep the real refusal payload — the test asserts on the contract the agent
  // actually receives, not on a stand-in.
  const actual = await importOriginal<typeof import('../../memory/memory-pause')>();
  return { ...actual, isMemoryPaused: vi.fn(async () => false) };
});

import remember from './remember';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { journalPendingWrite } from '../../memory/write-journal';
import { isMemoryPaused } from '../../memory/memory-pause';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({ id: 'user-1', display_name: 'Test' } as never);
  vi.mocked(getMemoryBackend).mockReturnValue(fakeBackend() as never);
  vi.mocked(isMemoryPaused).mockResolvedValue(false);
});

describe('memory:remember — user pause gate (EI-10355)', () => {
  it('REFUSES the write when the user has paused memory', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    const out = parse(await call({ content: 'my dog is Rex', kind: 'user' }));
    expect(out).toMatchObject({ ok: false, stored: false, paused: true, reason: 'memory_paused' });
    // The refusal must tell the agent what to say, not fail opaquely.
    expect(out.message).toMatch(/paused/i);
  });

  it('does NOT journal a paused write — the drain must not resurrect it on resume', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    await call({ content: 'my dog is Rex', kind: 'user' });
    expect(journalPendingWrite).not.toHaveBeenCalled();
  });

  it('does not touch the memory store at all while paused', async () => {
    const backend = fakeBackend();
    vi.mocked(getMemoryBackend).mockReturnValue(backend as never);
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    await call({ content: 'my dog is Rex', kind: 'user' });
    expect(backend.remember).not.toHaveBeenCalled();
  });

  it('checks the pause against the CALLING user', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(true);
    await call({ content: 'x', kind: 'user' });
    expect(isMemoryPaused).toHaveBeenCalledWith('user-1');
  });

  it('writes normally when NOT paused (the gate is inert by default)', async () => {
    vi.mocked(isMemoryPaused).mockResolvedValue(false);
    const out = parse(await call({ content: 'my dog is Rex', kind: 'user' }));
    expect(out.reason).not.toBe('memory_paused');
    expect(journalPendingWrite).toHaveBeenCalled();
  });
});
