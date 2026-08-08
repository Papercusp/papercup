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
  /**
   * An OVERLAY that implies the autonomy axis: entering it means "also mode:set
   * auto if the autonomy axis is empty", and every guard that asks "is this
   * session autonomous?" must count it. Modes on the `autonomy` axis imply it
   * inherently and leave this unset — read the question through
   * `modeImpliesAutonomy`, never by axis alone (goal-mode-2026-08-07 P-012).
   */
  impliesAutonomy?: boolean;
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
Close each su pass as a LOOP, not a blank page: GROUND on blender:ideation-feedback
{ scope: 'mine', intent: '<your pass focus>' } — prior grades + realized outcomes +
per-lens win-rates + the federated frontier read + observationsImpact (which of YOUR
observations became patterns → ideas → shipped; intent re-ranks the priming by relevance) → run
the pass under one lens → FILE lens-tagged, adding a bet/cheapExperiment when the idea is a
real bet → ROUTE the broad ones onward via blender:route-idea → CLOSE with
blender:ideate-pass-record (a measurable su-ideate tick). Grading an su idea wakes its
originator to revise (see GRADE).
(Overlay: stacks with anything — including DRAIN; ideating on why the drain
itself isn't working is a legitimate combination.)`,
  },
  {
    id: 'drain',
    axis: 'overlay',
    impliesAutonomy: true,
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
SU IDEAS: grading an su-filed idea (blender:grade-idea) with a low grade + feedback WAKES its
originator to revise — your critique is the revision signal that closes their loop, not just a
score. (No self-grading: the tool refuses when you authored the row.)
(Overlay: stacks with any autonomy/work-source mode.)`,
  },
  {
    id: 'goal',
    axis: 'overlay',
    impliesAutonomy: true,
    title: 'GOAL — own an outcome, not a queue',
    oneLiner:
      'own a goal end-to-end: create the projects/plans/fleets that reach it, reallocate on evidence, kill on written criteria',
    contract: `## GOAL mode — binding contract
The objective is an OUTCOME, not a queue. You are handed a goal ("ship a paid
app", "reach N users") and you own the whole ladder down to work-items: creating
the projects, plans and fleets that reach it, and REALLOCATING between them as
evidence arrives. A goal runs for weeks, so the posture is portfolio management,
not a single build.
KICKOFF QUESTION (mandatory): before creating anything, read the existing
portfolio (pot:list + plans:list + search:semantic on the goal's terms), report
what ALREADY targets this goal, and settle the two things a goal cannot run
without — its KILL CRITERION and its SPEND CEILING — proposing a concrete value
for each rather than offering a blank menu.
SHAPE (v1): a goal's projects are POTS inside this workspace, not separate
workspaces — no workspace-provisioning path exists yet. So they SHARE this
harness's workspace-widened Mug/Blender/Overwatch and compete with its own
self-improvement for placement and budget, which is what makes the arbitration
clause below load-bearing rather than merely prudent.
OPERATING LOOP, ordered by damage caused if skipped:
1. CAPACITY PREFLIGHT, RAMP ONE AT A TIME — accounts:status + gateway headroom
   before any launch; drive ONE project end-to-end before creating a second.
2. PROVE A CHILD EXECUTES before trusting it: seed one trivial work-item and
   confirm a session with \`adv_sessions.role = 'cup'\` carries it to terminal.
   An \`s-<epochMs>-<hex>\` owner id proves "spawned", NOT "cup" — many spawners
   emit that format, so join to the session row and assert the ROLE. Skip this
   and N children look busy while executing nothing.
3. ONE PLACER PER POT — before launching a fleet into a pot, EITHER leave
   placement to the Mug (just plans:start) OR take the pot yourself
   (pot:set_steering { pauseNewWork: true } / scoped allowedHarnesses) and then
   launch, unpausing at wind-down. Never both: two placers double-place work.
4. A WRITTEN KILL CRITERION PER PROJECT AT CREATION TIME, plus declared expected
   spend and reported actuals. An agent that only ever creates is a ratchet.
5. OWNER-WALLED ACTIONS, NAMED — app-store submission, payment/Stripe setup,
   domain registration, real spend, published marketing. Queue them as owner
   asks and keep working around them; never stall silently, never act
   irreversibly.
6. SHIPPED, NOT GREEN — a feature behind an unflipped flag is dead code; for a
   revenue goal the deliverable is a released artifact with a payment path, not
   a passing suite. Flags ship ON.
7. DEDUP BEFORE CREATING — pot:list / plans:list / search:semantic first.
8. TEMPLATES MANDATE — every new app materializes from a \`scope: "app"\`
   template root, never a hand-rolled tree.
9. RUBRIC REUSE, NOT PROLIFERATION (inherit GRADE's clause) — a fresh rubric per
   project makes trends uncomparable across the portfolio, destroying the
   reallocation signal that is the entire point of running one.
10. POT VS SUB-HARNESS IS YOUR JUDGMENT — a pot buys its own
    repo/blueprint/schema/plans and a blast-radius boundary; under a
    workspace-widened brain it does NOT buy a separate decider.
DURABILITY: a goal outlives any one session, so it must not live in a transcript.
Arm a loop as your wake source and treat the carry surfaces as the goal's real
memory — loop:checkpoint every wake, work_items:checkpoint at every boundary,
and the goal's standing state on its own pot/plan record — so a COLD wake
re-establishes the goal from durable state. A goal that dies with its terminal is
the failure this clause prevents.
REPORT on a standing cadence via coord:escalate / notifyAttention (desktop
notifications are OFF): what moved, what it cost, what is owner-walled, and what
you killed. Without it the owner learns goal state only by asking.
GOAL implies AUTO: if the autonomy axis is empty, also mode:set auto — a goal
agent that stops to ask cannot run for weeks. (Overlay: stacks with anything,
including DRAIN, IDEATE and GRADE.)`,
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

/**
 * Does this mode id put the session in an AUTONOMY posture — i.e. one that is
 * meant to outlive an owner sitting there?
 *
 * Two ways to qualify, and BOTH must be counted: a mode on the `autonomy` axis
 * (auto, cold-auto) qualifies inherently, and an overlay may declare
 * `impliesAutonomy` (drain, goal). Deriving it here is not tidiness — this
 * question was hardcoded at six call sites and three of them had already
 * drifted apart, each omitting `cold-auto` with no comment saying why. The
 * unguarded-halt sweep was one of them, so the single most autonomy-dependent
 * posture in the system was the one it did not sweep. A registry-derived
 * predicate means a new autonomous mode is counted everywhere the moment its
 * row lands, instead of depending on someone finding all six lists
 * (goal-mode-2026-08-07 P-012).
 */
export function modeImpliesAutonomy(id: string): boolean {
  const def = modeById(id);
  if (!def) return false;
  return def.axis === 'autonomy' || def.impliesAutonomy === true;
}

/** Every registered mode id that implies an autonomy posture. */
export function autonomousModeIds(): readonly string[] {
  return MODES.filter((m) => modeImpliesAutonomy(m.id)).map((m) => m.id);
}

/**
 * ── UI display helpers ──────────────────────────────────────────────────────
 *
 * The GUI shows standing modes as chips (the HUD session card, the Sessions
 * roster). Both surfaces used to spell their own label + hover text, so only
 * the three modes someone remembered to write ever got an explanation —
 * `cold-auto` and `grade` fell through to a bare "Standing mode: grade".
 *
 * These derive BOTH from this registry, so a new mode is explained in every
 * chip the moment its row lands here. They are pure string functions over pure
 * data (this module imports nothing), which is what makes them safe to import
 * from the SPA bundle — no PG, no node builtins.
 */

/** Short chip label for a mode id: `cold-auto` → `COLD AUTO`. */
export function modeChipLabel(id: string): string {
  return (modeById(id)?.id ?? id).toUpperCase().replace(/-/g, ' ');
}

/**
 * Hover text for a mode chip: what the mode MEANS, then who armed it.
 *
 * Provenance is the half a human actually needs on a board: "this agent is in
 * AUTO because I put it there" and "this agent put ITSELF in AUTO" call for
 * different reactions, and `agent_modes.owner_directed` already records which.
 */
export function modeChipTitle(id: string, opts?: { ownerDirected?: boolean }): string {
  const def = modeById(id);
  // Newline, not another dash: every registry title already carries its own
  // em-dash ("AUTO — act, don't ask"), so joining with one read as
  // "AUTO — act, don't ask — act on your own judgment…" on the live chip.
  const meaning = def ? `${def.title}\n${def.oneLiner}` : `Standing mode: ${id}`;
  if (opts?.ownerDirected === undefined) return meaning;
  return `${meaning}\n\n${
    opts.ownerDirected
      ? 'Set by the owner — peers cannot override it.'
      : 'The agent set this itself (or a peer did) — an owner instruction overrides it.'
  }`;
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
