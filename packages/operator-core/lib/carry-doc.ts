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
 * v1 wires the identity + session-mode legs to real readers and renders the
 * full document; the plan-state / asks / verbatim-tail legs are injectable seams
 * that default to empty pending their real readers (P-010 refines the tail's
 * last-turn handling, so v1 renders a plain verbatim tail when one is supplied).
 */
import {
  buildCarryBrief,
  renderCarryBriefText,
  type BuildCarryBriefOpts,
  type CarryBrief,
} from './carry-brief';

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
}

export interface CarryDoc {
  /** The standing continuity brief (loop note, held checkpoints, walls, facts…). */
  brief: CarryBrief;
  identity: CarryDocIdentity;
  sessionMode: CarryDocSessionMode;
  planItems: CarryDocPlanItem[];
  asks: CarryDocAsk[];
  tail: CarryDocTailTurn[];
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
 *  No-ops (empty) when no transcript path is supplied; best-effort otherwise. */
async function defaultGetTail(opts: BuildCarryDocOpts): Promise<CarryDocTailTurn[]> {
  if (!opts.transcriptPath) return [];
  try {
    const { readVerbatimTail } = await import('./turn-journal');
    const turns = await readVerbatimTail(
      opts.transcriptPath,
      opts.transcriptSourceKind ?? 'claude',
      CARRY_DOC_MAX_TAIL_TURNS,
    );
    return turns.map((t) => ({
      speaker: t.speaker,
      text: t.text,
      ts: t.ts ? t.ts.toISOString() : null,
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

  // Asks has no real default reader yet (its store is workspace/identity-scoped
  // per request) — the consumer wires it; absent a seam the slot is empty.
  const asks = opts.getAsksFn
    ? await opts.getAsksFn(ownerId, ws).catch(() => [] as CarryDocAsk[])
    : [];

  const getTail = opts.getTailFn ? () => opts.getTailFn!(ownerId) : () => defaultGetTail(opts);
  const tail = await getTail().catch(() => [] as CarryDocTailTurn[]);

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
    tail: tail.slice(-CARRY_DOC_MAX_TAIL_TURNS),
  };
}

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

function renderTail(tail: CarryDocTailTurn[]): string | null {
  if (tail.length === 0) return null;
  const blocks = tail.map((t) => {
    const who = t.speaker === 'owner' ? 'OWNER' : t.speaker === 'assistant' ? 'you' : 'user';
    const ts = t.ts ? ` @${t.ts}` : '';
    return `### ${who}${ts}\n${cap(t.text, TAIL_TURN_CAP)}`;
  });
  return `## Verbatim tail (most recent turns; tool outputs are pointers)\n${blocks.join('\n\n')}`;
}

/**
 * Render the full deterministic carry document as text. Pure — every input is
 * already assembled + bounded by {@link buildCarryDoc}. Ordered most-load-bearing
 * first: re-orient banner → identity → session mode → the standing brief → plan
 * state → asks → verbatim tail → self-recall pointer.
 */
export function renderCarryDoc(doc: CarryDoc, now: number = Date.now()): string {
  const sections: string[] = [
    '# Carry document (deterministic — assembled from the DB, no LLM)',
    `> ${REORIENT_BANNER}`,
    renderIdentity(doc.identity),
    renderSessionMode(doc.sessionMode),
  ];
  const briefBody = renderCarryBriefText(doc.brief, now).trim();
  if (briefBody) sections.push(`## Standing carry\n${briefBody}`);
  const plan = renderPlanState(doc.planItems);
  if (plan) sections.push(plan);
  const asks = renderAsks(doc.asks);
  if (asks) sections.push(asks);
  const tail = renderTail(doc.tail);
  if (tail) sections.push(tail);
  sections.push(`## Self-recall\n${SELF_RECALL_POINTER}`);
  return sections.join('\n\n');
}
