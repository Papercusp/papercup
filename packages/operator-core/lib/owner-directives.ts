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

// ── Shape ─────────────────────────────────────────────────────────────────────

export type OwnerDirectiveDisposition = 'done' | 'declined';
export type OwnerDirectiveCaptureStatus = 'pending' | 'open' | 'dismissed';

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
  captureStatus?: OwnerDirectiveCaptureStatus;
  captureDismissalReason?: string | null;
  captureDismissedAtMs?: number | null;
  captureDismissedBy?: string | null;
  /** When a pending hook capture was promoted to an open directive; null until promotion. */
  capturePromotedAtMs?: number | null;
  capturePromotedBy?: string | null;
  /**
   * True when the row came from the UserPromptSubmit provenance hook rather than an agent
   * calling orders:record. Unlike captureStatus this SURVIVES promotion, so provenance is
   * still answerable once the row is acted on.
   */
  capturedByHook?: boolean;
}

// ── Bounds ────────────────────────────────────────────────────────────────────

/** A row at or under this renders whole (verbatim). */
export const OWNER_DIRECTIVE_WHOLE_MAX = 300;
/** A longer row renders substr(0, this) + the orders:get pointer. */
export const OWNER_DIRECTIVE_EXCERPT_CHARS = 200;
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
  capture_status: string | null;
  capture_dismissal_reason: string | null;
  capture_dismissed_at: string | Date | null;
  capture_dismissed_by: string | null;
  capture_promoted_at: string | Date | null;
  capture_promoted_by: string | null;
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
    captureStatus:
      r.capture_status === 'pending' || r.capture_status === 'dismissed' ? r.capture_status : 'open',
    captureDismissalReason: r.capture_dismissal_reason,
    captureDismissedAtMs: toMs(r.capture_dismissed_at),
    captureDismissedBy: r.capture_dismissed_by,
    capturePromotedAtMs: toMs(r.capture_promoted_at),
    capturePromotedBy: r.capture_promoted_by,
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
  /** Hybrid capture lifecycle. Hook-created rows start pending; agents promote to open. */
  captureStatus?: Exclude<OwnerDirectiveCaptureStatus, 'dismissed'>;
  /** True only for the UserPromptSubmit hook's capture path; survives promotion. */
  capturedByHook?: boolean;
}

export async function recordOwnerDirective(
  input: RecordOwnerDirectiveInput,
  sql?: Sql,
): Promise<OwnerDirectiveRow> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(input.workspaceId);
  const text = input.verbatimText.slice(0, OWNER_DIRECTIVE_VERBATIM_MAX);
  const rows = await s<RawRow[]>`
    INSERT INTO harness_shared.owner_directives
      (workspace_id, owner_id, session_ref, source_turn_ref, verbatim_text, recorded_by, capture_status, captured_by_hook)
    SELECT ${ws}, ${input.ownerId ?? OWNER_DIRECTIVE_DEFAULT_OWNER}, ${input.sessionRef ?? null},
       ${input.sourceTurnRef ?? null}, ${text}, ${input.recordedBy}, ${input.captureStatus ?? 'open'},
       ${input.capturedByHook === true}
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
       AND capture_status = 'pending'
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
  /** true → only unresolved capture rows; false → only dispositioned history; omitted → all. */
  open?: boolean;
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
  const rows = await s<RawRow[]>`
    SELECT * FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       ${opts.open === true ? s`AND dispositioned_at IS NULL AND capture_status <> 'dismissed'` : opts.open === false ? s`AND (dispositioned_at IS NOT NULL OR capture_status = 'dismissed')` : s``}
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit}
  `;
  return rows.map(rowOf);
}

/** The hot read every render point uses: open directives, OLDEST first. */
export async function listOpenOwnerDirectives(
  workspaceId: string,
  limit: number = OWNER_DIRECTIVES_RENDER_MAX_ROWS,
  sql?: Sql,
): Promise<OwnerDirectiveRow[]> {
  return listOwnerDirectives({ workspaceId, open: true, limit }, sql);
}

export async function countOpenOwnerDirectives(workspaceId: string, sql?: Sql): Promise<number> {
  const s = db(sql);
  const ws = resolveConcreteWorkspaceId(workspaceId);
  const rows = await s<Array<{ n: string | number }>>`
    SELECT count(*) AS n FROM harness_shared.owner_directives
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND dispositioned_at IS NULL
       AND capture_status <> 'dismissed'
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

export type ResolvePendingOwnerDirectiveResult =
  | { ok: true; row: OwnerDirectiveRow }
  | { ok: false; error: 'not_found' | 'not_pending'; row?: OwnerDirectiveRow };

/** Promote an auto-captured pending owner turn into an actionable directive. */
export async function promoteOwnerDirective(
  input: { id: number; promotedBy: string },
  sql?: Sql,
): Promise<ResolvePendingOwnerDirectiveResult> {
  const s = db(sql);
  const rows = await s<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET capture_status = 'open',
           capture_promoted_at = now(),
           capture_promoted_by = ${input.promotedBy}
     WHERE id = ${input.id} AND capture_status = 'pending' AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'not_pending', row: existing };
}

/** Dismiss an auto-captured pending turn with an explicit, durable reason. */
export async function dismissOwnerDirective(
  input: { id: number; reason: string; dismissedBy: string },
  sql?: Sql,
): Promise<ResolvePendingOwnerDirectiveResult> {
  const s = db(sql);
  const rows = await s<RawRow[]>`
    UPDATE harness_shared.owner_directives
       SET capture_status = 'dismissed',
           capture_dismissal_reason = ${input.reason},
           capture_dismissed_at = now(),
           capture_dismissed_by = ${input.dismissedBy}
     WHERE id = ${input.id} AND capture_status = 'pending' AND dispositioned_at IS NULL
     RETURNING *
  `;
  if (rows[0]) return { ok: true, row: rowOf(rows[0]) };
  const existing = await getOwnerDirective(input.id, sql);
  if (!existing) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'not_pending', row: existing };
}

// ── Renderer (pure) ───────────────────────────────────────────────────────────

function humanAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** One row, budgeted: whole when short, substr(0, EXCERPT) + pointer when long.
 *  substr, never summarization — the full verbatim is one orders:get away. */
export function renderOwnerDirectiveRow(row: OwnerDirectiveRow, nowMs: number = Date.now()): string {
  const age = humanAge(Math.max(0, nowMs - row.createdAtMs));
  const by = row.recordedBy.length > 12 ? row.recordedBy.slice(0, 12) : row.recordedBy;
  const text = row.verbatimText.trim();
  const rendered =
    text.length <= OWNER_DIRECTIVE_WHOLE_MAX
      ? `"${text}"`
      : `"${text.slice(0, OWNER_DIRECTIVE_EXCERPT_CHARS)}…" [full text: orders:get #${row.id}]`;
  const pending = row.captureStatus === 'pending' ? ' [PENDING — resolve next turn]' : '';
  return `  • #${row.id} [${age} old, recorded by ${by}]${pending} ${rendered}`;
}

export const OWNER_DIRECTIVES_BLOCK_HEADER =
  '📌 OPEN OWNER DIRECTIVES — explicit owner turns recorded verbatim; pending captures must be promoted or ' +
  'dismissed before they stop injecting. These OUTRANK your loop agenda: re-read them BEFORE acting on ' +
  'the checkpoint below, then use orders:resolve-pending or orders:disposition as appropriate.';

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
  opts: { nowMs?: number; sql?: Sql } = {},
): Promise<string | null> {
  // A workspace-less caller (e.g. a loop routine armed without one) falls back
  // to the active workspace — an open owner directive must not be skippable by
  // a missing scope field.
  const ws = workspaceId || activeWorkspaceId();
  if (!ws) return null;
  try {
    const rows = await listOpenOwnerDirectives(ws, OWNER_DIRECTIVES_RENDER_MAX_ROWS, opts.sql);
    if (!rows.length) return null;
    const totalOpen =
      rows.length >= OWNER_DIRECTIVES_RENDER_MAX_ROWS
        ? await countOpenOwnerDirectives(ws, opts.sql).catch(() => rows.length)
        : rows.length;
    return renderOwnerDirectivesBlock(rows, { nowMs: opts.nowMs, totalOpen });
  } catch {
    return null;
  }
}
