/**
 * mid-turn-context.test.ts — the MID-TURN injection endpoint
 * (context-injection-audit-2026-07-28 P-015 / D-026).
 *
 * The load-bearing cases here are the COST ones. This endpoint is called before
 * every investigation-shaped tool dispatch in every psu session on the box, so
 * its failure mode is not "returns the wrong text" — it is "quietly costs the
 * whole fleet an embed per tool call, or floods a fifty-call turn with 200k
 * chars of context". Three properties keep that from happening, and each has a
 * test below that fails if someone removes it:
 *
 *   - the budget stays an order of magnitude under turn-start's 4000;
 *   - the port stays 'mid-turn', so the port-agnostic epoch ledger (D-006)
 *     dedups it against turn-start/orient/initialize FOR FREE — the reason
 *     P-017 must not grow a second dedup;
 *   - a tool call carrying no recall signal spends NOTHING.
 *
 * The acceptance case (P-018) is the last describe block: the push must fire on
 * the FIRST grep for a symptom, because that is the call that saves the other
 * nineteen. A time-based throttle would have suppressed exactly that, which is
 * why the rate guard is a rolling ceiling rather than a min-interval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { buildMemoryContextBlockMock } = vi.hoisted(() => ({
  buildMemoryContextBlockMock: vi.fn(),
}));

// Same relative specifiers the source's dynamic imports use (colocated).
vi.mock('../../../memory/injection', () => ({
  buildMemoryContextBlock: buildMemoryContextBlockMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'u-1' }) }));

import routes, {
  deriveQuery,
  deriveBatchQuery,
  clampToBudget,
  splitLegQueries,
} from './mid-turn-context';
import { CORPUS_BLOCK_HEADING } from '../../../memory/corpus-recall';

const endpoint = routes[0] as unknown as {
  handler: (req: Request) => Promise<Response>;
};

const post = async (body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await endpoint.handler(
    new Request('http://localhost/agent-mcp/mid-turn-context', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
  return (await res.json()) as { ok: boolean; text: string };
};

/** Each test gets a fresh session id — the rate/dedup state is keyed by owner. */
let seq = 0;
const owner = (): string => `sess-${++seq}`;

const firstCall = () => buildMemoryContextBlockMock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  buildMemoryContextBlockMock.mockReset().mockResolvedValue('MEM');
});

describe('mid-turn-context — query derivation', () => {
  it('reads a Bash call as its command plus the agent\'s own description', () => {
    expect(deriveQuery('Bash', { command: 'rg WI-6512 packages', description: 'find the bug' })).toBe(
      'rg WI-6512 packages — find the bug',
    );
  });

  it('reads a Grep call as pattern + where it is looking', () => {
    expect(deriveQuery('Grep', { pattern: 'buildMemoryContextBlock', path: 'packages' })).toBe(
      'buildMemoryContextBlock packages',
    );
  });

  it('reads a Read call as the path', () => {
    expect(deriveQuery('Read', { file_path: '/a/b/injection.ts' })).toBe('/a/b/injection.ts');
  });

  it('yields NOTHING for a tool with no recall signal — so it can be dropped before any spend', () => {
    // Edit/Write/TodoWrite etc. carry no investigation signal. Returning '' here
    // is what makes an unknown tool free rather than embedding a blob of JSON.
    expect(deriveQuery('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('');
    expect(deriveQuery('TodoWrite', { todos: [] })).toBe('');
  });
});

describe('mid-turn-context — batch folding (the PostToolBatch payload)', () => {
  it('folds a batch newest-FIRST — the tail of a batch is the freshest intent', () => {
    const q = deriveBatchQuery([
      { tool: 'Read', toolInput: { file_path: '/old.ts' }, toolResponse: 'contents' },
      { tool: 'Grep', toolInput: { pattern: 'newest' }, toolResponse: 'a hit' },
    ]);
    expect(q.indexOf('newest')).toBeLessThan(q.indexOf('/old.ts'));
  });

  it('marks a BARREN result — the strongest "about to re-derive something" signal there is', () => {
    // Only available because this fires AFTER the tools ran. A grep that found
    // nothing is exactly when recall is most valuable.
    expect(deriveBatchQuery([{ tool: 'Grep', toolInput: { pattern: 'WI-6512' }, toolResponse: 'No matches found' }]))
      .toContain('(no result)');
    expect(deriveBatchQuery([{ tool: 'Grep', toolInput: { pattern: 'WI-6512' }, toolResponse: 'packages/a.ts:12: hit' }]))
      .not.toContain('(no result)');
  });

  it('accepts the CLAMPED string tool_input the hook actually sends', () => {
    // The hook JSON-stringifies and clamps before POSTing, so the server must
    // parse that back rather than assuming a structured object.
    expect(deriveQuery('Grep', JSON.stringify({ pattern: 'abc', path: 'packages' }))).toBe('abc packages');
  });

  it('falls back to raw text when a clamp truncated the JSON mid-way', () => {
    expect(deriveQuery('Bash', '{"command":"rg WI-65')).toContain('rg WI-65');
  });

  it('drops a batch whose calls carry no recall signal at all', async () => {
    const out = await post({
      owner: owner(),
      toolCalls: [{ tool: 'Edit', toolInput: { file_path: '/a.ts' }, toolResponse: 'ok' }],
    });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(out.text).toBe('');
  });

  it('runs the pipeline once for the whole batch, not once per call', async () => {
    await post({
      owner: owner(),
      toolCalls: [
        { tool: 'Grep', toolInput: { pattern: 'alpha' }, toolResponse: 'x' },
        { tool: 'Grep', toolInput: { pattern: 'beta' }, toolResponse: 'y' },
        { tool: 'Read', toolInput: { file_path: '/c.ts' }, toolResponse: 'z' },
      ],
      harness: 'papercusp',
    });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(firstCall()).toMatchObject({ session: { port: 'mid-turn' } });
  });
});

describe('mid-turn-context — the cost properties', () => {
  it('spends NOTHING on a tool call with no recall signal', async () => {
    const out = await post({ owner: owner(), tool: 'Edit', toolInput: { file_path: '/a.ts' } });
    expect(buildMemoryContextBlockMock).not.toHaveBeenCalled();
    expect(out.text).toBe('');
  });

  it('uses a budget an ORDER OF MAGNITUDE under turn-start\'s 4000', async () => {
    // The arithmetic that matters: at turn-start's budget a 50-call turn would
    // inject ~200k chars. If this assertion is ever "fixed" by raising the
    // budget, re-do that arithmetic first.
    await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'deploy pipeline' } });
    const { budgetChars } = firstCall() as { budgetChars: number };
    expect(budgetChars).toBeLessThanOrEqual(400);
    expect(budgetChars * 50).toBeLessThan(4_000 * 50 * 0.2);
  });

  it('passes port "mid-turn" so the epoch ledger dedups it against every other port for free', async () => {
    // D-006: the ledger is port-agnostic. This is the whole reason P-017 needs
    // no dedup of its own — do not add a second one.
    await post({ owner: 'sess-port', tool: 'Grep', toolInput: { pattern: 'x' }, harness: 'papercusp' });
    expect(firstCall()).toMatchObject({
      session: { sessionId: 'sess-port', port: 'mid-turn' },
      harnessSlugs: ['papercusp'],
    });
  });

  it('skips an IDENTICAL consecutive query for free — a retry loop costs one embed, not N', async () => {
    const o = owner();
    const call = { owner: o, tool: 'Bash', toolInput: { command: 'npm test' } };
    await post(call);
    await post(call);
    await post(call);
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
  });

  it('caps recalls per rolling minute so a burst cannot buy an embed each', async () => {
    const o = owner();
    for (let i = 0; i < 40; i++) {
      await post({ owner: o, tool: 'Grep', toolInput: { pattern: `distinct-${i}` } });
    }
    // Every query is distinct, so only the rolling ceiling can bound this.
    expect(buildMemoryContextBlockMock.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('clamps a very long command rather than embedding a pasted heredoc', async () => {
    await post({ owner: owner(), tool: 'Bash', toolInput: { command: 'x'.repeat(5_000) } });
    // The clamp applies to the DERIVED text, before the P-044 per-leg split, so
    // both halves inherit it — neither leg can be handed a pasted heredoc.
    const { queryContext } = firstCall() as {
      queryContext: { userText: string; lexicalText: string };
    };
    expect(queryContext.userText).toHaveLength(1_000);
    expect(queryContext.lexicalText).toHaveLength(1_000);
  });
});

describe('mid-turn-context — never breaks a turn', () => {
  it('fail-soft: a throwing memory pipeline never surfaces an error into the tool call', async () => {
    buildMemoryContextBlockMock.mockRejectedValue(new Error('backend down'));
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'storage policy' } });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('');
  });

  it('returns empty rather than null when the pipeline finds nothing relevant', async () => {
    buildMemoryContextBlockMock.mockResolvedValue(null);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'nothing here' } });
    expect(out.text).toBe('');
  });

  it('requires an owner', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/mid-turn-context', {
        method: 'POST',
        body: JSON.stringify({ tool: 'Grep', toolInput: { pattern: 'x' } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('survives a malformed body', async () => {
    const res = await endpoint.handler(
      new Request('http://localhost/agent-mcp/mid-turn-context', { method: 'POST', body: 'not json' }),
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('mid-turn-context — P-018 acceptance: fires EARLY, on the first grep', () => {
  it('injects on the FIRST investigation call, not after a warm-up', async () => {
    // The founding case: an su spent ~20 calls re-deriving WI-6512, a bug
    // already documented in three docstrings. The push has to land on call one —
    // that is the call that saves the other nineteen.
    const out = await post({
      owner: owner(),
      tool: 'Grep',
      toolInput: { pattern: 'WI-6512', path: 'packages' },
      harness: 'papercusp',
    });
    expect(buildMemoryContextBlockMock).toHaveBeenCalledTimes(1);
    expect(out.text).toBe('MEM');
    // P-044: the derived signal is still `WI-6512 packages`, but it is now
    // issued as two per-leg queries. `packages` is a bare directory with no
    // slash, so nothing is strippable here and both halves are the whole text —
    // the id, which is what this acceptance case is actually about, reaches
    // BOTH legs exactly as before.
    expect(firstCall()).toMatchObject({
      queryContext: { userText: 'WI-6512 packages', lexicalText: 'WI-6512 packages' },
    });
  });
});

describe('mid-turn-context — the budget is enforced HERE, because injection.ts does not', () => {
  // THE DEFECT THIS PINS (found by running the P-018 acceptance case against live
  // retrieval, not by reading the code): buildMemoryContextBlock treats budgetChars
  // as advisory for the FIRST row. Its admit() is
  //     if (spent + line.length > budget && lines.length > 0) return false;
  // so row one is emitted whole at any size — deliberate there (a small-budget
  // caller should get something rather than null), wrong here. Measured against the
  // real store, the top-ranked record for the acceptance query is ~3,700 chars
  // against this endpoint's 350. Since this fires per tool BATCH, an unclamped
  // endpoint reintroduces exactly the context flood the 350 budget exists to
  // prevent — and the epoch dedup does NOT save us, because it bounds the repeat
  // of ONE record, not the size of fifty distinct ones.
  const OVERSIZED = `## Possibly relevant (mid-turn)\n\n- [project @ papercusp] (id=980ce692) ${'x'.repeat(4000)}`;

  it('clamps a single oversized row that buildMemoryContextBlock emitted whole', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce(OVERSIZED);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'slow session history' } });
    // Generously under the raw block, and near the 350 budget rather than 10x it.
    expect(out.text.length).toBeLessThan(500);
    expect(OVERSIZED.length).toBeGreaterThan(4000);
  });

  it('keeps the HANDLE when it clips — scope and id survive, so the teaser is actionable', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce(OVERSIZED);
    const out = await post({ owner: owner(), tool: 'Grep', toolInput: { pattern: 'slow session history' } });
    expect(out.text).toContain('id=980ce692');
    expect(out.text).toContain('memory:search');
  });

  it('leaves a block already within budget byte-identical', () => {
    const small = '## Possibly relevant (mid-turn)\n\n- [project] (id=abc) short and useful';
    expect(clampToBudget(small)).toBe(small);
  });

  it('never throws on an empty block', () => {
    expect(clampToBudget('')).toBe('');
  });

  it('cuts at a word boundary when one is available, not mid-token', () => {
    const block = `${'word '.repeat(100)}TAIL`;
    const out = clampToBudget(block, 120);
    const head = out.split(' … ')[0]!;
    expect(head.endsWith('word')).toBe(true);
  });

  // WI-6857 CUT 2. The clamp is a repair for the mem0 leg's UNENFORCED budget
  // (see the OVERSIZED comment above), and it was being applied to the whole
  // composed block — so the corpus pointer section composeWithCorpus appends
  // LAST was deleted on every call. Measured live: 21 of 21 calls returned
  // 398-403 chars, i.e. this budget plus the clip suffix, never a pointer.
  // The corpus leg enforces CORPUS_BUDGET_CHARS strictly (no first-row
  // exemption — WI-6870), so it arrives already bounded.
  const POINTER =
    "- [work-item WI-6512 · 2026-07-27] clicking an agent takes several seconds → work_items:get { id: 'WI-6512' }";
  const CORPUS = `### ${CORPUS_BLOCK_HEADING}\n\n${POINTER}`;

  it('does NOT clamp the corpus pointer section away — it is bounded by its own leg', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ${'x'.repeat(4000)}\n\n${CORPUS}`;
    const out = clampToBudget(block);
    expect(out).toContain('WI-6512');
    expect(out).toContain("work_items:get { id: 'WI-6512' }");
    expect(out.endsWith(POINTER)).toBe(true);
  });

  it('still clamps the mem0 half when a corpus section follows it', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ${'x'.repeat(4000)}\n\n${CORPUS}`;
    const out = clampToBudget(block);
    const mem0 = out.slice(0, out.indexOf(`\n\n### ${CORPUS_BLOCK_HEADING}`));
    expect(mem0).toContain('(clipped');
    expect(mem0.length).toBeLessThan(500);
  });

  it('leaves a corpus-only block whole — the mem0 leg having nothing is P-008s motivating case', () => {
    const block = `## ${CORPUS_BLOCK_HEADING}\n\n${POINTER.repeat(6)}`;
    expect(clampToBudget(block)).toBe(block);
  });

  it('never truncates a pointer mid-line — a half-written resolve call resolves to nothing', () => {
    const block = `## Possibly relevant (mid-turn)\n\n- [project] (id=abc) ok\n\n${CORPUS}`;
    const out = clampToBudget(block, 20);
    for (const line of out.split('\n').filter((l) => l.startsWith('- [work-item'))) {
      expect(line.endsWith("}")).toBe(true);
    }
  });
});

describe('splitLegQueries — de-diluting the cosine query (P-044 / F-L, motivated by D-041)', () => {
  it('strips path tokens from the COSINE half and keeps the LEXICAL half whole', () => {
    // D-041's batch one, in shape: four content words carrying a directory path
    // twice plus a full component path. The cosine leg embeds ONE vector, so
    // those tokens were pulling it toward "files under apps/operator-vite".
    const derived =
      'session history slow apps/operator-vite/src · apps/operator-vite/src/components/HistoryDropdown.tsx';
    const { cosine, lexical } = splitLegQueries(derived);
    // No trailing `·`: the second segment was nothing BUT a path, so its
    // separator is debris once the path is gone (WI-6857).
    expect(cosine).toBe('session history slow');
    expect(lexical).toBe(derived);
  });

  it('sweeps the separator + "(no result)" debris the strip leaves behind (WI-6857)', () => {
    // The WI-6512 replay's batch 63, verbatim: a barren Grep, a Read that is
    // pure path, and a Grep carrying its own path. Before the sweep the cosine
    // query was `session history (no result) · · agents running` — 46 chars of
    // which ~28% was residue this function had already judged non-prose.
    const derived = deriveBatchQuery([
      {
        tool: 'Grep',
        toolInput: { pattern: 'agents running', path: 'apps/operator-vite/src' },
        toolResponse: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx',
      },
      {
        tool: 'Read',
        toolInput: { file_path: 'apps/operator-vite/src/components/adv/AgentsRunningPill.tsx' },
        toolResponse: 'export function AgentsRunningPill() { … }',
      },
      {
        tool: 'Grep',
        toolInput: { pattern: 'session history', path: 'apps/operator-vite/src' },
        toolResponse: 'No matches found',
      },
    ]);
    const { cosine, lexical } = splitLegQueries(derived);
    expect(cosine).toBe('session history · agents running');
    // The LEXICAL leg is byte-identical to the derived text — it keeps the
    // paths AND the barren marker, both of which it can actually use.
    expect(lexical).toBe(derived);
    expect(lexical).toContain('(no result)');
  });

  it('strips an absolute path and a single-slash path that carries an extension', () => {
    expect(splitLegQueries('why empty /home/x/repo/lib/a.ts').cosine).toBe('why empty');
    expect(splitLegQueries('why empty memory/injection.ts').cosine).toBe('why empty');
  });

  it('LEAVES prose that merely contains a slash — where the false positives live', () => {
    // `and/or`, `input/output`, `24/7` are things an agent really does type into
    // a Grep pattern or a Bash description; stripping them would delete meaning
    // from the very query this is protecting.
    for (const text of ['check the and/or branch', 'the input/output split', 'runs 24/7']) {
      expect(splitLegQueries(text).cosine).toBe(text);
    }
  });

  it('FALLS BACK to the full text when stripping leaves no prose — the load-bearing case', () => {
    // A Read-only batch is nothing but paths. buildMemoryContextBlock gates on
    // the COSINE text being non-empty, so returning '' here would silently
    // disable mid-turn recall for every path-only batch — a far larger
    // regression than the dilution this fixes. And with no prose present there
    // is nothing to dilute, so keeping the full text costs nothing.
    const derived = deriveBatchQuery([
      { tool: 'Read', toolInput: { file_path: 'packages/operator-core/lib/memory/injection.ts' }, toolResponse: 'x' },
    ]);
    const { cosine, lexical } = splitLegQueries(derived);
    expect(cosine).toBe(derived);
    expect(lexical).toBe(derived);
  });

  it('treats a "(no result)" marker as chrome, not as the prose worth keeping', () => {
    // Otherwise a barren path-only batch reads as "has words" and the cosine
    // query becomes the literal string "(no result)".
    const derived = deriveBatchQuery([
      { tool: 'Glob', toolInput: { pattern: 'apps/**/Foo.tsx' }, toolResponse: 'No files found' },
    ]);
    expect(splitLegQueries(derived).cosine).toBe(derived);
  });

  it('is a no-op on a query with no paths at all', () => {
    const derived = 'why does session history take several seconds to load';
    expect(splitLegQueries(derived)).toEqual({ cosine: derived, lexical: derived });
  });

  it('the endpoint sends the two halves to the two legs', async () => {
    buildMemoryContextBlockMock.mockResolvedValueOnce('## Possibly relevant (mid-turn)\n\n- hit');
    await post({
      owner: owner(),
      toolCalls: [
        {
          tool: 'Grep',
          toolInput: { pattern: 'session history slow', path: 'apps/operator-vite/src' },
          toolResponse: 'No matches found',
        },
      ],
    });
    const arg = buildMemoryContextBlockMock.mock.calls[0]![0] as {
      queryContext: { userText: string; lexicalText: string };
    };
    expect(arg.queryContext.userText).not.toContain('apps/operator-vite/src');
    expect(arg.queryContext.userText).toContain('session history slow');
    expect(arg.queryContext.lexicalText).toContain('apps/operator-vite/src');
  });
});
