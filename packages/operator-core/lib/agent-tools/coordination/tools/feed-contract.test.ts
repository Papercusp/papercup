/**
 * coord:feed's agent-facing time-filter contract.
 *
 * `since` is the preferred spelling used by neighboring coordination reads;
 * `since_ts` remains a compatibility alias for existing callers and docs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORD_CONVERSATIONAL_KINDS,
  COORD_EXECUTABLE_KINDS,
} from '@papercusp/coordination/core';

const readCoordFeed = vi.hoisted(() =>
  vi.fn(async (): Promise<{
    rows: never[];
    nextCursor: string | null;
    nextCursorMsgId: string | null;
    total: number;
    byKind: Record<string, number>;
    tokens: number;
  }> => ({
    rows: [],
    nextCursor: null,
    nextCursorMsgId: null,
    total: 0,
    byKind: {},
    tokens: 0,
  })),
);

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

describe('coord:feed — fleet compatibility alias', () => {
  it('declares both canonical audience and legacy fleet filters', () => {
    expect(Object.keys(tool.args.shape)).toContain('audience');
    expect(Object.keys(tool.args.shape)).toContain('fleet');
  });

  it('normalizes a fleet slug or human name to the audience filter', async () => {
    await tool.handler({ fleet: 'Backend Team' } as never, {} as never);
    expect(readCoordFeed).toHaveBeenLastCalledWith(expect.objectContaining({ audience: '@fleet:backend-team' }));
  });

  it('prefers the canonical audience when both filters are supplied', async () => {
    await tool.handler(
      { fleet: 'ignored-fleet', audience: '@topic:coordination' } as never,
      {} as never,
    );
    expect(readCoordFeed).toHaveBeenLastCalledWith(expect.objectContaining({ audience: '@topic:coordination' }));
  });
});

describe('coord:feed — inbox-only shaping redirects (EI-22057308172107761)', () => {
  it.each([
    ['include_ambient', { include_ambient: true }],
    ['includeAmbient', { includeAmbient: true }],
    ['include_intents', { include_intents: true }],
    ['max_body_chars', { max_body_chars: 200 }],
  ] as const)('redirects `%s` to coord:inbox with a valid example', (key, args) => {
    expect(Object.keys(tool.args.shape)).not.toContain(key);
    expect(tool.guidance?.argRedirects?.[key]).toEqual({
      tool: 'coord:inbox',
      args,
      note: expect.stringContaining('coord:inbox'),
    });
  });
});

describe('coord:feed — canonical kind filter parity', () => {
  it('accepts every canonical CoordKind, including executable yield', () => {
    const canonicalKinds = [...COORD_EXECUTABLE_KINDS, ...COORD_CONVERSATIONAL_KINDS];

    for (const kind of canonicalKinds) {
      expect(
        tool.args.safeParse({ kinds: [kind] }).success,
        `coord:feed should accept canonical kind ${kind}`,
      ).toBe(true);
    }
  });
});

describe('coord:feed — lossless composite pagination cursor', () => {
  it('declares the companion message-id input', () => {
    expect(Object.keys(tool.args.shape)).toContain('before_ts');
    expect(Object.keys(tool.args.shape)).toContain('before_msg_id');
  });

  it('passes the cursor pair to the reader and returns both halves to callers', async () => {
    readCoordFeed.mockResolvedValueOnce({
      rows: [],
      nextCursor: '2026-08-26T12:00:00.000Z',
      nextCursorMsgId: 'm-boundary',
      total: 3,
      byKind: { message: 3 },
      tokens: 0,
    });

    const result = (await tool.handler(
      {
        before_ts: '2026-08-26T12:00:00.000Z',
        before_msg_id: 'm-boundary',
      } as never,
      {} as never,
    )) as { content: { text: string }[] };

    expect(readCoordFeed).toHaveBeenLastCalledWith(expect.objectContaining({
      before_ts: '2026-08-26T12:00:00.000Z',
      before_msg_id: 'm-boundary',
    }));
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.next_cursor).toBe('2026-08-26T12:00:00.000Z');
    expect(payload.next_cursor_msg_id).toBe('m-boundary');
  });
});
