/**
 * queen-brief — the Queen's precomputed per-wake brief
 * (queen-brief-cache-assembly-2026-06-13 B-03: P-004 two-part schema, P-005 reuse).
 *
 * The brief is the survey snapshot the Queen would otherwise gather through ~5
 * deterministic tool round-trips every wake (`hive:survey`, `fleet:assignments`,
 * `coord:presence`, `curation:change-feed`, `coord:inbox`). The deterministic
 * watchdog already computes this to decide whether to wake her (D-004), so
 * handing it to her costs nothing extra and saves the round-trips.
 *
 * TWO PARTS (D-009):
 *   1. FLOOR — objective world-state, system/watchdog-computed, ALWAYS included,
 *      NOT suppressible: frontier digest (ready/blocked, ranked), bee load +
 *      liveness, inbox delta, change-feed digest, what-woke-me, open escalations.
 *      A DIGEST (capped), never a raw dump.
 *   2. CARRY-NOTE — the Queen's own subjective in-flight intention from the prior
 *      wake (P-015), ADDITIVE to the floor, her content + length, replace-
 *      semantics. Degrades gracefully: absent → the floor alone (re-derive).
 *
 * Cache discipline (D-001): the rendered block changes every wake, so the caller
 * passes it as `buildPrompt({ queenBrief })`, which rides the VOLATILE TAIL as a
 * `<system-reminder>` — never the cacheable preamble.
 *
 * The renderer is PURE + deterministic (no Date.now / Math.random in the output;
 * inputs arrive already-ranked from `surveyHive`), so it unit-tests with no DB
 * and the same floor always renders the same bytes.
 */
import type { Ranked } from '../queue-ranker';
import type { PlacementCandidate } from './placement-ranker';
import type { HiveSurvey } from './survey';

/** A live bee's load + liveness, from `fleet:assignments`. */
export interface BriefBee {
  /** The bee's coord id / label. */
  id: string;
  /** Head-of-line work it is doing now (work-item id / short label), if any. */
  doing?: string | null;
  /** Claimed-work count (its work-list depth). */
  load: number;
  /** Liveness — a fresh heartbeat. A dead bee with an unfinished unit is a re-place signal. */
  alive: boolean;
}

/** One new inbox item since the last wake (`coord:inbox` delta). */
export interface BriefInboxItem {
  kind: string;
  from?: string;
  summary: string;
}

/** One open escalation needing attention (`curation:feed` / `coord:escalations`). */
export interface BriefEscalation {
  id: string;
  severity?: string;
  summary: string;
}

/**
 * The deterministic FLOOR — objective world-state. `frontier`/`frontierBlocked`/
 * `plans` come straight from `surveyHive` (P-005 reuse, don't fork); the rest are
 * the watchdog's already-computed wake signals (bees, inbox, change-feed,
 * escalations, what-woke-me, headroom).
 */
export interface QueenBriefFloor {
  /** What woke the Queen this turn (event key / note / 'timer' / 'backstop'). */
  wokeBy?: string;
  /** Spawn concurrency budget. */
  headroom?: { ceiling: number; running: number; headroom: number };
  /** Ready-to-place frontier, already ranked (HiveSurvey.frontier). */
  frontier: readonly Ranked<PlacementCandidate>[];
  /** Lanes held back by unsatisfied blocked_by (HiveSurvey.frontierBlocked). */
  frontierBlocked?: number;
  /** Started plans with momentum, already ranked (HiveSurvey.plans). */
  plans?: readonly Ranked<PlacementCandidate>[];
  /** Live bees: load + liveness (fleet:assignments). */
  bees?: readonly BriefBee[];
  /** New inbox items since the last wake (coord:inbox delta). */
  inbox?: readonly BriefInboxItem[];
  /** Recent change-feed digest lines (curation:change-feed), newest-first. */
  changeFeed?: readonly string[];
  /** Open escalations needing attention. */
  escalations?: readonly BriefEscalation[];
}

/** Per-section list caps so the brief stays a DIGEST, never a raw dump (P-004). */
export interface QueenBriefCaps {
  frontier: number;
  plans: number;
  bees: number;
  inbox: number;
  changeFeed: number;
  escalations: number;
}

export const DEFAULT_QUEEN_BRIEF_CAPS: QueenBriefCaps = {
  frontier: 12,
  plans: 8,
  bees: 20,
  inbox: 10,
  changeFeed: 8,
  escalations: 10,
};

export interface QueenBriefInput {
  floor: QueenBriefFloor;
  /** The Queen's self-authored carry-note from the prior wake (P-015). */
  carryNote?: string | null;
  /** Override the default per-section caps. */
  caps?: Partial<QueenBriefCaps>;
}

/**
 * The most-salient "why" for a ranked candidate — the reason line from the
 * feature that contributed most to its score (deterministic: highest
 * contribution first, stable sort for ties). Empty when no feature gave a reason.
 */
function whyOf(r: Ranked<PlacementCandidate>): string {
  const withReasons = r.rank.features
    .filter((fc) => fc.reasons && fc.reasons.length > 0)
    .slice()
    .sort((a, b) => b.contribution - a.contribution);
  const reason = withReasons[0]?.reasons.find((s) => s && s.trim());
  return reason ? ` · ${reason.trim()}` : '';
}

function importanceTag(c: PlacementCandidate): string {
  return c.importance && c.importance !== 'normal' ? ` (${c.importance})` : '';
}

function renderCandidateLine(r: Ranked<PlacementCandidate>, i: number): string {
  const c = r as unknown as PlacementCandidate; // Ranked<T> = T & { rank }
  const title = c.title || c.id;
  return `${i + 1}. ${c.id} — ${title}${importanceTag(c)} [${c.harness}] (rank ${r.rank.score.toFixed(2)})${whyOf(r)}`;
}

/** Append a capped list section; emits a "+N more" overflow line when truncated. */
function section(out: string[], heading: string, lines: readonly string[], cap: number, drillHint?: string): void {
  if (lines.length === 0) return;
  out.push('');
  out.push(`### ${heading}`);
  for (const line of lines.slice(0, cap)) out.push(line);
  const overflow = lines.length - cap;
  if (overflow > 0) out.push(`…+${overflow} more${drillHint ? ` (${drillHint})` : ''}`);
}

/**
 * Render the Queen's two-part wake brief as a deterministic markdown block.
 * Pass the result to `buildPrompt({ queenBrief })` — it rides the volatile tail
 * inside a `<system-reminder>` (the renderer does NOT add those tags; the prompt
 * assembler does, so the same block can also be delivered as a real
 * mid-conversation system message when the transport allows, D-006).
 */
export function renderQueenBrief(input: QueenBriefInput): string {
  const caps = { ...DEFAULT_QUEEN_BRIEF_CAPS, ...input.caps };
  const f = input.floor;
  const out: string[] = [];

  out.push('## Your wake brief — precomputed survey snapshot');
  out.push(
    'This is the deterministic floor the watchdog already computed for this wake. ' +
      'It replaces your every-wake survey reads — do NOT re-run `hive:survey`, ' +
      '`fleet:assignments`, `coord:presence`, `coord:inbox`, or `curation:change-feed` ' +
      'just to gather this; act on it. Drill into a specific bee/plan/thread with a tool only when you need detail this digest omits.',
  );

  if (f.wokeBy && f.wokeBy.trim()) {
    out.push('');
    out.push(`**Woke by:** ${f.wokeBy.trim()}`);
  }
  if (f.headroom) {
    out.push(`**Spawn headroom:** ${f.headroom.headroom} free (${f.headroom.running}/${f.headroom.ceiling} running)`);
  }

  // FRONTIER — ready-to-place, ranked. Always present (the heading even when empty
  // so "nothing ready" is an explicit, trustworthy signal, not an omission).
  out.push('');
  out.push('### Frontier — ready to place (ranked)');
  if (f.frontier.length === 0) {
    out.push('_empty — no ready work to place._');
  } else {
    for (let i = 0; i < Math.min(f.frontier.length, caps.frontier); i++) {
      out.push(renderCandidateLine(f.frontier[i], i));
    }
    const overflow = f.frontier.length - caps.frontier;
    if (overflow > 0) out.push(`…+${overflow} more (work_items:list to drill down)`);
  }
  if (f.frontierBlocked && f.frontierBlocked > 0) {
    out.push(`(+${f.frontierBlocked} lane(s) held back by unsatisfied blocked_by — not yet placeable)`);
  }

  section(
    out,
    'Plans — momentum (ranked)',
    (f.plans ?? []).map((p, i) => renderCandidateLine(p, i)),
    caps.plans,
    'hive:survey to drill down',
  );

  section(
    out,
    'Bees — load + liveness',
    (f.bees ?? []).map(
      (b) => `- ${b.id}: load ${b.load}${b.doing ? `, doing ${b.doing}` : ''} ${b.alive ? '[alive]' : '[DEAD — re-place its unit]'}`,
    ),
    caps.bees,
    'fleet:assignments to drill down',
  );

  section(
    out,
    'Inbox — new since last wake',
    (f.inbox ?? []).map((m) => `- [${m.kind}]${m.from ? ` ${m.from}:` : ''} ${m.summary}`),
    caps.inbox,
    'coord:inbox to drill down',
  );

  section(out, 'Change feed — recent', (f.changeFeed ?? []).map((l) => `- ${l}`), caps.changeFeed, 'curation:change-feed to drill down');

  section(
    out,
    'Open escalations',
    (f.escalations ?? []).map((e) => `- ${e.id}${e.severity ? ` (${e.severity})` : ''}: ${e.summary}`),
    caps.escalations,
    'curation:feed to drill down',
  );

  // CARRY-NOTE — additive second half (P-015). Absent → floor alone (re-derive).
  const note = (input.carryNote ?? '').trim();
  if (note) {
    out.push('');
    out.push('---');
    out.push('### Your carry-note (you wrote this last wake — your in-flight intention, not world-state)');
    out.push(note);
  }

  return out.join('\n');
}

/**
 * Adapter (P-005 reuse): build a `QueenBriefFloor` from a `HiveSurvey` plus the
 * watchdog's other already-computed wake signals. The survey supplies
 * frontier/plans/blocked; the caller supplies the live bee/inbox/change-feed/
 * escalation/headroom/woke-by signals it gathered for the wake decision (D-004).
 */
export function floorFromSurvey(
  survey: Pick<HiveSurvey, 'frontier' | 'plans' | 'frontierBlocked'>,
  signals: Omit<QueenBriefFloor, 'frontier' | 'plans' | 'frontierBlocked'> = {},
): QueenBriefFloor {
  return {
    frontier: survey.frontier,
    plans: survey.plans,
    frontierBlocked: survey.frontierBlocked,
    ...signals,
  };
}
