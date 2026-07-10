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
import { FEATURE_TERMINAL_STATES } from './work-item-dispatch-states';
import {
  getLoopCarryNoteWithMeta,
  splitCarryNoteWalls,
  type LoopCarryNoteWithMeta,
  type WallEntry,
} from './carry-note';
import { harnessOfScope } from './work-item-scope';

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
}

export interface CarryBrief {
  ownerId: string;
  /** Armed AUTO loop + its carry-note (verbatim) — null when no loop routine exists. */
  loop: {
    harness: string;
    active: boolean;
    intervalSec: number | null;
    carryNote: string | null;
    carryNoteUpdatedAtMs: number | null;
  } | null;
  /** Held (assigned, non-terminal) work-items + their checkpoints. */
  heldItems: CarryBriefHeldItem[];
  /** Open WALLS (P-006): owner-gated commitments as structured rows, parsed out of
   *  the loop carry-note's `## Walls` section. The brief carries them VERBATIM —
   *  they are open commitments, and prose dissolves them. */
  walls: WallEntry[];
  /** Owner-scoped standing facts — the softer standing-context carrier (structured
   *  walls live in `walls` since P-006; facts remain for everything else). */
  facts: Array<{ key: string; body: string }>;
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
  const getCheckpoint =
    opts.getWorkItemCheckpointFn ??
    (async (ref: { harness: string | null; workItemId: string; workspaceId?: string }) => {
      const { getWorkItemCheckpoint } = await import('./work-item-checkpoint');
      return getWorkItemCheckpoint(ref);
    });
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
    try {
      checkpoint = await getCheckpoint({ harness, workItemId: h.issue_id, workspaceId: ws });
    } catch {
      /* per-item best-effort */
    }
    out.push({ id: h.issue_id, title: h.title, body: h.body, harness, checkpoint });
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
  ) => Promise<{ harnessSlug: string; active: boolean; intervalSec: number | null } | null>;
  getLoopCarryNoteWithMetaFn?: (ref: {
    harness: string;
    ownerId: string;
  }) => Promise<LoopCarryNoteWithMeta>;
  readHeldWorkItemsFn?: typeof readHeldWorkItems;
  listOwnerFactsFn?: (
    ownerId: string,
    workspaceId: string | undefined,
  ) => Promise<Array<{ key: string; body: string }>>;
  listActiveAwaitsFn?: (
    ownerId: string,
  ) => Promise<Array<{ eventKey: string; note: string | null }>>;
  getFleetFn?: (ownerId: string) => Promise<{ slug: string; role: string | null } | null>;
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
  const brief: CarryBrief = { ownerId, loop: null, heldItems: [], walls: [], facts: [], awaits: [], fleet: null };

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
        carryNote: meta.note,
        carryNoteUpdatedAtMs: meta.updatedAtMs,
      };
      // P-006: walls ride the note's `## Walls` section — surface them structured.
      brief.walls = splitCarryNoteWalls(meta.note).walls;
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
        return facts.map((f) => ({ key: f.key, body: f.body }));
      });
    brief.facts = (await listOwnerFacts(ownerId, workspaceId)).slice(0, CARRY_BRIEF_MAX_FACTS);
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

/**
 * The sections a COLD reset/recycle injection appends AFTER the loop carry-note
 * (consumer iii — wake-executor). The note stays the injection's core (P-006:
 * no note ⇒ no cold start at all), so this renders everything else: held items
 * + capped checkpoints, standing facts, armed awaits, the fleet pointer.
 * Returns '' when the brief carries nothing beyond the loop note.
 */
export function renderCarryBriefColdExtras(brief: CarryBrief): string {
  const sections: string[] = [];
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
  if (brief.heldItems.length > 0) {
    const lines = brief.heldItems.map((h) => {
      const title = h.title ? ` — ${cap(h.title, COLD_TITLE_CAP)}` : '';
      const ckpt = h.checkpoint
        ? `\n    checkpoint: ${cap(h.checkpoint, COLD_CHECKPOINT_CAP)}`
        : '\n    (no checkpoint written — read the item via work_items:get before acting)';
      return `  • ${h.id}${title}${ckpt}`;
    });
    sections.push(
      `You still HOLD these work-items (the full checkpoint re-injects on the item's next invocation; refresh it before ending):\n${lines.join('\n')}`,
    );
  }
  if (brief.facts.length > 0) {
    const lines = brief.facts.map((f) => `  • ${f.key}: ${cap(f.body, COLD_FACT_BODY_CAP)}`);
    sections.push(
      `Your standing facts (owner-scoped; folded into every orient until retracted — walls/commitments live here):\n${lines.join('\n')}`,
    );
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

/**
 * The full brief as text — the P-004 recovery-hook payload (and a debugging
 * surface). Loop section first (with the note's write age when known), then the
 * cold-extras sections.
 */
export function renderCarryBriefText(brief: CarryBrief, now: number = Date.now()): string {
  const sections: string[] = [];
  if (brief.loop) {
    const iv = brief.loop.intervalSec != null ? `, every ${brief.loop.intervalSec}s` : '';
    const head = `Armed loop @${brief.loop.harness} (${brief.loop.active ? 'active' : 'inactive'}${iv}).`;
    if (brief.loop.carryNote) {
      const age =
        brief.loop.carryNoteUpdatedAtMs != null
          ? ` (written ${humanAge(Math.max(0, now - brief.loop.carryNoteUpdatedAtMs))} ago)`
          : '';
      sections.push(`${head} Its carry-note${age}:\n${brief.loop.carryNote}`);
    } else {
      sections.push(`${head} No carry-note written.`);
    }
  }
  const extras = renderCarryBriefColdExtras(brief);
  if (extras) sections.push(extras);
  return sections.join('\n\n');
}
