/**
 * METR HCAST live-ops unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-002/P-003/P-004).
 *
 * Focus (NO docker, NO spend — injected fakes): taskhelper output parsing; the docker Task-Standard lifecycle
 * (run → cp → start → setup → score → rm) sequencing; the single-opus ReAct loop (bash → submit → telemetry);
 * the hive loop's delegate → sub-agent token summing; the never-throw model-failure path.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dockerTaskStandardOps,
  gatewayModelCall,
  hiveDriveArm,
  parseTaskhelperResult,
  singleOpusDriveArm,
  type ExecFn,
  type ModelCall,
  type ModelResponse,
} from './metr-hcast-live';
import type { BenchTask } from './types';
import type { MetrHcastTaskEnv } from './metr-hcast-runner';

const SEP = 'SEP_MUfKWkpuVDn9E';

const task = (): BenchTask => ({
  benchmark: 'metr-hcast',
  instanceId: 'local_research__atari_epochs',
  problemStatement: 'q',
  graderMeta: { image: 'metrevals/public-tasks:local_research-0.4.0', family: 'local_research', task: 'atari_epochs', version: '0.4.0' },
});

const env: MetrHcastTaskEnv = {
  containerId: 'c1',
  image: 'metrevals/public-tasks:local_research-0.4.0',
  family: 'local_research',
  task: 'atari_epochs',
  instructions: 'How many epochs did the original PPO paper use for Atari?',
};

describe('parseTaskhelperResult', () => {
  it('parses a float score after the separator', () => {
    expect(parseTaskhelperResult(`some logs\n${SEP}\n0.0`)).toBe(0);
    expect(parseTaskhelperResult(`${SEP}\n1.0`)).toBe(1);
  });
  it('parses a JSON object (setup instructions)', () => {
    const out = `${SEP}\n${JSON.stringify({ instructions: 'do it', permissions: [] })}`;
    expect(parseTaskhelperResult(out)).toEqual({ instructions: 'do it', permissions: [] });
  });
  it('parses null (score returned None)', () => {
    expect(parseTaskhelperResult(`${SEP}\nnull`)).toBeNull();
  });
  it('throws when the separator is absent', () => {
    expect(() => parseTaskhelperResult('no separator here')).toThrow(/separator/);
  });
  it('throws task-not-found', () => {
    expect(() => parseTaskhelperResult('taskNotFound_FPW3SDMlvf9Kf')).toThrow(/not found/);
  });
});

describe('dockerTaskStandardOps', () => {
  it('prepareTask runs the image, copies taskhelper, starts, and reads instructions', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = vi.fn(async (file, args) => {
      calls.push([file, ...args]);
      const joined = args.join(' ');
      if (joined.includes('taskhelper.py') && joined.endsWith('setup')) {
        return { stdout: `${SEP}\n${JSON.stringify({ instructions: 'How many epochs?' })}`, stderr: '', code: 0 };
      }
      if (joined.includes('taskhelper.py') && joined.endsWith('start')) {
        return { stdout: `${SEP}\n"Success"`, stderr: '', code: 0 };
      }
      if (args[0] === 'run') return { stdout: 'container-hash', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const ops = dockerTaskStandardOps({ exec, taskhelper: '/host/taskhelper.py', nameSuffix: () => 'x' });
    const e = await ops.prepareTask({ task: task(), workspaceId: 'w' });
    expect(e.family).toBe('local_research');
    expect(e.task).toBe('atari_epochs');
    expect(e.instructions).toMatch(/epochs/);
    // sequence: rm(stale) → run → cp → start → setup
    const ops_seq = calls.map((c) => c[1]);
    expect(ops_seq).toEqual(['rm', 'run', 'cp', 'exec', 'exec']);
  });

  it('score parses the float from taskhelper score', async () => {
    const exec: ExecFn = vi.fn(async (_f, args) =>
      args.join(' ').includes('score') ? { stdout: `${SEP}\n1.0`, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 },
    );
    const ops = dockerTaskStandardOps({ exec });
    const r = await ops.score({ env, submission: '3', workspaceId: 'w' });
    expect(r.score).toBe(1);
  });

  it('teardownTask removes the container', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const ops = dockerTaskStandardOps({ exec });
    await ops.teardownTask({ env, workspaceId: 'w' });
    expect(exec).toHaveBeenCalledWith('docker', ['rm', '-f', 'c1'], expect.anything());
  });

  it('prepareTask throws on missing image/family in graderMeta', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const ops = dockerTaskStandardOps({ exec });
    const bad = { ...task(), graderMeta: { family: 'x' } } as BenchTask;
    await expect(ops.prepareTask({ task: bad, workspaceId: 'w' })).rejects.toThrow(/missing image/);
  });
});

/** A scripted model that emits a bash call then a submit. */
function scriptedModel(steps: Array<Partial<ModelResponse> & { assistantBlocks?: unknown[] }>): ModelCall {
  let i = 0;
  return vi.fn(async () => {
    const s = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return {
      text: s.text ?? '',
      toolCalls: s.toolCalls ?? [],
      stopReason: s.stopReason ?? 'tool_use',
      usage: s.usage ?? { inputTokens: 100, outputTokens: 20 },
      assistantBlocks: s.assistantBlocks ?? [{ type: 'text', text: s.text ?? '' }],
    };
  });
}

describe('singleOpusDriveArm', () => {
  it('runs bash then submits; accumulates telemetry; stopReason=done', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: '3 epochs found in paper', stderr: '', code: 0 }));
    const modelCall = scriptedModel([
      { toolCalls: [{ id: 't1', name: 'bash', input: { command: 'grep -r epochs .' } }], usage: { inputTokens: 200, outputTokens: 50 } },
      { toolCalls: [{ id: 't2', name: 'submit', input: { answer: '3' } }], usage: { inputTokens: 150, outputTokens: 10 } },
    ]);
    const drive = singleOpusDriveArm({ modelCall, exec });
    const r = await drive({ task: task(), env, arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.submission).toBe('3');
    expect(r.telemetry.stopReason).toBe('done');
    expect(r.telemetry.tokensIn).toBe(350); // 200 + 150
    expect(r.telemetry.tokensOut).toBe(60);
    expect(r.telemetry.turns).toBe(2);
    // the bash command went to `docker exec -u agent`
    expect(exec).toHaveBeenCalledWith('docker', expect.arrayContaining(['exec', '-u', 'agent', 'c1', 'bash', '-lc', 'grep -r epochs .']), expect.anything());
  });

  it('model-call failure → infra-failed, no throw', async () => {
    const modelCall: ModelCall = vi.fn(async () => { throw new Error('429'); });
    const drive = singleOpusDriveArm({ modelCall, exec: vi.fn() as unknown as ExecFn });
    const r = await drive({ task: task(), env, arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.telemetry.stopReason).toBe('infra-failed');
    expect(r.telemetry.generationError).toMatch(/429/);
  });

  it('budget cap → budget-exhausted (a scored terminal)', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: 'x', stderr: '', code: 0 }));
    const modelCall = scriptedModel([{ toolCalls: [{ id: 't1', name: 'bash', input: { command: 'ls' } }], usage: { inputTokens: 6000, outputTokens: 100 } }]);
    const drive = singleOpusDriveArm({ modelCall, exec, maxTurns: 10 });
    const r = await drive({ task: task(), env, arm: 'baseline-a-ablation', budget: { maxTokens: 5000 }, seed: '0', workspaceId: 'w' });
    expect(r.telemetry.stopReason).toBe('budget-exhausted');
  });

  it('a text-only response with no tool call is taken as the submission', async () => {
    const modelCall = scriptedModel([{ text: '3', toolCalls: [] }]);
    const drive = singleOpusDriveArm({ modelCall, exec: vi.fn() as unknown as ExecFn });
    const r = await drive({ task: task(), env, arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.submission).toBe('3');
    expect(r.telemetry.stopReason).toBe('done');
  });
});

describe('gatewayModelCall — transient-retry', () => {
  const okResp = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } };

  it('retries a 429 then succeeds (rides out concurrent-bench gateway contention)', async () => {
    let calls = 0;
    const ctor = class {
      messages = {
        create: vi.fn(async () => {
          calls += 1;
          if (calls < 3) {
            const e = new Error('rate_limit_error 429') as Error & { status: number };
            e.status = 429;
            throw e;
          }
          return okResp;
        }),
      };
    };
    const mc = gatewayModelCall({ anthropicCtor: ctor as never, sleep: async () => {}, maxRetries: 4 });
    const r = await mc({ system: 's', messages: [], tools: [], maxTokens: 100 });
    expect(calls).toBe(3); // 2 failures + 1 success
    expect(r.text).toBe('hi');
    expect(r.usage.inputTokens).toBe(5);
  });

  it('does NOT retry a non-transient error (e.g. 400)', async () => {
    let calls = 0;
    const ctor = class {
      messages = {
        create: vi.fn(async () => {
          calls += 1;
          const e = new Error('invalid_request 400') as Error & { status: number };
          e.status = 400;
          throw e;
        }),
      };
    };
    const mc = gatewayModelCall({ anthropicCtor: ctor as never, sleep: async () => {}, maxRetries: 4 });
    await expect(mc({ system: 's', messages: [], tools: [], maxTokens: 100 })).rejects.toThrow(/400/);
    expect(calls).toBe(1); // no retry
  });

  it('parses tool_use blocks into toolCalls', async () => {
    const ctor = class {
      messages = {
        create: vi.fn(async () => ({
          content: [
            { type: 'text', text: 'let me run a command' },
            { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 4 },
        })),
      };
    };
    const mc = gatewayModelCall({ anthropicCtor: ctor as never, sleep: async () => {} });
    const r = await mc({ system: 's', messages: [], tools: [], maxTokens: 100 });
    expect(r.toolCalls).toEqual([{ id: 'tu1', name: 'bash', input: { command: 'ls' } }]);
    expect(r.text).toBe('let me run a command');
    expect(r.assistantBlocks).toHaveLength(2);
  });
});

describe('hiveDriveArm', () => {
  it('delegates a subtask, sums sub-agent tokens, then submits', async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: 'worker output', stderr: '', code: 0 }));
    // Lead: delegate then submit. The delegated sub-agent (a single-opus loop) does one bash + submit.
    let leadStep = 0;
    const modelCall: ModelCall = vi.fn(async ({ system }) => {
      // The sub-agent is identified by its system prompt containing the subtask text.
      const isSub = system.includes('find the answer');
      if (isSub) {
        return { text: '', toolCalls: [{ id: 's1', name: 'submit', input: { answer: 'subdone' } }], stopReason: 'tool_use', usage: { inputTokens: 80, outputTokens: 8 }, assistantBlocks: [] };
      }
      leadStep += 1;
      if (leadStep === 1) {
        return { text: '', toolCalls: [{ id: 'd1', name: 'delegate', input: { subtask: 'find the answer' } }], stopReason: 'tool_use', usage: { inputTokens: 300, outputTokens: 40 }, assistantBlocks: [] };
      }
      return { text: '', toolCalls: [{ id: 'l2', name: 'submit', input: { answer: 'final' } }], stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 12 }, assistantBlocks: [] };
    });
    const drive = hiveDriveArm({ modelCall, exec });
    const r = await drive({ task: task(), env, arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.submission).toBe('final');
    expect(r.telemetry.stopReason).toBe('done');
    // lead tokens (300+120=420 in) + sub tokens (80 in) summed → 500 in
    expect(r.telemetry.tokensIn).toBe(500);
    expect(r.telemetry.tokensOut).toBe(60); // 40 + 12 + 8
  });
});
