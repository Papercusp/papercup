import { describe, expect, it } from 'vitest';
import {
  assertAdmissionCensusRatchet,
  buildBulkDedupPrompt,
} from './work-items-admission-bulk-dedup';
import type { PromoterItem, PromoterPair } from './work-items-admission-promoter';

function item(id: string, title = id): PromoterItem {
  return {
    id,
    title,
    summary: `${title} summary`,
    state: 'open',
    kind: 'change',
    admission: 'admitted',
    conditionKey: null,
    createdAtMs: 1,
  };
}

describe('buildBulkDedupPrompt', () => {
  it('reuses the promoter charter, emits each endpoint once, and labels ghost context read-only', () => {
    const a = item('a', 'Same failure');
    const b = item('b', 'Same failure again');
    const pair: PromoterPair = {
      pairKey: 'a::b',
      a,
      b,
      pendingIds: ['a', 'b'],
      signals: ['cosine'],
      cosine: 0.97,
    };
    const prompt = buildBulkDedupPrompt([pair], [item('g', 'Nearby context')]);

    expect(prompt.system).toContain('DUPLICATION ONLY');
    expect(prompt.system).toContain('r-finding-merge');
    expect(prompt.user.match(/## item a /g)).toHaveLength(1);
    expect(prompt.user.match(/## item b /g)).toHaveLength(1);
    expect(prompt.user).toContain('a::b | signals=cosine | cosine=0.9700');
    expect(prompt.user).toContain('READ-ONLY GHOST CONTEXT');
    expect(prompt.user).toContain('g | <title>Nearby context</title>');
  });
});

describe('assertAdmissionCensusRatchet', () => {
  it('accepts a flat or falling census', () => {
    expect(() => assertAdmissionCensusRatchet(3, 3)).not.toThrow();
    expect(() => assertAdmissionCensusRatchet(3, 0)).not.toThrow();
  });

  it('fails loudly on an injected rise', () => {
    expect(() => assertAdmissionCensusRatchet(2, 4)).toThrow(
      'admission census ratchet violated: 2 -> 4 (+2)',
    );
  });
});
