/**
 * loop:checkpoint — the su AUTO loop's CARRY-NOTE write (su-cold-auto-mode-2026-07-03
 * P-002 PRODUCER; the enabled→functional linchpin). The loop analog of
 * work_items:checkpoint: an su loop writes a compressed "note to my next self" that a
 * COLD wake (reset / recycle) reconstructs its working state from, instead of a grown
 * transcript. Keyed by the ownerId the loop wakes (loopScope) — STABLE across a
 * fresh-context RESET and a RECYCLE (PAPERCUSP_SID preserved, P-004), so the cold
 * successor reads the SAME note this warm turn left.
 *
 * WHY THIS EXISTS: without a producer, setLoopCarryNote has no caller, so a cold loop
 * has no anchor and decideColdWake's P-006 guard keeps it WARM forever. This tool is
 * what makes loop:arm{carry:'cold'} actually go cold — the missing half of P-002/P-004
 * (P-002 delivered the substrate; this writes it).
 *
 * SHAPE (the shared D-004 contract): pass the structured fields { did, left, insight,
 * next } (rendered to renderCarryNote's canonical `## Heading` template a cold successor
 * knows how to read) OR a raw { note } string. Replace-on-write; a blank/null note (or
 * all-blank fields) CLEARS. Journaling ON (the loop trajectory ring, like the Queen) —
 * recent wakes' notes survive a clear so a cold successor still sees the trajectory.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePotHomeSlug } from '../../pot/wake';
import {
  getLoopCarryNote,
  normalizeWallEntries,
  renderCarryNote,
  setLoopCarryNote,
  splitCarryNoteWalls,
  withCarryNoteWalls,
  CARRY_NOTE_MAX_WALLS,
} from '../../carry-note';
import { getOrgPg } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { getPresence } from '../coordination/presence';
import { readInbox } from '../coordination/messages';
import { readWatermark } from '../coordination/watermarks';
import { continuationGateFromReads, countPendingInterrupts } from '../coordination/tools/continuation-gate';
import { COORD_READ_TOOL_NAMES } from '../coordination/inbox-read-freshness';
import { provenanceLintField } from '../../carry-surface-provenance-lint';
import { withBoundedTimeout } from '../../bounded-timeout';

/** The continuation hint is advisory; it must never consume the checkpoint
 * tool's 60s transport budget when coordination reads are degraded. */
export const CONTINUATION_READ_BUDGET_MS = 5_000;

/**
 * P-007 (fleet-member-dx-improvements-2026-07-10, EI-9035): the owner's most
 * recent coord:inbox / coord:orient invocation (ISO), or null. The continuation
 * gate's unread-inbox leg previously keyed ONLY off the turn-END watermark
 * (`messages_since_ts`) — a session that never settled one has an empty
 * watermark, so the gate reported "inbox not evaluated" FOREVER, even seconds
 * after the agent literally read its inbox in the same turn. An inbox/orient
 * READ is evaluation: credit it as the unread cursor. Both name forms matched
 * (colon registry name + underscore transport variant). Best-effort: any
 * failure returns null (the gate then fails safe toward settling, as before).
 */
/** P-007 pure cursor pick: the LATER of the turn-END settle watermark and the
 *  owner's last inbox READ — either alone counts; neither ⇒ null (the gate then
 *  blocks, fail-safe toward settling). ISO strings compare lexicographically. */
export function pickUnreadCursor(
  wmTs: string | null | undefined,
  readTs: string | null | undefined,
): string | null {
  const a = wmTs || null;
  const b = readTs || null;
  if (a && b) return b > a ? b : a;
  return b ?? a;
}

export async function lastInboxReadAt(ownerId: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ invoked_at: string | Date }[]>`
      SELECT invoked_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${ownerId}
         AND tool_name = ANY(${[...COORD_READ_TOOL_NAMES]})
       ORDER BY invoked_at DESC
       LIMIT 1
    `;
    const v = rows[0]?.invoked_at;
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'loop:checkpoint',
  profile: 'engineer',
  description:
    "Write (or clear) your su AUTO loop's carry-note — a compressed 'note to my next self' a COLD loop wake " +
    '(reset / recycle) reconstructs its working state from (your transcript does NOT carry across a cold wake). ' +
    'Pass the structured fields { did, left, insight, next } (rendered to the canonical template) OR a raw { note }. ' +
    "Keyed by the loop's ownerId — stable across reset/recycle, so a cold successor reads the SAME note. " +
    'Replace-on-write; blank/null clears — except { walls } rows (owner-gated commitments): they render into ' +
    'every wake until you pass walls:[]. Returns { ok, harness, ownerId, cleared, length, walls }.',
  guidance: {
    when:
      "Before you end a turn on a COLD loop (carry:'cold'): persist what the next cold wake needs to continue — " +
      'what you did, what is left, the key non-obvious insight, and the single next action. Keep it COMPRESSED ' +
      '(facts, not a transcript). Until the first checkpoint exists a cold loop silently stays WARM (the P-006 ' +
      'no-anchor guard), and a cold loop that stops checkpointing keeps restarting from a stale note.',
    notWhen:
      "A WARM loop (carry:'warm', the default) carries its live transcript across wakes and needs no carry-note. " +
      'Not for work-item state — that is work_items:checkpoint.',
    chaining:
      "loop:checkpoint { did, left, insight, next } as the last step before ending a cold-loop turn — but it is " +
      'the WEAKEST continuity write: the carry-note is LOST if your session dies. So also refresh ' +
      'work_items:checkpoint { id, checkpoint } (a successor INHERITS it) and facts:assert any durable conclusion.',
    seeAlso: [
      "loop:arm (arm the loop; carry:'cold' opts into the cold lifecycle)",
      'loop:status (inspect the loop, incl. carry mode)',
      'work_items:checkpoint (the work-item-scoped analog)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      note: z
        .string()
        .max(32000)
        .nullish()
        .describe('Raw carry-note text; blank/null ⇒ clear. Ignored when any of did/left/insight/next is set.'),
      did: z.string().max(8000).optional().describe('What this wake accomplished (concrete progress).'),
      left: z.string().max(8000).optional().describe('What remains, in order.'),
      insight: z
        .string()
        .max(8000)
        .optional()
        .describe('The non-obvious thing a cold successor would waste time re-deriving.'),
      next: z.string().max(8000).optional().describe('The single concrete next action for the next wake.'),
      walls: z
        .array(
          z.object({
            claim: z.string().min(1).max(500).describe('The pending owner-gated action/decision, stated concretely.'),
            recheck: z.string().max(300).optional().describe('A concrete command a successor runs to re-check it.'),
          }),
        )
        .max(CARRY_NOTE_MAX_WALLS)
        .optional()
        .describe(
          'Open WALLS (owner-gated commitments) as rows — rendered into EVERY wake + carry brief until cleared. ' +
            'OMITTED ⇒ existing walls CARRY FORWARD (a rewrite or note-clear never drops them); pass the full ' +
            'current set to change it; [] clears.',
        ),
      ownerId: z
        .string()
        .max(120)
        .optional()
        .describe('The loop owner id (default: your own resolved identity). Mirrors loop:arm/end/status.'),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe('Harness the loop is scoped under (default: your session harness / home pot).'),
    })
    .refine(
      (a) =>
        a.note !== undefined ||
        a.did !== undefined ||
        a.left !== undefined ||
        a.insight !== undefined ||
        a.next !== undefined ||
        a.walls !== undefined,
      { message: 'pass { did, left, insight, next } (any), { note }, or { walls } — nothing to write' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    // WI-2148: the carry-note scope key MUST match what the cold-wake READER resolves —
    // and the reader gets `harness` from the ColdLoopMarker the FIRE stamped on the wake
    // payload, which is the ARMED ROUTINE's fixed `install_slug` (loop.ts's getLoopStatus),
    // NOT the checkpointing session's own ctx.harnessSlug. Those two can legitimately
    // differ wake-to-wake for the SAME loop (observed live: wakes 1-3 wrote
    // 'loop:*:<owner>', wake-4 wrote 'loop:papercusp:<owner>' because ctx.harnessSlug
    // resolved differently across wakes) — writing under the session's transient harness
    // instead of the routine's fixed one creates a SECOND, stale-diverging carry_notes row;
    // a cold reset that resolves the note by the routine's install_slug then reads whichever
    // row is stale. Resolve from the armed routine FIRST (the single source of truth the
    // reader also uses); only fall back to the old session-context chain when no routine is
    // armed yet (e.g. a checkpoint written before the first loop:arm — an edge case, since
    // loop:checkpoint's whole purpose assumes an armed loop already exists).
    const armedRoutine = await getLoopStatus(ownerId).catch(() => null);
    // EI-7734: the pre-armed-routine fallback is routed through resolvePotHomeSlug
    // (not a raw `??` chain) so its '*'-skip logic runs — every superuser/operator
    // session sets ctx.harnessSlug='*' (the wildcard sentinel), which would otherwise
    // win this chain outright and scope the carry-note under the literal '*' namespace.
    const harness = armedRoutine?.harnessSlug ?? resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_harness',
              message:
                'Pass `harness` — your session is not scoped to a harness and no home hive is set, so the loop carry-note has nowhere to live.',
            }),
          },
        ],
        isError: true,
      };
    }

    const hasStructured =
      args.did !== undefined || args.left !== undefined || args.insight !== undefined || args.next !== undefined;
    // Structured fields win over a raw note (renderCarryNote skips blank sections, so an
    // all-blank structured write renders '' ⇒ a clear). Otherwise the raw note verbatim.
    const baseNote = hasStructured
      ? renderCarryNote({ did: args.did, left: args.left, insight: args.insight, next: args.next })
      : args.note;

    // P-006 walls merge — commitments are cleared EXPLICITLY, never incidentally:
    //   explicit `walls` wins (its [] is the only true clear); a raw note's own
    //   `## Walls` rows win next; otherwise the PRIOR walls carry forward — across
    //   rewrites AND across a note clear (the note then survives as walls-only).
    //   A walls-only write likewise carries the prior note body forward.
    const prior = await getLoopCarryNote({ harness, ownerId }).catch(() => null);
    const priorParts = splitCarryNoteWalls(prior);
    const rawParts = splitCarryNoteWalls(baseNote ?? '');
    const walls =
      args.walls !== undefined
        ? normalizeWallEntries(args.walls, priorParts.walls)
        : rawParts.walls.length > 0
          ? normalizeWallEntries(rawParts.walls, priorParts.walls)
          : priorParts.walls;
    const hasNoteWrite = hasStructured || args.note !== undefined;
    const note = withCarryNoteWalls(hasNoteWrite ? rawParts.body : priorParts.body, walls);

    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? undefined;
    const stored = await setLoopCarryNote({ harness, ownerId, workspaceId: workspaceId ?? undefined }, note);

    // P-020 (su-ideate-learning-substrate): checkpoint-HARVEST. The carry-note `insight`
    // is exactly the "non-obvious thing a future agent would re-derive" the observation
    // lane wants — auto-file it as a lane:observation with ZERO new workflow (D-016/D-017).
    // Fire-and-forget + fully fail-open: a harvest miss must NEVER slow or break the
    // checkpoint write (the same discipline as the SSE-invalidate in capture-core). The
    // leg self-coalesces the verbatim carry-note that persists across consecutive wakes.
    if (args.insight && args.insight.trim()) {
      const insightText = args.insight;
      const harvestHarness = harness !== '*' ? harness : undefined;
      void (async () => {
        try {
          const filedByRole = (await getPresence(ownerId).catch(() => null))?.agentRole ?? undefined;
          const { harvestInsight } = await import('../../harness/improvements/checkpoint-harvest');
          await harvestInsight({
            insight: insightText,
            createdBy: ownerId,
            source: 'loop-checkpoint',
            ref: 'loop:checkpoint',
            ...(filedByRole ? { filedByRole } : {}),
            ...(harvestHarness ? { harness: harvestHarness, sourceHive: harvestHarness } : {}),
          });
        } catch {
          /* fail-open: harvest never affects the checkpoint the agent asked for */
        }
      })();
    }

    // flush-to-proceed-stretch-discipline-2026-07-04 P-005: piggyback the CONTINUATION-GATE
    // read on the checkpoint the agent already writes at a unit boundary, so settle-vs-continue
    // is a one-call read (not a separate orient). Two mechanical legs: context headroom (from
    // the cached presence row) and any unread inbox since the last settle. Best-effort — a read
    // failure omits the leg (which the gate treats as blocking ⇒ it recommends settling, never a
    // false "continue"). An unresolvable inbox cursor also stays null (blocking) rather than
    // counting all history as unread.
    const continuationRead = await withBoundedTimeout(
      async () => {
        const pres = await getPresence(ownerId).catch(() => null);
        let unreadInbox: number | null = null;
        try {
          const wm = await readWatermark(ownerId);
        // messages_since_ts advances at turn-END, so this counts messages addressed to you
        // that arrived since your last settle. filterInbox (inside readInbox) drops own +
        // notify-kind rows; countPendingInterrupts then drops system machinery — categorized
        // broadcasts, `auto` lifecycle chatter, intent declares — because WI-4179 showed the
        // raw count reads a watchdog burst (16 identical severe-event-resolved rows in one
        // 300ms window) as "16 unread ⇒ pending owner input" and closes the gate while
        // coord:inbox/orient show nothing pending.
        // P-007 (fleet-member-dx, EI-9035): ALSO credit the owner's last coord:inbox/
        // coord:orient READ — use the LATER of the two cursors. A never-settled session
        // ('' watermark) that just read its inbox no longer gets a false, permanent
        // "inbox not evaluated"; and a mid-turn read after the last settle correctly
        // narrows "unread" to what arrived AFTER that read. Neither cursor available ⇒
        // stays null (blocking — fail safe toward settling, unchanged).
          const readTs = await lastInboxReadAt(ownerId);
          const sinceTs = pickUnreadCursor(wm?.messages_since_ts, readTs);
          if (sinceTs) {
            const unread = await readInbox(ownerId, { since_ts: sinceTs, excludeOwn: true });
            unreadInbox = countPendingInterrupts(unread);
          }
        } catch {
          unreadInbox = null;
        }
        return continuationGateFromReads({
          contextTokens: pres?.contextTokens,
          compactionLimit: pres?.compactionLimit,
          unreadInbox,
        });
      },
      {
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint continuation reads',
      },
    );
    const continuation = continuationRead.value;

    // WI-3801: warn-only nudge — undefined (no field) on a clean/cleared write.
    const provenanceLint = stored !== null ? provenanceLintField(stored) : undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness,
            ownerId,
            cleared: stored === null,
            length: stored?.length ?? 0,
            walls: walls.length,
            ...(continuation ? { continuation } : {}),
            ...(provenanceLint ? { provenanceLint } : {}),
          }),
        },
      ],
    };
  },
});
