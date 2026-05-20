/**
 * subscriptions.ts — watch / notify (L3 #5).
 *
 * agent-coordination-architecture-v2 §6.4 (#5). Per-watcher append-
 * only JSONL: each subscribe line declares a pattern + trigger; an
 * unsubscribe line cancels by `related_msg_id`. Active watches are
 * the subscribe lines without a matching unsubscribe and not past
 * their expires_ts.
 *
 * Per-watcher file → one writer per file → no lock.
 *
 * Notifications fire when something matches a pattern. The integration
 * is `fireNotifications(from, paths, trigger)` — any callsite can
 * invoke it (the locks:acquire / plans:add-decision bolt-ons can plant
 * it once they land). Each match appends a typed `notify` envelope to
 * the watcher's outbox in coord/messages/.
 *
 * v1 pattern syntax (deliberate simplification — note in plan §18):
 *   `**` matches anything including `/`
 *   `*`  matches anything except `/`
 *   everything else literal
 * No brace expansion, no `?`. Good enough for common path globs;
 * upgrade to a real glob lib only when a real use case forces it.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  appendCoordLine,
  newMsgId,
  readCoordFile,
  type CoordEnvelope,
  type CoordKind,
} from './envelope';
import {
  outboxFile,
  subscriptionsDir,
  subscriptionsFile,
} from './paths';
import type { AgentIdentity } from './identity';

export type WatchTrigger =
  | 'lock_acquired'
  | 'file_edited'
  | 'plan_referenced'
  | 'any';

export interface WatchInput {
  pattern: string;
  trigger?: WatchTrigger;
  ttl_sec?: number;
}

export interface WatchEntry {
  msg_id: string;
  owner: string;
  pattern: string;
  trigger: WatchTrigger;
  ts: string;
  expires_ts: string | null;
}

/** Add a new watch — appends a subscribe line to the watcher's file. */
export async function addWatch(
  identity: AgentIdentity,
  input: WatchInput,
): Promise<WatchEntry> {
  const expiresMs = input.ttl_sec ? Date.now() + input.ttl_sec * 1000 : null;
  const expiresIso: string | null =
    expiresMs != null ? new Date(expiresMs).toISOString() : null;
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: ['*'],
    kind: 'subscribe',
    pattern: input.pattern,
    trigger: input.trigger ?? 'any',
  };
  if (expiresIso != null) env.expires_ts = expiresIso;
  await appendCoordLine(subscriptionsFile(identity.ownerId), env);
  return {
    msg_id: env.msg_id,
    owner: identity.ownerId,
    pattern: input.pattern,
    trigger: (input.trigger ?? 'any') as WatchTrigger,
    ts: env.ts,
    expires_ts: expiresIso,
  };
}

/** Cancel a watch — appends an unsubscribe line referencing the sub's msg_id. */
export async function removeWatch(
  identity: AgentIdentity,
  subscribeMsgId: string,
): Promise<void> {
  const env: CoordEnvelope = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: ['*'],
    kind: 'unsubscribe',
    related_msg_id: subscribeMsgId,
  };
  await appendCoordLine(subscriptionsFile(identity.ownerId), env);
}

/**
 * List active watches across all watcher files (or one). "Active" =
 * not cancelled by an unsubscribe and not past expires_ts.
 */
export async function listWatches(
  opts: { owner?: string } = {},
): Promise<WatchEntry[]> {
  const dir = subscriptionsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const now = Date.now();
  const subs = new Map<string, WatchEntry>(); // msg_id → entry
  const cancelled = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = await readCoordFile(join(dir, f));
    for (const l of lines) {
      if (opts.owner && l.from !== opts.owner) continue;
      if (l.kind === 'subscribe' && typeof l.pattern === 'string') {
        subs.set(l.msg_id, {
          msg_id: l.msg_id,
          owner: l.from,
          pattern: l.pattern,
          trigger: ((l.trigger as WatchTrigger | undefined) ?? 'any'),
          ts: l.ts,
          expires_ts: typeof l.expires_ts === 'string' ? l.expires_ts : null,
        });
      } else if (l.kind === 'unsubscribe' && l.related_msg_id) {
        cancelled.add(l.related_msg_id);
      }
    }
  }
  const out: WatchEntry[] = [];
  for (const sub of subs.values()) {
    if (cancelled.has(sub.msg_id)) continue;
    if (sub.expires_ts && new Date(sub.expires_ts).getTime() <= now) continue;
    out.push(sub);
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
  return out;
}

/** Convert a v1 path-glob pattern to a regex. See module header for syntax. */
export function patternToRegex(pattern: string): RegExp {
  // Escape regex specials except *
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** first (matches any chars including '/'); then * (matches any non-'/')
  re = re.replace(/\*\*/g, ''); // placeholder
  re = re.replace(/\*/g, '[^/]*');
  re = re.replace(//g, '.*');
  return new RegExp('^' + re + '$');
}

/** True if `path` matches the glob `pattern` (v1 syntax). */
export function matchesPattern(pattern: string, path: string): boolean {
  return patternToRegex(pattern).test(path);
}

export interface WatchMatch {
  watcher: string;
  watch_msg_id: string;
  pattern: string;
  trigger: WatchTrigger;
  matched_path: string;
}

/**
 * Find all (watcher, path) pairs whose active watch matches any of the
 * given paths and accepts the trigger. A watch with trigger='any' is
 * always accepted; otherwise the trigger must match.
 */
export async function findMatchingWatchers(
  paths: string[],
  trigger: WatchTrigger,
): Promise<WatchMatch[]> {
  if (paths.length === 0) return [];
  const watches = await listWatches();
  const out: WatchMatch[] = [];
  for (const w of watches) {
    if (w.trigger !== 'any' && w.trigger !== trigger) continue;
    const re = patternToRegex(w.pattern);
    for (const p of paths) {
      if (re.test(p)) {
        out.push({
          watcher: w.owner,
          watch_msg_id: w.msg_id,
          pattern: w.pattern,
          trigger: w.trigger,
          matched_path: p,
        });
      }
    }
  }
  return out;
}

/**
 * Best-effort: fire `notify` entries into each matching watcher's
 * outbox. The notify is written to the matching watcher's coord/messages/
 * outbox (i.e. the watcher writes a line addressed to itself — same
 * single-writer-per-file invariant as everything else). Returns the
 * number of notifications written. Each individual write try/catches
 * so a single broken outbox cannot drop the rest.
 */
export async function fireNotifications(
  source: AgentIdentity,
  paths: string[],
  trigger: WatchTrigger,
): Promise<number> {
  const matches = await findMatchingWatchers(paths, trigger);
  let written = 0;
  for (const m of matches) {
    const env: CoordEnvelope = {
      ts: new Date().toISOString(),
      msg_id: newMsgId(),
      from: source.ownerId,
      to: [m.watcher],
      kind: 'notify',
      pattern: m.pattern,
      trigger: m.trigger,
      matched_path: m.matched_path,
      watch_msg_id: m.watch_msg_id,
      summary: `notify: ${trigger} matched ${m.matched_path}`,
    };
    try {
      // The watcher's outbox is the receiver — a notify is the only
      // entry kind written into a file that is not the writer's own
      // outbox. We accept that small asymmetry to keep notify delivery
      // synchronous; for a strict one-writer invariant a future
      // refactor could route notifies through coord/notifies/<watcher>.
      await appendCoordLine(outboxFile(m.watcher), env);
      written += 1;
    } catch {
      // best-effort
    }
  }
  return written;
}

/**
 * Coord kinds reachable from this module — for callers that want to
 * narrow `CoordKind` further.
 */
export const SUBSCRIPTION_KINDS: ReadonlyArray<CoordKind> = [
  'subscribe',
  'unsubscribe',
  'notify',
] as const;
