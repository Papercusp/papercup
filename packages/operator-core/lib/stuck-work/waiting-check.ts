/**
 * Waiting check (stuck-work-detection-and-honest-waits-2026-11-13 P-002, bar R-2).
 *
 * Replaces the in-memory, log-only never-fires detector in
 * `../events/await/timeout-fallback.ts` (`recordTimeoutFires`, which reset on every
 * operator restart and only ever wrote a log line — EI-28703701301066960) with a
 * check that reads the waits table itself, so its counts survive a restart, and
 * raises a durable notice instead of a log line.
 *
 * The rule, from the 30-day replay (report rpt_da190e97-395f-4edc-be36-b5baa32a3be0):
 *   a signal waited on for >= 4 hours, with >= 3 missed alarms and no result since
 *   the episode began, raises ONE notice per item behind the signal; the notice
 *   repeats once at 24 hours if the wait is still unresolved. The two routine
 *   shared signals (commit sync and shared-resource release) are excluded — 93 of
 *   their 98 replay flags resolved by themselves.
 *
 * "Result" here is an `event` fire on the key: something an agent cannot produce
 * by writing about its work. A timeout (missed alarm) is not a result.
 *
 * Nothing in this module reads an agent-written note, estimate or field (bar R-1):
 * its inputs are the waits table, announcement rows and the work-item row.
 *
 * Layout: pure evaluation (`evaluateWaitingCheck`) + a deps-injected runner
 * (`runWaitingCheck`) so both unit-test without Postgres; the production adapters
 * live in `./waiting-check-adapters.ts`.
 */

/** Waited at least this long (since the episode's first wait) before a flag. */
export const WAIT_THRESHOLD_MS = 4 * 60 * 60 * 1000;
/** At least this many missed alarms (timeout fires) in the episode. */
export const MISSED_ALARM_THRESHOLD = 3;
/** A still-unresolved flag repeats exactly once, this long after the first notice. */
export const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;
/** An episode with no wait created, fired or still live in this window is over (nobody is waiting). */
export const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** How far back the loader reads the waits table. */
export const LOOKBACK_DAYS = 14;

/** The two routine shared signals many agents wait on, which resolve by themselves. */
export const ROUTINE_SHARED_SIGNAL_PREFIXES = ['git-sync:committed', 'resource:released:git-sync'] as const;
/** Self-wakes that are not waits on another party's work (the replay excluded them too). */
export const SELF_WAKE_PREFIXES = ['coord:inbox-wake:', 'turn-end:rewake:'] as const;

/** Condition-key namespace for the durable notice (one open item per group). */
export const STUCK_WAIT_CONDITION_PREFIX = 'stuck-wait:';

export function isExcludedWaitKey(eventKey: string): boolean {
  return (
    ROUTINE_SHARED_SIGNAL_PREFIXES.some((p) => eventKey === p || eventKey.startsWith(`${p}:`)) ||
    SELF_WAKE_PREFIXES.some((p) => eventKey.startsWith(p))
  );
}

/** SQL `LIKE` patterns for the exclusion, so the loader filters at the source. */
export function excludedWaitKeyLikePatterns(): string[] {
  return [
    ...ROUTINE_SHARED_SIGNAL_PREFIXES.flatMap((p) => [p, `${p}:%`]),
    ...SELF_WAKE_PREFIXES.map((p) => `${p}%`),
  ];
}

const WORK_ITEM_KEY = /^work-item:(?:done|status|unblocked|settled|terminal):((?:WI|EI|F)-\d+)(?::.*)?$/;

/** A `work-item:<verb>:<id>` key names its item directly. */
export function workItemIdFromKey(eventKey: string): string | null {
  return WORK_ITEM_KEY.exec(eventKey)?.[1] ?? null;
}

/** The plan slug named in a `plan:<slug>:<...>` key (announced plan gates). */
export function planSlugFromKey(eventKey: string): string | null {
  const m = /^plan:([^:]+):.+$/.exec(eventKey);
  return m && m[1] !== 'acceptance' ? m[1] : null;
}

/** One key's current waiting episode, as read from the waits table. */
export interface WaitKeyStats {
  eventKey: string;
  /** First wait created after the key's last result (episode start). */
  firstWaitAtMs: number;
  /** Timeout fires in the episode. */
  missedAlarms: number;
  /** Distinct subscribers waiting in the episode. */
  waiters: string[];
  /** Latest wait created / fired in the episode, or now if one is still live. */
  lastActivityAtMs: number;
  workspaceId: string;
}

/** The item a key resolves to, with the fields needed to pick a recipient. */
export interface ResolvedItem {
  id: string;
  harness: string | null;
  assignee: string | null;
  status: string;
}

export interface KeyResolution {
  item: ResolvedItem | null;
  /** The announcement's declarer, when the key was announced. */
  declarer: string | null;
}

/** Durable notice state already on record for a group (from its condition item). */
export interface ExistingNotice {
  conditionItemId: string;
  firstNoticeAtMs: number;
  repeatSentAtMs: number | null;
}

export type WaitingAction = 'first-notice' | 'repeat-notice' | 'none';

export interface WaitingFlag {
  groupKey: string;
  conditionKey: string;
  workspaceId: string;
  item: ResolvedItem | null;
  declarer: string | null;
  keys: string[];
  missedAlarms: number;
  waiters: string[];
  firstWaitAtMs: number;
  /** Who the notice goes to: the item's assignee, else the declarer, else the owner. */
  recipient: string;
  action: WaitingAction;
}

/** Whether one key's episode meets the rule at `nowMs`. */
export function keyQualifies(stats: WaitKeyStats, nowMs: number): boolean {
  if (isExcludedWaitKey(stats.eventKey)) return false;
  if (stats.missedAlarms < MISSED_ALARM_THRESHOLD) return false;
  if (nowMs - stats.firstWaitAtMs < WAIT_THRESHOLD_MS) return false;
  return nowMs - stats.lastActivityAtMs <= ACTIVE_WINDOW_MS;
}

/** One group per blocked item; a key that resolves to no item is its own group. */
export function groupKeyFor(eventKey: string, resolution: KeyResolution | undefined): string {
  return resolution?.item ? `item:${resolution.item.id}` : `key:${eventKey}`;
}

function recipientFor(item: ResolvedItem | null, declarer: string | null): string {
  return item?.assignee || declarer || 'human';
}

/**
 * Pure rule evaluation. Groups qualifying keys by the item behind them and decides,
 * against the durable notice state, whether this run sends the first notice, the
 * single 24-hour repeat, or nothing. Re-running with the state a previous run
 * wrote never produces a second first-notice (restart-safe by construction).
 */
export function evaluateWaitingCheck(input: {
  stats: WaitKeyStats[];
  resolutions: Map<string, KeyResolution>;
  existing: Map<string, ExistingNotice>;
  nowMs: number;
}): WaitingFlag[] {
  const groups = new Map<string, WaitingFlag>();
  for (const s of input.stats) {
    if (!keyQualifies(s, input.nowMs)) continue;
    const resolution = input.resolutions.get(s.eventKey);
    const groupKey = groupKeyFor(s.eventKey, resolution);
    const prior = groups.get(groupKey);
    if (prior) {
      prior.keys.push(s.eventKey);
      prior.missedAlarms += s.missedAlarms;
      prior.waiters = [...new Set([...prior.waiters, ...s.waiters])].sort();
      prior.firstWaitAtMs = Math.min(prior.firstWaitAtMs, s.firstWaitAtMs);
      prior.declarer ??= resolution?.declarer ?? null;
      prior.recipient = recipientFor(prior.item, prior.declarer);
      continue;
    }
    const item = resolution?.item ?? null;
    const declarer = resolution?.declarer ?? null;
    groups.set(groupKey, {
      groupKey,
      conditionKey: `${STUCK_WAIT_CONDITION_PREFIX}${groupKey}`,
      workspaceId: s.workspaceId,
      item,
      declarer,
      keys: [s.eventKey],
      missedAlarms: s.missedAlarms,
      waiters: [...new Set(s.waiters)].sort(),
      firstWaitAtMs: s.firstWaitAtMs,
      recipient: recipientFor(item, declarer),
      action: 'none',
    });
  }
  for (const flag of groups.values()) {
    const prior = input.existing.get(flag.conditionKey);
    if (!prior) flag.action = 'first-notice';
    else if (prior.repeatSentAtMs == null && input.nowMs - prior.firstNoticeAtMs >= REPEAT_AFTER_MS) {
      flag.action = 'repeat-notice';
    }
  }
  return [...groups.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

/** The notice text: what is stuck, the evidence, and the one thing to do. */
export function waitingNoticeText(flag: WaitingFlag, nowMs: number): { title: string; summary: string } {
  const hours = Math.floor((nowMs - flag.firstWaitAtMs) / 3_600_000);
  const subject = flag.item
    ? `${flag.item.id} (${flag.item.status}, ${flag.item.assignee ? `assigned to ${flag.item.assignee}` : 'nobody assigned'})`
    : `signal ${flag.keys[0]}`;
  const title = `Stuck wait: ${flag.waiters.length} agent(s) missed ${flag.missedAlarms} alarms over ${hours}h waiting on ${subject}`;
  const next = flag.item
    ? flag.item.assignee
      ? `Deliver ${flag.item.id} or tell its waiters it will not arrive.`
      : `Reassign or drop ${flag.item.id}; its waiters will be told once.`
    : flag.declarer
      ? `Fire ${flag.keys[0]} or cancel its announcement so waiters stop polling.`
      : `Decide whether anyone still needs ${flag.keys[0]}.`;
  const summary = [
    flag.action === 'repeat-notice' ? 'Still unresolved 24 hours after the first notice.' : 'Waiting check flag.',
    `Waited ${hours}h with ${flag.missedAlarms} missed alarms and no result.`,
    `Signals: ${flag.keys.join(', ')}.`,
    `Waiters: ${flag.waiters.join(', ')}.`,
    `Next: ${next}`,
  ].join('\n');
  return { title, summary };
}

export interface WaitingCheckDeps {
  nowMs(): number;
  loadStats(): Promise<WaitKeyStats[]>;
  resolveKeys(stats: WaitKeyStats[]): Promise<Map<string, KeyResolution>>;
  loadExisting(conditionKeys: string[]): Promise<Map<string, ExistingNotice>>;
  /** File-or-adopt the condition item; returns its id and whether it was created. */
  upsertNotice(flag: WaitingFlag, text: { title: string; summary: string }): Promise<{ id: string | null; created: boolean }>;
  /** Atomically stamp the repeat once; false when another run already stamped it. */
  markRepeatSent(conditionItemId: string, atMs: number): Promise<boolean>;
  /** Deliver the notice message to the recipient. */
  notify(flag: WaitingFlag, text: { title: string; summary: string }, conditionItemId: string | null): Promise<void>;
  /**
   * The notice switch (flag `papercusp-stuck-work-notices`, plan D-003). `false` = silent
   * run: every flag is still computed and returned, but no notice item is filed, no repeat
   * is stamped and no message is sent. Omitted = notices on.
   */
  noticesEnabled?: boolean;
  log?(line: string): void;
}

export interface WaitingCheckResult {
  flags: number;
  firstNotices: number;
  repeatNotices: number;
  /** True when the notice switch was off: flags were recorded, nothing was sent. */
  silent: boolean;
  flagged: WaitingFlag[];
}

/** One sweep: load, evaluate, and act on each flag exactly once. */
export async function runWaitingCheck(deps: WaitingCheckDeps): Promise<WaitingCheckResult> {
  const nowMs = deps.nowMs();
  const stats = await deps.loadStats();
  const qualifying = stats.filter((s) => keyQualifies(s, nowMs));
  const resolutions = await deps.resolveKeys(qualifying);
  const conditionKeys = [
    ...new Set(
      qualifying.map((s) => `${STUCK_WAIT_CONDITION_PREFIX}${groupKeyFor(s.eventKey, resolutions.get(s.eventKey))}`),
    ),
  ];
  const existing = await deps.loadExisting(conditionKeys);
  const flagged = evaluateWaitingCheck({ stats: qualifying, resolutions, existing, nowMs });
  if (deps.noticesEnabled === false) {
    return { flags: flagged.length, firstNotices: 0, repeatNotices: 0, silent: true, flagged };
  }
  let firstNotices = 0;
  let repeatNotices = 0;
  for (const flag of flagged) {
    if (flag.action === 'none') continue;
    const text = waitingNoticeText(flag, nowMs);
    try {
      if (flag.action === 'first-notice') {
        const res = await deps.upsertNotice(flag, text);
        // Adopted an incumbent another run filed: that run owns the message.
        if (!res.created) continue;
        await deps.notify(flag, text, res.id);
        firstNotices += 1;
      } else {
        const prior = existing.get(flag.conditionKey);
        if (!prior || !(await deps.markRepeatSent(prior.conditionItemId, nowMs))) continue;
        await deps.notify(flag, text, prior.conditionItemId);
        repeatNotices += 1;
      }
    } catch (e) {
      deps.log?.(`waiting-check: ${flag.conditionKey} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { flags: flagged.length, firstNotices, repeatNotices, silent: false, flagged };
}
