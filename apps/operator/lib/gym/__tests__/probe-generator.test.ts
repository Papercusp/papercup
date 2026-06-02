import { describe, it, expect } from 'vitest';
import {
  buildProbePrompt,
  parseProbeTask,
  generateProbeTask,
  type GenerateProbeInput,
} from '../probe-generator';
import type { GymLlmCall } from '../task-generator';

/**
 * Planted-bug probe generator (P-006). A probe task carries a CONCRETE planted
 * defect — where it lives + what a correct validator must observe — so the
 * `planted_bug_caught` guardrail (P-003) is not vacuous. The bug is a pre-existing
 * defect in the touched area the harness must catch (a cheap un-gameable monitor,
 * not a reward — D-011).
 */
const input: GenerateProbeInput = {
  taskId: 'probe-1',
  repoUrl: '/repos/substrate',
  repoCommit: '0123456789abcdef0123456789abcdef01234567',
  repoContext: 'A TS Hono service with an /orders total calculator.',
  generatorModel: 'claude-sonnet-4-6',
  judgeModel: 'claude-opus-4-8',
};

const validRaw = {
  intent: 'Operators need order totals to include tax',
  spec: 'Add tax to the /orders total.',
  planted_bug: {
    location: 'src/orders/total.ts computeTotal()',
    defect: 'off-by-one: loops items.length-1, dropping the last line item',
    detection_signature: 'a unit test summing a 3-item order returns the 2-item total',
  },
};

describe('buildProbePrompt', () => {
  it('asks for a concrete pre-existing planted defect with a detection signature, as JSON', () => {
    const { system } = buildProbePrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toMatch(/planted|defect|pre-existing/i);
    expect(system).toMatch(/detect/i);
    expect(system).toContain('planted_bug');
  });
});

describe('parseProbeTask', () => {
  it('parses intent + spec + a fully-specified planted_bug', () => {
    expect(parseProbeTask(validRaw)).toEqual({
      intent: 'Operators need order totals to include tax',
      spec: 'Add tax to the /orders total.',
      plantedBug: {
        location: 'src/orders/total.ts computeTotal()',
        defect: 'off-by-one: loops items.length-1, dropping the last line item',
        detectionSignature: 'a unit test summing a 3-item order returns the 2-item total',
      },
    });
  });

  it('throws when planted_bug or any of its fields is missing', () => {
    expect(() => parseProbeTask({ intent: 'i', spec: 's' })).toThrow();
    expect(() => parseProbeTask({ ...validRaw, planted_bug: { location: 'x', defect: 'y' } })).toThrow();
  });
});

function fakeLlm(json: unknown): GymLlmCall {
  return async () => ({ text: '', json, costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
}

describe('generateProbeTask', () => {
  it('assembles a probe-pool gym_tasks record with the planted bug', async () => {
    const task = await generateProbeTask(input, { llmCall: fakeLlm(validRaw) });
    expect(task.pool).toBe('probe');
    expect(task.taskId).toBe('probe-1');
    expect(task.plantedBug.location).toContain('computeTotal');
    expect(task.generatedBy).toBe('claude-sonnet-4-6');
  });

  it('refuses the judge model (decorrelation, D-015)', async () => {
    await expect(
      generateProbeTask({ ...input, generatorModel: 'claude-opus-4-8' }, { llmCall: fakeLlm(validRaw) }),
    ).rejects.toThrow();
  });
});
