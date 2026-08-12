/**
 * search.test.ts — EI-18877285731929394 regression.
 *
 * mode:'verbatim' is an exact, contiguous, case-insensitive substring match
 * (ILIKE) — by design, not a bug (confirmed live: a single literal word/quote
 * DOES match, and DOES span every session under session:'self' across a
 * carry-respawn — see WI-5644's filters.test.ts). But the compaction-recovery
 * doc's own example query is "<what you remember>", which reads as an
 * invitation to paraphrase — and a paraphrase silently returns 0 hits even
 * when the content exists. A 0-hit result then reads exactly like "it never
 * happened" instead of "your query wasn't a literal quote", which is what
 * misled an agent into telling the owner something false (the WI's own
 * incident). The fix: surface a fallback hint in the 0-hit verbatim response
 * itself, right where the false negative occurs.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/sessions/search.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
}));

// The verbatim tests below never reach the hybrid branch, but search.ts
// statically imports both — mock them inertly so the module loads without a
// live embedder/DB, and let the one hybrid test override the return value.
const runHybridSearch = vi.fn(async () => ({ results: [], totalHits: 0, embedderAvailable: true }));
// `configureSearchDefaults` is NOT used by these tests — it is here because
// `search.ts` -> `../search/sources` side-effect-imports
// `lib/search/configure-search-defaults`, which CALLS it at module load (P-017).
// An inline factory replaces the module wholesale, so omitting it turns this
// partial mock into a collection-time crash ("No export is defined on the
// mock") that fails the file before a single test runs. Keep it inert.
vi.mock('@papercusp/search', () => ({
  runHybridSearch: (...a: unknown[]) => runHybridSearch(...(a as [])),
  configureSearchDefaults: vi.fn(),
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn(async () => vi.fn()),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 1000),
}));

const searchModule = await import('./search');
const tool = searchModule.default;

const argsSchema = tool.args as {
  safeParse: (value: unknown) => { success: boolean };
};

interface ParsedResult {
  ok: boolean;
  mode: string;
  total_hits: number;
  hasMore: boolean;
  nextCursor?: string;
  hint?: string;
  resultsTruncated?: { requested: number; returned: number; reason: string };
  results: unknown[];
}

/** Stand-in for ctx.tx used by the verbatim (raw ILIKE) branch. */
function makeTx(rows: unknown[]) {
  return vi.fn(async () => rows);
}

function callTool(args: Record<string, unknown>, tx: unknown) {
  return (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx });
}

describe('sessions:search limit contract', () => {
  it('accepts a bounded page of 20 hits and rejects values above the advertised ceiling', () => {
    expect(argsSchema.safeParse({ query: 'needle', limit: 20 }).success).toBe(true);
    expect(argsSchema.safeParse({ query: 'needle', limit: 21 }).success).toBe(false);
  });
});

describe('sessions:search EI-18877285731929394 — verbatim 0-hit hint', () => {
  it('adds a fallback hint when verbatim mode finds nothing (the false-negative trap)', async () => {
    const tx = makeTx([]); // ILIKE query matched no rows
    const res = await callTool({ query: 'a paraphrase that is not a literal quote', mode: 'verbatim', context: 0 }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toMatch(/verbatim mode matches only an exact/i);
    expect(parsed.hint).toMatch(/mode:'hybrid'/);
  });

  it('omits the hint when verbatim mode finds a hit (no false negative to explain)', async () => {
    const tx = makeTx([
      { source_kind: 'claude', session_id: 'sess-1', turn_idx: 3, speaker: 'assistant', owner: 'su-self', harness_slug: null, ts: null, text: 'contains the literal quote' },
    ]);
    const res = await callTool({ query: 'literal quote', mode: 'verbatim', context: 0 }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(1);
    expect(parsed.hint).toBeUndefined();
  });

  it('never adds the verbatim hint in hybrid mode (default), even on 0 hits', async () => {
    runHybridSearch.mockResolvedValueOnce({ results: [], totalHits: 0, embedderAvailable: true });
    const res = await callTool({ query: 'anything', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.mode).toBe('hybrid');
    expect(parsed.total_hits).toBe(0);
    expect(parsed.hint).toBeUndefined();
  });
});

describe('sessions:search response-door shaping', () => {
  it('returns valid bounded JSON and a cursor when many same-block hits include windows', async () => {
    const text = 'same-content-block '.repeat(80);
    const rows = Array.from({ length: 11 }, (_, index) => ({
      source_kind: 'claude',
      session_id: `session-${index}`,
      turn_idx: index,
      speaker: 'assistant',
      owner: 'su-self',
      harness_slug: null,
      ts: null,
      text,
    }));
    const windowRows = rows.slice(0, 5).map(({ turn_idx, speaker, ts, text: windowText }) => ({
      turn_idx,
      speaker,
      ts,
      text: windowText,
    }));
    const tx = vi.fn(async (strings: readonly string[]) => {
      const sql = strings.join(' ');
      if (sql.includes('left(text, 700)')) return rows;
      if (sql.includes('left(text, 512)')) return [];
      if (sql.includes('SELECT turn_idx, speaker')) return windowRows;
      return [];
    });

    const res = await callTool({
      query: 'same-content-block',
      mode: 'verbatim',
      limit: 10,
      context: 2,
    }, tx);
    const raw = res.content[0].text;
    const parsed = JSON.parse(raw) as ParsedResult;

    expect(raw.length).toBeLessThanOrEqual(searchModule.SESSION_SEARCH_RESPONSE_BUDGET_CHARS);
    expect(parsed.ok).toBe(true);
    expect(parsed.total_hits).toBe(parsed.results.length);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.length).toBeLessThan(10);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBeDefined();
    expect(parsed.resultsTruncated).toMatchObject({ reason: 'response_budget' });
    expect(parsed.results[0]).toMatchObject({
      provenance: { session_id: 'session-0', source_kind: 'claude' },
      readMore: { tool: 'sessions:read' },
    });
  });
});
