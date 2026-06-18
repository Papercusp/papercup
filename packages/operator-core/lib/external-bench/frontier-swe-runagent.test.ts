import { describe, it, expect } from 'vitest';
import type { ExecFn, ModelCall, ModelResponse } from './metr-hcast-live';
import type { RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import type { IsoBudget } from './coordination-topology';
import { makeFrontierSweRunAgent } from './frontier-swe-runagent';

type Resp = Partial<ModelResponse> & { toolCalls?: ModelResponse['toolCalls'] };

/** A scripted modelCall that pops canned responses and records the system/tools it saw. */
function scriptedModelCall(responses: Resp[]) {
  const seen: { system: string; tools: string[] }[] = [];
  let i = 0;
  const call: ModelCall = async ({ system, tools }) => {
    seen.push({ system, tools: tools.map((t) => t.name) });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      text: r.text ?? '',
      toolCalls: r.toolCalls ?? [],
      stopReason: r.stopReason ?? 'tool_use',
      usage: r.usage ?? { inputTokens: 100, outputTokens: 50 },
      assistantBlocks: [],
    };
  };
  return { call, seen };
}

const fakeExec = (): ExecFn => async () => ({ stdout: 'ok', stderr: '', code: 0 });
const throwingModelCall: ModelCall = async () => {
  throw new Error('gateway 500');
};

const HANDLE: FrontierSweEnvHandle = { containerId: 'cid1', image: 'img', instanceId: 'cranelift-codegen-opt' };
const BUDGET: IsoBudget = { maxModelCalls: 100, maxTokens: 1_000_000, maxWallMs: 1e9 };

function input(over: Partial<RunAgentInput<FrontierSweEnvHandle>> = {}): RunAgentInput<FrontierSweEnvHandle> {
  return {
    task: { benchmark: 'frontier-swe', instanceId: 'cranelift-codegen-opt', problemStatement: 'optimize cranelift', graderMeta: {} },
    handle: HANDLE,
    role: 'worker',
    arm: 'su-independent',
    teamKey: 'all-0',
    topic: 'bench:su-independent:all-0',
    directive: '',
    forbidTools: [],
    attemptBudget: BUDGET,
    ...over,
  };
}

const bashTurn = (cmd: string): Resp => ({ toolCalls: [{ id: 't1', name: 'bash', input: { command: cmd } }] });
const submitTurn = (summary: string): Resp => ({ toolCalls: [{ id: 't2', name: 'submit', input: { summary } }] });

describe('makeFrontierSweRunAgent — worker/solver/driver drive', () => {
  it('runs the ReAct loop (bash → submit) and reports usage + coordCalls=0', async () => {
    const { call, seen } = scriptedModelCall([bashTurn('ls /app'), submitTurn('optimized the egraph cost model')]);
    let execArgs: string[] = [];
    const exec: ExecFn = async (_f, args) => { execArgs = args; return { stdout: 'files', stderr: '', code: 0 }; };
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec });
    const out = await runAgent(input());
    expect(out.status).toBe('completed');
    expect(out.modelCalls).toBe(2);
    expect(out.turns).toBe(2);
    expect(out.submission).toBe('optimized the egraph cost model');
    expect(out.coordCalls).toBe(0); // bash/submit are not coordination tools
    expect(out.tokensIn).toBe(200);
    expect(out.tokensOut).toBe(100);
    // bash ran in the container at /app
    expect(execArgs.slice(0, 2)).toEqual(['exec', '-w']);
    expect(execArgs).toContain('/app');
    expect(execArgs).toContain('cid1');
    // the system prompt carried the task brief
    expect(seen[0].system).toContain('optimize cranelift');
    expect(seen[0].tools.sort()).toEqual(['bash', 'submit']);
  });

  it('injects the coordination directive into the system prompt', async () => {
    const { call, seen } = scriptedModelCall([submitTurn('done')]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec() });
    await runAgent(input({ directive: 'BROADCAST findings to your peers.' }));
    expect(seen[0].system).toContain('BROADCAST findings to your peers.');
  });

  it('a model-call failure → status error (infra), not a crash', async () => {
    const runAgent = makeFrontierSweRunAgent({ modelCall: throwingModelCall, exec: fakeExec() });
    const out = await runAgent(input());
    expect(out.status).toBe('error');
    expect(out.error).toContain('gateway 500');
  });

  it('hitting maxTurns without submit → completed (container mutated) + capped', async () => {
    const { call } = scriptedModelCall([bashTurn('make changes')]); // always bash, never submit
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec(), maxTurns: 2 });
    const out = await runAgent(input());
    expect(out.status).toBe('completed');
    expect(out.turns).toBe(2);
    expect(out.capped).toBe(true);
    expect(out.submission).toContain('worker ran 2 turns');
  });

  it('respects attemptBudget.maxModelCalls (caps the drive)', async () => {
    const { call } = scriptedModelCall([bashTurn('a')]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec(), maxTurns: 50 });
    const out = await runAgent(input({ attemptBudget: { maxModelCalls: 3 } }));
    expect(out.modelCalls).toBe(3);
    expect(out.capped).toBe(true);
  });

  it('forbidTools removes a tool from the offered set', async () => {
    const { call, seen } = scriptedModelCall([submitTurn('done')]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec() });
    await runAgent(input({ forbidTools: ['bash'] }));
    expect(seen[0].tools).toEqual(['submit']);
  });
});

describe('makeFrontierSweRunAgent — judge (ensemble)', () => {
  it('picks a candidate index without re-solving (one model call)', async () => {
    const { call } = scriptedModelCall([{ toolCalls: [{ id: 'p', name: 'pick', input: { index: 1 } }] }]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec() });
    const out = await runAgent(
      input({ role: 'judge', candidates: [{ index: 0, submission: 'cand A' }, { index: 1, submission: 'cand B' }] }),
    );
    expect(out.status).toBe('completed');
    expect(out.pickIndex).toBe(1);
    expect(out.modelCalls).toBe(1);
    expect(out.submission).toBe('cand B');
  });

  it('an invalid pick falls back to the first candidate', async () => {
    const { call } = scriptedModelCall([{ toolCalls: [{ id: 'p', name: 'pick', input: { index: 9 } }] }]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec() });
    const out = await runAgent(input({ role: 'judge', candidates: [{ index: 0, submission: 'A' }, { index: 1, submission: 'B' }] }));
    expect(out.pickIndex).toBe(0);
  });

  it('no candidates → error', async () => {
    const { call } = scriptedModelCall([{}]);
    const runAgent = makeFrontierSweRunAgent({ modelCall: call, exec: fakeExec() });
    const out = await runAgent(input({ role: 'judge', candidates: [] }));
    expect(out.status).toBe('error');
  });
});
