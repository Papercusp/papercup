/**
 * coord:feed's agent-facing time-filter contract.
 *
 * `since` is the preferred spelling used by neighboring coordination reads;
 * `since_ts` remains a compatibility alias for existing callers and docs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readCoordFeed = vi.hoisted(() => vi.fn(async () => ({
  rows: [],
  nextCursor: null,
  total: 0,
  byKind: {},
  tokens: 0,
})));

vi.mock('../feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../feed')>();
  return { ...actual, readCoordFeed };
});

import tool from './feed';

beforeEach(() => {
  readCoordFeed.mockClear();
});

describe('coord:feed — since compatibility', () => {
  it('declares preferred `since` while retaining legacy `since_ts`', () => {
    expect(Object.keys(tool.args.shape)).toContain('since');
    expect(Object.keys(tool.args.shape)).toContain('since_ts');
  });

  it('maps preferred `since` to the existing readCoordFeed since_ts seam', async () => {
    await tool.handler({ since: '2026-08-12T00:00:00.000Z' } as never, {} as never);
    expect(readCoordFeed).toHaveBeenCalledWith(expect.objectContaining({ since_ts: '2026-08-12T00:00:00.000Z' }));
  });

  it('keeps legacy `since_ts` working and prefers `since` when both are supplied', async () => {
    await tool.handler({ since_ts: '2026-08-11T00:00:00.000Z' } as never, {} as never);
    expect(readCoordFeed).toHaveBeenLastCalledWith(expect.objectContaining({ since_ts: '2026-08-11T00:00:00.000Z' }));

    await tool.handler(
      { since: '2026-08-12T00:00:00.000Z', since_ts: '2026-08-11T00:00:00.000Z' } as never,
      {} as never,
    );
    expect(readCoordFeed).toHaveBeenLastCalledWith(expect.objectContaining({ since_ts: '2026-08-12T00:00:00.000Z' }));
  });
});
