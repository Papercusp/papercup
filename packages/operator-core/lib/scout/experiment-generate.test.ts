import { describe, expect, it, vi } from 'vitest';
import type { Proposal, ScoutLlmCall } from './types';
import { generateExperimentRequest } from './experiment-generate';

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  framing: 'lock contention stalls bees',
  mechanism: 'register events:await on grant + yield the turn',
  whyNew: 'no current path waits on a grant',
  bet: 'fewer stalled turns',
  cheapExperiment: { hypothesis: 'await beats poll', method: 'replay', falsifiableSignal: 'lower stall count' },
  sourceIdeaIds: [],
  addressesPatternRefs: [],
  ...over,
});

const llm = (result: unknown): ScoutLlmCall => (vi.fn(async () => result) as unknown) as ScoutLlmCall;

describe('generateExperimentRequest', () => {
  it('builds a sharp request from the LLM JSON output', async () => {
    const json = {
      overlay: 'When blocked on a lock, register events:await on grant and yield the turn rather than polling.',
      caseContext: 'mid-task: holding lock L, a peer holds the file you need',
      caseIntent: 'finish the feature without stalling',
    };
    const req = await generateExperimentRequest(proposal(), llm({ json, text: JSON.stringify(json), costUsd: 0.02, inputTokens: 10, outputTokens: 20 }));
    expect(req.testId).toBe('replay');
    expect(req.dryRun).toBe(true);
    expect(req.arms.map((a) => a.id)).toEqual(['baseline', 'candidate']);
    expect(String(req.arms[1]!.knobs['overlay.systemOverlay'])).toContain('events:await');
    expect(req.cases[0]!.intent).toBe('finish the feature without stalling');
  });

  it('falls back to the mechanical mapping on unparseable LLM output', async () => {
    const req = await generateExperimentRequest(proposal(), llm({ text: 'not json at all', costUsd: 0, inputTokens: 0, outputTokens: 0 }));
    // mechanical: the candidate overlay is the proposal's framing+mechanism prose.
    expect(String(req.arms[1]!.knobs['overlay.systemOverlay'])).toContain('lock contention stalls bees');
  });

  it('falls back to the mechanical mapping when the LLM throws', async () => {
    const llmCall = (vi.fn(async () => {
      throw new Error('boom');
    }) as unknown) as ScoutLlmCall;
    const req = await generateExperimentRequest(proposal(), llmCall);
    expect(req.batteryId).toBe('scout:p1');
    expect(req.dryRun).toBe(true);
  });
});
