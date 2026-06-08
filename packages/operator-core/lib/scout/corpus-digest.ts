/**
 * corpus-digest.ts — the "state of the Hive" corpus digest (Scout loop, step 1).
 *
 * Plan: hive-creative-ideation-2026-06-08 P-003 (build-item B1) — "Corpus
 * synthesis: a 'state of the Hive' digest of cross-corpus meta-patterns
 * (recurring friction, time/token sinks, chronic deferrals, capability gaps)
 * over the change feed + completions + reverts."
 *
 * This is the GENERATIVE-EXPLORATION substrate: the Scout loop's divergent
 * ideators (P-004) read this digest instead of per-turn context, because the
 * introspection it performs — rolling up META-patterns across the Hive's whole
 * operational history — is structurally impossible for the per-turn idea queue
 * (self-learning-central D-003: "the Hive's complete operational history is the
 * creative substrate").
 *
 * INTEGRATION CONTRACT (with su-797a5's scout/types.ts, affirmed by su-b6c3f's
 * verification-lane contract): the four ref-carrying lanes ARE the shared
 * {@link CorpusDigest} (types.ts is the single source of truth for the consumed
 * shape; this file is the production PRODUCER of it). {@link StateOfHiveDigest}
 * is a structural SUPERSET — the 4 `CorpusDigest` lanes plus a `reverts` churn
 * substrate (P-003's third input) and a `corpus` rollup — so it is directly
 * assignable to `CorpusDigest`; the ideators / `flattenDigest` / `digestRefSet`
 * read only the 4 lanes and ignore the extras. No adapter seam needed.
 *
 * DESIGN — deterministic, not an LLM call (mirrors curation/change-feed.ts):
 * the digest is a PURE, REGENERABLE rollup over injected readers. The creative
 * LEAP happens DOWNSTREAM (the P-004 ideators); the digest's job is to be the
 * grounded, queryable, ref-carrying substrate they leap FROM. Keeping it
 * deterministic makes it cheap (no per-cycle model spend just to summarise) and
 * exhaustively testable. Each pattern's `ref` drills back to the original (the
 * change-feed pattern — never a duplicated log).
 */

import { z } from 'zod';
import type { ChangeFeedEntry } from '../curation/change-feed';
import {
  dedupSignature,
  findLikelyDuplicates,
  signatureRecurrence,
} from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { MetaPattern, MetaPatternCategory } from './types';

// ---------------------------------------------------------------------------
// Raw input records (what the readers gather; normalised by synthesize).
// ---------------------------------------------------------------------------

/**
 * A status-regression event = work that was UNDONE (the "reverts" substrate).
 * Sourced from feature_audit (field='status'): a transition whose new status is
 * LESS complete than the old (e.g. passed→failing, passed→todo, validating→todo,
 * passed→deprecated). The strongest revert is undoing terminal-good work.
 */
export interface RevertRecord {
  /** The work item whose status regressed (feature/issue id). */
  workItemId: string;
  harness?: string;
  /** Status before (e.g. "passed"). */
  from: string;
  /** Status after (e.g. "failing"). */
  to: string;
  /** Who/what caused the transition (audit actor), when recorded. */
  actor?: string | null;
  /** ISO timestamp of the transition. */
  ts: string;
}

/**
 * One aggregated spend bucket = where time/tokens went. Sourced from
 * agent_usage_samples, grouped by (harness, role). `costUsd` is the spend;
 * `runs` is how many samples rolled up.
 */
export interface SpendRecord {
  harness?: string | null;
  role?: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

/**
 * A deferral = something the Hive explicitly put off. Two sources, one shape:
 *  - a plan ITEM whose status is `blocked` or `needs-human` (an explicit punt;
 *    a normal dependency-blocked todo is NOT a deferral and is excluded), or
 *  - a plan DECISION whose body marks a deferral ("deferred to a follow-up").
 */
export interface DeferralRecord {
  planSlug: string;
  /** The plan-item id (P-NNN) or decision id (D-NNN). */
  refId: string;
  /** 'item' | 'decision' — where the deferral lives. */
  source: 'item' | 'decision';
  /** Item status (`blocked`/`needs-human`) or 'decision' for a deferred decision. */
  status: string;
  /** The item text / decision title — the thing being deferred. */
  text: string;
}

/** The injectable source bag — each reader returns one corpus substrate. */
export interface StateOfHiveReaders {
  /** The change feed: completions / proposals / plan-runs (curation/change-feed). */
  completions(): Promise<ChangeFeedEntry[]>;
  /** Reverts: status regressions (undone work). */
  reverts(): Promise<RevertRecord[]>;
  /** Captured friction (the papercusp-improvement queue) for recurrence + gaps. */
  friction(): Promise<ImprovementCandidate[]>;
  /** Spend buckets (where time/tokens went). */
  spend(): Promise<SpendRecord[]>;
  /** Explicit deferrals (blocked / needs-human items + deferred decisions). */
  deferrals(): Promise<DeferralRecord[]>;
}

// ---------------------------------------------------------------------------
// DigestSchema — the structured output the Scout ideators consume (B1).
// The MetaPattern shape MATCHES scout/types.ts (single source of truth for the
// consumed contract); this zod schema is the runtime validator for it.
// ---------------------------------------------------------------------------

/** The four corpus lanes (mirrors scout/types.ts MetaPatternCategory). */
const META_PATTERN_CATEGORIES = [
  'recurring-friction',
  'time-token-sink',
  'chronic-deferral',
  'capability-gap',
] as const;

/**
 * Zod validator for one grounded meta-pattern — structurally identical to
 * scout/types.ts `MetaPattern` (a colocated `satisfies` assertion in the tests
 * pins the two together). `weight` is the 0..1 salience the digest's own
 * ranking assigns (top pattern per lane = 1.0); `ref` is the drill-back key.
 */
export const MetaPatternSchema = z.object({
  category: z.enum(META_PATTERN_CATEGORIES).optional(),
  summary: z.string(),
  detail: z.string().optional(),
  ref: z.string(),
  weight: z.number().optional(),
});

/**
 * `DigestSchema` (B1 deliverable) — the validated shape of a "state of the Hive"
 * corpus digest. The four plan-named lanes (the shared {@link CorpusDigest}) +
 * a `reverts` churn substrate + a `corpus` coverage rollup.
 * `z.infer<typeof DigestSchema>` is {@link StateOfHiveDigest}.
 */
export const DigestSchema = z.object({
  /** ISO generation time (deterministic in tests via opts.nowMs). */
  generatedAt: z.string(),
  /** What corpus was scanned — honesty about coverage. */
  corpus: z.object({
    completions: z.number().int().nonnegative(),
    reverts: z.number().int().nonnegative(),
    frictionCaptured: z.number().int().nonnegative(),
    deferrals: z.number().int().nonnegative(),
    spendUsd: z.number(),
    spendBuckets: z.number().int().nonnegative(),
  }),
  // The four meta-pattern categories (plan P-003) — the shared CorpusDigest lanes.
  recurringFriction: z.array(MetaPatternSchema),
  timeTokenSinks: z.array(MetaPatternSchema),
  chronicDeferrals: z.array(MetaPatternSchema),
  capabilityGaps: z.array(MetaPatternSchema),
  /** Undone work — status regressions, churniest first (P-003's reverts input). */
  reverts: z.array(MetaPatternSchema),
  /** One-line summary for a coord broadcast / the Scout trigger. */
  headline: z.string(),
});

/**
 * The production digest. A structural SUPERSET of the shared {@link CorpusDigest}
 * (the four lanes), adding the `reverts` churn substrate + the `corpus` rollup.
 * Assignable to `CorpusDigest`, so the P-004 ideators consume it directly.
 */
export type StateOfHiveDigest = z.infer<typeof DigestSchema>;

// ---------------------------------------------------------------------------
// Pure synthesis — deterministic given `nowMs`.
// ---------------------------------------------------------------------------

export interface SynthesizeOptions {
  /** Now, in ms — passed for deterministic tests; the tool passes Date.now(). */
  nowMs?: number;
  /** Max patterns per category (default 20). */
  perCategory?: number;
}

/** Run a reader defensively — one bad source won't kill the whole digest. */
async function safe<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[corpus-digest] reader "${label}" failed:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Status completeness rank — higher = more complete. A revert/regression is a
 * transition to a LOWER rank. Unknown statuses rank at 2 (neutral) so an
 * unmodelled status never spuriously reads as a regression in either direction.
 */
function statusRank(status: string): number {
  switch (status.toLowerCase()) {
    case 'deprecated':
    case 'dropped':
      return 0; // abandoned / killed
    case 'failing':
      return 1;
    case 'todo':
    case 'blocked':
    case 'needs-human':
      return 2;
    case 'validating':
    case 'in_progress':
    case 'wip':
      return 3;
    case 'passed':
    case 'done':
    case 'resolved':
    case 'closed':
      return 4; // terminal-good
    default:
      return 2;
  }
}

/** The churn weight of one revert: how far it fell, +2 extra for undoing
 *  terminal-good (rank-4) work. 0 when it is not a regression. */
export function revertWeight(from: string, to: string): number {
  const fromR = statusRank(from);
  const toR = statusRank(to);
  if (toR >= fromR) return 0; // not a regression (recovery or lateral)
  return fromR - toR + (fromR === 4 ? 2 : 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent activity (resolution time when resolved, else creation) — the
 *  recurrence-decay clock for one candidate. */
function lastSeenMsOf(c: ImprovementCandidate): number {
  const ts = c.updatedAt ?? c.createdAt;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function truncate(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** A scored, pre-normalisation row. We carry the raw salience so each lane can
 *  max-normalise it into MetaPattern.weight (0..1, top = 1.0). */
interface Scored {
  salience: number;
  pattern: Omit<MetaPattern, 'weight'>;
}

/** Sort by raw salience desc, slice to `limit`, then max-normalise into the
 *  shared MetaPattern.weight (top of the lane = 1.0). */
function finalize(scored: Scored[], limit: number): MetaPattern[] {
  const ranked = [...scored].sort((a, b) => b.salience - a.salience).slice(0, limit);
  const max = ranked.length ? ranked[0].salience : 0;
  return ranked.map((s) => ({
    ...s.pattern,
    weight: max > 0 ? round(s.salience / max) : 0,
  }));
}

/** recurringFriction — friction that RECURS: clusters of captures sharing a
 *  stable signature OR near-duplicate wording (Jaccard ≥ 0.8). Reuses the
 *  shipped keystone matcher `findLikelyDuplicates` (exact-then-near-dup) — NOT a
 *  second dedup — so the same underlying friction worded differently still
 *  collides (the "friction nobody named", which exact-signature-only misses on
 *  real, distinctly-worded captures). Open recurrence outweighs a quiet one. */
function buildRecurringFriction(friction: ImprovementCandidate[], nowMs: number, limit: number): MetaPattern[] {
  const byId = new Map(friction.map((c) => [c.id, c] as const));
  const clusters = findLikelyDuplicates(friction).filter((c) => c.ids.length > 1);
  const scored: Scored[] = clusters.map((cluster) => {
    const members = cluster.ids
      .map((id) => byId.get(id))
      .filter((c): c is ImprovementCandidate => Boolean(c));
    const openCount = members.filter((m) => (m.state ?? 'open') === 'open').length;
    // Exemplar + decay clock = the most-recently-seen member.
    const newest = [...members].sort((a, b) => lastSeenMsOf(b) - lastSeenMsOf(a))[0];
    const lastSeenMs = newest ? lastSeenMsOf(newest) : 0;
    const decayDays = lastSeenMs ? round((nowMs - lastSeenMs) / DAY_MS, 1) : 0;
    const openBoost = openCount > 0 ? 1 + openCount / members.length : 0.5;
    return {
      salience: members.length * openBoost,
      pattern: {
        category: 'recurring-friction' as MetaPatternCategory,
        summary: newest ? truncate(newest.title) : cluster.signature,
        detail: `recurred ${members.length}× (${openCount} open), last ${decayDays}d ago`,
        ref: newest ? `wi:${newest.id}` : `friction:${cluster.signature.slice(0, 40)}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** timeTokenSinks — the heaviest spend buckets (where time/tokens went). */
function buildTimeTokenSinks(spend: SpendRecord[], limit: number): MetaPattern[] {
  const scored: Scored[] = spend
    .filter((s) => s.costUsd > 0 || s.outputTokens > 0)
    .map((s) => {
      const harness = s.harness ?? '(unattributed)';
      const role = s.role ?? '(any role)';
      const tokens = s.inputTokens + s.outputTokens;
      return {
        salience: s.costUsd > 0 ? s.costUsd : tokens / 1_000_000, // $ first; tokens as a tiny tiebreak
        pattern: {
          category: 'time-token-sink' as MetaPatternCategory,
          summary: `$${round(s.costUsd)} on ${harness} · ${role}`,
          detail: `${s.runs} run(s), ${tokens.toLocaleString()} tokens`,
          ref: `usage:${harness}/${role}`,
        },
      };
    });
  return finalize(scored, limit);
}

/** chronicDeferrals — deferrals aggregated by stable signature so the SAME thing
 *  deferred repeatedly (across items / plans / decisions) reads as *chronic*
 *  (high salience). needs-human punts weigh above blocked; a one-off deferral is
 *  a low-salience current deferral, not yet chronic. */
function buildChronicDeferrals(deferrals: DeferralRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, DeferralRecord[]>();
  for (const d of deferrals) {
    const sig = dedupSignature(d.text) || d.text.toLowerCase().slice(0, 40);
    const arr = groups.get(sig) ?? [];
    arr.push(d);
    groups.set(sig, arr);
  }
  const weightOf = (status: string): number => (status === 'needs-human' ? 1.5 : status === 'blocked' ? 1.2 : 1);
  const scored: Scored[] = [...groups.values()].map((members) => {
    // Recurrence is the chronic signal; punt-severity is the tiebreak.
    const severity = members.reduce((acc, m) => acc + weightOf(m.status), 0);
    const salience = members.length * 10 + severity;
    const exemplar = members[0];
    const plans = [...new Set(members.map((m) => m.planSlug))];
    const statuses = [...new Set(members.map((m) => m.status))];
    return {
      salience,
      pattern: {
        category: 'chronic-deferral' as MetaPatternCategory,
        summary: truncate(exemplar.text),
        detail: `deferred ${members.length}× across ${plans.length} plan(s) [${statuses.join(', ')}]`,
        ref: `plan:${exemplar.planSlug}#${exemplar.refId}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** capabilityGaps — absent capabilities: net-new feature-kind asks + friction
 *  that NAMES a missing capability, aggregated by signature so a repeatedly
 *  requested capability ranks highest. */
const GAP_KEYWORDS = [
  'no way to', 'cannot ', "can't ", 'unable to', 'missing', 'there is no', "there's no",
  'wish there was', 'would be nice', 'lacks', 'not possible', 'need a tool', 'no tool',
  'unsupported', 'no support for', 'add support',
];

function namesMissingCapability(c: ImprovementCandidate): boolean {
  const hay = `${c.title} ${c.body ?? ''}`.toLowerCase();
  return GAP_KEYWORDS.some((k) => hay.includes(k));
}

function buildCapabilityGaps(friction: ImprovementCandidate[], nowMs: number, limit: number): MetaPattern[] {
  const gapCandidates = friction.filter((c) => c.kind === 'feature' || namesMissingCapability(c));
  const recurrences = signatureRecurrence(gapCandidates, { nowMs });
  const byId = new Map(gapCandidates.map((c) => [c.id, c] as const));
  const scored: Scored[] = recurrences.map((r) => {
    const exemplar = byId.get(r.ids[0]);
    const isFeature = exemplar?.kind === 'feature';
    const salience = r.count * (isFeature ? 2 : 1) + (r.openCount > 0 ? 1 : 0);
    return {
      salience,
      pattern: {
        category: 'capability-gap' as MetaPatternCategory,
        summary: exemplar ? truncate(exemplar.title) : r.signature,
        detail: `${isFeature ? 'net-new ask' : 'named missing capability'}${r.count > 1 ? `, asked ${r.count}×` : ''} (${r.openCount} open)`,
        ref: `wi:${r.ids[0]}`,
      },
    };
  });
  return finalize(scored, limit);
}

/** reverts — status regressions grouped by work item; the churniest (most-/
 *  hardest-reverted) work first. The substrate signal for "where rework lives".
 *  Not one of the four CorpusDigest lanes, so its patterns carry no `category`. */
function buildReverts(reverts: RevertRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, { records: RevertRecord[]; weight: number }>();
  for (const r of reverts) {
    const w = revertWeight(r.from, r.to);
    if (w <= 0) continue; // not a regression
    const g = groups.get(r.workItemId) ?? { records: [], weight: 0 };
    g.records.push(r);
    g.weight += w;
    groups.set(r.workItemId, g);
  }
  const scored: Scored[] = [...groups.entries()].map(([workItemId, g]) => {
    const latest = [...g.records].sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    return {
      salience: g.weight,
      pattern: {
        summary: `${workItemId} reverted ${g.records.length}× (latest ${latest.from}→${latest.to})`,
        detail: latest.actor ? `last by ${latest.actor}` : `latest ${latest.ts}`,
        ref: `wi:${workItemId}`,
      },
    };
  });
  return finalize(scored, limit);
}

/**
 * Synthesize the "state of the Hive" corpus digest. Pure + deterministic given
 * `nowMs`. Gathers all substrates (defensively), rolls each into its
 * meta-pattern lane, and returns a `DigestSchema`-valid digest (a structural
 * superset of the shared CorpusDigest).
 */
export async function synthesizeStateOfHive(
  readers: StateOfHiveReaders,
  opts: SynthesizeOptions = {},
): Promise<StateOfHiveDigest> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.perCategory ?? 20;

  const [completions, reverts, friction, spend, deferrals] = await Promise.all([
    safe(() => readers.completions(), 'completions'),
    safe(() => readers.reverts(), 'reverts'),
    safe(() => readers.friction(), 'friction'),
    safe(() => readers.spend(), 'spend'),
    safe(() => readers.deferrals(), 'deferrals'),
  ]);

  const recurringFriction = buildRecurringFriction(friction, nowMs, limit);
  const timeTokenSinks = buildTimeTokenSinks(spend, limit);
  const chronicDeferrals = buildChronicDeferrals(deferrals, limit);
  const capabilityGaps = buildCapabilityGaps(friction, nowMs, limit);
  const revertPatterns = buildReverts(reverts, limit);

  const spendUsd = round(spend.reduce((acc, s) => acc + (s.costUsd || 0), 0));
  const corpus = {
    completions: completions.length,
    reverts: reverts.length,
    frictionCaptured: friction.length,
    deferrals: deferrals.length,
    spendUsd,
    spendBuckets: spend.length,
  };

  const headline =
    `State of the Hive: ${recurringFriction.length} recurring friction, ` +
    `${timeTokenSinks.length} spend sink(s) ($${spendUsd}), ` +
    `${chronicDeferrals.length} chronic deferral(s), ` +
    `${capabilityGaps.length} capability gap(s), ` +
    `${revertPatterns.length} reverted item(s) ` +
    `over ${completions.length} completions`;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    corpus,
    recurringFriction,
    timeTokenSinks,
    chronicDeferrals,
    capabilityGaps,
    reverts: revertPatterns,
    headline,
  };
}
