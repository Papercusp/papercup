/**
 * Guards for the chat pane's staleness detector (gui-chat-pane-repaint-2026-08-12
 * P-003). The failure being prevented: a pane that has gone deaf looks exactly
 * like a live one, so the owner reads "my message never sent" off a transcript
 * that simply stopped repainting.
 *
 * The two directions are NOT symmetric, and the tests are weighted accordingly:
 *   - a MISSED stale stream costs the owner an investigation (the reported bug);
 *   - a FALSE stale alarm on a merely-idle agent is worse long-term, because
 *     most agents are idle most of the time and a banner that is usually wrong
 *     gets ignored exactly when it is finally right.
 * So "quiet agent is not a broken stream" gets its own explicit case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResilientEventSource, DEFAULT_ZOMBIE_TIMEOUT_MS } from '@papercusp/sse';
import {
  STREAM_SILENCE_STALE_MS,
  classifyStreamFreshness,
  streamFreshnessMessage,
  type TransportStatus,
} from './stream-freshness';

const NOW = new Date('2026-08-12T09:00:00Z').getTime();
const at = (msAgo: number) => NOW - msAgo;

describe('classifyStreamFreshness', () => {
  it('a stream delivering on schedule is fresh — no banner', () => {
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(5_000), nowMs: NOW });
    expect(f).toBe('fresh');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  /**
   * THE ANTI-CRY-WOLF CASE. The server heartbeats every 15s whether or not the
   * agent is doing anything, so an idle agent still produces signals. A detector
   * keyed on transcript activity instead would fire here — and be wrong.
   */
  it('an IDLE agent is not a broken stream, as long as the transport is still beating', () => {
    // No transcript entries for an hour, but a heartbeat 3s ago.
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(3_000), nowMs: NOW });
    expect(f).toBe('fresh');
  });

  it('silence past the threshold on an open stream is STALE — the reported symptom', () => {
    const f = classifyStreamFreshness({
      transport: 'open',
      lastSignalAtMs: at(STREAM_SILENCE_STALE_MS + 1),
      nowMs: NOW,
    });
    expect(f).toBe('stale');
    expect(streamFreshnessMessage(f)).toMatch(/may be behind/i);
  });

  it('is exactly at-or-past the threshold, not merely near it', () => {
    const open = (msAgo: number) =>
      classifyStreamFreshness({ transport: 'open', lastSignalAtMs: at(msAgo), nowMs: NOW });
    expect(open(STREAM_SILENCE_STALE_MS - 1)).toBe('fresh');
    expect(open(STREAM_SILENCE_STALE_MS)).toBe('stale');
  });

  /**
   * The transport's verdict outranks the timer: `failing` is a positive
   * observation, silence is an absence of evidence. A backing-off stream is
   * legitimately silent, so timer-first would report the vaguer of two answers.
   */
  it("a retrying transport reads as 'reconnecting' even when it has also gone silent", () => {
    const f = classifyStreamFreshness({
      transport: 'failing',
      lastSignalAtMs: at(STREAM_SILENCE_STALE_MS * 10),
      nowMs: NOW,
    });
    expect(f).toBe('reconnecting');
    expect(streamFreshnessMessage(f)).toMatch(/reconnecting/i);
  });

  it('treats an initial connect as reconnecting rather than stale', () => {
    expect(classifyStreamFreshness({ transport: 'connecting', lastSignalAtMs: null, nowMs: NOW })).toBe(
      'reconnecting',
    );
  });

  /**
   * A closed stream is not stale, it is over. The composer/`done` state already
   * says so and a second alarm would be noise.
   */
  it.each(['closed', 'idle'] as TransportStatus[])('%s is unknown, not an alarm', (transport) => {
    const f = classifyStreamFreshness({ transport, lastSignalAtMs: at(999_999), nowMs: NOW });
    expect(f).toBe('unknown');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  /**
   * Never claim a connection is dead because we never looked. This fires on
   * every pane's first frames, and a banner there would be pure noise.
   */
  it('reports unknown — never stale — when nothing has been observed yet', () => {
    expect(classifyStreamFreshness({ transport: undefined, lastSignalAtMs: null, nowMs: NOW })).toBe(
      'unknown',
    );
    expect(classifyStreamFreshness({ transport: 'open', lastSignalAtMs: null, nowMs: NOW })).toBe(
      'unknown',
    );
  });

  it('a backwards clock jump (NTP step, suspend/resume) invents neither verdict', () => {
    const f = classifyStreamFreshness({ transport: 'open', lastSignalAtMs: NOW + 30_000, nowMs: NOW });
    expect(f).toBe('unknown');
    expect(streamFreshnessMessage(f)).toBeNull();
  });

  it('works with no transport wired at all, falling back to the silence timer', () => {
    expect(classifyStreamFreshness({ lastSignalAtMs: at(1_000), nowMs: NOW })).toBe('fresh');
    expect(classifyStreamFreshness({ lastSignalAtMs: at(STREAM_SILENCE_STALE_MS), nowMs: NOW })).toBe(
      'stale',
    );
  });
});

describe('streamFreshnessMessage', () => {
  /**
   * The wording is load-bearing. "My message never sent" was the owner's
   * (incorrect) inference; a banner that implied it would automate the very
   * mistake this exists to prevent. It must speak about the VIEW being behind,
   * and must not cast doubt on delivery.
   */
  it('never suggests the message failed to send', () => {
    for (const f of ['reconnecting', 'stale'] as const) {
      const msg = streamFreshnessMessage(f);
      expect(msg).toBeTruthy();
      expect(msg).not.toMatch(/fail|not sent|never sent|undelivered|error/i);
    }
  });

  it('affirms delivery on the stale banner, which is the reassurance that was missing', () => {
    expect(streamFreshnessMessage('stale')).toMatch(/still delivered/i);
  });

  it('stays silent for the states that need no banner', () => {
    expect(streamFreshnessMessage('fresh')).toBeNull();
    expect(streamFreshnessMessage('unknown')).toBeNull();
  });
});

/* ── REACHABILITY (EI-20265888603098901) ────────────────────────────────────
 *
 * Every test above injects `{ transport, lastSignalAtMs }` by hand, and that is
 * precisely why they all passed while `'stale'` was dead code from the first
 * commit. A pure classifier tested by injection answers "given this state, what
 * do you say?" — it CANNOT answer "can the system ever be in this state?", and
 * the unreachable combination is the easiest one of all to construct by hand.
 *
 * The bug: `'stale'` needs `transport === 'open'` plus 60 s of silence, but one
 * `signal()` seam drove both timers, so the transport's 45 s zombie watchdog
 * always fired first, flipped the status to `'failing'`, and the classifier
 * returned `'reconnecting'` on that alone. The banner written for the owner's
 * actual incident could never render.
 *
 * So this block drives the REAL transport (its real watchdog, its real status
 * transitions) against the REAL classifier, and substitutes only the React
 * plumbing. Run it against `STREAM_SILENCE_STALE_MS = 60_000` and it fails —
 * which is the point.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners: { type: string; fn: (ev: unknown) => void }[] = [];
  readyState = 0;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (ev: unknown) => void) { this.listeners.push({ type, fn }); }
  close() { this.readyState = 2; }
  fireOpen() {
    this.readyState = 1;
    for (const e of this.listeners) if (e.type === 'open') e.fn({ data: '', type: 'open' });
  }
}

describe('the stale rung is REACHABLE against the real transport', () => {
  beforeEach(() => { FakeEventSource.instances = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('is ordered below the transport zombie timeout, or it can never fire', () => {
    // The structural tie. Without this, the two constants live in different
    // packages with nothing relating them, and either can be moved into an
    // unreachable configuration without a single test going red.
    expect(STREAM_SILENCE_STALE_MS).toBeLessThan(DEFAULT_ZOMBIE_TIMEOUT_MS);
    // ...and far enough above the 15 s server heartbeat that ONE dropped beat is
    // not enough to cry wolf. A false alarm on an idle agent is the worse error.
    expect(STREAM_SILENCE_STALE_MS).toBeGreaterThan(2 * 15_000);
  });

  it('says stale on a silent-but-open stream, then escalates to reconnecting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    let transport: TransportStatus | undefined;
    let lastSignalAtMs: number | null = null;
    createResilientEventSource({
      url: 'http://x/sse',
      handlers: {},
      eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      onStatusChange: (s) => { transport = s as TransportStatus; },
      onSignal: () => { lastSignalAtMs = Date.now(); },
    });
    FakeEventSource.instances.at(-1)!.fireOpen();

    const verdict = () => classifyStreamFreshness({ transport, lastSignalAtMs, nowMs: Date.now() });
    expect(transport).toBe('open');
    expect(verdict()).toBe('fresh');

    // Total silence from here — not even a heartbeat.
    vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS);
    expect(transport).toBe('open'); // the transport has NOT given up yet...
    expect(verdict()).toBe('stale'); // ...so this rung is the one the owner sees.

    // The transport then gives up, and the banner escalates rather than vanishing.
    vi.advanceTimersByTime(DEFAULT_ZOMBIE_TIMEOUT_MS - STREAM_SILENCE_STALE_MS);
    expect(verdict()).toBe('reconnecting');
  });

  /* The CONTROL for the two tests above. A guard that has never failed is a
   * guard you have not tested — but the honest way to prove this one bites is
   * not to hand-mutate the constant (the shared tree is swept into commits every
   * few minutes, so a mutation window is a committed mutant waiting to happen).
   * Instead this pins the DEFECT itself, permanently: at the 60 s the detector
   * shipped with, the precondition `'stale'` requires is already gone. If some
   * later change makes this pass, the transport's escalation has moved and the
   * ordering above needs re-deriving, not re-blessing. */
  it('CONTROL: at the shipped 60s mark the transport has already escalated, which is why it was dead', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    let transport: TransportStatus | undefined;
    let lastSignalAtMs: number | null = null;
    createResilientEventSource({
      url: 'http://x/sse',
      handlers: {},
      eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      onStatusChange: (s) => { transport = s as TransportStatus; },
      onSignal: () => { lastSignalAtMs = Date.now(); },
    });
    FakeEventSource.instances.at(-1)!.fireOpen();

    vi.advanceTimersByTime(60_000);
    // `'stale'` needs transport === 'open'. It is not, and cannot be, at 60 s.
    expect(transport).not.toBe('open');
    expect(classifyStreamFreshness({ transport, lastSignalAtMs, nowMs: Date.now() })).toBe('reconnecting');
  });

  it('never fires on a merely-idle agent, because heartbeats are signals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    let transport: TransportStatus | undefined;
    let lastSignalAtMs: number | null = null;
    createResilientEventSource({
      url: 'http://x/sse',
      handlers: {},
      eventSourceCtor: FakeEventSource as unknown as typeof EventSource,
      onStatusChange: (s) => { transport = s as TransportStatus; },
      onSignal: () => { lastSignalAtMs = Date.now(); },
    });
    const es = FakeEventSource.instances.at(-1)!;
    es.fireOpen();

    // An agent doing nothing for five minutes, on a perfectly healthy stream:
    // the server still heartbeats every 15 s and the wrapper routes those
    // through the same `signal()` seam.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(15_000);
      for (const e of es.listeners) if (e.type === 'heartbeat') e.fn({ data: '', type: 'heartbeat' });
    }
    expect(transport).toBe('open');
    expect(classifyStreamFreshness({ transport, lastSignalAtMs, nowMs: Date.now() })).toBe('fresh');
  });
});
