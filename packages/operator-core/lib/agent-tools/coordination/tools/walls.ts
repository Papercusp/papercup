/**
 * coord:walls — "what is blocked on the OWNER right now?"
 *
 * EI-10890. The system already MANDATES that an agent register anything it is
 * blocked on the owner for:
 *   - `loop:checkpoint { walls }` writes owner-gated commitments as rows into the
 *     loop carry-note, where they re-render into every wake until cleared;
 *   - a work-item parked in `needs-human` is, by definition, waiting on a human.
 *
 * Both are WRITTEN faithfully. Neither was READABLE. There was no query that
 * answered "what is waiting on me", so the walls piled up where only the blocked
 * agent could see them — in its own carry-note.
 *
 * The cost of that gap, observed 2026-07-13: the auto-loop-reliability lane
 * (su-39f079d3) sat parked for ~5 HOURS on a single 4-way capacity decision it had
 * correctly registered as a wall and correctly messaged the owner about. The owner
 * did not know. It surfaced only because he happened to ask an unrelated question
 * about that session and an agent grepped its carry-note by hand. Every mechanism
 * worked exactly as designed; the only missing part was a read.
 *
 * This is that read. It is deliberately a UNION over the two write surfaces rather
 * than a new store — the data is already there, correctly maintained, and a third
 * parallel "walls table" would just be a fourth thing to keep in sync (reuse-first).
 *
 * The liveness join is the non-obvious half: a wall whose agent is DEAD is worse
 * than a wall whose agent is alive. Answering a dead agent's question unblocks
 * nothing — nobody is waiting to act on the answer — so those are reported as
 * `stranded` and need a respawn, not a reply. Without that distinction an owner
 * clears a wall, feels productive, and the work still does not move.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../roles';
import { splitCarryNoteWalls } from '../../../carry-note';

/** A loop carry-note scope is `loop:<harness>:<ownerId>` (carry-note.ts loopScope). */
function parseLoopScope(scope: string): { harness: string; ownerId: string } | null {
  if (!scope.startsWith('loop:')) return null;
  const rest = scope.slice('loop:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { harness: rest.slice(0, sep), ownerId: rest.slice(sep + 1) };
}

/** Whole hours a wall has stood. Drives the ordering: oldest first, because the
 *  wall nobody has looked at in 5h is the one costing the most. */
function hoursSince(ms: number | null, now: number): number | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(((now - ms) / 3_600_000) * 10) / 10);
}

/** An agent is a live waiter only if it has heartbeated recently. Beyond this it
 *  is presumed dead and its wall is STRANDED — the answer would land on nobody. */
const LIVE_WITHIN_MS = 10 * 60 * 1000;

export interface WallRow {
  source: 'loop-carry-note' | 'work-item';
  ownerId: string | null;
  harness: string | null;
  claim: string;
  recheck?: string;
  ref?: string;
  sinceIso: string | null;
  waitingHours: number | null;
  /** waiting = the agent is alive and parked on your answer; stranded = its session
   *  is gone, so answering alone will NOT resume the work (respawn it too). */
  status: 'waiting' | 'stranded' | 'unknown';
}

export interface ListOwnerWallsOpts {
  workspaceId?: string;
  harness?: string;
  ownerId?: string;
  minHours?: number;
  includeStranded?: boolean;
  limit?: number;
}

/**
 * The reusable core of `coord:walls` (owner-inbox-single-pane-2026-07-17 P-005b
 * reuse-first extraction): unions loop-carry-note walls + needs-human work-items
 * with the liveness join, sorted oldest-wait-first. Exported so the unified
 * `plans:attention` reader can fold the SAME rows into the owner's inbox
 * (`ownerWallToAttention`) without duplicating this SQL/liveness logic — the
 * tool handler below is now a thin wrapper over this function.
 */
export async function listOwnerWalls(opts: ListOwnerWallsOpts = {}): Promise<{
  walls: WallRow[];
  waiting: number;
  stranded: number;
  oldestWaitHours: number | null;
}> {
  const sql = getOrgPg().sql;
  const ws = opts.workspaceId ?? 'default';
  const now = Date.now();
  const limit = opts.limit ?? 50;
  const includeStranded = opts.includeStranded ?? true;

  // ── Liveness: who is still actually there to receive an answer ────────────
  const presence = await sql<Array<{ owner_id: string; last_active_at: Date | null }>>`
    SELECT owner_id, last_active_at
      FROM harness_shared.coord_presence
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
  `;
  const liveness = new Map<string, boolean>();
  for (const p of presence) {
    const lastMs = p.last_active_at ? new Date(p.last_active_at).getTime() : null;
    liveness.set(p.owner_id, lastMs != null && now - lastMs <= LIVE_WITHIN_MS);
  }
  const statusOf = (ownerId: string | null): WallRow['status'] => {
    if (!ownerId) return 'unknown';
    const live = liveness.get(ownerId);
    if (live === undefined) return 'unknown';
    return live ? 'waiting' : 'stranded';
  };

  const walls: WallRow[] = [];

  // ── Source 1: loop carry-note walls (the P-006 owner-gated commitment rows) ──
  const notes = await sql<Array<{ scope: string; note: string | null; updated_ts: Date | null }>>`
    SELECT scope, note, updated_ts
      FROM harness_shared.carry_notes
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND scope LIKE 'loop:%'
       AND note IS NOT NULL
  `;
  for (const row of notes) {
    const parsed = parseLoopScope(row.scope);
    if (!parsed) continue;
    if (opts.harness && parsed.harness !== opts.harness) continue;
    if (opts.ownerId && parsed.ownerId !== opts.ownerId) continue;
    const { walls: entries } = splitCarryNoteWalls(row.note);
    for (const w of entries) {
      const sinceMs = w.sinceMs ?? (row.updated_ts ? new Date(row.updated_ts).getTime() : null);
      walls.push({
        source: 'loop-carry-note',
        ownerId: parsed.ownerId,
        harness: parsed.harness,
        claim: w.claim,
        ...(w.recheck ? { recheck: w.recheck } : {}),
        sinceIso: sinceMs != null ? new Date(sinceMs).toISOString() : null,
        waitingHours: hoursSince(sinceMs, now),
        status: statusOf(parsed.ownerId),
      });
    }
  }

  // ── Source 2: work-items parked in needs-human ───────────────────────────
  const items = await sql<Array<{
    feature_id: string; title: string | null; harness_slug: string | null;
    taken_by: string | null; last_progress_at: Date | null;
  }>>`
    SELECT feature_id, title, harness_slug, taken_by, last_progress_at
      FROM harness_shared.work_items
     WHERE (workspace_id = ${ws} OR workspace_id = 'default')
       AND status = 'needs-human'
       AND (${opts.harness ?? null}::text IS NULL OR harness_slug = ${opts.harness ?? null})
       AND (${opts.ownerId ?? null}::text IS NULL OR taken_by = ${opts.ownerId ?? null})
  `;
  for (const it of items) {
    const sinceMs = it.last_progress_at ? new Date(it.last_progress_at).getTime() : null;
    walls.push({
      source: 'work-item',
      ownerId: it.taken_by,
      harness: it.harness_slug,
      claim: it.title ?? it.feature_id,
      ref: it.feature_id,
      sinceIso: sinceMs != null ? new Date(sinceMs).toISOString() : null,
      waitingHours: hoursSince(sinceMs, now),
      status: statusOf(it.taken_by),
    });
  }

  const filtered = walls
    .filter((w) => (includeStranded ? true : w.status !== 'stranded'))
    .filter((w) => (opts.minHours == null ? true : (w.waitingHours ?? 0) >= opts.minHours))
    .sort((a, b) => (b.waitingHours ?? -1) - (a.waitingHours ?? -1))
    .slice(0, limit);

  return {
    walls: filtered,
    waiting: filtered.filter((w) => w.status === 'waiting').length,
    stranded: filtered.filter((w) => w.status === 'stranded').length,
    oldestWaitHours: filtered.length > 0 ? (filtered[0]!.waitingHours ?? null) : null,
  };
}

export default defineTool({
  name: 'coord:walls',
  description:
    'What is BLOCKED ON THE OWNER right now — every agent parked on a decision, credential, or approval only a human can give. ' +
    'Unions the two surfaces where agents are already required to register owner-gated blockers: loop carry-note walls ' +
    '(loop:checkpoint { walls }) and work-items in needs-human. Each row carries the ask VERBATIM, how long it has been ' +
    'waiting, the re-check command, and — critically — whether the blocked agent is still ALIVE (waiting) or its session ' +
    'has died (stranded: answering will not resume it; it must be respawned). Ordered oldest-wait first.',
  guidance: {
    when:
      'The owner asks "what needs me / what is waiting on me / am I blocking anything", at the top of an owner session, ' +
      'and in any fleet-leader or monitor sweep. Also before you report "all green" — a fleet with a 5h-old owner wall ' +
      'is NOT green, it is stalled on the owner and nobody has told them.',
    notWhen:
      'Who is working on what (coord:presence / fleet:assignments). Blockers between AGENTS — those are peer coordination ' +
      '(coord:send), not owner walls; only a blocker a HUMAN must clear belongs here.',
    chaining:
      'coord:walls → answer the claim (coord:send to the ownerId), then the agent clears it via loop:checkpoint { walls: [...] } ' +
      '(pass the remaining set; [] clears all). A `stranded` row needs a respawn as well as an answer — the waiter is gone.',
    returns:
      '{ ok, count, waiting, stranded, oldestWaitHours, walls: [{ source, ownerId, harness, claim, recheck?, ref?, sinceIso, waitingHours, status }] }. ' +
      'status: waiting = agent alive and parked on you; stranded = its session died (answer AND respawn); unknown = no presence row.',
    seeAlso: ['coord:presence', 'coord:send', 'loop:checkpoint', 'work_items:list'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // EI-20226779878046151: walls reads its own loop/work-item stores and never
  // reads ctx.tx. The orient leader fold must not retain an ambient pool slot.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Only walls under this harness (default: every harness).'),
    ownerId: z.string().max(120).optional().describe('Only walls raised by this agent.'),
    minHours: z
      .number()
      .min(0)
      .max(720)
      .optional()
      .describe('Only walls standing at least this long — e.g. 1 to skip walls raised moments ago.'),
    includeStranded: z
      .boolean()
      .optional()
      .describe('Include walls whose agent is dead (default true). These need a respawn, not just an answer.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  }),
  async handler(args, ctx) {
    // owner-inbox-single-pane P-005b: the union/liveness-join logic now lives in
    // the exported `listOwnerWalls` (reuse-first — `plans:attention` folds the
    // SAME rows into the unified inbox without duplicating this SQL).
    const { walls: filtered, waiting, stranded, oldestWaitHours } = await listOwnerWalls({
      workspaceId: ctx.workspaceId ?? 'default',
      harness: args.harness,
      ownerId: args.ownerId,
      minHours: args.minHours,
      includeStranded: args.includeStranded,
      limit: args.limit,
    });

    // Return a { data } envelope (NOT hand-rolled inline JSON): the framework then
    // compact-encodes the walls array for the agent transport for free, and the
    // tool-data-shape ratchet holds. A new tool has no legacy byte-contract to keep.
    return {
      data: {
        ok: true,
        count: filtered.length,
        waiting,
        stranded,
        oldestWaitHours,
        note:
          filtered.length === 0
            ? 'Nothing is blocked on the owner.'
            : `${filtered.length} owner-gated blocker(s): ${waiting} agent(s) alive and parked on an answer, ` +
              `${stranded} STRANDED (session died — answering alone will not resume them; respawn as well). ` +
              'Answer via coord:send to the ownerId; the agent clears its wall with loop:checkpoint { walls }.',
        walls: filtered,
      },
    };
  },
});
