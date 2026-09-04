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
import plansAudit from '../plans/audit';
import plansSearch from '../plans/search';
import crossHarnessPlansSearch from '../cross_harness/plans_search';
import eventsAwait from '../events/await';
import complete from '../work_items/complete';
import workItemsCreate from '../work_items/create';
import coordSend from '../coordination/tools/send';
import { scorecardEmitArgs } from '../scorecards/emit';
import { schemaAliasAnnotation } from '../../cupboard/tools-discovery';

// Force lexical-only: buildQueryEmbedder resolves to null (unconfigured embedder).
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

const hiveMocks = vi.hoisted(() => ({
  potHomeSlugForHarness: vi.fn(),
}));

const pluginHostMocks = vi.hoisted(() => ({
  getPluginHost: vi.fn(),
}));

vi.mock('../../hive-federation', () => ({
  potHomeSlugForHarness: hiveMocks.potHomeSlugForHarness,
}));

vi.mock('../../plugin-host-runtime', () => ({
  getPluginHost: pluginHostMocks.getPluginHost,
}));

import toolFind, {
  boundDiscoveryHits,
  buildEmbeddingIndex,
  buildCorpus,
  compactOutputSchemaForResult,
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
    hits: Array<{
      tool: string;
      description: string | null;
      argSchema: string | null;
      returns: string | null;
      returnsSource: 'registered-output-schema' | 'authored-tool-guidance' | null;
      via: string;
    }>;
    howToCall: string;
  };
}

beforeEach(() => {
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  pluginHostMocks.getPluginHost.mockReset();
  pluginHostMocks.getPluginHost.mockResolvedValue({ loaded: [] });
});

describe('tools:find tool registration', () => {
  it('registers with the expected name + capability + args', () => {
    const def = toolFind as unknown as ToolDef;
    expect(def.name).toBe('tools:find');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    expect((def as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    expect((def as { guidance?: { notWhen?: string } }).guidance?.notWhen).toContain(
      'accepted but ignored — it never filters or narrows results',
    );
    // args schema accepts a query, rejects an empty one.
    expect(def.args.safeParse({ query: 'feature flag' }).success).toBe(true);
    expect(def.args.safeParse({ query: '' }).success).toBe(false);
    expect(def.args.safeParse({}).success).toBe(false);
  });

  it('EI-21854434860586936: accepts (and ignores) caller-supplied harness/workspace scope hints', () => {
    const def = toolFind as unknown as ToolDef;
    // Every other harness/workspace-scoped tool in the catalog accepts these
    // keys, so callers naturally pass them here too — the strict schema must
    // not reject them as unrecognized (that was the recurring caller-error).
    expect(def.args.safeParse({ query: 'feature flag', harness: 'papercusp' }).success).toBe(true);
    expect(def.args.safeParse({ query: 'feature flag', workspace: 'papercusp-workspace' }).success).toBe(true);
    expect(
      def.args.safeParse({ query: 'feature flag', harness: 'papercusp', workspace: 'papercusp-workspace' }).success,
    ).toBe(true);
    // Still rejects a genuinely unknown key.
    expect(def.args.safeParse({ query: 'feature flag', bogus: 'nope' }).success).toBe(false);
  });

  it('EI-21854434860586936: caller-supplied harness/workspace hints do not change results (accept-and-ignore)', async () => {
    const withoutHint = await callHandler({ query: 'feature flag' });
    const withHint = await callHandler({ query: 'feature flag', harness: 'some-other-harness', workspace: 'some-other-workspace' });
    expect(withHint.hits.map((h) => h.tool)).toEqual(withoutHint.hits.map((h) => h.tool));
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
  it('reuses a snapshot until the projected registry revision changes', () => {
    const first = buildCorpus();
    const second = buildCorpus();
    expect(second.corpus).toBe(first.corpus);
    expect(second.embedText).toBe(first.embedText);

    const name = 'test:tools-find-corpus-cache';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.object({ value: z.string() }),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });

    const afterRegistration = buildCorpus();
    expect(afterRegistration.corpus).not.toBe(first.corpus);
    expect(afterRegistration.corpus.some((entry) => entry.tool === name)).toBe(true);
  });

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

  it('derives return shapes from registered output schemas before authored prose', () => {
    const name = 'test:derived-return-shape';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.object({}),
      result: z.object({ actual: z.string(), count: z.number().int() }),
      guidance: { returns: '{ stale_authored_shape }' },
      handler: async () => ({ data: { actual: 'ok', count: 1 } }),
    });

    const { returnsByTool, returnSourcesByTool } = buildCorpus();
    expect(returnsByTool.get(name)).toContain('actual:string');
    expect(returnsByTool.get(name)).not.toContain('stale_authored_shape');
    expect(returnSourcesByTool.get(name)).toBe('registered-output-schema');
    expect(compactOutputSchemaForResult({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })).toContain('array{id:string}');
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

  it('keeps plans:audit auditedSha completion-only guidance in compact discovery output', () => {
    expect(plansAudit.name).toBe('plans:audit');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:audit'));

    expect(compact).toContain(
      'auditedSha?:string(7-64) Completion phase only: commit audited against; resolved from the local tree when omitted.',
    );
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

  it('annotates description- and metadata-declared aliases at the root and in array items', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'body / summary text' },
        body: { type: 'string', description: 'alias for `summary` — pass either spelling' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              canonical: { type: 'string' },
              legacy: { type: 'string', 'x-papercusp-aliases': ['canonical'] },
            },
          },
        },
      },
    };

    expect(schemaAliasAnnotation(schema)).toBe(
      'alias-group:summary|body; alias-group:items[].canonical|legacy',
    );
    const compact = compactSchemaForResult(schema);
    expect(compact).toContain('alias-group:summary|body');
    expect(compact).toContain('alias-group:items[].canonical|legacy');
  });

  it('surfaces the live work_items:create alias groups in both discovery projections', () => {
    expect(workItemsCreate.name).toBe('work_items:create');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'work_items:create');
    const compact = compactSchemaForResult(schemaByTool.get('work_items:create'));

    expect(entry?.argSchema).toContain('alias-group:summary|body');
    expect(entry?.argSchema).toContain('alias-group:items[].summary|body');
    expect(compact).toContain('alias-group:summary|body');
    expect(compact).toContain('alias-group:items[].summary|body');
  });

  it('merges every discriminated-union literal instead of advertising only the first op', () => {
    const compact = compactSchemaForResult({
      oneOf: [
        { type: 'object', required: ['op'], properties: { op: { const: 'get' }, stallReds: { type: 'integer' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'set' }, enabled: { type: 'boolean' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'hold' }, reason: { type: 'string' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'unhold' } } },
      ],
    });

    expect(compact).toContain('one-of:op;');
    expect(compact).not.toContain('one-of:op|op');
    expect(compact).toContain('op:enum(get|set|hold|unhold)');
    expect(compact).toContain('stallReds?:integer');
    expect(compact).toContain('enabled?:boolean');
    expect(compact).toContain('reason?:string');
  });

  it('keeps closed repair-queue branch conditions while retaining all CAS field shapes', () => {
    const compact = compactSchemaForResult({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: { op: { const: 'get' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'paths'],
          properties: {
            op: { const: 'admit' },
            paths: { type: 'array', maxItems: 50, items: { type: 'string' } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'paths'],
          properties: {
            op: { const: 'converge' },
            paths: { type: 'array', maxItems: 50, items: { type: 'string' } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'],
          properties: {
            op: { const: 'retire' },
            expectedCandidate: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
            expectedRepairHead: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
            expectedUpdatedAtMs: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          },
        },
      ],
    });

    expect(compact).toContain(
      'when op=retire => expectedCandidate required; when op!=retire => expectedCandidate forbidden',
    );
    expect(compact).toContain('expectedCandidate?:string~/^[0-9a-fA-F]{40,64}$/');
    expect(compact).toContain('expectedRepairHead?:string~/^[0-9a-fA-F]{40,64}$/');
    expect(compact).toContain('expectedUpdatedAtMs?:integer(0-9007199254740991)');
  });

  it('preserves explicit discriminator-dependent required and forbidden fields in compact results', () => {
    const compact = compactSchemaForResult({
      anyOf: [
        {
          required: ['kind', 'settledBy'],
          properties: { kind: { const: 'undecidable' }, settledBy: { type: 'string' } },
        },
        {
          required: ['kind'],
          properties: {
            kind: { enum: ['conclusion', 'assumption', 'convention'] },
            settledBy: { not: {} },
          },
        },
      ],
    });

    expect(compact).toContain('when kind=undecidable => settledBy required');
    expect(compact).toContain('when kind!=undecidable => settledBy forbidden');
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
    // EI-21563626901112953: the recursive verification shape is larger than
    // the nested segment budget, but its field name/type must remain visible;
    // otherwise discovery advertises only the legacy top-level coverage alias.
    // EI-21646294277891760: retain the canonical nested coverage path and its
    // residue bucket on the bounded fallback. Runtime universal-verification
    // enforcement reads completion.verification.coverage, not the legacy
    // completion.coverage sibling that follows it.
    expect(compact).toContain(
      'verification?:object{coverage?:object{population:array(≥1)<string>,checked?:array<string>,notChecked?:array<string>,notApplicable?:array<string>,residue?:array<string>}}',
    );
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('bounds a verbose nested-fields segment so nesting stays readable (EI-21490971340666010)', () => {
    const manyFields: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      manyFields[`field${i}`] = { type: 'string', description: 'x'.repeat(180) };
    }
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        observation: { type: 'object', properties: manyFields, required: ['field0'] },
        tail: { type: 'boolean' },
      },
    });

    expect(compact).toContain('tail?:boolean');
    // The nested block stays visually attachable to its parent: per-field
    // descriptions drop first, then the tail elides with an explicit marker.
    const segment = /\{(.*)\}/.exec(compact ?? '')?.[1] ?? '';
    expect(segment.length).toBeLessThanOrEqual(400);
    expect(segment).toContain('field0:string');
    expect(segment).not.toContain('xxxxxxx');
    expect(segment).toMatch(/…\+\d+$/);
  });

  it('keeps nested descriptions when a block fits the budget', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        wait: {
          type: 'object',
          properties: { max_sec: { type: 'integer', description: 'seconds' } },
          required: ['max_sec'],
        },
      },
    });
    expect(compact).toBe('wait?:object{max_sec:integer seconds}');
  });

  it('retains required shallow fields beside a wide nested field in the bounded fallback (EI-21985077629322871)', () => {
    const wideFingerprint: Record<string, unknown> = {};
    for (let i = 0; i < 24; i += 1) wideFingerprint[`field${i}`] = { type: 'string' };

    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          properties: {
            prefix: { type: 'string' },
            current: {
              type: 'object',
              required: ['supplied'],
              properties: {
                fingerprints: { type: 'array', items: { type: 'object', properties: wideFingerprint } },
                supplied: { type: 'boolean' },
              },
            },
            tail: { type: 'boolean' },
          },
        },
      },
    });

    expect(compact).toContain('current?:object{fingerprints?:array,supplied:boolean}');
    expect(compact).toContain('tail?:boolean');
  });

  it('keeps scorecards:emit rerunRecipe.current.supplied visible at the root budget (EI-21985077629322871)', () => {
    const schema = z.toJSONSchema(scorecardEmitArgs) as { properties?: Record<string, unknown> };
    const compact = compactSchemaForResult(schema);

    expect(compact).toContain('rerunRecipe?:object{');
    expect(compact).toContain('current:object{supplied:boolean}');
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
  it('waits for plugin-host readiness before snapshotting the projected registry', async () => {
    const toolName = 'test:tools-find-readiness';
    let releaseHost!: () => void;
    pluginHostMocks.getPluginHost.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHost = () => {
          defineTool({
            name: toolName,
            capability: 'test:read',
            requirePrincipal: false,
            args: z.object({}),
            handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
          });
          resolve({ loaded: [] });
        };
      }),
    );

    const pending = callHandler({ query: toolName });
    await vi.waitFor(() => expect(pluginHostMocks.getPluginHost).toHaveBeenCalledOnce());
    expect(await Promise.race([pending.then(() => true), Promise.resolve(false)])).toBe(false);

    releaseHost();
    const out = await pending;
    expect(out.hits.some((hit) => hit.tool === toolName)).toBe(true);
  });

  it('runs lexical-only when no embedder is configured, marking semantic accordingly', async () => {
    const out = await callHandler({ query: 'find tools by intent' });
    expect(out.semantic).toBe('lexical-only'); // never silently pretends semantic ran
    expect(out.registry).toEqual({
      source: 'projected-tool-registry',
      revision: expect.stringMatching(/^projected-tool-registry-v1:/),
    });
    expect(out.count).toBeGreaterThan(0);
    // every hit carries name + description + argSchema + returns + via.
    for (const h of out.hits) {
      expect(typeof h.tool).toBe('string');
      expect(h).toHaveProperty('description');
      expect(h).toHaveProperty('argSchema'); // null or a string, never missing
      expect(h).toHaveProperty('returns'); // null or a string, never missing
      expect(h).toHaveProperty('returnsSource');
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
    // tools:find now declares a result schema, so discovery must expose the
    // registered structural projection rather than its authored prose clause.
    expect(self?.returns).toContain('hits?');
    expect(self?.returnsSource).toBe('registered-output-schema');
  });

  it('returns null when a matched tool has no declared response shape', async () => {
    const { corpus, returnsByTool } = buildCorpus();
    const undeclared = corpus.find((hit) => !returnsByTool.has(hit.tool));
    expect(undeclared).toBeDefined();

    const out = await callHandler({ query: undeclared!.tool });
    const hit = out.hits.find((candidate) => candidate.tool === undeclared!.tool);
    expect(hit).toBeDefined();
    expect(hit?.returns).toBeNull();
    expect(hit?.returnsSource).toBeNull();
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
      'body?:array(1-20){text:string,premises?:array(≤20)<string>,youMayNotKnow?:array(≤20){ref:string,provenance:enum(computed|authored)},couldNotDetermine?:array(≤20){what:string,note?:string}}',
    );
    expect(compact).toContain('expects?:enum(ack|answer|action|none)');
    expect(compact).not.toContain('body?:string|');
    expect(compact).not.toContain('premises?:array|string');
    expect(compact).not.toContain('youMayNotKnow?:array|string');
    expect(compact).not.toContain('couldNotDetermine?:array|string');
    expect(compact).not.toContain('description');
  });

  it('EI-21579794371308546: live coord:send discovery identifies premises as string refs', () => {
    expect(coordSend.name).toBe('coord:send');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('coord:send'));

    expect(compact).toContain('premises?:array(≤20)<string>');
    expect(compact).toContain('forYouBecause?:object{relation');
    expect(compact).not.toContain('premises?:array(≤20){');
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
      returns: null,
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
