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
import type { OpenPlacementSummary } from './placement-watchdog';
import type { OwnerSteering } from '../owner-steering';

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
  /**
   * Open placements the Queen must DRIVE to terminal (the completion mandate) —
   * the watchdog's already-computed state (summarizeOpenPlacements): recovering
   * (re-place NOW), cursed (stop re-placing), stranded (a blocker is stuck),
   * workingTracked (in flight). This is the D-004 "the watchdog already computed
   * it" floor element — surfaced so she clears recoveries each wake without a
   * separate hive:status round-trip.
   */
  openPlacements?: OpenPlacementSummary;
  /**
   * The OVERWATCH's liveness, as the Queen sees it (overwatch-role-2026-06-15
   * B-09 / D-004 — the who-watches-the-watcher reverse leg). `true` = overwatch
   * is alive; `false` = it has gone DARK and the Queen should ESCALATE (she
   * cannot relaunch it — that is structural). `undefined` = overwatch is not in
   * play (flag off / not expected) → the cross-monitor line is omitted entirely.
   */
  overwatchAlive?: boolean;
  /**
   * The owner's steering directive for THIS wake (queen-steering-panel-2026-06-15
   * B-02 / D-004): the authoritative `### Owner steering directive` block —
   * free-text directive + plan eligibility + pause state. Gathered fail-soft by
   * `gatherOwnerSteering` (reads C-1's `getOwnerSteering`); `undefined` ⇒ the Hive
   * is un-steered (default behaviour) and the section is omitted entirely. Expired
   * pauses are normalized away in the gather, so a present pause field here is
   * currently active. The Queen honors it BEFORE placement (advisory in Phase 1;
   * `pause-new-work` is HARD-enforced in `surveyHive`, P-003).
   */
  ownerSteering?: OwnerSteering;
}

/** Per-section list caps so the brief stays a DIGEST, never a raw dump (P-004). */
export interface QueenBriefCaps {
  frontier: number;
  plans: number;
  bees: number;
  inbox: number;
  changeFeed: number;
  escalations: number;
  placements: number;
}

export const DEFAULT_QUEEN_BRIEF_CAPS: QueenBriefCaps = {
  frontier: 12,
  plans: 8,
  bees: 20,
  inbox: 10,
  changeFeed: 8,
  escalations: 10,
  placements: 12,
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
      'just to gather this; act on it. Drill into detail this digest omits with a tool ' +
      'only when you need it (page deeper in your inbox, a specific bee/plan/thread).',
  );

  if (f.wokeBy && f.wokeBy.trim()) {
    out.push('');
    out.push(`**Woke by:** ${f.wokeBy.trim()}`);
  }

  // Interactive-brain teaching (queen-interactive-brain-fresh-context P-004):
  // the interactive `psu --brain` dock pane runs the SU engineer playbook + this
  // injected brief — it does NOT load queen.md, so it never sees queen.md's
  // "Each wake is a FRESH session — re-derive, never remember" teaching. Mirror it
  // HERE, gated on the interactive-brain wake, so the dock Queen trusts this
  // freshly-computed brief instead of assuming a carried conversation. (The
  // autonomous Queen already gets this from queen.md; the floor/digest sections
  // below are identical for both.)
  if (f.wokeBy?.trim() === 'interactive-brain') {
    out.push('');
    out.push(
      '**Fresh-per-launch (the dock brain model):** each time the brain pane opens you ' +
        'are a BRAND-NEW session — no transcript of any prior dock conversation carries ' +
        'over (by design). Do NOT assume you remember earlier turns; re-derive your ' +
        'working state from this brief and the durable substrate it summarizes. Continuity ' +
        'rides three durable channels, never a carried transcript: (1) THIS precomputed ' +
        'brief (your survey, already done); (2) your carry-note below (what you left your ' +
        'next self via `hive:declare-wake { remember }`); (3) the steering substrate ' +
        '(work-item claims / `blocked_by` edges / priorities / the decision ledger). ' +
        'Anchor anything that must survive the next dock-open in one of those, not in the ' +
        'conversation — it will be gone next launch; the artifacts will not.',
    );
  }

  if (f.headroom) {
    out.push(`**Spawn headroom:** ${f.headroom.headroom} free (${f.headroom.running}/${f.headroom.ceiling} running)`);
  }

  // OWNER STEERING — the owner's authoritative directive for this wake
  // (queen-steering-panel-2026-06-15 B-02 / D-004). Rendered BEFORE the frontier so
  // she reads her constraints before deciding what to place. Present only when the
  // Hive is actually steered (gatherOwnerSteering returns undefined otherwise +
  // normalizes away expired pauses), so an un-steered Hive sees no section.
  const os = f.ownerSteering;
  if (os) {
    out.push('');
    out.push('### Owner steering directive (AUTHORITATIVE — honor before placement)');
    if (os.pauseNewWork || os.pausedUntil != null) {
      const until = os.pausedUntil != null ? ` until ${new Date(os.pausedUntil).toISOString()}` : '';
      out.push(
        `**PAUSED${until} — start NO new work.** Drive existing placements to terminal, then idle; ` +
          'do NOT place new frontier work this wake.',
      );
    }
    if (os.eligiblePlans.length > 0) {
      out.push(
        `**Eligible plans ONLY:** ${os.eligiblePlans.join(', ')} — place work only from these plans; ` +
          'start nothing outside them.',
      );
    }
    if (os.eligibleHives.length > 0) {
      out.push(
        `**Eligible hives ONLY:** ${os.eligibleHives.join(', ')} — place work only INTO these ` +
          'hives/harnesses (the survey frontier is already scoped to them); leave others alone.',
      );
    }
    if (os.directive && os.directive.trim()) {
      out.push(os.directive.trim());
    }
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

  // Open placements — the completion mandate (drive to terminal). The watchdog's
  // already-computed state; surfaced so she clears recoveries each wake (D-004).
  const op = f.openPlacements;
  if (op && op.recovering + op.cursed + op.stranded + op.workingTracked > 0) {
    out.push('');
    out.push('### Placements — drive to terminal (your completion mandate)');
    out.push(
      `recovering ${op.recovering} (re-place NOW) · cursed ${op.cursed} (STOP re-placing) · ` +
        `stranded ${op.stranded} (blocker stuck) · working ${op.workingTracked} (in flight)`,
    );
    for (const it of op.items.slice(0, caps.placements)) {
      out.push(`- ${it.workItemId} [${it.status}]${it.harness ? ` (${it.harness})` : ''}${it.failCount ? ` ×${it.failCount} fails` : ''}`);
    }
    const overflow = op.items.length - caps.placements;
    if (overflow > 0) out.push(`…+${overflow} more (hive:status to drill down)`);
  }

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
    'Inbox — recent (addressed to you)',
    (f.inbox ?? []).map((m) => `- [${m.kind}]${m.from ? ` ${m.from}:` : ''} ${m.summary}`),
    caps.inbox,
    'coord:inbox to page deeper',
  );

  section(out, 'Change feed — recent', (f.changeFeed ?? []).map((l) => `- ${l}`), caps.changeFeed, 'curation:change-feed to drill down');

  section(
    out,
    'Open escalations',
    (f.escalations ?? []).map((e) => `- ${e.id}${e.severity ? ` (${e.severity})` : ''}: ${e.summary}`),
    caps.escalations,
    'curation:feed to drill down',
  );

  // CROSS-MONITOR — the overwatch's liveness (D-004 reverse leg). Rendered only
  // when overwatch is in play (defined): a DARK overwatch is a critical signal
  // to ESCALATE (the Queen cannot relaunch it — structural); alive is a quiet
  // one-liner. Undefined ⇒ overwatch not in play ⇒ omitted (no noise).
  if (f.overwatchAlive !== undefined) {
    out.push('');
    out.push('### Cross-monitor (who-watches-the-watcher)');
    out.push(
      f.overwatchAlive
        ? '- overwatch alive'
        : '- ⚠ OVERWATCH DARK — your supervisor has gone silent. ESCALATE (coord:escalate / owner); ' +
            'do not assume the system is being watched. You cannot relaunch overwatch — that is structural.',
    );
  }

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
