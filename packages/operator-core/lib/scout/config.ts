/**
 * config.ts — the per-blueprint Scout tuning surface (P-009 scout-config seam,
 * domain-generic-hive-architecture-2026-06-18 D-004).
 *
 * The Scout loop's behavior was tuned by constants scattered across the engine:
 * `CREATIVE_LENSES` (the ideator roster, types.ts), the search-first novelty knobs
 * and verdict-bucket thresholds (critique-core.ts), and the routing default + the
 * genome-axis `WHOLE_SYSTEM_MARKERS` vocabulary (router.ts). This module lifts those
 * into ONE `ScoutConfig` a blueprint can supply, so a `coding` hive and a `work` hive
 * can scout DIFFERENTLY — not just be worded differently (the "how the hive learns"
 * customization, D-002/D-004).
 *
 * KEY INVARIANT: {@link DEFAULT_SCOUT_CONFIG} is built FROM the engine's own exported
 * defaults, so an absent / partial blueprint `scout` block yields byte-identical
 * behavior to before this seam existed. The engine itself (the pipeline, the
 * critic spine's search-first novelty ceiling, the verdict buckets, the
 * `scout-ceiling` learning governor) stays hardcoded — the blueprint supplies domain
 * JUDGMENT (lenses, thresholds, routing, markers), not the mechanism.
 *
 * PURE — no IO, no LLM. Resolution + defensive parsing only; fully unit-testable.
 */
import { CREATIVE_LENSES, type CreativeLens } from './types';
import {
  DEFAULT_BUCKET_OPTIONS,
  DEFAULT_CORPUS_NOVELTY_OPTIONS,
  type BucketOptions,
  type CorpusNoveltyOptions,
} from './critique-core';
import { DEFAULT_ROUTING_RAIL, WHOLE_SYSTEM_MARKERS } from './router';
import type { RoutedRail } from './outcome-feedback';

/** The routing knobs a blueprint can tune (router.ts ClassifyOptions + the markers). */
export interface ScoutRoutingConfig {
  /** Rail used when a proposal carries no routeHint (default `improvement`). */
  defaultRail: RoutedRail;
  /**
   * The genome-axis vocabulary that bumps a testable proposal to the `instance` rail
   * (`isWholeSystemProposal`). Coding/Papercusp-specific by default — a `work` hive
   * supplies its own or `[]` (never bump to instance).
   */
  wholeSystemMarkers: readonly string[];
}

/**
 * The fully-resolved per-blueprint Scout tuning. Every field is concrete (no optionals)
 * so the engine call sites can use it directly. Build one with {@link resolveScoutConfig}.
 *
 * NOTE: `outcomeSignals` (what counts as "paid off" for the P-013 lens-attribution loop)
 * is a planned follow-on — the attribution path (`outcome-feedback.ts`) is not yet
 * parameterized, so it is intentionally NOT a field here yet (no dead config).
 */
export interface ScoutConfig {
  /** Forced-diversity ideator roster (D-004). Each lens is a distinct generative stance. */
  lenses: readonly CreativeLens[];
  /** Search-first novelty knobs (`corpusNovelty`). */
  novelty: Required<CorpusNoveltyOptions>;
  /** Verdict-bucket thresholds (`verdictFor`/`bucketByCritique`). */
  buckets: Required<BucketOptions>;
  /** Routing defaults + the whole-system marker vocabulary. */
  routing: ScoutRoutingConfig;
}

/**
 * The default tuning — byte-identical to the previous hardcoded constants. Built FROM
 * the engine's exported defaults so it can never drift (asserted in config.test.ts).
 */
export const DEFAULT_SCOUT_CONFIG: ScoutConfig = {
  lenses: CREATIVE_LENSES,
  novelty: DEFAULT_CORPUS_NOVELTY_OPTIONS,
  buckets: DEFAULT_BUCKET_OPTIONS,
  routing: {
    defaultRail: DEFAULT_ROUTING_RAIL,
    wholeSystemMarkers: WHOLE_SYSTEM_MARKERS,
  },
};

/** A partial override a blueprint supplies — every field optional; missing → default. */
export interface ScoutConfigOverride {
  lenses?: readonly CreativeLens[];
  novelty?: Partial<CorpusNoveltyOptions>;
  buckets?: Partial<BucketOptions>;
  routing?: Partial<ScoutRoutingConfig>;
}

/** Copy only the DEFINED own keys of `src` onto a shallow clone of `base`. */
function mergeDefined<T extends object>(base: T, src?: Partial<T>): T {
  if (!src) return { ...base };
  const out = { ...base };
  for (const k of Object.keys(src) as (keyof T)[]) {
    const v = src[k];
    if (v !== undefined) out[k] = v as T[keyof T];
  }
  return out;
}

/**
 * Resolve a blueprint override over {@link DEFAULT_SCOUT_CONFIG}. A null/empty override
 * yields the defaults; an empty `lenses` array is ignored (the D-004 floor — never
 * silence the ideators). Missing nested keys fall back per-field, so a blueprint can
 * tune just `buckets.moonshotNoveltyFloor` without restating everything.
 */
export function resolveScoutConfig(override?: ScoutConfigOverride | null): ScoutConfig {
  if (!override) return DEFAULT_SCOUT_CONFIG;
  return {
    lenses:
      override.lenses && override.lenses.length > 0
        ? [...override.lenses]
        : DEFAULT_SCOUT_CONFIG.lenses,
    novelty: mergeDefined<Required<CorpusNoveltyOptions>>(DEFAULT_SCOUT_CONFIG.novelty, override.novelty),
    buckets: mergeDefined<Required<BucketOptions>>(DEFAULT_SCOUT_CONFIG.buckets, override.buckets),
    routing: mergeDefined<ScoutRoutingConfig>(DEFAULT_SCOUT_CONFIG.routing, override.routing),
  };
}

const ROUTED_RAILS: readonly RoutedRail[] = ['plan', 'gym', 'improvement', 'instance'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/**
 * Defensively parse a blueprint's raw `scout` block (untrusted yaml/JSON) into a
 * {@link ScoutConfigOverride}. Unknown / malformed fields are DROPPED (never throws),
 * so a typo'd block degrades to the defaults rather than breaking the cycle — the same
 * fail-safe discipline as `parseScoutCycleConfig` (run.ts).
 */
export function parseScoutConfigBlock(raw: unknown): ScoutConfigOverride {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: ScoutConfigOverride = {};

  const lenses = asStringArray(r.lenses)?.filter((l): l is CreativeLens =>
    (CREATIVE_LENSES as readonly string[]).includes(l),
  );
  if (lenses && lenses.length > 0) out.lenses = lenses;

  if (r.novelty && typeof r.novelty === 'object') {
    const n = r.novelty as Record<string, unknown>;
    const nov: Partial<CorpusNoveltyOptions> = {};
    if (isFiniteNumber(n.matchFloor)) nov.matchFloor = n.matchFloor;
    if (isFiniteNumber(n.maxMatches)) nov.maxMatches = n.maxMatches;
    if (isFiniteNumber(n.decidedPenalty)) nov.decidedPenalty = n.decidedPenalty;
    const ds = asStringArray(n.decidedStates);
    if (ds) nov.decidedStates = ds;
    if (Object.keys(nov).length > 0) out.novelty = nov;
  }

  if (r.buckets && typeof r.buckets === 'object') {
    const b = r.buckets as Record<string, unknown>;
    const bk: Partial<BucketOptions> = {};
    if (isFiniteNumber(b.noveltyFloor)) bk.noveltyFloor = b.noveltyFloor;
    if (isFiniteNumber(b.feasibilityFloor)) bk.feasibilityFloor = b.feasibilityFloor;
    if (isFiniteNumber(b.moonshotNoveltyFloor)) bk.moonshotNoveltyFloor = b.moonshotNoveltyFloor;
    if (isFiniteNumber(b.maxMoonshots)) bk.maxMoonshots = b.maxMoonshots;
    if (Object.keys(bk).length > 0) out.buckets = bk;
  }

  if (r.routing && typeof r.routing === 'object') {
    const rt = r.routing as Record<string, unknown>;
    const routing: Partial<ScoutRoutingConfig> = {};
    if (typeof rt.defaultRail === 'string' && ROUTED_RAILS.includes(rt.defaultRail as RoutedRail)) {
      routing.defaultRail = rt.defaultRail as RoutedRail;
    }
    const markers = asStringArray(rt.wholeSystemMarkers);
    if (markers) routing.wholeSystemMarkers = markers.map((m) => m.toLowerCase());
    if (Object.keys(routing).length > 0) out.routing = routing;
  }

  return out;
}
