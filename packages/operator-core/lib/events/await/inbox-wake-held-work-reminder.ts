/**
 * inbox-wake-held-work-reminder — the DELIVERY-TIME half of the silent-halt fix (WI-6554700010018536,
 * report rpt_24408ef5-04d2-45ca-b56a-27ee3cca8c98 item #3).
 *
 * Measured (WI-6554700010015550): codex su-08effe51, AUTO on, holding two items, was woken by an
 * always-armed `coord:inbox-wake:<owner>`. The wake text ended with the EI-16648 reconcile NOTE
 * ("the quoted message may ALREADY have been surfaced + handled … do NOT re-do handled mail") and
 * said nothing about the work the agent still held. It reconciled the mail, read "mail handled" as
 * "lane done", ended the turn with no loop armed, and took no turn for 4h28m.
 *
 * The turn-end guard (turn-end-held-work-guard.ts) refuses that stop after the fact, on clients
 * whose Stop hook runs it. This module fixes the prompt that invited it: when an inbox-wake is
 * delivered to a session that holds unfinished work-items, the wake text says so, names them, and
 * says that answering the mail does not finish the lane. When that session is also in an autonomy
 * mode with no armed loop, it says that nothing will wake it after this turn.
 *
 * Read at DELIVERY time, not fire time: a held-work list taken when the message was sent goes stale
 * across the fire→delivery gap exactly like the quoted body does. Every read is bounded and every
 * failure degrades to '' — a reminder must never delay or break a wake.
 */
import { getLoopStatus } from '../../harness/routines/loop';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import { readHeldWorkItems, type HeldWorkItem } from './wake-source-predicate';

/** How many held ids the reminder names before summarising the rest. */
export const INBOX_WAKE_HELD_WORK_LISTED_CAP = 5;

/** The whole reminder read must finish inside this budget or it is skipped. */
export const INBOX_WAKE_HELD_WORK_BUDGET_MS = 1500;

/** Everything the reminder depends on, already read. */
export interface InboxWakeHeldWorkFacts {
  /** Non-terminal, non-observation work-items this session holds. */
  held: readonly Pick<HeldWorkItem, 'id'>[];
  /** Registered modes of this session that imply autonomy (auto, cold-auto, drain, goal, grade). */
  autonomyModes: readonly string[];
  /** true = an engine loop is armed; false = none; null = unknown (never claims "no loop"). */
  loopActive: boolean | null;
}

/** The single-line reminder for these facts; '' when the session holds nothing. Pure. */
export function inboxWakeHeldWorkReminderText(f: InboxWakeHeldWorkFacts): string {
  if (f.held.length === 0) return '';
  const ids = f.held.map((h) => h.id);
  const listed =
    ids.slice(0, INBOX_WAKE_HELD_WORK_LISTED_CAP).join(', ') +
    (ids.length > INBOX_WAKE_HELD_WORK_LISTED_CAP ? `, +${ids.length - INBOX_WAKE_HELD_WORK_LISTED_CAP} more` : '');
  const parts = [
    `REMINDER (held work): you still hold ${ids.length} unfinished work-item(s) [${listed}].` +
      ' Answering or reconciling this message does not finish them — after the mail, continue that work.',
  ];
  if (f.autonomyModes.length > 0 && f.loopActive === false) {
    parts.push(
      `You are in ${f.autonomyModes.join('+')} mode with no loop armed, so nothing will wake you after this turn:` +
        ' before you end it, take the next step on a held item, arm a wake (loop:arm, or events:await with' +
        " on_timeout:'wake'), or work_items:checkpoint + work_items:release what you cannot advance.",
    );
  }
  return parts.join(' ');
}

/** IO seams, injectable for tests. */
export interface InboxWakeHeldWorkDeps {
  readHeldWorkItems: (ownerId: string, workspaceId: string) => Promise<HeldWorkItem[]>;
  getModes: (workspaceId: string, ownerId: string) => Promise<Array<{ mode: string }>>;
  getLoopActive: (ownerId: string) => Promise<boolean | null>;
  budgetMs: number;
}

const defaultDeps: InboxWakeHeldWorkDeps = {
  readHeldWorkItems: (ownerId, workspaceId) => readHeldWorkItems(ownerId, workspaceId),
  getModes: (workspaceId, ownerId) => getModes(workspaceId, ownerId),
  getLoopActive: async (ownerId) => {
    const status = await getLoopStatus(ownerId);
    return status ? status.active === true : null;
  },
  budgetMs: INBOX_WAKE_HELD_WORK_BUDGET_MS,
};

/**
 * The reminder for one inbox-wake recipient at delivery time, or ''. Reads held work first (the
 * cheapest exit: most recipients hold nothing). A failed or slow mode/loop read drops only the
 * autonomy sentence, never the held-work one; a failed or slow held-work read yields ''.
 */
export async function prepareInboxWakeHeldWorkReminder(input: {
  ownerId: string;
  workspaceId: string;
  deps?: Partial<InboxWakeHeldWorkDeps>;
}): Promise<string> {
  const deps: InboxWakeHeldWorkDeps = { ...defaultDeps, ...input.deps };
  const { ownerId, workspaceId } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.budgetMs);
  });
  const within = <T>(p: Promise<T>): Promise<T | 'timeout'> => Promise.race([p, timedOut]);
  try {
    const held = await within(deps.readHeldWorkItems(ownerId, workspaceId));
    if (held === 'timeout' || held.length === 0) return '';
    const [modes, loopActive] = await Promise.all([
      within(deps.getModes(workspaceId, ownerId)).catch(() => 'timeout' as const),
      within(deps.getLoopActive(ownerId)).catch(() => 'timeout' as const),
    ]);
    const autonomyModes =
      modes === 'timeout' ? [] : modes.map((row) => row.mode).filter((mode) => modeImpliesAutonomy(mode));
    return inboxWakeHeldWorkReminderText({
      held,
      autonomyModes,
      loopActive: loopActive === 'timeout' ? null : loopActive,
    });
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
