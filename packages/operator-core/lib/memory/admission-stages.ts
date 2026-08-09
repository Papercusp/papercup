/**
 * The admission funnel's STAGE VOCABULARY — the six filters between "what the
 * index returned" and "what the agent got", and what each one means in words.
 *
 * WHY THIS IS ITS OWN MODULE, split out of `recall-stats.ts` (WI-37549): the
 * agent dossier renders these stages to a human, and `recall-stats.ts` imports
 * `@papercusp/flags/server`, so importing the vocabulary from there would drag
 * server-only code into the operator's client bundle. The alternative — a
 * hand-copied gloss in the UI — is how "3 dropped by dedup" and its explanation
 * drift apart, which is the exact failure the design-intent text below exists to
 * prevent. So: one definition, no server imports, importable by both sides.
 *
 * `recall-stats.ts` re-exports every symbol here, so existing importers and the
 * write path are unchanged.
 */

/**
 * The filter stages between "what the index returned" and "what the agent got",
 * in pipeline order — migration 758 / P-002.
 *
 * Named rather than positional so a stage inserted later cannot silently shift
 * every historical row's meaning.
 */
export type AdmissionStage =
  /** knowledge-pack rows whose pack is disabled for the hive. */
  | 'pack'
  /** memory_feedback: the user deleted this fact (or a re-extraction of it). */
  | 'feedback'
  /** the user pool's workspace scoping — a `project` hit from another workspace. */
  | 'workspace'
  /** already surfaced this session-epoch (or inside the wall-clock window). */
  | 'dedup'
  /** near-duplicate collapse — the same fact stored under several ids. */
  | 'nearDuplicate'
  /** did not fit the char budget. */
  | 'budget';

export const ADMISSION_STAGES: readonly AdmissionStage[] = [
  'pack',
  'feedback',
  'workspace',
  'dedup',
  'nearDuplicate',
  'budget',
];

/**
 * ONE CLAUSE per stage, for rendering beside a live count in the dossier.
 *
 * Deliberately short where `ADMISSION_STAGE_DESIGN_INTENT` below is long: that
 * one is the argument you read BEFORE filing a loss as a defect, this one is
 * what makes a bare number legible at a glance ("8 — did not fit the char
 * budget" rather than "8"). They are not redundant and neither replaces the
 * other; the panel that shows this should point at the other.
 *
 * Phrased as the reason a row was DROPPED, so it reads correctly after a count:
 * `${n} — ${ADMISSION_STAGE_SHORT_WHY[stage]}`.
 */
export const ADMISSION_STAGE_SHORT_WHY: Record<AdmissionStage, string> = {
  pack: 'belongs to a knowledge pack disabled for this hive',
  feedback: 'the user deleted this fact, so it is not re-surfaced',
  workspace: 'scoped to another workspace (a cross-workspace correctness boundary)',
  dedup: 'already surfaced in this session-epoch',
  nearDuplicate: 'the same fact under another id, collapsed after ranking',
  budget: 'did not fit the char budget, cut after ranking',
};

/**
 * WHY each stage drops what it drops — the DESIGNED loss, next to the metric.
 *
 * This exists because the funnel reports WHAT was lost and never WHY, and a bare
 * large number reads as a defect. Three work-items in the context-injection lane
 * filed a deliberate design behaviour as a bug off these counters
 * (context-injection-retrieval-reach-and-visibility-2026-08-03 D-063, D-073,
 * D-074). The failure is systematic, not careless: the stages tuned MOST
 * aggressively produce the MOST alarming numbers, so the funnel indicts exactly
 * the stages someone already thought hardest about.
 *
 * ⚠ TWO RULES BEFORE YOU FILE A LOSS AS A DEFECT (D-076):
 *
 * 1. SPLIT BY SURFACE FIRST. Never aggregate `dropped` across ports. `mid-turn`
 *    is ~91% of recalls and ~89% of returned rows, so it sets any workspace-wide
 *    aggregate by itself — and its budget is an order of magnitude smaller than
 *    every other port's ON PURPOSE. An aggregate over sub-populations with
 *    deliberately different targets will always indict whichever one was designed
 *    to be most aggressive. That is arithmetic, not evidence.
 * 2. READ THE INTENT BELOW (and the writer it names). A loss is a defect only if
 *    it CONTRADICTS its own design intent.
 *
 * Corollary worth stating plainly: an acceptance criterion phrased "make metric X
 * move off zero" is suspect on its face. Zero may be the specification — see
 * `AdmittedByLeg.lexicalOnly`, whose zero is structural.
 */
export const ADMISSION_STAGE_DESIGN_INTENT: Record<AdmissionStage, string> = {
  pack: 'Configuration, not relevance: the row belongs to a knowledge pack disabled for this hive. Nonzero is expected wherever packs are off; it says nothing about retrieval quality.',
  feedback:
    'CORRECT BY CONSTRUCTION — the user deleted this fact. This loss must never be "fixed"; a zero here where deletions exist would mean deletions are not being honoured. Higher is not worse.',
  workspace:
    'A correctness boundary, not a filter to relax: a `project` hit leaking from another workspace. Reducing this loss means leaking cross-workspace memory.',
  dedup:
    'Already surfaced in this session-epoch. THE ONE STAGE WHERE A HIGH VALUE IS GENUINELY DIAGNOSTIC — but of the EPOCH, not of the filter. Sustained ~60% means the epoch is not advancing (the P-022 cutover orphaned the bump for 6 days; D-072), not that dedup is too aggressive. Residual loss on a live epoch is genuine within-epoch repeats and is correct. Check `memory_session_epochs` for organic bumps before touching anything here.',
  nearDuplicate:
    'The same fact stored under several ids, collapsed after ranking. Correct dedup; the loss is the feature.',
  budget:
    'Deliberately aggressive, and PER-PORT — this is the stage that has caused the most false defect reports. `mid-turn` runs ~350 chars against a 16,000-char global default because that port is a per-tool-call interruption that "must be cheap enough to ignore" (mid-turn-context.ts); its low admit rate is the design working (D-073). DO NOT raise MID_TURN_BUDGET_CHARS off an aggregate — it taxes every agent on ~89% of all retrieval volume. ⚠ This text used to name turn-start as the port that was NOT deliberately tightened; it IS (4,000 vs the 16,000 default, "D-004 small budget", turn-start-memory.ts) — EVERY port here is tightened, so "untightened" is never the argument (D-077). Reopen a budget only when a stated PREMISE of its decision changed, and A/B it — %budget falls by construction when you raise the budget, so it cannot validate the change; read the admitted rate.',
};
