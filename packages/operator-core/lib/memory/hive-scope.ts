/**
 * hive-scope — the `hive:<slug>` memory pool (learning-packs-2026-06-11 P-004,
 * D-008/OQ-1: a payload-level scope value, no schema migration).
 *
 * A Hive's shared knowledge — seeded learning packs (D-001) + organically
 * recorded conventions (D-002's binding step) — lives in mem0 rows whose scope
 * is `hive:<home-slug>`. Every agent working anywhere in the Hive should
 * recall it, so injection resolves the harness slugs it was given to their
 * owning Hives:
 *
 *   member harness   → its registry `hive_slug` (shared-hive-federation P-004)
 *   hive home        → its own slug (`harness_kind: 'hive'`, incl. remote_hive
 *                      joiner views — recalling an empty pool is harmless)
 *   plain standalone → no hive pool (D-008/OQ-4: hives only in v1)
 *
 * The pure resolution is split from the registry IO so injection tests pin it
 * without PG (same posture as the rest of lib/memory).
 */

import { loadHarnessRegistry } from '../harness-registry';

export const HIVE_SCOPE_PREFIX = 'hive:';

export function hiveScopeKey(hiveSlug: string): string {
  return `${HIVE_SCOPE_PREFIX}${hiveSlug}`;
}

/** `hive:<slug>` → `<slug>`, or null when the scope isn't hive-shaped. */
export function hiveSlugFromScope(scope: string): string | null {
  return scope.startsWith(HIVE_SCOPE_PREFIX) ? scope.slice(HIVE_SCOPE_PREFIX.length) : null;
}

export interface RegistryEntryLite {
  slug: string;
  harness_kind?: string;
  hive_slug?: string;
}

/** Pure member→hive resolution over registry entries. De-duped, input order. */
export function hiveSlugsForHarnesses(
  entries: readonly RegistryEntryLite[],
  harnessSlugs: readonly string[],
): string[] {
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const out: string[] = [];
  for (const slug of harnessSlugs) {
    const entry = bySlug.get(slug);
    if (!entry) continue;
    const hive = entry.harness_kind === 'hive' ? entry.slug : entry.hive_slug;
    if (hive && !out.includes(hive)) out.push(hive);
  }
  return out;
}

/**
 * Registry-backed resolution. One operator-state read per call — callers on
 * hot paths (pre-turn injection) treat it as best-effort and catch failures.
 */
export async function resolveHiveSlugsForHarnesses(
  workspaceId: string | undefined,
  harnessSlugs: readonly string[],
): Promise<string[]> {
  if (harnessSlugs.length === 0) return [];
  const reg = await loadHarnessRegistry(workspaceId);
  return hiveSlugsForHarnesses(reg.projects, harnessSlugs);
}
