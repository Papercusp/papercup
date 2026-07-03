import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { z } from 'zod';

// Real MemoryUnavailableError so `err instanceof MemoryUnavailableError` in the
// handler's runtime-failure catch matches what the test throws (the handler
// imports the class from this same module shim). Exported under the real name
// from the mock; the test imports it as MemoryUnavailableError below.
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
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

import remember, { runbookShapeHint } from './remember';
import { coerceMemoryKind, normalizeMemoryKind } from './remember-coerce';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
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

// The projected wrapper hands principal-gated handlers { principal, tx, log };
// the workspace rides principal.workspaceId (P-004 — the old top-level
// ctx.workspaceId was never populated at runtime).
const fakeCtx = {
  principal: { workspaceId: 'ws-test' },
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
      { content: 'anything', kind: 'feedback' },
      fakeCtx,
    );
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed).toEqual({ ok: false, reason: 'memory_backend_disabled' });
    expect(b.remember).not.toHaveBeenCalled();
  });

  it('scopes to the session user by default, harness pool when harness_slug given', async () => {
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'personal', kind: 'feedback' }, fakeCtx);
    expect(b.remember).toHaveBeenLastCalledWith('personal', expect.objectContaining({
      scope: 'user-1',
      kind: 'feedback',
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

  // EI-178: the explicit-write path must store the agent's text AS-IS
  // (verbatim → mem0 infer:false). The old default ran mem0's unbounded LLM
  // condense step before returning, which under 429 backoff outlived the MCP
  // client timeout and dropped the transport (write committed, response lost).
  it('stores the fact verbatim (skips the LLM condense step) on every explicit write', async () => {
    const b = fakeBackend();
    useBackend(b);

    await remember.handler({ content: 'a clean one-line fact', kind: 'reference' }, fakeCtx);
    expect(b.remember).toHaveBeenLastCalledWith(
      'a clean one-line fact',
      expect.objectContaining({ verbatim: true }),
    );
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
        kind: 'feedback',
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
      { content: 'Avi prefers short responses', kind: 'feedback' },
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
      { content: 'New unrelated fact', kind: 'feedback' },
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
        kind: 'feedback',
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
      { content: 'something', kind: 'feedback' },
      fakeCtx,
    );
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(b.remember).toHaveBeenCalled();
  });

  it('dedup is disabled by default (env not set)', async () => {
    delete process.env.PAPERCUSP_MEMORY_DEDUP;
    process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK = 'off'; // isolate dedup; conflict-check has its own checks
    const b = fakeBackend([
      { id: 'mem-old', text: 'exact match', score: 0.99 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      { content: 'exact match', kind: 'feedback' },
      fakeCtx,
    );
    // With BOTH dedup and conflict-check off, the high-similarity write still succeeds
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    // neither gate enabled → no neighbor search at all
    expect(b.search).not.toHaveBeenCalled();
    // restore for following tests
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    delete process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK;
  });

  it('conflict-check runs the neighbor search even when dedup is OFF (EI-2032 decouple)', async () => {
    delete process.env.PAPERCUSP_MEMORY_DEDUP;          // dedup off → no similar_exists rejection
    delete process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK; // conflict-check default ON
    const b = fakeBackend([
      { id: 'mem-rel', text: 'a related fact', score: 0.5 },
    ]);
    useBackend(b);

    const res = await remember.handler(
      { content: 'a brand new fact', kind: 'feedback' },
      fakeCtx,
    );
    // The neighbor search MUST run for the conflict-check even with dedup off
    // (the exact bug this decouple fixes — previously it was nested under dedup).
    expect(b.search).toHaveBeenCalledTimes(1);
    // dedup off → no rejection; the uncredentialed judge degrades → write succeeds.
    expect(JSON.parse((res as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on'; // restore for following tests
  });
});

describe('memory:remember — runbook-shape boundary nudge (EI-2032)', () => {
  const runbook = '# Runbook\n\n' + Array.from({ length: 18 }, (_, i) => `## Step ${i}\n- ${'do the thing '.repeat(6)}`).join('\n\n');

  it('no nudge for a short fact', () => {
    expect(runbookShapeHint('Avi prefers terse responses.')).toBeNull();
  });

  it('no nudge for a long but UNSTRUCTURED single-paragraph fact', () => {
    expect(runbookShapeHint('x'.repeat(1500))).toBeNull();
  });

  it('nudges a large, structured, multi-section write toward agent-insights', () => {
    expect(runbook.length).toBeGreaterThan(1200);
    expect(runbookShapeHint(runbook)).toContain('agent-insights');
  });

  it('handler surfaces the hint on a runbook-shaped write but still stores it (ok:true, non-blocking)', async () => {
    process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK = 'off';
    const b = fakeBackend([], ['11111111-1111-1111-1111-111111111111']);
    useBackend(b);
    const res = await remember.handler({ content: runbook, kind: 'reference' }, fakeCtx);
    const out = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(out.ok).toBe(true);
    expect(b.remember).toHaveBeenCalled();
    expect(out.hint).toContain('agent-insights');
    delete process.env.PAPERCUSP_MEMORY_CONFLICT_CHECK;
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
      { content: 'Avi prefers terse responses', kind: 'feedback' },
      fakeCtx,
    );
    await new Promise((r) => setImmediate(r));
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips the writer when the backend reported no newly-added ids', async () => {
    const b = fakeBackend([], []); // defensive: backend reports no new ids (e.g. a dedup-merge); verbatim writes normally return one ADD
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

// Regression: memory:remember (like memory:search) must be reachable from a
// default unscoped psu session. crossWorkspace:true gives it the admin handle +
// a synthesized principal instead of `workspace_required`; the optional
// `workspace` arg lets an unscoped superuser tag the write's provenance.
describe('memory:remember — psu reachability (crossWorkspace + workspace arg)', () => {
  it('declares crossWorkspace:true (unscoped superuser write path)', () => {
    expect((remember as { crossWorkspace?: boolean }).crossWorkspace).toBe(true);
  });

  it('accepts an optional per-call `workspace` arg', () => {
    const schema = remember.args as z.ZodTypeAny;
    expect(schema.safeParse({ content: 'x', kind: 'feedback' }).success).toBe(true);
    const withWs = schema.safeParse({ content: 'x', kind: 'feedback', workspace: 'ws-a' });
    expect(withWs.success).toBe(true);
    if (withWs.success) expect((withWs.data as { workspace?: string }).workspace).toBe('ws-a');
  });
});

// Helper: unwrap the JSON envelope a handler result carries.
const envelope = (res: unknown): { ok: boolean; reason?: string; [k: string]: unknown } =>
  JSON.parse((res as { content: { text: string }[] }).content[0].text);

// GAP 1: `available()` is only a connectivity probe (false green) — a RUNTIME
// embedder/store failure trips inside `backend.remember`, which THROWS
// MemoryUnavailableError per the backend contract. The handler catches that and
// returns the SAME clean `{ ok:false, reason }` shape the upfront-unavailable
// branch returns, instead of letting the throw escape to the MCP framework's
// opaque `handler_error` (isError) envelope. A non-MemoryUnavailableError throw
// is a real bug and MUST propagate.
describe('memory:remember — runtime store failure (GAP 1: available() false-green)', () => {
  it('maps a MemoryUnavailableError throw from backend.remember to a clean { ok:false, reason }', async () => {
    const b = fakeBackend();
    // available() is GREEN (connectivity probe), but the actual write throws —
    // the exact false-green the embedder-down case produces.
    b.available.mockResolvedValue({ ok: true });
    b.remember.mockRejectedValue(new MemoryUnavailableError('mem0_unavailable'));
    useBackend(b);

    const res = await remember.handler(
      { content: 'a fact the embedder cannot embed', kind: 'feedback' },
      fakeCtx,
    );
    const parsed = envelope(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('mem0_unavailable');
    // The structured `reason` is surfaced (not buried in a handler_error prefix),
    // and crucially the handler returns a normal envelope — it does NOT throw.
    expect(b.remember).toHaveBeenCalledTimes(1);
  });

  it('lets a NON-MemoryUnavailableError throw propagate (pins current crash behavior — a real bug surfaces, not a fake {ok:false})', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: true });
    b.remember.mockRejectedValue(new Error('unexpected PG constraint violation'));
    useBackend(b);

    await expect(
      remember.handler({ content: 'x', kind: 'feedback' }, fakeCtx),
    ).rejects.toThrow('unexpected PG constraint violation');
  });
});

// GAP 7: the explicit-write path is the EI-178 guard — it MUST always pass
// verbatim:true so mem0 skips the unbounded LLM condense step. And a
// dedup/conflict-check failure must FALL THROUGH to the write (the defensive
// catch), never block a legitimate remember.
describe('memory:remember — verbatim guard + dedup fall-through (GAP 7)', () => {
  const origEnv = process.env.PAPERCUSP_MEMORY_DEDUP;
  afterAll(() => {
    if (origEnv === undefined) delete process.env.PAPERCUSP_MEMORY_DEDUP;
    else process.env.PAPERCUSP_MEMORY_DEDUP = origEnv;
  });

  it('always passes verbatim:true — dedup OFF path', async () => {
    delete process.env.PAPERCUSP_MEMORY_DEDUP;
    const b = fakeBackend();
    useBackend(b);
    await remember.handler({ content: 'fact', kind: 'feedback' }, fakeCtx);
    const [, opts] = b.remember.mock.calls[0];
    expect((opts as { verbatim?: boolean }).verbatim).toBe(true);
  });

  it('always passes verbatim:true — dedup ON, force:true bypass path', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend([{ id: 'm', text: 'fact', score: 0.99 }]);
    useBackend(b);
    await remember.handler({ content: 'fact', kind: 'feedback', force: true }, fakeCtx);
    const [, opts] = b.remember.mock.calls[0];
    expect((opts as { verbatim?: boolean }).verbatim).toBe(true);
  });

  it('always passes verbatim:true — dedup ON, neighbors below threshold (write path runs after the check)', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend([{ id: 'm', text: 'unrelated', score: 0.2 }]);
    useBackend(b);
    await remember.handler({ content: 'a new fact', kind: 'feedback' }, fakeCtx);
    expect(b.search).toHaveBeenCalled(); // dedup check ran
    const [, opts] = b.remember.mock.calls[0];
    expect((opts as { verbatim?: boolean }).verbatim).toBe(true);
  });

  it('a dedup/conflict-check failure (search throws) falls through to the write — write still carries verbatim:true', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on';
    const b = fakeBackend();
    b.search.mockRejectedValue(new Error('dedup/conflict path exploded'));
    useBackend(b);

    const res = await remember.handler({ content: 'fact', kind: 'project' }, fakeCtx);
    expect(envelope(res).ok).toBe(true);
    expect(b.remember).toHaveBeenCalledTimes(1);
    const [, opts] = b.remember.mock.calls[0];
    // The catch{} at the dedup site must not strip the verbatim guard on the
    // fall-through write.
    expect((opts as { verbatim?: boolean }).verbatim).toBe(true);
  });
});

// GAP 8: scope isolation. harness_slug + hive_slug together is rejected
// (mutually exclusive); hive_slug alone routes to scope 'hive:<slug>' and a
// user-scoped search NEVER sees the hive scope key (no cross-pool leak).
describe('memory:remember — scope isolation (GAP 8)', () => {
  it('rejects { harness_slug, hive_slug } both set as mutually exclusive — backend never called', async () => {
    const b = fakeBackend();
    useBackend(b);

    const res = await remember.handler(
      { content: 'fact', kind: 'project', harness_slug: 'sheets', hive_slug: 'team-hive' },
      fakeCtx,
    );
    const parsed = envelope(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/mutually exclusive/i);
    expect(b.remember).not.toHaveBeenCalled();
    expect(b.search).not.toHaveBeenCalled();
  });

  it('hive_slug only → backend.remember called with scope "hive:<slug>" and metadata.scope "hive"', async () => {
    const b = fakeBackend();
    useBackend(b);

    await remember.handler(
      { content: 'whole-hive convention: build via `npm run build`', kind: 'project', hive_slug: 'team-hive' },
      fakeCtx,
    );
    expect(b.remember).toHaveBeenLastCalledWith(
      'whole-hive convention: build via `npm run build`',
      expect.objectContaining({ scope: 'hive:team-hive' }),
    );
    const [, opts] = b.remember.mock.calls[0];
    const meta = (opts as { metadata: Record<string, unknown> }).metadata;
    expect(meta.scope).toBe('hive');
    expect(meta.hive_slug).toBe('team-hive');
    expect(meta.harness_slug).toBeUndefined();
  });

  it('a user-scoped write (no slug) never tags the hive scope key — no cross-pool leak between hive and user pools', async () => {
    process.env.PAPERCUSP_MEMORY_DEDUP = 'on'; // force the dedup search to run so we can inspect its scope arg
    const b = fakeBackend([{ id: 'm', text: 'noise', score: 0.1 }]);
    useBackend(b);

    await remember.handler({ content: 'personal preference', kind: 'feedback' }, fakeCtx);

    // The dedup search must race ONLY the user pool — never a hive:* scope.
    for (const call of b.search.mock.calls) {
      const opts = call[1] as { scope: string };
      expect(opts.scope).toBe('user-1');
      expect(opts.scope).not.toMatch(/^hive:/);
    }
    // And the write lands in the user pool, not a hive pool.
    expect(b.remember).toHaveBeenLastCalledWith(
      'personal preference',
      expect.objectContaining({ scope: 'user-1' }),
    );
    delete process.env.PAPERCUSP_MEMORY_DEDUP;
  });
});

/**
 * WI-1982 — memory:remember rejected ~21% of calls (34/161 in 24h); ~12 were a valid fact
 * (content present) LOST purely because `kind` was a legacy value (identity/preference/
 * correction), a free-form label (fact/note/technical/…), or missing. We coerce `kind`
 * to the closest valid enum member BEFORE validation so durable knowledge is never
 * dropped on the enum. `content` is deliberately untouched (a genuinely-missing fact
 * still fails — the double-encoded-args class is a separate dispatch-layer fix).
 */
describe('memory:remember kind coercion (WI-1982)', () => {
  const parse = (x: unknown) => (remember.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

  describe('normalizeMemoryKind / coerceMemoryKind (unit)', () => {
    it('keeps a valid unified kind', () => {
      expect(normalizeMemoryKind('project')).toBe('project');
      expect(coerceMemoryKind({ content: 'c', kind: 'feedback' })).toEqual({ content: 'c', kind: 'feedback' });
    });

    it('maps legacy kinds (identity→user, preference/correction→feedback)', () => {
      expect(normalizeMemoryKind('identity')).toBe('user');
      expect(normalizeMemoryKind('preference')).toBe('feedback');
      expect(normalizeMemoryKind('correction')).toBe('feedback');
    });

    it('maps free-form technical labels → reference', () => {
      for (const label of ['fact', 'note', 'technical', 'insight', 'gotcha', 'pointer']) {
        expect(normalizeMemoryKind(label)).toBe('reference');
      }
    });

    it('defaults an unknown / missing / non-string kind to reference (never rejects)', () => {
      expect(normalizeMemoryKind('wibble')).toBe('reference');
      expect(normalizeMemoryKind(undefined)).toBe('reference');
      expect(normalizeMemoryKind(null)).toBe('reference');
      expect((coerceMemoryKind({ content: 'c' }) as { kind: string }).kind).toBe('reference');
    });

    it('is case-insensitive on a valid kind (USER → user)', () => {
      expect(normalizeMemoryKind('USER')).toBe('user');
    });

    it('passes a non-object through untouched', () => {
      expect(coerceMemoryKind('x')).toBe('x');
    });
  });

  describe('through the real args schema (the ~12 kind-rejections that now parse)', () => {
    it("a legacy kind:'identity' now parses to 'user' (was: kind Invalid option)", () => {
      expect(parse({ content: 'Avi is the owner', kind: 'identity' }).kind).toBe('user');
    });

    it("a free-form kind:'fact' parses to 'reference'", () => {
      expect(parse({ content: 'clampFactBody truncates at 500', kind: 'fact' }).kind).toBe('reference');
    });

    it('a missing kind defaults to reference instead of rejecting', () => {
      expect(parse({ content: 'a standalone fact' }).kind).toBe('reference');
    });

    it('a valid kind is unaffected', () => {
      expect(parse({ content: 'ongoing work note', kind: 'project' }).kind).toBe('project');
    });

    it('content is STILL required — a missing fact is not fabricated (kind coercion only)', () => {
      expect(() => parse({ kind: 'reference' })).toThrow();
    });
  });

  it('the published tools/list JSON schema still advertises the {user,feedback,project,reference} kind enum', () => {
    const json = z.toJSONSchema(remember.args as never) as {
      properties?: { kind?: { enum?: string[] } };
    };
    expect(json.properties?.kind?.enum).toEqual(['user', 'feedback', 'project', 'reference']);
  });
});
