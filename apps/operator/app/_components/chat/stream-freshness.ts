/**
 * stream-freshness.ts — is the conversation you are looking at LIVE, or is it a
 * corpse that still looks alive?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * [owner 2026-08-12] "I sent a message to <an agent> in the gui chat ... but the
 * gui chat didn't updat it seems like the message was never sent to them."
 *
 * The message HAD been sent. Measured afterwards: it reached that agent 250 ms
 * after the send, and the agent answered 11 s later. Delivery, the wake, the
 * reply and the display filter were each verified working. What failed is that
 * the owner's pane stopped repainting — and the pane had no way to say so, so a
 * frozen transcript and a live one were pixel-identical. With nothing on screen
 * to distinguish them, the only reading available to the owner was "my message
 * never went anywhere", which was false and cost real time to disprove.
 *
 * That is a DETECTOR failure, and it is the half worth fixing: the specific
 * repaint bug died with the webview (the app was restarted three minutes later,
 * taking its console and network state with it), but "the pane cannot tell you
 * it went deaf" is reproducible, permanent, and independent of whatever the
 * original cause turns out to have been.
 *
 * ── What the banner ladder could see BEFORE this ────────────────────────────
 *
 * `SessionChatModal` had three states: connecting-with-no-events, `status ===
 * 'error'`, and live-but-empty. `status` only becomes `'error'` via the
 * transport's `onError`, which fires after `maxConsecutiveFailures` (3)
 * consecutive failures with ZERO successful opens. So the two shapes that
 * actually produce a silently-stale pane both slipped through:
 *
 *   1. a connection that is retrying and sometimes succeeding (open → zombie →
 *      reconnect → open), which never accumulates 3 clean failures; and
 *   2. a connection the transport still considers OPEN that has simply stopped
 *      delivering.
 *
 * `createResilientEventSource` already distinguishes both — it publishes a
 * `'failing'` status the moment it schedules a backoff or trips its 45 s zombie
 * watchdog, and that signal was being dropped on the floor rather than shown.
 * This module is the reuse of it, not a new mechanism.
 *
 * ── The rule that keeps it honest ───────────────────────────────────────────
 *
 * A QUIET AGENT IS NOT A BROKEN STREAM, and conflating them would be worse than
 * the bug: most agents are idle most of the time, so a detector keyed on "no
 * transcript entries lately" would cry wolf constantly and be ignored by the
 * time it mattered. Liveness is therefore keyed on the TRANSPORT's own signal
 * (heartbeats, which the server sends every 15 s regardless of whether the agent
 * is doing anything) and never on transcript activity.
 *
 * PURE → unit-tested, no React, no clock of its own (the caller passes `nowMs`).
 */

/** The transport's own status, as `createResilientEventSource` publishes it. */
export type TransportStatus = 'idle' | 'connecting' | 'open' | 'failing' | 'closed';

/**
 * How long the pane tolerates total silence from an ostensibly-open stream
 * before it says so.
 *
 * The server heartbeats every 15 s and the transport's own zombie watchdog
 * force-reconnects at 45 s, so this sits just past the watchdog: if the stream
 * were merely jittery, the transport would have already rebuilt it and told us
 * via `'failing'`. Silence that outlives BOTH means the pane is looking at
 * something no longer being fed, which is precisely the state the owner could
 * not see.
 */
export const STREAM_SILENCE_STALE_MS = 60_000;

export interface StreamFreshnessInput {
  /** The transport's status. `undefined` when the caller has not wired it. */
  transport?: TransportStatus;
  /** Epoch ms of the last inbound signal of ANY kind (heartbeat included). */
  lastSignalAtMs: number | null;
  /** Now, injected so this stays pure and testable. */
  nowMs: number;
}

export type StreamFreshness =
  /** Signals are arriving on schedule — what the pane shows is current. */
  | 'fresh'
  /** The transport is retrying: dropped, or its zombie watchdog tripped. */
  | 'reconnecting'
  /** Nominally open, but nothing has arrived for STREAM_SILENCE_STALE_MS. */
  | 'stale'
  /**
   * Not enough information to judge — no transport status wired AND no signal
   * recorded yet. Deliberately NOT folded into 'stale': claiming a connection
   * is dead because we never looked is the same false-confidence failure in the
   * opposite direction, and it would fire on every pane during its first frames.
   */
  | 'unknown';

/**
 * Classify what the viewer is actually looking at.
 *
 * Order matters. The transport's own verdict OUTRANKS the silence timer,
 * because `'failing'` is a positive observation ("I tried and could not") while
 * silence is an absence of evidence — and a reconnecting stream is legitimately
 * silent while it backs off, so checking silence first would report the vaguer
 * of two available answers.
 */
export function classifyStreamFreshness(input: StreamFreshnessInput): StreamFreshness {
  const { transport, lastSignalAtMs, nowMs } = input;

  if (transport === 'failing' || transport === 'connecting') return 'reconnecting';
  // A closed stream is not stale, it is over — the pane's `done`/composer state
  // already speaks for that, and a second alarm would be noise.
  if (transport === 'closed' || transport === 'idle') return 'unknown';

  if (lastSignalAtMs === null) return 'unknown';
  // Guard a clock that jumped backwards (NTP step, suspend/resume): a negative
  // age is not evidence of freshness OR staleness, so do not invent either.
  const age = nowMs - lastSignalAtMs;
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  return age >= STREAM_SILENCE_STALE_MS ? 'stale' : 'fresh';
}

/**
 * What to tell the owner. `null` for every state that needs no banner, so the
 * caller can render it directly without re-deciding.
 *
 * The wording commits to the distinction the owner actually needed: it says the
 * CONVERSATION MAY BE BEHIND, never that their message failed — that inference
 * is exactly the one that was wrong, and a banner that implied it would be
 * automating the original mistake.
 */
export function streamFreshnessMessage(freshness: StreamFreshness): string | null {
  switch (freshness) {
    case 'reconnecting':
      return 'Reconnecting to this session — new messages may not appear until it recovers.';
    case 'stale':
      return "No update from this session in a while — it may be behind. Anything you've sent was still delivered.";
    default:
      return null;
  }
}
