/**
 * cache-policy.test.ts — the prompt-cache request-body rewrites
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19).
 *
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/cache-policy.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  PSU_CACHE_BOUNDARY,
  applyAnthropicCachePolicy,
  applyOpenAiCachePolicy,
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
