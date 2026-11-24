/**
 * What a close does next for a fleet member: it hands the member its next item, and starts that
 * item on a fresh context.
 *
 * A member's work is a loop of single items. Each turn of that loop used to cost the member two
 * calls it had no decision to make in (the close, then the pull), and every item was built on top
 * of the conversation of every item before it, so the prompt a member re-read on each call grew
 * with the number of items it had closed. Now the close makes the pull itself, through the same
 * `scheduler:get_next` door the member's own call takes (its own invocation row, gates and claim
 * spec, so the pull ledger and the fleet watchdog see it as they see any pull), and then asks the
 * host for a carry at the item boundary (session/request-compaction.ts), so the next item starts
 * on the session's launch prompt and nothing else.
 *
 * `handNext: false` on the close turns both off for that call. Left out, a fleet MEMBER is handed
 * its next item and nobody else is: a leader's or a lone session's close is not a step in a pull
 * loop. `handNext: true` asks for the pull outright.
 *
 * Nothing here can fail a close. The close has landed before any of this runs, and every failure
 * below becomes a line in the hand-off telling the caller what to do instead.
 */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ItemBoundaryCarry, ItemBoundaryCarryOutcome } from '../session/request-compaction';

/** The item text a hand-off or a boundary note quotes; the rest is one `work_items:get` away. */
export const HAND_OFF_SUMMARY_CAP = 6_000;
/** A pull's refusal, quoted. Its text can run to a page of repair advice the caller does not need here. */
const HAND_OFF_REASON_CAP = 400;
/** Why no carry was asked for when FRESH_CONTEXT_AT_ITEM_CLOSE is off. Never shown to the caller. */
const CONTEXT_KEPT_BY_DESIGN = 'fresh_context_switched_off';

/** The `next` a close reports. Absent when the close made no hand-off attempt at all. */
export interface CloseHandOff {
  /** True when this close claimed the caller's next item. */
  handed: boolean;
  workItem?: { id: string; title?: string; summary?: string };
  /** What the caller already holds, when that is why the pull claimed nothing more. */
  held?: string[];
  /** Why nothing was handed, in the pull's own words. */
  reason?: string;
  /** The pull reported the caller's lane finished. */
  windDown?: true;
  /** `queued`: the handed item starts on a fresh context once this turn ends. */
  freshContext?: 'queued';
  /** Why the context was kept, when a renewal was asked for and refused. */
  freshContextRefused?: string;
  /** What the caller does now. */
  instruction: string;
}

export interface CloseHandOffInput {
  ctx: UnifiedToolContext;
  ownerId: string;
  workspaceId: string | null | undefined;
  /** The close's own `handNext` argument. */
  handNext: boolean | undefined;
  /** The items this call closed: terminal, landed, and not a preflight or a record-only call. */
  closedIds: readonly string[];
  /** False when any item of the call failed: the caller has that to deal with first. */
  everyResultOk: boolean;
}

export interface CloseHandOffDeps {
  isFleetMember: (workspaceId: string, ownerId: string) => Promise<boolean>;
  /** FRESH_CONTEXT_AT_ITEM_CLOSE: off keeps the hand-off and the caller's context. */
  freshContextOn: (ownerId: string) => Promise<boolean>;
  requestCarry: (ctx: UnifiedToolContext, boundary: ItemBoundaryCarry) => Promise<ItemBoundaryCarryOutcome>;
}

const DEFAULT_DEPS: CloseHandOffDeps = {
  async freshContextOn(ownerId) {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    // An unreadable flag store keeps the default, which is on.
    return getFlag(FLAGS.FRESH_CONTEXT_AT_ITEM_CLOSE, ownerId).catch(() => true);
  },
  async isFleetMember(workspaceId, ownerId) {
    // The pinned environment answers for a session whose tool calls run in its own process; the
    // membership ledger answers for one served over HTTP, where the process is the operator's.
    const { deriveFleetMembership } = await import('../coordination/identity');
    const pinned = deriveFleetMembership();
    if (pinned.fleetSlug) return pinned.fleetRole === 'member';
    const { latestFleetMembership } = await import('../../fleet-membership-store');
    const latest = await latestFleetMembership(workspaceId, ownerId);
    return Boolean(latest?.fleetSlug) && latest?.fleetRole === 'member';
  },
  async requestCarry(ctx, boundary) {
    const { requestItemBoundaryCarry } = await import('../session/request-compaction');
    return requestItemBoundaryCarry(ctx, boundary);
  },
};

/** The pull's payload, from whichever form the dispatcher returned it in. */
function pullPayload(result: { content?: ReadonlyArray<unknown>; structuredContent?: unknown }): Record<string, unknown> | null {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured as Record<string, unknown>;
  for (const block of result.content ?? []) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* an advisory line, not the payload */
    }
  }
  return null;
}

function clip(text: string, cap: number, tail: string): string {
  return text.length > cap ? text.slice(0, cap) + tail : text;
}

/** The successor's first prompt at an item boundary: all it is told of what came before. */
export function itemBoundaryNote(closedIds: readonly string[], item: { id: string; title?: string; summary?: string }): string {
  return [
    `Your context was renewed at a work-item boundary. You closed ${closedIds.join(', ')}, and nothing of that ` +
      'conversation was carried over; what you built is in the working tree.',
    `You hold ${item.id}${item.title ? `: ${item.title}` : ''}. It is already claimed for you, so do not orient again ` +
      'and do not pull an item. Build it with its tests and close it with work_items:complete, as your instructions ' +
      'describe; that close hands you your next item. Change files with Edit and Write only: a shell write into ' +
      'the folder is refused.',
    ...(item.summary
      ? [
          'The item, as its record states it:',
          clip(item.summary, HAND_OFF_SUMMARY_CAP, '\n[cut short here: read the rest with work_items:get]'),
        ]
      : []),
    `If you need more of the record than this, read it with work_items:get. If the record shows ${item.id} is closed ` +
      'or is no longer yours, pull with scheduler:get_next instead.',
  ].join('\n\n');
}

export async function handNextAfterClose(
  input: CloseHandOffInput,
  deps: CloseHandOffDeps = DEFAULT_DEPS,
): Promise<CloseHandOff | null> {
  const { ctx, handNext, closedIds } = input;
  if (handNext === false || closedIds.length === 0 || !input.everyResultOk) return null;
  const pullYourself = 'Pull your next item with scheduler:get_next.';
  // Only a transport with a server-side dispatcher can make the pull through the pull's own door.
  if (!ctx.dispatchTool) {
    return handNext === true
      ? { handed: false, reason: 'this transport cannot make the pull for you', instruction: pullYourself }
      : null;
  }
  if (handNext === undefined) {
    // A script closing items in a loop reads results, not instructions: it is handed nothing unasked.
    if (ctx.codeMode === true) return null;
    try {
      if (!(await deps.isFleetMember(input.workspaceId?.trim() || 'default', input.ownerId))) return null;
    } catch {
      return null; // membership unreadable: the caller's own pull still works
    }
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = pullPayload(await ctx.dispatchTool('scheduler:get_next', {}));
  } catch (error) {
    return {
      handed: false,
      reason: clip(error instanceof Error ? error.message : String(error), HAND_OFF_REASON_CAP, '…'),
      instruction: pullYourself,
    };
  }
  const row = payload?.workItem as { id?: unknown; title?: unknown; summary?: unknown } | null | undefined;
  if (!payload || typeof row?.id !== 'string' || !row.id) {
    // The caller is at its claim cap: a repeat of a close that already handed an item, or a pull the
    // caller made alongside its close. It has its next item; the context it is working in is kept.
    const diagnosis = payload?.diagnosis as { concurrencyBlocked?: unknown; heldIds?: unknown } | null | undefined;
    const held = diagnosis?.concurrencyBlocked === true && Array.isArray(diagnosis.heldIds)
      ? diagnosis.heldIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (held.length > 0) {
      return {
        handed: false,
        held,
        instruction: `You already hold ${held.join(', ')}: build that next. Do not call scheduler:get_next.`,
      };
    }
    const said = [payload?.error, payload?.reason].find((value): value is string => typeof value === 'string' && value.length > 0);
    const windDown = payload?.windDown === true;
    return {
      handed: false,
      ...(said ? { reason: clip(said, HAND_OFF_REASON_CAP, '… [scheduler:get_next gives the whole of it]') } : {}),
      ...(windDown ? { windDown } : {}),
      instruction: windDown
        ? 'Nothing was handed to you and your lane is finished: end your turn.'
        : payload
          ? 'Nothing was handed to you. Call scheduler:get_next for the whole reason before you end your turn.'
          : pullYourself,
    };
  }
  const item = {
    id: row.id,
    ...(typeof row.title === 'string' && row.title ? { title: row.title } : {}),
    ...(typeof row.summary === 'string' && row.summary ? { summary: row.summary } : {}),
  };
  let carry: ItemBoundaryCarryOutcome;
  try {
    carry = (await deps.freshContextOn(input.ownerId))
      ? await deps.requestCarry(ctx, { note: itemBoundaryNote(closedIds, item) })
      : { queued: false, error: CONTEXT_KEPT_BY_DESIGN };
  } catch (error) {
    carry = { queued: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (carry.queued) {
    // The summary is left out: this context is about to be dropped, and the fresh one is given it.
    return {
      handed: true,
      workItem: { id: item.id, ...(item.title ? { title: item.title } : {}) },
      freshContext: 'queued',
      instruction:
        `You hold ${item.id}. End this turn now, with no further tool call: your context is renewed when the turn ` +
        `ends, and ${item.id} is given to you in full on the fresh one. Do not start it in this turn.`,
    };
  }
  return {
    handed: true,
    workItem: {
      ...item,
      ...(item.summary
        ? { summary: clip(item.summary, HAND_OFF_SUMMARY_CAP, '\n[cut short here: read the rest with work_items:get]') }
        : {}),
    },
    // A session that is not on an outside plan, or one whose install has the fresh context
    // switched off, keeps its context by design; that is not a refusal.
    ...(carry.error && carry.error !== 'not_on_an_outside_plan' && carry.error !== CONTEXT_KEPT_BY_DESIGN
      ? { freshContextRefused: carry.error }
      : {}),
    instruction: `You hold ${item.id}: build it next. Do not call scheduler:get_next; this close made that pull for you.`,
  };
}
