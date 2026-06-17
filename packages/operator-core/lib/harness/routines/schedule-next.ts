/**
 * Recurrence → next-fire-time for the routines engine.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-006, D-004).
 *
 * The engine schedules on the `next_fire_at` TIMESTAMP, not on cron — cron is
 * merely one dialect that computes it (cron.ts), and RRULE is another. We NEVER
 * convert RRULE→cron: cron is strictly less expressive (no interval-from-anchor,
 * COUNT, UNTIL, or nth-weekday). Per cron.ts's own note, the engine depends only
 * on a `(rule, from) -> Date | null` contract; this module is the RRULE branch
 * plus the dispatcher over a routine's `trigger_config` / a plan's `schedule`
 * shape.
 */
import { createRequire } from 'node:module';
import { computeNextFireAt } from './cron';

// `rrule` is a CommonJS package: under the ESM/tsx host its classes are exposed on the
// DEFAULT export, NOT as statically-detectable named exports, so `import { RRule } from
// 'rrule'` throws `The requested module 'rrule' does not provide an export named 'RRule'`
// at module load. That took down EVERY consumer of this routine's transitive import graph
// — notably `fleet:place_batch` on the staging operator (:3170), which 500'd on every
// placement. Load it via createRequire (the repo's ESM-safe CJS pattern; cf.
// libs/generic/resource-profile) so the named classes resolve at runtime.
const { RRule, RRuleSet } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

/**
 * The recurrence config stored on a routine's `trigger_config` (and authored on
 * a plan's `schedule` column). RRULE-native recurrence SET (rrule + rdate +
 * exdate, anchored on dtstart/tzid); `cron` is the alternate input dialect.
 */
export interface ScheduleTrigger {
  kind?: 'rrule' | 'cron';
  /** RRULE string (RFC 5545), e.g. 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;INTERVAL=2'. */
  rrule?: string;
  /** DTSTART anchor (ISO). Required for INTERVAL/COUNT/UNTIL to be meaningful. */
  dtstart?: string;
  /** IANA tz id for calendar-time recurrence (D-013). */
  tzid?: string;
  /** Explicit added occurrences (RDATE, ISO). */
  rdate?: string[];
  /** Excluded occurrences (EXDATE, ISO) — holidays, a dragged-off instance, etc. */
  exdate?: string[];
  /** Cron dialect (5/6-field) — the alternate input. */
  cron?: string;
}

/**
 * Next fire strictly AFTER `from` (exclusive) for an RRULE recurrence SET, or
 * null when the rule is unparseable / has no further occurrence (COUNT or UNTIL
 * exhausted). Builds an RRuleSet so RDATE additions and EXDATE exclusions are
 * honored (the "edit this occurrence vs all occurrences" model, D-004).
 */
export function computeNextFireFromRrule(cfg: ScheduleTrigger, from: Date): Date | null {
  if (!cfg.rrule || !cfg.rrule.trim()) return null;
  try {
    const opts = RRule.parseString(cfg.rrule);
    const dt = cfg.dtstart ? new Date(cfg.dtstart) : undefined;
    if (dt && Number.isFinite(dt.getTime())) opts.dtstart = dt;
    // tzid governs floating-vs-zoned semantics so calendar-time rules survive DST
    // (D-013). Full tz correctness is hardened at the integration layer.
    if (cfg.tzid) opts.tzid = cfg.tzid;

    const set = new RRuleSet();
    set.rrule(new RRule(opts));
    for (const iso of cfg.rdate ?? []) {
      const d = new Date(iso);
      if (Number.isFinite(d.getTime())) set.rdate(d);
    }
    for (const iso of cfg.exdate ?? []) {
      const d = new Date(iso);
      if (Number.isFinite(d.getTime())) set.exdate(d);
    }

    const next = set.after(from, false); // exclusive — strictly after `from`
    return next ?? null;
  } catch {
    return null;
  }
}

/**
 * The engine's recurrence dispatcher: compute the next fire for a routine's
 * `trigger_config` (or a plan's `schedule`), dispatching on shape. RRULE takes
 * precedence when present; otherwise cron. Returns null when neither yields a
 * future occurrence — the same contract `claim.ts` already expects from
 * `computeNextFireAt` (a null next_fire_at deactivates a one-shot).
 */
export function computeNextFire(cfg: ScheduleTrigger | null | undefined, from: Date): Date | null {
  if (!cfg) return null;
  if (cfg.kind === 'rrule' || cfg.rrule) return computeNextFireFromRrule(cfg, from);
  if (cfg.cron) return computeNextFireAt(cfg.cron, from);
  return null;
}

/**
 * All occurrences of a recurrence within [rangeStart, rangeEnd] (inclusive) — the
 * calendar window expansion (P-018). The calendar is driven from these
 * backend-computed occurrences (one source of truth; the calendar lib stays
 * swappable). RRULE uses RRuleSet.between so RDATE additions + EXDATE exclusions
 * are honored; cron is stepped (no native range expansion). A bare `scheduled_at`
 * one-shot carries no rrule/cron and is added by the caller. `limit` bounds a
 * pathological sub-minute cadence over a wide window.
 */
export function expandOccurrences(
  cfg: ScheduleTrigger | null | undefined,
  rangeStart: Date,
  rangeEnd: Date,
  limit = 500,
): Date[] {
  if (!cfg || rangeEnd.getTime() < rangeStart.getTime()) return [];
  if (cfg.rrule) {
    try {
      const opts = RRule.parseString(cfg.rrule);
      const dt = cfg.dtstart ? new Date(cfg.dtstart) : undefined;
      if (dt && Number.isFinite(dt.getTime())) opts.dtstart = dt;
      if (cfg.tzid) opts.tzid = cfg.tzid;
      const set = new RRuleSet();
      set.rrule(new RRule(opts));
      for (const iso of cfg.rdate ?? []) {
        const d = new Date(iso);
        if (Number.isFinite(d.getTime())) set.rdate(d);
      }
      for (const iso of cfg.exdate ?? []) {
        const d = new Date(iso);
        if (Number.isFinite(d.getTime())) set.exdate(d);
      }
      return set.between(rangeStart, rangeEnd, true).slice(0, limit); // inclusive bounds
    } catch {
      return [];
    }
  }
  if (cfg.cron) {
    const out: Date[] = [];
    // step from just before rangeStart so an occurrence exactly at the bound is included
    let cursor = new Date(rangeStart.getTime() - 1);
    for (let i = 0; i < limit; i++) {
      const next = computeNextFireAt(cfg.cron, cursor);
      if (!next || next.getTime() > rangeEnd.getTime()) break;
      out.push(next);
      cursor = next;
    }
    return out;
  }
  return [];
}

/**
 * A warning if a schedule fires very frequently — the doable half of "warn on
 * expensive × frequent" (P-013 / D-012): frequency is knowable at author time,
 * expense is not until runs accrue. Returns null for a one-shot / reasonable cadence.
 * Measures the gap between the next two occurrences from `from`.
 */
export function frequencyWarning(
  cfg: ScheduleTrigger | null | undefined,
  from: Date,
  minIntervalMs = 15 * 60_000,
): string | null {
  if (!cfg || (!cfg.rrule && !cfg.cron)) return null;
  const f1 = computeNextFire(cfg, from);
  if (!f1) return null;
  const f2 = computeNextFire(cfg, f1);
  if (!f2) return null; // no second occurrence ⇒ effectively one-shot / exhausted
  const interval = f2.getTime() - f1.getTime();
  if (interval >= minIntervalMs) return null;
  const mins = Math.max(1, Math.round(interval / 60_000));
  return `This schedule fires very frequently (~every ${mins} min); each fire spawns a run — watch cost (set schedule.costCapCents; global/per-plugin budget caps also apply).`;
}

/**
 * Validate an authored RRULE string before it's stored (P-014). Checks it parses
 * and carries a FREQ (the one required RRULE part); a parse error or a missing FREQ
 * is rejected with a reason. Does NOT require a future occurrence — an exhausted
 * COUNT/UNTIL is an expiry concern, not an authoring error.
 */
export function validateRrule(rrule: string): { ok: true } | { ok: false; error: string } {
  if (!rrule || !rrule.trim()) return { ok: false, error: 'empty rrule' };
  try {
    const opts = RRule.parseString(rrule);
    if (opts.freq === undefined || opts.freq === null) {
      return { ok: false, error: 'rrule missing FREQ' };
    }
    new RRule(opts); // construct to surface an invalid option combination
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid rrule' };
  }
}
