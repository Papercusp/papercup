/**
 * session-compacted-events — bridge a completed /compact to the await primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-103).
 *
 * When a psu session finishes a compaction (the WI-1804 warm post-compaction turn),
 * fire an awaitable key so a peer can
 *
 *   events:await { event: "session:compacted:su-94b69…" }   // wake when THAT session recompacts
 *
 * instead of polling. The ownerId lives IN the key (a required param), so a waiter
 * for one owner wakes only for THAT owner's compaction — no payload filtering.
 *
 * WIRE (grounded, not the plan's prose): the ONLY place compaction-COMPLETION is
 * observable is the psu-pty host's `mode:'compact'` handler, step (4) — after the
 * output-idle busy-gate confirms the compaction turn settled and just before the
 * carry-note continuation is submitted (apps/operator/scripts/psu-pty-host.mjs).
 * `session:request-compaction` (server-side) only SENDS the compact and returns; it
 * never sees completion. The host is a standalone Node process with no PG pool / no
 * operator HTTP client, so it cannot call `emitAwaitedEvent` in-process — the host
 * invokes this via a short-lived emit path (see the P-103 hand-off to su-94b69, the
 * live owner of that host file). This module is the SERVER-side core of that path:
 * one tested, fire-and-forget emit that never breaks the resume.
 */

import { emitAwaitedEvent } from './events/await/engine';

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and so must
 * never warn (vitest-fail-on-console would then flake any rig test): a partial test schema
 * (a projection table the emit touches is absent → "… does not exist"), or the emit's async
 * query outliving the Postgres pool it ran on (a rig tearing down mid-emit → postgres.js
 * CONNECTION_ENDED/CONNECTION_DESTROYED). Anything else is a real surprise.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[session-compacted-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seam for tests. */
export interface SessionCompactedEventsDeps {
  emit?: typeof emitAwaitedEvent;
}

/**
 * Fire the awaitable key for one completed session compaction. `owner` is the coord
 * ownerId (PAPERCUSP_SID) whose /compact just finished; it lives IN the key, so a
 * waiter wakes only for that owner. `detail` (the compaction focus, when any) rides
 * the summary + payload so a woken peer sees the focus without a follow-up read.
 * Fire-and-forget; never throws — an emit failure can never break the resume turn.
 */
export function emitSessionCompactedEvent(
  owner: string,
  detail?: string,
  deps: SessionCompactedEventsDeps = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(async () => {
      const key = `session:compacted:${owner}`;
      const summary = `session ${owner} finished /compact${detail ? ` — ${detail}` : ''}`;
      await emit({ key, summary, payload: { owner, detail: detail ?? null }, source: 'session' });
    })
    .catch((e: unknown) => failSoft(`compacted-event for ${owner}`, e));
}
