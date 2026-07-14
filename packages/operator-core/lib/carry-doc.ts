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
import type { RecordedTurnClass } from './turn-provenance/turn-ref';

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
 *   - `deliberate` — was this boundary self-requested at a clean point
 *     (session:request-compaction) or FORCED (native auto-compact / window-guard
 *     mid-turn)? A forced boundary may have truncated an in-flight reply, so the
 *     successor trusts the tail less.
 */
export interface CarryDocContinuation {
  lastOwnerMessage: { text: string; ts: string | null } | null;
  answered: boolean;
  deliberate: boolean;
}

export interface CarryDoc {
  /** The standing continuity brief (loop note, held checkpoints, walls, facts…). */
  brief: CarryBrief;
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

/** The one-line re-orient banner every carry document opens with. */
export const REORIENT_BANNER =
  'This is a stale snapshot of a live system. Before acting on any fleet / claim / liveness ' +
  'statement below, re-run coord:orient { afterCompaction: true } and reconcile — the recovery ' +
  "block re-delivers your held work-items' checkpoints, armed-loop status, and the self-recall pointer.";

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
  /** Was this boundary reached DELIBERATELY (self-requested at a clean point via
   *  session:request-compaction / the psu threshold-end) vs FORCED (native
   *  auto-compact or the gateway window-guard firing mid-turn)? Feeds the P-010
   *  continuation flags. Defaults to `false` (treat as forced/unknown) — the safe
   *  under-promise: a successor trusts a "forced" tail less, and the deliberate
   *  psu path asserts `true` explicitly. Only a deliberate boundary can be
   *  REFUSED across an open owner question ({@link gateOpenOwnerQuestion}). */
  boundaryDeliberate?: boolean;
  // Test seams — each defaults to the real reader (or a best-effort empty leg).
  buildCarryBriefFn?: (ownerId: string, opts: BuildCarryBriefOpts) => Promise<CarryBrief>;
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

/** Read the caller's claimed / in-flight plan items. Assignment is keyed on the
 *  agent-NAME a session adopts (not the coordination ownerId), so resolve the
 *  adopted name first; a session with no adopted name simply owns no items.
 *  Best-effort: a throwing read yields no items, never a failed document. */
async function defaultGetPlanItems(ownerId: string, workspaceId: string): Promise<CarryDocPlanItem[]> {
  try {
    const { resolveAdoptedName } = await import('./plan-items/agent-names');
    const name = await resolveAdoptedName(workspaceId, ownerId);
    if (!name) return [];
    const { myItemsWithState } = await import('./plan-items/liveness');
    const items = await myItemsWithState(workspaceId, name);
    return items.map((s) => ({
      itemId: s.assignment.itemId,
      planSlug: s.assignment.planSlug,
      // myItemsWithState pairs assignment+live-claim but does not fetch the plan
      // item's stored status; the disposition (active / assigned-idle / …) is the
      // load-bearing state here. Status stays null until a leg fetches it.
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

  const getModes = opts.getModesFn ?? defaultGetModes;
  const modes = await getModes(ws, ownerId).catch(() => [] as CarryDocMode[]);

  const getPlanItems = opts.getPlanItemsFn ?? defaultGetPlanItems;
  const planItems = await getPlanItems(ownerId, ws).catch(() => [] as CarryDocPlanItem[]);

  const getAsks = opts.getAsksFn ?? defaultGetAsks;
  const asks = await getAsks(ownerId, ws).catch(() => [] as CarryDocAsk[]);

  const getTail = opts.getTailFn ? () => opts.getTailFn!(ownerId) : () => defaultGetTail(opts);
  const tail = (await getTail().catch(() => [] as CarryDocTailTurn[])).slice(-CARRY_DOC_MAX_TAIL_TURNS);

  return {
    brief,
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
    },
    planItems: planItems.slice(0, CARRY_DOC_MAX_PLAN_ITEMS),
    asks: asks.slice(0, CARRY_DOC_MAX_ASKS),
    tail,
    continuation: deriveContinuation(tail, opts.boundaryDeliberate ?? false),
  };
}

// ── Continuation / last-turn handling (P-010, pure) ─────────────────────────────

const CONT_PREVIEW_CAP = 240;

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
): CarryDocContinuation {
  let idx = -1;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (tail[i].provenance?.verdict === 'owner-typed') {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    // No owner turn in the recent tail ⇒ nothing owner-shaped is open. `answered`
    // is vacuously true (there is no open owner question to cross).
    return { lastOwnerMessage: null, answered: true, deliberate: boundaryDeliberate };
  }
  const owner = tail[idx];
  // Answered ⇔ a model turn FOLLOWS the owner's final message in the tail.
  const answered = tail.slice(idx + 1).some((t) => t.speaker === 'assistant');
  return {
    lastOwnerMessage: { text: owner.text, ts: owner.ts },
    answered,
    deliberate: boundaryDeliberate,
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
}): Promise<CarryDocContinuation> {
  const tail = await defaultGetTail({
    transcriptPath: opts.transcriptPath ?? undefined,
    transcriptSourceKind: opts.transcriptSourceKind,
  });
  return deriveContinuation(tail.slice(-CARRY_DOC_MAX_TAIL_TURNS), opts.boundaryDeliberate ?? false);
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

function renderSessionMode(sm: CarryDocSessionMode): string {
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
  lines.push(
    sm.loopActive
      ? `- loop: ARMED${sm.loopIntervalSec != null ? ` (every ${sm.loopIntervalSec}s)` : ''} — verify loop:status.active before ending the turn`
      : '- loop: not armed — ending the turn halts the session unless an owner is present',
  );
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
  const lines = asks.map((a) => `- #${a.id}: ${cap(a.question, ASK_CAP)}`);
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
    cont.deliberate
      ? '- Boundary: DELIBERATE (self-requested at a clean point — state was flushed; the tail is trustworthy).'
      : '- Boundary: FORCED (native auto-compact / window-guard fired mid-turn — the tail may be ' +
        'truncated mid-reply; trust it less and re-verify via the self-recall pointer).',
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
      if (tail[i].provenance?.verdict === 'owner-typed') {
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
    renderIdentity(doc.identity),
    renderSessionMode(doc.sessionMode),
  ];
  const briefBody = renderCarryBriefText(doc.brief, now).trim();
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
