import { describe, it, expect } from 'vitest';
import { candidateChangesFor } from './counterfactual-core';
import type { DivergenceFinding } from './divergence-core';

const finding = (
  kind: DivergenceFinding['kind'],
  evidence: Record<string, unknown> = {},
  turn = 7,
): DivergenceFinding => ({ kind, turn, confidence: 0.9, evidence });

describe('candidateChangesFor', () => {
  it('error-loop → stop-retry-ladder + escalate-on-third-failure, with tools interpolated', () => {
    const out = candidateChangesFor(finding('error-loop', { tools: ['Bash', 'Edit'] }));
    expect(out.map((c) => c.id)).toEqual(['stop-retry-ladder', 'escalate-on-third-failure']);
    expect(out[0]!.rationale).toContain('Bash, Edit');
    for (const c of out) {
      expect(c.fromTurn).toBe(7);
      expect(c.promptDelta.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
  });

  it('error-loop with non-array tools falls back to "the tool"', () => {
    const out = candidateChangesFor(finding('error-loop', {}));
    expect(out[0]!.rationale).toContain('the tool');
  });

  it('repeat-loop → no-identical-reissue carrying the tool + identical-call count', () => {
    const out = candidateChangesFor(finding('repeat-loop', { tool: 'search:fulltext', identicalCalls: 5 }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('no-identical-reissue');
    expect(out[0]!.rationale).toContain('search:fulltext');
    expect(out[0]!.rationale).toContain('5');
  });

  it('repeat-loop with missing evidence uses safe fallbacks', () => {
    const out = candidateChangesFor(finding('repeat-loop', {}));
    expect(out[0]!.rationale).toContain('a tool');
    expect(out[0]!.rationale).toContain('3+');
  });

  it('burn-inflection → checkpoint-on-burn-spike', () => {
    const out = candidateChangesFor(finding('burn-inflection'));
    expect(out.map((c) => c.id)).toEqual(['checkpoint-on-burn-spike']);
    expect(out[0]!.fromTurn).toBe(7);
  });

  it('rescue-marker → yield-early-checkpoint', () => {
    const out = candidateChangesFor(finding('rescue-marker'));
    expect(out.map((c) => c.id)).toEqual(['yield-early-checkpoint']);
  });

  it('every candidate has a stable, unique id within its finding', () => {
    for (const kind of ['error-loop', 'repeat-loop', 'burn-inflection', 'rescue-marker'] as const) {
      const ids = candidateChangesFor(finding(kind)).map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('propagates the divergence turn into fromTurn for every candidate', () => {
    const out = candidateChangesFor(finding('error-loop', { tools: ['X'] }, 42));
    for (const c of out) expect(c.fromTurn).toBe(42);
  });
});
