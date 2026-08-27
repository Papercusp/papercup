/**
 * testing:run-status — handler coverage for detached testing:run snapshots.
 *
 * The store lifecycle is covered by testing-run-store.test.ts; this suite
 * pins the MCP-facing found/unknown response and the guidance that makes the
 * timeout recovery callable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../testing-run-store', async (orig) => ({
  ...(await orig<typeof import('../../testing-run-store')>()),
  getRun: vi.fn(),
}));

import { getRun } from '../../testing-run-store';
import { detachedTestTimeoutHint } from './run';

const getRunMock = vi.mocked(getRun);
const tool = (await import('./run-status')).default;

type Output = { data: Record<string, unknown> };

const call = (runId: string) => tool.handler({ runId } as never, {} as never) as Promise<Output>;

beforeEach(() => {
  getRunMock.mockReset();
});

describe('testing:run-status handler', () => {
  it('returns the bounded snapshot for a known detached run', async () => {
    const snapshot = {
      runId: 'run-1',
      kind: 'vitest',
      label: 'detached test',
      command: ['node', 'scripts/test-files.mjs'],
      status: 'running',
      exitCode: null,
      startedAt: 123,
      finishedAt: null,
      output: 'collected 1 test',
      truncated: false,
    } as const;
    getRunMock.mockReturnValue(snapshot);

    const out = await call(snapshot.runId);

    expect(out.data).toEqual({ ok: true, snapshot });
    expect(getRunMock).toHaveBeenCalledWith(snapshot.runId);
  });

  it('returns explicit unknown_run for an absent or evicted id', async () => {
    getRunMock.mockReturnValue(null);

    const out = await call('missing-run');

    expect(out.data).toMatchObject({ ok: false, error: 'unknown_run', runId: 'missing-run' });
    expect(String(out.data.message)).toContain('not evidence that the test passed');
  });

  it('documents the callable timeout recovery poll surface', () => {
    expect(tool.description).toContain('testing:run-status { runId }');
    expect(tool.guidance?.chaining).toContain('testing:run-status { runId }');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.test.ts'])).toContain('testing:run-status { runId }');
    expect(detachedTestTimeoutHint(['packages/operator-core/lib/example.integration.test.ts'])).toContain(
      'testing:run-status { runId }',
    );
  });
});
