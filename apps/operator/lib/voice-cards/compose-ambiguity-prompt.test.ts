import { describe, expect, it } from 'vitest';

import type { OpenCardSnapshot, CardPresentation } from '@papercusp/agent-mcp';

import { composeAmbiguityPrompt } from './compose-ambiguity-prompt';

function card(presentation: CardPresentation | undefined, prompt = 'Pick one'): OpenCardSnapshot {
  return {
    correlationId: 'cid',
    prompt,
    dataSchemaJson: {},
    presentation,
    createdAt: 0,
  };
}

const opts: CardPresentation = {
  kind: 'radio',
  options: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ],
};

describe('composeAmbiguityPrompt', () => {
  it('two candidates uses "A, or B?"', () => {
    expect(composeAmbiguityPrompt(card(opts), ['a', 'b'])).toBe(
      'Did you mean Alpha, or Beta?',
    );
  });

  it('three candidates uses Oxford-style comma + or', () => {
    expect(composeAmbiguityPrompt(card(opts), ['a', 'b', 'c'])).toBe(
      'Did you mean Alpha, Beta, or Gamma?',
    );
  });

  it('single candidate falls to one-option phrasing', () => {
    expect(composeAmbiguityPrompt(card(opts), ['a'])).toBe('Did you mean Alpha?');
  });

  it('no candidates → falls back to card prompt', () => {
    expect(composeAmbiguityPrompt(card(opts, 'Pick something already'), [])).toBe(
      'Pick something already',
    );
  });

  it('unknown candidate ids are skipped; empty result falls back to prompt', () => {
    expect(composeAmbiguityPrompt(card(opts, 'Choose'), ['xx', 'yy'])).toBe('Choose');
  });

  it('non-radio presentation falls back to prompt', () => {
    const c = card({ kind: 'checkbox', options: [{ id: 'a', label: 'A' }] }, 'p');
    expect(composeAmbiguityPrompt(c, ['a'])).toBe('p');
  });

  it('missing presentation falls back to prompt', () => {
    expect(composeAmbiguityPrompt(card(undefined, 'q'), ['a'])).toBe('q');
  });
});
