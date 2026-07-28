/**
 * The structured recall query — context-injection-audit-2026-07-28 P-042 (F-J).
 *
 * WHY THIS EXISTS. The automatic memory-injection seam took a bare
 * `queryContext: string`, which forced ONE string to be three different things:
 * what the human said, what the agent is actually doing, and what gets issued to
 * the index. Phase 11 separates them, because the measured defect is that the
 * recall query represents the HUMAN's last utterance rather than the TURN — and
 * on a machine-injected turn (a loop fire, a wake envelope, the literal word
 * "continue") the human part is boilerplate or absent, so retrieval is asked a
 * question nobody actually asked.
 *
 * WHAT THIS ITEM DELIBERATELY DOES NOT DO. P-042 is the SEAM ONLY — no retrieval
 * behavior changes here, so it lands and stays revertable on its own.
 * `retrievalQueryText()` still returns the user text alone; P-043 populates the
 * signals and P-044 routes them to the lexical leg. If you are here because you
 * want signals to affect retrieval, the edit belongs in `retrievalQueryText()`
 * — and per D-014 it must ADD to a leg's QUERY, never re-rank or reorder a
 * leg's OUTPUT (reordering a fusion leg rewrites the fusion INPUT, the exact
 * trap F-D caught).
 */

/**
 * Grounded, ACTION-derived context about what the agent is actually doing.
 *
 * ⚠ EVERY FIELD IS AN IDENTIFIER OR A STORED ARTIFACT — NEVER THE AGENT'S OWN
 * PROSE OR THINKING. That exclusion is the whole design point rather than
 * timidity (P-043): prose is what creates the self-confirmation loop — the agent
 * asserts X, retrieval returns X, the agent asserts more X — whereas actions are
 * grounded in verifiable events the agent cannot talk itself into. The two are
 * cleanly separable, so v1 takes the half that carries no such risk. Whether
 * agent prose earns its place at all is deferred to P-047, to be settled on
 * bench evidence rather than a priori. Do not add a free-prose field here
 * without going through that item.
 *
 * Fields are listed in P-043's preference order.
 */
export interface AgentSignals {
  /**
   * (a) The claimed work-item / plan-item. Already structured, already scoped to
   * the agent's real task, and free to obtain — the highest-value source.
   */
  workItem?: {
    /** e.g. `WI-6635`, `EI-18881202063786528`, `P-042`. */
    id?: string;
    title?: string;
    /** The item's STORED body — authored text, not the agent's narration. */
    body?: string;
  };
  /**
   * (b) The recent tool-call trajectory, as IDENTIFIERS ONLY. These are
   * overwhelmingly what the lexical leg exists for and what cosine embedding is
   * worst at, which is why P-044 routes them there rather than into the cosine
   * query.
   */
  trajectory?: {
    /** Repo-relative file paths touched this turn. */
    paths?: readonly string[];
    /** Work-item / feature / plan-item ids referenced (`WI-…`, `EI-…`, `P-…`). */
    ids?: readonly string[];
    /** Symbol names — functions, types, tools — named in tool arguments. */
    symbols?: readonly string[];
  };
  /** (c) The file the agent is working in right now, repo-relative. */
  activeFile?: string;
}

/** A recall query, with the human part and the agent part kept separate. */
export interface RecallQuery {
  /**
   * What the human said — the ONLY thing that reached retrieval before Phase 11.
   * On the turn-start push path this is the raw submitted prompt, envelope and
   * all, which is precisely what makes P-041's origin classification free.
   */
  userText: string;
  /** Grounded agent context. OPTIONAL — see `RecallQueryInput` for why. */
  agentSignals?: AgentSignals;
}

/**
 * What the seam ACCEPTS. A bare string is shorthand for `{ userText }`.
 *
 * ⚠ THIS UNION IS THE DESIGN, not a compatibility shim scheduled for removal.
 * `MemoryInjectionInput` is constructed at ~14 production sites (oracle,
 * architect ×2, operator-converse, launch-profile, mcp-prelude, the memory suite
 * ×6, turn-start-memory, agent-chats, cup-wake-dossier) plus ~45 test fixtures —
 * and only THREE of them, all inside injection.ts, ever READ the field.
 * Requiring the object form would invalidate every construction site at once, in
 * files this change never touches and `test:affected` never selects: the
 * `AgentFact.confidence` / `OwnerSteering.createWakeSuppressPlans` /
 * `PipelinePosition.submodulePin` class, which bit three separate changes on
 * 2026-07-26 alone. And the string form is not merely tolerated — a chat route
 * genuinely has only user text, so those sites are CORRECT to keep passing a
 * string permanently.
 */
export type RecallQueryInput = string | RecallQuery;

/** Normalize the accepted forms to the structured one. */
export function toRecallQuery(input: RecallQueryInput): RecallQuery {
  return typeof input === 'string' ? { userText: input } : input;
}

/**
 * The ONE place that decides what text is issued to the index — and therefore
 * the single edit site for P-044.
 *
 * ⚠ IT IGNORES `agentSignals` ON PURPOSE, and a test pins that. P-042 is the
 * seam only: signals may be CARRIED through the seam but must not yet reach
 * retrieval, so the P-041 baseline being measured right now is not contaminated
 * by a fix it is meant to judge. When P-044 changes this, that test should fail
 * — it is the tripwire, not an obstacle; update it deliberately and say so.
 *
 * ⚠ DO NOT route signals into retrieval by concatenating them into `userText` at
 * a call site. That would send agent identifiers into the COSINE leg, which is
 * exactly what P-044 forbids (identifiers are the lexical leg's job; cosine is
 * worst at them, and it would also corrupt P-041's query-shape telemetry, which
 * records what was asked).
 */
export function retrievalQueryText(query: RecallQuery): string {
  return query.userText;
}
