// @vitest-environment node
/**
 * psu-pty-host.test.ts — pure-logic unit tests for the managed-pty host
 * (turn-lifecycle-control Phase 3, P-012/P-013). The real-pty round-trip
 * (spawn → socket-inject → cleanup) lives in psu-pty-host.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeKey,
  socketPathFor,
  metaPathFor,
  encodeControl,
  decodeControl,
  controlBytes,
  controlWrites,
  makeIdleGate,
  makeActivityTracker,
  ACTIVITY_PERSIST_MS,
  PSU_PTY_DIR,
} from '../scripts/psu-pty-host.mjs';

describe('sanitizeKey', () => {
  it('passes SID-shaped ids through unchanged', () => {
    expect(sanitizeKey('su-a4bf457e-6f4a-4ee1-8682-8da0749c701b')).toBe(
      'su-a4bf457e-6f4a-4ee1-8682-8da0749c701b',
    );
  });
  it('escapes path-traversal + separators (no escaping the dir)', () => {
    expect(sanitizeKey('su/../../etc/passwd')).toBe('su_.._.._etc_passwd');
    expect(sanitizeKey('a b\tc')).toBe('a_b_c');
  });
  it('bounds length + tolerates empty/undefined', () => {
    expect(sanitizeKey('x'.repeat(500)).length).toBe(200);
    expect(sanitizeKey('')).toBe('unknown');
    // @ts-expect-error exercising the undefined path
    expect(sanitizeKey(undefined)).toBe('unknown');
  });
});

describe('socketPathFor / metaPathFor', () => {
  it('derive sibling .sock / .json paths under PSU_PTY_DIR', () => {
    expect(socketPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.sock`);
    expect(metaPathFor('su-x')).toBe(`${PSU_PTY_DIR}/su-x.json`);
  });
});

describe('control wire protocol (v1)', () => {
  it('turn envelope → idle-gated, CR-terminated turn', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(d).toEqual({ mode: 'turn', data: 'hello', gated: true });
    expect(controlBytes(d)).toBe('hello\r');
  });
  it('raw envelope → immediate, verbatim bytes (force interrupt)', () => {
    const d = decodeControl(encodeControl({ mode: 'raw', data: '' })); // Ctrl-C
    expect(d).toEqual({ mode: 'raw', data: '', gated: false });
    expect(controlBytes(d)).toBe('');
  });
  it('Esc force interrupt round-trips', () => {
    expect(controlBytes(decodeControl(encodeControl({ mode: 'raw', data: '' })))).toBe('');
  });
  it('a non-envelope payload is a legacy idle-gated turn (psupty back-compat)', () => {
    const d = decodeControl('just some text');
    expect(d).toEqual({ mode: 'turn', data: 'just some text', gated: true });
    expect(controlBytes(d)).toBe('just some text\r');
  });
  it('an unknown/garbage JSON object falls back to a legacy turn', () => {
    const d = decodeControl('{"v":2,"mode":"weird"}');
    expect(d.mode).toBe('turn');
    expect(d.gated).toBe(true);
  });
});

describe('controlWrites — a turn submits via a SEPARATE delayed CR (paste-detector fix)', () => {
  it('a turn is TWO steps: the text now, then the submit CR after a delay', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'wake-turn' }));
    expect(controlWrites(d, 150)).toEqual([
      { data: 'wake-turn', delayMs: 0 },
      { data: '\r', delayMs: 150 },
    ]);
    // The CR is its OWN step — never concatenated onto the text (which the TUI's
    // paste detector would swallow as a literal newline → unsubmitted turn).
    const steps = controlWrites(d, 150);
    expect(steps[0].data).not.toContain('\r');
    expect(steps[1]).toEqual({ data: '\r', delayMs: 150 });
  });
  it('a raw (force-interrupt) message is ONE immediate verbatim write — no CR appended', () => {
    const ctrlC = decodeControl(encodeControl({ mode: 'raw', data: '\x03' }));
    expect(controlWrites(ctrlC)).toEqual([{ data: '\x03', delayMs: 0 }]);
  });
  it('the total bytes still match controlBytes (text + CR), just delivered in two writes', () => {
    const d = decodeControl(encodeControl({ mode: 'turn', data: 'hello' }));
    expect(controlWrites(d).map((s) => s.data).join('')).toBe(controlBytes(d));
  });
});

describe('makeIdleGate (P-013 mid-keystroke safety)', () => {
  it('is idle immediately when nothing was ever typed', () => {
    const g = makeIdleGate({ idleMs: 100, now: () => 1000 });
    expect(g.remainingIdleMs(1000)).toBe(0);
  });
  it('reports the remaining wait right after a keystroke, then idle', () => {
    let t = 1000;
    const g = makeIdleGate({ idleMs: 100, now: () => t });
    g.touch(); // typed at t=1000
    expect(g.remainingIdleMs(1000)).toBe(100); // must wait the full window
    expect(g.remainingIdleMs(1050)).toBe(50); // halfway
    expect(g.remainingIdleMs(1100)).toBe(0); // window elapsed → idle
    expect(g.remainingIdleMs(1200)).toBe(0); // stays idle
  });
  it('waitIdle resolves immediately when already idle', async () => {
    const g = makeIdleGate({ idleMs: 50, capMs: 1000 });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(false);
  });
  it('waitIdle defers a write while typing continues, bounded by capMs', async () => {
    // Tiny idle window + tiny cap: never goes idle (we keep "typing" via a clock
    // that always advances less than idleMs since the last touch) → cap fires.
    let t = 0;
    const g = makeIdleGate({ idleMs: 1_000_000, capMs: 30, now: () => (t += 10) });
    const r = await g.waitIdle();
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe('idle-cap');
  });
});

/**
 * makeActivityTracker (liveness-hardening P-006/P-007): the output-side
 * sibling of makeIdleGate. lastOutputAt fresh = the agent is emitting RIGHT
 * NOW (a generating TUI repaints constantly); lastActivityAt = max(in, out).
 * Annotate-only (plan D-002) — display/triage, never claim release.
 */
describe('makeActivityTracker (P-006 mid-turn activity)', () => {
  it('starts with null activity (never seen)', () => {
    const a = makeActivityTracker({ now: () => 123 });
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: null, lastActivityAt: null });
  });

  it('tracks input and output independently; lastActivityAt is the max', () => {
    let t = 100;
    const a = makeActivityTracker({ now: () => t });
    a.touchInput();
    t = 250;
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: 100, lastOutputAt: 250, lastActivityAt: 250 });
    t = 400;
    a.touchInput();
    expect(a.snapshot().lastActivityAt).toBe(400);
    expect(a.snapshot().lastOutputAt).toBe(250);
  });

  it('output alone marks the session active (the heads-down generating case)', () => {
    let t = 7;
    const a = makeActivityTracker({ now: () => t });
    a.touchOutput();
    expect(a.snapshot()).toEqual({ lastInputAt: null, lastOutputAt: 7, lastActivityAt: 7 });
  });

  it('persist cadence is coarse (≥5s) so the pty bridge never becomes an fs hot loop', () => {
    expect(ACTIVITY_PERSIST_MS).toBeGreaterThanOrEqual(5_000);
  });
});
