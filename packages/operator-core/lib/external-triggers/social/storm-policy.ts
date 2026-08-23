/**
 * P-023 — per-platform storm policy defaults for social sources.
 *
 * WHY SOCIAL NEEDS ITS OWN DEFAULT. Mail storms are bounded by how fast humans
 * write. Social is not: one viral post can produce thousands of inbound
 * comments in minutes, all of them genuinely new events with distinct dedupe
 * keys. The landed binding-engine storm policy caps runs per window and SKIPS
 * the overflow (`skippedForStorm`), which is the right answer for mail and the
 * wrong one here — skipping means the comments are never seen at all. The
 * social default is therefore COALESCE-with-cap: the cap still bounds how many
 * plan runs may launch, but overflow folds into the run rather than being
 * dropped. Nothing inbound is lost; it is batched.
 *
 * WHERE THE CAP COMES FROM, and the trap in deriving it. P-023 says the cap is
 * derived from the platform's rate budget in the P-002 registry. Only ONE of the
 * three Wave A platforms actually states a numeric budget: Reddit documents 60
 * requests/minute. Bluesky publishes only a `Retry-After` header contract, and
 * Mastodon's limits are explicitly per-instance and unstated on the streaming
 * page. So a naive `cap = f(requestsPerMinute)` yields `undefined` for two of
 * three platforms — and if `undefined` degraded to "unbounded", the storm policy
 * would be VACUOUS for precisely the two platforms whose transport is a live
 * stream, which is where a storm actually arrives. A cap that silently means
 * "no cap" is indistinguishable from a working one.
 *
 * So an absent budget falls back to a deliberately conservative cap, and the
 * policy RECORDS WHICH PATH IT TOOK in `basis`. A caller (and the admin surface)
 * can tell a derived cap from a fallback one instead of having to trust that a
 * number came from somewhere real. This mirrors how the P-003 conformance kit
 * handles a check it cannot run: skip, and say so, rather than quietly pass.
 */

import {
  getSocialPlatform,
  type SocialPlatformRow,
  type SocialQuotaBucket,
  type SocialQuotaVerb,
} from './platform-registry';

/**
 * The coalescing window. Longer than the binding engine's 60s default because
 * the unit being coalesced is a conversation's worth of comments, not a
 * retry burst — five minutes is long enough that a viral thread produces one
 * batched run rather than five, and short enough that a reply still feels
 * responsive.
 */
export const SOCIAL_STORM_WINDOW_SECONDS = 300;

/**
 * Requests one launched run is assumed to spend against the platform (fetch
 * the thread's context, compose, post). Deliberately pessimistic: the cap
 * exists to keep runs from exhausting the very budget each run needs, so
 * over-estimating costs a smaller cap while under-estimating costs a
 * rate-limit wall mid-conversation.
 */
export const ASSUMED_REQUESTS_PER_RUN = 10;

/** Cap used when the registry states no numeric budget. */
export const FALLBACK_MAX_RUNS = 12;

/** Nothing derives above this, however generous the platform's budget. */
export const MAX_RUNS_CEILING = 60;

/**
 * How the cap was arrived at. Carried on the policy so a fallback cap is
 * visible rather than passing for a measured one.
 */
export type SocialStormCapBasis =
  | {
      kind: 'rate-budget';
      /** The registry figure the cap was derived from. */
      requestsPerMinute: number;
      requestsPerRun: number;
    }
  | {
      kind: 'quota-bucket';
      /** WHICH non-fungible bucket this cap was derived from (D-020). */
      bucket: string;
      /** The verb the bucket was selected for. */
      verb: SocialQuotaVerb;
      perDay: number;
      unit: 'calls' | 'units';
      /** What one run is assumed to spend against that bucket, in its unit. */
      spendPerRun: number;
      /**
       * True when the bucket could not be selected from a declaration and the
       * TIGHTEST bucket was taken instead. A cap derived this way is safe but
       * may be far stricter than the platform requires, and saying so is the
       * difference between a deliberate throttle and an unexplained one.
       */
      fallbackToTightest?: boolean;
      /**
       * True when the daily budget could not fund even ONE run inside the
       * standard window, so the WINDOW was widened instead of the cap being
       * floored to 1. Without this the policy would silently overspend — see
       * `socialStormPolicyFor`.
       */
      windowWidened?: boolean;
    }
  | {
      kind: 'conservative-default';
      /** Why no cap could be derived — surfaced, not swallowed. */
      why: string;
    };

export interface SocialStormPolicy {
  /**
   * Always `coalesce-with-cap` for social. Named rather than implied so a
   * reader of a stored policy can tell it apart from the binding engine's
   * skip-the-overflow default.
   */
  mode: 'coalesce-with-cap';
  maxRuns: number;
  windowSeconds: number;
  basis: SocialStormCapBasis;
}

const SECONDS_PER_DAY = 86_400;

/**
 * The verified unit cost of the most expensive social write measured so far —
 * YouTube's `comments.insert`, "a quota cost of 50 units".
 *
 * Used as the write component of a run's spend against a UNITS bucket. It is
 * deliberately platform-neutral and pessimistic, for the same reason
 * `ASSUMED_REQUESTS_PER_RUN` is: a platform with a cheaper write only ends up
 * with a smaller cap than it could have had, whereas under-estimating spends a
 * budget that, once gone, stops the integration for the rest of the quota day.
 */
export const ASSUMED_WRITE_UNITS = 50;

/**
 * What one launched run is assumed to spend against a bucket, in that bucket's
 * own unit.
 *
 * `calls`: 1. A call-capped bucket caps the ONE expensive operation a run
 * performs (an upload, a search); the cheap surrounding calls are not drawn
 * from it — that non-fungibility is the entire point of D-020.
 *
 * `units`: the run's list calls (`ASSUMED_REQUESTS_PER_RUN`, 1 unit each) plus
 * one write when the verb writes. Every term traces to a figure the registry or
 * a vendor page states, rather than being a new magic number.
 */
export function assumedSpendPerRun(bucket: SocialQuotaBucket, verb: SocialQuotaVerb): number {
  if (bucket.unit === 'calls') return 1;
  return ASSUMED_REQUESTS_PER_RUN + (verb === 'read' ? 0 : ASSUMED_WRITE_UNITS);
}

/**
 * Pick the bucket a verb draws on.
 *
 * Matches only on the DECLARED `verbs` list. When nothing declares the verb,
 * the TIGHTEST bucket wins — the conservative direction on purpose: a cap that
 * is too small throttles the integration, while one that is too large exhausts a
 * daily budget and stops it outright until the quota day rolls over. The caller
 * is told which happened via `fallbackToTightest`.
 */
export function selectQuotaBucket(
  buckets: Record<string, SocialQuotaBucket>,
  verb: SocialQuotaVerb,
): { name: string; bucket: SocialQuotaBucket; fallbackToTightest: boolean } | null {
  const entries = Object.entries(buckets).filter(([, b]) => Number.isFinite(b.perDay) && b.perDay > 0);
  if (entries.length === 0) return null;

  const declared = entries.filter(([, b]) => b.verbs?.includes(verb));
  if (declared.length > 0) {
    // More than one declaring bucket is still resolvable, and the tightest is
    // the only safe reading: a verb genuinely drawing on two budgets is bounded
    // by whichever runs out first.
    const [name, bucket] = declared.reduce((a, b) => (b[1].perDay < a[1].perDay ? b : a));
    return { name, bucket, fallbackToTightest: false };
  }

  const [name, bucket] = entries.reduce((a, b) => (b[1].perDay < a[1].perDay ? b : a));
  return { name, bucket, fallbackToTightest: true };
}

/**
 * The default storm policy for a source on this platform, for a given verb.
 *
 * Pure and total: every registry row yields a policy, and no row yields an
 * unbounded one.
 *
 * ⚠ WHY THE WINDOW CAN WIDEN, WHICH IS THE POINT OF THE WHOLE BUCKET PATH.
 * The existing `requestsPerMinute` derivation clamps a small cap up to 1,
 * reasoning that "a platform with a tiny budget still gets to act once per
 * window" and that a cap of 0 would be an outage wearing a policy's clothes.
 * That reasoning holds for a PER-MINUTE budget, which refills continuously. It
 * breaks for a DAILY one, which does not: YouTube's 10,000 units/day against a
 * ~60-unit reply run funds ~166 runs a day, but the 300-second window contains
 * 288 windows a day — so clamping to "1 per window" authorises 288 runs and
 * overspends the budget by ~70%, then stops the integration entirely for the
 * remainder of the quota day.
 *
 * So when the budget cannot fund one run per standard window, this widens the
 * WINDOW to the run's actual share of the day rather than inflating the cap.
 * The cap stays honest, nothing is dropped (`coalesce-with-cap` still folds the
 * overflow in), and `basis.windowWidened` records that it happened.
 */
export function socialStormPolicyFor(
  row: SocialPlatformRow,
  verb: SocialQuotaVerb = 'read',
): SocialStormPolicy {
  // D-020: a verb's own non-fungible bucket outranks any aggregate figure. A cap
  // derived from `quotaUnitsPerDay` alone is not merely imprecise for a
  // call-capped verb, it is calibrated against an unrelated quantity.
  const buckets = row.limits.buckets;
  if (buckets) {
    const picked = selectQuotaBucket(buckets, verb);
    if (picked) {
      const { name, bucket, fallbackToTightest } = picked;
      const spendPerRun = assumedSpendPerRun(bucket, verb);
      const runsPerDay = Math.floor(bucket.perDay / spendPerRun);

      if (runsPerDay < 1) {
        // The budget cannot fund a single run even across a whole day. Refuse to
        // invent headroom: one run per day is the most this can honestly allow.
        return {
          mode: 'coalesce-with-cap',
          maxRuns: 1,
          windowSeconds: SECONDS_PER_DAY,
          basis: {
            kind: 'quota-bucket',
            bucket: name,
            verb,
            perDay: bucket.perDay,
            unit: bucket.unit,
            spendPerRun,
            windowWidened: true,
            ...(fallbackToTightest ? { fallbackToTightest } : {}),
          },
        };
      }

      const windowsPerDay = SECONDS_PER_DAY / SOCIAL_STORM_WINDOW_SECONDS;
      const perWindow = Math.floor(runsPerDay / windowsPerDay);

      if (perWindow < 1) {
        return {
          mode: 'coalesce-with-cap',
          maxRuns: 1,
          windowSeconds: Math.ceil(SECONDS_PER_DAY / runsPerDay),
          basis: {
            kind: 'quota-bucket',
            bucket: name,
            verb,
            perDay: bucket.perDay,
            unit: bucket.unit,
            spendPerRun,
            windowWidened: true,
            ...(fallbackToTightest ? { fallbackToTightest } : {}),
          },
        };
      }

      return {
        mode: 'coalesce-with-cap',
        maxRuns: Math.min(perWindow, MAX_RUNS_CEILING),
        windowSeconds: SOCIAL_STORM_WINDOW_SECONDS,
        basis: {
          kind: 'quota-bucket',
          bucket: name,
          verb,
          perDay: bucket.perDay,
          unit: bucket.unit,
          spendPerRun,
          ...(fallbackToTightest ? { fallbackToTightest } : {}),
        },
      };
    }
  }

  const rpm = row.limits.requestsPerMinute;

  if (typeof rpm === 'number' && Number.isFinite(rpm) && rpm > 0) {
    const windowMinutes = SOCIAL_STORM_WINDOW_SECONDS / 60;
    const sustainable = Math.floor((rpm * windowMinutes) / ASSUMED_REQUESTS_PER_RUN);
    // Never below 1: a platform with a tiny budget still gets to act once per
    // window. A cap of 0 would be an outage wearing a policy's clothes.
    const maxRuns = Math.min(Math.max(sustainable, 1), MAX_RUNS_CEILING);

    return {
      mode: 'coalesce-with-cap',
      maxRuns,
      windowSeconds: SOCIAL_STORM_WINDOW_SECONDS,
      basis: { kind: 'rate-budget', requestsPerMinute: rpm, requestsPerRun: ASSUMED_REQUESTS_PER_RUN },
    };
  }

  return {
    mode: 'coalesce-with-cap',
    maxRuns: FALLBACK_MAX_RUNS,
    windowSeconds: SOCIAL_STORM_WINDOW_SECONDS,
    basis: {
      kind: 'conservative-default',
      why:
        row.limits.notes?.trim() ||
        `the ${row.id} registry row states no requestsPerMinute, so no cap could be derived from a budget`,
    },
  };
}

/**
 * Project a social policy onto the landed binding-engine storm-policy shape,
 * which is what `storm_policy` jsonb actually stores.
 *
 * The extra social fields ride along rather than being dropped: `parseStormPolicy`
 * reads only `maxRuns`/`windowSeconds` and ignores the rest, so persisting the
 * basis costs nothing and keeps a stored policy self-describing — otherwise the
 * only record of whether a cap was measured or guessed would be this source file.
 */
export function toBindingStormPolicy(policy: SocialStormPolicy): Record<string, unknown> {
  return {
    maxRuns: policy.maxRuns,
    windowSeconds: policy.windowSeconds,
    mode: policy.mode,
    basis: policy.basis,
  };
}

/**
 * The default storm policy for a trigger source of this kind, or null when the
 * kind is not a social platform.
 *
 * A social source's `kind` IS its platform id (the canonical event pattern is
 * `ext:<kind>:*`, and each adapter's `platformId` is that same string), so the
 * registry lookup is the whole mapping.
 *
 * Returning null rather than a neutral default is deliberate: it lets the
 * caller leave non-social sources on the landed behaviour untouched, instead of
 * this module quietly becoming the default for every trigger source in the
 * system.
 */
export function defaultSocialStormPolicyForSourceKind(kind: string): Record<string, unknown> | null {
  const row = getSocialPlatform(kind);
  return row ? toBindingStormPolicy(socialStormPolicyFor(row)) : null;
}

export interface CoalesceOutcome {
  /** Dedupe keys that launch a run, in arrival order. */
  launched: string[];
  /** Dedupe keys folded into an already-launched run within the window. */
  coalesced: string[];
  /**
   * Dedupe keys seen more than once in the burst. Deduped before the cap
   * applies, so a redelivery cannot consume cap headroom.
   */
  duplicates: string[];
}

/**
 * Decide what a burst does under a coalesce-with-cap policy, for one source
 * inside one window.
 *
 * The invariant this exists to make testable: every distinct inbound event is
 * accounted for as either launched or coalesced. NOTHING IS DROPPED — that is
 * the whole difference from the binding engine's skip behaviour, and it is the
 * property a burst test should assert, because a cap that silently discarded
 * the overflow would look identical from a run count alone.
 */
export function planCoalesceWithCap(
  events: readonly { dedupeKey: string }[],
  policy: SocialStormPolicy,
): CoalesceOutcome {
  const launched: string[] = [];
  const coalesced: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    const key = event.dedupeKey;
    if (seen.has(key)) {
      duplicates.push(key);
      continue;
    }
    seen.add(key);

    if (launched.length < policy.maxRuns) launched.push(key);
    else coalesced.push(key);
  }

  return { launched, coalesced, duplicates };
}
