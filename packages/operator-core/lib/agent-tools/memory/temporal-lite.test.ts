/**
 * temporal-lite.test.ts — the P-008 scenario fixture of
 * memory-temporal-lite-validity-windows-2026-07-11, at the TOOL layer: the
 * P-015 shape (a "default embedder is gemma" fact superseded by a "default
 * embedder is harrier" fact) exercised through memory:search/list read flags
 * (`as_of`, `include_superseded`), memory:update supersession
 * (`supersedes:<old-id>` → backend.invalidateEntry(old, { supersededBy: new })),
 * and memory:forget soft mode (invalidate instead of delete; the DEFAULT stays
 * hard-delete — the privacy-safe answer).
 *
 * The backend is a fake that implements the validity-window semantics the
 * real Mem0Backend + CanonicalVectorStore pair provides (windows live in
 * columns, surfaced as metadata.validity) — canonical-store.test.ts pins the
 * SQL those semantics compile to.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/temporal-lite.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
}));
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));
vi.mock('../../memory/write-journal', () => ({
  journalPendingWrite: vi.fn(async () => null),
}));

import search from './search';
import list from './list';
import update from './update';
import forget from './forget';
import { getMemoryBackend } from '../../memory/backend';

/** The P-015 scenario: the gemma-default fact was superseded 2026-07-10 by
 *  the harrier-default fact. Windows as the store holds them (columns). */
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const SUPERSEDED_AT = '2026-07-10T00:00:00.000Z';
const FIXTURE = [
  {
    id: OLD_ID,
    text: 'memory embed default is gemma',
    scope: 'user-1',
    score: 0.9,
    validAt: '2026-06-01T00:00:00.000Z',
    invalidAt: SUPERSEDED_AT,
    supersededBy: NEW_ID,
  },
  {
    id: NEW_ID,
    text: 'memory embed default is harrier',
    scope: 'user-1',
    score: 0.9,
    validAt: SUPERSEDED_AT,
    invalidAt: null as string | null,
    supersededBy: null as string | null,
  },
];

type Row = (typeof FIXTURE)[number];

/** The read semantics the real backend pair provides: default = current rows
 *  only; asOf = point-in-time window; includeSuperseded = everything. Rows
 *  touched by a control (or with a closed window) carry metadata.validity. */
function readFixture(opts: { asOf?: string; includeSuperseded?: boolean }): Array<{
  id: string;
  text: string;
  scope: string;
  score: number;
  metadata?: Record<string, unknown>;
}> {
  const refMs = opts.asOf !== undefined ? new Date(opts.asOf).getTime() : Date.now();
  const rows = FIXTURE.filter((r) => {
    if (opts.asOf !== undefined) {
      return new Date(r.validAt).getTime() <= refMs && (r.invalidAt === null || new Date(r.invalidAt).getTime() > refMs);
    }
    if (opts.includeSuperseded) return true;
    return r.invalidAt === null || new Date(r.invalidAt).getTime() > Date.now();
  });
  const fold = (r: Row) =>
    r.invalidAt === null && r.supersededBy === null && opts.asOf === undefined
      ? {}
      : {
          metadata: {
            validity: {
              valid_at: r.validAt,
              invalid_at: r.invalidAt,
              superseded_by: r.supersededBy,
              status: r.invalidAt !== null && new Date(r.invalidAt).getTime() <= refMs ? 'superseded' : 'current',
            },
          },
        };
  return rows.map((r) => ({ id: r.id, text: r.text, scope: r.scope, score: r.score, ...fold(r) }));
}

function fakeBackend(withInvalidateEntry = true) {
  return {
    name: 'fake-temporal',
    available: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async (_q: string, opts: { asOf?: string; includeSuperseded?: boolean }) => readFixture(opts)),
    list: vi.fn(async (opts: { asOf?: string; includeSuperseded?: boolean }) => readFixture(opts)),
    get: vi.fn(async () => null),
    remember: vi.fn(async () => ({ ids: [] })),
    update: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    ...(withInvalidateEntry ? { invalidateEntry: vi.fn(async () => true) } : {}),
  };
}

const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
// Handlers return either { data } or the MCP content envelope.
const parse = (res: unknown): any => {
  const r = res as { data?: unknown; content?: Array<{ text: string }> };
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeEach(() => vi.clearAllMocks());

describe('memory:search temporal flags (P-006 read path)', () => {
  it('DEFAULT recall returns only the CURRENT fact — the superseded one is gone', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await search.handler({ query: 'memory embed default' } as never, ctx));
    expect(out.ok).toBe(true);
    expect(out.results.map((r: { id: string }) => r.id)).toEqual([NEW_ID]);
    // No temporal control was passed to the backend.
    const opts = b.search.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.asOf).toBeUndefined();
    expect(opts.includeSuperseded).toBeUndefined();
  });

  it('as_of 2026-06-15 answers "what did we believe then?" — the gemma fact, marked current-as-of', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await search.handler({ query: 'memory embed default', as_of: '2026-06-15T00:00:00Z' } as never, ctx),
    );
    expect(out.results.map((r: { id: string }) => r.id)).toEqual([OLD_ID]);
    expect(out.results[0].metadata.validity.status).toBe('current');
    expect((b.search.mock.calls[0][1] as { asOf?: string }).asOf).toBe('2026-06-15T00:00:00Z');
  });

  it('include_superseded returns BOTH, the old one marked superseded with its replacement id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await search.handler({ query: 'memory embed default', include_superseded: true } as never, ctx),
    );
    expect(out.results.map((r: { id: string }) => r.id).sort()).toEqual([OLD_ID, NEW_ID].sort());
    const oldHit = out.results.find((r: { id: string }) => r.id === OLD_ID);
    expect(oldHit.metadata.validity).toMatchObject({ status: 'superseded', superseded_by: NEW_ID });
    expect((b.search.mock.calls[0][1] as { includeSuperseded?: boolean }).includeSuperseded).toBe(true);
  });
});

describe('memory:list temporal flags (P-006 read path)', () => {
  it('passes as_of + include_superseded through to backend.list', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await list.handler({ as_of: '2026-06-15T00:00:00Z', include_superseded: true } as never, ctx),
    );
    expect(out.ok).toBe(true);
    expect(b.list.mock.calls[0][0]).toMatchObject({
      asOf: '2026-06-15T00:00:00Z',
      includeSuperseded: true,
    });
  });
});

describe('memory:update supersedes (P-004 write path)', () => {
  it('patches the new fact, then closes the old one with superseded_by = new id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await update.handler(
        { id: NEW_ID, content: 'memory embed default is harrier', supersedes: OLD_ID } as never,
        ctx,
      ),
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: OLD_ID });
    // EI-10371: content edits carry the credential-flag re-stamp (clean here).
    expect(b.update).toHaveBeenCalledWith(NEW_ID, {
      text: 'memory embed default is harrier',
      metadata: { possible_secret: false, possible_secret_classes: [] },
    });
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID, { supersededBy: NEW_ID });
    // Order: the replacing fact lands in corrected form BEFORE the old closes.
    expect(b.update.mock.invocationCallOrder[0]).toBeLessThan(
      (b.invalidateEntry as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it('a supersedes-ONLY item is valid: no patch call, just the window close', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await update.handler({ id: NEW_ID, supersedes: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: OLD_ID });
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).toHaveBeenCalledTimes(1);
  });

  it('a memory cannot supersede itself — rejected BEFORE any write', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: NEW_ID } as never, ctx),
    );
    expect(out.results[0]).toMatchObject({ ok: false, id: NEW_ID });
    expect(out.results[0].error).toContain('supersede itself');
    expect(b.update).not.toHaveBeenCalled();
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('supersedes on a backend WITHOUT the capability fails the item before the patch (no half-done state)', async () => {
    const b = fakeBackend(false);
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx),
    );
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).toContain('validity-window support');
    expect(b.update).not.toHaveBeenCalled();
  });

  it('an already-closed / unknown old id reports honestly: patch ok, superseded:false + note (first-wins)', async () => {
    const b = fakeBackend();
    (b.invalidateEntry as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    useBackend(b);
    const out = parse(
      await update.handler({ id: NEW_ID, content: 'x', supersedes: OLD_ID } as never, ctx),
    );
    expect(out.results[0]).toMatchObject({ ok: true, id: NEW_ID, superseded: false });
    expect(out.results[0].supersede_note).toContain('already superseded or unknown');
  });
});

describe('memory:forget soft mode (P-004 write path)', () => {
  it('DEFAULT stays the HARD delete — the privacy-safe answer', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: OLD_ID });
    expect(out.results[0].soft).toBeUndefined();
    expect(b.forget).toHaveBeenCalledWith(OLD_ID);
    expect(b.invalidateEntry).not.toHaveBeenCalled();
  });

  it('soft:true closes the validity window instead of deleting', async () => {
    const b = fakeBackend();
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID, soft: true } as never, ctx));
    expect(out.results[0]).toMatchObject({ ok: true, id: OLD_ID, soft: true });
    expect(b.invalidateEntry).toHaveBeenCalledWith(OLD_ID);
    expect(b.forget).not.toHaveBeenCalled();
  });

  it('a soft forget of an already-closed / unknown id fails that item (never a silent no-op)', async () => {
    const b = fakeBackend();
    (b.invalidateEntry as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    useBackend(b);
    const out = parse(await forget.handler({ ids: [OLD_ID, NEW_ID], soft: true } as never, ctx));
    expect(out.counts).toEqual({ ok: 0, failed: 2 });
    expect(out.results[0].error).toContain('no open memory matched');
  });

  it('soft on a backend WITHOUT the capability refuses the batch — NEVER falls back to hard delete', async () => {
    const b = fakeBackend(false);
    useBackend(b);
    const out = parse(await forget.handler({ id: OLD_ID, soft: true } as never, ctx));
    expect(out).toMatchObject({ ok: false, reason: 'soft_forget_unsupported' });
    expect(b.forget).not.toHaveBeenCalled();
  });
});
