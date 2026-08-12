/**
 * carry-brief — ONE assembly of a session's continuity state
 * (compaction-continuity-hardening-2026-07-07 P-003).
 *
 * A context boundary (warm compaction OR cold reset/recycle) loses the transcript
 * but NOT the state parked on the carry surfaces: the loop carry-note, held
 * work-item checkpoints, open WALLS (structured owner-gated commitments, P-006),
 * owner-scoped standing facts, armed awaits, and fleet membership. This module
 * reads all of them in one place
 * so every boundary hands the successor the SAME brief:
 *
 *   (i)   the compaction watchdog's force-compact `/compact` FOCUS
 *         (compaction-compliance-watchdog.ts → renderCarryBriefFocus),
 *   (ii)  `session:request-compaction`'s default focus (request-compaction.ts),
 *   (iii) the COLD reset/recycle anchor payload (wake-executor.ts →
 *         renderCarryBriefColdExtras, appended to the loop carry-note).
 *
 * One code path serving warm compaction and cold recycle is the structural
 * guarantee that the two modes can't drift (owner requirement Q2). The P-004
 * post-compaction recovery hook consumes {@link renderCarryBriefText}.
 *
 * The focus renderer deliberately produces POINTERS, not copies: checkpointed
 * state is re-injected mechanically on the next wake/pickup, so spending summary
 * budget copying it is the failure the compaction strategy warns about. Every
 * read leg is best-effort — a failed leg yields an empty section, never a throw.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import { ANY_FAMILY_TERMINAL_STATES, FEATURE_TERMINAL_STATES } from './work-item-dispatch-states';
import {
  getLoopCarryNoteWithMeta,
  renderCheckLine,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  type CheckEntry,
  type LoopCarryNoteWithMeta,
  type WallEntry,
} from './carry-note';
import { harnessOfScope } from './work-item-scope';
import { renderOwnerDirectivesBlock, type OwnerDirectiveRow } from './owner-directives';
import type { QueryHandle } from './ambient-push';
import { DEAD_END_KEY_PREFIX, type FactSourceProvenance } from './agent-facts/store';
import { capPreservingOperative } from './operative-clause';
import {
  checkCarriedFactsStaleness,
  renderFactsStalenessWarning,
  type FactStalenessResult,
} from './carry-fact-staleness';

// ── Shape ─────────────────────────────────────────────────────────────────────

export interface CarryBriefHeldItem {
  id: string;
  title: string | null;
  /** The item's description body (uncapped here; renderers cap). */
  body: string | null;
  /** null for an operator/harness-null item (EI-8813) — never a guessed slug. */
  harness: string | null;
  /** In-flight state left by work_items:checkpoint — null when never written. */
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write (carry_notes.updated_ts) — the
   *  staleness signal (P-003 fleet-deltas-leader-primitives: a checkpoint written
   *  long before a compaction means the turns since it will NOT carry). Null when
   *  no checkpoint, or when an injected test read supplies no meta. */
  checkpointUpdatedAtMs?: number | null;
}

export interface CarryBrief {
  ownerId: string;
  /** Armed AUTO loop + its carry-note (verbatim) — null when no loop routine exists. */
  loop: {
    harness: string;
    active: boolean;
    intervalSec: number | null;
    /**
     * Persisted loop lifecycle. The current builder always supplies this from
     * LoopStatus; optional keeps injected/legacy briefs readable while they
     * roll forward to the mode-aware shape.
     */
    carry?: 'warm' | 'cold';
    /** EI-20072281215342526: the loop's GOAL — the agent's MISSION. Carried here
     *  because a carry-respawn renders no wake kickoff, which used to be the goal's
     *  only delivery channel; the successor therefore inherited its held work-items
     *  WITHOUT the mission that generated them. Null for a loop armed with no goal, or
     *  armed before the goal was persisted structurally (those cannot be back-filled). */
    goal: string | null;
    carryNote: string | null;
    carryNoteUpdatedAtMs: number | null;
  } | null;
  /** P-002 (cold-carry-system-hardening-2026-07-19): LIVE one-line hydrations of the
   *  WI-/EI- ids the carry-note cites (P-008 reuse) — a cited item that changed state
   *  after the note was written is the #1 stale-conclusion tell. Optional: absent on
   *  briefs built before this leg / when the note cites nothing. */
  citedRefs?: string[];
  /** P-003: directed inbox mail that landed AFTER the carry-note was written — the
   *  note PREDATES these; a cold successor must not treat the note as current past
   *  them. Null when unknown (no note timestamp / read failed); count 0 = verified
   *  quiet. */
  postNoteInbox?: { count: number; lines: string[] } | null;
  /** Held (assigned, non-terminal) work-items + their checkpoints. */
  heldItems: CarryBriefHeldItem[];
  /** Open OWNER DIRECTIVES (EI-11484): explicit owner orders recorded verbatim
   *  (orders:record), still awaiting disposition — the workspace's highest-priority
   *  carry class, rendered ABOVE everything else. */
  directives: OwnerDirectiveRow[];
  /** Total open directives (may exceed directives.length — the fetch is bounded). */
  directivesTotalOpen: number;
  /** Open WALLS (P-006): owner-gated commitments as structured rows, parsed out of
   *  the loop carry-note's `## Walls` section. The brief carries them VERBATIM —
   *  they are open commitments, and prose dissolves them. */
  walls: WallEntry[];
  /** carried CHECKS (cold-carry-system-hardening P-001): external-state claims +
   *  probes, parsed out of the note's `## Checks` section — same structured
   *  delivery as walls so a capped/stale-collapsed note can't dissolve them. */
  checks?: CheckEntry[];
  /** Owner-scoped standing facts — the softer standing-context carrier (structured
   *  walls live in `walls` since P-006; facts remain for everything else).
   *  `sourceRef`/`sourceProvenance` ride along (when the store has them) purely
   *  as the input to {@link factsStaleness} — carried facts still render by
   *  `key`/`body` everywhere else. */
  facts: Array<{
    key: string;
    body: string;
    sourceRef?: string | null;
    sourceProvenance?: FactSourceProvenance | null;
  }>;
  /**
   * P-026 leg (b) (WI-5141): embedding staleness verdicts for `facts` above —
   * one entry per fact, `possibly-stale` when its verified typed source has
   * drifted since assert time. Empty/absent when `facts` is empty or nothing
   * in it qualifies (see carry-fact-staleness.ts) — never a failure signal on
   * its own. OPTIONAL (not just empty-array-default) so every pre-existing
   * `CarryBrief` literal (tests, other builders) stays valid without an edit —
   * renderers treat a missing array the same as an empty one.
   */
  factsStaleness?: FactStalenessResult[];
  /** Armed event awaits (infra inbox-wake rows excluded) — they survive the
   *  boundary and WILL wake the successor. */
  awaits: Array<{ eventKey: string; note: string | null }>;
  /** Fleet membership pointer, when presence carries one. */
  fleet: { slug: string; role: string | null } | null;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

export const CARRY_BRIEF_MAX_HELD_ITEMS = 6;
export const CARRY_BRIEF_MAX_FACTS = 8;
export const CARRY_BRIEF_MAX_AWAITS = 8;
/** The /compact focus cap — mirrors session:request-compaction's schema cap. */
export const CARRY_BRIEF_FOCUS_MAX = 600;
/** Per-checkpoint render cap in the cold extras (the note is a pointer target,
 *  not the whole state — the full checkpoint is re-injected on item pickup). */
const COLD_CHECKPOINT_CAP = 500;
const COLD_FACT_BODY_CAP = 240;
const COLD_TITLE_CAP = 120;
/** An INACTIVE loop's carry-note older than this renders as a labeled STALE
 *  pointer instead of verbatim — a dead lane's "Next action" is history, not the
 *  successor's agenda (2026-07-18: a 3-day-old drill note rode a carry doc as if
 *  current). An ACTIVE loop's note is always rendered in full (it is the
 *  workhorse), as is a recently-ended loop's (still-warm context). */
const INACTIVE_LOOP_NOTE_STALE_MS = 24 * 60 * 60_000;

/**
 * EI-18684357744098956: a held work-item's checkpoint carries the SAME authority
 * whether it is current or SUPERSEDED — nothing distinguishes a checkpoint the
 * session wrote-then-outgrew from one written last. The verified incident: a
 * pre-cut session wrote a checkpoint ("ZERO CODE WRITTEN"), then did real work,
 * then detected the staleness and tried to correct it — but the correction never
 * reached the store, so the successor woke on the stale claim rendered as plain
 * fact, and (holding "I wrote nothing" + "the file exists on disk" simultaneously)
 * misattributed its own work to a peer. A checkpoint whose write-time PREDATES
 * demonstrable subsequent session activity (further transcript turns) by more
 * than this margin cannot be trusted at face value — flag it instead of rendering
 * it as current. The margin absorbs ordinary write/flush latency so a checkpoint
 * written moments before the final turn isn't flagged on clock noise alone.
 *
 * Distinct from (complements, does not duplicate) `turn-end-tracking.ts`'s
 * `isStaleHeldCheckpoint` (P-015): that one compares a checkpoint's age against
 * an absolute now (45min) at turn-end to decide whether to WRITE a fresh
 * mechanical checkpoint. This one compares a checkpoint's write-time against
 * this SAME session's own later activity to decide whether to FLAG it at
 * carry-doc READ time — it catches the incident case a 45min age threshold
 * cannot: a checkpoint that is only seconds-to-minutes old but was already
 * superseded by work later in the very same pre-cut session. */
const HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS = 2 * 60_000;

/** `HH:MM` (UTC) for the superseded-checkpoint flag — compact, sortable, and
 *  unambiguous next to another such stamp in the same line. */
function fmtClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`;
}

// ── Held-items read (shared with the orient recovery fold) ────────────────────

export interface ReadHeldWorkItemsOpts {
  sql?: Sql;
  limit?: number;
  getWorkItemCheckpointFn?: (ref: {
    harness: string | null;
    workItemId: string;
    workspaceId?: string;
  }) => Promise<string | null>;
}

/**
 * The caller's held (assigned, non-terminal) work-items + checkpoints — the read
 * both this brief and orient's post-compaction recovery fold
 * (compaction-recovery.ts) use, extracted so the two surfaces cannot drift.
 */
export async function readHeldWorkItems(
  ownerId: string,
  workspaceId: string,
  opts: ReadHeldWorkItemsOpts = {},
): Promise<CarryBriefHeldItem[]> {
  const sql = opts.sql ?? getOrgPg().sql;
  const limit = opts.limit ?? CARRY_BRIEF_MAX_HELD_ITEMS;
  // EI-9013: canonicalize the workspace — an unscoped su session's '*' (or a raw
  // ctx pass-through) previously scoped this query + the checkpoint reads to a
  // workspace that holds no rows, so the fold showed NOTHING held.
  const ws = resolveConcreteWorkspaceId(workspaceId);
  // EI-9013: query work_items DIRECTLY, covering BOTH families. The previous read
  // went through the engineer_issues VIEW, which filters item_kind IN
  // ('bug','change','task') — so a held FEATURE/chunk item (e.g. WI-3535, the
  // incident item) never appeared in the fold at all, checkpoint or not. The
  // scope CASE mirrors the view's mapping so harnessOfScope() semantics are
  // unchanged (EI-8813). Terminal filters stay per-family: the issue-family list
  // is the view-era literal set; feature-family uses FEATURE_TERMINAL_STATES.
  const held = await sql<Array<{ issue_id: string; title: string | null; body: string | null; scope: string }>>`
    SELECT feature_id AS issue_id,
           title,
           COALESCE(summary, '') AS body,
           CASE
             WHEN harness_slug LIKE 'operator:%' OR harness_slug = '' OR harness_slug IS NULL THEN 'operator'
             ELSE 'harness:' || harness_slug
           END AS scope
      FROM harness_shared.work_items
     WHERE taken_by = ${ownerId}
       AND (workspace_id = ${ws} OR workspace_id = 'default')
       AND (
         (item_kind IN ('bug', 'change', 'task') AND status NOT IN ('done', 'resolved', 'deprecated', 'closed'))
         OR (item_kind IN ('feature', 'chunk') AND NOT (status = ANY(${[...FEATURE_TERMINAL_STATES]}::text[])))
       )
     ORDER BY feature_id DESC
     LIMIT ${limit}
  `;
  // P-003 (fleet-deltas-leader-primitives): the default read carries the checkpoint's
  // write instant (getWorkItemCheckpointWithMeta) so the compaction gate can flag a
  // STALE checkpoint, not just a missing one. An injected test fn (string-only) keeps
  // the legacy shape — its meta stays null.
  const getCheckpointWithMeta = opts.getWorkItemCheckpointFn
    ? async (ref: { harness: string | null; workItemId: string; workspaceId?: string }) => ({
        checkpoint: await opts.getWorkItemCheckpointFn!(ref),
        updatedAtMs: null as number | null,
      })
    : async (ref: { harness: string | null; workItemId: string; workspaceId?: string }) => {
        const { getWorkItemCheckpointWithMeta } = await import('./work-item-checkpoint');
        return getWorkItemCheckpointWithMeta(ref);
      };
  const out: CarryBriefHeldItem[] = [];
  for (const h of held) {
    // EI-8813: reuse the SAME scope→harness resolution the write/read paths use
    // (harnessOfScope — null for the explicit global `operator` scope), instead of
    // an ad-hoc parse that defaulted a harness-null item to the literal string
    // 'papercup' (misspelled, and not even the checkpoint store's wildcard sentinel).
    // That mismatched harness silently orphaned the checkpoint from THIS read path
    // only — work_items:checkpoint/get already canonicalize correctly (EI-8805).
    const harness = harnessOfScope(h.scope ?? '');
    let checkpoint: string | null = null;
    let checkpointUpdatedAtMs: number | null = null;
    try {
      const meta = await getCheckpointWithMeta({ harness, workItemId: h.issue_id, workspaceId: ws });
      checkpoint = meta.checkpoint;
      checkpointUpdatedAtMs = meta.updatedAtMs;
    } catch {
      /* per-item best-effort */
    }
    out.push({ id: h.issue_id, title: h.title, body: h.body, harness, checkpoint, checkpointUpdatedAtMs });
  }
  return out;
}

// ── Build ─────────────────────────────────────────────────────────────────────

export interface BuildCarryBriefOpts {
  sql?: Sql;
  workspaceId?: string;
  // Test seams — each defaults to the real reader.
  getLoopStatusFn?: (
    ownerId: string,
  ) => Promise<{
    harnessSlug: string;
    active: boolean;
    intervalSec: number | null;
    /** EI-20072281215342526: the MISSION. Optional on the seam (not on `LoopStatus`,
     *  where it is required) so an existing test stub keeps compiling — a stub that
     *  omits it is stating "this test does not exercise the goal", which is honest,
     *  whereas the real reader always has one to give. */
    goal?: string | null;
  } | null>;
  getLoopCarryNoteWithMetaFn?: (ref: {
    harness: string;
    ownerId: string;
  }) => Promise<LoopCarryNoteWithMeta>;
  readHeldWorkItemsFn?: typeof readHeldWorkItems;
  listOwnerFactsFn?: (
    ownerId: string,
    workspaceId: string | undefined,
  ) => Promise<
    Array<{ key: string; body: string; sourceRef?: string | null; sourceProvenance?: FactSourceProvenance | null }>
  >;
  /** P-026 leg (b) (WI-5141): injectable staleness checker — defaults to the
   *  real {@link checkCarriedFactsStaleness} (which itself resolves the real
   *  embedder unless `checkFactsStalenessFn` is supplied, e.g. in tests). */
  checkFactsStalenessFn?: typeof checkCarriedFactsStaleness;
  listActiveAwaitsFn?: (
    ownerId: string,
  ) => Promise<Array<{ eventKey: string; note: string | null }>>;
  getFleetFn?: (ownerId: string) => Promise<{ slug: string; role: string | null } | null>;
  listOpenDirectivesFn?: (
    workspaceId: string,
  ) => Promise<{ rows: OwnerDirectiveRow[]; totalOpen: number }>;
  /** P-002 seam: hydrate WI-/EI- ids cited in the carry note into live one-liners.
   *  Defaults to the P-008 detect→hydrate→render pipeline. */
  hydrateNoteRefsFn?: (noteText: string) => Promise<string[]>;
  /** P-003 seam: read directed inbox mail strictly after `sinceIso` (bounded).
   *  Defaults to the coordination inbox reader. */
  readPostNoteInboxFn?: (
    ownerId: string,
    sinceIso: string,
  ) => Promise<{ count: number; lines: string[] }>;
}

/** P-003 render bounds: at most this many post-note message lines, each clipped. */
const POST_NOTE_INBOX_MAX_LINES = 3;
const POST_NOTE_INBOX_LINE_CHARS = 150;

/** Default P-002 hydrator: P-008 reuse end-to-end (detect → hydrate → render one-liners).
 *  Lazy imports keep the coordination edge off the brief's cold path; any failure ⇒ [].
 *
 *  Returns BARE `label: "snippet"` strings (no leading glyph) — the seam's contract
 *  (see carry-brief.test.ts's hydrateNoteRefsFn mocks) is that the RENDERER adds the
 *  single `↪ ` prefix. This used to call ref-hydrate's `renderHydratedRef`, which
 *  ALSO prefixes `↪ ` — doubling the glyph in every real (non-test) carry doc
 *  ("↪ ↪ EI-… [bug/done]: …", found while fixing EI-18726068732447732). */
async function defaultHydrateNoteRefs(noteText: string): Promise<string[]> {
  try {
    const [{ detectBodyRefs }, { hydrateRefs }] = await Promise.all([
      import('./agent-tools/coordination/ref-hydrate'),
      import('./agent-tools/coordination/ref-hydrate-resolve'),
    ]);
    const refs = detectBodyRefs(noteText);
    if (refs.length === 0) return [];
    const hydrated = await hydrateRefs(refs);
    return hydrated.filter((h) => h.ok).map((h) => (h.snippet ? `${h.label}: "${h.snippet}"` : h.label));
  } catch {
    return [];
  }
}

/** Parse a cited-ref line's bracketed `[kind/state]` tag — the shape
 *  `defaultWorkItemResolver` / `bodyRefWorkItemResolver` emit as
 *  `<id> [<kind>/<state>...]`. Regex-only (never throws); returns null for a
 *  line with no recognizable id or tag (a custom hydrator, or a non-work-item
 *  ref shape) so callers degrade to "not terminal" rather than misfire. */
const CITED_REF_ID = /\b((?:WI|EI|F)-\d+)\b/;
const CITED_REF_STATE_TAG = /\[[a-z0-9_]+\/([a-z0-9_-]+)/i;
export function parseCitedRefStateTag(line: string): { id: string; state: string } | null {
  const idMatch = CITED_REF_ID.exec(line);
  const stateMatch = CITED_REF_STATE_TAG.exec(line);
  if (!idMatch || !stateMatch) return null;
  return { id: idMatch[1], state: stateMatch[1] };
}

/**
 * Which of `citedRefs` cite a work-item whose LIVE state (as already resolved
 * by the fold) is terminal — the P-002 stale-imperative contradiction detector
 * (EI-18726068732447732): a cold carry-note's own prose can still instruct
 * action ("complete WI-NNN", "verify then close it") on an id the SAME brief's
 * fold already resolves as done/dropped/etc. The fold has the answer at render
 * time; this just joins it against the ids the note cites instead of printing
 * both and letting the reader reconcile them. Pure + derived from
 * ANY_FAMILY_TERMINAL_STATES (never re-list the words) so it's independently
 * unit-testable and can't drift from the canonical terminal vocabulary.
 */
export function detectTerminalCitedRefs(citedRefs: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of citedRefs) {
    const tag = parseCitedRefStateTag(line);
    if (tag && ANY_FAMILY_TERMINAL_STATES.includes(tag.state)) out.push(tag.id);
  }
  return out;
}

/** Retraction-shaped language in a post-note message — "retract", "I was wrong",
 *  "supersede", etc. A post-note message merely EXISTING is already flagged (the
 *  generic P-003 list below); this distinguishes the subset that specifically
 *  WITHDRAWS a prior claim, so the render can surface it loudly right next to
 *  the note's imperative instead of leaving it to be discovered only inside a
 *  list the reader may not fully read (EI-19408487308624743: a carry-note's own
 *  imperative kept marching orders on a premise a peer had retracted 55s before
 *  the note was built — the retraction was present, but only as one bullet
 *  inside the generic "N messages landed after" list below the imperative). */
const RETRACTION_LANGUAGE_RE =
  /\b(retract(?:ed|ing|ion)?|correction|corrected|superse(?:de[sd]?|ded|ding)|i was wrong|no longer (?:true|valid|applies)|disregard|withdraw(?:n|al|ing)?|scratch that)\b/i;

export function detectRetractionShapedLines(lines: readonly string[]): string[] {
  return lines.filter((l) => RETRACTION_LANGUAGE_RE.test(l));
}

/** Default P-003 reader: directed non-own mail strictly after `sinceIso`, bounded.
 *  Review fold #7: filtered through the continuation gate's isPendingInterrupt —
 *  categorized system broadcasts / auto lifecycle chatter / intent declares are
 *  presence machinery, not "the note predates N messages" evidence (the raw inbox
 *  held 10.7k rows with 4.6k ambient the night this shipped — an unfiltered count
 *  is pure noise). */
async function defaultReadPostNoteInbox(
  ownerId: string,
  sinceIso: string,
): Promise<{ count: number; lines: string[] }> {
  const [{ readInbox }, { isPendingInterrupt }] = await Promise.all([
    import('./agent-tools/coordination/messages'),
    import('./agent-tools/coordination/tools/continuation-gate'),
  ]);
  const entries = await readInbox(ownerId, { since_ts: sinceIso, excludeOwn: true });
  const rows = (Array.isArray(entries) ? entries : []).filter((e) => isPendingInterrupt(e as never));
  const lines = rows.slice(-POST_NOTE_INBOX_MAX_LINES).map((e: Record<string, unknown>) => {
    const from = typeof e.from === 'string' ? e.from.slice(0, 12) : '?';
    const ts = typeof e.ts === 'string' ? e.ts : '';
    const text =
      (typeof e.summary === 'string' && e.summary) || (typeof e.body === 'string' && e.body) || '';
    const clipped = text.replace(/\s+/g, ' ').trim();
    const line = `- ${from} (${ts}): ${clipped}`;
    return line.length > POST_NOTE_INBOX_LINE_CHARS ? `${line.slice(0, POST_NOTE_INBOX_LINE_CHARS - 1)}…` : line;
  });
  return { count: rows.length, lines };
}

/** Awaits the engine arms for itself (the always-on inbox wake) — infrastructure,
 *  not session state worth a line of the brief. */
function isInfraAwait(eventKey: string): boolean {
  return eventKey.startsWith('coord:inbox-wake:');
}

/**
 * Assemble the caller's carry brief. Every leg is independently best-effort: a
 * throwing reader yields that section empty, never a failed brief — this runs at
 * the worst possible moments (context exhausted, session about to reset).
 */
export async function buildCarryBrief(
  ownerId: string,
  opts: BuildCarryBriefOpts = {},
): Promise<CarryBrief> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId() ?? 'default';
  const brief: CarryBrief = {
    ownerId,
    loop: null,
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    factsStaleness: [],
    awaits: [],
    fleet: null,
  };

  try {
    // EI-11484: open owner directives — the highest-priority carry class. The
    // read is workspace-scoped (NOT loop/session-scoped) on purpose: a
    // directive must survive the recording session's death.
    const listDirectives =
      opts.listOpenDirectivesFn ??
      (async (ws: string) => {
        const { listOpenOwnerDirectives, countOpenOwnerDirectives, OWNER_DIRECTIVES_RENDER_MAX_ROWS } =
          await import('./owner-directives');
        const rows = await listOpenOwnerDirectives(ws, OWNER_DIRECTIVES_RENDER_MAX_ROWS, opts.sql);
        const totalOpen =
          rows.length >= OWNER_DIRECTIVES_RENDER_MAX_ROWS
            ? await countOpenOwnerDirectives(ws, opts.sql).catch(() => rows.length)
            : rows.length;
        return { rows, totalOpen };
      });
    const d = await listDirectives(workspaceId);
    brief.directives = d.rows;
    brief.directivesTotalOpen = d.totalOpen;
  } catch {
    /* section stays empty */
  }

  try {
    const getStatus =
      opts.getLoopStatusFn ??
      (async (id: string) => {
        const { getLoopStatus } = await import('./harness/routines/loop');
        return getLoopStatus(id, { sql: opts.sql });
      });
    const loop = await getStatus(ownerId);
    if (loop) {
      const getNote = opts.getLoopCarryNoteWithMetaFn ?? getLoopCarryNoteWithMeta;
      const meta = await getNote({ harness: loop.harnessSlug, ownerId }).catch(
        (): LoopCarryNoteWithMeta => ({ note: null, updatedAtMs: null }),
      );
      brief.loop = {
        harness: loop.harnessSlug,
        active: Boolean(loop.active),
        intervalSec: loop.intervalSec ?? null,
        carry: loop.carry,
        goal: loop.goal ?? null,
        carryNote: meta.note,
        carryNoteUpdatedAtMs: meta.updatedAtMs,
      };
      // P-006: walls ride the note's `## Walls` section — surface them structured.
      brief.walls = splitCarryNoteWalls(meta.note).walls;
      // P-001 delivery parity (review fold): checks get the SAME structured
      // extraction as walls — a note that later stale-collapses or truncates
      // must not silently dissolve its carried claims/probes.
      brief.checks = splitCarryNoteChecks(meta.note).checks;
      // P-002 (cold-carry-system-hardening-2026-07-19): hydrate the note's cited
      // WI-/EI- ids into LIVE one-liners. Best-effort; empty on any failure.
      if (meta.note) {
        const hydrate = opts.hydrateNoteRefsFn ?? defaultHydrateNoteRefs;
        brief.citedRefs = await hydrate(meta.note).catch(() => [] as string[]);
      }
      // P-003: what landed AFTER the note was written — the note predates it.
      if (meta.note && meta.updatedAtMs != null && Number.isFinite(meta.updatedAtMs)) {
        const readDelta = opts.readPostNoteInboxFn ?? defaultReadPostNoteInbox;
        brief.postNoteInbox = await readDelta(ownerId, new Date(meta.updatedAtMs).toISOString()).catch(
          () => null,
        );
      }
    }
  } catch {
    /* section stays null */
  }

  try {
    const readHeld = opts.readHeldWorkItemsFn ?? readHeldWorkItems;
    brief.heldItems = await readHeld(ownerId, workspaceId, { sql: opts.sql });
  } catch {
    /* section stays empty */
  }

  try {
    const listOwnerFacts =
      opts.listOwnerFactsFn ??
      (async (id: string, ws: string | undefined) => {
        const { foldFacts } = await import('./agent-facts/store');
        const facts = await foldFacts(
          [{ scope: 'owner', scopeRef: id }],
          { workspaceId: ws, limitPerSelector: CARRY_BRIEF_MAX_FACTS },
          opts.sql,
        );
        return facts.map((f) => ({
          key: f.key,
          body: f.body,
          sourceRef: f.sourceRef,
          sourceProvenance: f.sourceProvenance,
        }));
      });
    brief.facts = (await listOwnerFacts(ownerId, workspaceId)).slice(0, CARRY_BRIEF_MAX_FACTS);
  } catch {
    /* section stays empty */
  }

  try {
    // P-026 leg (b) (WI-5141): embedding staleness-check of the facts JUST
    // folded above — deliberately runs AFTER the facts leg (not merged into
    // it) so a staleness failure can never blank out the facts themselves,
    // matching every other leg's independent-best-effort contract. Skips
    // entirely (stays []) when there are no facts to check.
    const checkStaleness = opts.checkFactsStalenessFn ?? checkCarriedFactsStaleness;
    brief.factsStaleness = await checkStaleness(brief.facts);
  } catch {
    /* section stays empty */
  }

  try {
    const listAwaits =
      opts.listActiveAwaitsFn ??
      (async (id: string) => {
        const { listActiveAwaits } = await import('./events/await/store');
        const rows = await listActiveAwaits(id);
        return rows.map((r) => ({ eventKey: r.eventKey, note: r.note }));
      });
    brief.awaits = (await listAwaits(ownerId))
      .filter((a) => !isInfraAwait(a.eventKey))
      .slice(0, CARRY_BRIEF_MAX_AWAITS);
  } catch {
    /* section stays empty */
  }

  try {
    const getFleet =
      opts.getFleetFn ??
      (async (id: string) => {
        const sql = opts.sql ?? getOrgPg().sql;
        const rows = await sql<Array<{ fleet_slug: string | null; fleet_role: string | null }>>`
          SELECT fleet_slug, fleet_role FROM harness_shared.coord_presence
           WHERE owner_id = ${id}
           ORDER BY heartbeat_at DESC
           LIMIT 1
        `;
        const r = rows[0];
        return r?.fleet_slug ? { slug: r.fleet_slug, role: r.fleet_role ?? null } : null;
      });
    brief.fleet = await getFleet(ownerId);
  } catch {
    /* section stays null */
  }

  return brief;
}

// ── Renderers (pure) ──────────────────────────────────────────────────────────

function cap(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + '…' : t;
}

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h${min % 60 ? ` ${min % 60}m` : ''}` : `${Math.round(h / 24)}d`;
}

// ── Pull-precise query handles (P-026, WI-5001 leg (a)) ───────────────────────
//
// deterministic-context-carry-2026-07-14 P-026 retires the speculative embedding
// hole-patch re-prime for session classes whose cold-boot drills PROVE the
// deterministic carry sufficient (see memory/compact-reprime.ts). Retiring the
// FOLD must not mean retiring the ABILITY to pull — a genuinely needed recall is
// a BUILDER gap, not a reason to keep folding noise. This is the growth leg: a
// PURE, no-recall deriver that turns typed carry state directly into resolvable
// {@link QueryHandle}s (never full content — D-002's teaser+handle discipline),
// covering exactly the three classes the item text names: a held work-item, an
// armed await ("open thread" — an unresolved rendezvous the successor is a party
// to), and a recorded dead-end (a tried-and-failed approach, P-015 slot).

/** Input shape for {@link deriveCarryQueryHandles} — a subset of {@link CarryBrief}
 *  (not the whole brief) so callers with only some of it (e.g. compact-reprime's
 *  narrower CompactReprimeInput) can still derive handles from what they have. */
export interface CarryQueryHandleInputs {
  heldItems: ReadonlyArray<{ id: string; title: string | null }>;
  awaits: ReadonlyArray<{ eventKey: string; note: string | null }>;
  facts: ReadonlyArray<{ key: string; body: string }>;
}

/** Hard cap on emitted handles — a handles block is a pointer list, not a dump. */
export const CARRY_QUERY_HANDLES_MAX = 8;

const HANDLE_QUERY_CLAMP_CHARS = 200;

function clampHandleQuery(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > HANDLE_QUERY_CLAMP_CHARS ? `${t.slice(0, HANDLE_QUERY_CLAMP_CHARS - 1)}…` : t;
}

/**
 * Derive deterministic pull-precise handles from typed carry state — PURE, no
 * embedding call, no recall. Order: held work-items first (the most concrete),
 * then open awaits, then dead-ends; each class stops contributing once `max` is
 * reached (a partial mix, never one class crowding out the others entirely, is
 * avoided by capping the OVERALL list — same reasoning as CARRY_BRIEF's per-
 * section caps upstream of this call).
 */
export function deriveCarryQueryHandles(
  inputs: CarryQueryHandleInputs,
  max: number = CARRY_QUERY_HANDLES_MAX,
): QueryHandle[] {
  const handles: QueryHandle[] = [];
  for (const item of inputs.heldItems) {
    if (handles.length >= max) return handles;
    const label = item.title?.trim() || item.id;
    handles.push({ kind: 'work-item', ref: item.id, query: [clampHandleQuery(label)] });
  }
  for (const a of inputs.awaits) {
    if (handles.length >= max) return handles;
    const label = a.note?.trim() || a.eventKey;
    handles.push({ kind: 'topic', ref: a.eventKey, query: [clampHandleQuery(label)] });
  }
  for (const f of inputs.facts) {
    if (handles.length >= max) return handles;
    if (!f.key.startsWith(DEAD_END_KEY_PREFIX)) continue; // dead-ends only (P-015 slot)
    handles.push({ kind: 'fact', ref: f.key, query: [clampHandleQuery(f.body)] });
  }
  return handles;
}

/** The heading compact-reprime's retired branch renders the handles block under. */
export const CARRY_QUERY_HANDLES_HEADING = 'Pull-precise carry handles (no recall)';

/**
 * Render handles as a compact, resolvable-pointer block — one line per handle,
 * NEVER folded content (mirrors ambient-push's teaser-not-content discipline:
 * this is the "pull" side of the same D-002 handle, resolved by the reader
 * explicitly, not injected as if it were a hit). Empty input renders null (the
 * caller's existing "nothing to inject" contract).
 */
export function renderCarryQueryHandlesBlock(handles: readonly QueryHandle[]): string | null {
  if (handles.length === 0) return null;
  const lines = handles.map((h) => `- [${h.kind}:${h.ref}] pull: ${h.query.join(' | ')}`);
  return `${CARRY_QUERY_HANDLES_HEADING}\n${lines.join('\n')}`;
}

/**
 * The `/compact` FOCUS line (consumers i + ii): the standing preserve set plus
 * THIS session's real pointers, hard-capped at `max`. Pointer semantics on
 * purpose — checkpointed state is re-injected mechanically, so the summarizer
 * should keep ids and one-line hooks, not copies. Ordered most-load-bearing
 * first so a truncation drops the least important tail.
 */
export function renderCarryBriefFocus(brief: CarryBrief, max: number = CARRY_BRIEF_FOCUS_MAX): string {
  const parts: string[] = [
    'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls',
  ];
  if (brief.directives.length > 0) {
    // EI-11484: open owner directives outrank even walls — ids only (the
    // store re-renders them mechanically on every wake; copying wastes focus).
    parts.push(
      `OPEN OWNER DIRECTIVES ${brief.directives.map((d) => `#${d.id}`).join(', ')} — re-rendered every wake, keep the ids`,
    );
  }
  if (brief.walls.length > 0) {
    // P-006: open walls outrank everything else — they are open COMMITMENTS, kept
    // VERBATIM (per-claim capped only to survive the hard focus cap).
    parts.push(`OPEN WALLS (carry verbatim, do not re-declare resolved): ${brief.walls.map((w) => `"${cap(w.claim, 90)}"`).join('; ')}`);
  }
  if (brief.heldItems.length > 0) {
    const ids = brief.heldItems.map((h) => h.id).join(', ');
    parts.push(
      `held work-items ${ids} — keep the ids as POINTERS (their checkpoints are re-injected on pickup, do not copy them)`,
    );
  }
  if (brief.loop) {
    const iv = brief.loop.intervalSec != null ? ` ${brief.loop.intervalSec}s` : '';
    parts.push(
      `armed loop @${brief.loop.harness}${iv} — its loop:checkpoint re-delivers on wake, pointer only`,
    );
  }
  if (brief.facts.length > 0) {
    parts.push(`standing facts (folded into every orient): ${brief.facts.map((f) => f.key).join(', ')}`);
    // P-026 leg (b) (WI-5141): flag which ones drifted — ids only, pointer-style.
    const staleKeys = (brief.factsStaleness ?? [])
      .filter((r) => r.verdict === 'possibly-stale')
      .map((r) => r.key);
    if (staleKeys.length > 0) {
      parts.push(`⚠ possibly-stale facts (source drifted, re-verify): ${staleKeys.join(', ')}`);
    }
  }
  if (brief.awaits.length > 0) {
    parts.push(`armed awaits: ${brief.awaits.map((a) => a.eventKey).join(', ')}`);
  }
  if (brief.fleet) {
    parts.push(`fleet ${brief.fleet.slug}${brief.fleet.role ? ` (${brief.fleet.role})` : ''}`);
  }
  parts.push('drop resolved tool output and superseded state');
  return cap(parts.join('; ') + '.', max);
}

export interface RenderCarryBriefColdExtrasOpts {
  /** EI-18684357744098956: the epoch ms of the LATEST demonstrable session
   *  activity (e.g. the last verbatim tail turn) known to the caller — the
   *  "session active until" half of the staleness comparison. A held item's
   *  checkpoint written more than {@link HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS}
   *  before this instant is flagged SUPERSEDED rather than rendered as current.
   *  Omitted/null ⇒ no comparison is possible (e.g. no transcript available);
   *  every checkpoint renders as before — this is purely additive. */
  sessionActivityMs?: number | null;
}

/**
 * The sections a COLD reset/recycle injection appends AFTER the loop carry-note
 * (consumer iii — wake-executor). The note stays the injection's core (P-006:
 * no note ⇒ no cold start at all), so this renders everything else: held items
 * + capped checkpoints, standing facts, armed awaits, the fleet pointer.
 * Returns '' when the brief carries nothing beyond the loop note.
 */
export function renderCarryBriefColdExtras(
  brief: CarryBrief,
  opts: RenderCarryBriefColdExtrasOpts = {},
): string {
  const sessionActivityMs = opts.sessionActivityMs ?? null;
  const sections: string[] = [];
  if (brief.directives.length > 0) {
    // EI-11484: open owner directives render FIRST — above walls, above the
    // agenda. Budgeted by the shared renderer (whole ≤300 chars, else substr
    // + orders:get pointer, block cap + "+N more").
    const block = renderOwnerDirectivesBlock(brief.directives, { totalOpen: brief.directivesTotalOpen });
    if (block) sections.push(block);
  }
  if (brief.walls.length > 0) {
    // P-006: walls FIRST, as rows, VERBATIM — the redundancy with the note's own
    // `## Walls` section is deliberate; commitments are the one carry class where
    // double-delivery beats any byte saving.
    const lines = brief.walls.map(
      (w) => `  • ${w.claim}${w.recheck ? ` — re-check: ${w.recheck}` : ''}`,
    );
    sections.push(
      `⛔ OPEN WALLS — owner-gated commitments you still carry (re-check, do not re-litigate or re-declare resolved; clear via loop:checkpoint { walls }):\n${lines.join('\n')}`,
    );
  }
  if (brief.checks && brief.checks.length > 0) {
    // P-001 delivery parity: same double-delivery rationale as walls — a carried
    // claim whose probe dissolves in a capped note is the phantom-re-anchor shape.
    sections.push(
      `🧪 CARRIED CHECKS — claims + their probes (✓ verified w/ evidence · ? PREDICTED — run the re-check before relying; clear via loop:checkpoint { checks }):\n${brief.checks
        .map((c) => `  ${renderCheckLine(c).replace(/^-\s*/, '• ')}`)
        .join('\n')}`,
    );
  }
  if (brief.heldItems.length > 0) {
    // The excerpt must SAY it is an excerpt. This is the cold successor's entire
    // resume state, rendered as prose with no sibling field to carry a structured
    // marker — so the withheld-chars notice goes inline, naming the call that
    // returns the rest. A bare `…` here reads as a complete checkpoint.
    const excerptCheckpoint = (h: { id: string; checkpoint: string | null }): string =>
      capPreservingOperative(h.checkpoint!, COLD_CHECKPOINT_CAP, {
        inlineNotice: true,
        more: `work_items:get { id: '${h.id}' }`,
      });
    const lines = brief.heldItems.map((h) => {
      const title = h.title ? ` — ${cap(h.title, COLD_TITLE_CAP)}` : '';
      let ckpt: string;
      if (!h.checkpoint) {
        ckpt = '\n    (no checkpoint written — read the item via work_items:get before acting)';
      } else {
        const superseded =
          sessionActivityMs != null &&
          h.checkpointUpdatedAtMs != null &&
          sessionActivityMs - h.checkpointUpdatedAtMs > HELD_ITEM_CHECKPOINT_STALE_MARGIN_MS;
        // EI-19952485326105760: checkpoints are written APPEND-STYLE, so the
        // newest and most-binding content (e.g. a later owner directive that
        // SUPERSEDES an earlier plan in the same body) is written last —
        // exactly what a plain head-only `cap()` discards first. Use the
        // operative/supersession-preserving excerpt instead of `cap()` here.
        ckpt = superseded
          ? `\n    checkpoint: ⚠ SUPERSEDED — written ${fmtClock(h.checkpointUpdatedAtMs!)}, session active until ` +
            `${fmtClock(sessionActivityMs!)} (more happened after this was written; it may be flat-out wrong — ` +
            `verify via sessions:search { session:'self', mode:'verbatim' } and the actual files/state before ` +
            `trusting it, never treat it as "nothing done" or "work undone" at face value): ` +
            `${excerptCheckpoint(h)}`
          : `\n    checkpoint: ${excerptCheckpoint(h)}`;
      }
      return `  • ${h.id}${title}${ckpt}`;
    });
    sections.push(
      `You HELD these work-items as of just before this respawn (the full checkpoint re-injects on the item's next invocation; refresh it before ending). ` +
        `CAUTION (EI-18665023147548277): this brief was built BEFORE your old session's SessionEnd/Stop lifecycle event fired — that event unconditionally ` +
        `releases every claim you held (session-death-claim-release-2026-07-11), so a claim listed here CAN already be released by the time you read this. ` +
        `Do not trust "HOLD" at face value: re-verify with work_items:get (or coord:orient { afterCompaction: true }, which re-queries live) and re-claim ` +
        `(work_items:claim) before editing if assignee is not you:\n${lines.join('\n')}`,
    );
  }
  if (brief.facts.length > 0) {
    // Same fix as the held-item checkpoint above — a fact body can carry a
    // later imperative/supersession clause past the excerpt cut too.
    const lines = brief.facts.map(
      (f) =>
        `  • ${f.key}: ${capPreservingOperative(f.body, COLD_FACT_BODY_CAP, {
          inlineNotice: true,
          more: `facts:list { key: '${f.key}' }`,
        })}`,
    );
    sections.push(
      `Your standing facts (owner-scoped; folded into every orient until retracted — walls/commitments live here):\n${lines.join('\n')}`,
    );
    // P-026 leg (b) (WI-5141): a fact whose verified typed source has drifted
    // since assert time — surfaced right after the facts block it annotates.
    const stalenessWarning = renderFactsStalenessWarning(brief.factsStaleness ?? []);
    if (stalenessWarning) sections.push(stalenessWarning);
  }
  if (brief.awaits.length > 0) {
    const lines = brief.awaits.map(
      (a) => `  • ${a.eventKey}${a.note ? ` — ${cap(a.note, 120)}` : ''}`,
    );
    sections.push(`Your armed awaits are still live and WILL wake you:\n${lines.join('\n')}`);
  }
  if (brief.fleet) {
    sections.push(
      `Fleet: you are in "${brief.fleet.slug}"${brief.fleet.role ? ` as ${brief.fleet.role}` : ''} — fleet:status for live state.`,
    );
  }
  return sections.join('\n\n');
}

export interface RenderCarryBriefTextOpts extends RenderCarryBriefColdExtrasOpts {}

/**
 * The full brief as text — the P-004 recovery-hook payload (and a debugging
 * surface). Loop section first (with the note's write age when known), then the
 * cold-extras sections.
 */
export function renderCarryBriefText(
  brief: CarryBrief,
  now: number = Date.now(),
  opts: RenderCarryBriefTextOpts = {},
): string {
  const sections: string[] = [];
  // EI-11484: open owner directives render ABOVE the loop contract — the whole
  // point of the store is that they outrank the re-injected standing agenda.
  const directivesBlock =
    brief.directives.length > 0
      ? renderOwnerDirectivesBlock(brief.directives, { nowMs: now, totalOpen: brief.directivesTotalOpen })
      : null;
  if (directivesBlock) sections.push(directivesBlock);
  if (brief.loop) {
    const iv = brief.loop.intervalSec != null ? `, every ${brief.loop.intervalSec}s` : '';
    const head = `Armed loop @${brief.loop.harness} (${brief.loop.active ? 'active' : 'inactive'}${iv}).`;
    if (brief.loop.carryNote) {
      const ageMs =
        brief.loop.carryNoteUpdatedAtMs != null
          ? Math.max(0, now - brief.loop.carryNoteUpdatedAtMs)
          : null;
      if (!brief.loop.active && ageMs != null && ageMs > INACTIVE_LOOP_NOTE_STALE_MS) {
        // A dead lane's old note is HISTORY, not agenda — reproducing its
        // imperative "Next action" verbatim reads as current marching orders to
        // a cold successor (the 2026-07-18 carry doc carried a 3-day-stale drill
        // note this way). Collapse to a labeled pointer; the note itself stays
        // recoverable via loop:status / the loop's checkpoint history.
        sections.push(
          `${head} Its last carry-note is ${humanAge(ageMs)} old — STALE (the loop is not armed; ` +
            `the note's imperatives are historical, NOT your current agenda). Recover it via ` +
            `loop:status if genuinely needed.`,
        );
      } else {
        const age = ageMs != null ? ` (written ${humanAge(ageMs)} ago)` : '';
        sections.push(`${head} Its carry-note${age}:\n${brief.loop.carryNote}`);
        // P-002: LIVE hydrations of the ids the note cites — a successor trusts
        // these over the note's phrasing (the note is a snapshot; these are now).
        if (brief.citedRefs && brief.citedRefs.length > 0) {
          const terminalIds = detectTerminalCitedRefs(brief.citedRefs);
          if (terminalIds.length > 0) {
            // EI-18726068732447732: the note's own imperatives ("complete WI-NNN",
            // "verify then close it") can target an id the fold below ALREADY
            // resolves as terminal — flag the contradiction loudly, right at the
            // point a reader would otherwise just follow the stale prose.
            const idList = terminalIds.join(', ');
            const plural = terminalIds.length > 1;
            sections.push(
              `⚠⚠ STALE-NOTE CONTRADICTION: the note above may still instruct action on ${idList} — ` +
                `but the LIVE status below shows ${plural ? 'they are' : 'it is'} already TERMINAL. ` +
                `Do NOT follow any instruction to complete/verify/close/work on ${plural ? 'them' : 'it'}; ` +
                `treat ${plural ? 'them' : 'it'} as already resolved and re-orient before acting on the rest of the note.`,
            );
          }
          sections.push(
            `Cited in the note — LIVE status (trust these over the note's phrasing):\n` +
              brief.citedRefs
                .map((l) => {
                  const tag = parseCitedRefStateTag(l);
                  const flagged = !!tag && ANY_FAMILY_TERMINAL_STATES.includes(tag.state);
                  return `  ${flagged ? '⚠ TERMINAL ' : ''}↪ ${l}`;
                })
                .join('\n'),
          );
        }
        // P-003: the note PREDATES this mail — a cold successor must reconcile
        // before executing the note's imperatives.
        if (brief.postNoteInbox && brief.postNoteInbox.count > 0) {
          // EI-19408487308624743: surface a RETRACTION-shaped post-note message
          // loudly, right next to the note's imperative — never let a withdrawn
          // premise sit as just one bullet in the generic list below, where a
          // reader following the note's own marching orders may never reach it.
          const retractionLines = detectRetractionShapedLines(brief.postNoteInbox.lines);
          if (retractionLines.length > 0) {
            sections.push(
              `⚠⚠ POSSIBLE RETRACTION AFTER THIS NOTE: ${retractionLines.length} of the message(s) below ` +
                `read as a correction/retraction of a prior claim. The note's imperative above (including any ` +
                `"resume"/"next action" instruction) may rest on a premise that was WITHDRAWN after the note ` +
                `was written — reconcile against these BEFORE executing anything the note instructs:\n` +
                retractionLines.join('\n'),
            );
          }
          sections.push(
            `⚠ ${brief.postNoteInbox.count} directed message(s) landed AFTER this carry-note was written — ` +
              `the note PREDATES them; read before acting on its imperatives:\n` +
              brief.postNoteInbox.lines.join('\n'),
          );
        }
      }
    } else {
      sections.push(`${head} No carry-note written.`);
    }
  }
  // Directives already rendered at the top — strip them so the extras call
  // (shared with the cold path, where they DO belong inside) can't double-render.
  const extras = renderCarryBriefColdExtras(directivesBlock ? { ...brief, directives: [] } : brief, {
    sessionActivityMs: opts.sessionActivityMs,
  });
  if (extras) sections.push(extras);
  return sections.join('\n\n');
}
