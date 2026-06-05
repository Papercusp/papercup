import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(),
}));

import remember from './remember';
import { getMemoryBackend } from '../../memory/backend';
import { getSessionUserOrDefault } from '../../auth';
import { getOrgPg } from '@papercusp/db-org';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

/** A fake neutral MemoryBackend (generalize-memory-backend-swappable D-003). */
const fakeBackend = (
  searchResults: Array<{ id: string; text: string; scope?: string; score?: number }> = [],
  rememberIds: string[] = [],
): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  remember: vi.fn(async () => ({ ids: rememberIds })),
  search: vi.fn(async () =>
    searchResults.map((r) => ({ scope: 'user-1', ...r })),
  ),
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const fakeCtx = {
  workspaceId: 'ws-test',
} as unknown as Parameters<typeof remember.handler>[1];

beforeEach(() => {
  vi.mocked(getSessionUserOrDefault).mockResolvedValue({
    id: 'user-1',
    display_name: 'Test User',
  } as unknown as Awaited<ReturnType<typeof getSessionUserOrDefault>>);
  // Default: silent no-op sql tag so the handler's fire-and-forget
  // anchor writer never throws into the test scope.
  vi.mocked(getOrgPg).mockReturnValue({
    sql: vi.fn(async () => undefined) as unknown,
  } as unknown as ReturnType<typeof getOrgPg>);
});

describe('memory:remember — backend seam (D-003)', () => {
  it('reports the backend-unavailable reason verbatim', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'memory_backend_disabled' });
    useBackend(b);

    const res = await remember.handler(
      { content: 'anything', kind: 'preference' },
      fakeCtx,
    );
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed).toEqual({ ok: false, reason: 'memory_backend_disabled' });
    expect(b.remember).not.toHaveBeenCalled();
  });

  it('scopes to the session user by default, harness pool when harness_slug given', async () => {
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'personal', kind: 'preference' }, fakeCtx);
    expect(b.remember).toHaveBeenLastCalledWith('personal', expect.objectContaining({
      scope: 'user-1',
      kind: 'preference',
    }));

    await remember.handler(
      { content: 'team fact', kind: 'project', harness_slug: 'sheets' },
      fakeCtx,
    );
    expect(b.remember).toHaveBeenLastCalledWith('team fact', expect.objectContaining({
      scope: 'harness:sheets',
      kind: 'project',
    }));
  });
});

describe('memory:remember — anchor extraction (P-015)', () => {
  it('writes anchors metadata when body contains structural references', async () => {
    const b = fakeBackend();
    useBackend(b);

    const res = await remember.handler(
      {
        content:
          'Per memory-harness-scope-2026-05-24 plan, F-001 lives in apps/operator/lib/memory/injection.ts.',
        kind: 'project',
      },
      fakeCtx,
    );

    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);

    expect(b.remember).toHaveBeenCalledTimes(1);
    const [, opts] = b.remember.mock.calls[0];
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
    const b = fakeBackend();
    useBackend(b);

    await remember.handler(
      {
        content: 'Avi prefers terse responses',
        kind: 'preference',
      },
      fakeCtx,
    );

    const [, opts] = b.remember.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.anchors).toBeUndefined();
    expect(meta.anchor_count).toBeUndefined();
  });

  it('preserves scope/provenance metadata alongside anchors; kind rides opts.kind', async () => {
    const b = fakeBackend();
    useBackend(b);

    await remember.handler(
      {
        content: 'F-AUTH-001 needs apps/operator/lib/auth.ts',
        kind: 'project',
        harness_slug: 'sheets',
      },
      fakeCtx,
    );

    const [, opts] = b.remember.mock.calls[0];
    expect((opts as { kind: string }).kind).toBe('project');
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
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
    const b = fakeBackend([
      { id: 'mem-old', text: 'Avi prefers terse responses', score: 0.95 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      { content: 'Avi prefers short responses', kind: 'preference' },
      fakeCtx,
    );
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('similar_exists');
    expect(parsed.similar_memory_id).toBe('mem-old');
    expect(parsed.similar_score).toBe(0.95);
    expect(parsed.similar_text).toBe('Avi prefers terse responses');
    expect(b.remember).not.toHaveBeenCalled();
  });

  it('allows when no similar memory found (low score)', async () => {
    const b = fakeBackend([
      { id: 'mem-old', text: 'unrelated', score: 0.30 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      { content: 'New unrelated fact', kind: 'preference' },
      fakeCtx,
    );
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(b.remember).toHaveBeenCalled();
  });

  it('force: true bypasses the dedup check', async () => {
    const b = fakeBackend([
      { id: 'mem-old', text: 'Avi prefers terse responses', score: 0.99 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      {
        content: 'Avi prefers terse responses',
        kind: 'preference',
        force: true,
      },
      fakeCtx,
    );
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(b.remember).toHaveBeenCalled();
    // search not invoked when force=true (no dedup check)
    expect(b.search).not.toHaveBeenCalled();
  });

  it('proceeds defensively if dedup search throws', async () => {
    const b = fakeBackend();
    b.search.mockRejectedValue(new Error('backend search broken'));
    useBackend(b);

    const res = await remember.handler(
      { content: 'something', kind: 'preference' },
      fakeCtx,
    );
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(b.remember).toHaveBeenCalled();
  });

  it('dedup is disabled by default (env not set)', async () => {
    delete process.env.PAPERCUSP_MEMORY_DEDUP;
    const b = fakeBackend([
      { id: 'mem-old', text: 'exact match', score: 0.99 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      { content: 'exact match', kind: 'preference' },
      fakeCtx,
    );
    // With flag off, the high-similarity write should still succeed
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(b.search).not.toHaveBeenCalled();
    // restore for following tests
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
  });
});

describe('memory:remember — anchor table wiring (P-015)', () => {
  it('hands the new memory ids + extracted anchors to the writer after a successful add', async () => {
    const b = fakeBackend([], ['77777777-7777-7777-7777-777777777777']);
    useBackend(b);

    const sql = vi.fn(async () => undefined);
    vi.mocked(getOrgPg).mockReturnValue({
      sql: sql as unknown,
    } as unknown as ReturnType<typeof getOrgPg>);

    const res = await remember.handler(
      {
        content: 'F-001 lives at apps/operator/lib/foo.ts',
        kind: 'project',
      },
      fakeCtx,
    );
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ids).toEqual(['77777777-7777-7777-7777-777777777777']);

    // Fire-and-forget — yield once so the void IIFE's microtasks run.
    await new Promise((r) => setImmediate(r));

    // persist-anchors.ts uses unnest — one INSERT per added memory id
    // (carries every anchor for that id). One added id → one INSERT.
    expect(sql).toHaveBeenCalledTimes(1);
    const callArgs = (sql.mock.calls[0] as unknown) as unknown[];
    const tpl = ((callArgs[0] as unknown) as TemplateStringsArray).join('');
    expect(tpl).toContain('INSERT INTO harness_shared.memory_anchors');
    expect(tpl).toContain('ON CONFLICT (memory_id, kind, value) DO NOTHING');
    // Values: memory_id, kinds[], values[]
    expect(callArgs[1]).toBe('77777777-7777-7777-7777-777777777777');
    expect(callArgs[2]).toEqual(['file', 'feature']);
    expect(callArgs[3]).toEqual(['apps/operator/lib/foo.ts', 'F-001']);
  });

  it('skips the writer entirely when no anchors were extracted', async () => {
    const b = fakeBackend([], ['88888888-8888-8888-8888-888888888888']);
    useBackend(b);

    const sql = vi.fn(async () => undefined);
    vi.mocked(getOrgPg).mockReturnValue({
      sql: sql as unknown,
    } as unknown as ReturnType<typeof getOrgPg>);

    await remember.handler(
      { content: 'Avi prefers terse responses', kind: 'preference' },
      fakeCtx,
    );
    await new Promise((r) => setImmediate(r));
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips the writer when the backend reported no newly-added ids', async () => {
    const b = fakeBackend([], []); // e.g. mem0 merged into existing entries (UPDATE/NONE)
    useBackend(b);

    const sql = vi.fn(async () => undefined);
    vi.mocked(getOrgPg).mockReturnValue({
      sql: sql as unknown,
    } as unknown as ReturnType<typeof getOrgPg>);

    await remember.handler(
      { content: 'F-001 in apps/operator/lib/foo.ts', kind: 'project' },
      fakeCtx,
    );
    await new Promise((r) => setImmediate(r));
    expect(sql).not.toHaveBeenCalled();
  });
});
