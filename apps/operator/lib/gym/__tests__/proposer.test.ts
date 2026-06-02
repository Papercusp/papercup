import { describe, it, expect } from 'vitest';
import { buildProposerPrompt, parseProposal, proposeCandidate, type ProposeInput } from '../proposer';
import type { GymLlmCall } from '../task-generator';

/**
 * Reflective proposer (P-015, prompts-only per D-015). Reads the parent's worst
 * train traces + judge rationales + the running changelog and emits a targeted
 * PROMPT diff for one/few roles → a candidate overlay. The judge's rationales are
 * the reflection signal. LLM injected.
 */
const input: ProposeInput = {
  parentOverlay: { promptOverrides: { worker: '# worker v1' } },
  worstTraces: [
    { taskId: 't1', composite: 4.2, rationale: 'worker shipped without handling the empty-list case' },
    { taskId: 't2', composite: 5.0, rationale: 'validator rubber-stamped a missing error path' },
  ],
  changelog: 'cycle 1: tightened worker error-handling (accepted, +0.4).',
  proposerModel: 'claude-sonnet-4-6',
};

describe('buildProposerPrompt', () => {
  it('feeds the failures, rationales, and changelog, and asks for a JSON prompt diff', () => {
    const { system, user } = buildProposerPrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toMatch(/prompt/i);
    expect(user).toContain('worker shipped without handling the empty-list case');
    expect(user).toContain('validator rubber-stamped');
    expect(user).toContain('cycle 1: tightened worker error-handling');
  });
});

describe('parseProposal', () => {
  it('parses {promptOverrides, rationale} and validates roles', () => {
    const p = parseProposal({ promptOverrides: { worker: '# worker v2' }, rationale: 'handle empty list' });
    expect(p.promptOverrides).toEqual({ worker: '# worker v2' });
    expect(p.rationale).toBe('handle empty list');
  });
  it('throws on an unknown role or missing rationale', () => {
    expect(() => parseProposal({ promptOverrides: { nonsense: 'x' }, rationale: 'r' })).toThrow();
    expect(() => parseProposal({ promptOverrides: { worker: 'x' } })).toThrow();
  });
});

function fakeLlm(json: unknown): GymLlmCall {
  return async () => ({ text: '', json, costUsd: 0.02, inputTokens: 200, outputTokens: 80 });
}

describe('proposeCandidate', () => {
  it('merges the proposed role change onto the parent overlay (prompts-only)', async () => {
    const cand = await proposeCandidate(input, {
      llmCall: fakeLlm({ promptOverrides: { validator: '# validator stricter' }, rationale: 'stop rubber-stamping' }),
    });
    // parent worker override preserved, validator change added
    expect(cand.overlay.promptOverrides).toEqual({
      worker: '# worker v1',
      validator: '# validator stricter',
    });
    expect(cand.rationale).toBe('stop rubber-stamping');
    expect(cand.diffFromParent).toContain('validator');
  });

  it('overrides a role the parent already changed', async () => {
    const cand = await proposeCandidate(input, {
      llmCall: fakeLlm({ promptOverrides: { worker: '# worker v2' }, rationale: 'handle empty list' }),
    });
    expect(cand.overlay.promptOverrides.worker).toBe('# worker v2');
  });

  it('calls the proposer model', async () => {
    let model = '';
    await proposeCandidate(input, {
      llmCall: async (o) => {
        model = o.model;
        return { text: '', json: { promptOverrides: { worker: 'x' }, rationale: 'r' }, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    });
    expect(model).toBe('claude-sonnet-4-6');
  });
});
