import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../replay/transcript', () => ({ parseTranscriptJsonl: vi.fn() }));

import { makeAblationReplayLeg, ABLATION_FULL_VARIANT, ABLATION_ABLATED_VARIANT } from './replay-leg';
import { parseTranscriptJsonl } from '../replay/transcript';

const mockedParse = vi.mocked(parseTranscriptJsonl);

type Row = { runId: string; transcriptBytes: number; startedAt: string };

function makeLeg(rows: Row[], runReplay: ReturnType<typeof vi.fn>, opts: Record<string, unknown> = {}) {
  const deps = {
    sql: {},
    readRows: async () => rows,
    readBody: async (_sql: unknown, runId: string) => `jsonl:${runId}`,
    runReplay,
    llmCall: vi.fn(),
    nowMs: () => 123,
    log: () => {},
  };
  return makeAblationReplayLeg(deps as never, opts as never);
}

const legArg = {
  workspaceId: 'ws',
  rule: { ruleKey: 'no-poll', contentHash: 'abc' },
  body: 'FULL_BODY',
  ablatedBody: 'ABLATED_BODY',
} as never;

describe('makeAblationReplayLeg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips with no-cases when no transcript clears the byte floor', async () => {
    const runReplay = vi.fn();
    const leg = makeLeg([{ runId: 'r1', transcriptBytes: 100, startedAt: '2026-01-01' }], runReplay);
    const out = await leg(legArg);
    expect(out).toEqual({ batteryId: '', cases: 0, skipped: 'no-cases', costUsd: 0 });
    expect(runReplay).not.toHaveBeenCalled();
  });

  it('samples the most-recent transcripts (sampleSize, newest first) and maps the replay result', async () => {
    mockedParse.mockReturnValue({ turns: new Array(6).fill({}) } as never);
    const runReplay = vi.fn(async () => ({
      verdict: {},
      result: {
        batteryId: 'b1',
        perVariant: [
          { variantId: ABLATION_FULL_VARIANT, meanComposite: 8 },
          { variantId: ABLATION_ABLATED_VARIANT, meanComposite: 5 },
        ],
        totalCostUsd: 1.5,
        budgetExhausted: false,
      },
    }));
    const rows: Row[] = [
      { runId: 'r1', transcriptBytes: 1000, startedAt: '2026-01-02' },
      { runId: 'r2', transcriptBytes: 1000, startedAt: '2026-01-03' },
      { runId: 'r3', transcriptBytes: 1000, startedAt: '2026-01-01' },
    ];
    const leg = makeLeg(rows, runReplay, { sampleSize: 2 });
    const out = await leg(legArg);

    expect(runReplay).toHaveBeenCalledTimes(1);
    const [[replayArgs]] = runReplay.mock.calls as unknown as Array<[
      { config: { cases: { caseId: string }[]; variants: { variantId: string }[] } },
    ]>;
    const cfg = replayArgs.config;
    expect(cfg.cases.map((c) => c.caseId)).toEqual(['run:r2', 'run:r1']); // newest first, capped at 2
    expect(cfg.variants.map((v) => v.variantId)).toEqual(
      expect.arrayContaining([ABLATION_FULL_VARIANT, ABLATION_ABLATED_VARIANT]),
    );
    expect(out).toMatchObject({
      cases: 2,
      fullComposite: 8,
      ablatedComposite: 5,
      compositeDelta: -3, // ablated − full
      costUsd: 1.5,
    });
  });

  it('records the governor refusal when the governed replay returns no result', async () => {
    mockedParse.mockReturnValue({ turns: new Array(6).fill({}) } as never);
    const runReplay = vi.fn(async () => ({ verdict: { reason: 'replay-dark' }, result: null }));
    const leg = makeLeg([{ runId: 'r1', transcriptBytes: 1000, startedAt: '2026-01-01' }], runReplay);
    const out = await leg(legArg);
    expect(out).toMatchObject({ cases: 1, skipped: 'replay-dark', costUsd: 0 });
  });

  it('drops transcripts too short to cut meaningfully (< 4 turns)', async () => {
    mockedParse.mockReturnValue({ turns: new Array(2).fill({}) } as never);
    const runReplay = vi.fn();
    const leg = makeLeg([{ runId: 'r1', transcriptBytes: 1000, startedAt: '2026-01-01' }], runReplay);
    const out = await leg(legArg);
    expect(out).toMatchObject({ cases: 0, skipped: 'no-cases' });
    expect(runReplay).not.toHaveBeenCalled();
  });
});
