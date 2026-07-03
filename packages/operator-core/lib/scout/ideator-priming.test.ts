/**
 * ideator-priming.test.ts — Scout P-012 archive→Scout priming (the ideators half).
 * Pins that the gym-QD stepping-stone priming threads into the ideator prompt:
 * buildIdeatorPrompt appends it, and runIdeators forwards opts.priming to every
 * ideator. (The cycle-deps wire — gatherSteppingStones(archive).priming — is the
 * other half, in cycle-deps ideate.)
 */
import { describe, it, expect } from 'vitest';
import { buildIdeatorPrompt } from './lenses';
import { runIdeators } from './ideators';
import type { CorpusDigest, ScoutLlmCall } from './types';

const DIGEST: CorpusDigest = {
  recurringFriction: [{ summary: 'lock contention on shared tree', ref: 'wi:F-1' }],
  timeTokenSinks: [],
  chronicDeferrals: [],
  capabilityGaps: [],
  headline: 'busy week',
};

const PRIMING = '## Gym stepping-stones\n- [module/sync/low risk] (gym fitness 0.80) — re-read acceptance';

describe('buildIdeatorPrompt priming (P-012)', () => {
  it('appends the priming block to the user prompt when present', () => {
    const { user } = buildIdeatorPrompt({ lens: 'reframing', digest: DIGEST, priming: PRIMING });
    expect(user).toContain('Gym stepping-stones');
    expect(user).toContain('re-read acceptance');
  });
  it('omits priming when absent', () => {
    const { user } = buildIdeatorPrompt({ lens: 'reframing', digest: DIGEST });
    expect(user).not.toContain('Gym stepping-stones');
  });
  it('adds the federated niche-guidance section beside the lens framing', () => {
    const { system } = buildIdeatorPrompt({
      lens: 'reframing',
      digest: DIGEST,
      nicheMapPriming: 'AVOID crowded niches.\nTARGET empty adjacent niches.',
    });
    expect(system).toContain('## Federated niche guidance');
    expect(system).toContain('AVOID crowded niches');
    expect(system).toContain('TARGET empty adjacent niches');
    expect(system).toContain('seededByRefs');
  });
});

describe('runIdeators forwards priming to every ideator (P-012)', () => {
  it('passes opts.priming into the ideator prompt', async () => {
    const seen: string[] = [];
    const llmCall: ScoutLlmCall = async (opts) => {
      seen.push([opts.system ?? '', ...opts.messages.map((m) => m.content)].join('\n'));
      return {
        text: '',
        json: { ideas: [{ title: 'T', body: 'B', mechanism: 'M', addressesPatternRefs: ['wi:F-1'] }] },
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    };
    const res = await runIdeators(DIGEST, {
      llmCall,
      lenses: ['reframing', 'first-principles'],
      priming: 'STEPSTONE-MARKER',
      nicheMapPriming: 'NICHE-MAP-MARKER',
    });
    expect(res.ideas.length).toBeGreaterThan(0);
    expect(seen.length).toBe(2); // one per lens
    expect(seen.every((s) => s.includes('STEPSTONE-MARKER'))).toBe(true);
    expect(seen.every((s) => s.includes('NICHE-MAP-MARKER'))).toBe(true);
  });
});
