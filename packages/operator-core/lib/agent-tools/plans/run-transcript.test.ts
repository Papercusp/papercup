/**
 * run-transcript.test.ts — the plans:run-transcript HANDLER (getPlanRun/
 * readPlanRunTranscript mocked). Pins the unknown_run guard (no transcript read when
 * the run is missing), the paginated projection (run fields + turns + nextCursor + the
 * query echo that defaults to null), and the DB-failure → isError
 * {error:'run_transcript_unavailable'} mapping. A regression that dumps without the
 * guard or swallows a DB error is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/run-transcript.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runs', () => ({ getPlanRun: vi.fn(), readPlanRunTranscript: vi.fn() }));

import { getPlanRun, readPlanRunTranscript } from './runs';
const getRun = vi.mocked(getPlanRun);
const readTx = vi.mocked(readPlanRunTranscript);
const tool = (await import('./run-transcript')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ runId: 5, ...args } as never, { metadata: meta } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

const aRun = { id: 5, planSlug: 'p1', sessionId: 's1', status: 'done', planContentHash: 'h1' };

beforeEach(() => {
  vi.clearAllMocks();
  getRun.mockResolvedValue(aRun as never);
  readTx.mockResolvedValue({ turns: [{ seq: 1, content: 'hi' }], nextCursor: 10 } as never);
});

describe('plans:run-transcript handler', () => {
  it('guards an unknown run and does not read the transcript', async () => {
    getRun.mockResolvedValue(null as never);
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'unknown_run', runId: 5 });
    expect(readTx).not.toHaveBeenCalled();
  });

  it('projects the run + page, reads by sessionId, and emits a turnCount breadcrumb', async () => {
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({
      runId: 5, planSlug: 'p1', sessionId: 's1', status: 'done', planContentHash: 'h1',
      turns: [{ seq: 1 }], nextCursor: 10, query: null,
    });
    expect(readTx.mock.calls[0]![0]).toBe('s1'); // reads by sessionId
    expect(meta).toHaveBeenCalledWith({ runId: 5, turnCount: 1 });
  });

  it('echoes the substring query when provided', async () => {
    const out = await call({ query: 'error' });
    expect(body(out).query).toBe('error');
    expect(readTx.mock.calls[0]![1]).toMatchObject({ query: 'error' });
  });

  it('maps a DB failure to run_transcript_unavailable (isError)', async () => {
    readTx.mockRejectedValue(new Error('turns table gone'));
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'run_transcript_unavailable', runId: 5 });
  });
});
