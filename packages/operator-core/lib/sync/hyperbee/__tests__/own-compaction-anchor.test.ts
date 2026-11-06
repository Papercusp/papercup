import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverOwnCompactionAnchor } from '../own-compaction-anchor';
import { createMergeCursor, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';

const op = (index: number): PeerLogOp => ({
  type: 'put', table: 'anchor-test', hbKey: String(index), value: {},
  ts: index, schema_version: 1, author_pubkey: '',
});
const snapshot: PeerLogOp = {
  ...op(1), table: '__snapshot__',
  value: { coversUpTo: 1, chunkCount: 1, chunkIdx: 0, rows: [] },
};

afterEach(() => vi.useRealTimers());

describe('own compaction anchor continuation', () => {
  it('re-verifies a retained complete set without reading the long ordinary tail', async () => {
    const get = vi.fn(async (index: number) => {
      if (index !== 1) throw new Error('must seek the known set rather than scan the tail');
      return snapshot;
    });
    const log: AdmittedLog = { keyHex: 'hint-anchor', length: 1_000_000, get };
    expect(await discoverOwnCompactionAnchor(log, { hintIndex: 1 })).toMatchObject({
      known: true, lastCoversUpTo: 1, seedSet: { coversUpTo: 1, chunkCount: 1 },
    });
    expect(get.mock.calls.every(([index]) => index === 1)).toBe(true);
  });

  it('falls back from a stale non-snapshot hint and finds a complete set on the current log', async () => {
    const newer = { ...snapshot, value: { coversUpTo: 4, chunkCount: 1, chunkIdx: 0, rows: [] } };
    const log: AdmittedLog = { keyHex: 'stale-hint', length: 6,
      get: vi.fn(async (index: number) => index === 4 ? newer : op(index)) };
    expect(await discoverOwnCompactionAnchor(log, { hintIndex: 1 })).toMatchObject({ known: true, lastCoversUpTo: 4 });
  });

  it('never accepts a hinted set whose other chunk cannot be read', async () => {
    const firstChunk = { ...snapshot, value: { coversUpTo: 1, chunkCount: 2, chunkIdx: 0, rows: [] } };
    const log: AdmittedLog = { keyHex: 'incomplete-hint', length: 4,
      get: vi.fn(async (index: number) => index === 1 ? firstChunk : index === 2 ? null : op(index)) };
    expect(await discoverOwnCompactionAnchor(log, { hintIndex: 1 })).toMatchObject({ known: false });
  });

  it('reproduces tail rescanning when no continuation cursor is retained', async () => {
    vi.useFakeTimers();
    let serve!: (value: PeerLogOp) => void;
    const delayed = new Promise<PeerLogOp>((resolve) => { serve = resolve; });
    const get = vi.fn((index: number) => index === 2 ? delayed : Promise.resolve(index === 1 ? snapshot : op(index)));
    const log: AdmittedLog = { keyHex: 'unmemoized-control', length: 4, get };
    const first = discoverOwnCompactionAnchor(log, { getTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toMatchObject({ known: false });
    serve(op(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(await discoverOwnCompactionAnchor(log)).toMatchObject({ known: true });
    expect(get.mock.calls.filter(([index]) => index === 3)).toHaveLength(2);
    expect(get.mock.calls.filter(([index]) => index === 2)).toHaveLength(2);
  });

  it('retains scanned history and a late served block across tail growth', async () => {
    vi.useFakeTimers();
    const cursor = createMergeCursor();
    let length = 4;
    let serve!: (value: PeerLogOp) => void;
    const delayed = new Promise<PeerLogOp>((resolve) => { serve = resolve; });
    const get = vi.fn((index: number) => index === 2 ? delayed : Promise.resolve(index === 1 ? snapshot : op(index)));
    const log: AdmittedLog = { keyHex: 'own-anchor', get length() { return length; }, get };

    const first = discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toEqual({ known: false, outcome: 'unreadable(atIndex=2,cause=timeout)' });
    serve(op(2));
    await vi.advanceTimersByTimeAsync(30_001);
    length = 5;

    const recovered = await discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 });
    expect(recovered).toMatchObject({ known: true, lastCoversUpTo: 1, seedSet: { coversUpTo: 1, chunkCount: 1 } });
    expect(get.mock.calls.filter(([index]) => index === 3)).toHaveLength(1);
    expect(get.mock.calls.filter(([index]) => index === 2)).toHaveLength(1);
    expect(get.mock.calls.some(([index]) => index === 0)).toBe(false);
  });

  it('keeps a resolved null unknown even when the reader permits gate-dropped history', async () => {
    vi.useFakeTimers();
    const cursor = createMergeCursor();
    const log: AdmittedLog = { keyHex: 'null-anchor', length: 2, get: vi.fn(async () => null) };
    expect(await discoverOwnCompactionAnchor(log, { cursor })).toMatchObject({ known: false });
    expect(await discoverOwnCompactionAnchor(log, { cursor })).toMatchObject({ known: false });
  });

  it('verifies a complete set from its late served chunk without reading that chunk again', async () => {
    vi.useFakeTimers();
    const cursor = createMergeCursor();
    let serve!: (value: PeerLogOp) => void;
    const delayed = new Promise<PeerLogOp>((resolve) => { serve = resolve; });
    const firstChunk = { ...snapshot, value: { coversUpTo: 1, chunkCount: 2, chunkIdx: 0, rows: [] } };
    const lastChunk = { ...snapshot, value: { coversUpTo: 1, chunkCount: 2, chunkIdx: 1, rows: [] } };
    let chunkReads = 0;
    const get = vi.fn((index: number) => index === 2
      ? ++chunkReads === 1 ? delayed : new Promise<PeerLogOp>(() => {})
      : Promise.resolve(index === 1 ? firstChunk : op(index)));
    const log: AdmittedLog = { keyHex: 'late-chunk-anchor', length: 4, get };
    const first = discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toMatchObject({ known: false });
    serve(lastChunk);
    await vi.advanceTimersByTimeAsync(30_001);
    const next = discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await next).toMatchObject({ known: true, seedSet: { coversUpTo: 1, chunkCount: 2 } });
    expect(chunkReads).toBe(1);
  });

  it('discards scan and late-read state when the same log shrinks', async () => {
    vi.useFakeTimers();
    const cursor = createMergeCursor();
    let length = 4;
    let serve!: (value: PeerLogOp) => void;
    const delayed = new Promise<PeerLogOp>((resolve) => { serve = resolve; });
    const get = vi.fn((index: number) => index === 2 ? delayed : Promise.resolve(op(index)));
    const log: AdmittedLog = { keyHex: 'shrunk-anchor', get length() { return length; }, get };
    const first = discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toMatchObject({ known: false });
    serve(snapshot);
    await vi.advanceTimersByTimeAsync(30_001);
    length = 1;
    expect(await discoverOwnCompactionAnchor(log, { cursor, getTimeoutMs: 10 })).toMatchObject({
      known: true, lastCoversUpTo: 0, seedSet: null,
    });
    expect(cursor.lateReadResults?.size).toBe(0);
  });
});
