/**
 * cache-policy.test.ts — the prompt-cache request-body rewrites
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19).
 *
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/cache-policy.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  DEFAULT_DEFER_MIN_TOOL_BYTES,
  PSU_CACHE_BOUNDARY,
  TOOL_SEARCH_BM25_TOOL,
  applyAnthropicCachePolicy,
  applyOpenAiCachePolicy,
  applyToolDeferral,
  openAiCacheGeneration,
  rewriteAnthropicCacheBody,
  rewriteOpenAiCacheBody,
  shardedCacheKey,
  splitSystemAtBoundary,
} from './cache-policy';

const cc = () => ({ type: 'ephemeral' as const });

describe('applyAnthropicCachePolicy — ttl upgrade (P-001)', () => {
  it('upgrades every ephemeral cache_control without an explicit ttl', () => {
    const body: Record<string, unknown> = {
      model: 'claude-opus-4-8',
      tools: [{ name: 'a' }, { name: 'b', cache_control: cc() }],
      system: [{ type: 'text', text: 'x', cache_control: cc() }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: cc() }] }],
    };
    const s = applyAnthropicCachePolicy(body);
    expect(s.ttlUpgraded).toBe(3);
    expect(s.changed).toBe(true);
    expect((body.tools as any)[1].cache_control.ttl).toBe('1h');
    expect((body.system as any)[0].cache_control.ttl).toBe('1h');
    expect((body.messages as any)[0].content[0].cache_control.ttl).toBe('1h');
  });

  it('respects an explicit client ttl (client intent wins) — both values', () => {
    const body: Record<string, unknown> = {
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: false });
    expect(s.ttlUpgraded).toBe(0);
    expect((body.system as any)[0].cache_control.ttl).toBe('5m');
  });

  it('upgrades the top-level automatic-caching marker too, and counts its slot', () => {
    const body: Record<string, unknown> = { cache_control: cc(), tools: [{ name: 'a' }] };
    const s = applyAnthropicCachePolicy(body);
    expect((body.cache_control as any).ttl).toBe('1h');
    expect(s.breakpointsBefore).toBe(1);
  });

  it('leaves a non-ephemeral cache_control type alone', () => {
    const body: Record<string, unknown> = { system: [{ type: 'text', cache_control: { type: 'persistent' } }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: false });
    expect(s.changed).toBe(false);
    expect((body.system as any)[0].cache_control.ttl).toBeUndefined();
  });
});

describe('applyAnthropicCachePolicy — shared tools breakpoint (P-003)', () => {
  it('injects a breakpoint on the LAST tool (the org-shared per-variant span)', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.toolsBreakpointInjected).toBe(true);
    expect((body.tools as any)[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((body.tools as any)[0].cache_control).toBeUndefined();
  });

  it('NEVER exceeds the 4-marker budget (a 5th is a 400 upstream)', () => {
    const body: Record<string, unknown> = {
      tools: [{ name: 'a' }],
      system: [
        { type: 'text', cache_control: cc() },
        { type: 'text', cache_control: cc() },
        { type: 'text', cache_control: cc() },
        { type: 'text', cache_control: cc() },
      ],
    };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.breakpointsBefore).toBe(ANTHROPIC_MAX_BREAKPOINTS);
    expect(s.toolsBreakpointInjected).toBe(false);
    expect(s.toolsBreakpointSkippedNoBudget).toBe(true);
    expect((body.tools as any)[0].cache_control).toBeUndefined();
  });

  it('does not double-mark a tools array the client already marked', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }, { name: 'b', cache_control: cc() }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.toolsBreakpointInjected).toBe(false);
    expect(s.ttlUpgraded).toBe(1);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }], system: [{ type: 'text', cache_control: cc() }] };
    applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    const second = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(second.changed).toBe(false);
  });

  it('DEFAULTS OFF — the injection is opt-in after the 2026-07-19 A/B measured it a no-op', () => {
    // Controlled A/B (proxy with vs without the injection, differing system prompts) produced
    // IDENTICAL usage: write_1h=31426, read=9724 in both arms. Zero benefit, and it caused
    // EI-16980. So an unqualified call must NOT touch tools; only an explicit opt-in does.
    const body: Record<string, unknown> = { tools: [{ name: 'a' }, { name: 'b' }] };
    const s = applyAnthropicCachePolicy(body);
    expect(s.toolsBreakpointInjected).toBe(false);
    expect((body.tools as any)[1].cache_control).toBeUndefined();
    expect(s.changed).toBe(false);
  });

  it('opt-out leaves tools untouched (ttl-only mode)', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: false });
    expect(s.toolsBreakpointInjected).toBe(false);
    expect((body.tools as any)[0].cache_control).toBeUndefined();
  });
});

describe('defer_loading × cache_control is a hard 400 — never emit the pair', () => {
  // REGRESSION (2026-07-19, live incident): the first cut marked the LAST tool unconditionally.
  // Every tool-search session (the fleet forces ENABLE_TOOL_SEARCH=true) defers most of its
  // catalog, so that landed on a deferred tool and the API rejected the whole request:
  // "Tool 'X' cannot have both defer_loading=true and cache_control set."
  const invariant = (body: Record<string, unknown>) => {
    for (const t of (body.tools as Record<string, unknown>[]) ?? []) {
      expect(Boolean(t.defer_loading) && Boolean(t.cache_control), `illegal pair on ${String(t.name)}`).toBe(false);
    }
  };

  it('marks the last NON-deferred tool when the tail is deferred', () => {
    const body: Record<string, unknown> = {
      tools: [
        { name: 'search' },
        { name: 'invoke' },
        { name: 'a', defer_loading: true },
        { name: 'b', defer_loading: true },
      ],
    };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.toolsBreakpointInjected).toBe(true);
    expect((body.tools as any)[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((body.tools as any)[3].cache_control).toBeUndefined();
    invariant(body);
  });

  it('injects NOTHING when every tool is deferred (no legal anchor exists)', () => {
    const body: Record<string, unknown> = {
      tools: [{ name: 'a', defer_loading: true }, { name: 'b', defer_loading: true }],
    };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.toolsBreakpointInjected).toBe(false);
    expect(s.toolsBreakpointSkippedAllDeferred).toBe(true);
    expect(s.changed).toBe(false);
    invariant(body);
  });

  it('treats defer_loading:false as markable (only truthy defers)', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a', defer_loading: false }] };
    applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect((body.tools as any)[0].cache_control).toBeDefined();
    invariant(body);
  });

  it('fails CLOSED on an unexpected truthy defer_loading spelling', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a', defer_loading: { mode: 'lazy' } }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: true });
    expect(s.toolsBreakpointSkippedAllDeferred).toBe(true);
    invariant(body);
  });

  it('holds through the buffer path on a realistic tool-search body', () => {
    const buf = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-4-8',
        tools: [
          { name: 'tool_search_tool_bm25' },
          ...Array.from({ length: 40 }, (_, i) => ({ name: `mcp__papercusp_su__t${i}`, defer_loading: true })),
        ],
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      }),
      'utf8',
    );
    const out = rewriteAnthropicCacheBody(buf, { injectToolsBreakpoint: true });
    const parsed = JSON.parse(out.body.toString('utf8'));
    expect(parsed.tools[0].cache_control).toBeDefined(); // the one non-deferred tool
    invariant(parsed);
  });
});

describe('rewriteAnthropicCacheBody — buffer contract', () => {
  it('returns the ORIGINAL buffer instance when nothing changed (byte-identical forward)', () => {
    const buf = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8', messages: [] }), 'utf8');
    const r = rewriteAnthropicCacheBody(buf);
    expect(r.body).toBe(buf);
  });

  it('never throws on a non-JSON or non-object body', () => {
    expect(rewriteAnthropicCacheBody(Buffer.from('not json')).stats).toBeNull();
    expect(rewriteAnthropicCacheBody(Buffer.from('[1,2]')).stats).toBeNull();
    expect(rewriteAnthropicCacheBody(Buffer.alloc(0)).stats).toBeNull();
  });

  it('round-trips a rewritten body as valid JSON', () => {
    const buf = Buffer.from(JSON.stringify({ tools: [{ name: 'a' }] }), 'utf8');
    const r = rewriteAnthropicCacheBody(buf, { injectToolsBreakpoint: true });
    expect(JSON.parse(r.body.toString('utf8')).tools[0].cache_control.ttl).toBe('1h');
  });
});

describe('splitSystemAtBoundary — stable/volatile split (P-004, MEASURED +66k shared/session)', () => {
  const boundary = PSU_CACHE_BOUNDARY;
  /** Content is never lost or reordered: the halves must concatenate to the original minus sentinel. */
  const concatEquals = (out: any[], original: string) => {
    const joined = out.map((b) => b.text).join('');
    expect(joined).toBe(original.replace(boundary, ''));
  };

  it('splits the block at the sentinel, moves cache_control to the STABLE half, drops the sentinel', () => {
    const original = `CLAUDE BASE + stable playbook${boundary}per-session launch context`;
    const system = [{ type: 'text', text: original, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    const r = splitSystemAtBoundary(system);
    expect(r.split).toBe(true);
    expect(r.system).toHaveLength(2);
    expect((r.system as any)[0].text).toBe('CLAUDE BASE + stable playbook');
    expect((r.system as any)[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect((r.system as any)[1].text).toBe('per-session launch context');
    expect((r.system as any)[1].cache_control).toBeUndefined();
    concatEquals(r.system as any[], original);
  });

  it('is budget-NEUTRAL when the block already had a marker (move, not add)', () => {
    const system = [
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `stable${boundary}tail`, cache_control: { type: 'ephemeral' } },
    ];
    const before = system.filter((b) => b.cache_control).length;
    const r = splitSystemAtBoundary(system);
    const after = (r.system as any[]).filter((b) => b.cache_control).length;
    expect(before).toBe(after); // 2 → 2, no new breakpoint
  });

  it('adds a marker only when the block had none AND the 4-budget has room', () => {
    const system = [{ type: 'text', text: `stable${boundary}tail` }];
    const r = splitSystemAtBoundary(system);
    expect((r.system as any)[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('REFUSES to add a marker that would exceed the 4-cap (no budget → no-op)', () => {
    const system = [
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `stable${boundary}tail` }, // no marker; adding one would be the 5th
    ];
    const r = splitSystemAtBoundary(system);
    expect(r.split).toBe(false);
    expect(r.system).toBeNull();
  });

  it('no-ops safely when there is no sentinel, no array, or the stable half is empty', () => {
    expect(splitSystemAtBoundary([{ type: 'text', text: 'no sentinel here' }]).split).toBe(false);
    expect(splitSystemAtBoundary('a string system').split).toBe(false);
    expect(splitSystemAtBoundary(undefined).split).toBe(false);
    // sentinel at the very start → nothing stable before it
    expect(splitSystemAtBoundary([{ type: 'text', text: `${boundary}only tail` }]).split).toBe(false);
  });

  it('handles a sentinel at the very END (no volatile tail block emitted)', () => {
    const r = splitSystemAtBoundary([{ type: 'text', text: `stable body${boundary}` }]);
    expect(r.split).toBe(true);
    expect(r.system).toHaveLength(1);
    expect((r.system as any)[0].text).toBe('stable body');
  });

  it('through the buffer path: split + ttl upgrade compose, and the sentinel never reaches the wire', () => {
    const original = `${'stable '.repeat(20)}${boundary}launch ctx`;
    const buf = Buffer.from(JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: original }] }), 'utf8');
    const out = rewriteAnthropicCacheBody(buf, { splitBoundary: true });
    const parsed = JSON.parse(out.body.toString('utf8'));
    expect(parsed.system).toHaveLength(2);
    expect(parsed.system[0].cache_control.ttl).toBe('1h'); // stable half cached at 1h
    expect(JSON.stringify(parsed)).not.toContain(boundary); // sentinel dropped
    expect(out.stats?.boundarySplit).toBe(true);
  });

  it('buffer path is a clean no-op (original buffer) when splitBoundary is off', () => {
    const buf = Buffer.from(JSON.stringify({ model: 'x', system: [{ type: 'text', text: `a${boundary}b` }] }), 'utf8');
    const out = rewriteAnthropicCacheBody(buf, { splitBoundary: false, injectToolsBreakpoint: false });
    expect(out.body).toBe(buf);
  });
});

describe('openAiCacheGeneration (D-004 — the param families are NOT interchangeable)', () => {
  it('classifies gpt-5.6+ as modern', () => {
    expect(openAiCacheGeneration('gpt-5.6')).toBe('modern');
    expect(openAiCacheGeneration('gpt-5.6-codex')).toBe('modern');
    expect(openAiCacheGeneration('gpt-6')).toBe('modern');
    expect(openAiCacheGeneration('gpt-5.7-mini')).toBe('modern');
  });

  it('classifies gpt-5.5 and earlier as legacy', () => {
    expect(openAiCacheGeneration('gpt-5.5')).toBe('legacy');
    expect(openAiCacheGeneration('gpt-5.1')).toBe('legacy');
    expect(openAiCacheGeneration('gpt-5')).toBe('legacy');
    expect(openAiCacheGeneration('gpt-4.1')).toBe('legacy');
    expect(openAiCacheGeneration('gpt-4o')).toBe('legacy');
  });

  it('falls back to legacy for unknown/absent ids (the wider-supported pair)', () => {
    expect(openAiCacheGeneration(undefined)).toBe('legacy');
    expect(openAiCacheGeneration('o3-mini')).toBe('legacy');
  });
});

describe('applyOpenAiCachePolicy (P-005/P-008)', () => {
  it('legacy models get 24h retention (writes are free there)', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.1' };
    const s = applyOpenAiCachePolicy(body);
    expect(s.generation).toBe('legacy');
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body.prompt_cache_options).toBeUndefined();
  });

  it('modern models get prompt_cache_options.ttl and NEVER the legacy retention param', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.6-codex' };
    const s = applyOpenAiCachePolicy(body);
    expect(s.generation).toBe('modern');
    expect(body.prompt_cache_options).toEqual({ ttl: '30m' });
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it('sets prompt_cache_key only when the client omitted it', () => {
    const a: Record<string, unknown> = { model: 'gpt-5.1' };
    applyOpenAiCachePolicy(a, { cacheKey: 'trimmed-2' });
    expect(a.prompt_cache_key).toBe('trimmed-2');

    const b: Record<string, unknown> = { model: 'gpt-5.1', prompt_cache_key: 'client-key' };
    const s = applyOpenAiCachePolicy(b, { cacheKey: 'trimmed-2' });
    expect(b.prompt_cache_key).toBe('client-key');
    expect(s.cacheKeySet).toBe(false);
  });

  it('can omit provider-unsupported retention controls while keeping cache-key affinity', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.6-terra' };
    const s = applyOpenAiCachePolicy(body, { cacheKey: 'psu-1', injectRetention: false });
    expect(body.prompt_cache_options).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.prompt_cache_key).toBe('psu-1');
    expect(s).toMatchObject({ changed: true, ttlSet: false, retentionSet: false, cacheKeySet: true });
  });

  it('is idempotent', () => {
    const body: Record<string, unknown> = { model: 'gpt-5.6' };
    applyOpenAiCachePolicy(body, { cacheKey: 'k-0' });
    expect(applyOpenAiCachePolicy(body, { cacheKey: 'k-0' }).changed).toBe(false);
  });

  it('rewriteOpenAiCacheBody keeps the original buffer on a no-op and never throws', () => {
    const buf = Buffer.from(JSON.stringify({ model: 'gpt-5.1', prompt_cache_retention: '24h' }), 'utf8');
    expect(rewriteOpenAiCacheBody(buf).body).toBe(buf);
    expect(rewriteOpenAiCacheBody(Buffer.from('{oops')).stats).toBeNull();
  });
});

describe('shardedCacheKey (the ~15 req/min-per-key sharding limit)', () => {
  it('is stable for the same session and bounded by the shard count', () => {
    const a = shardedCacheKey('trimmed', 'su-abc', 4);
    expect(shardedCacheKey('trimmed', 'su-abc', 4)).toBe(a);
    expect(Number(a.split('-').pop())).toBeLessThan(4);
  });

  it('spreads distinct sessions across buckets', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(shardedCacheKey('trimmed', `su-${i}`, 4));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('collapses to a single bucket when shards <= 1 (max sharing)', () => {
    expect(shardedCacheKey('full', 'su-x', 1)).toBe('full-0');
    expect(shardedCacheKey('full', 'su-y', 0)).toBe('full-0');
  });
});

// ── P-002: per-tool defer_loading (agent-launch-context-cost-2026-09-18) ─────

/** A client tool whose serialized form exceeds `bytes`. */
const bigTool = (name: string, bytes = 12_000): Record<string, unknown> => ({
  name,
  description: 'x'.repeat(bytes),
  input_schema: { type: 'object', properties: {} },
});

/** A client tool comfortably under the default 8,000 B threshold. */
const smallTool = (name: string): Record<string, unknown> => ({
  name,
  description: 'small',
  input_schema: { type: 'object', properties: {} },
});

/** The one pairing that is a hard API 400 (EI-16980), asserted on EVERY tool in the body. */
const noIllegalPair = (body: Record<string, unknown>) => {
  for (const t of (body.tools as Record<string, unknown>[]) ?? []) {
    expect(
      Boolean(t.defer_loading) && Boolean(t.cache_control),
      `illegal defer_loading+cache_control pair on ${String(t.name)}`,
    ).toBe(false);
  }
};

/** The API rejects a body in which every tool is deferred. */
const someToolNonDeferred = (body: Record<string, unknown>) => {
  const tools = (body.tools as Record<string, unknown>[]) ?? [];
  if (tools.length === 0) return;
  expect(
    tools.some((t) => !t.defer_loading),
    'all tools deferred — API 400 "All tools have defer_loading set"',
  ).toBe(true);
};

/** A deferred tool is unreachable unless a tool-search tool is in the body. */
const deferredToolsReachable = (body: Record<string, unknown>) => {
  const tools = (body.tools as Record<string, unknown>[]) ?? [];
  if (!tools.some((t) => t.defer_loading)) return;
  expect(
    tools.some(
      (t) =>
        String(t.type ?? '').startsWith('tool_search_tool_') ||
        String(t.name ?? '').startsWith('tool_search_tool_'),
    ),
    'deferred tools present with no tool-search tool — schemas are UNREACHABLE',
  ).toBe(true);
};

const allInvariants = (body: Record<string, unknown>) => {
  noIllegalPair(body);
  someToolNonDeferred(body);
  deferredToolsReachable(body);
};

describe('the invariant helpers are FALSIFIABLE (controls — do not delete)', () => {
  // Every assertion below this point runs `allInvariants` over a body the real code produced,
  // and a helper that cannot fail would make all of them vacuous while looking thorough. These
  // three controls hand each helper a hand-built VIOLATING body and require it to reject.
  // They are the permanent, zero-risk form of a mutation probe: no tree mutation, no restore
  // step, nothing for a git-sync sweep to commit half-done.
  it('noIllegalPair REJECTS a defer_loading + cache_control pair', () => {
    expect(() =>
      noIllegalPair({ tools: [{ name: 'x', defer_loading: true, cache_control: { type: 'ephemeral' } }] }),
    ).toThrow();
  });

  it('someToolNonDeferred REJECTS an all-deferred body', () => {
    expect(() =>
      someToolNonDeferred({ tools: [{ name: 'a', defer_loading: true }, { name: 'b', defer_loading: true }] }),
    ).toThrow();
  });

  it('deferredToolsReachable REJECTS deferred tools with no search tool', () => {
    expect(() =>
      deferredToolsReachable({ tools: [{ name: 'a' }, { name: 'b', defer_loading: true }] }),
    ).toThrow();
  });

  it('...and each helper ACCEPTS the corresponding legal body (calibration)', () => {
    // Without this, a helper that threw unconditionally would also pass the three tests above.
    const legal = {
      tools: [
        { name: 'a' },
        { name: 'b', defer_loading: true },
        { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
      ],
    };
    expect(() => allInvariants(legal)).not.toThrow();
  });
});

describe('applyToolDeferral — the three hard invariants', () => {
  it('NEVER pairs defer_loading with a client cache_control (EI-16980 hard 400)', () => {
    // Claude Code marks a tool itself, so a body arriving here already carries one. Deferring
    // THAT tool is the exact pairing that took every affected session down. The tool is skipped,
    // not stripped: stripping would discard the client's own caching intent to serve ours.
    const marked = bigTool('already-cached');
    marked.cache_control = { type: 'ephemeral' };
    const body: Record<string, unknown> = { tools: [marked, bigTool('other'), smallTool('keep')] };

    const s = applyToolDeferral(body);

    expect(marked.defer_loading).toBeUndefined();
    expect(s.skippedCacheControl).toBe(1);
    expect((body.tools as any)[1].defer_loading).toBe(true);
    allInvariants(body);
  });

  it('NEVER defers every tool — holds the smallest candidate back', () => {
    // API 400: "All tools have defer_loading set". Two large tools and nothing else means the
    // naive pass defers both.
    const body: Record<string, unknown> = {
      tools: [bigTool('big-a', 20_000), bigTool('big-b', 12_000)],
    };

    const s = applyToolDeferral(body);

    expect(s.heldBackToKeepNonDeferred).toBe(true);
    expect(s.toolsDeferred).toBe(1);
    // The SMALLEST candidate is the one held back: deferring it buys the least.
    expect((body.tools as any)[1].defer_loading).toBeUndefined();
    expect((body.tools as any)[0].defer_loading).toBe(true);
    allInvariants(body);
  });

  it('NEVER defers a single-tool body', () => {
    const body: Record<string, unknown> = { tools: [bigTool('only', 40_000)] };
    const s = applyToolDeferral(body);
    expect(s.toolsDeferred).toBe(0);
    expect((body.tools as any)[0].defer_loading).toBeUndefined();
    allInvariants(body);
  });

  it('NEVER defers the tool-search tool itself', () => {
    const search = { ...TOOL_SEARCH_BM25_TOOL, description: 'x'.repeat(30_000) };
    const body: Record<string, unknown> = {
      tools: [search, bigTool('a'), bigTool('b'), smallTool('keep')],
    };
    applyToolDeferral(body);
    expect((body.tools as any)[0].defer_loading).toBeUndefined();
    allInvariants(body);
  });
});

describe('applyToolDeferral — reachability', () => {
  it('injects the BM25 search tool with the exact documented wire shape', () => {
    const body: Record<string, unknown> = {
      tools: [bigTool('a'), bigTool('b'), smallTool('keep')],
    };
    const s = applyToolDeferral(body);

    expect(s.searchToolInjected).toBe(true);
    const injected = (body.tools as any).at(-1);
    // The exact strings from the Server Tools reference. A wrong `type` is a 400 on every
    // request, so it is pinned literally rather than derived.
    expect(injected).toEqual({
      type: 'tool_search_tool_bm25_20251119',
      name: 'tool_search_tool_bm25',
    });
    allInvariants(body);
  });

  it('appends rather than prepends, preserving the shared cache prefix', () => {
    const body: Record<string, unknown> = {
      tools: [bigTool('a'), bigTool('b'), smallTool('keep')],
    };
    applyToolDeferral(body);
    expect((body.tools as any)[0].name).toBe('a');
    expect((body.tools as any).length).toBe(4);
  });

  it('does not double-inject when a search tool is already present', () => {
    const body: Record<string, unknown> = {
      tools: [{ ...TOOL_SEARCH_BM25_TOOL }, bigTool('a'), bigTool('b'), smallTool('keep')],
    };
    const s = applyToolDeferral(body);
    expect(s.searchToolInjected).toBe(false);
    expect(
      (body.tools as any).filter((t: any) => String(t.name).startsWith('tool_search_tool_')).length,
    ).toBe(1);
    allInvariants(body);
  });

  it('recognises the REGEX search variant as satisfying reachability', () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        bigTool('a'),
        bigTool('b'),
        smallTool('keep'),
      ],
    };
    const s = applyToolDeferral(body);
    expect(s.searchToolInjected).toBe(false);
    allInvariants(body);
  });

  it('injects a search tool for tools the CLIENT deferred, which would otherwise be unreachable', () => {
    // psu denies native ToolSearch, so a body can arrive with deferred tools and no way to
    // reach them. Deferring nothing ourselves is not a reason to leave that broken.
    const body: Record<string, unknown> = {
      tools: [smallTool('keep'), { ...smallTool('deferred'), defer_loading: true }],
    };
    const s = applyToolDeferral(body);
    expect(s.toolsDeferred).toBe(0);
    expect(s.searchToolInjected).toBe(true);
    allInvariants(body);
  });

  it('injects NOTHING when no tool is deferred', () => {
    const body: Record<string, unknown> = { tools: [smallTool('a'), smallTool('b')] };
    const s = applyToolDeferral(body);
    expect(s.searchToolInjected).toBe(false);
    expect((body.tools as any).length).toBe(2);
  });
});

describe('applyToolDeferral — selection', () => {
  it('defers only tools above the byte threshold', () => {
    const body: Record<string, unknown> = {
      tools: [bigTool('big', 20_000), smallTool('small'), smallTool('other')],
    };
    const s = applyToolDeferral(body);
    expect(s.toolsDeferred).toBe(1);
    expect(s.toolsDeferredBytes).toBeGreaterThan(20_000);
    expect((body.tools as any)[0].defer_loading).toBe(true);
    expect((body.tools as any)[1].defer_loading).toBeUndefined();
  });

  it('pins the MEASURED default threshold (D-002) — a regression here is a silent 3% no-op', () => {
    // 1200 came from a live both-arms A/B, not from taste: the previous 8000 (derived from the
    // 895-tool CATALOG rather than a ~119-tool SESSION) measured −3.3% where 1200 measured
    // −31.9%. The failure mode this guards is the worst kind — the feature still reads as
    // ENABLED in config while doing essentially nothing.
    expect(DEFAULT_DEFER_MIN_TOOL_BYTES).toBe(1200);

    // ...and the behavioural consequence, so the constant cannot be bypassed by a caller default:
    // a mid-sized tool (~2 KB) that 8000 would have MISSED is deferred under the shipped default.
    const midTool = {
      name: 'mid',
      description: 'y'.repeat(2_000),
      input_schema: { type: 'object', properties: {} },
    };
    const body: Record<string, unknown> = { tools: [midTool, smallTool('keep'), smallTool('k2')] };
    expect(applyToolDeferral(body).toolsDeferred).toBe(1);
    expect((body.tools as any)[0].defer_loading).toBe(true);
  });

  it('honours a custom threshold', () => {
    const mk = () => ({
      tools: [bigTool('a', 3_000), bigTool('b', 3_000), smallTool('keep')],
    });
    expect(applyToolDeferral(mk(), { minToolBytes: 50_000 }).toolsDeferred).toBe(0);
    expect(applyToolDeferral(mk(), { minToolBytes: 1_000 }).toolsDeferred).toBe(2);
  });

  it('leaves SERVER tools alone (declared by type, no input_schema)', () => {
    const body: Record<string, unknown> = {
      tools: [
        { type: 'code_execution_20260521', name: 'code_execution', note: 'x'.repeat(20_000) },
        bigTool('a'),
        bigTool('b'),
        smallTool('keep'),
      ],
    };
    applyToolDeferral(body);
    expect((body.tools as any)[0].defer_loading).toBeUndefined();
    allInvariants(body);
  });

  it('is a no-op on an absent, empty or non-array tools field', () => {
    for (const tools of [undefined, [], 'nope', 42]) {
      const body: Record<string, unknown> = tools === undefined ? {} : { tools };
      const s = applyToolDeferral(body);
      expect(s.toolsDeferred).toBe(0);
      expect(s.searchToolInjected).toBe(false);
    }
  });

  it('is IDEMPOTENT — a second pass changes nothing', () => {
    const body: Record<string, unknown> = {
      tools: [bigTool('a'), bigTool('b'), smallTool('keep')],
    };
    applyToolDeferral(body);
    const after = JSON.stringify(body);
    const second = applyToolDeferral(body);
    expect(second.toolsDeferred).toBe(0);
    expect(second.searchToolInjected).toBe(false);
    expect(JSON.stringify(body)).toBe(after);
    allInvariants(body);
  });
});

describe('applyAnthropicCachePolicy — deferral is OFF by default and ordered before anchoring', () => {
  it('does NOTHING unless deferLargeTools is explicitly true', () => {
    // The gateway sits on EVERY session's inference path. Default-off is the whole safety story.
    const body: Record<string, unknown> = { tools: [bigTool('a'), bigTool('b'), smallTool('k')] };
    const s = applyAnthropicCachePolicy(body);
    expect(s.toolDeferral).toBeUndefined();
    expect((body.tools as any)[0].defer_loading).toBeUndefined();
    expect((body.tools as any).length).toBe(3);
  });

  it('reports a pass that ran but deferred nothing DISTINCTLY from a pass that never ran', () => {
    const body: Record<string, unknown> = { tools: [smallTool('a'), smallTool('b')] };
    const s = applyAnthropicCachePolicy(body, { deferLargeTools: true });
    expect(s.toolDeferral).toEqual({
      toolsDeferred: 0,
      toolsDeferredBytes: 0,
      searchToolInjected: false,
      skippedCacheControl: 0,
      heldBackToKeepNonDeferred: false,
    });
  });

  it('never anchors the cache breakpoint on a tool it just deferred', () => {
    // The ordering bug this guards: anchor first, defer second, and the anchored tool becomes
    // a deferred tool carrying cache_control — the EI-16980 400.
    const body: Record<string, unknown> = {
      tools: [smallTool('keep'), bigTool('big-a'), bigTool('big-b')],
    };
    const s = applyAnthropicCachePolicy(body, {
      deferLargeTools: true,
      injectToolsBreakpoint: true,
    });
    expect(s.toolDeferral!.toolsDeferred).toBe(2);
    expect(s.toolsBreakpointInjected).toBe(true);
    expect((body.tools as any)[0].cache_control).toBeDefined();
    allInvariants(body);
  });

  it('never anchors the breakpoint on the INJECTED search tool', () => {
    // The search tool is appended last, so a naive "mark the last non-deferred tool" would land
    // on it. cache_control on a server tool is unvalidated here; keep the anchor on a client tool.
    const body: Record<string, unknown> = {
      tools: [smallTool('keep'), bigTool('big-a'), bigTool('big-b')],
    };
    applyAnthropicCachePolicy(body, { deferLargeTools: true, injectToolsBreakpoint: true });
    const injected = (body.tools as any).at(-1);
    expect(injected.type).toBe('tool_search_tool_bm25_20251119');
    expect(injected.cache_control).toBeUndefined();
    allInvariants(body);
  });

  it('holds through the buffer path, producing a legal body end to end', () => {
    const buf = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-5',
        tools: [
          smallTool('keep'),
          ...Array.from({ length: 20 }, (_, i) => bigTool(`mcp__papercusp_su__t${i}`)),
        ],
        system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      }),
      'utf8',
    );
    const out = rewriteAnthropicCacheBody(buf, {
      deferLargeTools: true,
      injectToolsBreakpoint: true,
    });
    const parsed = JSON.parse(out.body.toString('utf8'));

    expect(out.stats!.toolDeferral!.toolsDeferred).toBe(20);
    expect(out.stats!.toolDeferral!.searchToolInjected).toBe(true);
    allInvariants(parsed);
    // The point of the exercise: the deferred schemas are the bulk of the payload.
    expect(out.stats!.toolDeferral!.toolsDeferredBytes).toBeGreaterThan(200_000);
  });

  it('leaves the buffer byte-identical when deferral is off and nothing else changed', () => {
    const buf = Buffer.from(JSON.stringify({ tools: [bigTool('a'), bigTool('b')] }), 'utf8');
    expect(rewriteAnthropicCacheBody(buf).body).toBe(buf);
  });
});
