/**
 * cache-policy.test.ts — the prompt-cache request-body rewrites
 * (gateway-cache-plane-shared-prefix-ttl-2026-07-19).
 *
 * Run: cd packages/operator-core && npx vitest run lib/inference-gateway/cache-policy.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  applyAnthropicCachePolicy,
  applyOpenAiCachePolicy,
  openAiCacheGeneration,
  rewriteAnthropicCacheBody,
  rewriteOpenAiCacheBody,
  shardedCacheKey,
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
    const s = applyAnthropicCachePolicy(body);
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
    const s = applyAnthropicCachePolicy(body);
    expect(s.breakpointsBefore).toBe(ANTHROPIC_MAX_BREAKPOINTS);
    expect(s.toolsBreakpointInjected).toBe(false);
    expect(s.toolsBreakpointSkippedNoBudget).toBe(true);
    expect((body.tools as any)[0].cache_control).toBeUndefined();
  });

  it('does not double-mark a tools array the client already marked', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }, { name: 'b', cache_control: cc() }] };
    const s = applyAnthropicCachePolicy(body);
    expect(s.toolsBreakpointInjected).toBe(false);
    expect(s.ttlUpgraded).toBe(1);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }], system: [{ type: 'text', cache_control: cc() }] };
    applyAnthropicCachePolicy(body);
    const second = applyAnthropicCachePolicy(body);
    expect(second.changed).toBe(false);
  });

  it('opt-out leaves tools untouched (ttl-only mode)', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'a' }] };
    const s = applyAnthropicCachePolicy(body, { injectToolsBreakpoint: false });
    expect(s.toolsBreakpointInjected).toBe(false);
    expect((body.tools as any)[0].cache_control).toBeUndefined();
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
    const r = rewriteAnthropicCacheBody(buf);
    expect(JSON.parse(r.body.toString('utf8')).tools[0].cache_control.ttl).toBe('1h');
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
