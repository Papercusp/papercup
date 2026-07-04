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
import { IDLE_ACTIVITY_KINDS, type OwnerSteering } from '../owner-steering';

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
 * Live inference-pool capacity digest (queen-capacity-aware-dispatch-2026-06-22 P-002) — the SOURCE-side
 * read of the shared gateway oracle, so the Queen sizes the batch to what the pool can FEED, not just to her
 * spawn ceiling. A compact projection of `buildCapacityReport`; the full breakdown is `fleet:capacity`.
 * Gathered fail-soft (the gateway fetch degrades to omitted, never blocks the brief).
 */
export interface BriefCapacity {
  /** Pool spare-capacity factor in [0,1] (1 = full headroom, 0 = no fresh capacity). */
  factor: number;
  /** Bee-tier spare slots right now (dispatchBudget = cap − inFlight − queued); null when the tier layer is off. */
  dispatchBudget: number | null;
  utilizationPct: number | null;
  paused: boolean;
  /** Fresh-gateway startup grace: a blocked/zero-capacity snapshot is recovering, not sustained exhaustion. */
  restartRecovering?: boolean;
  processUptimeMs?: number | null;
  /** One-line dispatch advice (place broadly / hold the tail / tier-1 only). */
  advice: string;
}

/**
 * The deterministic FLOOR — objective world-state. `frontier`/`frontierBlocked`/
 * `plans` come straight from `surveyHive` (P-005 reuse, don't fork); the rest are
 * the watchdog's already-computed wake signals (bees, inbox, change-feed,
 * escalations, what-woke-me, headroom).
 */
export interface QueenBriefFloor {
  /**
   * The hive/harness slug THIS brief is for (EI-3419). There is one workspace
   * Queen covering every started hive, and her carry-note/carry-journal is
   * WORKSPACE-scoped, not hive-scoped (`hiveScope()` in carry-note.ts returns a
   * constant key by design) — so a note written during a wake for hive A is
   * still the one she reads back during a LATER wake for hive B. Rendering the
   * ground-truth hive slug here, ahead of the carry-note, gives every wake an
   * unambiguous anchor to catch a stale/foreign-scope carry-note against,
   * instead of silently trusting whatever hive the note happens to name.
   */
  hiveSlug?: string;
  /** What woke the Queen this turn (event key / note / 'timer' / 'backstop'). */
  wokeBy?: string;
  /** Spawn concurrency budget. */
  headroom?: { ceiling: number; running: number; headroom: number };
  /** Live inference-pool capacity digest (P-002) — size the batch to this, not just the spawn ceiling. */
  capacity?: BriefCapacity;
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

export interface QueenBriefTextCaps {
  totalChars: number;
  lineChars: number;
  carryNoteChars: number;
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

export const DEFAULT_QUEEN_BRIEF_TEXT_CAPS: QueenBriefTextCaps = {
  // Keep the volatile wake tail below model admission limits. The Queen can
  // drill down with tools when the digest omits detail.
  totalChars: 4_000,
  lineChars: 900,
  carryNoteChars: 700,
};

export interface QueenBriefInput {
  floor: QueenBriefFloor;
  /** LEGACY single carry-note (P-015) — rendered only when `carryJournal` is absent/empty. */
  carryNote?: string | null;
  /** The Queen's carry-JOURNAL, NEWEST FIRST (queen-memory-hybrid L1a) — her
   *  recent wake notes rendered as the trajectory section. */
  carryJournal?: Array<{ at: number; note: string }> | null;
  /** STANDING FACTS (queen-memory-hybrid L1c) — pre-rendered deterministic fold
   *  block (agent-facts renderFactsFold over workspace + role:queen + harness
   *  scopes). Delivered verbatim every wake until expiry/retraction. */
  factsFold?: string | null;
  /** mem0 BACKGROUND RECALL (queen-memory-hybrid L1d) — pre-rendered fuzzy
   *  recall block (harness memory pool, bounded). Rendered AFTER the facts fold
   *  and labeled non-authoritative. */
  memoryFold?: string | null;
  /** Override the default per-section caps. */
  caps?: Partial<QueenBriefCaps>;
  /** Override text-size caps. Intended for tests and emergency tuning only. */
  textCaps?: Partial<QueenBriefTextCaps>;
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
  return `${i + 1}. ${c.id} — ${title}${importanceTag(c)}${c.needsStart ? ' (needs start)' : ''} [${c.harness}] (rank ${r.rank.score.toFixed(2)})${whyOf(r)}`;
}

function truncateText(value: string, maxChars: number, label = 'truncated'): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  const marker = `…[${label}; ${value.length - maxChars} chars omitted]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function capRenderedBrief(lines: readonly string[], caps: QueenBriefTextCaps): string {
  const lineChars = Math.max(80, Math.floor(caps.lineChars));
  const totalChars = Math.max(1_000, Math.floor(caps.totalChars));
  let text = lines.map((line) => truncateText(line, lineChars, 'line truncated')).join('\n');
  if (text.length <= totalChars) return text;

  const marker = `\n\n…[brief truncated to ${totalChars} chars; drill down with hive:survey / coord:inbox / curation:feed as needed]`;
  if (marker.length >= totalChars) return marker.slice(0, totalChars);
  text = text.slice(0, totalChars - marker.length).trimEnd();
  return `${text}${marker}`;
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
  const textCaps = { ...DEFAULT_QUEEN_BRIEF_TEXT_CAPS, ...input.textCaps };
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

  // EI-3419: the ground-truth hive anchor, rendered BEFORE "Woke by" so it is
  // the first concrete fact a fresh-per-wake Queen reads — an unambiguous
  // cross-check point against a carry-note/journal that may (by the substrate's
  // own workspace-wide scope, not this brief's fault) reference a different hive.
  if (f.hiveSlug && f.hiveSlug.trim()) {
    out.push('');
    out.push(`**Hive (this wake):** ${f.hiveSlug.trim()}`);
  }

  if (f.wokeBy && f.wokeBy.trim()) {
    out.push('');
    out.push(`**Woke by:** ${f.wokeBy.trim()}`);
  }

  // ── MEMORY SECTIONS FIRST (queen-memory-hybrid L1, position fix 2026-07-02) ──
  // These are SMALL and orientation-critical, so they render BEFORE the floor's
  // bulky lists: capRenderedBrief truncates the TAIL when over budget, and when
  // they were appended last a floor-heavy brief silently dropped exactly them
  // (caught by the L1 live-verify). Order: objective standing facts → own
  // trajectory → fuzzy background; the floor's long sections are the right
  // truncation victims.
  const factsFold = (input.factsFold ?? '').trim();
  if (factsFold) {
    out.push('');
    out.push(factsFold);
  }
  // EI-3419: this substrate is WORKSPACE-scoped (one shared store across every
  // hive this Queen operates — see hiveScope() in carry-note.ts), not scoped to
  // the hive above, so an entry here may be trailing intention from a wake for a
  // DIFFERENT hive. Only worth stating when there's a ground-truth hive to check
  // against; keep it one line so it doesn't drown the note itself.
  const scopeCaveat = f.hiveSlug?.trim()
    ? ` — shared across every hive this Queen operates; if it names a different hive than **${f.hiveSlug.trim()}** above, IGNORE it and re-derive from this wake's floor instead`
    : '';
  const journal = (input.carryJournal ?? []).filter((e) => (e.note ?? '').trim().length > 0);
  if (journal.length > 0) {
    out.push('');
    out.push(
      `### Your carry-journal (your own notes from recent wakes, newest first — in-flight intention, not world-state${scopeCaveat}; leave the next one via declare-wake { remember })`,
    );
    const journalBudget = Math.max(600, Math.floor(textCaps.carryNoteChars) * 3);
    let journalUsed = 0;
    for (const e of journal) {
      const line = `- ${e.at > 0 ? `[${new Date(e.at).toISOString().slice(5, 16)}Z] ` : ''}${e.note}`;
      if (journalUsed + line.length > journalBudget) break;
      out.push(line);
      journalUsed += line.length;
    }
  } else {
    const legacyNote = (input.carryNote ?? '').trim();
    if (legacyNote) {
      out.push('');
      out.push(`### Your carry-note (you wrote this last wake — your in-flight intention, not world-state${scopeCaveat})`);
      out.push(truncateText(legacyNote, Math.floor(textCaps.carryNoteChars), 'carry-note truncated'));
    }
  }
  const memoryFold = (input.memoryFold ?? '').trim();
  if (memoryFold) {
    out.push('');
    out.push(memoryFold);
  }

  // Legacy interactive-brain wake teaching (queen-interactive-brain-fresh-context
  // P-004). `psu --brain` is retired, but old wake metadata may still carry this
  // marker; keep the fresh-session teaching here for historical rows.
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

  // INFERENCE CAPACITY — the SOURCE-side read of the gateway oracle (P-002). Size the batch to what the
  // pool can FEED, not just to the spawn ceiling above; `fleet:capacity` drills in. Omitted when not gathered
  // (gateway off / fetch failed) — fail-soft, never blocks the brief.
  if (f.capacity) {
    const c = f.capacity;
    out.push(
      `**Inference capacity:** ${c.dispatchBudget != null ? `~${c.dispatchBudget} bee slot(s) free` : 'tier layer off'} · ` +
        `util ${c.utilizationPct != null ? `${c.utilizationPct}%` : 'n/a'} · factor ${c.factor.toFixed(2)}` +
        `${c.paused && !c.restartRecovering ? ' · ⚠ POOL PAUSED' : ''}` +
        `${c.restartRecovering && c.processUptimeMs != null ? ` · gateway uptime ${Math.round(c.processUptimeMs / 1000)}s` : ''}` +
        ` — ${c.advice}`,
    );
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

    // Throttle + self-governance knobs (queen-steering-panel P-006/P-009). Most are
    // HARD-enforced at their live seams (cadence clamp, spawn ceiling, idle-action
    // gates, scale-out gate) — surfaced here so the Queen plans WITHIN the envelope
    // instead of fighting it (e.g. don't request a tighter wake, don't plan 20 bees
    // when capped at 5, don't run a gym cycle when gym is gated off). Decomposition
    // is purely advisory (no seam) — a steer on how aggressively to parallelize.
    const throttle: string[] = [];
    if (os.cadenceFloorSec != null) {
      throttle.push(
        `- Wake-cadence floor: **≥${os.cadenceFloorSec}s between wakes** — pace yourself; a tighter self-wake is clamped up to this.`,
      );
    }
    if (os.maxBees != null) {
      throttle.push(
        `- Concurrency ceiling: **≤${os.maxBees} bees** running at once — plan within it; spawns past it queue, they do not run.`,
      );
    }
    if (os.tierCeilings && Object.keys(os.tierCeilings).length > 0) {
      throttle.push(
        `- Model-tier ceilings (this session): ${Object.entries(os.tierCeilings)
          .map(([role, tier]) => `${role}→${tier}`)
          .join(', ')} — spawns are pinned/clamped to these.`,
      );
    } else if (os.modelTiers && os.modelTiers.length > 0) {
      throttle.push('- Model-tier menu overridden for this session (spawns resolve against the session menu).');
    }
    if (os.idleActivities) {
      const off = IDLE_ACTIVITY_KINDS.filter((k) => os.idleActivities?.[k] === false);
      if (off.length > 0) {
        throttle.push(`- Idle activities OFF: **${off.join(', ')}** — do NOT run these when idle (the seam already skips them).`);
      }
    }
    if (os.autoScaleOut === false) {
      throttle.push(
        '- Auto-scale-out DISABLED — no new accounts will be auto-deployed on rate-limit exhaustion; throttle the loop instead of expecting more capacity.',
      );
    }
    if (os.decomposition) {
      const hint =
        os.decomposition === 'serial'
          ? 'one lane at a time — minimize parallel bees'
          : os.decomposition === 'parallel'
            ? 'maximize independent parallel lanes'
            : 'moderate parallelism — balance throughput and coordination';
      throttle.push(`- Decomposition (advisory): prefer **${os.decomposition}** — ${hint}.`);
    }
    if (throttle.length > 0) {
      out.push('');
      out.push('**Throttle + self-governance (owner-set — work within this envelope):**');
      out.push(...throttle);
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
    // EI-6104: this is a point-in-time snapshot taken when your brief was
    // assembled — a fast-draining queue can clear these between then and now.
    // An empty Frontier above alongside nonzero counts here is the tell
    // (phantom completion pressure, not real backlog) — reconcile with a fresh
    // `hive:survey` / `fleet:assignments` read before acting on it as-is.
    if (f.frontier.length === 0) {
      out.push(
        '_(snapshot at wake-time — if this conflicts with the empty Frontier above, re-check `hive:survey` before re-placing/escalating)_',
      );
    }
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

  // (queen-memory-hybrid L1 sections render EARLY, right after Woke-by — see the
  // position-fix comment there. Nothing memory-related renders in the tail.)

  return capRenderedBrief(out, textCaps);
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
