/**
 * reset-backoff.ts — EI-1404: parse a "weekly limit · resets <time>" (or similar
 * usage/rate-limit reset hint) out of a dead worker's captured output, and turn it
 * into an absolute HOLD-UNTIL instant.
 *
 * Observed live (EI-1404, overnight 2026-07-16/17): the auto-implement dispatcher
 * re-fired EI-89/EI-17/EI-170/EI-172 roughly every 1-2h all night, every attempt
 * dying instantly on `worker exit 1 … You've hit your weekly limit · resets 7am
 * (America/New_York)`. The death is correctly classified as an env failure
 * (isEnvFailureExit, implement-worker-exit.ts) so it isn't charged — but nothing
 * stopped the NEXT tick from re-dispatching the same item into the same closed
 * window. The lane-wide `laneInEnvOutage` pause (P-032, orphaned-dispatch.ts)
 * requires >=2 env deaths inside a 90-minute window to engage; at a dispatch
 * cadence slower than that window, a death always ages out before the next one
 * lands, so the pause never trips against a quiet, isolated once-an-hour bounce —
 * exactly the shape this bug describes.
 *
 * This is the cheap, PER-ITEM fix the bug's own body proposes: when the death text
 * names an exact reset time, parse it and hold re-dispatch for THAT item until the
 * reset, instead of the generic hourly retry cadence. Self-correcting — every item
 * that dies on the same account-limit gets its own hold stamped independently, no
 * cross-item bookkeeping needed. Complementary to (not a replacement for)
 * laneInEnvOutage, which still catches the true SPIKE (many distinct items dying
 * back-to-back).
 *
 * Pure + IO-free (no PG, no clock ambient — `nowMs` is always passed in) so every
 * shape is unit-testable without a live process.
 */
import { createRequire } from 'node:module';

// luxon ships no type declarations in this install (see schedule-next.ts's identical
// note) — load it via createRequire (the repo's ESM-safe CJS pattern) with a minimal
// local type for the slice used here: resolving a WALL-CLOCK time-of-day in a given
// IANA zone to the correct absolute UTC instant (DST-correct, unlike a naive fixed
// UTC-offset guess).
interface LuxonDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  setZone(zone: string): LuxonDateTime;
  set(o: { hour: number; minute: number; second: number; millisecond: number }): LuxonDateTime;
  plus(o: { days: number }): LuxonDateTime;
  toMillis(): number;
  isValid: boolean;
}
const { DateTime } = createRequire(import.meta.url)('luxon') as {
  DateTime: { fromMillis(ms: number, opts?: { zone?: string }): LuxonDateTime };
};

/**
 * Matches "resets 7am", "resets 7:30pm", optionally followed by a parenthesized
 * IANA-ish zone name — "resets 7am (America/New_York)". Deliberately narrow (the
 * live shape); a reset hint with no parseable clock time returns null rather than
 * guessing.
 */
const RESET_TIME_RE = /\bresets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

export interface ResetHold {
  /** Absolute instant (epoch ms) to hold re-dispatch until. */
  holdUntilMs: number;
  /** The matched substring, for the ledger/payload detail. */
  raw: string;
  /** The IANA zone used, when one was present in the text. */
  tzid?: string;
}

/**
 * True-looking IANA zone id — a bare sanity check ("Region/City", optionally with
 * an underscore/second slash) so junk parenthetical text ("resets 7am (ish)")
 * doesn't get treated as a zone and silently mis-resolve the hold instant.
 */
function looksLikeIanaZone(s: string): boolean {
  return /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(s.trim());
}

/**
 * Parse a "resets <time>[am|pm][ (<tz>)]" hint out of `text` and resolve it to the
 * NEXT future occurrence of that wall-clock time (today if still ahead of `nowMs`,
 * else tomorrow) — null when no such hint is present, or the parsed pieces don't
 * resolve to a valid instant. When a zone is present it is resolved DST-correctly
 * via luxon; when absent, the hour/minute is treated as the PROCESS's own local
 * time (Node's `Date` local-zone rules) as the best available fallback — still far
 * more precise than the generic 90-minute env-outage window.
 */
export function parseResetHoldUntil(text: string | undefined | null, nowMs: number): ResetHold | null {
  if (!text) return null;
  const m = RESET_TIME_RE.exec(text);
  if (!m) return null;
  const rawHour = Number.parseInt(m[1], 10);
  const rawMinute = m[2] ? Number.parseInt(m[2], 10) : 0;
  const meridiem = m[3].toLowerCase();
  if (!Number.isFinite(rawHour) || rawHour < 1 || rawHour > 12 || rawMinute < 0 || rawMinute > 59) return null;
  let hour24 = rawHour % 12;
  if (meridiem === 'pm') hour24 += 12;
  const tzid = m[4] && looksLikeIanaZone(m[4]) ? m[4].trim() : undefined;

  let holdUntilMs: number;
  if (tzid) {
    const nowInZone = DateTime.fromMillis(nowMs, { zone: tzid });
    if (!nowInZone.isValid) return null; // an unrecognized zone name — don't guess
    let candidate = nowInZone.set({ hour: hour24, minute: rawMinute, second: 0, millisecond: 0 });
    if (candidate.toMillis() <= nowMs) candidate = candidate.plus({ days: 1 });
    holdUntilMs = candidate.toMillis();
  } else {
    const now = new Date(nowMs);
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour24, rawMinute, 0, 0);
    if (candidate.getTime() <= nowMs) candidate.setDate(candidate.getDate() + 1);
    holdUntilMs = candidate.getTime();
  }
  if (!Number.isFinite(holdUntilMs)) return null;
  return { holdUntilMs, raw: m[0], ...(tzid ? { tzid } : {}) };
}
