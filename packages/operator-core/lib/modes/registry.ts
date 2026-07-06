/**
 * Mode registry — the single source of truth for official session modes
 * (modes-and-intake-ux-2026-07-05 P-006/P-008/P-009; owner directive 2026-07-05).
 *
 * Modes were prompt prose; this makes them DATA. Everything derives from here:
 *   - mode:list / mode:get / mode:set read this registry;
 *   - the one-line-per-mode INDEX for always-present prompts is
 *     modeIndexMarkdown() (P-008: the initial prompt carries ONLY the index);
 *   - the FULL binding contract is `contract`, injected on activation
 *     (mode:set returns it; coord:orient re-injects active contracts each
 *     wake — the checkpoint re-injection pattern), so a mode's depth costs
 *     context only while you are IN it.
 *
 * AXES (D-006, corrected by owner 2026-07-05): same-axis modes exclude each
 * other — mode:set AUTO-SWITCHES (replaces the same-axis incumbent, auditing
 * the displacement); everything else STACKS. The ONLY exclusive family is
 * autonomy (auto vs cold-auto — one dial, two positions). Ideate, drain, and
 * grade are overlays, each with its own axis key, stackable with everything —
 * including each other (owner's example: ideate on why the drain isn't
 * working). Absence of a row on an axis = that axis's default posture
 * (manual / no-overlay), deliberately NOT stored.
 */

export type ModeAxis = 'autonomy' | 'overlay';

export interface ModeDef {
  /** Stable id — what mode:set takes and agent_modes.mode stores. */
  id: string;
  axis: ModeAxis;
  title: string;
  /** The one-liner for the always-present index (P-008). Keep it ONE line. */
  oneLiner: string;
  /** The full binding contract, injected on activation. Markdown. */
  contract: string;
}

export const MODES: readonly ModeDef[] = [
  {
    id: 'auto',
    axis: 'autonomy',
    title: 'AUTO — act, don’t ask',
    oneLiner: 'act on your own judgment, replace questions with disclosures, arm a loop for open-ended work',
    contract: `## AUTO mode — binding contract
Act, don't ask. The confirm-before-acting posture is suspended: choose the route,
pass approval gates on your own judgment, and replace every question with a
DISCLOSURE in your report ("want me to X or Y?" menus are banned — pick one, say
which and why). For open-ended directives, arm an engine loop (loop:arm) so work
recurs across turns instead of stopping at "what next?".
What still stops you: nothing owner-shaped except the genuinely owner-walled
actions (credentials, capital arming, category-1/irreversible ops) and the one
hard data rail — never destroy a PEER's uncommitted work (no tree-wide
destructive git ops on the shared checkout). Unresolvable product-direction
forks become disclosed assumptions, not pauses. Whatever you did under AUTO is
disclosed and recorded — autonomy never means invisibility.`,
  },
  {
    id: 'cold-auto',
    axis: 'autonomy',
    title: 'COLD AUTO — auto across fresh-context wakes',
    oneLiner: 'AUTO carried across scheduled cold wakes: fresh context each fire, continuity via the carry-note',
    contract: `## COLD AUTO mode — binding contract
Everything AUTO grants, carried across scheduled wakes with NO human in the room
and NO transcript continuity: each cold fire resets to your carry-note. Your
continuity IS the checkpoint layer, so flushing it is mandatory, not hygiene:
loop:checkpoint { did, left, insight, next } every wake before settling; held
work-items get work_items:checkpoint at every boundary. A cold wake that cannot
reconstruct from the carry-note is a defect — write the note you would need.
Same owner-walls and the peer-work data rail as AUTO. (Same axis as AUTO: you
are in one or the other, never both.)`,
  },
  {
    id: 'ideate',
    axis: 'overlay',
    title: 'IDEATE — invent net-new, don’t just patch',
    oneLiner: 'run deliberate ideation passes and file net-new feature proposals; with AUTO on, build the strongest',
    contract: `## IDEATE mode — binding contract
Ambition is part of the job: run deliberate ideation passes — mine your recent
observations, curation:state-of-pot, rubric freshness/trends, and past graded
proposals — and file net-new feature proposals via improvements:capture
{ kind: "feature" }. Blue-sky is licensed; no quality gate or quota. With AUTO
also on, BUILD the strongest ideas (flag-ON, disclosed), don't just file them.
(Overlay: stacks with anything — including DRAIN; ideating on why the drain
itself isn't working is a legitimate combination.)`,
  },
  {
    id: 'drain',
    axis: 'overlay',
    title: 'DRAIN — drive the queue to terminal',
    oneLiner: 'take a work-item backlog and drive every item to a terminal state; completion integrity over speed',
    contract: `## DRAIN mode — binding contract
The objective is the queue: drive every item of the agreed backlog to a
terminal state (done / resolved / deprecated / needs_human), usually by leading
a fleet. KICKOFF QUESTION (mandatory): before draining, read the live queue
(work_items:completion_stats + a pile/age breakdown) and ask WHICH pile to
drain, with concrete numbers from the data ("9 stale 'Loop iteration' items, 2
canary items — a kind, a harness, oldest-first, or everything?"). Then: triage
+ rank first · capacity preflight · canary launch before the fleet · feed by
claim-spec (never hand-assignment) · monitor each wake · wind down with a
residue report of what genuinely needs the owner. Completion integrity
outranks burn-down speed — nothing goes terminal without evidence. DRAIN
implies AUTO: if the autonomy axis is empty, also mode:set auto — a drain runs
autonomously. (Overlay: stacks with anything, including IDEATE.)`,
  },
  {
    id: 'grade',
    axis: 'overlay',
    title: 'GRADE — monitor via rubrics + scorecards',
    oneLiner: 'stand up rubric-graded monitoring of the given target: reuse a rubric or ratify one, emit scorecards on a loop',
    contract: `## GRADE mode — binding contract
Stand up rubric-graded MONITORING of whatever the owner named, on the
rubric/scorecard system — never ad-hoc prose reports.
1. REUSE FIRST: rubrics:search for an applicable rubric; propose a new one
   (rubrics:propose → ratification) ONLY on a real gap. Rubric proliferation is
   the failure mode — a near-fit existing rubric beats a bespoke new one.
2. LOOP: arm/extend a loop; each wake gathers evidence, emits a scorecard
   (improvements:capture with payloadExtra.observation { rubricRef, ratings,
   kind: 'reinforce' } — every criterion rated, evidence per rating; the
   completeness gate rejects partials), then reads rubrics:trend for direction.
3. CHEAP EVIDENCE: prefer deterministic evidence (dev:pg_query, counters,
   freshness checks) over per-wake LLM judgment — the cheapest grading is
   compute, not inference. Rate honestly: unknown beats invented.
4. TERMS: take cadence + exit criteria from the owner at entry; surface
   worsening trends instead of waiting to be asked.
(Overlay: stacks with any autonomy/work-source mode.)`,
  },
];

/** Look up a mode by id (case-insensitive). */
export function modeById(id: string): ModeDef | null {
  const key = id.trim().toLowerCase();
  return MODES.find((m) => m.id === key) ?? null;
}

/**
 * The agent_modes.axis_key for a mode: exclusive axes use the axis name
 * (one row per axis ⇒ same-axis auto-switch via PK upsert); each overlay
 * gets its own key ⇒ overlays stack.
 */
export function axisKeyFor(def: ModeDef): string {
  return def.axis === 'overlay' ? `overlay:${def.id}` : def.axis;
}

/** The one-line-per-mode index (P-008) — what always-present prompts carry. */
export function modeIndexMarkdown(): string {
  const lines = MODES.map((m) => `- **${m.id}** (${m.axis}): ${m.oneLiner}`);
  return [
    '### Modes — index (details load when a mode is set)',
    ...lines,
    '_Same-axis modes exclude each other (setting one auto-switches); cross-axis modes stack. mode:set { mode, reason } to enter; { enabled: false } to exit; mode:get to see anyone’s._',
  ].join('\n');
}
