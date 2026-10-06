import { describe, it, expect } from 'vitest';
import { buildProposerPrompt, parseProposal, proposeCandidate, throwWithCostUsd, type ProposeInput } from '../proposer';
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

  // P-032 (learning-system-audit): triage-routed gym ideas as candidate directions.
  it('zero candidate directions → the prompt is byte-identical (purely additive)', () => {
    const base = buildProposerPrompt(input);
    expect(buildProposerPrompt({ ...input, candidateDirections: [] })).toEqual(base);
    expect(buildProposerPrompt({ ...input, candidateDirections: undefined })).toEqual(base);
    expect(base.user).not.toMatch(/Candidate directions/i);
  });

  it('routed gym ideas appear as an optional-directions section', () => {
    const { user } = buildProposerPrompt({
      ...input,
      candidateDirections: ['Validator rubber-stamps — tighten the validator prompt', 'Workers skip re-reads'],
    });
    expect(user).toMatch(/## Candidate directions/);
    expect(user).toContain('- Validator rubber-stamps — tighten the validator prompt');
    expect(user).toContain('- Workers skip re-reads');
    // advisory, not a mandate — the proposer may ignore them
    expect(user).toMatch(/otherwise ignore/i);
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
  it.each([
    { label: 'absent', usage: {} },
    { label: 'NaN', usage: { costUsd: NaN } },
    { label: 'infinite', usage: { costUsd: Infinity } },
    { label: 'negative', usage: { costUsd: -1 } },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 } },
    { label: 'marked missing', usage: { costUsd: 0.42, costUsdMeasurementMissing: true } },
  ])('retains incomplete $label failed-call usage instead of inventing a complete zero', async ({ usage }) => {
    const failure = Object.assign(new Error('failed after dispatch'), usage);
    let caught: unknown;
    try {
      await proposeCandidate(input, { llmCall: async () => { throw failure; } });
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(caught).toMatchObject({ costUsdMeasurementMissing: true,
      costUsd: 'costUsd' in usage && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : 0 });
  });

  it.each([0, 0.42])('retains a complete failed-call measurement of $%s', async costUsd => {
    const failure = Object.assign(new Error('measured failed call'), { costUsd });
    await expect(proposeCandidate(input, { llmCall: async () => { throw failure; } }))
      .rejects.toMatchObject({ costUsd });
    expect(failure).not.toHaveProperty('costUsdMeasurementMissing');
  });

  it('preserves missingness and the subtotal when a non-Error failure is wrapped', () => {
    const failure = { costUsd: 0.2, unreportedFrames: 1, costUsdMeasurementMissing: true };
    expect(() => throwWithCostUsd(failure, 0.3)).toThrow();
    try { throwWithCostUsd(failure, 0.3); } catch (error) {
      expect(error).toMatchObject({ costUsd: 0.5, costUsdMeasurementMissing: true, unreportedFrames: 1 });
    }
  });

  it('a measured zero response remains complete when validation fails', async () => {
    let caught: unknown;
    try {
      await proposeCandidate(input, { llmCall: async () => ({ text: 'invalid', costUsd: 0,
        inputTokens: 0, outputTokens: 0 }) });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ costUsd: 0 });
    expect(caught).not.toHaveProperty('costUsdMeasurementMissing');
  });

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
    expect(cand.costUsd).toBeCloseTo(0.02, 6);
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

  it('preserves provider cost when response validation fails after the call', async () => {
    await expect(
      proposeCandidate(input, {
        llmCall: async () => ({
          text: '',
          json: { promptOverrides: { nonsense: 'x' }, rationale: 'invalid role' },
          costUsd: 0.37,
          inputTokens: 10,
          outputTokens: 5,
        }),
      }),
    ).rejects.toMatchObject({ costUsd: 0.37 });
  });
});
