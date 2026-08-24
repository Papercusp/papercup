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
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import releaseTrace from '../release/trace';
import plansSearch from '../plans/search';
import crossHarnessPlansSearch from '../cross_harness/plans_search';
import eventsAwait from '../events/await';
import complete from '../work_items/complete';

// Force lexical-only: buildQueryEmbedder resolves to null (unconfigured embedder).
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

const hiveMocks = vi.hoisted(() => ({
  potHomeSlugForHarness: vi.fn(),
}));

vi.mock('../../hive-federation', () => ({
  potHomeSlugForHarness: hiveMocks.potHomeSlugForHarness,
}));

import toolFind, {
  boundDiscoveryHits,
  buildEmbeddingIndex,
  buildCorpus,
  compactSchemaForResult,
  DISCOVERY_RESULT_MAX_BYTES,
  filterCorpusForConfirmedHiveScope,
  warmToolFindIndex,
} from './find';

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

async function callHandler(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const res = await (toolFind as unknown as ToolDef).handler(args, ctx);
  return JSON.parse(res.content[0].text) as {
    query: string;
    count: number;
    semantic: 'on' | 'warming' | 'lexical-only';
    registry: { source: string; revision: string };
    hits: Array<{ tool: string; description: string | null; argSchema: string | null; via: string }>;
    howToCall: string;
  };
}

beforeEach(() => {
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
});

describe('tools:find tool registration', () => {
  it('registers with the expected name + capability + args', () => {
    const def = toolFind as unknown as ToolDef;
    expect(def.name).toBe('tools:find');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    expect((def as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
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

  it('uses the raw discovery schema for a release:trace-style path-or-sha union', () => {
    const name = 'test:release-trace-discovery-schema';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.union([
        z.object({ path: z.string().min(1), sha: z.string().optional() }),
        z.object({ path: z.string().optional(), sha: z.string().min(4) }),
      ]),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });

    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === name);
    expect(entry?.argSchema).toContain('one-of:path|sha');
    expect(entry?.argSchema).toContain('path?:string');
    expect(entry?.argSchema).toContain('sha?:string');
    expect(schemaByTool.get(name)).toMatchObject({ anyOf: expect.any(Array) });
  });

  it('exposes the actual release:trace path-or-sha requirements to discovery', () => {
    expect(releaseTrace.name).toBe('release:trace');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'release:trace');
    expect(entry?.argSchema).toContain('one-of:path|sha');
    expect(entry?.argSchema).toContain('path?:string');
    expect(entry?.argSchema).toContain('sha?:string');
    expect(schemaByTool.get('release:trace')).toMatchObject({ anyOf: expect.any(Array) });
  });

  it('projects root anyOf and oneOf branches with their required-key hint', () => {
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const compact = compactSchemaForResult({
        [keyword]: [
          { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sha: { type: 'string' } } },
          { type: 'object', required: ['sha'], properties: { path: { type: 'string' }, sha: { type: 'string' } } },
        ],
      });

      expect(compact).toBe('one-of:path|sha; path?:string; sha?:string');
    }
  });

  it('keeps work_items:complete assumptions visible in the bounded discovery schema', () => {
    expect(complete.name).toBe('work_items:complete');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'work_items:complete');
    const schema = schemaByTool.get('work_items:complete');
    const compact = compactSchemaForResult(schema);

    expect(schema).toMatchObject({ anyOf: expect.any(Array) });
    expect(entry?.argSchema).toContain('assumptions?');
    expect(compact).toContain('one-of:items');
    expect(compact).toContain('assumptions?');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });
});

describe('confirmed hive discovery visibility (WI-39255)', () => {
  it('removes cross_harness tools only after a concrete hive resolution', async () => {
    expect(plansSearch.name).toBe('plans:search');
    expect(crossHarnessPlansSearch.name).toBe('cross_harness:plans_search');
    const { corpus } = buildCorpus();
    expect(corpus.some((entry) => entry.tool.startsWith('cross_harness:'))).toBe(true);
    const resolveHive = vi.fn().mockResolvedValue('home-hive');

    const visible = await filterCorpusForConfirmedHiveScope(
      corpus,
      { workspaceId: 'ws-1', harnessSlug: 'member-a' },
      resolveHive,
    );

    expect(resolveHive).toHaveBeenCalledWith('ws-1', 'member-a');
    expect(visible.some((entry) => entry.tool.startsWith('cross_harness:'))).toBe(false);
    expect(visible.some((entry) => entry.tool === 'plans:search')).toBe(true);
  });

  it('fails open when the harness is standalone or hive resolution throws', async () => {
    const { corpus } = buildCorpus();

    await expect(
      filterCorpusForConfirmedHiveScope(
        corpus,
        { workspaceId: 'ws-1', harnessSlug: 'standalone' },
        vi.fn().mockResolvedValue(null),
      ),
    ).resolves.toBe(corpus);
    await expect(
      filterCorpusForConfirmedHiveScope(
        corpus,
        { workspaceId: 'ws-1', harnessSlug: 'member-a' },
        vi.fn().mockRejectedValue(new Error('registry unavailable')),
      ),
    ).resolves.toBe(corpus);
  });

  it('does not resolve hive membership for an unscoped caller', async () => {
    const { corpus } = buildCorpus();
    const resolveHive = vi.fn();

    await expect(
      filterCorpusForConfirmedHiveScope(corpus, { workspaceId: 'ws-1', harnessSlug: '*' }, resolveHive),
    ).resolves.toBe(corpus);
    expect(resolveHive).not.toHaveBeenCalled();
  });

  it('ranks a callable local plan reader first after hiding the forbidden exact match', async () => {
    hiveMocks.potHomeSlugForHarness.mockResolvedValue('home-hive');

    const out = await callHandler(
      { query: 'cross_harness:plans_search', limit: 1 },
      { workspaceId: 'ws-1', harnessSlug: 'member-a' },
    );

    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-1', 'member-a');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.tool).toBe('plans:search');
  });
});

describe('handler — graceful degrade + result shape', () => {
  it('runs lexical-only when no embedder is configured, marking semantic accordingly', async () => {
    const out = await callHandler({ query: 'find tools by intent' });
    expect(out.semantic).toBe('lexical-only'); // never silently pretends semantic ran
    expect(out.registry).toEqual({
      source: 'projected-tool-registry',
      revision: expect.stringMatching(/^projected-tool-registry-v1:/),
    });
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

describe('bounded discovery projection (EI-20235784774977954)', () => {
  it('keeps nested object fields visible without copying verbose descriptions', () => {
    const schema = {
      type: 'object',
      properties: {
        body: {
          anyOf: [
            { type: 'string' },
            {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  premises: {
                    anyOf: [
                      { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                  youMayNotKnow: {
                    anyOf: [
                      {
                        type: 'array',
                        maxItems: 20,
                        items: {
                          type: 'object',
                          properties: {
                            ref: { type: 'string' },
                            provenance: { type: 'string', enum: ['computed', 'authored'] },
                          },
                          required: ['ref', 'provenance'],
                        },
                      },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                  couldNotDetermine: {
                    anyOf: [
                      {
                        type: 'array',
                        maxItems: 20,
                        items: {
                          type: 'object',
                          properties: { what: { type: 'string' }, note: { type: 'string' } },
                          required: ['what'],
                        },
                      },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                },
                required: ['text'],
              },
            },
          ],
        },
        expects: { type: 'string', enum: ['ack', 'answer', 'action', 'none'] },
      },
    };

    const compact = compactSchemaForResult(schema);
    expect(compact).toContain(
      'body?:array(1-20){text:string,premises?:array(≤20),youMayNotKnow?:array(≤20){ref:string,provenance:enum(computed|authored)},couldNotDetermine?:array(≤20){what:string,note?:string}}',
    );
    expect(compact).toContain('expects?:enum(ack|answer|action|none)');
    expect(compact).not.toContain('body?:string|');
    expect(compact).not.toContain('premises?:array|string');
    expect(compact).not.toContain('youMayNotKnow?:array|string');
    expect(compact).not.toContain('couldNotDetermine?:array|string');
    expect(compact).not.toContain('description');
  });

  it('keeps ordinary unions intact when they are not teaching-only array branches', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['yes', 'no'] }] },
      },
    });

    expect(compact).toContain('value?:boolean|enum(yes|no)');
  });

  it('renders an array item pattern in the compact result', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        refs: { type: 'array', items: { type: 'string', pattern: '^P-\\d{3,}$' } },
      },
    });

    expect(compact).toBe('refs?:array<string~/^P-\\d{3,}$/>');
  });

  it('renders a property pattern in the compact result', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        published_sha: { type: 'string', pattern: '^[0-9a-f]{40,64}$' },
      },
    });

    expect(compact).toBe('published_sha?:string~/^[0-9a-f]{40,64}$/');
  });

  it('preserves exclusive bounds in the compact result (events:await timeout_sec)', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        timeout_sec: { type: 'integer', exclusiveMinimum: 0, maximum: 604800 },
      },
    });

    expect(compact).toBe('timeout_sec?:integer(>0-604800)');
  });

  it('exposes the live events:await exclusive lower bound through the discovery corpus', () => {
    expect(eventsAwait.name).toBe('events:await');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'events:await');
    const compact = compactSchemaForResult(schemaByTool.get('events:await'));

    expect(entry?.argSchema).toContain('timeout_sec?:integer');
    expect(compact).toContain('timeout_sec?:integer(>0-604800)');
  });

  it('renders a JSON-schema const as a singleton enum in nested discovery output', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        producer_health: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'green-checkpoint' },
          },
          required: ['kind'],
        },
      },
    });

    expect(compact).toBe('producer_health?:object{kind:enum(green-checkpoint)}');
  });

  it('preserves a bounded nested semantic description when structure cannot express the constraint (EI-21211778836360588)', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        producer_health: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'green-checkpoint' },
            pipeline: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              description:
                'Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
            },
          },
          required: ['kind'],
        },
      },
    });

    const rendered = compact ?? '';
    expect(rendered).toContain(
      'pipeline?:string(1-64) Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
    );
    expect(rendered.length).toBeLessThanOrEqual(2_200);
  });

  it('returns valid bounded JSON and marks omitted hits', () => {
    const base = {
      query: 'a verbose discovery query',
      semantic: 'on',
      activated: false,
      howToCall: 'tools:invoke {name, args}',
      totalMatches: 8,
    };
    const hits = Array.from({ length: 8 }, (_, i) => ({
      tool: `tool:${i}`,
      description: 'd'.repeat(320),
      argSchema: 'field?:object' + 'x'.repeat(2_180),
      via: 'lexical',
    }));
    const bounded = boundDiscoveryHits(base, hits);
    const payload = { ...base, count: bounded.hits.length, truncated: bounded.truncated, hits: bounded.hits };

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(DISCOVERY_RESULT_MAX_BYTES);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(bounded.truncated).toBe(true);
    expect(bounded.hits.length).toBeLessThan(hits.length);
  });
});

describe('handler — dynamic activation (dynamic-tool-surface-2026-07-01)', () => {
  it('activates the matched tools for the session + reports activated:true', async () => {
    const activated: string[][] = [];
    const ctx = {
      activateTools: (names: readonly string[]) => {
        activated.push([...names]);
        return true;
      },
    };
    const res = await (toolFind as unknown as ToolDef).handler({ query: 'find tools by intent' }, ctx);
    const out = JSON.parse(res.content[0].text) as {
      activated: boolean;
      hits: Array<{ tool: string }>;
      howToCall: string;
    };
    // activateTools was called exactly once, with EVERY hit's tool name.
    expect(activated).toHaveLength(1);
    expect(activated[0]).toEqual(out.hits.map((h) => h.tool));
    expect(out.activated).toBe(true);
    // EI-20224177038218883: server activation cannot prove the client consumed
    // list_changed and materialized a same-turn wrapper. Lead with the one path
    // that is immediately callable on every client.
    expect(out.howToCall).toContain('tools:invoke');
    expect(out.howToCall).toContain('does NOT guarantee');
    expect(out.howToCall).not.toContain('call the one you want directly');
  });

  it('never breaks discovery when activation throws — hits still returned', async () => {
    const ctx = {
      activateTools: () => {
        throw new Error('surface exploded');
      },
    };
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
