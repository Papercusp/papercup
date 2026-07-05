/**
 * Watchdog AUTO-CLOSE lifecycle (watchdog-and-exposed-systems-improvement-2026-06-18
 * P-009 / D-002). The watchdog escalates a long-open EI (known-open-aging) but never
 * RETIRES one whose underlying problem has CLEARED — so the backlog only grows (the
 * 2026-06-17 audit found 51 red-test EIs with 0 live reds, plus benchmark debris and
 * stopped-recurring tool errors all sitting open). This sweep closes a watchdog-sourced
 * EI once its signal has been ABSENT from the recent ran-ticks' known-open keys for
 * `minAbsentTicks` consecutive ticks — i.e. the signal stopped firing, so the problem
 * is gone. If it recurs, the watchdog simply re-files it (search-first dedup).
 *
 * SAFETY: auto-closing real improvement items is dangerous, so the decision is heavily
 * guarded (open + watchdog-keyed + organic + no LIVE in-flight dispatch + eligible
 * source + old enough + enough tick history) AND the whole sweep is gated by a
 * DEFAULT-OFF flag (`FLAGS.WATCHDOG_AUTO_CLOSE`) — inert until the owner enables it.
 * NOTE (EI-7317): a bare `assignee` does NOT block retirement on its own — only a live
 * `in-flight-dispatch` row means someone is genuinely still working it. An assignee left
 * over from a resolved/abandoned dispatch is not active work; see decideAutoClose.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import {
  listIssues,
  setIssueState,
  commentIssue,
  type EngineerIssue,
} from '../../issues-engineer';
import { watchdogSourceOf } from './policy';
import { effectiveOrigin, DEFAULT_SIGNAL_ORIGIN } from './provenance';

/**
 * Sources where a signal's ABSENCE reliably means the problem resolved (the
 * collector runs every tick and would re-fire if it persisted). Conservative
 * allowlist — live-state/one-shot/ambiguous sources stay out so a quiet tick is
 * never mistaken for a resolution.
 */
export const AUTO_CLOSE_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set([
  'red-test',
  'repeated-tool-error',
  'stalled-feature',
  'unresolved-escalation',
  'failed-spawn',
  'smoke-fail',
  'escalation-spike',
  'fire-circuit-open',
  // P-011: per-harness sources whose absence reliably means resolution (a torn-down
  // benchmark hive's saturation/orphan/stuck signal simply stops). Added so auto-close
  // retires the full benchmark-debris set (governor-starvation was the gap — 27 EIs).
  'governor-starvation',
  'orphaned-spawn',
  'stuck-plan',
  'ship-link-stuck',
  // agent-activity-liveness-truth P-007: a live-state collector — when the claim
  // progresses (or is freed/reclaimed) the stalled signal simply stops, so its
  // absence reliably means resolution.
  'stalled-claim',
  // EI-5994: collectLoopStalledSignals filters `r.active = true` — once the dead-owner
  // reaper (loop-unreachable-guard / autoPauseLoopRoutine) deactivates the routine, this
  // signal STOPS firing immediately and unconditionally (not just recency-gated), so its
  // absence reliably means the underlying loop is gone/paused, not merely quiet.
  'loop-stalled',
]);

/** The minimal shape the pure decision needs (an EngineerIssue maps onto it). */
export interface AutoCloseCandidate {
  issueId: string;
  /** payload.watchdogKey (`<source>:<key>`). */
  watchdogKey: string;
  state: string;
  assignee: string | null;
  /** ms epoch of created_at. */
  createdAtMs: number;
  /** provenance (organic | drill | replay | shadow). */
  signalOrigin: string;
  /** An open, unresolved dispatch ledger row exists for this item. */
  inFlightDispatch: boolean;
}

/** The recent-tick context the decision reads against. */
export interface AutoCloseTickContext {
  /** Union of `known_open_keys` across the last `ranTickCount` ran-ticks (the
   *  "still-firing" set). A key absent from this set was absent from ALL of them. */
  seenKeys: ReadonlySet<string>;
  /** How many ran-ticks the window held (must be ≥ minAbsentTicks to act). */
  ranTickCount: number;
  nowMs: number;
}

export interface AutoCloseOptions {
  /** Consecutive ran-ticks a signal must be absent before its EI auto-closes. Default 6 (~90min). */
  minAbsentTicks?: number;
  /** An EI younger than this never auto-closes (its signal may not have hit known-open yet). Default 90min. */
  minIssueAgeMs?: number;
}

export const AUTO_CLOSE_DEFAULT_MIN_TICKS = 6;
export const AUTO_CLOSE_DEFAULT_MIN_AGE_MS = 90 * 60_000;

export interface AutoCloseDecision {
  close: boolean;
  reason: string;
}

/**
 * Pure: should this candidate auto-close? Returns `{close:false, reason}` for every
 * guard so the decision is fully observable + unit-tested. Closes ONLY when the
 * signal has verifiably stopped firing and the item is safe to retire untouched.
 */
export function decideAutoClose(
  c: AutoCloseCandidate,
  ctx: AutoCloseTickContext,
  opts: AutoCloseOptions = {},
): AutoCloseDecision {
  const minTicks = opts.minAbsentTicks ?? AUTO_CLOSE_DEFAULT_MIN_TICKS;
  const minAge = opts.minIssueAgeMs ?? AUTO_CLOSE_DEFAULT_MIN_AGE_MS;
  if (c.state !== 'open') return { close: false, reason: 'not-open' };
  if (!c.watchdogKey) return { close: false, reason: 'no-watchdog-key' };
  if (effectiveOrigin(c.signalOrigin) !== DEFAULT_SIGNAL_ORIGIN) return { close: false, reason: 'non-organic' };
  if (!AUTO_CLOSE_ELIGIBLE_SOURCES.has(watchdogSourceOf(c.watchdogKey))) {
    return { close: false, reason: 'ineligible-source' };
  }
  // EI-7317: an `assignee` alone must NOT block retirement — only a LIVE in-flight
  // dispatch means genuinely active work. Once a dispatch resolves (or a watchdog
  // routine it was chasing is deactivated/deleted) the `assignee` column is never
  // cleared, so a signal that has verifiably stopped firing was staying open+assigned
  // forever and getting re-dispatched indefinitely (concrete case: EI-3901 — the
  // underlying loop was deactivated 2026-07-01, but the EI re-dispatched on
  // 2026-07-04, burning a full worker run to rediscover the bug was already gone).
  // inFlightDispatch is the only signal that means "do not touch, someone is on it".
  if (c.inFlightDispatch) return { close: false, reason: 'in-flight-dispatch' };
  if (ctx.ranTickCount < minTicks) return { close: false, reason: 'insufficient-tick-history' };
  if (!Number.isFinite(c.createdAtMs) || ctx.nowMs - c.createdAtMs < minAge) {
    return { close: false, reason: 'too-new' };
  }
  if (ctx.seenKeys.has(c.watchdogKey)) return { close: false, reason: 'still-firing' };
  const abandonedAssignmentNote = c.assignee != null ? ' (assignee present but no live in-flight dispatch — abandoned assignment, not active work)' : '';
  return {
    close: true,
    reason: `signal absent from known-open keys for ≥${minTicks} ran-ticks — evidence cleared${abandonedAssignmentNote}`,
  };
}

export interface AutoCloseOutcome {
  issueId: string;
  watchdogKey: string;
  reason: string;
}

interface CanonicalWatchdogIssue {
  id: string;
  watchdogKey: string;
  updatedAtMs: number;
  createdAtMs: number;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

export interface AutoCloseDeps {
  listOpen: () => Promise<EngineerIssue[]>;
  recentRanTickKeys: (n: number) => Promise<{ seenKeys: Set<string>; ranTickCount: number }>;
  inFlightDispatchIds: (ids: string[]) => Promise<Set<string>>;
  close: (id: string, watchdogKey: string, reason: string) => Promise<void>;
  nowMs: () => number;
}

const watchdogKeyOfIssue = (i: EngineerIssue): string => {
  const p = i.payload && typeof i.payload === 'object' ? (i.payload as Record<string, unknown>) : {};
  return typeof p.watchdogKey === 'string' ? p.watchdogKey : '';
};

const issueUpdatedAtMs = (i: EngineerIssue): number => {
  const ms = Date.parse(i.updatedAt ?? '');
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

const issueCreatedAtMs = (i: EngineerIssue): number => {
  const ms = Date.parse(i.createdAt ?? '');
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

function selectCanonicalOpenIssues(open: EngineerIssue[]): {
  canonicalByKey: Map<string, CanonicalWatchdogIssue>;
  duplicates: Array<{ issueId: string; watchdogKey: string; keepId: string }>;
} {
  const canonicalByKey = new Map<string, CanonicalWatchdogIssue>();
  const duplicates: Array<{ issueId: string; watchdogKey: string; keepId: string }> = [];

  for (const issue of open) {
    const watchdogKey = watchdogKeyOfIssue(issue);
    if (!watchdogKey) continue;
    const candidate: CanonicalWatchdogIssue = {
      id: issue.id,
      watchdogKey,
      updatedAtMs: issueUpdatedAtMs(issue),
      createdAtMs: issueCreatedAtMs(issue),
    };
    const existing = canonicalByKey.get(watchdogKey);
    if (!existing) {
      canonicalByKey.set(watchdogKey, candidate);
      continue;
    }
    const replace =
      candidate.updatedAtMs > existing.updatedAtMs
      || (candidate.updatedAtMs === existing.updatedAtMs && candidate.createdAtMs > existing.createdAtMs)
      || (candidate.updatedAtMs === existing.updatedAtMs
        && candidate.createdAtMs === existing.createdAtMs
        && candidate.id > existing.id);
    if (replace) {
      duplicates.push({ issueId: existing.id, watchdogKey, keepId: candidate.id });
      canonicalByKey.set(watchdogKey, candidate);
    } else {
      duplicates.push({ issueId: candidate.id, watchdogKey, keepId: existing.id });
    }
  }

  return { canonicalByKey, duplicates };
}

/** Default deps: the real PG-backed reads + close. */
export function defaultAutoCloseDeps(workspaceId: string): AutoCloseDeps {
  const { sql }: { sql: Sql } = getOrgPg();
  return {
    listOpen: () => listIssues({ state: 'open', limit: 500 }),
    recentRanTickKeys: async (n: number) => {
      const rows = await sql<{ known_open_keys: string[] }[]>`
        SELECT known_open_keys
          FROM harness_shared.watchdog_ticks
         WHERE workspace_id = ${workspaceId} AND status = 'ran'
         ORDER BY tick_at DESC
         LIMIT ${n}`;
      const seenKeys = new Set<string>();
      for (const r of rows) for (const k of r.known_open_keys ?? []) seenKeys.add(k);
      return { seenKeys, ranTickCount: rows.length };
    },
    inFlightDispatchIds: async (ids: string[]) => {
      if (ids.length === 0) return new Set();
      const rows = await sql<{ item_id: string }[]>`
        SELECT DISTINCT item_id
          FROM harness_shared.improvement_dispatches
         WHERE item_id = ANY(${ids}::text[]) AND resolved_at IS NULL`;
      return new Set(rows.map((r) => r.item_id));
    },
    close: async (id, watchdogKey, reason) => {
      await commentIssue(
        id,
        `🟢 Auto-resolved by the watchdog: ${reason}. Signal \`${watchdogKey}\` stopped firing — no fix was dispatched; the underlying condition cleared on its own. Re-files automatically if it recurs (search-first dedup). (P-009)`,
        'watchdog-auto-close',
      );
      // skipCompletionGate (WI-1403/WI-1404, contract C-1): the watchdog auto-close is a
      // DEDUP marker, not a genuine completion — "no fix was dispatched; the underlying
      // condition cleared on its own" is explicitly NOT evidence of completed work, so
      // this flip must never satisfy C-1's genuine-completion criteria.
      await setIssueState(id, 'resolved', 'watchdog-auto-close', undefined, { skipCompletionGate: true });
    },
    nowMs: () => Date.now(),
  };
}

/**
 * IO: the auto-close sweep for one tick. DEFAULT-OFF flag-gated — returns [] until the
 * owner enables `papercusp-watchdog-auto-close`. Reads open watchdog-keyed EIs, the
 * recent ran-tick known-open keys, and the in-flight dispatch set; closes each EI the
 * pure decision admits.
 */
export async function processAutoClose(
  workspaceId: string,
  opts: AutoCloseOptions = {},
  deps?: AutoCloseDeps,
): Promise<AutoCloseOutcome[]> {
  if (!(await getFlag(FLAGS.WATCHDOG_AUTO_CLOSE, `watchdog-auto-close:${workspaceId}`))) return [];
  const d = deps ?? defaultAutoCloseDeps(workspaceId);
  const minTicks = opts.minAbsentTicks ?? AUTO_CLOSE_DEFAULT_MIN_TICKS;

  const open = await d.listOpen();
  // Pre-filter to watchdog-keyed candidates before the (cheaper) tick + dispatch reads.
  const keyed = open.filter((i) => watchdogKeyOfIssue(i));
  if (keyed.length === 0) return [];
  const out: AutoCloseOutcome[] = [];

  const { canonicalByKey, duplicates } = selectCanonicalOpenIssues(keyed);
  for (const dup of duplicates) {
    try {
      const reason = `duplicate of ${dup.keepId} — canonical open watchdog item retained for \`${dup.watchdogKey}\``;
      await d.close(dup.issueId, dup.watchdogKey, reason);
      out.push({ issueId: dup.issueId, watchdogKey: dup.watchdogKey, reason });
    } catch (e) {
      console.warn(`[watchdog-auto-close] duplicate close failed for ${dup.issueId}:`, e instanceof Error ? e.message : e);
    }
  }

  const { seenKeys, ranTickCount } = await d.recentRanTickKeys(minTicks);
  if (ranTickCount < minTicks) return []; // not enough history — never close on a fresh watchdog
  const canonical = keyed.filter((i) => canonicalByKey.get(watchdogKeyOfIssue(i))?.id === i.id);
  const inFlight = await d.inFlightDispatchIds(canonical.map((i) => i.id));
  const nowMs = d.nowMs();

  for (const i of canonical) {
    const watchdogKey = watchdogKeyOfIssue(i);
    const candidate: AutoCloseCandidate = {
      issueId: i.id,
      watchdogKey,
      state: i.state,
      assignee: i.assignee,
      createdAtMs: i.createdAt ? Date.parse(i.createdAt) : NaN,
      signalOrigin: i.signalOrigin ?? DEFAULT_SIGNAL_ORIGIN,
      inFlightDispatch: inFlight.has(i.id),
    };
    const decision = decideAutoClose(candidate, { seenKeys, ranTickCount, nowMs }, opts);
    if (!decision.close) continue;
    try {
      await d.close(i.id, watchdogKey, decision.reason);
      out.push({ issueId: i.id, watchdogKey, reason: decision.reason });
    } catch (e) {
      // Best-effort: one close failing must not abort the sweep.
      console.warn(`[watchdog-auto-close] close failed for ${i.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (out.length > 0) {
    console.log(`[watchdog-auto-close] retired ${out.length} watchdog EI(s): ${out.map((o) => o.issueId).join(', ')}`);
  }
  return out;
}
