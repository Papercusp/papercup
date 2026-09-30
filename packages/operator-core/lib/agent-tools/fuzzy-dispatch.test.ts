/**
 * fuzzy-dispatch seam (plan fuzzy-tool-name-resolution-2026-07-02, P-007 / D-008).
 * The wrapper is dependency-injected, so it is exercised here with a fake inner handler and a
 * fake resolver — no MCP host involved.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedMcpName } from '@papercusp/agent-mcp';
import {
  annotateFuzzyResult,
  fuzzyNote,
  refusedResolutionNote,
  withFuzzyToolName,
  type FuzzyDispatchDeps,
  type FuzzyResolutionRecord,
  type ToolCallResultLike,
} from './fuzzy-dispatch';

type Req = { params: { name: string; arguments?: unknown } };

const ok = (text = '{"ok":true}'): ToolCallResultLike => ({ content: [{ type: 'text', text }] });
const err = (text = 'unknown_tool'): ToolCallResultLike => ({ content: [{ type: 'text', text }], isError: true });

function resolved(partial: Partial<ResolvedMcpName>): ResolvedMcpName {
  return {
    tool: undefined,
    resolvedName: undefined,
    via: 'none',
    distance: undefined,
    alternatives: [],
    ambiguous: false,
    blocked: false,
    ...partial,
  } as unknown as ResolvedMcpName;
}

function harness(over: Partial<FuzzyDispatchDeps> & { resolveResult?: ResolvedMcpName; registered?: string[] } = {}) {
  const records: FuzzyResolutionRecord[] = [];
  const registered = new Set(over.registered ?? ['coord:declare-intent']);
  const deps: FuzzyDispatchDeps = {
    lookup: (n) => (registered.has(n) ? {} : undefined),
    resolve: vi.fn(async () => over.resolveResult ?? resolved({})),
    transport: 'mcp',
    modelOf: () => 'weak-model',
    tierOf: () => 'low',
    record: async (rec) => {
      records.push(rec);
    },
    ...over,
  };
  return { deps, records };
}

describe('fuzzyNote / annotateFuzzyResult (D-008 — never silent)', () => {
  it('renders the exact annotation text', () => {
    expect(fuzzyNote('coord:declare-intnt', 'coord:declare-intent', 1)).toBe(
      'note: interpreted "coord:declare-intnt" as "coord:declare-intent" (distance 1)',
    );
  });

  it('appends a second text block and _meta without touching content[0] or the input', () => {
    const original = ok('{"a":1}');
    const out = annotateFuzzyResult(original, { input: 'x', resolvedName: 'y', distance: 2 });
    expect(out.content[0]).toEqual({ type: 'text', text: '{"a":1}' });
    expect(out.content).toHaveLength(2);
    expect(String((out.content[1] as { text: string }).text)).toContain('interpreted "x" as "y"');
    expect(out._meta).toMatchObject({ fuzzyResolution: { in: 'x', out: 'y', distance: 2 } });
    expect(original.content).toHaveLength(1);
  });
});

describe('withFuzzyToolName', () => {
  it('exact registered name: untouched fast path — no resolve, no record, no annotation', async () => {
    const { deps, records } = harness();
    const inner = vi.fn(async (_req: Req) => ok());
    const res = await withFuzzyToolName(inner, deps)({ params: { name: 'coord:declare-intent' } }, {});
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(res.content).toHaveLength(1);
    expect(inner.mock.calls[0]![0].params.name).toBe('coord:declare-intent');
  });

  it('fuzzy resolution: rewrites the name for the inner handler, annotates, and records telemetry', async () => {
    const { deps, records } = harness({
      resolveResult: resolved({
        tool: {} as never,
        resolvedName: 'coord:declare-intent',
        via: 'fuzzy',
        distance: 1,
      }),
    });
    const inner = vi.fn(async (_req: Req) => ok());
    const res = await withFuzzyToolName(inner, deps)({ params: { name: 'coord:declare-intnt' } }, {});
    expect(inner.mock.calls[0]![0].params.name).toBe('coord:declare-intent');
    expect(res.content).toHaveLength(2);
    expect(String((res.content[1] as { text: string }).text)).toContain('interpreted "coord:declare-intnt"');
    expect(records).toEqual([
      expect.objectContaining({
        in: 'coord:declare-intnt',
        out: 'coord:declare-intent',
        distance: 1,
        transport: 'mcp',
        model: 'weak-model',
        tier: 'low',
        outcome: 'resolved',
      }),
    ]);
  });

  it('canonical-only recovery (separator/case): rewrites and records but does NOT annotate', async () => {
    const { deps, records } = harness({
      resolveResult: resolved({ tool: {} as never, resolvedName: 'coord:declare-intent', via: 'canonical', distance: 0 }),
    });
    const inner = vi.fn(async (_req: Req) => ok());
    const res = await withFuzzyToolName(inner, deps)({ params: { name: 'coord_declare_intent' } }, {});
    expect(inner.mock.calls[0]![0].params.name).toBe('coord:declare-intent');
    expect(res.content).toHaveLength(1);
    expect(records[0]!.outcome).toBe('canonical');
  });

  it('ambiguous: inner runs with the ORIGINAL name; an error reply gains a did-you-mean note; telemetry records it', async () => {
    const { deps, records } = harness({
      resolveResult: resolved({ ambiguous: true, alternatives: ['flags:get', 'flags:set'] }),
    });
    const inner = vi.fn(async (_req: Req) => err());
    const res = await withFuzzyToolName(inner, deps)({ params: { name: 'flags:xet' } }, {});
    expect(inner.mock.calls[0]![0].params.name).toBe('flags:xet');
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(2);
    expect(String((res.content[1] as { text: string }).text)).toContain('flags:get, flags:set');
    expect(records[0]).toMatchObject({ outcome: 'ambiguous', alternatives: ['flags:get', 'flags:set'] });
  });

  it('blocked (D-007 write-tier): never rewritten; note names the mutating candidate', async () => {
    const { deps, records } = harness({
      resolveResult: resolved({ blocked: true, resolvedName: 'flags:set', alternatives: ['flags:set'], distance: 1 }),
    });
    const inner = vi.fn(async (_req: Req) => err());
    const res = await withFuzzyToolName(inner, deps)({ params: { name: 'flags:sett' } }, {});
    expect(inner.mock.calls[0]![0].params.name).toBe('flags:sett');
    expect(String((res.content[1] as { text: string }).text)).toContain('mutating tool');
    expect(records[0]!.outcome).toBe('blocked');
  });

  it('skipped names (plugin-namespaced) go straight to the inner handler', async () => {
    const { deps, records } = harness({ skip: (n) => n.includes('.') });
    const inner = vi.fn(async (_req: Req) => err());
    await withFuzzyToolName(inner, deps)({ params: { name: 'repomix.pak' } }, {});
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(inner.mock.calls[0]![0].params.name).toBe('repomix.pak');
  });

  it('a throwing resolver or throwing telemetry sink never changes the reply', async () => {
    const boom = harness({ resolve: vi.fn(async () => { throw new Error('resolver down'); }) });
    const res1 = await withFuzzyToolName(async (_r: Req) => err(), boom.deps)({ params: { name: 'nope' } }, {});
    expect(res1.content).toHaveLength(1);

    const sinkDown = harness({
      record: async () => { throw new Error('pg down'); },
      resolveResult: resolved({ tool: {} as never, resolvedName: 'coord:declare-intent', via: 'fuzzy', distance: 1 }),
    });
    const res2 = await withFuzzyToolName(async (_r: Req) => ok(), sinkDown.deps)({ params: { name: 'coord:declare-intnt' } }, {});
    expect(res2.isError).toBeUndefined();
    expect(res2.content).toHaveLength(2);
  });

  it('a successful reply to an ambiguous name is not decorated', async () => {
    const { deps } = harness({ resolveResult: resolved({ ambiguous: true, alternatives: ['a', 'b'] }) });
    const res = await withFuzzyToolName(async (_r: Req) => ok(), deps)({ params: { name: 'zz' } }, {});
    expect(res.content).toHaveLength(1);
  });
});

describe('refusedResolutionNote', () => {
  const base = { in: 'x', out: null, distance: null, transport: 'mcp', model: null, tier: null } as const;
  it('is null when there is nothing to suggest', () => {
    expect(refusedResolutionNote({ ...base, outcome: 'ambiguous', alternatives: [] })).toBeNull();
    expect(refusedResolutionNote({ ...base, outcome: 'resolved', alternatives: ['a'] })).toBeNull();
  });
});
