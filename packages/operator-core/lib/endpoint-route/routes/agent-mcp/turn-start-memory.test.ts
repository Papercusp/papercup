/**
 * turn-start-memory.test.ts — the turn-start injection endpoint's admission
 * behavior (context-injection-audit-2026-07-28 P-035 / F-E).
 *
 * The load-bearing case is the FIRST one: a SHORT prompt must reach the memory
 * pipeline. A `MIN_PROMPT_CHARS = 40` gate used to drop every prompt below 40
 * characters, and that gate is the audit's founding symptom — it silently
 * discarded the owner's 23-char question, a specific and entirely on-topic
 * prompt, because length was standing in as a proxy for relevance. F-B
 * (cosine-gated fusion) made the push path able to return zero on its own
 * merits, so the proxy was deleted with no replacement.
 *
 * These tests exist to stop it coming back: if anyone reintroduces a length
 * floor here — as a constant, an env var, or an inline `prompt.length <` — the
 * first two cases fail loudly rather than the regression being discovered
 * months later by an owner wondering why a short question got no memory.
 *
 * This endpoint previously had NO test file at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { buildMemoryContextBlockMock, consumePendingControlTransitionMock } = vi.hoisted(() => ({
  buildMemoryContextBlockMock: vi.fn(),
  consumePendingControlTransitionMock: vi.fn(),
}));

// Same relative specifiers the source's dynamic imports use (this test is
// colocated under routes/agent-mcp/).
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: buildMemoryContextBlockMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-1' }) }));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  consumePendingControlTransition: consumePendingControlTransitionMock,
  renderControlTransitionContext: (t: unknown) => `CTRL:${String((t as { kind?: string }).kind)}`,
}));

import routes from './turn-start-memory';

const endpoint = routes[0] as unknown as {
  handler: (req: Request) => Promise<Response>;
};

const post = async (body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/turn-start-memory', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as { ok: boolean; text: string };
};

beforeEach(() => {
  buildMemoryContextBlockMock.mockReset().mockResolvedValue('MEM-BLOCK');
  consumePendingControlTransitionMock.mockReset().mockResolvedValue(null);
});

describe('turn-start-memory admission (F-E: no length floor)', () => {
  it('a 23-char prompt REACHES the memory pipeline — the audit\'s founding symptom', async () => {
    // Verbatim length of the owner prompt the old 40-char gate dropped.
    const prompt = 'why is recall empty??!';
    expect(prompt.length).toBeLessThan(40);

    const out = await post({ owner: 'sess-1', prompt, harness: 'papercusp' });

    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toContain('MEM-BLOCK');
    expect(buildMemoryContextBlockMock.mock.calls[0]![0]).toMatchObject({
      queryContext: prompt,
      harnessSlugs: ['papercusp'],
      session: { sessionId: 'sess-1', port: 'turn-start' },
    });
  });

  it('even a 1-char prompt reaches it — relevance is the floor\'s job, not the length\'s', async () => {
    await post({ owner: 'sess-1', prompt: 'y' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('a signal-free prompt injects NOTHING when the pipeline finds nothing — the real gate', async () => {
    // The point of F-E: "continue" is filtered by RELEVANCE returning no hits,
    // not by a character count refusing to ask. Same prompt the old gate
    // dropped a priori; now it is asked and answered honestly.
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'continue' });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('');
  });

  it('memoryEnabled:false still skips recall — the ONE admission gate that remains', async () => {
    await post({ owner: 'sess-1', prompt: 'a real question about the deploy pipeline', memoryEnabled: false });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
  });

  it('clamps a very long prompt to the query head rather than embedding a pasted document', async () => {
    await post({ owner: 'sess-1', prompt: 'x'.repeat(5_000) });
    const { queryContext } = buildMemoryContextBlockMock.mock.calls[0]![0] as { queryContext: string };
    expect(queryContext).toHaveLength(1_000);
  });

  it('CTRL is delivered even for a prompt carrying no recall signal at all', async () => {
    // A mode/loop/carry/route transition must take effect at the very next
    // boundary, so it is deliberately NOT subject to any prompt gating.
    consumePendingControlTransitionMock.mockResolvedValue({ kind: 'mode' });
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: 'sess-1', prompt: 'ok' });
    expect(out.text).toBe('CTRL:mode');
  });

  it('fail-soft: a throwing memory pipeline never surfaces an error into the turn', async () => {
    buildMemoryContextBlockMock.mockRejectedValue(new Error('backend down'));
    const out = await post({ owner: 'sess-1', prompt: 'a question about storage policy' });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
  });

  it('requires an owner', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/turn-start-memory', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'a question' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
