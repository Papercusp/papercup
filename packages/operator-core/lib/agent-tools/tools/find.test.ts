/**
 * Tests for the tools:find defineTool wiring (tool-discovery-for-weak-models WS3).
 * Importing the file triggers defineTool registration, so a compile/import/
 * capability error fails here too.
 *
 * The embedder module is mocked to return NO embedder, so the tool runs in its
 * graceful-degrade (lexical-only) mode deterministically — no network, no DB.
 * The semantic index BUILD path is covered separately via the injectable
 * buildEmbeddingIndex (a mock embedder), and the semantic FUSION via
 * tool-find.test.ts.
 *
 * Run with: npx vitest run packages/operator-core/lib/agent-tools/tools/find.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// Force lexical-only: buildQueryEmbedder resolves to null (unconfigured embedder).
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

import toolFind, { buildEmbeddingIndex, buildCorpus, warmToolFindIndex } from './find';

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

async function callHandler(args: Record<string, unknown>) {
  const res = await (toolFind as unknown as ToolDef).handler(args, {});
  return JSON.parse(res.content[0].text) as {
    query: string;
    count: number;
    semantic: 'on' | 'warming' | 'lexical-only';
    hits: Array<{ tool: string; description: string | null; argSchema: string | null; via: string }>;
    howToCall: string;
  };
}

describe('tools:find tool registration', () => {
  it('registers with the expected name + capability + args', () => {
    const def = toolFind as unknown as ToolDef;
    expect(def.name).toBe('tools:find');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    // args schema accepts a query, rejects an empty one.
    expect(def.args.safeParse({ query: 'feature flag' }).success).toBe(true);
    expect(def.args.safeParse({ query: '' }).success).toBe(false);
    expect(def.args.safeParse({}).success).toBe(false);
  });
});

describe('buildEmbeddingIndex (boot-time index builder)', () => {
  it('embeds each row → name→vector map', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['a', 'aaa'],
        ['c', 'ccccc'],
      ]),
      async (t) => [t.length, 0, 0],
    );
    expect(idx.get('a')).toEqual([3, 0, 0]);
    expect(idx.get('c')).toEqual([5, 0, 0]);
  });

  it('skips a row whose embedder throws (partial index still helps)', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['ok', 'fine'],
        ['boom', 'boom'],
      ]),
      async (t) => {
        if (t.includes('boom')) throw new Error('admission shed');
        return [1, 1];
      },
    );
    expect(idx.has('ok')).toBe(true);
    expect(idx.has('boom')).toBe(false);
  });

  it('skips a row that embeds to an empty vector', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['x', 'x'],
        ['y', 'y'],
      ]),
      async (t) => (t === 'x' ? [] : [1]),
    );
    expect(idx.has('x')).toBe(false);
    expect(idx.has('y')).toBe(true);
  });
});

describe('buildCorpus (live registry → corpus + embed text)', () => {
  it('includes tools:find itself, with arg-schema text folded in', () => {
    const { corpus, embedText } = buildCorpus();
    const self = corpus.find((e) => e.tool === 'tools:find');
    expect(self).toBeDefined();
    // tools:find takes { query, limit? } → its arg-schema text mentions the query arg.
    expect(self?.argSchema).toContain('query');
    // The embed text folds name + description + arg schema.
    const text = embedText.get('tools:find');
    expect(text).toContain('tools:find');
    expect(text).toContain('query');
  });
});

describe('handler — graceful degrade + result shape', () => {
  it('runs lexical-only when no embedder is configured, marking semantic accordingly', async () => {
    const out = await callHandler({ query: 'find tools by intent' });
    expect(out.semantic).toBe('lexical-only'); // never silently pretends semantic ran
    expect(out.count).toBeGreaterThan(0);
    // every hit carries name + description + argSchema + via.
    for (const h of out.hits) {
      expect(typeof h.tool).toBe('string');
      expect(h).toHaveProperty('description');
      expect(h).toHaveProperty('argSchema'); // null or a string, never missing
      expect(h.via).toBe('lexical');
    }
    // howToCall must always name the never-fails dispatch path (tools:invoke) —
    // the exact copy varies by activation state; the invariant is the pointer.
    expect(out.howToCall).toContain('tools:invoke');
  });

  it('returns the real tool arg-schema with a hit (schemas are returnable)', async () => {
    const out = await callHandler({ query: 'tools:find' });
    const self = out.hits.find((h) => h.tool === 'tools:find');
    expect(self?.argSchema).toContain('query');
  });
});

describe('handler — dynamic activation (dynamic-tool-surface-2026-07-01)', () => {
  it('activates the matched tools for the session + reports activated:true', async () => {
    const activated: string[][] = [];
    const ctx = { activateTools: (names: readonly string[]) => { activated.push([...names]); return true; } };
    const res = await (toolFind as unknown as ToolDef).handler({ query: 'find tools by intent' }, ctx);
    const out = JSON.parse(res.content[0].text) as {
      activated: boolean; hits: Array<{ tool: string }>; howToCall: string;
    };
    // activateTools was called exactly once, with EVERY hit's tool name.
    expect(activated).toHaveLength(1);
    expect(activated[0]).toEqual(out.hits.map((h) => h.tool));
    expect(out.activated).toBe(true);
    // The guidance flips to "call directly" once activated.
    expect(out.howToCall).toContain('call the one you want directly');
  });

  it('never breaks discovery when activation throws — hits still returned', async () => {
    const ctx = { activateTools: () => { throw new Error('surface exploded'); } };
    const res = await (toolFind as unknown as ToolDef).handler({ query: 'feature flag' }, ctx);
    const out = JSON.parse(res.content[0].text) as { activated: boolean; count: number };
    expect(out.activated).toBe(false); // swallowed
    expect(out.count).toBeGreaterThan(0); // discovery unaffected
  });
});

describe('warmToolFindIndex (boot warm)', () => {
  it('resolves without throwing when no embedder is configured (no-op warm)', async () => {
    await expect(warmToolFindIndex()).resolves.toBeUndefined();
  });
});
