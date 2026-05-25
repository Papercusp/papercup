import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('../../memory/mem0-client', () => ({
  getMemoryClient: vi.fn(),
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));

import remember from './remember';
import { getMemoryClient } from '../../memory/mem0-client';
import { getSessionUserOrDefault } from '../../auth';

type FakeClient = {
  add: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

const fakeClient = (
  searchResults: Array<{ id: string; memory: string; score?: number }> = [],
): FakeClient => ({
  add: vi.fn(async () => ({ ok: true })),
  search: vi.fn(async () => ({ results: searchResults })),
});

const fakeCtx = {
  workspaceId: 'ws-test',
} as unknown as Parameters<typeof remember.handler>[1];

beforeEach(() => {
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'user-1',
    display_name: 'Test User',
  } as unknown as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
});

describe('memory:remember — anchor extraction (P-015)', () => {
  it('writes anchors metadata when body contains structural references', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      {
        content:
          'Per memory-harness-scope-2026-05-24 plan, F-001 lives in apps/operator/lib/memory/injection.ts.',
        kind: 'project',
      },
      fakeCtx,
    );

    expect(JSON.parse(res.content[0].text).ok).toBe(true);

    expect(c.add).toHaveBeenCalledTimes(1);
    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;

    expect(meta.anchor_count).toBe(3);
    expect(meta.anchors).toEqual(
      expect.arrayContaining([
        { kind: 'file', value: 'apps/operator/lib/memory/injection.ts' },
        { kind: 'feature', value: 'F-001' },
        { kind: 'plan', value: 'memory-harness-scope-2026-05-24' },
      ]),
    );
  });

  it('omits anchor metadata when body has no anchors', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    await remember.handler(
      {
        content: 'Avi prefers terse responses',
        kind: 'preference',
      },
      fakeCtx,
    );

    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.anchors).toBeUndefined();
    expect(meta.anchor_count).toBeUndefined();
  });

  it('preserves existing metadata fields (kind, scope, etc.) alongside anchors', async () => {
    const c = fakeClient();
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    await remember.handler(
      {
        content: 'F-AUTH-001 needs apps/operator/lib/auth.ts',
        kind: 'project',
        harness_slug: 'sheets',
      },
      fakeCtx,
    );

    const [, opts] = c.add.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.kind).toBe('project');
    expect(meta.scope).toBe('harness');
    expect(meta.harness_slug).toBe('sheets');
    expect(meta.workspace_id).toBe('ws-test');
    expect(meta.anchor_count).toBe(2);
  });
});

describe('memory:remember — dedup-on-write (P-016)', () => {
  const origEnv = process.env.PAPERCUSP_MEMORY_DEDUP;
  beforeEach(() => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
  });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.PAPERCUSP_MEMORY_DEDUP;
    else process.env.PAPERCUSP_MEMORY_DEDUP = origEnv;
  });

  it('refuses when a similar memory exists (score above threshold)', async () => {
    const c = fakeClient([
      { id: 'mem-old', memory: 'Avi prefers terse responses', score: 0.95 },
    ]);
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      { content: 'Avi prefers short responses', kind: 'preference' },
      fakeCtx,
    );
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('similar_exists');
    expect(parsed.similar_memory_id).toBe('mem-old');
    expect(parsed.similar_score).toBe(0.95);
    expect(c.add).not.toHaveBeenCalled();
  });

  it('allows when no similar memory found (low score)', async () => {
    const c = fakeClient([
      { id: 'mem-old', memory: 'unrelated', score: 0.30 },
    ]);
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      { content: 'New unrelated fact', kind: 'preference' },
      fakeCtx,
    );
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    expect(c.add).toHaveBeenCalled();
  });

  it('force: true bypasses the dedup check', async () => {
    const c = fakeClient([
      { id: 'mem-old', memory: 'Avi prefers terse responses', score: 0.99 },
    ]);
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      {
        content: 'Avi prefers terse responses',
        kind: 'preference',
        force: true,
      },
      fakeCtx,
    );
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    expect(c.add).toHaveBeenCalled();
    // search not invoked when force=true (no dedup check)
    expect(c.search).not.toHaveBeenCalled();
  });

  it('proceeds defensively if dedup search throws', async () => {
    const c = fakeClient();
    c.search.mockRejectedValue(new Error('mem0 search broken'));
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await remember.handler(
      { content: 'something', kind: 'preference' },
      fakeCtx,
    );
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    expect(c.add).toHaveBeenCalled();
  });

  it('dedup is disabled by default (env not set)', async () => {
    delete process.env.PAPERCUSP_MEMORY_DEDUP;
    // Re-import to re-evaluate the module-level const
    vi.resetModules();
    const { default: rememberFresh } = await import('./remember');
    const c = fakeClient([
      { id: 'mem-old', memory: 'exact match', score: 0.99 },
    ]);
    vi.mocked(getMemoryClient).mockResolvedValue(c as unknown as Awaited<ReturnType<typeof getMemoryClient>>);

    const res = await rememberFresh.handler(
      { content: 'exact match', kind: 'preference' },
      fakeCtx,
    );
    // With flag off, the high-similarity write should still succeed
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    expect(c.search).not.toHaveBeenCalled();
    // restore for following tests
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
  });
});
