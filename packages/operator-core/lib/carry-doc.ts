/**
 * carry-doc — the deterministic CARRY DOCUMENT builder
 * (deterministic-context-carry-2026-07-14 P-009, plan D-002/D-003/D-004).
 *
 * The no-LLM replacement for native summarizers. Where {@link buildCarryBrief}
 * (predecessor plan compaction-continuity-hardening-2026-07-07 P-003) assembles
 * the continuity STATE — loop carry-note, held-WI checkpoints (verbatim),
 * directives, walls, facts, awaits, fleet — this layers the remaining P-009
 * carry-document slots ON TOP of that brief and renders ONE deterministic
 * handoff document a successor opens on:
 *
 *   - a structured IDENTITY BLOCK (su-id, harness, workspace, fleet, account);
 *   - SESSION-MODE FLAGS (AUTO on/off + owner-directed, armed loop + interval);
 *   - PLAN STATE (the caller's claimed / wip plan items);
 *   - open owner ASKS (P-015 coord:ask-owner records);
 *   - the standing carry brief, VERBATIM (renderCarryBriefText);
 *   - a VERBATIM TAIL (recent turns; tool outputs already decayed to pointers);
 *   - the SELF-RECALL POINTER (the surviving verbatim transcript is searchable).
 *
 * Two invariants inherited from the plan: the document is assembled from the DB
 * and DEGRADES BY DROP-TO-POINTER, never by abstractive summary (D-004); and it
 * is provenance-stamped mechanically from the turn ledger, never by a reader-LLM
 * (D-003). Every read leg is independently best-effort — a throwing reader
 * yields that slot empty, never a failed document — because this runs at the
 * worst possible moment (context exhausted, session about to reset).
 *
 * All legs have real default readers (each still an injectable test seam):
 * identity + session-mode from the brief + modes store; plan-state via the
 * adopted agent-name (assignment is keyed on the NAME a session adopts, not the
 * coordination ownerId); asks from the open kind='question' conversations the
 * caller asked; the verbatim tail from the caller's transcript (the consumer
 * passes its own transcriptPath — the session-id→file resolution is the
 * consumer's knowledge), with every USER turn mechanically stamped
 * owner-typed / agent-injected from the recorded ⟦turn-origin:…⟧ envelope
 * (classifyRecordedTurn — D-003; the WI-3532 manufactured-directive killer).
 * P-010 refines the tail's last-turn handling; v1 renders the plain tail.
 */
import {
  buildCarryBrief,
  renderCarryBriefText,
  type BuildCarryBriefOpts,
  type CarryBrief,
} from './carry-brief';
import { CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import { modeImpliesAutonomy } from './modes/registry';
import type { RecordedTurnClass } from './turn-provenance/turn-ref';
import {
  AUTOMATIC_COMPACTION_RECOVERY_MARKER,
  MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION,
  type AutomaticCompactionRecovery,
} from './agent-tools/coordination/compaction-recovery';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface CarryDocIdentity {
  /** The session's coordination identity (PAPERCUSP_SID / su-id). */
  ownerId: string;
  ownerLabel: string | null;
  /** The session's harness slug (null for an operator/harness-null session). */
  harness: string | null;
  workspaceId: string;
  fleet: { slug: string; role: string | null } | null;
  /** The account pin, when known (best-effort — often unavailable at build time). */
  account: string | null;
}

export interface CarryDocMode {
  mode: string;
  /** True when a human owner set this mode (vs a machine/self transition) — the
   *  provenance the successor needs before treating the mode as an owner order. */
  ownerDirected: boolean;
  reason: string | null;
}

export interface CarryDocSessionMode {
  /** Active modes (AUTO, DRAIN, …) with their owner-directed provenance. */
  modes: CarryDocMode[];
  loopActive: boolean;
  loopIntervalSec: number | null;
  /**
   * EI-20072281215342526: the armed loop's GOAL — the session's MISSION.
   *
   * The carry document printed the loop's INTERVAL and not its goal, so a respawned
   * successor was told a loop existed but not what it was for. The mission was durable
   * the whole time (in the loop row), and reached the successor through no channel at
   * all: the wake kickoff that renders it is a different wake path, and `loop:status`
   * did not return it either. Optional so an older caller compiles unchanged.
   */
  loopGoal?: string | null;
}

export interface CarryDocPlanItem {
  itemId: string;
  planSlug: string;
  /** Stored/effective status when known (wip / todo / blocked / …). */
  status: string | null;
  /** assigned / claimed / … — the caller's relation to the item. */
  disposition: string;
}

export interface CarryDocAsk {
  id: string;
  question: string;
  askedAtMs: number | null;
  /** WI-5682: standing-fact key(s) whose decided conclusion strongly overlaps this
   *  question — i.e. the ask MAY re-litigate an already-decided directive (the
   *  "directive downgraded to a question, carried forever as undecided" failure).
   *  Absent when nothing overlaps. Annotates, never drops the ask. */
  possiblyDecidedBy?: string[];
}

export interface CarryDocTailTurn {
  speaker: 'owner' | 'assistant' | 'user';
  /** Verbatim prose (tool outputs are expected pre-decayed to pointers, D-004). */
  text: string;
  ts: string | null;
  /** MECHANICAL owner-vs-agent classification of a user turn (D-003 — stamped
   *  by the system from the recorded ⟦turn-origin:…⟧ envelope, never asserted
   *  by an LLM). Absent/null = unclassified; assistant turns carry none. A
   *  successor must never read an 'agent-injected' turn as owner words — the
   *  WI-3532 manufactured-directive class this stamp exists to kill. */
  provenance?: RecordedTurnClass | null;
}

/**
 * The last-turn / continuation handling (P-010). At a boundary the single most
 * load-bearing turn is the owner's FINAL message — because a successor's job is
 * to continue it, and getting its status wrong (treating an open question as
 * handled, or a machine wake as the owner) is the expensive failure. This block
 * types that turn explicitly so the consumer never has to re-derive it from prose:
 *   - `lastOwnerMessage` — the final OWNER-typed turn (identified mechanically by
 *     the D-003 provenance stamp, never by speaker heuristic). When present and
 *     UNANSWERED the consumer (P-018 psu respawn) delivers its `text` as the
 *     successor's ACTUAL first prompt, so the render never quotes it as tail
 *     material (a quoted copy reads as already-handled history — the exact
 *     confusion this avoids);
 *   - `answered` — did a model turn follow it? false = the owner's message is
 *     still OPEN; a deliberate compaction across it is refused
 *     ({@link gateOpenOwnerQuestion});
 *   - `deliberate` — did this boundary land at a CLEAN point (a settled turn) vs
 *     FORCED mid-turn? A forced boundary may have truncated an in-flight reply,
 *     so the successor trusts the tail less. Also the refuse-once gate key
 *     ({@link gateOpenOwnerQuestion}).
 *   - `selfRequested` — did the SESSION ITSELF ask for this cut
 *     (session:request-compaction, after running its flush discipline)? A
 *     watchdog-initiated cut can be clean (`deliberate: true`) yet NOT
 *     self-requested — the session never flushed, so the successor must verify
 *     checkpoint freshness instead of trusting a "state was flushed" claim
 *     (the 2026-07-18 mislabel: a watchdog force-cut rendered as "self-requested
 *     at a clean point — state was flushed").
 */
export interface CarryDocContinuation {
  lastOwnerMessage: { text: string; ts: string | null } | null;
  answered: boolean;
  deliberate: boolean;
  selfRequested: boolean;
}

export interface CarryDoc {
  /** The standing continuity brief (loop note, held checkpoints, walls, facts…). */
  brief: CarryBrief;
  /** D-017: rich recovery is pushed with the boundary document. Optional keeps
   *  legacy/test literals readable; absence deliberately renders the fallback. */
  automaticRecovery?: AutomaticCompactionRecovery | null;
  identity: CarryDocIdentity;
  sessionMode: CarryDocSessionMode;
  planItems: CarryDocPlanItem[];
  asks: CarryDocAsk[];
  tail: CarryDocTailTurn[];
  /** Last-turn continuation handling (P-010) — how a successor must treat the
   *  final owner message and this boundary. */
  continuation: CarryDocContinuation;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

export const CARRY_DOC_MAX_PLAN_ITEMS = 12;
export const CARRY_DOC_MAX_ASKS = 8;
export const CARRY_DOC_MAX_TAIL_TURNS = 8;
const TAIL_TURN_CAP = 4000;
const ASK_CAP = 400;

/**
 * The self-recall pointer — a constant, because the surviving verbatim
 * transcript is the same recovery mechanism at every boundary. A successor that
 * re-derives dropped state from scratch when it could retrieve it verbatim is
 * the failure this line prevents (compaction-strategy: the record SURVIVES).
 */
export const SELF_RECALL_POINTER =
  "Anything this document dropped is recoverable verbatim: sessions:search { session:'self', " +
  "mode:'verbatim', query:'<what you remember>' } finds the exact pre-boundary quote with its " +
  "surrounding turns; sessions:read { session:'self' } reads the tail.";

/** Boundary contract: delivery first, orient only as a conditional fallback. */
export const REORIENT_BANNER =
  'This is a stale snapshot of a live system, but its post-compaction recovery is pushed ' +
  'automatically below. A complete marker means do not re-fetch it; use the named fallback ' +
  'exactly once only when the marker is absent, incomplete, or control-generation-mismatched.';

// ── Build ─────────────────────────────────────────────────────────────────────

export interface BuildCarryDocOpts extends BuildCarryBriefOpts {
  harness?: string | null;
  account?: string | null;
  ownerLabel?: string | null;
  /** The caller's native transcript file, for the verbatim-tail leg. The session
   *  id → transcript path resolution belongs to the CONSUMER (it knows its own
   *  session), so a path is passed in rather than derived from the coordination
   *  ownerId (which names the coordination identity, not the transcript file). */
  transcriptPath?: string | null;
  /** Which client wrote the transcript (default 'claude'). */
  transcriptSourceKind?: 'claude' | 'omp' | 'codex';
  /** Was this boundary reached at a CLEAN point (a settled turn) vs FORCED
   *  mid-turn? Feeds the P-010 continuation flags. Defaults to `false` (treat as
   *  forced/unknown) — the safe under-promise: a successor trusts a "forced"
   *  tail less, and the clean-boundary paths assert `true` explicitly. Only a
   *  deliberate boundary can be REFUSED across an open owner question
   *  ({@link gateOpenOwnerQuestion}). */
  boundaryDeliberate?: boolean;
  /** Did the SESSION ITSELF request this cut (session:request-compaction — i.e.
   *  its flush discipline presumably ran) vs an EXTERNAL initiator (the
   *  compaction watchdog) cutting a session that never asked? Defaults to
   *  `boundaryDeliberate` (the historical meaning of "deliberate" WAS
   *  self-requested, so existing callers keep their semantics); the watchdog's
   *  clean soft rung passes `false` explicitly so the rendered continuation
   *  never claims a flush that did not happen. */
  boundarySelfRequested?: boolean;
  // Test seams — each defaults to the real reader (or a best-effort empty leg).
  buildCarryBriefFn?: (ownerId: string, opts: BuildCarryBriefOpts) => Promise<CarryBrief>;
  buildAutomaticRecoveryFn?: (
    ownerId: string,
    workspaceId: string,
    opts: { sessionHarness?: string | null; heldItems?: CarryBrief['heldItems'] },
  ) => Promise<AutomaticCompactionRecovery>;
  getModesFn?: (workspaceId: string, ownerId: string) => Promise<CarryDocMode[]>;
  getPlanItemsFn?: (ownerId: string, workspaceId: string) => Promise<CarryDocPlanItem[]>;
  getAsksFn?: (ownerId: string, workspaceId: string) => Promise<CarryDocAsk[]>;
  getTailFn?: (ownerId: string) => Promise<CarryDocTailTurn[]>;
}

/** Read active modes → the AUTO/owner-directed provenance the successor needs.
 *  Best-effort: a throwing store yields no mode rows, never a failed document. */
async function defaultGetModes(workspaceId: string, ownerId: string): Promise<CarryDocMode[]> {
  try {
    const { getModes } = await import('./modes/store');
    const rows = await getModes(workspaceId, ownerId);
    return rows.map((r) => ({
      mode: r.mode,
      ownerDirected: Boolean(r.ownerDirected),
      reason: r.reason ?? null,
    }));
  } catch {
    return [];
  }
}

/** Read the caller's claimed / in-flight plan items. Assignment is keyed on EITHER
 *  the agent-NAME a session adopts OR its raw coordination ownerId (EI-15910/
 *  EI-2299 — a push assignment made by ownerId, e.g. coord:dispatch, targets that
 *  identity directly, with no adoption ever happening) — match both identity axes
 *  so a successor's carry doc doesn't silently drop an assignment made straight to
 *  its own ownerId just because it never adopted a name.
 *  Best-effort: a throwing read yields no items, never a failed document. */
async function defaultGetPlanItems(ownerId: string, workspaceId: string): Promise<CarryDocPlanItem[]> {
  try {
    const { resolveAdoptedName } = await import('./plan-items/agent-names');
    const name = await resolveAdoptedName(workspaceId, ownerId);
    const { myItemsWithStateForIdentities } = await import('./plan-items/liveness');
    const items = await myItemsWithStateForIdentities(workspaceId, name ? [name, ownerId] : [ownerId]);
    return items.map((s) => ({
      itemId: s.assignment.itemId,
      planSlug: s.assignment.planSlug,
      // myItemsWithStateForIdentities pairs assignment+live-claim but does not
      // fetch the plan item's stored status; the disposition (active /
      // assigned-idle / …) is the load-bearing state here. Status stays null
      // until a leg fetches it.
      status: null,
      disposition: s.disposition,
    }));
  } catch {
    return [];
  }
}

/** Read the caller's still-OPEN questions (the P-015 typed ask slot — a question
 *  the owner/peers were asked and hasn't been answered). A successor must not
 *  silently self-answer one. Both coord:ask-owner and knowledge-first coord:ask
 *  land as kind='question' conversations with no stored owner-vs-peer flag, so
 *  v1 surfaces every open question THIS owner asked (asker_id === ownerId); the
 *  owner-directed refinement is a later leg. The conversation store scopes reads
 *  by the ambient request workspace, so pin the caller's workspace for the read.
 *  Best-effort: a throwing read yields no asks, never a failed document. */
async function defaultGetAsks(ownerId: string, workspaceId: string): Promise<CarryDocAsk[]> {
  try {
    const [{ listConversations }, { runWithWorkspaceIfConcrete }] = await Promise.all([
      import('./agent-tools/coordination/conversations'),
      import('./workspace-als'),
    ]);
    const rows = await runWithWorkspaceIfConcrete(workspaceId, () =>
      listConversations({ kind: 'question', state: 'open', limit: CARRY_DOC_MAX_ASKS * 4 }),
    );
    return rows
      .filter((r) => r.asker_id === ownerId)
      .map((r) => ({
        id: r.id,
        question: r.title ?? r.body,
        askedAtMs: r.created_ts ? Date.parse(r.created_ts) : null,
      }));
  } catch {
    return [];
  }
}

/** WI-5682: significant-token set for the ask↔fact overlap check — lowercased
 *  words ≥4 chars (hyphen/underscore kept, so `papercusp-workspace` stays one
 *  token) minus common filler. Deterministic (no LLM/embeddings — the carry doc
 *  is assembled LLM-free by design). */
const ASK_FACT_STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'into', 'your', 'have', 'been', 'will', 'would',
  'should', 'could', 'than', 'then', 'them', 'some', 'more', 'most', 'only', 'just',
  'over', 'under', 'about', 'still', 'like', 'also', 'each', 'does', 'they', 'their',
  'what', 'when', 'which', 'were', 'where', 'here', 'there', 'these', 'those', 'being',
  'want', 'need', 'needs', 'make', 'made', 'used', 'using', 'onto', 'them', 'else',
]);

function significantTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (!ASK_FACT_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Minimum distinct significant tokens an ask must share with a fact before the
 *  ask is flagged as "may already be decided" — conservative to avoid crying
 *  wolf on a genuinely-open question. */
const MIN_ASK_FACT_OVERLAP = 4;

/**
 * WI-5682: flag any carried open owner-ask that RE-LITIGATES an already-decided
 * standing fact — the exact failure that let `conv-mrssq5xh` ("fold in the 55
 * bugs?") ride the carry as an open question for days AFTER the owner had already
 * directed the move + a fact recorded it. A decided directive re-surfaced as an
 * undecided question is a continuity bug; here we make the carry doc SURFACE the
 * collision so a successor verifies against the fact instead of blindly treating
 * the ask as open. Conservative keyword overlap; ANNOTATES, never drops an ask.
 */
export function flagAsksAgainstFacts(
  asks: CarryDocAsk[],
  facts: Array<{ key: string; body: string }>,
): CarryDocAsk[] {
  if (!facts.length || !asks.length) return asks;
  const factTokens = facts.map((f) => ({ key: f.key, toks: significantTokens(f.body) }));
  return asks.map((a) => {
    const qToks = significantTokens(a.question);
    if (qToks.size === 0) return a;
    const hits: Array<{ key: string; shared: number }> = [];
    for (const f of factTokens) {
      let shared = 0;
      for (const t of qToks) if (f.toks.has(t)) shared += 1;
      if (shared >= MIN_ASK_FACT_OVERLAP) hits.push({ key: f.key, shared });
    }
    if (!hits.length) return a;
    hits.sort((x, y) => y.shared - x.shared);
    return { ...a, possiblyDecidedBy: hits.slice(0, 2).map((h) => h.key) };
  });
}

/** Read the verbatim tail from the caller's transcript, mapped to tail turns.
 *  Every USER turn gets the mechanical owner-vs-agent stamp (D-003): the
 *  recorded ⟦turn-origin:…⟧ envelope is durable in the transcript, so
 *  classifyRecordedTurn decides from what was written at injection time —
 *  never from what the text claims. No-ops (empty) when no transcript path is
 *  supplied; best-effort otherwise. */
async function defaultGetTail(opts: BuildCarryDocOpts): Promise<CarryDocTailTurn[]> {
  if (!opts.transcriptPath) return [];
  try {
    const [{ readVerbatimTail }, { classifyRecordedTurn }] = await Promise.all([
      import('./turn-journal'),
      import('./turn-provenance/turn-ref'),
    ]);
    const turns = await readVerbatimTail(
      opts.transcriptPath,
      opts.transcriptSourceKind ?? 'claude',
      CARRY_DOC_MAX_TAIL_TURNS,
    );
    return turns.map((t) => ({
      speaker: t.speaker,
      text: t.text,
      ts: t.ts ? t.ts.toISOString() : null,
      provenance: t.speaker === 'user' ? classifyRecordedTurn(t.text) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Assemble the caller's carry document. Layers the P-009 slots on top of
 * {@link buildCarryBrief}; every leg is independently best-effort.
 */
export async function buildCarryDoc(ownerId: string, opts: BuildCarryDocOpts = {}): Promise<CarryDoc> {
  const build = opts.buildCarryBriefFn ?? buildCarryBrief;
  const brief = await build(ownerId, opts).catch(
    (): CarryBrief => ({
      ownerId,
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    }),
  );
  const ws = opts.workspaceId ?? 'default';

  const buildAutomaticRecovery =
    opts.buildAutomaticRecoveryFn ??
    (async (
      id: string,
      workspaceId: string,
      recoveryOpts: { sessionHarness?: string | null; heldItems?: CarryBrief['heldItems'] },
    ) => {
      const { buildAutomaticCompactionRecovery } = await import(
        './agent-tools/coordination/compaction-recovery'
      );
      return buildAutomaticCompactionRecovery(id, workspaceId, recoveryOpts);
    });
  const automaticRecovery = await buildAutomaticRecovery(ownerId, ws, {
    sessionHarness: opts.harness ?? brief.loop?.harness ?? null,
    heldItems: brief.heldItems,
  }).catch(() => null);

  const getModes = opts.getModesFn ?? defaultGetModes;
  const modes = await getModes(ws, ownerId).catch(() => [] as CarryDocMode[]);

  const getPlanItems = opts.getPlanItemsFn ?? defaultGetPlanItems;
  const planItems = await getPlanItems(ownerId, ws).catch(() => [] as CarryDocPlanItem[]);

  const getAsks = opts.getAsksFn ?? defaultGetAsks;
  const rawAsks = await getAsks(ownerId, ws).catch(() => [] as CarryDocAsk[]);
  // WI-5682: flag any open owner-ask that re-litigates a decided standing fact,
  // so a successor verifies against the fact instead of carrying it as undecided.
  const asks = flagAsksAgainstFacts(rawAsks, brief.facts);

  const getTail = opts.getTailFn ? () => opts.getTailFn!(ownerId) : () => defaultGetTail(opts);
  const tail = (await getTail().catch(() => [] as CarryDocTailTurn[])).slice(-CARRY_DOC_MAX_TAIL_TURNS);

  return {
    brief,
    automaticRecovery,
    identity: {
      ownerId,
      ownerLabel: opts.ownerLabel ?? null,
      harness: opts.harness ?? brief.loop?.harness ?? null,
      workspaceId: ws,
      fleet: brief.fleet,
      account: opts.account ?? null,
    },
    sessionMode: {
      modes,
      loopActive: Boolean(brief.loop?.active),
      loopIntervalSec: brief.loop?.intervalSec ?? null,
      loopGoal: brief.loop?.goal ?? null,
    },
    planItems: planItems.slice(0, CARRY_DOC_MAX_PLAN_ITEMS),
    asks: asks.slice(0, CARRY_DOC_MAX_ASKS),
    tail,
    continuation: deriveContinuation(
      tail,
      opts.boundaryDeliberate ?? false,
      opts.boundarySelfRequested,
    ),
  };
}

/**
 * EI-18684357744098956: the epoch ms of the MOST RECENT timestamped tail turn —
 * "session active until" for the held-item checkpoint staleness comparison
 * ({@link renderCarryBriefText}'s `sessionActivityMs`). The tail is not
 * guaranteed chronologically monotonic by every reader, so this takes the max
 * over all entries rather than trusting the last one; null when nothing in the
 * tail carries a parseable timestamp (no transcript, or every ts absent) — the
 * comparison is then simply skipped, never guessed. Pure.
 */
function latestTailTurnMs(tail: ReadonlyArray<CarryDocTailTurn>): number | null {
  let max: number | null = null;
  for (const t of tail) {
    if (!t.ts) continue;
    const ms = Date.parse(t.ts);
    if (!Number.isFinite(ms)) continue;
    if (max == null || ms > max) max = ms;
  }
  return max;
}

// ── Continuation / last-turn handling (P-010, pure) ─────────────────────────────

const CONT_PREVIEW_CAP = 240;

function isOwnerSpeechVerdict(verdict: string | null | undefined): boolean {
  return verdict === 'owner-typed' || verdict === 'owner-dialog';
}

/**
 * Derive the {@link CarryDocContinuation} from the (already-capped) verbatim tail.
 * The "final owner message" is the LAST tail turn mechanically stamped
 * `owner-typed` (D-003) — never the last `speaker:'owner'`/`'user'` turn, because
 * a wake-pump or self-compaction turn is recorded as a user turn yet is
 * agent-injected, NOT the owner (the WI-3532 manufactured-directive class). Pure.
 */
export function deriveContinuation(
  tail: ReadonlyArray<CarryDocTailTurn>,
  boundaryDeliberate: boolean,
  boundarySelfRequested: boolean = boundaryDeliberate,
): CarryDocContinuation {
  // A cut can only have been self-requested if it was also clean/deliberate.
  const selfRequested = boundaryDeliberate && boundarySelfRequested;
  let idx = -1;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (isOwnerSpeechVerdict(tail[i].provenance?.verdict)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    // No owner turn in the recent tail ⇒ nothing owner-shaped is open. `answered`
    // is vacuously true (there is no open owner question to cross).
    return { lastOwnerMessage: null, answered: true, deliberate: boundaryDeliberate, selfRequested };
  }
  const owner = tail[idx];
  // Answered ⇔ a model turn FOLLOWS the owner's final message in the tail.
  const answered = tail.slice(idx + 1).some((t) => t.speaker === 'assistant');
  return {
    lastOwnerMessage: { text: owner.text, ts: owner.ts },
    answered,
    deliberate: boundaryDeliberate,
    selfRequested,
  };
}

/**
 * Derive JUST the {@link CarryDocContinuation} for a session's own transcript —
 * the verbatim tail read + per-turn provenance stamp ({@link classifyRecordedTurn})
 * + {@link deriveContinuation} — WITHOUT the rest of the carry-doc assembly
 * (modes / plan-items / asks / brief rebuild). session:request-compaction uses
 * this to surface the P-010 open-owner-question warn on its hot path without
 * paying for a whole {@link buildCarryDoc}. Best-effort by construction: an
 * unreadable/absent transcript yields an empty tail ⇒ `{ lastOwnerMessage:null,
 * answered:true }` (nothing open), so a caller's warn stays SILENT rather than
 * firing blind on a read miss.
 */
export async function deriveSessionContinuation(opts: {
  transcriptPath?: string | null;
  transcriptSourceKind?: 'claude' | 'omp' | 'codex';
  boundaryDeliberate?: boolean;
  boundarySelfRequested?: boolean;
}): Promise<CarryDocContinuation> {
  const tail = await defaultGetTail({
    transcriptPath: opts.transcriptPath ?? undefined,
    transcriptSourceKind: opts.transcriptSourceKind,
  });
  return deriveContinuation(
    tail.slice(-CARRY_DOC_MAX_TAIL_TURNS),
    opts.boundaryDeliberate ?? false,
    opts.boundarySelfRequested,
  );
}

export interface OpenOwnerQuestionGate {
  /** True when a DELIBERATE compaction/handoff would cross an UNANSWERED owner
   *  message — the boundary the consumer must refuse once. A distinct, SEMANTIC
   *  tripwire alongside the P-016 flush ladder (which keys on the brief, not the
   *  tail's provenance), so it lives here rather than in the done enforcement gate. */
  crossesOpenOwnerMessage: boolean;
  /** Actionable refusal text — present only when `crossesOpenOwnerMessage`. */
  refusalText?: string;
}

/**
 * The P-010 rule "never deliberately compact across an unanswered owner question."
 * Trips ONLY when the boundary is deliberate AND the owner's final message is open:
 * a FORCED boundary is not a choice to refuse (its safety net is that the same
 * `lastOwnerMessage` is delivered to the successor as its first prompt — nothing is
 * lost, just carried). Pure — the consumer (session:request-compaction / P-018)
 * wires the actual bounce, mirroring the P-016 gate's single-refuse shape.
 */
export function gateOpenOwnerQuestion(cont: CarryDocContinuation): OpenOwnerQuestionGate {
  if (!cont.deliberate || !cont.lastOwnerMessage || cont.answered) {
    return { crossesOpenOwnerMessage: false };
  }
  return {
    crossesOpenOwnerMessage: true,
    refusalText:
      'This compaction is HELD: your owner\'s final message is still UNANSWERED, and this is a ' +
      'DELIBERATE boundary — do not abandon it across the cut. Either answer it first, or, if you are ' +
      'compacting to gain room to answer, retry: the successor receives that exact message as its ' +
      'first prompt (never as quoted history), so the question is carried, not lost.',
  };
}

// ── Constant budget B + aging ladder (P-010's sibling, P-011; plan D-004/D-001) ──

/**
 * The carry document's total budget is a CONSTANT fraction of the window
 * (~10%, plan P-011) — the whole point is that it is INVARIANT IN N: it never
 * grows with the number of turns/hops/session length. It can be, because every
 * slot is individually bounded by a constant (a snapshot is O(1); a sliding
 * window and a top-K store are O(K)); no slot is append-only-in-context, so the
 * SUM is O(constant). The fraction, not a fixed char count, honors D-001 (derive
 * from the actual limit, never adapt from history).
 */
export const CARRY_DOC_BUDGET_FRACTION = 0.1;

/**
 * The budget B in CHARACTERS for an effective window (in TOKENS). Floored at one
 * coherent verbatim tail so a small window never trims below a usable handoff;
 * degenerate input falls back to that same floor. Depends only on the window —
 * invariant in N by construction.
 */
export function carryDocBudgetChars(effectiveWindowTokens: number): number {
  const floor = CARRY_DOC_MAX_TAIL_TURNS * TAIL_TURN_CAP;
  const w = Number(effectiveWindowTokens);
  if (!Number.isFinite(w) || w <= 0) return floor;
  return Math.max(floor, Math.floor(w * CARRY_DOC_BUDGET_FRACTION * CHARS_PER_TOKEN_ESTIMATE));
}

/** The three admissible bound-kinds for a carry slot (plus 'derived', a function
 *  of another bounded slot). The audit's whole job is that EVERY slot maps to one
 *  of these — never 'append-only-in-context' (unbounded growth with N). */
export type CarryDocSlotKind = 'snapshot' | 'sliding-window' | 'top-k' | 'derived';

export interface CarryDocSlotAudit {
  slot: string;
  kind: CarryDocSlotKind;
  /** The constant that bounds it — the audit evidence. */
  boundedBy: string;
}

/**
 * The executable slot audit (P-011): every carry slot classified by its bound.
 * A test iterates this and asserts each `kind` is one of the admissible bounded
 * kinds — so "reject anything append-only-in-context" is enforced by construction,
 * not by review. The embedded standing brief carries carry-brief's own top-K legs
 * (held items ≤6, facts ≤8, awaits ≤8, bounded directives/walls); its only
 * unbounded dimension is per-ITEM verbatim text (a held checkpoint is large), which
 * the budget fit below drops-to-pointer — and those checkpoints are re-injected
 * mechanically on the next wake/pickup, so the pointer loses nothing.
 */
export const CARRY_DOC_SLOTS: readonly CarryDocSlotAudit[] = Object.freeze([
  { slot: 'automaticRecovery', kind: 'snapshot', boundedBy: 'one marker + compact live recovery summary' },
  { slot: 'identity', kind: 'snapshot', boundedBy: 'fixed identity fields' },
  { slot: 'sessionMode', kind: 'snapshot', boundedBy: 'active modes + loop flags' },
  { slot: 'planItems', kind: 'top-k', boundedBy: `CARRY_DOC_MAX_PLAN_ITEMS=${CARRY_DOC_MAX_PLAN_ITEMS}` },
  { slot: 'asks', kind: 'top-k', boundedBy: `CARRY_DOC_MAX_ASKS=${CARRY_DOC_MAX_ASKS}` },
  { slot: 'tail', kind: 'sliding-window', boundedBy: `last ${CARRY_DOC_MAX_TAIL_TURNS} turns × ${TAIL_TURN_CAP} chars` },
  { slot: 'continuation', kind: 'derived', boundedBy: 'derived from the tail (preview capped)' },
  { slot: 'brief', kind: 'top-k', boundedBy: 'carry-brief top-K legs; per-item text bounded by the budget fit' },
]);

/**
 * The AGING LADDER (P-011). When the assembled document exceeds B, sheddable
 * sections drop-to-pointer (D-004 — never abstractive summary) in a fixed order.
 * `keep` is the SPEND order (most load-bearing gets budget first); `shed` is its
 * reverse. Ordering rationale: the standing brief sheds FIRST because its held
 * checkpoints/facts/walls are re-injected mechanically on the next wake/pickup —
 * a pointer there loses the least; the tail then ages (oldest turns drop first)
 * before it too becomes a pointer; the small, high-value asks/plan-state slots
 * spend first and almost always survive. The always-keep head/continuation/
 * self-recall are the successor's minimum viable orientation and never shed.
 */
export const CARRY_DOC_SHED_LADDER = Object.freeze(['brief', 'tail', 'planState', 'asks'] as const);

// ── Render (pure) ──────────────────────────────────────────────────────────────

function cap(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t;
}

/**
 * EI-18697157970421032: a plain, comparable build-time stamp for the top of
 * every carry document — the concrete counterpart to REORIENT_BANNER's prose
 * instruction. `now` is the moment THIS document was assembled (not when it
 * is eventually delivered), so a successor reading it can diff it against its
 * own current wall-clock and judge staleness directly, instead of relying
 * solely on remembering to re-orient. Pure; exported for direct testing.
 *
 * EI-18894888815338094 (the carry-respawn BLIND WINDOW): this stamp is when
 * the document was ASSEMBLED, and delivery can lag it by up to 30 minutes —
 * but the pre-respawn session does not necessarily stop working the instant
 * the document is built. It can keep running real, durable tool calls (an
 * experiment finishing, a file written, a work-item checkpointed) right up
 * until it actually dies, and NONE of that lands in this already-frozen
 * document — a successor was observed re-building an experiment from scratch
 * that had, in fact, already completed 7 minutes after this stamp. So this
 * document is a LOWER BOUND on what was done, never an upper one: before
 * (re)constructing anything this doc describes as pending — an experiment, an
 * artifact, an analysis — check for evidence newer than this stamp first (the
 * artifact directory, the work-item's own comments/checkpoint via
 * work_items:get). The filesystem and the work-item are the authority on what
 * was actually done; this document is not.
 *
 * EI-19340500312449463 (a RETRACTED CLAIM riding the blind window): the same
 * gap above also lets a WITHDRAWN claim ride back in. A pre-respawn session
 * can report a finding to a peer/leader (coord:send), catch that it overstated
 * it, and retract it — all AFTER this document was assembled but BEFORE it
 * actually died. The retraction lives in coord messages / a work-item comment
 * / a loop:checkpoint the successor's own predecessor wrote; none of that
 * un-writes text already frozen into this document. Concretely observed: the
 * retracted claim came back as this system-injected snapshot's own framing,
 * which reads with MORE apparent authority than the peer-authored correction
 * it superseded — an agent that trusts its brief over reconciling first would
 * re-broadcast a claim it (as its own predecessor) had already withdrawn,
 * citing this document as the source. The mitigation is the same one BLIND
 * WINDOW already prescribes for unfinished work — check for evidence newer
 * than this stamp before acting — stated explicitly for CLAIMS so it is not
 * read as scoped to artifacts/experiments alone.
 */
export function renderBuiltAtStamp(now: number): string {
  return (
    `> Carry document built at ${new Date(now).toISOString()} — if it is now meaningfully later than that, treat any "currently working on / waiting on" claim below as UNVERIFIED until the live turn-start Orientation/CTRL delta reconciles it (a queued carry-respawn can deliver up to 30 minutes after it was built).\n` +
    `> ⚠ BLIND WINDOW: this document is a snapshot of what was known AT BUILD TIME, not of everything the pre-respawn session actually did — it may have kept working (and completing real artifacts) after this stamp, right up until it died. Before starting or re-doing anything below, check the filesystem / work-item for evidence newer than this stamp; do not assume this document is complete.\n` +
    `> ⚠ RETRACTED CLAIMS RIDE THE SAME WINDOW: a finding/framing below may have been corrected or WITHDRAWN by your predecessor (a coord:send correction, a work-item comment, a loop:checkpoint) after this stamp — this document cannot know that and will restate the ORIGINAL claim with more apparent authority than the correction had. Before repeating, re-broadcasting, or resuming work on ANY finding described below, check coord:feed / the relevant work-item's comments for a correction newer than this stamp; do not treat this document as the authority on what you last concluded.`
  );
}

/** Render the marker that lets a successor distinguish automatic delivery from
 *  the fail-soft fallback. This block is always kept by the carry budget. */
export function renderAutomaticCompactionRecovery(
  delivery: AutomaticCompactionRecovery | null | undefined,
): string {
  if (!delivery) {
    return (
      '## Post-compaction recovery — FALLBACK REQUIRED\n' +
      'No automatic recovery marker arrived. Call `coord:orient { afterCompaction: true }` exactly once, then continue.'
    );
  }
  const { marker, recovery } = delivery;
  const lines = [
    `${AUTOMATIC_COMPACTION_RECOVERY_MARKER} ${JSON.stringify(marker)}`,
    marker.complete
      ? 'Automatic recovery is complete for the stamped control generation. Do NOT call coord:orient to re-fetch it; declare your actual lane with `coord:declare-intent { intent, current_plan_slug, items }`.'
      : 'Automatic recovery is incomplete. Call `coord:orient { afterCompaction: true }` exactly once, then continue.',
    `- recovery coverage: selfSession=${recovery.coverage.selfSession} control=${recovery.coverage.control} heldItems=${recovery.coverage.heldItems} staleness=${recovery.coverage.staleness ?? 'not-applicable'}`,
    `- held checkpoints automatically delivered below: ${recovery.checkpoints?.length ?? 0}`,
    `- self-recall: ${recovery.selfRecall}`,
  ];
  if (recovery.control) {
    lines.push(`- control generation ${recovery.control.generation}: ${JSON.stringify(recovery.control.state)}`);
  }
  if (recovery.staleness_warnings?.warnings.length) {
    lines.push(
      `- changes after the prior summary (${recovery.staleness_warnings.summaryAt}): ${recovery.staleness_warnings.warnings.join(' · ')}`,
    );
  }
  if (marker.complete) {
    lines.push(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION);
  }
  return `## Post-compaction recovery (automatically delivered)\n${lines.join('\n')}`;
}

function renderIdentity(id: CarryDocIdentity): string {
  const lines = [
    `- su-id: ${id.ownerId}${id.ownerLabel ? ` (${id.ownerLabel})` : ''}`,
    `- harness: ${id.harness ?? '(operator / none)'}`,
    `- workspace: ${id.workspaceId}`,
  ];
  if (id.fleet) lines.push(`- fleet: ${id.fleet.slug}${id.fleet.role ? ` (${id.fleet.role})` : ''}`);
  if (id.account) lines.push(`- account: ${id.account}`);
  return `## Identity\n${lines.join('\n')}`;
}

function renderSessionMode(sm: CarryDocSessionMode, hasLiveAwaits = false): string {
  const lines: string[] = [];
  if (sm.modes.length > 0) {
    for (const m of sm.modes) {
      const prov = m.ownerDirected ? 'owner-directed' : 'self/machine-set';
      const reason = m.reason ? ` — ${cap(m.reason, 200)}` : '';
      lines.push(`- ${m.mode.toUpperCase()}: on (${prov})${reason}`);
    }
  } else {
    lines.push('- no active modes');
  }
  // WI-6949 — the AUTO×no-loop combination is an ALARM, not a neutral fact, and it must not
  // read like one. The prior wording ("ending the turn halts the session unless an owner is
  // present") stated the hazard as a subordinate clause with a get-out at the end, so a
  // successor reading it while an owner WAS present correctly resolved it to "fine" — and then
  // silently inherited the halt when the owner walked away. State the consequence first, in
  // the imperative, and only soften it when there is genuinely a loop.
  const autonomyOn = sm.modes.some((m) => modeImpliesAutonomy(m.mode));
  lines.push(
    sm.loopActive
      ? `- loop: ARMED${sm.loopIntervalSec != null ? ` (every ${sm.loopIntervalSec}s)` : ''} — verify loop:status.active before ending the turn`
      : hasLiveAwaits
        ? '- loop: ⚠ NOT ARMED, BUT LIVE EVENT AWAITS PROVIDE A WAKE SOURCE RIGHT NOW. They are one-shot; verify events:status and arm loop:arm for continued autonomous work.'
        : autonomyOn
        ? '- loop: ⚠ NOT ARMED, AND AN AUTONOMY MODE IS ON. You have NO wake source. If you end a turn without loop:arm, this session HALTS and nothing re-wakes it — the mode grants you authorization to keep working, not the means. Arm it (loop:arm { intervalSec, goal, workItem }) as your FIRST act unless you will finish inside this turn.'
        : '- loop: not armed — your only wake source is the owner speaking. If they stop, ending a turn halts this session for good; arm a loop before you go autonomous.',
  );
  // EI-20072281215342526 — THE MISSION, on its own line, right under the loop.
  //
  // This document used to print the loop's INTERVAL and not its GOAL, and that
  // asymmetry WAS the bug: a respawned successor is handed its held work-items but not
  // the mission that generated them, so it cannot tell a mission-held item from an
  // ambient claim. The observed failure is not a loud halt — the agent re-orients,
  // sees unclaimed backlog, and confidently starts doing something else. Printed
  // VERBATIM (not summarised) because the successor's whole problem is that it has no
  // other copy of this text.
  if (sm.loopActive && sm.loopGoal?.trim()) {
    lines.push(
      `- loop goal (YOUR MISSION — carried from the loop that armed it; frozen at arm time, so re-check any work-item it names before acting): ${sm.loopGoal.trim()}`,
    );
  }
  return `## Session mode\n${lines.join('\n')}`;
}

function renderPlanState(items: CarryDocPlanItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map(
    (i) => `- ${i.itemId} [${i.status ?? '?'}] ${i.planSlug} (${i.disposition})`,
  );
  return `## Plan state (your claimed / in-flight items)\n${lines.join('\n')}`;
}

function renderAsks(asks: CarryDocAsk[]): string | null {
  if (asks.length === 0) return null;
  const lines = asks.map((a) => {
    const flag = a.possiblyDecidedBy?.length
      ? `\n    ⚠ MAY ALREADY BE DECIDED — cross-check standing fact(s) ${a.possiblyDecidedBy
          .map((k) => `\`${k}\``)
          .join(', ')} before treating this as open (a decided directive re-surfaced as a question is the WI-5682 continuity bug; verify, don't blindly re-ask).`
      : '';
    return `- #${a.id}: ${cap(a.question, ASK_CAP)}${flag}`;
  });
  return `## Open owner asks (BLOCKING — do not self-answer)\n${lines.join('\n')}`;
}

/** The turn header a successor keys off. The mechanical stamp OUTRANKS the
 *  bare speaker: a user turn stamped 'agent-injected' renders as machine-
 *  injected, explicitly NOT the owner (WI-3532 class), and only an
 *  'owner-typed' stamp earns the OWNER header. */
function tailTurnHeader(t: CarryDocTailTurn): string {
  if (t.speaker === 'assistant') return 'you';
  if (t.provenance) {
    switch (t.provenance.verdict) {
      case 'owner-typed':
        return 'OWNER (typed — mechanically classified)';
      case 'owner-dialog':
        return 'OWNER (dialog answer — mechanically classified)';
      case 'agent-injected':
        return `machine-injected (${t.provenance.origin ?? 'unknown origin'}) — NOT the owner`;
      case 'synthetic':
        return 'machine (harness-synthetic) — NOT the owner';
      case 'machine-surface':
        return 'machine (CLI surface) — NOT the owner';
    }
  }
  return t.speaker === 'owner' ? 'OWNER' : 'user (unclassified)';
}

/**
 * The typed continuation block (P-010) — states how the successor must treat this
 * boundary and the owner's final message BEFORE it reads the tail, so it never
 * misreads an open question as handled or a forced tail as complete.
 */
function renderContinuation(cont: CarryDocContinuation): string {
  const lines: string[] = [
    cont.deliberate && cont.selfRequested
      ? '- Boundary: DELIBERATE (self-requested at a clean point — state was flushed; the tail is trustworthy).'
      : cont.deliberate
        ? '- Boundary: CLEAN but WATCHDOG-INITIATED (the session crossed its context limit and was cut ' +
          'at an idle point — it did NOT request this cut, so pre-cut flushes are NOT guaranteed: ' +
          'verify checkpoint/fact freshness against the automatic recovery + live turn-start delta before trusting them. The tail itself is complete.)'
        : '- Boundary: FORCED (the watchdog/window-guard seized a saturated session mid-flight — the ' +
          'tail may be truncated mid-reply AND nothing was flushed; trust both less and re-verify via ' +
          'the self-recall pointer).',
  ];
  if (cont.lastOwnerMessage) {
    const preview = cap(cont.lastOwnerMessage.text, CONT_PREVIEW_CAP);
    lines.push(
      cont.answered
        ? `- Owner's final message was ANSWERED before this boundary (quoted in the tail below). Preview: «${preview}»`
        : "- Owner's final message is OPEN (unanswered) — it is delivered to you as your ACTUAL FIRST " +
          `PROMPT, NOT quoted in the tail below. Respond to it directly. Preview: «${preview}»`,
    );
  } else {
    lines.push('- No owner turn in the recent tail — continue the standing work above.');
  }
  return `## Continuation (last-turn handling)\n${lines.join('\n')}`;
}

function renderTail(tail: CarryDocTailTurn[], cont: CarryDocContinuation): string | null {
  // When the owner's final message is OPEN it is delivered live as the successor's
  // first prompt, so it must NOT also appear here as quoted history (P-010 "never
  // quoted material" — a quoted copy reads as already-handled). Drop that one turn,
  // the LAST owner-typed turn, from the quoted tail.
  let quoted = tail;
  if (cont.lastOwnerMessage && !cont.answered) {
    let dropAt = -1;
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (isOwnerSpeechVerdict(tail[i].provenance?.verdict)) {
        dropAt = i;
        break;
      }
    }
    if (dropAt >= 0) quoted = tail.filter((_, i) => i !== dropAt);
  }
  if (quoted.length === 0) return null;
  const blocks = quoted.map((t) => {
    const ts = t.ts ? ` @${t.ts}` : '';
    return `### ${tailTurnHeader(t)}${ts}\n${cap(t.text, TAIL_TURN_CAP)}`;
  });
  return `## Verbatim tail (most recent turns; tool outputs are pointers)\n${blocks.join('\n\n')}`;
}

export interface RenderCarryDocOpts {
  /** Hard char budget for the whole document (the P-011 constant budget B). When
   *  set AND the full render exceeds it, the aging ladder ({@link CARRY_DOC_SHED_LADDER})
   *  sheds sections drop-to-pointer (D-004 — never abstractive summary): the tail
   *  ages oldest-turn-first, the standing brief and other sheddable slots become
   *  one-line pointers, until the document fits. Omitted ⇒ full render (unchanged).
   *  Derive it from the effective window with {@link carryDocBudgetChars}. */
  budgetChars?: number;
}

const SECTION_SEP = '\n\n';

/** The drop-to-pointer stand-ins the aging ladder swaps a full section for. Each
 *  keeps its section HEADER (so the successor sees the slot existed) + a one-line
 *  recovery route — the shed content is never summarized, only pointered (D-004). */
const SHED_POINTERS = Object.freeze({
  brief:
    '## Standing carry\n(dropped to fit the carry budget — your held checkpoints, facts, walls and ' +
    'directives are re-injected mechanically on your next wake/pickup; recover the rest via the self-recall pointer below.)',
  tail:
    '## Verbatim tail (most recent turns; tool outputs are pointers)\n(dropped to fit the carry budget — ' +
    'recover recent turns via the self-recall pointer below.)',
  planState:
    '## Plan state (your claimed / in-flight items)\n(dropped to fit the carry budget — re-read via coord:orient { afterCompaction: true }.)',
  asks:
    '## Open owner asks (BLOCKING — do not self-answer)\n(dropped to fit the carry budget — re-read open asks via coord:orient.)',
});

/**
 * Render the deterministic carry document as text. Pure — every input is already
 * assembled + bounded by {@link buildCarryDoc}. Fixed order, most-load-bearing
 * first: re-orient banner → identity → session mode → the standing brief → plan
 * state → asks → continuation (last-turn handling) → verbatim tail → self-recall.
 * The tail sits at the document END (P-010) — most recent turns closest to where
 * the successor begins — with the continuation block just before it framing how to
 * read it, and the self-recall pointer as the trailing one-line recovery hint.
 *
 * With `opts.budgetChars` (P-011) the render is held to a constant budget B by the
 * aging ladder; without it, the full document is returned unchanged.
 */
export function renderCarryDoc(doc: CarryDoc, now: number = Date.now(), opts: RenderCarryDocOpts = {}): string {
  const head = [
    '# Carry document (deterministic — assembled from the DB, no LLM)',
    `> ${REORIENT_BANNER}`,
    renderAutomaticCompactionRecovery(doc.automaticRecovery),
    // EI-18697157970421032: a carry-respawn control message can sit busy-gate
    // deferred + rearm-retried for up to CARRY_RESPAWN_MAX_AGE_MS (30min
    // default, psu-pty-host.mjs) before actual delivery — its content (this
    // whole document) is built ONCE here and never re-rendered against live
    // state before delivery. The re-orient banner above already tells the
    // successor to reconcile, but carries no CONCRETE staleness signal — a
    // stamped build time lets the successor compare it against its own
    // current wall-clock and judge for itself how much may have changed
    // since (an incident traced a stale carry-respawn's frozen `focus`
    // describing a work-item that had been reassigned away by delivery
    // time — the mandatory re-orient caught it, but only after the fact).
    renderBuiltAtStamp(now),
    renderIdentity(doc.identity),
    renderSessionMode(doc.sessionMode, doc.brief.awaits.length > 0),
  ];
  // EI-18684357744098956: the carry doc (unlike the bare brief) also carries the
  // verbatim tail — the one place a held item's checkpoint write-time can be
  // compared against DEMONSTRABLE subsequent session activity. Feed the latest
  // tail-turn timestamp through so a checkpoint the session outgrew (wrote, then
  // kept working past, without the correction landing) renders SUPERSEDED
  // instead of as plain, equally-authoritative fact.
  const briefBody = renderCarryBriefText(doc.brief, now, {
    sessionActivityMs: latestTailTurnMs(doc.tail),
  }).trim();
  const briefText = briefBody ? `## Standing carry\n${briefBody}` : null;
  const planText = renderPlanState(doc.planItems);
  const asksText = renderAsks(doc.asks);
  const continuationText = renderContinuation(doc.continuation);
  const selfRecall = `## Self-recall\n${SELF_RECALL_POINTER}`;

  // Fixed render order; a null slot is simply omitted. The always-keep sections
  // (head, continuation, self-recall) are the successor's minimum viable
  // orientation and are never shed.
  const assemble = (brief: string | null, plan: string | null, asks: string | null, tail: string | null): string => {
    const s = [...head];
    if (brief) s.push(brief);
    if (plan) s.push(plan);
    if (asks) s.push(asks);
    s.push(continuationText);
    if (tail) s.push(tail);
    s.push(selfRecall);
    return s.join(SECTION_SEP);
  };

  const fullTail = renderTail(doc.tail, doc.continuation);
  const full = assemble(briefText, planText, asksText, fullTail);
  if (!opts.budgetChars || full.length <= opts.budgetChars) return full;

  // Over budget: spend B across the sheddable slots in KEEP order (the reverse of
  // the shed ladder — most load-bearing gets budget first), charging each included
  // section its separator + length. The tail ages (newest turns kept) before it too
  // drops to a pointer.
  const alwaysLen = [...head, continuationText, selfRecall].join(SECTION_SEP).length;
  let remaining = opts.budgetChars - alwaysLen;

  const chargeOrPointer = (text: string | null, pointer: string): string | null => {
    if (text == null) return null;
    if (SECTION_SEP.length + text.length <= remaining) {
      remaining -= SECTION_SEP.length + text.length;
      return text;
    }
    if (SECTION_SEP.length + pointer.length <= remaining) {
      remaining -= SECTION_SEP.length + pointer.length;
      return pointer;
    }
    return null;
  };

  // Spend order: asks, plan-state, tail, brief (brief last ⇒ it sheds first).
  const asksOut = chargeOrPointer(asksText, SHED_POINTERS.asks);
  const planOut = chargeOrPointer(planText, SHED_POINTERS.planState);

  let tailOut: string | null = null;
  if (fullTail) {
    if (SECTION_SEP.length + fullTail.length <= remaining) {
      remaining -= SECTION_SEP.length + fullTail.length;
      tailOut = fullTail;
    } else {
      // Age the sliding window: keep the NEWEST turns that fit.
      for (let k = doc.tail.length - 1; k >= 1; k -= 1) {
        const aged = renderTail(doc.tail.slice(-k), doc.continuation);
        if (aged && SECTION_SEP.length + aged.length <= remaining) {
          remaining -= SECTION_SEP.length + aged.length;
          tailOut = aged;
          break;
        }
      }
      if (!tailOut) tailOut = chargeOrPointer(SHED_POINTERS.tail, SHED_POINTERS.tail);
    }
  }

  const briefOut = chargeOrPointer(briefText, SHED_POINTERS.brief);

  return assemble(briefOut, planOut, asksOut, tailOut);
}
