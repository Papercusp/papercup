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
import { resolveHiveHomeSlug } from '../../hive/wake';
import { setLoopCarryNote, renderCarryNote } from '../../carry-note';
import { getLoopStatus } from '../../harness/routines/loop';
import { getPresence } from '../coordination/presence';
import { readInbox } from '../coordination/messages';
import { readWatermark } from '../coordination/watermarks';
import { continuationGateFromReads } from '../coordination/tools/continuation-gate';

export default defineTool({
  name: 'loop:checkpoint',
  profile: 'engineer',
  description:
    "Write (or clear) your su AUTO loop's carry-note — a compressed 'note to my next self' a COLD loop wake " +
    '(reset / recycle) reconstructs its working state from (your transcript does NOT carry across a cold wake). ' +
    'Pass the structured fields { did, left, insight, next } (rendered to the canonical template) OR a raw { note }. ' +
    "Keyed by the loop's ownerId — stable across reset/recycle, so a cold successor reads the SAME note. " +
    'Replace-on-write; blank/null clears. Returns { ok, harness, ownerId, cleared, length }.',
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
      'work_items:checkpoint { id, checkpoint } (a successor INHERITS it) and facts:assert any durable conclusion ' +
      "(folded into every future orient). Pass { note:'' } to clear a stale note.",
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
      ownerId: z
        .string()
        .max(120)
        .optional()
        .describe('The loop owner id (default: your own resolved identity). Mirrors loop:arm/end/status.'),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe('Harness the loop is scoped under (default: your session harness / home hive).'),
    })
    .refine(
      (a) =>
        a.note !== undefined ||
        a.did !== undefined ||
        a.left !== undefined ||
        a.insight !== undefined ||
        a.next !== undefined,
      { message: 'pass { did, left, insight, next } (any) or { note } — nothing to write' },
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
    // EI-7734: the pre-armed-routine fallback is routed through resolveHiveHomeSlug
    // (not a raw `??` chain) so its '*'-skip logic runs — every superuser/operator
    // session sets ctx.harnessSlug='*' (the wildcard sentinel), which would otherwise
    // win this chain outright and scope the carry-note under the literal '*' namespace.
    const harness = armedRoutine?.harnessSlug ?? resolveHiveHomeSlug(args.harness, ctx.harnessSlug);
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
    const note = hasStructured
      ? renderCarryNote({ did: args.did, left: args.left, insight: args.insight, next: args.next })
      : args.note;

    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? undefined;
    const stored = await setLoopCarryNote({ harness, ownerId, workspaceId: workspaceId ?? undefined }, note);

    // flush-to-proceed-stretch-discipline-2026-07-04 P-005: piggyback the CONTINUATION-GATE
    // read on the checkpoint the agent already writes at a unit boundary, so settle-vs-continue
    // is a one-call read (not a separate orient). Two mechanical legs: context headroom (from
    // the cached presence row) and any unread inbox since the last settle. Best-effort — a read
    // failure omits the leg (which the gate treats as blocking ⇒ it recommends settling, never a
    // false "continue"). An unresolvable inbox cursor also stays null (blocking) rather than
    // counting all history as unread.
    let continuation: ReturnType<typeof continuationGateFromReads> | undefined;
    try {
      const pres = await getPresence(ownerId).catch(() => null);
      let unreadInbox: number | null = null;
      try {
        const wm = await readWatermark(ownerId);
        // messages_since_ts advances at turn-END, so this counts messages addressed to you
        // that arrived since your last settle (excludeOwn + non-notify by filterInbox default
        // = real interrupts, not ambient). Empty ('' — never-settled) ⇒ stays null (blocking).
        const sinceTs = wm?.messages_since_ts;
        if (sinceTs) {
          const unread = await readInbox(ownerId, { since_ts: sinceTs, excludeOwn: true });
          unreadInbox = unread.length;
        }
      } catch {
        unreadInbox = null;
      }
      continuation = continuationGateFromReads({
        contextTokens: pres?.contextTokens,
        compactionLimit: pres?.compactionLimit,
        unreadInbox,
      });
    } catch {
      continuation = undefined;
    }

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
            ...(continuation ? { continuation } : {}),
          }),
        },
      ],
    };
  },
});
