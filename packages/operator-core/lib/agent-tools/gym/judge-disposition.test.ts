/**
 * judge-disposition.test.ts — the gym:judge → decision-ledger fire-and-forget
 * guard (judge.ts ~91-109, queen-autonomy P-112). The sibling judge.test.ts
 * pins the {ok,score} envelope + the no-ws skip; this file pins the DISPOSITION
 * side-write specifically:
 *   (a) ws==='*' AND ws===undefined → recordProactiveDisposition is NOT called,
 *       yet the result is still {ok:true} (the gate `ws && ws !== '*'`),
 *   (b) a valid ws → called ONCE with action:'gym:judge' + metadata.composite,
 *   (c) recordProactiveDisposition REJECTING still yields {ok:true, score} —
 *       "a ledger miss must never break the judge" (the ~106 catch).
 *
 * The write is fire-and-forget (`void (async () => …)()`), so each test flushes
 * the microtask queue before asserting on the mock. runGymJudge is mocked via
 * its gym/primitives source (same idiom as judge.test.ts) so no LLM/network runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../gym/primitives', () => ({ judgeGymRun: vi.fn(), rubricFromBlueprintGym: vi.fn() }));
vi.mock('../../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));
vi.mock('../../decision-ledger/disposition', () => ({ recordProactiveDisposition: vi.fn() }));

import judgeTool from './judge';
import { judgeGymRun, rubricFromBlueprintGym } from '../../gym/primitives';
import { recordProactiveDisposition } from '../../decision-ledger/disposition';

const mockJudge = vi.mocked(judgeGymRun);
const mockRubric = vi.mocked(rubricFromBlueprintGym);
const mockRecord = vi.mocked(recordProactiveDisposition);

const SCORE = { d1: 0.8, d2: 0.7, d3: 0.6, composite: 0.71, rationale: 'solid', judgeModel: 'opus', rubricHash: 'rh' };
const RUBRIC = { version: 'v1', weights: { d1: 1 } };
const ARGS = { intent: 'fix the bug', projectContext: 'a TS repo', distilledTrace: 'did X then Y' };

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    judgeTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

/** Let the fire-and-forget `void (async () => …)()` settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function parse(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text);
}

describe('gym:judge — disposition side-write guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRubric.mockReturnValue(RUBRIC as unknown as ReturnType<typeof rubricFromBlueprintGym>);
    mockJudge.mockResolvedValue(SCORE as unknown as Awaited<ReturnType<typeof judgeGymRun>>);
    mockRecord.mockResolvedValue(1);
  });

  it("(a) ws==='*' skips the ledger write but still returns {ok:true}", async () => {
    const res = await callTool(ARGS, { workspaceId: '*' });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(parse(res)).toEqual({ ok: true, score: SCORE });
  });

  it('(a) ws===undefined skips the ledger write but still returns {ok:true}', async () => {
    const res = await callTool(ARGS, {}); // no workspaceId, no principal
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(parse(res)).toEqual({ ok: true, score: SCORE });
  });

  it("(b) a valid ws calls recordProactiveDisposition once with action:'gym:judge' + metadata.composite", async () => {
    const res = await callTool(ARGS, { workspaceId: 'ws-1', harnessSlug: 'gym-h', role: 'architect', spawnId: 'spw_1' });
    await flush();
    expect(parse(res)).toEqual({ ok: true, score: SCORE });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        harnessSlug: 'gym-h',
        decisionInput: expect.objectContaining({ action: 'gym:judge' }),
        metadata: expect.objectContaining({ composite: SCORE.composite }),
        actorRole: 'architect',
        actorSpawnId: 'spw_1',
      }),
    );
  });

  it('(b) resolves the ws from ctx.principal.workspaceId when ctx.workspaceId is absent', async () => {
    await callTool(ARGS, { principal: { workspaceId: 'ws-principal' } });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-principal' }));
  });

  it('(c) a REJECTING recordProactiveDisposition still yields {ok:true, score} — a ledger miss must never break the judge', async () => {
    mockRecord.mockRejectedValue(new Error('ledger down'));
    const res = await callTool(ARGS, { workspaceId: 'ws-1' });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(parse(res)).toEqual({ ok: true, score: SCORE });
  });
});
