/**
 * The cache↔change-stream ECA rule (caching-layer-tag-eca-2026-06-22 P-004) — the
 * keystone wiring the operator cache to the change stream.
 *
 * A table-change event (`<schema>.<table>.changed`, emitted from the sync change
 * stream into the reaction matcher via `emitSystemEvent`) carries
 * `{ workspace_id, op, id }` (mig 368 added the row PK + the correct workspace).
 * This rule maps EVERY such event to the built-in `cache.bumpTags` action with a
 * deterministic, workspace-scoped tag scheme:
 *
 *   a change to row `<id>` on `<table>` bumps tags `['<table>', '<table>:<id>']`
 *
 * so a `getOrSet` entry tagged with the table (a list query) OR the specific row
 * (`<table>:<id>`) is lazily stale on its next read. `<table>` is the BASE table
 * name (the `<schema>.` prefix stripped) — the same identifier a cache consumer
 * would naturally tag with.
 *
 * The rule is registered on the wildcard `'*.changed'` trigger key (see
 * `registry.ts` `keyOf`) so ONE rule reacts to a change on ANY table without
 * enumerating the open-ended table set.
 *
 * FLAG-GATED (CACHE_TAG_ECA, default ON). The rule's `when` is the rules engine's
 * synchronous predicate, so the flag is held in a SYNC-cached boolean refreshed on
 * boot + every flag change (the WORKITEM_CLAIM_LEASE / lexicon precedent). OFF ⇒
 * `when` falls false ⇒ no `cache.bumpTags` fires (byte-identical to no cache).
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { registerReactionRule } from './registry';
import { TABLE_CHANGED_KEY } from './registry';
import { CACHE_BUMP_TAGS_ACTION } from './builtin-actions';
import { systemDistinctId } from '../flag-distinct-id';
import type { ToolInvocationEvent } from './types';

/** The rule id (stable — re-registering replaces; used in tests + the reactive graph). */
export const CACHE_TAG_ECA_RULE_ID = 'cache-tag-eca:table-changed';

// SYNC-cached CACHE_TAG_ECA flag — the rules-engine `when` predicate is synchronous,
// so we can't await getFlag inside it. Refreshed on an initial read + every flag
// change. Unloaded ⇒ the DEFAULT (true) is the safe behavior (a no-op bump), but we
// fail-CLOSED to false on an actual read error so a flag-store hiccup can't fire an
// unintended invalidation; the change handler re-reads and recovers.
let cacheEcaOn = false;
async function refreshCacheEca(): Promise<void> {
  try {
    cacheEcaOn = await getFlag(FLAGS.CACHE_TAG_ECA, systemDistinctId());
  } catch {
    cacheEcaOn = false;
  }
}
void refreshCacheEca();
onFlagChange((key) => {
  if (key === null || key === FLAGS.CACHE_TAG_ECA) void refreshCacheEca();
});

/** Whether the cache-ECA rule is live (read from the SYNC-cached CACHE_TAG_ECA flag). */
export function cacheTagEcaEnabled(): boolean {
  return cacheEcaOn;
}

/** Test-only: re-read the flag synchronously-awaitably (the boot `void` read may not have settled). */
export async function _refreshCacheEcaForTests(): Promise<void> {
  await refreshCacheEca();
}

/** Strip the `<schema>.` prefix and the `.changed` suffix → the base table name. */
export function tableNameFromChangedEvent(tool: string): string | null {
  if (!tool.endsWith('.changed')) return null;
  const withoutSuffix = tool.slice(0, -'.changed'.length);
  if (withoutSuffix.length === 0) return null;
  const dot = withoutSuffix.lastIndexOf('.');
  // `<schema>.<table>` ⇒ table; a bare `<table>` (no schema) ⇒ itself.
  const table = dot >= 0 ? withoutSuffix.slice(dot + 1) : withoutSuffix;
  return table.length > 0 ? table : null;
}

/**
 * The deterministic, workspace-scoped tag set a change to `<table>` row `<id>`
 * invalidates: the table-level tag (list queries) + the row-level tag (`<table>:<id>`).
 * A change with no row PK (a table-wide event) bumps only the table tag.
 */
export function tagsForTableChange(table: string, id: unknown): string[] {
  const tags = [table];
  if (typeof id === 'string' && id.length > 0) tags.push(`${table}:${id}`);
  else if (typeof id === 'number') tags.push(`${table}:${id}`);
  return tags;
}

/**
 * Register the cache↔change-stream ECA rule. Idempotent (stable id). Called at
 * module load from the Events file (`./rules`).
 */
export function registerCacheTagEcaRule(): void {
  registerReactionRule({
    id: CACHE_TAG_ECA_RULE_ID,
    on: TABLE_CHANGED_KEY,
    // Flag gate (sync-cached) — OFF ⇒ never fires. Also require a resolvable table.
    when: (e: ToolInvocationEvent) => cacheTagEcaEnabled() && tableNameFromChangedEvent(e.tool) !== null,
    fire: CACHE_BUMP_TAGS_ACTION,
    args: (e: ToolInvocationEvent) => {
      const table = tableNameFromChangedEvent(e.tool);
      const a = (e.args ?? {}) as { id?: unknown };
      return { tags: table ? tagsForTableChange(table, a.id) : [] };
    },
    // A side effect, not durability-worthy: fire-and-forget in-process. (A missed
    // bump is self-healing — the next change re-bumps, and TTLs bound staleness.)
    mode: 'sync',
    onlyOnSuccess: true,
    source: 'events-file',
  });
}
