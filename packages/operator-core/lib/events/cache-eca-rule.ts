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
import { getFlag } from '@papercusp/flags/server';
import { lazyFlagRefresh } from '../lazy-flag-refresh';
import { registerReactionRule } from './registry';
import { TABLE_CHANGED_KEY } from './registry';
import { CACHE_BUMP_TAGS_ACTION } from './builtin-actions';
import { systemDistinctId } from '../flag-distinct-id';
import type { ToolInvocationEvent } from './types';

/** The rule id (stable — re-registering replaces; used in tests + the reactive graph). */
export const CACHE_TAG_ECA_RULE_ID = 'cache-tag-eca:table-changed';

// SYNC-cached CACHE_TAG_ECA flag — the rules-engine `when` predicate is synchronous, so we
// can't await getFlag inside it. We fail-CLOSED to `false` on a read error so a flag-store
// hiccup can't fire an unintended invalidation; the change handler re-reads and recovers.
// (An earlier version of this comment said "Unloaded ⇒ the DEFAULT (true)", which contradicted
// the `= false` initializer one line below it. Unloaded is `false`; the flag's REGISTRY default
// is true. Both facts matter to the arming note below, so neither is left implied.)
let cacheEcaOn = false;
async function refreshCacheEca(): Promise<void> {
  try {
    cacheEcaOn = await getFlag(FLAGS.CACHE_TAG_ECA, systemDistinctId());
  } catch {
    cacheEcaOn = false;
  }
}

// EI-19416650993725684: armed on FIRST READ, never at module scope — a module-scope
// `onFlagChange` binding access (or the eager `void refreshCacheEca()` that used to sit here;
// an async body runs synchronously to its first await, so it reached `getFlag` just as hard)
// makes this file unimportable under a PARTIAL vitest mock of '@papercusp/flags/server',
// killing COLLECTION for every test whose import graph touches it. See lazy-flag-refresh.ts.
//
// ⚠ The arm belongs on the READER (cacheTagEcaEnabled), NOT in registerCacheTagEcaRule() —
// which is the tempting spot, since registration looks like a boot path. It is not a usable
// one: rules.ts calls the registrar at MODULE SCOPE, so arming there would touch the flag
// binding during rules.ts's import and simply move the unimportability one file over.
//
// Safe to arm lazily: the unpopulated value is `false`, which is this module's OWN documented
// fail-CLOSED state (see the `catch` above) — the rule's `when` falls false and no tag bump
// fires. The cost of the one pre-refresh read is a single skipped invalidation in that process,
// self-healing on the next bump for the same tag; it cannot produce a WRONG value, only a
// briefly stale cached one. Contrast issues-engineer.ts, whose unpopulated state points at a
// DEAD partition and is therefore NOT migratable without a boot warm (EI-19448574704459898).
const armFlagRefresh = lazyFlagRefresh(refreshCacheEca, FLAGS.CACHE_TAG_ECA);

/** Whether the cache-ECA rule is live (read from the SYNC-cached CACHE_TAG_ECA flag). */
export function cacheTagEcaEnabled(): boolean {
  armFlagRefresh(); // the ONLY reader of the cache, so the sole arm point
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
