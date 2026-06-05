// @vitest-environment node
/**
 * Process-local voice-debug ring buffer (voice-debug-ring.ts) — the in-memory
 * log the /api/agent-mcp/voice-debug route + the operator:voice_debug tool both
 * read. Untested. Covers defaulting, MAX-cap eviction, read ordering/slicing,
 * the `since` filter, and clear.
 *
 * P-016 of plan voice-production-test-coverage-2026-06-01.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { appendVoiceDebugEvent, readVoiceDebugEvents, clearVoiceDebugEvents } from './voice-debug-ring';

beforeEach(() => clearVoiceDebugEvents());

describe('appendVoiceDebugEvent', () => {
  it('fills defaults for a bare event and returns the new ring length', () => {
    const n = appendVoiceDebugEvent({});
    expect(n).toBe(1);
    const [e] = readVoiceDebugEvents();
    expect(e.event).toBe('(no-event)');
    expect(typeof e.ts).toBe('number');
  });

  it('preserves explicit event/detail/ts', () => {
    appendVoiceDebugEvent({ event: 'stt.final', detail: { text: 'hi' }, ts: 1234 });
    const [e] = readVoiceDebugEvents();
    expect(e).toEqual({ event: 'stt.final', detail: { text: 'hi' }, ts: 1234 });
  });

  it('caps the ring at MAX (200), evicting oldest', () => {
    let last = 0;
    for (let i = 1; i <= 200; i++) last = appendVoiceDebugEvent({ event: 'e', ts: i });
    expect(last).toBe(200);
    // 201st append stays capped at 200
    expect(appendVoiceDebugEvent({ event: 'e', ts: 201 })).toBe(200);
  });
});

describe('readVoiceDebugEvents', () => {
  it('returns newest-first', () => {
    appendVoiceDebugEvent({ event: 'a', ts: 1 });
    appendVoiceDebugEvent({ event: 'b', ts: 2 });
    appendVoiceDebugEvent({ event: 'c', ts: 3 });
    expect(readVoiceDebugEvents().map((e) => e.ts)).toEqual([3, 2, 1]);
  });

  it('filters to events strictly after `since`', () => {
    for (const ts of [1, 2, 3]) appendVoiceDebugEvent({ event: 'e', ts });
    expect(readVoiceDebugEvents(2).map((e) => e.ts)).toEqual([3]);
  });

  it('returns at most the 100 newest', () => {
    for (let i = 1; i <= 150; i++) appendVoiceDebugEvent({ event: 'e', ts: i });
    const out = readVoiceDebugEvents();
    expect(out).toHaveLength(100);
    expect(out[0].ts).toBe(150); // newest first
    expect(out[99].ts).toBe(51);
  });
});

describe('clearVoiceDebugEvents', () => {
  it('empties the ring', () => {
    appendVoiceDebugEvent({ event: 'e', ts: 1 });
    clearVoiceDebugEvents();
    expect(readVoiceDebugEvents()).toEqual([]);
  });
});
