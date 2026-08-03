/**
 * workspace-brain-scope.ts — the SHARED K1 keying helper for the per-hive →
 * workspace brain re-key (workspace-scoped-coordination-2026-06-20, D-006/D-007).
 *
 * The Queen (P-003), Scout (P-002) and Overwatch (P-004) all move from per-HIVE
 * to one-per-WORKSPACE behind ONE shared flag (FLAGS.WORKSPACE_COORDINATION).
 * D-006 mandates ONE consistent keying pattern across all three — this module IS
 * that pattern, so the three brains can't drift apart.
 *
 * K1 (migration-light, reversible — D-006): the brain's per-hive state key
 * collapses to a stable WORKSPACE SENTINEL (= workspaceId) that REUSES the
 * existing per-hive index/column (operator_settings `<thing>:<ws>:<install>` →
 * `<thing>:<ws>`; routines (ws, install_slug, name) → install_slug=ws sentinel;
 * SQL tables keyed (workspace_id, hive_slug, …) → hive_slug = workspaceId). No
 * migration on a hot live table during the deploy-freeze. Every read ships a
 * READ-FALLBACK to the legacy per-hive row so a single-hive workspace
 * (papercusp == papercusp-workspace) pre-backfill has ZERO regression.
 *
 * Flag OFF ⇒ the legacy per-hive slug, byte-identical to today.
 *
 * ⚠ "the dark default" is what this line used to say, and it is STALE — measured 2026-08-03,
 * `FLAG_DEFAULTS[WORKSPACE_COORDINATION] === true`. The flag graduated; the canary verify this
 * paragraph gated on has happened. Two other comments below inherited the same wrong premise and
 * are corrected in place. (Fourth instance of this class in two days — WORKITEM_REDUNDANCY,
 * WORKITEM_CLAIM_LEASE and ISSUES_PER_WORKSPACE all carried comments asserting a default that
 * contradicted the registry, and in one case the stale comment was the stated safety justification
 * for a migration. In this area read `libs/flags/src/types.ts`, never the prose.)
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { systemDistinctId } from './flag-distinct-id';

/**
 * Is the per-hive → workspace brain re-key (FLAGS.WORKSPACE_COORDINATION) ON?
 * Reads the shared master gate; on any error returns false (legacy per-hive), so
 * a flag-bus hiccup can never silently flip a live loop.
 * Mirrors the getFlag(systemDistinctId()) pattern used by the sibling keying
 * flags (configure-per-workspace.ts / coordination/log.ts).
 */
// Keying mode is a process-wide topology decision, not a request-level feature
// toggle.  A per-call PostHog timeout can otherwise return a DIFFERENT value
// between two successful reads, making one process write sentinel rows and
// legacy rows minutes apart.  Keep the first resolved value sticky for this
// process and invalidate it only when the flag bus reports an intentional flip.
//
// ⚠ This comment used to say the timeout "return[s] FLAG_DEFAULTS (OFF)". That parenthetical is
// stale twice over: FLAG_DEFAULTS is now `true`, and the `catch` below does not return the
// registry default at all — it returns a hardcoded `false`.
//
// ⚠⚠ AND THE STICKINESS APPLIES TO THAT ERROR VALUE. The `.then` below caches whatever the async
// IIFE resolved to, and the `catch { return false }` resolves rather than rejecting — so ONE
// transient getFlag failure pins this whole process to legacy per-hive keying until a flag-change
// event or a restart, while production is ON. That is the opposite of what stickiness was added to
// achieve (it was added to stop a transient value from being observed at all). Filed separately;
// NOT changed here, because changing which keying topology a process commits to on an error is a
// behaviour change that deserves its own item and test rather than a drive-by.
let workspaceCoordinationOn: boolean | undefined;
let workspaceCoordinationRead: Promise<boolean> | undefined;
let workspaceCoordinationEpoch = 0;

function invalidateWorkspaceCoordination(): void {
  workspaceCoordinationOn = undefined;
  workspaceCoordinationRead = undefined;
  workspaceCoordinationEpoch += 1;
}

/**
 * Armed on FIRST USE, not at import (EI-19416650993725684) — a module-scope `onFlagChange` binding
 * ACCESS makes this file unimportable under a PARTIAL vitest mock of '@papercusp/flags/server',
 * killing COLLECTION for every test whose import graph touches it. See lazy-flag-refresh.ts.
 *
 * ⚠ This caller is shaped UNLIKE every other one, and the difference is worth stating because it is
 * what makes it trivially safe. Elsewhere the subscription keeps a cache fresh FOR A SYNC READER,
 * so lazy arming widens a window in which that reader serves a pre-refresh value — the hazard the
 * `unpopulated` declaration exists to force a judgement about. Here:
 *
 *   - the callback is an INVALIDATOR, not a refresher (it clears the cache and bumps the epoch), and
 *   - the only reader of the flag state is ASYNC and AWAITS the real `getFlag` whenever the cache is
 *     `undefined`, so an unpopulated cache serves no value at all — it just causes the read.
 *
 * The other two exports take the flag value as a PARAMETER (deliberately — see their docs), so they
 * read no cache. There is therefore no pre-refresh window to reason about: `undefined` means
 * "go and read it", not "here is a guess". A flag flip landing before the first read needs no
 * subscription either, because there is no cache yet to invalidate.
 */
const armFlagRefresh = lazyFlagRefresh(invalidateWorkspaceCoordination, {
  keys: [FLAGS.WORKSPACE_COORDINATION],
  unpopulated: {
    kind: 'selects-behaviour',
    serves:
      'NOTHING — there is no sync reader of this cache. `isWorkspaceCoordinationOn()` is async and ' +
      'awaits the real getFlag whenever the cached value is `undefined`.',
    safeBecause:
      'the hazard this declaration exists to catch is a SYNC reader serving a pre-refresh value, and ' +
      'this module has no sync reader: the cache is `boolean | undefined`, `undefined` means ' +
      '"unread" rather than a guessed default, and the async reader blocks on getFlag to resolve it. ' +
      'The two SYNC exports (workspaceBrainScopeKey / workspaceBrainReadKeys) are pure and take the ' +
      'flag value as a parameter, so they touch no cache. Arming on first read is also strictly ' +
      'sufficient here: the subscription only INVALIDATES, and a flip arriving before the first read ' +
      'has no cache to invalidate. (Closest available kind; the taxonomy assumes a sync reader and ' +
      'has no name for "no sync reader exists" — noted rather than shoehorned.)',
  },
});

export async function isWorkspaceCoordinationOn(): Promise<boolean> {
  armFlagRefresh(); // first use installs the invalidation subscription
  if (workspaceCoordinationOn !== undefined) return workspaceCoordinationOn;
  if (workspaceCoordinationRead) return workspaceCoordinationRead;
  const epoch = workspaceCoordinationEpoch;
  workspaceCoordinationRead = (async () => {
    try {
      return await getFlag(FLAGS.WORKSPACE_COORDINATION, systemDistinctId());
    } catch {
      return false;
    }
  })().then((value) => {
    if (epoch === workspaceCoordinationEpoch) workspaceCoordinationOn = value;
    return value;
  }).finally(() => {
    if (epoch === workspaceCoordinationEpoch) workspaceCoordinationRead = undefined;
  });
  return workspaceCoordinationRead;
}

/**
 * The K1 WRITE scope key for a workspace brain's per-hive state. ON → the
 * workspace sentinel (= workspaceId), reusing the existing per-hive key column so
 * there is one row per workspace. OFF → the legacy per-hive slug. Pure (the flag
 * value is passed in) so callers read the flag ONCE per operation and stay
 * deterministic + testable.
 */
export function workspaceBrainScopeKey(workspaceId: string, perHiveSlug: string, on: boolean): string {
  return on ? workspaceId : perHiveSlug;
}

/**
 * The K1 READ-FALLBACK keys, in priority order. ON → prefer the workspace
 * sentinel row, then fall back to the legacy per-hive row (so a workspace whose
 * sentinel row has not been written yet still resolves the live per-hive value —
 * zero regression). OFF → only the per-hive row. The sentinel is de-duplicated
 * when the per-hive slug already equals the workspaceId (a workspace==hive shape).
 * A reader consumes these in order and takes the first that yields a value.
 */
export function workspaceBrainReadKeys(workspaceId: string, perHiveSlug: string, on: boolean): string[] {
  if (!on) return perHiveSlug ? [perHiveSlug] : [];
  if (!perHiveSlug || perHiveSlug === workspaceId) return [workspaceId];
  return [workspaceId, perHiveSlug];
}
