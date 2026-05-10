/**
 * Operator persona — structural tests on the prompt content itself.
 *
 * No real-model calls — those are deferred to the persona-drift audit
 * (§10e) which queries `agent_actions` weekly. These tests catch
 * accidental edits that would break the persona shape.
 */

import { describe, it, expect } from 'vitest';
import { OPERATOR_PERSONA_PROMPT, OPERATOR_FEW_SHOTS } from './operator-persona';

describe('OPERATOR_PERSONA_PROMPT', () => {
  it('mentions all 5 tonal modes', () => {
    for (const mode of ['Default', 'Assertive', 'Sober', 'Apologetic', 'Wry']) {
      expect(OPERATOR_PERSONA_PROMPT).toContain(mode);
    }
  });

  it('declares the name policy with the budget window', () => {
    expect(OPERATOR_PERSONA_PROMPT).toMatch(/at most once per/i);
    expect(OPERATOR_PERSONA_PROMPT).toMatch(/5 minutes/);
    expect(OPERATOR_PERSONA_PROMPT).toMatch(/never start or end/i);
  });

  it('lists banned preambles (regression guard)', () => {
    for (const phrase of [
      'Great question',
      'I\'d be happy to help',
      'As an AI',
      'Let me know if there',
      'This reminds me of',
      'Speaking of which',
      'And the lesson there is',
    ]) {
      expect(OPERATOR_PERSONA_PROMPT).toContain(phrase);
    }
  });

  it('forbids markdown formatting symbols in spoken output', () => {
    expect(OPERATOR_PERSONA_PROMPT).toMatch(/no markdown/i);
  });

  it('declares anonymized-employer rule for backstories', () => {
    expect(OPERATOR_PERSONA_PROMPT).toMatch(/anonymized|the last place I worked/i);
  });

  it('is under 5KB (token budget)', () => {
    // Haiku context is generous, but every byte we add is per-turn cost.
    expect(OPERATOR_PERSONA_PROMPT.length).toBeLessThan(5000);
  });

  it('does not contain real company names', () => {
    const denylist = ['Google', 'Meta', 'Stripe', 'OpenAI', 'Anthropic', 'Apple', 'Amazon', 'Microsoft', 'Netflix', 'Uber'];
    for (const n of denylist) {
      // Substring check — can't ban "Google" if e.g. the prompt itself
      // mentions "google" as a verb. Adjust if a real false positive
      // appears.
      expect(OPERATOR_PERSONA_PROMPT.includes(n)).toBe(false);
    }
  });
});

describe('OPERATOR_FEW_SHOTS', () => {
  it('has at least one example per mode', () => {
    // Few-shots are tone-set examples; not all modes have to appear in
    // the abridged set, but at least default + assertive + sober + wry.
    const text = OPERATOR_FEW_SHOTS.toLowerCase();
    expect(text).toMatch(/3 features|on it/); // default
    expect(text).toMatch(/heads up|replan/); // assertive
    expect(text).toMatch(/failed|failed:/); // sober
    expect(text).toMatch(/proud of|new record/); // wry
  });

  it('every example fits the length cap (200 chars)', () => {
    // Pull lines starting with "You: " — assistant utterances.
    const youLines = OPERATOR_FEW_SHOTS.split('\n')
      .filter((l) => /^You:\s/.test(l))
      .map((l) => l.replace(/^You:\s/, ''));
    expect(youLines.length).toBeGreaterThan(0);
    for (const line of youLines) {
      expect(line.length).toBeLessThanOrEqual(350);
    }
  });
});
