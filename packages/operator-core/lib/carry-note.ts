/**
 * carry-note — the ONE shared "note to my next self" substrate + shape
 * (su-cold-auto-mode-2026-07-03 Phase 1 / P-001; D-004 — the linchpin +
 * precondition for cold-auto).
 *
 * Converges the THREE per-role carry mechanisms that already do this job into a
 * single durable PG store (`harness_shared.carry_notes`, mig 472) and one
 * structured shape:
 *   - the Queen carry-journal  (pot:declare-wake { remember } → setHiveCarryNote)
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
import { resolveConcreteWorkspaceId } from './workspace-registry';

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

/** An owner-gated / pending-decision COMMITMENT carried as a row, never prose
 *  (compaction-continuity-hardening-2026-07-07 P-006). Prose asks dissolve at a
 *  context boundary; a wall row survives it mechanically — rendered into every
 *  wake and every carry brief until explicitly cleared. */
export interface WallEntry {
  /** The pending action / decision, stated concretely ("3 zombie PIDs await owner OK to kill"). */
  claim: string;
  /** A concrete re-check command a successor runs to test whether the wall still stands. */
  recheck?: string;
  /** Epoch ms the wall was first recorded — preserved across rewrites of the same claim. */
  sinceMs?: number;
}

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
  /** open WALLS — owner-gated commitments as rows (P-006); rendered as a `## Walls`
   *  section of parseable one-line rows, carried until explicitly cleared. */
  walls?: WallEntry[];
}

type CarryNoteTextKey = 'did' | 'left' | 'insight' | 'next';

const CARRY_NOTE_SECTIONS: ReadonlyArray<{ key: CarryNoteTextKey; heading: string }> = [
  { key: 'did', heading: 'Did' },
  { key: 'left', heading: 'Left' },
  { key: 'insight', heading: 'Key insight' },
  { key: 'next', heading: 'Next action' },
];

/** The walls section heading (P-006). Rendered LAST so the four narrative sections
 *  keep their positions for existing parsers/extractors. */
export const CARRY_NOTE_WALLS_HEADING = 'Walls';

/** Bound on carried wall rows — a wall set past this is a triage problem, not a note. */
export const CARRY_NOTE_MAX_WALLS = 12;

/** One wall as a parseable single line: `- <claim> — re-check: <cmd> (since <ISO>)`.
 *  The " — re-check: " and trailing " (since …)" markers are the round-trip anchors. */
export function renderWallLine(w: WallEntry): string {
  const recheck = (w.recheck ?? '').trim();
  const since =
    w.sinceMs != null && Number.isFinite(w.sinceMs) ? ` (since ${new Date(w.sinceMs).toISOString()})` : '';
  return `- ${w.claim.trim()}${recheck ? ` — re-check: ${recheck}` : ''}${since}`;
}

/** Parse one walls-section line back into a {@link WallEntry}; null for a
 *  non-row line (blank, prose, malformed). */
export function parseWallLine(line: string): WallEntry | null {
  const m = /^-\s+(.+?)(?:\s+—\s+re-check:\s+(.+?))?(?:\s+\(since\s+([^)]+)\))?\s*$/.exec(line);
  if (!m) return null;
  const claim = (m[1] ?? '').trim();
  if (!claim) return null;
  const out: WallEntry = { claim };
  const recheck = (m[2] ?? '').trim();
  if (recheck) out.recheck = recheck;
  if (m[3]) {
    const t = Date.parse(m[3]);
    if (Number.isFinite(t)) out.sinceMs = t;
  }
  return out;
}

/** Render structured fields into the canonical carry-note template (the shared
 *  SHAPE). Blank/omitted sections are skipped; returns '' when nothing is set (⇒ a
 *  clear when passed to {@link setCarryNote}). Walls render last as parseable rows. */
export function renderCarryNote(fields: CarryNoteFields): string {
  const sections = CARRY_NOTE_SECTIONS.map(({ key, heading }) => {
    const v = (fields[key] ?? '').trim();
    return v.length > 0 ? `## ${heading}\n${v}` : null;
  }).filter((s): s is string => s !== null);
  const walls = (fields.walls ?? []).filter((w) => (w.claim ?? '').trim().length > 0);
  if (walls.length > 0) {
    sections.push(`## ${CARRY_NOTE_WALLS_HEADING}\n${walls.map(renderWallLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Best-effort parse of a canonical carry-note (as produced by {@link renderCarryNote})
 *  back into fields — for inspection / loop:status rendering (P-008). A note with no
 *  recognized `## <Heading>` markers yields {} (the caller keeps the raw text). */
export function parseCarryNote(text: string): CarryNoteFields {
  const fields: CarryNoteFields = {};
  const byHeading = new Map<string, CarryNoteTextKey | 'walls'>(
    CARRY_NOTE_SECTIONS.map((s) => [s.heading.toLowerCase(), s.key] as const),
  );
  byHeading.set(CARRY_NOTE_WALLS_HEADING.toLowerCase(), 'walls');
  // Split on lines that are exactly a known "## Heading".
  const lines = (text ?? '').split('\n');
  let cur: CarryNoteTextKey | 'walls' | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur === 'walls') {
      const walls = buf.map(parseWallLine).filter((w): w is WallEntry => w !== null);
      if (walls.length) fields.walls = walls;
    } else if (cur) {
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

/** Split a note into its walls rows and everything else (the `## Walls` section
 *  removed). The wake renderer needs walls SEPARATE from the truncatable note body
 *  (a wall clipped off the end of a capped note is a dissolved commitment), and the
 *  carry-forward merge needs the body without them. */
export function splitCarryNoteWalls(note: string | null | undefined): { body: string; walls: WallEntry[] } {
  const text = (note ?? '').trim();
  if (!text) return { body: '', walls: [] };
  const headingRe = new RegExp(`^##\\s+${CARRY_NOTE_WALLS_HEADING}\\s*$`, 'i');
  const lines = text.split('\n');
  const bodyLines: string[] = [];
  const walls: WallEntry[] = [];
  let inWalls = false;
  for (const line of lines) {
    if (headingRe.test(line)) {
      inWalls = true;
      continue;
    }
    if (inWalls && /^##\s+/.test(line)) inWalls = false; // a later section ends the walls block
    if (inWalls) {
      const w = parseWallLine(line);
      if (w) walls.push(w);
      continue; // non-row lines inside the section are dropped with it
    }
    bodyLines.push(line);
  }
  return { body: bodyLines.join('\n').trim(), walls };
}

/** Re-attach a walls set to a note body (any existing `## Walls` in `body` is
 *  replaced). An empty walls set yields the bare body; a blank body with walls
 *  yields a walls-only note — commitments survive a careless note clear. */
export function withCarryNoteWalls(body: string, walls: WallEntry[]): string {
  const { body: stripped } = splitCarryNoteWalls(body);
  const kept = walls.filter((w) => (w.claim ?? '').trim().length > 0);
  if (kept.length === 0) return stripped;
  const section = `## ${CARRY_NOTE_WALLS_HEADING}\n${kept.map(renderWallLine).join('\n')}`;
  return stripped ? `${stripped}\n\n${section}` : section;
}

/** Normalize an incoming walls write against the prior set: trim + drop blank
 *  claims, dedup by claim, preserve the ORIGINAL sinceMs for a claim that already
 *  stood (age is evidence — a rewrite must not reset it), stamp `nowMs` on new
 *  ones, cap at {@link CARRY_NOTE_MAX_WALLS}. */
export function normalizeWallEntries(
  entries: ReadonlyArray<{ claim: string; recheck?: string; sinceMs?: number }>,
  prior: ReadonlyArray<WallEntry>,
  nowMs: number = Date.now(),
): WallEntry[] {
  const priorByClaim = new Map(prior.map((w) => [w.claim.trim(), w] as const));
  const seen = new Set<string>();
  const out: WallEntry[] = [];
  for (const e of entries) {
    const claim = (e.claim ?? '').trim();
    if (!claim || seen.has(claim)) continue;
    seen.add(claim);
    const existing = priorByClaim.get(claim);
    const recheck = (e.recheck ?? existing?.recheck ?? '').trim();
    out.push({
      claim,
      ...(recheck ? { recheck } : {}),
      sinceMs: e.sinceMs ?? existing?.sinceMs ?? nowMs,
    });
    if (out.length >= CARRY_NOTE_MAX_WALLS) break;
  }
  return out;
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
  // WI-3648 (same bug class as EI-8824/EI-3409/WI-892): canonicalize through
  // resolveConcreteWorkspaceId, not a bare `?? activeWorkspaceId()`. A bare
  // fallback only fires on null/undefined — it lets a TRUTHY '*' (the
  // unscoped-superuser read-scoping wildcard, e.g. carry-brief.ts's
  // readHeldWorkItems → getWorkItemCheckpoint passing ctx.workspaceId straight
  // through) win outright, so a superuser session's checkpoint READ keyed
  // under the literal workspace_id='*' while EI-8824 already made every WRITE
  // (work_items:checkpoint) resolve to the concrete activeWorkspaceId() — the
  // write/read mismatch silently orphaned the checkpoint (observed live: a
  // 01:47Z write reported ok, but a ~01:49Z post-compaction read returned the
  // stale pre-EI-8824 '*'-keyed row instead). Canonicalizing HERE, in the one
  // shared resolveRef both setCarryNote and getCarryNote funnel through, closes
  // the gap for every current AND future caller — not just the write path.
  const ws = resolveConcreteWorkspaceId(typeof ref === 'string' ? undefined : ref.workspaceId);
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
  return (await setCarryNoteWithPrior(ref, note, opts)).stored;
}

/** The prior note's length alongside the write result — EI-9325: the row is
 *  already locked + read (for the journal ring) inside {@link setCarryNoteWithPrior}'s
 *  transaction, so surfacing the PRIOR note's length here is free (no extra
 *  round-trip). Lets a caller warn (never block) on a suspicious shrink — a
 *  replace-on-write dramatically shorter than what was there before usually means
 *  an accidental placeholder/truncated paste, not an intentional rewrite. */
export interface SetCarryNoteResult {
  stored: string | null;
  /** chars in the PRIOR note before this write replaced it (0 if none existed). */
  priorLength: number;
}

/** Same semantics as {@link setCarryNote}, plus the prior note's length (EI-9325) —
 *  free, since the row is already SELECTed FOR UPDATE to build the journal ring. */
export async function setCarryNoteWithPrior(
  ref: CarryNoteRef | string,
  note: string | null | undefined,
  opts?: { journal?: boolean },
): Promise<SetCarryNoteResult> {
  const journalEnabled = opts?.journal ?? true;
  const { ws, scope } = resolveRef(ref);
  const { sql } = getOrgPg();
  const trimmed = (note ?? '').trim();
  const now = Date.now();
  return (await sql.begin(async (tx) => {
    const rows = await tx<{ journal: unknown; note: string | null }[]>`
      SELECT journal, note FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} FOR UPDATE`;
    const prevJournal = normalizeJournal(rows[0]?.journal);
    const priorLength = (rows[0]?.note ?? '').length;
    // journaling ON: append (blank ⇒ unchanged ring); OFF: never keep a ring.
    const journal = journalEnabled ? appendCarryJournal(prevJournal, trimmed, now) : [];
    const noteCol = trimmed.length > 0 ? trimmed : null;

    if (noteCol === null && journal.length === 0) {
      // Nothing to store (cleared with no surviving journal) — delete the row.
      await tx`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${ws} AND scope = ${scope}`;
      return { stored: null, priorLength };
    }
    await tx`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, journal, updated_ts)
      VALUES (${ws}, ${scope}, ${noteCol}, ${JSON.stringify(journal)}::text::jsonb, ${now})
      ON CONFLICT (workspace_id, scope) DO UPDATE
        SET note = EXCLUDED.note, journal = EXCLUDED.journal, updated_ts = EXCLUDED.updated_ts`;
    return { stored: noteCol, priorLength };
  })) as SetCarryNoteResult;
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

/** A loop carry-note plus its write instant — the staleness input the wake
 *  renderer needs (compaction-continuity-hardening-2026-07-07 P-002): a note is
 *  only trustworthy relative to WHEN it was written, so the fire path reads both
 *  in one query instead of the note alone. */
export interface LoopCarryNoteWithMeta {
  note: string | null;
  /** Epoch ms of the note's last write (carry_notes.updated_ts), null when no note. */
  updatedAtMs: number | null;
}

/** Read an su AUTO loop's carry-note WITH its write instant. Same pinned-then-
 *  any-workspace precedence as {@link getLoopCarryNote}, collapsed to one query
 *  (the pinned coord-workspace row wins; else the newest row for the scope). */
export async function getLoopCarryNoteWithMeta(ref: LoopCarryNoteRef): Promise<LoopCarryNoteWithMeta> {
  const scope = loopScope(ref.harness, ref.ownerId);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ note: string | null; updated_ts: string | number | null }[]>`
      SELECT note, updated_ts FROM harness_shared.carry_notes
       WHERE scope = ${scope} AND note IS NOT NULL
       ORDER BY (workspace_id = ${loopCarryWs()}) DESC, updated_ts DESC LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    if (note.length === 0) return { note: null, updatedAtMs: null };
    const ts = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    return { note, updatedAtMs: Number.isFinite(ts) ? ts : null };
  } catch {
    return { note: null, updatedAtMs: null };
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
