import { describe, expect, it } from 'vitest';

import type { OpenCardSnapshot, CardPresentation } from '@papercusp/agent-mcp';

import { matchVoiceAnswer, type VoiceTranscript } from './match-voice-answer';

function card(
  presentation: CardPresentation | undefined,
  overrides: Partial<OpenCardSnapshot> = {},
): OpenCardSnapshot {
  return {
    correlationId: 'cid',
    prompt: 'Pick one',
    dataSchemaJson: {},
    presentation,
    createdAt: 0,
    ...overrides,
  };
}

function tx(text: string, opts: Partial<VoiceTranscript> = {}): VoiceTranscript {
  return { text, tsMs: 1, ...opts };
}

const yesNo: CardPresentation = {
  kind: 'radio',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
};

const longLabels: CardPresentation = {
  kind: 'radio',
  options: [
    { id: 'use_existing', label: 'Use the existing version' },
    { id: 'generate_new', label: 'Generate a new one' },
  ],
};

const ready: CardPresentation = {
  kind: 'radio',
  options: [{ id: 'ready', label: 'Ready' }],
};

describe('matchVoiceAnswer — precedence', () => {
  it('id exact match wins', () => {
    expect(matchVoiceAnswer(tx('yes'), card(yesNo))).toEqual({
      action: 'submit', payload: { picks: ['yes'] },
    });
  });

  it('label exact match wins when id does not match', () => {
    const c = card({
      kind: 'radio',
      options: [{ id: 'opt_a', label: 'Alpha' }, { id: 'opt_b', label: 'Beta' }],
    });
    expect(matchVoiceAnswer(tx('alpha'), c)).toEqual({
      action: 'submit', payload: { picks: ['opt_a'] },
    });
  });

  it('id beats label when both could match different options', () => {
    // Pathological card: option1.id === option2.label.
    const c = card({
      kind: 'radio',
      options: [
        { id: 'foo', label: 'Bar' },
        { id: 'baz', label: 'Foo' },
      ],
    });
    // "foo" matches option1.id (step 1) before option2.label (step 2).
    expect(matchVoiceAnswer(tx('foo'), c)).toEqual({
      action: 'submit', payload: { picks: ['foo'] },
    });
  });

  it('decline phrase fires when no option matches', () => {
    expect(matchVoiceAnswer(tx('skip'), card(yesNo))).toEqual({ action: 'decline' });
    expect(matchVoiceAnswer(tx('never mind'), card(yesNo))).toEqual({ action: 'decline' });
    expect(matchVoiceAnswer(tx('Cancel.'), card(yesNo))).toEqual({ action: 'decline' });
  });

  it('label wins over decline phrase (option literally named "Skip this step")', () => {
    const c = card({
      kind: 'radio',
      options: [
        { id: 'skip_step', label: 'Skip this step' },
        { id: 'do_it', label: 'Do it' },
      ],
    });
    // "skip this step" exact-matches label at step 2 before step 3.
    expect(matchVoiceAnswer(tx('skip this step'), c)).toEqual({
      action: 'submit', payload: { picks: ['skip_step'] },
    });
  });

  it('bare "skip" without exact match still declines even with substring overlap', () => {
    const c = card({
      kind: 'radio',
      options: [
        { id: 'skip_step', label: 'Skip this step' },
        { id: 'do_it', label: 'Do it' },
      ],
    });
    // "skip" does not exact-match any label; decline-phrase step 3 fires
    // before substring step 4. This is by design — explicit short
    // commands feel like decline more than partial pick.
    expect(matchVoiceAnswer(tx('skip'), c)).toEqual({ action: 'decline' });
  });
});

describe('matchVoiceAnswer — substring step', () => {
  it('subset match → single submit', () => {
    expect(matchVoiceAnswer(tx('use existing'), card(longLabels))).toEqual({
      action: 'submit', payload: { picks: ['use_existing'] },
    });
  });

  it('subset match in the other direction → submit', () => {
    // "yes please" → label is just "Yes" (subset of transcript tokens).
    expect(matchVoiceAnswer(tx('yes please'), card(yesNo))).toEqual({
      action: 'submit', payload: { picks: ['yes'] },
    });
  });

  it('multiple substring matches → ambiguous', () => {
    const c = card({
      kind: 'radio',
      options: [
        { id: 'apple_red', label: 'Red apple' },
        { id: 'apple_green', label: 'Green apple' },
      ],
    });
    expect(matchVoiceAnswer(tx('apple'), c)).toEqual({
      action: 'ambiguous', candidateIds: ['apple_red', 'apple_green'],
    });
  });

  it('zero substring matches → null (fall through)', () => {
    expect(matchVoiceAnswer(tx('what time is it'), card(yesNo))).toBeNull();
  });

  it('stop words alone do not match anything', () => {
    const c = card({
      kind: 'radio',
      options: [{ id: 'the_thing', label: 'The thing' }],
    });
    expect(matchVoiceAnswer(tx('the'), c)).toBeNull();
  });
});

describe('matchVoiceAnswer — ready synonyms', () => {
  it('single-option card: ready / continue / go / ok / okay all match id', () => {
    for (const word of ['ready', 'continue', 'go', 'ok', 'okay']) {
      expect(matchVoiceAnswer(tx(word), card(ready))).toEqual({
        action: 'submit', payload: { picks: ['ready'] },
      });
    }
  });

  it('multi-option card: "ready" only matches if it is literally an id or label', () => {
    expect(matchVoiceAnswer(tx('ready'), card(yesNo))).toBeNull();
  });

  it('mixed punctuation OK: "Ready."', () => {
    expect(matchVoiceAnswer(tx('Ready.'), card(ready))).toEqual({
      action: 'submit', payload: { picks: ['ready'] },
    });
  });
});

describe('matchVoiceAnswer — confidence gate', () => {
  it('confidence below default 0.6 returns null even on exact match', () => {
    expect(matchVoiceAnswer(tx('yes', { confidence: 0.5 }), card(yesNo))).toBeNull();
  });

  it('confidence at or above threshold passes', () => {
    expect(matchVoiceAnswer(tx('yes', { confidence: 0.6 }), card(yesNo))).toEqual({
      action: 'submit', payload: { picks: ['yes'] },
    });
    expect(matchVoiceAnswer(tx('yes', { confidence: 0.95 }), card(yesNo))).toEqual({
      action: 'submit', payload: { picks: ['yes'] },
    });
  });

  it('undefined confidence skips the gate (EL behavior)', () => {
    expect(matchVoiceAnswer(tx('yes'), card(yesNo))).toEqual({
      action: 'submit', payload: { picks: ['yes'] },
    });
  });

  it('custom minConfidence honored', () => {
    expect(
      matchVoiceAnswer(tx('yes', { confidence: 0.75 }), card(yesNo), { minConfidence: 0.8 }),
    ).toBeNull();
  });
});

describe('matchVoiceAnswer — presentation gating', () => {
  it('no presentation → null', () => {
    expect(matchVoiceAnswer(tx('yes'), card(undefined))).toBeNull();
  });

  it('checkbox presentation → null', () => {
    const c = card({ kind: 'checkbox', options: [{ id: 'a', label: 'A' }] });
    expect(matchVoiceAnswer(tx('a'), c)).toBeNull();
  });

  it('text presentation → null', () => {
    const c = card({ kind: 'text' });
    expect(matchVoiceAnswer(tx('hello'), c)).toBeNull();
  });

  it('empty options → null', () => {
    const c = card({ kind: 'radio', options: [] });
    expect(matchVoiceAnswer(tx('yes'), c)).toBeNull();
  });
});

describe('matchVoiceAnswer — empty / edge inputs', () => {
  it('empty transcript → null', () => {
    expect(matchVoiceAnswer(tx(''), card(yesNo))).toBeNull();
  });

  it('whitespace-only transcript → null', () => {
    expect(matchVoiceAnswer(tx('   '), card(yesNo))).toBeNull();
  });

  it('punctuation-only transcript → null', () => {
    expect(matchVoiceAnswer(tx('...!!!'), card(yesNo))).toBeNull();
  });

  it('case and punctuation in id are normalized', () => {
    const c = card({
      kind: 'radio',
      options: [{ id: 'opt-1', label: 'One' }, { id: 'opt-2', label: 'Two' }],
    });
    // normalize("opt-1") = "opt 1"; normalize("OPT 1") = "opt 1".
    expect(matchVoiceAnswer(tx('OPT 1'), c)).toEqual({
      action: 'submit', payload: { picks: ['opt-1'] },
    });
  });
});
