import { describe, expect, it } from 'vitest';
import { buildExperimentGymAbDeps } from './gym-live-deps';

describe('buildExperimentGymAbDeps', () => {
  it('composes createGymRunnerPorts + buildAbDeps into a live AbDeps (no I/O at build time)', () => {
    const deps = buildExperimentGymAbDeps({
      operatorBaseUrl: 'http://127.0.0.1:3971',
      gymSql: (() => {}) as never, // a store handle is built but not queried at construction
      superuserToken: 'tok',
      workspaceId: 'ws',
      llmCall: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as never,
      scratchRoot: '/tmp/gym-experiment',
      exec: async () => {},
      rm: async () => {},
      fetchFn: (async () => new Response('{}')) as never,
    });

    // It's a real AbDeps — the runner + collect + store hooks exist; nothing touched PG
    // or exec just by building it (the gym-operator infra is only hit on an actual run).
    expect(typeof deps.runPipeline).toBe('function');
    expect(typeof deps.collectAndDistill).toBe('function');
    expect(deps.store).toBeDefined();
  });
});
