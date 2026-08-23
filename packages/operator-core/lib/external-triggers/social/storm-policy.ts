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

import { getSocialPlatform, type SocialPlatformRow } from './platform-registry';

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

/**
 * The default storm policy for a source on this platform.
 *
 * Pure and total: every registry row yields a policy, and no row yields an
 * unbounded one.
 */
export function socialStormPolicyFor(row: SocialPlatformRow): SocialStormPolicy {
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
