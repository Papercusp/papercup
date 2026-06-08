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
 * DESIGN — deterministic, not an LLM call (mirrors curation/change-feed.ts):
 * the digest is a PURE, REGENERABLE rollup over injected readers. The creative
 * LEAP happens DOWNSTREAM (the P-004 ideators); the digest's job is to be the
 * grounded, queryable, ref-carrying substrate they leap FROM. Keeping it
 * deterministic makes it cheap (no per-cycle model spend just to summarise) and
 * exhaustively testable.
 *
 * Each surfaced pattern carries `refs` back to the originals (the
 * rationale:feed / change-feed pattern) — never a duplicated log; an ideator or
 * critic drills in with work_items:get / plans:get / curation:change-feed.
 */

import { z } from 'zod';
import type { ChangeFeedEntry } from '../curation/change-feed';
import {
  dedupSignature,
  signatureRecurrence,
  type SignatureRecurrence,
} from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';

const DAY_MS = 24 * 60 * 60 * 1000;

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
// ---------------------------------------------------------------------------

/**
 * One grounded meta-pattern — a single row in one of the four categories. The
 * unit the ideators reason over: a named pattern with a salience `signal`, the
 * underlying `count`, and `refs` to drill back to the originals.
 */
export const MetaPatternSchema = z.object({
  /** Stable id for dedup across ticks, e.g. "friction:<signature>", "sink:papercup/worker". */
  id: z.string(),
  /** Human one-line: what the pattern IS. */
  title: z.string(),
  /** Optional detail (counts, decay, $ amount, statuses). */
  detail: z.string().optional(),
  /**
   * Salience score (higher = more significant for ideation). Category-relative:
   * recurrence count for friction, $ for sinks, occurrences×weight for deferrals,
   * recurrence for gaps, churn weight for reverts.
   */
  signal: z.number(),
  /** How many underlying records this pattern rolls up. */
  count: z.number().int().nonnegative(),
  /** Owning harness, when the pattern is harness-scoped. */
  harness: z.string().optional(),
  /**
   * Drill-back references to the originals (never duplicated): e.g.
   * "wi:EI-12", "plan:foo-2026#P-003", "usage:papercup/worker", "audit:F-7".
   */
  refs: z.array(z.string()),
  /** Category-specific extras (decayDays, costUsd, openCount, statuses, …). */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MetaPattern = z.infer<typeof MetaPatternSchema>;

/**
 * `DigestSchema` (B1 deliverable) — the validated shape of a "state of the Hive"
 * corpus digest. The four plan-named meta-pattern categories + a reverts churn
 * substrate + a corpus rollup. `z.infer<typeof DigestSchema>` is the
 * `StateOfHiveDigest` type the Scout loop passes around.
 */
export const DigestSchema = z.object({
  /** ISO generation time (deterministic in tests via opts.nowMs). */
  generatedAt: z.string(),
  /** What corpus was scanned — for honesty about coverage. */
  corpus: z.object({
    completions: z.number().int().nonnegative(),
    reverts: z.number().int().nonnegative(),
    frictionCaptured: z.number().int().nonnegative(),
    deferrals: z.number().int().nonnegative(),
    spendUsd: z.number(),
    spendBuckets: z.number().int().nonnegative(),
  }),
  // The four meta-pattern categories (plan P-003), each ranked signal-desc.
  /** Recurring friction nobody named — same stable signature seen >1×. */
  recurringFriction: z.array(MetaPatternSchema),
  /** Where time/tokens went — the heaviest spend buckets. */
  timeTokenSinks: z.array(MetaPatternSchema),
  /** What keeps being deferred — chronic (recurring) deferrals first. */
  chronicDeferrals: z.array(MetaPatternSchema),
  /** Absent capabilities — net-new asks + repeated "no way to X" friction. */
  capabilityGaps: z.array(MetaPatternSchema),
  /** Undone work — status regressions, churniest items first (substrate signal). */
  reverts: z.array(MetaPatternSchema),
  /** One-line summary for a coord broadcast / the Scout trigger. */
  headline: z.string(),
});
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

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function truncate(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** recurringFriction — recurring (count>1) stable signatures from the friction
 *  queue, ranked recurrence-then-recency. Open recurrence (active friction) is
 *  weighted above resolved. Reuses the improvement loop's recurrence matcher. */
function buildRecurringFriction(friction: ImprovementCandidate[], nowMs: number, limit: number): MetaPattern[] {
  const recurrences: SignatureRecurrence[] = signatureRecurrence(friction, { nowMs }).filter((s) => s.count > 1);
  const byId = new Map(friction.map((c) => [c.id, c] as const));
  return recurrences
    .map((r): MetaPattern => {
      // Open friction still biting outweighs a recurrence that has gone quiet.
      const openBoost = r.openCount > 0 ? 1 + r.openCount / r.count : 0.5;
      const signal = round(r.count * openBoost);
      const exemplar = byId.get(r.ids[0]);
      const title = exemplar ? truncate(exemplar.title) : r.signature;
      return {
        id: `friction:${r.signature.slice(0, 60)}`,
        title,
        detail: `recurred ${r.count}× (${r.openCount} open), last ${r.decayDays}d ago`,
        signal,
        count: r.count,
        refs: r.ids.slice(0, 12).map((id) => `wi:${id}`),
        meta: { signature: r.signature, openCount: r.openCount, resolvedCount: r.resolvedCount, decayDays: r.decayDays },
      };
    })
    .sort((a, b) => b.signal - a.signal)
    .slice(0, limit);
}

/** timeTokenSinks — the heaviest spend buckets (where time/tokens went). */
function buildTimeTokenSinks(spend: SpendRecord[], limit: number): MetaPattern[] {
  return [...spend]
    .filter((s) => s.costUsd > 0 || s.outputTokens > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens)
    .slice(0, limit)
    .map((s): MetaPattern => {
      const harness = s.harness ?? '(unattributed)';
      const role = s.role ?? '(any role)';
      const tokens = s.inputTokens + s.outputTokens;
      return {
        id: `sink:${harness}/${role}`,
        title: `$${round(s.costUsd)} on ${harness} · ${role}`,
        detail: `${s.runs} run(s), ${tokens.toLocaleString()} tokens`,
        signal: round(s.costUsd),
        count: s.runs,
        harness: s.harness ?? undefined,
        refs: [`usage:${harness}/${role}`],
        meta: { costUsd: round(s.costUsd), inputTokens: s.inputTokens, outputTokens: s.outputTokens },
      };
    });
}

/** chronicDeferrals — deferrals aggregated by stable signature so the SAME thing
 *  deferred repeatedly (across items / plans / decisions) reads as *chronic*
 *  (high signal). needs-human punts weigh above blocked; a one-off deferral is a
 *  low-signal current deferral, not yet chronic. */
function buildChronicDeferrals(deferrals: DeferralRecord[], limit: number): MetaPattern[] {
  const groups = new Map<string, DeferralRecord[]>();
  for (const d of deferrals) {
    const sig = dedupSignature(d.text) || d.text.toLowerCase().slice(0, 40);
    const arr = groups.get(sig) ?? [];
    arr.push(d);
    groups.set(sig, arr);
  }
  const weightOf = (status: string): number => (status === 'needs-human' ? 1.5 : status === 'blocked' ? 1.2 : 1);
  return [...groups.entries()]
    .map(([sig, members]): MetaPattern => {
      const signal = round(members.reduce((acc, m) => acc + weightOf(m.status), 0));
      const exemplar = members[0];
      const plans = [...new Set(members.map((m) => m.planSlug))];
      const statuses = [...new Set(members.map((m) => m.status))];
      return {
        id: `deferral:${sig.slice(0, 60)}`,
        title: truncate(exemplar.text),
        detail: `deferred ${members.length}× across ${plans.length} plan(s) [${statuses.join(', ')}]`,
        signal,
        count: members.length,
        refs: members.slice(0, 12).map((m) => `plan:${m.planSlug}#${m.refId}`),
        meta: { signature: sig, plans, statuses },
      };
    })
    // Chronic = recurs OR is a hard stop (needs-human). Rank chronic-first.
    .sort((a, b) => b.count - a.count || b.signal - a.signal)
    .slice(0, limit);
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
  return recurrences
    .map((r): MetaPattern => {
      const exemplar = byId.get(r.ids[0]);
      const isFeature = exemplar?.kind === 'feature';
      // A net-new feature ask is a stronger gap signal than a keyword hit; recurrence amplifies.
      const signal = round(r.count * (isFeature ? 2 : 1) + (r.openCount > 0 ? 1 : 0));
      return {
        id: `gap:${r.signature.slice(0, 60)}`,
        title: exemplar ? truncate(exemplar.title) : r.signature,
        detail: `${isFeature ? 'net-new ask' : 'named missing capability'}${r.count > 1 ? `, asked ${r.count}×` : ''} (${r.openCount} open)`,
        signal,
        count: r.count,
        refs: r.ids.slice(0, 12).map((id) => `wi:${id}`),
        meta: { signature: r.signature, kind: exemplar?.kind, openCount: r.openCount },
      };
    })
    .sort((a, b) => b.signal - a.signal)
    .slice(0, limit);
}

/** reverts — status regressions grouped by work item; the churniest (most-/
 *  hardest-reverted) work first. The substrate signal for "where rework lives". */
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
  return [...groups.entries()]
    .map(([workItemId, g]): MetaPattern => {
      const latest = [...g.records].sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
      return {
        id: `revert:${workItemId}`,
        title: `${workItemId} reverted ${g.records.length}× (latest ${latest.from}→${latest.to})`,
        detail: latest.actor ? `last by ${latest.actor}` : undefined,
        signal: round(g.weight),
        count: g.records.length,
        harness: latest.harness,
        refs: [`wi:${workItemId}`, `audit:${workItemId}`],
        meta: { latestFrom: latest.from, latestTo: latest.to, latestTs: latest.ts },
      };
    })
    .sort((a, b) => b.signal - a.signal)
    .slice(0, limit);
}

/**
 * Synthesize the "state of the Hive" corpus digest. Pure + deterministic given
 * `nowMs`. Gathers all substrates (defensively), rolls each into its
 * meta-pattern category, and returns a `DigestSchema`-valid digest.
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
