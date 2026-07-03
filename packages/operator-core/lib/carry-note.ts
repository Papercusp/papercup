/**
 * carry-note — the ONE shared "note to my next self" substrate + shape
 * (su-cold-auto-mode-2026-07-03 Phase 1 / P-001; D-004 — the linchpin +
 * precondition for cold-auto).
 *
 * Converges the THREE per-role carry mechanisms that already do this job into a
 * single durable PG store (`harness_shared.carry_notes`, mig 472) and one
 * structured shape:
 *   - the Queen carry-journal  (hive:declare-wake { remember } → setHiveCarryNote)
 *   - the bee checkpoint        (work_items:checkpoint → setWorkItemCheckpoint)
 *   - the su loop carry-note     (the SU AUTO loop's cold-wake anchor, P-002)
 *
 * A COLD wake (fresh-context reset or a recycle — Phase 2) reads its carry-note to
 * reconstruct working state instead of re-reading a grown transcript. Cold-start
 * is only as safe as what this captures, so the substrate lands FIRST and the
 * mechanism (Phase 2) builds on it.
 *
 * SEMANTICS (the shared D-003 contract, formerly duplicated in setHiveCarryNote +
 * setWorkItemCheckpoint): `note` is the current full state — any length (TEXT, no
 * cap), REPLACE-on-write; a blank/omitted/null note CLEARS `note` (the reader
 * re-derives from its floor — graceful degradation). Every non-blank write APPENDS
 * a capped entry to a bounded `journal` ring so the reasoning TRAJECTORY survives
 * a clear (the Queen carry-JOURNAL behavior, generalized to all three). A row with
 * a null note AND an empty journal is deleted. Durable PG, inspectable. LOCAL
 * working state — never federated.
 *
 * SCOPE: a stable, role-discriminated string key so the one store keys every
 * carrier — use the {@link hiveScope} / {@link workItemScope} / {@link loopScope}
 * constructors. Keyed (workspace_id, scope); the workspace_id column carries
 * workspace isolation.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { activeWorkspaceId } from './workspace-registry';

// ── Scope keys (the convergence axis) ────────────────────────────────────────

/** The Queen's per-workspace carry-note. The workspace_id column disambiguates,
 *  so no workspace suffix is needed. */
export function hiveScope(): string {
  return 'hive';
}

/** A bee's work-item-scoped checkpoint — lives on the item so an evicted bee's
 *  successor inherits it (bee-context-efficiency D-002). */
export function workItemScope(harness: string, workItemId: string): string {
  return `workitem:${harness}:${workItemId}`;
}

/** An su AUTO loop's carry-note, keyed by the owner id the loop wakes (stable
 *  across a fresh-context RESET and a RECYCLE — PAPERCUSP_SID is preserved, P-004). */
export function loopScope(harness: string, ownerId: string): string {
  return `loop:${harness}:${ownerId}`;
}

// ── The structured shape — a "note to my next self" ──────────────────────────

/** FACTS, not a self-grade (D-004). All fields optional; a plain string is equally
 *  valid (the store is free TEXT). {@link renderCarryNote} produces the canonical
 *  template a cold successor knows how to read. */
export interface CarryNoteFields {
  /** what-I-did — the concrete progress this session/wake made. */
  did?: string;
  /** what's-left — the remaining work, in order. */
  left?: string;
  /** key-insight — the non-obvious thing a cold successor would waste time re-deriving. */
  insight?: string;
  /** next-action — the single concrete next step to take on the next wake. */
  next?: string;
}

const CARRY_NOTE_SECTIONS: ReadonlyArray<{ key: keyof CarryNoteFields; heading: string }> = [
  { key: 'did', heading: 'Did' },
  { key: 'left', heading: 'Left' },
  { key: 'insight', heading: 'Key insight' },
  { key: 'next', heading: 'Next action' },
];

/** Render structured fields into the canonical carry-note template (the shared
 *  SHAPE). Blank/omitted sections are skipped; returns '' when nothing is set (⇒ a
 *  clear when passed to {@link setCarryNote}). */
export function renderCarryNote(fields: CarryNoteFields): string {
  return CARRY_NOTE_SECTIONS.map(({ key, heading }) => {
    const v = (fields[key] ?? '').trim();
    return v.length > 0 ? `## ${heading}\n${v}` : null;
  })
    .filter((s): s is string => s !== null)
    .join('\n\n');
}

/** Best-effort parse of a canonical carry-note (as produced by {@link renderCarryNote})
 *  back into fields — for inspection / loop:status rendering (P-008). A note with no
 *  recognized `## <Heading>` markers yields {} (the caller keeps the raw text). */
export function parseCarryNote(text: string): CarryNoteFields {
  const fields: CarryNoteFields = {};
  const byHeading = new Map(CARRY_NOTE_SECTIONS.map((s) => [s.heading.toLowerCase(), s.key]));
  // Split on lines that are exactly a known "## Heading".
  const lines = (text ?? '').split('\n');
  let cur: keyof CarryNoteFields | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) {
      const body = buf.join('\n').trim();
      if (body) fields[cur] = body;
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    const key = m ? byHeading.get(m[1].toLowerCase()) : undefined;
    if (key) {
      flush();
      cur = key;
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return fields;
}

// ── The journal ring (lifted verbatim from hive/wake.ts — the Queen's L1a
//    trajectory ring, now the shared default; wake.ts re-exports these) ────────

/** Carry-journal ring bounds (L1a): entries kept, per-note chars, total chars. */
export const CARRY_JOURNAL_MAX_ENTRIES = 15;
export const CARRY_JOURNAL_NOTE_MAX_CHARS = 600;
export const CARRY_JOURNAL_TOTAL_MAX_CHARS = 6_000;

export interface CarryJournalEntry {
  at: number;
  note: string;
}

/** Normalize a `journal` jsonb column read from PG. Depending on the pg client's
 *  type-parser config, a jsonb column comes back either already-parsed (a JS
 *  array) or as the raw JSON text — accept both, and any other shape degrades to
 *  an empty ring rather than spreading a string into characters. */
function normalizeJournal(v: unknown): CarryJournalEntry[] {
  if (!v) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as CarryJournalEntry[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? (v as CarryJournalEntry[]) : [];
}

/**
 * PURE (L1a): append a note to a carry-journal ring, enforcing all three bounds
 * (entry count, per-note chars, total chars — oldest dropped first). A blank note
 * appends nothing (returns the input unchanged).
 */
export function appendCarryJournal(
  journal: ReadonlyArray<CarryJournalEntry> | undefined,
  note: string,
  at: number,
): CarryJournalEntry[] {
  const trimmed = note.trim();
  const cur = [...(journal ?? [])];
  if (!trimmed) return cur;
  cur.push({ at, note: trimmed.slice(0, CARRY_JOURNAL_NOTE_MAX_CHARS) });
  while (cur.length > CARRY_JOURNAL_MAX_ENTRIES) cur.shift();
  let total = cur.reduce((n, e) => n + e.note.length, 0);
  while (total > CARRY_JOURNAL_TOTAL_MAX_CHARS && cur.length > 1) {
    const dropped = cur.shift();
    total -= dropped ? dropped.note.length : 0;
  }
  return cur;
}

// ── The durable store ────────────────────────────────────────────────────────

export interface CarryNoteRef {
  scope: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

function resolveRef(ref: CarryNoteRef | string): { ws: string; scope: string } {
  const scope = typeof ref === 'string' ? ref : ref.scope;
  const ws = (typeof ref === 'string' ? undefined : ref.workspaceId) ?? activeWorkspaceId();
  if (!ws) throw new Error('carry-note — no active workspace to scope the carry-note to');
  if (!scope) throw new Error('carry-note — a scope is required');
  return { ws, scope };
}

/**
 * Write (or clear) a carry-note. D-003 semantics: a non-blank string REPLACES
 * `note`; blank/null/undefined CLEARS `note`. Returns the stored note (trimmed)
 * or null when cleared. Read-modify-writes in one transaction.
 *
 * Journaling (default ON — the Queen/loop trajectory ring): a non-blank write
 * APPENDS a capped entry to the `journal` ring so the reasoning trajectory
 * survives a clear (a cleared note keeps its row while the journal is non-empty).
 * Pass `{ journal: false }` for a pure note (the bee checkpoint) — no ring, and a
 * clear DELETES the row (graceful degradation: the next read re-derives from the
 * floor). A scope always uses the same journaling mode.
 */
export async function setCarryNote(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: { journal?: boolean },
): Promise<string | null> {
  const journalEnabled = opts?.journal ?? true;
  const { ws, scope } = resolveRef(ref);
  const { sql } = getOrgPg();
  const trimmed = (note ?? '').trim();
  const now = Date.now();
  return (await sql.begin(async (tx) => {
    const rows = await tx<{ journal: unknown }[]>`
      SELECT journal FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} FOR UPDATE`;
    const prevJournal = normalizeJournal(rows[0]?.journal);
    // journaling ON: append (blank ⇒ unchanged ring); OFF: never keep a ring.
    const journal = journalEnabled ? appendCarryJournal(prevJournal, trimmed, now) : [];
    const noteCol = trimmed.length > 0 ? trimmed : null;

    if (noteCol === null && journal.length === 0) {
      // Nothing to store (cleared with no surviving journal) — delete the row.
      await tx`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${ws} AND scope = ${scope}`;
      return null;
    }
    await tx`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
      VALUES (${ws}, ${scope}, ${noteCol}, ${JSON.stringify(journal)}::jsonb, ${now})
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET note = EXCLUDED.note, journal = EXCLUDED.journal, updated_ts = EXCLUDED.updated_ts`;
    return noteCol;
  })) as string | null;
}

/** Read the current carry-note (the full `note` column), or null when none/cleared. */
export async function getCarryNote(ref: CarryNoteRef | string): Promise<string | null> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return null;
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ note: string | null }[]>`
    SELECT note FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
  const note = (rows[0]?.note ?? '').trim();
  return note.length > 0 ? note : null;
}

/** Read the carry-journal ring, NEWEST FIRST (the Queen brief renderer's input,
 *  generalized). Empty array when none. */
export async function getCarryJournal(ref: CarryNoteRef | string): Promise<CarryJournalEntry[]> {
  let ws: string, scope: string;
  try {
    ({ ws, scope } = resolveRef(ref));
  } catch {
    return [];
  }
  const { sql } = getOrgPg();
  const rows = await sql<{ journal: unknown }[]>`
    SELECT journal FROM harness_shared.carry_notes
     WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
  return [...normalizeJournal(rows[0]?.journal)].reverse();
}

// ── su-loop carry-note (P-002) — the SU AUTO loop's cold-wake anchor ──────────
//
// The su loop's slice of the substrate. Keyed by the owner id the loop wakes
// (loopScope), which is STABLE across a fresh-context RESET and a RECYCLE
// (PAPERCUSP_SID preserved — P-004), so a cold wake reads the SAME carry-note the
// warm session left. Journaling ON (like the Queen): the loop's recent trajectory
// (did/left/insight/next across wakes) survives, which a cold successor reads.
//
// The Phase-2 psu-host RESET-CONTEXT (P-004) captures the compaction summary the
// agent ALREADY writes at a clean turn-boundary into this note (no new agent
// behavior, P-002) and re-injects it as the cold session's opening context.

export interface LoopCarryNoteRef {
  harness: string;
  /** The coord ownerId the loop wakes (loop:arm target_owner_id). */
  ownerId: string;
  /** IGNORED for the loop scope since 2026-07-03 (kept for call-site compat): the
   *  loop carry-note is PINNED to the coord workspace — see loopCarryWs(). */
  workspaceId?: string;
}

/**
 * The ONE workspace the loop carry-note lives in — pinned to the coord workspace,
 * because the loop's whole lifecycle (arm → routine fire → wake delivery → cold
 * decision) rides the coord/events subsystem, which is itself pinned to
 * DEFAULT_COORD_WORKSPACE (events/await/store.ts `eventsWs`). Before this pin the
 * PRODUCER (loop:checkpoint, keyed by the MCP caller's ctx.workspaceId, e.g.
 * 'papercusp-workspace') and the CONSUMER (the wake executor, keyed by the
 * delivery row's ws = 'default') addressed DIFFERENT rows for the same scope —
 * the anchor was never found and every cold wake fail-safed to WARM (the
 * 2026-07-03 live-test bug, round 2). The scope string (loop:<harness>:<ownerId>)
 * is globally unique (ownerId is a session uuid), so a single pinned namespace
 * cannot collide across workspaces.
 */
function loopCarryWs(): string {
  return DEFAULT_COORD_WORKSPACE;
}

/** Write (or clear) an su AUTO loop's carry-note. Delegates to the shared
 *  substrate under {@link loopScope}, PINNED to the coord workspace (see
 *  {@link loopCarryWs}) so the producer and the wake-executor consumer address
 *  the same row no matter which host/ctx they run under. */
export async function setLoopCarryNote(
  ref: LoopCarryNoteRef,
  note: string | null | undefined,
): Promise<string | null> {
  return setCarryNote({ scope: loopScope(ref.harness, ref.ownerId), workspaceId: loopCarryWs() }, note);
}

/** Read an su AUTO loop's current carry-note (the full note), or null when none.
 *  Reads the pinned coord workspace first; on a miss, FALLS BACK to the newest
 *  row for the scope in ANY workspace — a note written by a not-yet-redeployed
 *  host still running the old ctx-workspace keying (host-version skew is real:
 *  the :3070 release, the bg-host and psu sessions restart at different times,
 *  and this exact skew is what broke cold-auto twice on 2026-07-03). */
export async function getLoopCarryNote(ref: LoopCarryNoteRef): Promise<string | null> {
  const scope = loopScope(ref.harness, ref.ownerId);
  const pinned = await getCarryNote({ scope, workspaceId: loopCarryWs() });
  if (pinned != null) return pinned;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ note: string | null }[]>`
      SELECT note FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY updated_ts DESC LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    return note.length > 0 ? note : null;
  } catch {
    return null;
  }
}

/** Read an su AUTO loop's carry-JOURNAL (newest first) — its recent trajectory.
 *  Same pinned-then-any-workspace resolution as {@link getLoopCarryNote}. */
export async function getLoopCarryJournal(ref: LoopCarryNoteRef): Promise<CarryJournalEntry[]> {
  const scope = loopScope(ref.harness, ref.ownerId);
  const pinned = await getCarryJournal({ scope, workspaceId: loopCarryWs() });
  if (pinned.length > 0) return pinned;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ journal: unknown }[]>`
      SELECT journal FROM harness_shared.carry_notes
       WHERE scope = ${scope}
       ORDER BY updated_ts DESC LIMIT 1`;
    return [...normalizeJournal(rows[0]?.journal)].reverse();
  } catch {
    return [];
  }
}
