/**
 * SwarmBench live-port unit tests (plan benchmark-suite-swarmbench-2026-06-17 P-003).
 * Focus: the swarmbench_run.py result parsing + the pythonRunSwarmSim subprocess wiring (injected fake exec —
 * no python, no spend). The sim mechanics themselves are validated by the vendored runner (P-002 spike).
 */
import { describe, expect, it, vi } from 'vitest';
import { parseSwarmSimResult, pythonRunSwarmSim, scenarioId, type ExecFn, type SwarmScenario } from './swarmbench-live';

const SEP = 'SWARMBENCH_RESULT_JSON';
const scenario: SwarmScenario = { task: 'Pursuit', numAgents: 4, width: 8, height: 8, seed: 42, viewSize: 5, maxRound: 15 };

describe('parseSwarmSimResult', () => {
  it('parses a good result line after the separator', () => {
    const out = `some sim logs\n${SEP}\n${JSON.stringify({ score: 3.5, rounds: 15, agentTokens: 60, done: true, task: 'Pursuit' })}`;
    const r = parseSwarmSimResult(out);
    expect(r.score).toBe(3.5);
    expect(r.rounds).toBe(15);
    expect(r.agentTokens).toBe(60);
    expect(r.done).toBe(true);
    expect(r.error).toBeUndefined();
  });
  it('parses an error result → score null + error', () => {
    const r = parseSwarmSimResult(`${SEP}\n${JSON.stringify({ error: 'KeyError: x' })}`);
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/KeyError/);
  });
  it('handles a missing separator as an infra error', () => {
    const r = parseSwarmSimResult('boom, no separator');
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/no result separator/);
  });
  it('handles a non-JSON result line', () => {
    const r = parseSwarmSimResult(`${SEP}\nnot json{`);
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/not JSON/);
  });
});

describe('scenarioId', () => {
  it('is stable + encodes the config', () => {
    expect(scenarioId(scenario)).toBe('Pursuit__n4_8x8_v5_r15_s42');
  });
});

describe('pythonRunSwarmSim', () => {
  it('builds the right CLI args and returns the parsed result', async () => {
    let capturedArgs: string[] = [];
    const exec: ExecFn = vi.fn(async (_file, args) => {
      capturedArgs = args;
      return { stdout: `${SEP}\n${JSON.stringify({ score: 1.0, rounds: 15, agentTokens: 60, done: true })}`, stderr: '', code: 0 };
    });
    const run = pythonRunSwarmSim({ exec, model: 'claude-opus-4-8', apiBase: 'http://127.0.0.1:8788/v1' });
    const r = await run({ scenario, mode: 'openai', workspaceId: 'w' });
    expect(r.score).toBe(1.0);
    expect(capturedArgs).toContain('--mode');
    expect(capturedArgs[capturedArgs.indexOf('--mode') + 1]).toBe('openai');
    expect(capturedArgs[capturedArgs.indexOf('--task') + 1]).toBe('Pursuit');
    expect(capturedArgs[capturedArgs.indexOf('--num-agents') + 1]).toBe('4');
    expect(capturedArgs[capturedArgs.indexOf('--api-base') + 1]).toBe('http://127.0.0.1:8788/v1');
  });

  it('never throws on a subprocess spawn failure → returns an error result', async () => {
    const exec: ExecFn = vi.fn(async () => { throw new Error('ENOENT python'); });
    const run = pythonRunSwarmSim({ exec });
    const r = await run({ scenario, mode: 'openai', workspaceId: 'w' });
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/spawn failed|ENOENT/);
  });

  it('flags a nonzero exit with no parseable result as an infra error', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: 'Traceback...', stderr: 'boom', code: 1 }));
    const run = pythonRunSwarmSim({ exec });
    const r = await run({ scenario, mode: 'random', workspaceId: 'w' });
    expect(r.score).toBeNull();
    expect(r.error).toMatch(/no result separator|exited 1/);
  });
});
