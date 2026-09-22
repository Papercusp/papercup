/**
 * owner-directives — the first-class store + budgeted renderer for explicit
 * owner directives (EI-11484).
 *
 * ORIGIN: after the 2026-07-13 OOM logout the owner directed "resume all the
 * sessions active in the last half hour"; the agent demoted the order to
 * checkpoint prose and the armed loop's re-injected standing agenda buried it.
 * Priority inversion: loop agendas have a re-injection surface, fresh owner
 * directives don't. This module gives them one.
 *
 * MODEL (owner-ruled: "lets just have the agent record the directive. they
 * should decide what to keep" — agent-EXPLICIT recording, no auto-capture, no
 * imperative detection):
 *   - orders:record files the owner's words VERBATIM into
 *     harness_shared.owner_directives (migration 597);
 *   - OPEN rows (dispositioned_at IS NULL) render ABOVE the loop contract in
 *     every wake (loop-fire), every orient fold, and the compaction/cold
 *     anchor (carry-brief) until dispositioned;
 *   - orders:disposition { id, status: done|declined, note } closes one.
 *
 * RENDER BUDGET (owner token-burn ruling): verbatim in STORE, budgeted in
 * RENDER — rows ≤ WHOLE_MAX chars render whole; longer rows render
 * substr(0, EXCERPT_CHARS) + an "[orders:get #id]" pointer; the whole block is
 * capped at BLOCK_CHAR_CAP with an overflow "+N more — orders:list" line.
 * Excerpts are substr(), NEVER summarization — a paraphrase of an owner order
 * is exactly the rot this store exists to prevent.
 *
 * SCOPE: rows key on (workspace_id, owner_id) — NOT on a session or loop — so
 * a directive survives the recording session's death and renders to successor
 * sessions in the same workspace. Rows carry recorded_by attribution so a
 * reader can tell "mine" from a peer's lane.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId, resolveConcreteWorkspaceId } from './workspace-registry';
import { agendaClearedExclusionSql } from './owner-directive-agenda';
import {
  directiveDisplayText,
  directiveNeedsSummary,
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
  shortOwner,
} from './owner-directive-display';

export {
  directiveDisplayText,
  directiveNeedsSummary,
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
} from './owner-directive-display';

// ── Shape ─────────────────────────────────────────────────────────────────────

export type OwnerDirectiveDisposition = 'done' | 'declined';

/**
 * The single LIFECYCLE state of a directive. Every owner turn is a directive
 * (D-001 of owner-directive-delivery-redesign-2026-09-22): a captured turn is
 * `open` the moment it lands, and it ends only as `done` or `declined` with a
 * reason. The former pending → promote/dismiss capture triage is gone; migration
 * 1198 folded pending rows into open and capture dismissals into declines, and a
 * BEFORE trigger keeps legacy writers inside this three-state space.
 */
export type OwnerDirectiveState = 'open' | 'done' | 'declined';

export const OWNER_DIRECTIVE_STATES: readonly OwnerDirectiveState[] = ['open', 'done', 'declined'] as const;

/** Derive the lifecycle state of one row. PURE; the SQL CASE in listOwnerDirectives mirrors it. */
export function ownerDirectiveState(row: {
  dispositionedAtMs: number | null;
  dispositionStatus: OwnerDirectiveDisposition | null;
}): OwnerDirectiveState {
  if (row.dispositionedAtMs != null) return row.dispositionStatus === 'declined' ? 'declined' : 'done';
  return 'open';
}

export interface OwnerDirectiveRow {
  id: number;
  workspaceId: string;
  ownerId: string;
  sessionRef: string | null;
  sourceTurnRef: string | null;
  verbatimText: string;
  recordedBy: string;
  createdAtMs: number;
  dispositionedAtMs: number | null;
  dispositionStatus: OwnerDirectiveDisposition | null;
  dispositionNote: string | null;
  dispositionedBy: string | null;
  /**
   * Agent-written summary (≤ OWNER_DIRECTIVE_SUMMARY_MAX chars) of a directive
   * whose verbatim text exceeds OWNER_DIRECTIVE_VERBATIM_CAP. It is what other
   * agents see for a long open directive (D-004); null until orders:summarize.
   */
  summaryText?: string | null;
  summaryBy?: string | null;
  summaryAtMs?: number | null;
  /**
   * True when the row came from the UserPromptSubmit provenance hook rather than an agent
   * calling orders:record.
   */
  capturedByHook?: boolean;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

/** A row at or under this renders whole (verbatim). */
export const OWNER_DIRECTIVE_WHOLE_MAX = 300;
/** A longer row renders substr(0, this) + the orders:get pointer. */
export const OWNER_DIRECTIVE_EXCERPT_CHARS = 200;
/**
 * The ORIENTATION-ROW excerpt, a much tighter bound than the block renders.
 *
 * Deliberately its own constant rather than a reuse of the two above: the
 * turn-start obligation sink budgets 400 chars for 3 whole rows (~132 each),
 * and a row also has to carry its id, disposition verb and recovery pointer.
 * A 200-char excerpt there does not merely clip — it costs WHOLE ROWS, so a
 * third pending directive silently stops being delivered at all.
 *
 * Changing this without re-measuring the rendered row against that budget is
 * the failure `agent-obligation-orientation-row.test.ts` exists to catch.
 */
export const ORIENTATION_ROW_EXCERPT_CHARS = 90;
/** Hard cap on the rendered block (~1.5K tokens) — overflow rows collapse to a count line. */
export const OWNER_DIRECTIVES_BLOCK_CHAR_CAP = 6000;
/** Most rows any render fetches — beyond this, the "+N more" line covers the rest. */
export const OWNER_DIRECTIVES_RENDER_MAX_ROWS = 12;
/** Store-side sanity cap on verbatim_text (the store keeps it verbatim; render budgets). */
export const OWNER_DIRECTIVE_VERBATIM_MAX = 16000;

/** Single-owner system default for owner_id when the caller has no richer identity. */
export const OWNER_DIRECTIVE_DEFAULT_OWNER = 'owner';

// ── Store ─────────────────────────────────────────────────────────────────────

function db(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function toMs(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

interface RawRow {
  id: string | number;
  workspace_id: string;
  owner_id: string;
  session_ref: string | null;
  source_turn_ref: string | null;
  verbatim_text: string;
  recorded_by: string;
  created_at: string | Date;
  dispositioned_at: string | Date | null;
  disposition_status: string | null;
  disposition_note: string | null;
  dispositioned_by: string | null;
  summary_text: string | null;
  summary_by: string | null;
  summary_at: string | Date | null;
  captured_by_hook: boolean | null;
}

function rowOf(r: RawRow): OwnerDirectiveRow {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    sessionRef: r.session_ref,
    sourceTurnRef: r.source_turn_ref,
    verbatimText: r.verbatim_text,
    recordedBy: r.recorded_by,
    createdAtMs: toMs(r.created_at) ?? 0,
    dispositionedAtMs: toMs(r.dispositioned_at),
    dispositionStatus:
      r.disposition_status === 'done' || r.disposition_status === 'declined' ? r.disposition_status : null,
    dispositionNote: r.disposition_note,
    dispositionedBy: r.dispositioned_by,
    summaryText: r.summary_text ?? null,
    summaryBy: r.summary_by ?? null,
    summaryAtMs: toMs(r.summary_at),
    capturedByHook: r.captured_by_hook === true,
  };
}

export interface RecordOwnerDirectiveInput {
  workspaceId: string;
  /** The human owner the directive came from (single-owner default: 'owner'). */
  ownerId?: string;
  /** The recording agent's session pointer (native session id when known). */
  sessionRef?: string | null;
  /** Provenance pointer to the OWNER (interactive) turn (session id + turn ts / stamp tag). */
  sourceTurnRef?: string | null;
  /** The owner's words VERBATIM — never a paraphrase. */
  verbatimText: string;
  /** The recording agent (coord ownerId). */
  recordedBy: string;
  /** True only for the UserPromptSubmit hook's capture path. */
  capturedByHook?: boolean;
}

/**
 * Insert a directive, OPEN. Idempotent on (workspace, owner, source_turn_ref):
 * a retried capture of the same turn returns the row that already exists,
 * whatever state it has reached since, instead of failing.
 */
export async function recordOwnerDirective(
  input: RecordOwnerDirectiveInput,
  sql?: Sql,
): Promise<OwnerDirectiveRow> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(input.workspaceId);
  const text = input.verbatimText.slice(0, OWNER_DIRECTIVE_VERBATIM_MAX);
  const rows = await s<RawRow[]>`
    INSERT INTO harness_shared.owner_directives
      (workspace_id, owner_id, session_ref, source_turn_ref, verbatim_text, recorded_by, captured_by_hook)
    SELECT ${ws}, ${input.ownerId ?? OWNER_DIRECTIVE_DEFAULT_OWNER}, ${input.sessionRef ?? null},
       ${input.sourceTurnRef ?? null}, ${text}, ${input.recordedBy}, ${input.capturedByHook === true}
    WHERE NOT EXISTS (
      SELECT 1 FROM harness_shared.owner_directives
       WHERE workspace_id = ${ws}
         AND owner_id = ${input.ownerId ?? OWNER_DIRECTIVE_DEFAULT_OWNER}
         AND source_turn_ref = ${input.sourceTurnRef ?? null}
    )
    RETURNING *
  `;
  if (rows[0]) return rowOf(rows[0]);
  const existing = await s<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives
     WHERE workspace_id = ${ws}
       AND owner_id = ${input.ownerId ?? OWNER_DIRECTIVE_DEFAULT_OWNER}
       AND source_turn_ref = ${input.sourceTurnRef ?? null}
     ORDER BY id DESC
     LIMIT 1
  `;
  if (existing[0]) return rowOf(existing[0]);
  throw new Error('owner_directive_insert_conflict');
}

export async function getOwnerDirective(id: number, sql?: Sql): Promise<OwnerDirectiveRow | null> {
  const rows = await db(sql)<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives WHERE id = ${id}
  `;
  return rows[0] ? rowOf(rows[0]) : null;
}

export interface ListOwnerDirectivesOpts {
  workspaceId: string;
  /** true → only open rows; false → only dispositioned history; omitted → all. */
  open?: boolean;
  /**
   * Filter by exact lifecycle state(s) — the only way to separate `done` from
   * `declined`. Applied in SQL, BEFORE `limit`: filtering client-side on the
   * returned page silently drops matching rows that the limit already truncated
   * away, which reads as a real absence. Combined with `open`, both apply (AND).
   */
  state?: OwnerDirectiveState | readonly OwnerDirectiveState[];
  /**
   * P-008 / D-008: the session this list is being rendered FOR. When given,
   * directives that session has cleared off its own agenda are excluded — for
   * that session only, changing nothing for the addressee or any peer.
   *
   * Omitted = the LEDGER view (orders:list, the disposition audit trail), which
   * must keep showing rows a session has personally discharged. Only banner /
   * obligation render points pass it.
   */
  viewerOwnerId?: string | null;
  limit?: number;
}

export async function listOwnerDirectives(
  opts: ListOwnerDirectivesOpts,
  sql?: Sql,
): Promise<OwnerDirectiveRow[]> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(opts.workspaceId);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  // 'default' is matched alongside the canonical workspace for the same reason
  // readHeldWorkItems does: legacy/unscoped writers land rows under 'default'.
  const states = opts.state == null ? null : [...(Array.isArray(opts.state) ? opts.state : [opts.state])];
  const rows = await s<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       ${opts.open === true ? s`AND dispositioned_at IS NULL` : opts.open === false ? s`AND dispositioned_at IS NOT NULL` : s``}
       ${agendaClearedExclusionSql(s, opts.viewerOwnerId)}
       ${
         states && states.length > 0
           ? // Mirrors ownerDirectiveState() exactly, in the same precedence order.
             // owner-directive-state-parity.test.ts asserts the two agree for every
             // state, so this CASE cannot silently drift from the TS derivation.
             s`AND CASE
                 WHEN dispositioned_at IS NOT NULL AND disposition_status = 'declined' THEN 'declined'
                 WHEN dispositioned_at IS NOT NULL THEN 'done'
                 ELSE 'open'
               END IN ${s(states)}`
           : s``
       }
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit}
  `;
  return rows.map(rowOf);
}

/**
 * The hot read every render point uses: open directives, OLDEST first.
 *
 * `viewerOwnerId` is the session the banner is being rendered FOR; passing it
 * drops the rows that session has cleared from its own agenda (P-008 / D-008).
 * It is the LAST parameter and optional, so a caller with no session in scope
 * keeps the workspace-wide view rather than accidentally rendering somebody
 * else's agenda.
 */
export async function listOpenOwnerDirectives(
  workspaceId: string,
  limit: number = OWNER_DIRECTIVES_RENDER_MAX_ROWS,
  sql?: Sql,
  viewerOwnerId?: string | null,
): Promise<OwnerDirectiveRow[]> {
  return listOwnerDirectives({ workspaceId, open: true, limit, viewerOwnerId }, sql);
}

export async function countOpenOwnerDirectives(
  workspaceId: string,
  sql?: Sql,
  viewerOwnerId?: string | null,
): Promise<number> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(workspaceId);
  // The count must apply the SAME exclusion as the list above, or a banner that
  // hides three cleared rows still announces "+3 more" and sends the reader to
  // orders:list looking for directives its own banner is deliberately hiding.
  const rows = await s<Array<{ n: string | number }>>`
    SELECT count(*) AS n FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND dispositioned_at IS NULL
       ${agendaClearedExclusionSql(s, viewerOwnerId)}
  `;
  return Number(rows[0]?.n ?? 0);
}

export type DispositionOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | { ok: false; error: 'not_found' | 'already_dispositioned'; row?: OwnerDirectiveRow };

export async function dispositionOwnerDirective(
  input: { id: number; status: OwnerDirectiveDisposition; note: string; dispositionedBy: string },
  sql?: Sql,
): Promise<DispositionOwnerDirectiveResult> {
  const s = db(sql);
  const rows = await s<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET dispositioned_at = now(),
           disposition_status = ${input.status},
           disposition_note = ${input.note},
           dispositioned_by = ${input.dispositionedBy}
     WHERE id = ${input.id}
       AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'already_dispositioned', row: existing };
}

export type SummarizeOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | {
      ok: false;
      error: 'not_found' | 'already_dispositioned' | 'summary_not_needed' | 'summary_too_long' | 'summary_empty';
      row?: OwnerDirectiveRow;
    };

/**
 * Write (or rewrite) the agent summary of an over-cap directive (D-004). The
 * summary is what every OTHER agent sees for a long open directive, so it is
 * refused for a directive short enough to render verbatim (a summary there
 * would only ever be a lossy duplicate) and for a closed one (closed
 * directives render nowhere, D-002). verbatim_text is never touched.
 */
export async function summarizeOwnerDirective(
  input: { id: number; summary: string; summarizedBy: string },
  sql?: Sql,
): Promise<SummarizeOwnerDirectiveResult> {
  const summary = input.summary.trim().replace(/\s+/g, ' ');
  if (!summary) return { ok: false, error: 'summary_empty' };
  if (summary.length > OWNER_DIRECTIVE_SUMMARY_MAX) return { ok: false, error: 'summary_too_long' };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  if (!directiveNeedsSummary(existing)) return { ok: false, error: 'summary_not_needed', row: existing };
  const rows = await db(sql)<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET summary_text = ${summary},
           summary_by = ${input.summarizedBy},
           summary_at = now()
     WHERE id = ${input.id}
       AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  return { ok: false, error: 'already_dispositioned', row: existing };
}

// ── Renderer (pure) ───────────────────────────────────────────────────────────

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The budgeted VERBATIM excerpt of one directive's text — whole when short,
 * `substr(0, EXCERPT_CHARS) + '…'` when long. substr, never summarization: the
 * full verbatim is one `orders:get` away, and a paraphrase of an owner turn is
 * precisely the rot the verbatim store exists to prevent.
 *
 * Exported because more than one render point needs the SAME budgeted text
 * (the per-turn owner-directive block and the class-B obligation row), and two
 * hand-spelled copies of a truncation rule drift into two different excerpts of
 * the same owner sentence. Truncation is detectable by the caller without a
 * second flag: a truncated excerpt is strictly SHORTER than the trimmed input.
 */
export function orientationRowExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= ORIENTATION_ROW_EXCERPT_CHARS) return trimmed;
  // The input may ALREADY be a budgeted excerpt (ownerDirectiveExcerpt output),
  // so strip its ellipsis before re-cutting — otherwise a row renders '……' and
  // spends two of its scarcest chars saying "truncated" twice.
  const body = trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed;
  return `${body.slice(0, ORIENTATION_ROW_EXCERPT_CHARS).trimEnd()}…`;
}

export function ownerDirectiveExcerpt(verbatimText: string): string {
  const text = verbatimText.trim();
  if (text.length <= OWNER_DIRECTIVE_WHOLE_MAX) return text;
  return `${text.slice(0, OWNER_DIRECTIVE_EXCERPT_CHARS)}…`;
}

/** One row: id, age, addressee, and the D-004 display text. */
export function renderOwnerDirectiveRow(row: OwnerDirectiveRow, nowMs: number = Date.now()): string {
  const age = humanAge(Math.max(0, nowMs - row.createdAtMs));
  return `  • #${row.id} [${age} old, recorded by ${shortOwner(row.recordedBy)}] ${directiveDisplayText(row)}`;
}

export const OWNER_DIRECTIVES_BLOCK_HEADER =
  '📌 OPEN OWNER DIRECTIVES — every owner turn is a directive, recorded verbatim. These OUTRANK your loop ' +
  'agenda: re-read them BEFORE acting on the checkpoint below. Close each one you resolve with ' +
  'orders:disposition { id, status: done|declined, note }.';

/**
 * The block every render point injects. Returns null when there are no open
 * rows. `totalOpen` (when it exceeds rows.length) adds the "+N more" line even
 * if the char cap was not hit — the fetch itself is bounded.
 */
export function renderOwnerDirectivesBlock(
  rows: ReadonlyArray<OwnerDirectiveRow>,
  opts: { nowMs?: number; totalOpen?: number } = {},
): string | null {
  if (!rows.length) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const totalOpen = Math.max(opts.totalOpen ?? rows.length, rows.length);
  const lines: string[] = [OWNER_DIRECTIVES_BLOCK_HEADER];
  let used = OWNER_DIRECTIVES_BLOCK_HEADER.length;
  let shown = 0;
  for (const row of rows) {
    const line = renderOwnerDirectiveRow(row, nowMs);
    if (used + line.length + 1 > OWNER_DIRECTIVES_BLOCK_CHAR_CAP) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const hidden = totalOpen - shown;
  if (hidden > 0) lines.push(`  +${hidden} more open — orders:list { open: true }`);
  return lines.join('\n');
}

/**
 * Convenience: fetch + render the open-directives block for a workspace.
 * Best-effort by contract — every caller is a prompt-assembly path that must
 * never fail because this read did; a miss renders nothing.
 */
export async function renderOpenOwnerDirectivesBlock(
  workspaceId: string | null | undefined,
  opts: { nowMs?: number; sql?: Sql; viewerOwnerId?: string | null } = {},
): Promise<string | null> {
  // A workspace-less caller (e.g. a loop routine armed without one) falls back
  // to the active workspace — an open owner directive must not be skippable by
  // a missing scope field.
  const ws = workspaceId || activeWorkspaceId();
  if (!ws) return null;
  try {
    const rows = await listOpenOwnerDirectives(ws, OWNER_DIRECTIVES_RENDER_MAX_ROWS, opts.sql, opts.viewerOwnerId);
    if (!rows.length) return null;
    const totalOpen =
      rows.length >= OWNER_DIRECTIVES_RENDER_MAX_ROWS
        ? await countOpenOwnerDirectives(ws, opts.sql, opts.viewerOwnerId).catch(() => rows.length)
        : rows.length;
    return renderOwnerDirectivesBlock(rows, { nowMs: opts.nowMs, totalOpen });
  } catch {
    return null;
  }
}
