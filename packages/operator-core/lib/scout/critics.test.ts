/**
 * Tests for the P-005 critics (D-005). Self-contained: a tiny local fake
 * ScoutLlmCall + local Idea fixtures, so this verifies the critic LOGIC
 * independent of the (actively-evolving) shared test-support harness. The
 * load-bearing invariant pinned here: SEARCH-FIRST novelty is a CEILING — an
 * already-present idea is rejected even when the LLM critic claims it's novel.
 */
import { describe, it, expect } from 'vitest';
import type { Idea, ScoutLlmCall } from './types';
import { buildCriticPrompt, critiqueIdea, critiqueIdeas, DEFAULT_CRITIC_MISSION, runCritic } from './critics';
import type { CorpusEntry } from './critique-core';
import { PROSE_VECTOR_DIMS } from '../search/prose-vector-dims';
import { callScoutPhaseLlm } from './llm-deadline';

describe('buffered transport deadline diagnostics', () => {
  it.each([false, true])('does not infer capacity or generation from missing response telemetry (admitted=%s)', async (admitted) => {
    let signal: AbortSignal | undefined;
    const call = callScoutPhaseLlm({
      phase: 'review',
      input: { model: 'gpt-5.6-sol:xhigh', messages: [{ role: 'user', content: 'review' }] },
      timeoutMs: 100,
      cycleDeadlineMs: Date.now() + 5_025,
      llmCall: async (input) => {
        signal = input.signal;
        if (admitted) input.onAdmitted?.();
        // A buffered HTTP response may be generating without exposing either hook.
        return new Promise<never>(() => {});
      },
    });
    const error = await call.then(() => '', (e: Error) => e.message);
    expect(signal?.aborted).toBe(true);
    expect(error).toContain('queueing versus generation unknown');
    expect(error).not.toMatch(/never admitted|no capacity|not generation|ms of GENERATION/);
  });
});

function idea(over: Partial<Idea> = {}): Idea {
  return {
    id: 'i1',
    lens: 'first-principles',
    title: 'a genuinely fresh mechanism',
    body: 'something the hive has not considered',
    mechanism: 'do the new thing',
    addressesPatternRefs: [],
    ...over,
  };
}

/** A fake critic LLM returning fixed scores (optionally varying by idea title). */
function fakeCritic(
  pick:
    | { conceptualNovelty: number; feasibility: number }
    | ((title: string) => { conceptualNovelty: number; feasibility: number }),
): ScoutLlmCall {
  return async (opts) => {
    const userText = opts.messages.map((m) => m.content).join('\n');
    const titleLine = userText.split('\n').find((l) => l.startsWith('Title: ')) ?? '';
    const title = titleLine.slice('Title: '.length);
    const scores = typeof pick === 'function' ? pick(title) : pick;
    const json = { ...scores, rationale: 'fake critic' };
    return { text: JSON.stringify(json), json, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  };
}

describe('critiqueIdea', () => {
  it('keeps a novel + feasible idea', async () => {
    const c = await critiqueIdea(idea(), [], { llmCall: fakeCritic({ conceptualNovelty: 0.9, feasibility: 0.9 }) });
    expect(c.verdict).toBe('keep');
    expect(c.novelty).toBeGreaterThanOrEqual(0.66);
    expect(c.feasibility).toBe(0.9);
  });

  it('SEARCH-FIRST CEILING: an already-present idea is rejected even when the LLM claims it is novel', async () => {
    const corpus: CorpusEntry[] = [
      { ref: 'plan:dup', kind: 'plan', text: 'reuse the lock token bucket', state: 'dropped' },
    ];
    const dup = idea({ title: 'reuse the lock token bucket', body: 'reuse the lock token bucket' });
    // The fake critic LIES that it is maximally novel — search-first must win.
    const c = await critiqueIdea(dup, corpus, { llmCall: fakeCritic({ conceptualNovelty: 1, feasibility: 0.9 }) });
    expect(c.novelty).toBe(0);
    expect(c.verdict).toBe('reject');
    expect(c.noveltyMatches[0]?.ref).toBe('plan:dup');
  });

  it('WI-6773: a shipped implementation found at query time reaches the critic novelty ceiling', async () => {
    const dup = idea({
      title: 'graduated per-account throttle ladder',
      body: 'rotate egress on bare 429s before pausing the account',
    });
    const c = await critiqueIdea(
      dup,
      [],
      { llmCall: fakeCritic({ conceptualNovelty: 1, feasibility: 0.9 }) },
      {
        semanticDeps: {
          resolveEmbedder: async () => ({
            mode: 'test',
            dims: PROSE_VECTOR_DIMS,
            embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.01),
          }),
          queryPlanSims: async () => new Map(),
          queryWorkItemSims: async () => new Map(),
          queryImplementationCorpus: async () => [
            {
              entry: {
                ref: 'wi:WI-SHIPPED',
                kind: 'implementation',
                text: `${dup.title}\n${dup.body}`,
                state: 'shipped',
              },
              similarity: 0.99,
            },
          ],
        },
      },
    );
    expect(c.novelty).toBe(0);
    expect(c.verdict).toBe('reject');
    expect(c.noveltyMatches[0]).toMatchObject({
      ref: 'wi:WI-SHIPPED',
      kind: 'implementation',
      state: 'shipped',
    });
  });

  it('WI-6773: below-floor implementation candidates still reach the LLM skeptic with completion evidence', async () => {
    let criticPrompt = '';
    const llm: ScoutLlmCall = async (opts) => {
      criticPrompt = opts.messages.map((message) => message.content).join('\n');
      return {
        text: JSON.stringify({ conceptualNovelty: 0.2, feasibility: 0.9, rationale: 'existing mechanism' }),
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    await critiqueIdea(
      idea({ title: 'novel phrasing with no lexical overlap', body: 'another vocabulary entirely' }),
      [],
      { llmCall: llm },
      {
        semanticDeps: {
          resolveEmbedder: async () => ({
            mode: 'test',
            dims: PROSE_VECTOR_DIMS,
            embed: async () => new Array(PROSE_VECTOR_DIMS).fill(0.01),
          }),
          queryPlanSims: async () => new Map(),
          queryWorkItemSims: async () => new Map(),
          queryImplementationCorpus: async () => [
            {
              entry: {
                ref: 'wi:WI-REALIZED',
                kind: 'implementation',
                text: 'A verified graduated throttle ladder shipped and rotates egress before account pause.',
                state: 'shipped',
              },
              similarity: 0.41,
            },
          ],
        },
      },
    );
    expect(criticPrompt).toContain('wi:WI-REALIZED [shipped]');
    expect(criticPrompt).toContain('NOT a duplicate verdict');
    expect(criticPrompt).toContain('Completion evidence: A verified graduated throttle ladder shipped');
  });

  it('preserves a high-novelty / low-feasibility idea as a moonshot (D-005)', async () => {
    const c = await critiqueIdea(idea(), [], { llmCall: fakeCritic({ conceptualNovelty: 1, feasibility: 0.2 }) });
    expect(c.verdict).toBe('moonshot');
  });

  it('a critic that fails to produce JSON cannot smuggle an idea to KEEP', async () => {
    const brokenLlm: ScoutLlmCall = async () => ({
      text: 'not json at all',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    const c = await critiqueIdea(idea(), [], { llmCall: brokenLlm });
    expect(c.feasibility).toBe(0);
    expect(c.verdict).not.toBe('keep');
  });

  it('aborts a wedged downstream critic call at its phase-local cap', async () => {
    let seenSignal: AbortSignal | undefined;
    const r = await runCritic(
      idea(),
      [],
      { timeoutMs: 10 },
      {
        llmCall: async (opts) => {
          seenSignal = opts.signal;
          return await new Promise<never>(() => {});
        },
      },
    );
    expect(seenSignal?.aborted).toBe(true);
    expect(r.feasibility).toBe(0);
    expect(r.rationale).toContain('critic timed out after 10ms');
  });
});

describe('critiqueIdeas (batch + moonshot cap + no-human-prompt)', () => {
  it('partitions a batch into keep / moonshot / reject', async () => {
    const ideas = [idea({ id: 'keep', title: 'keep me' }), idea({ id: 'leap', title: 'leap one' })];
    const llm = fakeCritic((title) =>
      title.startsWith('keep')
        ? { conceptualNovelty: 0.9, feasibility: 0.8 }
        : { conceptualNovelty: 0.9, feasibility: 0.2 },
    );
    const r = await critiqueIdeas(ideas, [], { llmCall: llm });
    expect(r.kept.map((c) => c.idea.id)).toEqual(['keep']);
    expect(r.moonshot.map((c) => c.idea.id)).toEqual(['leap']);
    expect(r.critiques).toHaveLength(2);
  });

  it('caps the moonshot bucket and demotes the least-novel leap', async () => {
    const ideas = [
      idea({ id: 'm1', title: 'leap alpha' }),
      idea({ id: 'm2', title: 'leap beta' }),
      idea({ id: 'm3', title: 'leap gamma' }),
    ];
    // All high-novelty / low-feasibility, but distinct novelty so the cap is deterministic.
    const llm = fakeCritic((title) => {
      const cn = title.endsWith('alpha') ? 0.95 : title.endsWith('beta') ? 0.85 : 0.75;
      return { conceptualNovelty: cn, feasibility: 0.2 };
    });
    const r = await critiqueIdeas(ideas, [], { llmCall: llm }, { bucket: { maxMoonshots: 2 } });
    expect(r.moonshot.map((c) => c.idea.id)).toEqual(['m1', 'm2']);
    expect(r.rejected.map((c) => c.idea.id)).toEqual(['m3']);
  });

  it('runs entirely from the injected llmCall — one call per idea, no other input (no human prompt)', async () => {
    const ideas = [idea({ id: 'a', title: 'one' }), idea({ id: 'b', title: 'two' })];
    let calls = 0;
    const llm: ScoutLlmCall = async () => {
      calls += 1;
      return {
        text: '{}',
        json: { conceptualNovelty: 0.9, feasibility: 0.9 },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    await critiqueIdeas(ideas, [], { llmCall: llm });
    expect(calls).toBe(2);
  });
});

describe('buildCriticPrompt — mission framing (P-010 prompt-overlay seam)', () => {
  it('states that a bounded corpus miss is incomplete coverage, never proof of novelty', () => {
    const { user } = buildCriticPrompt(idea(), [], {});
    expect(user).toContain('coverage is incomplete');
    expect(user).toContain('absence is not evidence');
  });

  it('defaults to the coding-platform critic mission when none is supplied', () => {
    const { system } = buildCriticPrompt(idea(), [], {});
    expect(system.startsWith(DEFAULT_CRITIC_MISSION)).toBe(true);
    expect(system).toContain('multi-agent coding platform');
  });

  it('a blueprint mission replaces the default lead, leaving the two-axis mechanism intact', () => {
    const mission = 'You are TWO critics judging an idea proposed for a WORK hive. Pull against each other:';
    const { system } = buildCriticPrompt(idea(), [], { mission });
    expect(system.startsWith(mission)).toBe(true);
    expect(system).not.toContain('multi-agent coding platform');
    // the engine MECHANISM (the two critics + the JSON contract) is untouched
    expect(system).toContain('NOVELTY critic');
    expect(system).toContain('FEASIBILITY critic');
    expect(system).toContain('conceptualNovelty');
  });

  // EI-18801316749542776 — two Scout analogical ideas proposed a capability that
  // already fully existed, and cited incidents whose own titles contradicted the
  // claimed mechanism (a local token-bucket pause read as an upstream HTTP 429).
  // Both critic axes must carry an explicit instruction to catch this shape,
  // regardless of the domain MISSION override.
  it('the NOVELTY + FEASIBILITY axes carry the already-exists + evidence-class checks (EI-18801316749542776)', () => {
    const { system } = buildCriticPrompt(idea(), [], {});
    expect(system).toContain('MORE LIKELY to already exist than not');
    expect(system).toContain("idea's OWN cited evidence");
  });

  it('the already-exists + evidence-class checks survive a blueprint mission override', () => {
    const mission = 'You are TWO critics judging an idea proposed for a WORK hive. Pull against each other:';
    const { system } = buildCriticPrompt(idea(), [], { mission });
    expect(system).toContain('MORE LIKELY to already exist than not');
    expect(system).toContain("idea's OWN cited evidence");
  });
});
