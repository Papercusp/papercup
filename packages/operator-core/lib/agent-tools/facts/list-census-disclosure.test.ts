/**
 * WI-38910 — `facts:list` reported its PAGE SIZE as `count` and nothing else.
 *
 * The page is 4 rows by default (FACTS_LIST_DEFAULT_LIMIT, sized for the result
 * door — that limit is correct and is NOT what this guards). The defect was that
 * a 4-row page over a scope holding 271 live facts came back as `count: 4` with
 * no census, which reads as "4 facts stand in this scope".
 *
 * Why that is worth a guard rather than a nicer label: agents are instructed to
 * read standing facts BEFORE asserting, so the dedup check saw ~1.5% of the
 * population and could not find the key it was looking for. The duplicate assert
 * that follows EVICTS a peer's still-valid fact, because the busy scopes sit
 * permanently at FACTS_PER_SCOPE_CAP. The read side was quietly driving avoidable
 * destructive writes on the write side.
 *
 * The store-level parity between page and census lives in
 * agent-facts/store.integration.test.ts (real PG). THIS file pins the half a
 * caller actually sees: that the response distinguishes page from census at all,
 * and does so on the DEFAULT no-argument call — which was the one path with zero
 * disclosure before.
 *
 * Hermetic: the two PG-touching reads (listFacts, countLiveFacts) and the
 * stale-source annotator are stubbed, so this never writes to or reads from the
 * live agent_facts table (the EI-18690423801323019 lesson from the sibling
 * assert suite: never let ambient DB reachability be the assertion mechanism).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact } from '../../agent-facts/store';

const listFactsSpy = vi.hoisted(() => vi.fn<() => Promise<AgentFact[]>>());
const countLiveFactsSpy = vi.hoisted(() => vi.fn<() => Promise<number>>());

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  // Spread the real module: the tool also imports FACT_SCOPES / isPermanentFactExpiry
  // from here, and the shaping under test should run against the real helpers.
  return { ...actual, listFacts: listFactsSpy, countLiveFacts: countLiveFactsSpy };
});
// EI-10947 annotator: pure pass-through here so the shaping is what is measured.
vi.mock('./stale-source', () => ({ markStaleSourceFacts: async (f: AgentFact[]) => f }));

import factsListTool, { FACTS_LIST_ALL_LIMIT, FACTS_LIST_MAX_LIMIT } from './list';

const ctx = { isSuperuser: true, uiClientId: 'su-test-census-disclosure' } as never;

const fact = (key: string): AgentFact => ({
  scope: 'workspace',
  scopeRef: null,
  key,
  body: `body of ${key}`,
  confidence: null,
  kind: null,
  // Left empty on purpose: a non-empty dependsOn sends the handler down the
  // dependency-staleness path, which is a different concern than this file's.
  dependsOn: [],
  claim: null,
  enforcement: null,
  sourceRef: null,
  audienceScope: null,
  sourceProvenance: null,
  createdBy: 'su-test',
  updatedAt: '2026-08-14T00:00:00Z',
  expiresAt: '2026-08-21T00:00:00Z',
});

const page = (n: number) => Array.from({ length: n }, (_, i) => fact(`k-${i}`));

async function listWorkspace(args: Record<string, unknown> = {}) {
  const out = (await factsListTool.handler(
    { scope: 'workspace', ...args } as never,
    ctx,
  )) as { data: Record<string, unknown> };
  return out.data;
}

beforeEach(() => {
  listFactsSpy.mockReset();
  countLiveFactsSpy.mockReset();
});

describe('facts:list distinguishes the page from the census (WI-38910)', () => {
  it('refuses a ref-bearing scope when context cannot resolve its scopeRef', async () => {
    await expect(factsListTool.handler({ scope: 'harness' } as never, ctx)).rejects.toThrow(
      "facts:list — scope 'harness' requires scope_ref",
    );
    expect(listFactsSpy).not.toHaveBeenCalled();
    expect(countLiveFactsSpy).not.toHaveBeenCalled();
  });

  it('reports the census on a DEFAULT no-argument call — the path that had no disclosure at all', async () => {
    listFactsSpy.mockResolvedValue(page(FACTS_LIST_MAX_LIMIT));
    countLiveFactsSpy.mockResolvedValue(271);

    const data = await listWorkspace();

    // `count` keeps meaning the page size — callers and tests depend on that.
    expect(data.count).toBe(FACTS_LIST_MAX_LIMIT);
    // ...but it is no longer the ONLY number, which is the whole defect.
    expect(data.total).toBe(271);
    expect(data.truncatedByLimit).toBe(true);
    // The disclosure has to be legible without reading the source: both numbers.
    expect(String(data.note_truncated)).toContain('271');
    expect(String(data.note_truncated)).toContain(String(FACTS_LIST_MAX_LIMIT));
  });

  it('accepts a compatibility limit above the ordinary validator cap with all:true', async () => {
    listFactsSpy.mockResolvedValue(page(FACTS_LIST_ALL_LIMIT));
    countLiveFactsSpy.mockResolvedValue(500);

    const limitSchema = (
      factsListTool.args as unknown as {
        shape: { limit: { safeParse(value: unknown): { success: boolean } } };
      }
    ).shape.limit;
    expect(limitSchema.safeParse(500).success).toBe(true);

    const data = await listWorkspace({ all: true, limit: 500 });

    expect(data.ok).toBe(true);
    expect(data.total).toBe(500);
    expect(listFactsSpy).toHaveBeenCalledWith(
      { scope: 'workspace', scopeRef: null },
      { limit: FACTS_LIST_ALL_LIMIT },
    );
  });

  it('stays quiet when the page IS the whole scope — a warning that always fires is one nobody reads', async () => {
    listFactsSpy.mockResolvedValue(page(2));
    countLiveFactsSpy.mockResolvedValue(2);

    const data = await listWorkspace();

    expect(data.count).toBe(2);
    expect(data.total).toBe(2);
    expect(data.truncatedByLimit).toBeUndefined();
    expect(data.note_truncated).toBeUndefined();
  });

  it('degrades to an explicit unknown when the census fails — never to a confident-looking number', async () => {
    listFactsSpy.mockResolvedValue(page(4));
    countLiveFactsSpy.mockRejectedValue(new Error('pg exploded'));

    const data = await listWorkspace();

    // Fail-soft: the read the caller asked for still succeeds...
    expect(data.ok).toBe(true);
    expect(data.facts).toHaveLength(4);
    // ...but a failed census must not masquerade as "the scope holds 4".
    expect(data.total).toBeUndefined();
    expect(data.totalUnknown).toBe('census_query_failed');
    // And with no census there is no basis to claim truncation either way.
    expect(data.truncatedByLimit).toBeUndefined();
  });

  it('asks the census about the SAME scope it paged — a census over another scope is a new lie, not a fix', async () => {
    listFactsSpy.mockResolvedValue(page(4));
    countLiveFactsSpy.mockResolvedValue(9);

    await listWorkspace();

    expect(countLiveFactsSpy).toHaveBeenCalledTimes(1);
    const [selector] = countLiveFactsSpy.mock.calls[0]! as unknown as [
      { scope: string; scopeRef: string | null },
    ];
    expect(selector.scope).toBe('workspace');
    expect(selector.scopeRef).toBeNull();
  });
});
