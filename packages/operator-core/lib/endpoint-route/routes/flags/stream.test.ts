/**
 * /flags/stream resume-integrity wiring (agent-tool-delta-protocol Lane D, P-008).
 *
 * Proves the route wires `resumeBounds` onto the flag bus (a getChannel ring,
 * ringSize 64): a reconnecting client whose Last-Event-ID fell below the ring
 * floor gets the standardized `resync` (so it refetches the full flag set)
 * instead of a silently-partial replay; a client still within the ring replays
 * normally with no resync. The resync MECHANISM is unit-tested in @papercusp/sse;
 * this pins that THIS stream is correctly hooked to its bus bounds.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _resetChannelsForTest, parseSseStream } from '@papercusp/sse';
import route from './stream';
import { publishFlagChange } from '../../../flag-bus';

beforeEach(() => _resetChannelsForTest());

function open(lastEventId: number): { res: Promise<Response>; abort: () => void } {
  const ac = new AbortController();
  const req = new Request('http://127.0.0.1/api/flags/stream', {
    headers: { 'Last-Event-ID': String(lastEventId) },
    signal: ac.signal,
  });
  return { res: route.handler(req as never, {} as never) as Promise<Response>, abort: () => ac.abort() };
}

/** Read frames until `kinds` is satisfied or maxFrames hit, then abort the stream. */
async function readFrames(res: Response, abort: () => void, stopOn: (e: { event: string }) => boolean, maxFrames = 80) {
  const out: Array<{ event: string; data: string }> = [];
  try {
    for await (const ev of parseSseStream(res.body!)) {
      if (ev.event === 'heartbeat') continue;
      out.push({ event: ev.event, data: ev.data });
      if (stopOn(ev) || out.length >= maxFrames) break;
    }
  } finally {
    abort();
  }
  return out;
}

describe('/flags/stream resumeBounds → resync', () => {
  it('emits resync(gap) when a reconnecting client fell below the bus ring floor', async () => {
    for (let i = 0; i < 70; i++) publishFlagChange(null); // ringSize 64 → ids 7..70 retained, floor 7
    const { res, abort } = open(1); // client last saw id 1 — ids 2..6 evicted
    const frames = await readFrames(await res, abort, (e) => e.event === 'resync' || e.event === 'flag_changed');

    const resync = frames.find((f) => f.event === 'resync');
    expect(resync).toBeDefined();
    expect(JSON.parse(resync!.data)).toMatchObject({ reason: 'gap', fromId: 1, floorId: 7, maxId: 70 });
    expect(frames.some((f) => f.event === 'flag_changed')).toBe(false); // partial replay skipped
  });

  it('replays normally with no resync when the client is still within the ring', async () => {
    for (let i = 0; i < 5; i++) publishFlagChange(null); // ids 1..5, nothing evicted (floor 1)
    const { res, abort } = open(2); // recoverable — replays 3,4,5
    let flags = 0;
    const frames = await readFrames(await res, abort, (e) => {
      if (e.event === 'flag_changed') flags++;
      return flags >= 3;
    });

    expect(frames.some((f) => f.event === 'resync')).toBe(false);
    expect(frames.filter((f) => f.event === 'flag_changed').length).toBe(3); // ids 3,4,5
  });
});
