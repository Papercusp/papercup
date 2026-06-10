/**
 * Unit tests for the claude-loaded-index bench backend (P-012): the pure
 * index render + pick parsing, and search() against a fake inner store +
 * fake LLM (no live transport).
 */
import { describe, expect, it } from 'vitest';
import type { MemoryBackend, MemoryEntry } from '@papercusp/memory';
import type { LlmCallFn, LlmCallResult } from '@papercusp/testing-shell/llm';

import { ClaudeLoadedIndexBackend, parsePicks, renderLoadedIndex } from './loaded-index-backend';

const entries: MemoryEntry[] = [
  {
    id: 'a',
    text: 'The deploy gate drains for 120s before swap.',
    kind: 'reference',
    scope: 'bench',
    metadata: { corpus_key: 'k_deploy', description: 'Deploy gate drains 120s before swap' },
  },
  {
    id: 'b',
    text: 'Use port 31785 for staging governor probes.',
    scope: 'bench',
    metadata: { corpus_key: 'k_port', kind: 'reference' },
  },
  {
    id: 'c',
    text: 'Owner prefers terse PR titles.',
    kind: 'feedback',
    scope: 'bench',
    metadata: { corpus_key: 'k_pr', description: 'Owner prefers terse PR titles' },
  },
];

function fakeInner(list: MemoryEntry[]): MemoryBackend {
  return {
    name: 'fake',
    available: async () => ({ ok: true as const }),
    remember: async () => ({ ids: ['x'] }),
    search: async () => [],
    list: async () => list,
    get: async () => null,
    forget: async () => {},
    update: async () => {},
  };
}

function fakeLlm(reply: string): { fn: LlmCallFn; prompts: string[] } {
  const prompts: string[] = [];
  const fn: LlmCallFn = async (opts) => {
    prompts.push(`${opts.system ?? ''}\n${opts.messages.map((m) => m.content).join('\n')}`);
    return { text: reply, inputTokens: 0, outputTokens: 0, costUsd: 0, raw: {} } as LlmCallResult;
  };
  return { fn, prompts };
}

describe('renderLoadedIndex', () => {
  it('renders one hook line per entry — description when present, truncated text otherwise', () => {
    const idx = renderLoadedIndex(entries);
    expect(idx.split('\n')).toHaveLength(3);
    expect(idx).toContain('1. [reference] Deploy gate drains 120s before swap');
    // No description → falls back to the fact text; kind read from metadata.
    expect(idx).toContain('2. [reference] Use port 31785 for staging governor probes.');
  });
});

describe('parsePicks', () => {
  it('parses the {"picks": [...]} shape, 1-based, deduped, bounded', () => {
    expect(parsePicks('{"picks": [3, 1, 3, 99, 0]}', 3)).toEqual([3, 1]);
  });
  it('accepts a bare array and prose-wrapped JSON', () => {
    expect(parsePicks('Sure! [2, 1]', 3)).toEqual([2, 1]);
  });
  it('returns no picks on garbage instead of throwing', () => {
    expect(parsePicks('nothing relevant', 3)).toEqual([]);
  });
});

describe('ClaudeLoadedIndexBackend.search', () => {
  it('returns the picked entries in rank order with ordering-only scores', async () => {
    const { fn } = fakeLlm('{"picks": [3, 1]}');
    const backend = new ClaudeLoadedIndexBackend(fakeInner(entries), fn);
    const hits = await backend.search('how should I title PRs?', { scope: 'bench', limit: 5 });
    expect(hits.map((h) => h.id)).toEqual(['c', 'a']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score!);
  });

  it('shows the model the full index + the intent', async () => {
    const { fn, prompts } = fakeLlm('{"picks": []}');
    const backend = new ClaudeLoadedIndexBackend(fakeInner(entries), fn);
    await backend.search('anything', { scope: 'bench', limit: 5 });
    expect(prompts[0]).toContain('MEMORY INDEX:');
    expect(prompts[0]).toContain('Owner prefers terse PR titles');
    expect(prompts[0]).toContain('CURRENT INTENT: "anything"');
  });

  it('hard-negative discipline: an empty pick list means an empty result', async () => {
    const { fn } = fakeLlm('{"picks": []}');
    const backend = new ClaudeLoadedIndexBackend(fakeInner(entries), fn);
    expect(await backend.search('quantum basket weaving', { scope: 'bench' })).toEqual([]);
  });

  it('empty store short-circuits without an LLM call', async () => {
    let called = false;
    const llm: LlmCallFn = async () => {
      called = true;
      return { text: '', inputTokens: 0, outputTokens: 0, costUsd: 0, raw: {} } as LlmCallResult;
    };
    const backend = new ClaudeLoadedIndexBackend(fakeInner([]), llm);
    expect(await backend.search('x', { scope: 'bench' })).toEqual([]);
    expect(called).toBe(false);
  });
});
