import { describe, it, expect } from 'vitest';
import {
  buildTaskGenPrompt,
  parseGeneratedTask,
  generateGymTask,
  type GymLlmCall,
  type GenerateTaskInput,
} from '../task-generator';

/**
 * Intent-first synthetic task generator (P-005, D-004/D-015). Generates a
 * high-level intent then a deliberately-realistic, mildly-underspecified spec so
 * spec-gaps exist for the judge's D1 to find. The generator model must differ
 * from the judge model (D-015) to avoid correlated bias. LLM injected.
 */
const input: GenerateTaskInput = {
  taskId: 'task-1',
  pool: 'train',
  repoUrl: '/repos/substrate',
  repoCommit: '0123456789abcdef0123456789abcdef01234567',
  repoContext: 'A small TypeScript Hono service exposing /orders.',
  generatorModel: 'claude-sonnet-4-6',
  judgeModel: 'claude-opus-4-8',
};

describe('buildTaskGenPrompt', () => {
  it('asks for intent first, then a mildly-underspecified spec, as JSON', () => {
    const { system } = buildTaskGenPrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toMatch(/intent/i);
    expect(system).toMatch(/underspecif|gap|realistic/i);
    // intent is requested before spec
    expect(system.toLowerCase().indexOf('intent')).toBeLessThan(system.toLowerCase().lastIndexOf('spec'));
  });

  it('includes the repo context to ground the task', () => {
    expect(buildTaskGenPrompt(input).user).toContain(input.repoContext);
  });
});

describe('parseGeneratedTask', () => {
  it('parses a valid {intent, spec}', () => {
    expect(parseGeneratedTask({ intent: 'i', spec: 's' })).toEqual({ intent: 'i', spec: 's' });
  });
  it('throws when intent or spec is missing or empty', () => {
    expect(() => parseGeneratedTask({ spec: 's' })).toThrow();
    expect(() => parseGeneratedTask({ intent: 'i' })).toThrow();
    expect(() => parseGeneratedTask({ intent: '', spec: 's' })).toThrow();
    expect(() => parseGeneratedTask(null)).toThrow();
  });
});

function fakeLlm(json: unknown): GymLlmCall {
  return async () => ({ text: '', json, costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
}

describe('generateGymTask', () => {
  it('assembles a gym_tasks record from the generated intent + spec', async () => {
    const task = await generateGymTask(input, {
      llmCall: fakeLlm({ intent: 'Operators need order search', spec: 'Add search to /orders.' }),
    });
    expect(task).toEqual({
      taskId: 'task-1',
      pool: 'train',
      repoUrl: '/repos/substrate',
      repoCommit: '0123456789abcdef0123456789abcdef01234567',
      intent: 'Operators need order search',
      spec: 'Add search to /orders.',
      generatedBy: 'claude-sonnet-4-6',
    });
  });

  it('calls the LLM with the generator model and JSON format', async () => {
    let seen: { model?: string; responseFormat?: string } = {};
    const spy: GymLlmCall = async (opts) => {
      seen = { model: opts.model, responseFormat: opts.responseFormat };
      return { text: '', json: { intent: 'i', spec: 's' }, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    };
    await generateGymTask(input, { llmCall: spy });
    expect(seen.model).toBe('claude-sonnet-4-6');
    expect(seen.responseFormat).toBe('json');
  });

  it('refuses to generate with the judge model (decorrelation, D-015)', async () => {
    await expect(
      generateGymTask({ ...input, generatorModel: 'claude-opus-4-8' }, { llmCall: fakeLlm({ intent: 'i', spec: 's' }) }),
    ).rejects.toThrow(/decorrel|judge|same model/i);
  });
});
