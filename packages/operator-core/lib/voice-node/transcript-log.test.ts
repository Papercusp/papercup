/**
 * transcript-log.test.ts — the B12 voice transcript buffer (offsite-planner demo).
 *
 * Seam-injected (no real voice channel / agent-peer): a fake `onTranscript`
 * emitter + a `setEars` spy. Pins the contract the narrator agent depends on:
 * enable turns the ears on + subscribes, capture assigns a monotonic seq,
 * `since` reads the delta with a monotonic cursor, `limit` keeps the most-recent
 * N (flagging lossy), the ring evicts the oldest at capacity (flagging lossy on
 * a stale cursor), and disable unsubscribes + clears the buffer (ears left as-is).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/voice-node/transcript-log.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTranscriptLogForTest,
  enableTranscriptCapture,
  readTranscripts,
  transcriptCaptureEnabled,
  transcriptLogState,
  type TranscriptLogSeams,
} from './transcript-log';
import type { VoiceTranscript } from './agent-peer';

function transcript(text: string, peerId = 'peerA'): VoiceTranscript {
  return { peerId, text, seconds: 1, at: 0 };
}

function makeHarness() {
  const earsCalls: boolean[] = [];
  let emit: (t: VoiceTranscript) => void = () => {};
  let unsubbed = false;
  const seams: TranscriptLogSeams = {
    setEars: (on) => earsCalls.push(on),
    onTranscript: (cb) => {
      emit = cb;
      return () => {
        unsubbed = true;
        emit = () => {};
      };
    },
  };
  return {
    seams,
    earsCalls,
    fire: (text: string, peerId?: string) => emit(transcript(text, peerId)),
    wasUnsubbed: () => unsubbed,
  };
}

afterEach(() => {
  __resetTranscriptLogForTest();
});

describe('voice transcript log (B12)', () => {
  it('enabling turns the ears on, subscribes, and captures with a monotonic seq', () => {
    const h = makeHarness();
    enableTranscriptCapture(true, h.seams);
    expect(transcriptCaptureEnabled()).toBe(true);
    expect(h.earsCalls).toEqual([true]); // ears on — can't transcribe without listening

    h.fire('hello');
    h.fire('world');
    const { entries, cursor, lossy } = readTranscripts();
    expect(entries.map((e) => e.text)).toEqual(['hello', 'world']);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]); // monotonic from 1
    expect(cursor).toBe(2);
    expect(lossy).toBe(false);
  });

  it('reads only the delta after `since`, with a monotonic cursor', () => {
    const h = makeHarness();
    enableTranscriptCapture(true, h.seams);
    h.fire('a');
    h.fire('b');
    const first = readTranscripts();
    expect(first.cursor).toBe(2);

    h.fire('c');
    const delta = readTranscripts({ since: first.cursor });
    expect(delta.entries.map((e) => e.text)).toEqual(['c']);
    expect(delta.cursor).toBe(3);

    // A read at the head with nothing new returns no entries and holds the cursor.
    const caughtUp = readTranscripts({ since: delta.cursor });
    expect(caughtUp.entries).toEqual([]);
    expect(caughtUp.cursor).toBe(3);

    // A stale (future) `since` never drags the cursor backwards.
    const stale = readTranscripts({ since: 99 });
    expect(stale.entries).toEqual([]);
    expect(stale.cursor).toBe(99);
  });

  it('`limit` keeps the most-recent N and flags lossy truncation', () => {
    const h = makeHarness();
    enableTranscriptCapture(true, h.seams);
    for (const t of ['1', '2', '3', '4', '5']) h.fire(t);
    const { entries, cursor, lossy } = readTranscripts({ limit: 2 });
    expect(entries.map((e) => e.text)).toEqual(['4', '5']); // most-recent N
    expect(cursor).toBe(5);
    expect(lossy).toBe(true); // dropped 1..3
  });

  it('evicts the oldest at capacity and flags lossy on a pre-eviction cursor', () => {
    const h = makeHarness();
    enableTranscriptCapture(true, h.seams);
    const cap = transcriptLogState().capacity;
    const overflow = 5;
    for (let i = 0; i < cap + overflow; i++) h.fire(`u${i}`);

    const state = transcriptLogState();
    expect(state.buffered).toBe(cap);
    expect(state.dropped).toBe(overflow);
    expect(state.headSeq).toBe(cap + overflow);

    // Reading from seq 1 (long evicted): we only still hold the tail, so it's lossy.
    const { entries, lossy } = readTranscripts({ since: 1 });
    expect(entries.length).toBe(cap);
    expect(entries[0]!.seq).toBe(overflow + 1); // oldest retained
    expect(lossy).toBe(true);
  });

  it('disable unsubscribes + clears the buffer; ears are left as-is; re-enable keeps seq monotonic', () => {
    const h = makeHarness();
    enableTranscriptCapture(true, h.seams);
    h.fire('x');
    expect(transcriptLogState().headSeq).toBe(1);

    enableTranscriptCapture(false, h.seams);
    expect(transcriptCaptureEnabled()).toBe(false);
    expect(h.wasUnsubbed()).toBe(true);
    expect(readTranscripts().entries).toEqual([]); // buffer cleared
    // disable must NOT yank the shared ears (only enable touched them)
    expect(h.earsCalls).toEqual([true]);

    // Re-enable: a fresh subscription, but seq does not reset — the cursor a
    // reader holds stays valid (no backwards seq across an enable cycle).
    const h2 = makeHarness();
    enableTranscriptCapture(true, h2.seams);
    h2.fire('y');
    const { entries } = readTranscripts();
    expect(entries.map((e) => e.text)).toEqual(['y']);
    expect(entries[0]!.seq).toBe(2); // continued from 1, not reset
  });

  it('is idempotent — re-enabling does not double-subscribe', () => {
    const h = makeHarness();
    const onTranscript = vi.spyOn(h.seams, 'onTranscript');
    enableTranscriptCapture(true, h.seams);
    enableTranscriptCapture(true, h.seams); // no-op
    expect(onTranscript).toHaveBeenCalledTimes(1);
    h.fire('once');
    expect(readTranscripts().entries.length).toBe(1); // one subscription → one capture
  });
});
