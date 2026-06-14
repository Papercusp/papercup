import { describe, it, expect, beforeEach, vi } from 'vitest';
import judgeTool, { runGymJudge } from './judge';
import { judgeGymRun, rubricFromBlueprintGym } from '../../gym/primitives';

// PG/LLM-free unit: judgeGymRun + the rubric mapper live in gym/primitives (their
// own suites); this pins the TOOL's wiring — runGymJudge resolves the target
// rubric then runs the judge with the injected llmCall, and the handler shapes
// the {ok, score} / {ok:false, error} envelope (harness-blueprint-orchestration
// P-012 / D-022). The disposition side-write is fire-and-forget + flag/ws-gated,
// so the no-ws ctx path skips it.
vi.mock('../../gym/primitives', () => ({ judgeGymRun: vi.fn(), rubricFromBlueprintGym: vi.fn() }));
vi.mock('../../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));

const mockJudge = vi.mocked(judgeGymRun);
const mockRubric = vi.mocked(rubricFromBlueprintGym);

const SCORE = { d1: 0.8, d2: 0.7, composite: 0.75, rationale: 'solid', judgeModel: 'opus', rubricHash: 'rh' };
const RUBRIC = { version: 'v1', weights: { d1: 1 } };
const ARGS = { intent: 'fix the bug', projectContext: 'a TS repo', distilledTrace: 'did X then Y' };

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    judgeTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('gym:judge — runGymJudge core', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRubric.mockReturnValue(RUBRIC as unknown as ReturnType<typeof rubricFromBlueprintGym>);
    mockJudge.mockResolvedValue(SCORE as unknown as Awaited<ReturnType<typeof judgeGymRun>>);
  });

  it('resolves the target rubric and runs the judge with the injected llmCall', async () => {
    const fakeLlm = vi.fn();
    const out = await runGymJudge({ ...ARGS, rubric: { version: 'v2' } }, { llmCall: fakeLlm as never });
    expect(mockRubric).toHaveBeenCalledWith({ rubric: { version: 'v2' } });
    expect(mockJudge).toHaveBeenCalledWith(
      { intent: ARGS.intent, projectContext: ARGS.projectContext, distilledTrace: ARGS.distilledTrace, rubric: RUBRIC },
      { llmCall: fakeLlm },
    );
    expect(out).toEqual(SCORE);
  });

  it('passes undefined to the rubric mapper when no rubric is given (→ V1 fallback)', async () => {
    await runGymJudge(ARGS, { llmCall: vi.fn() as never });
    expect(mockRubric).toHaveBeenCalledWith(undefined);
  });
});

describe('gym:judge — tool envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRubric.mockReturnValue(RUBRIC as unknown as ReturnType<typeof rubricFromBlueprintGym>);
    mockJudge.mockResolvedValue(SCORE as unknown as Awaited<ReturnType<typeof judgeGymRun>>);
  });

  it('returns { ok:true, score } on success', async () => {
    const res = await callTool(ARGS, {});
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, score: SCORE });
  });

  it('maps a judge failure to { ok:false, error }', async () => {
    mockJudge.mockRejectedValue(new Error('judge model timed out'));
    const res = await callTool(ARGS, {});
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, error: 'judge model timed out' });
  });
});
