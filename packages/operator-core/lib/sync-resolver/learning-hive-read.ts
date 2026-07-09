/**
 * learning-hive-read.ts — the read behind the Learning tab's "Learnings" view
 * (learning-packs-2026-06-11 P-008).
 *
 * One hive's shared memory pool (`hive:<slug>`, P-004), annotated with pack
 * provenance so the UI can keep the boundary legible between "what Papercusp
 * (or an installed pack) gave you" and "what your hive learned":
 *
 *   - a row whose metadata carries `{source:'pack', pack_id, pack_version,
 *     pack_item_id}` is PACK-SEEDED → badge it; `packState` says whether its
 *     text still matches the pack's canonical render (`pristine`) or was
 *     edited (`modified`, compared via memoryTextOf against the currently
 *     resolvable pack of the same id);
 *   - any other row is ORGANIC — recorded by the hive's own agents/owner.
 *
 * Per-pack rollups also count `notPresent` (pack items with no row — removed
 * by the user OR filtered at seed time by applies_to; the store can't
 * distinguish, so the UI words it as "not seeded / removed").
 *
 * Pure over injected deps (backend list + pack loader) so the resolver test
 * pins it without PG/FS; the index.ts entry wires the real impls.
 */

import type { MemoryEntry } from '../memory/backend';
import { memoryTextOf, type LearningPack } from '../learning-packs/pack-format';

export interface HiveLearningRow {
  id: string;
  text: string;
  kind?: string;
  /** Pack provenance (absent on organic rows). */
  packId?: string;
  packVersion?: string;
  packItemId?: string;
  /** pack rows only: text matches the resolvable pack's canonical render? */
  packState?: 'pristine' | 'modified';
  appliesTo?: string[];
  createdBy?: string;
}

export interface HivePackRollup {
  packId: string;
  /** Version stamped on the seeded rows (first seen). */
  packVersion?: string;
  /** Rows present, of which `modified` were user-edited. */
  present: number;
  modified: number;
  /** Items in the resolvable pack with no row (removed or never seeded). */
  notPresent: number;
  /** Item count of the currently resolvable pack (absent when unresolvable). */
  packTotal?: number;
  /** Decorated by the resolver (P-009): injection on/off for this hive. */
  enabled?: boolean;
  /** Decorated by the resolver (P-013): a newer pack version is adoptable. */
  updateAvailable?: boolean;
  availableVersion?: string;
}

export interface HiveLearningsSnapshot {
  hive: string;
  rows: HiveLearningRow[];
  packs: HivePackRollup[];
  organicCount: number;
  /** True when the memory store was unreachable (UI renders "unavailable"). */
  unavailable?: boolean;
}

export interface HiveLearningsDeps {
  listPool: (scope: string) => Promise<MemoryEntry[]>;
  loadPack: (packId: string) => Promise<{ pack: LearningPack } | null>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export async function readHiveLearnings(
  potSlug: string,
  deps: HiveLearningsDeps,
): Promise<HiveLearningsSnapshot> {
  let entries: MemoryEntry[];
  try {
    entries = await deps.listPool(`hive:${potSlug}`);
  } catch {
    return { hive: potSlug, rows: [], packs: [], organicCount: 0, unavailable: true };
  }

  // Resolve each referenced pack ONCE (batched — never per-row).
  const packIds = [
    ...new Set(
      entries
        .map((e) => (e.metadata?.source === 'pack' ? str(e.metadata?.pack_id) : undefined))
        .filter((v): v is string => !!v),
    ),
  ];
  const loaded = await Promise.all(
    packIds.map(async (id) => [id, await deps.loadPack(id).catch(() => null)] as const),
  );
  const packById = new Map(loaded);

  const rows: HiveLearningRow[] = entries.map((e) => {
    const m = e.metadata ?? {};
    const isPack = m.source === 'pack' && str(m.pack_id);
    const base: HiveLearningRow = {
      id: e.id,
      text: e.text,
      ...(e.kind ? { kind: e.kind } : {}),
      ...(Array.isArray(m.applies_to) ? { appliesTo: m.applies_to as string[] } : {}),
      ...(str(m.created_by) ? { createdBy: str(m.created_by) } : {}),
    };
    if (!isPack) return base;
    const packId = str(m.pack_id)!;
    const itemId = str(m.pack_item_id);
    const pack = packById.get(packId)?.pack;
    const item = itemId ? pack?.items.find((i) => i.id === itemId) : undefined;
    return {
      ...base,
      packId,
      ...(str(m.pack_version) ? { packVersion: str(m.pack_version) } : {}),
      ...(itemId ? { packItemId: itemId } : {}),
      // Unresolvable pack/item ⇒ can't compare ⇒ treat as modified (honest:
      // we can't vouch it's pristine).
      packState: item && memoryTextOf(item) === e.text ? 'pristine' : 'modified',
    };
  });

  const packs: HivePackRollup[] = packIds.map((packId) => {
    const mine = rows.filter((r) => r.packId === packId);
    const pack = packById.get(packId)?.pack;
    const presentItemIds = new Set(mine.map((r) => r.packItemId).filter(Boolean));
    return {
      packId,
      ...(mine.find((r) => r.packVersion)?.packVersion
        ? { packVersion: mine.find((r) => r.packVersion)!.packVersion }
        : {}),
      present: mine.length,
      modified: mine.filter((r) => r.packState === 'modified').length,
      notPresent: pack ? pack.items.filter((i) => !presentItemIds.has(i.id)).length : 0,
      ...(pack ? { packTotal: pack.items.length } : {}),
    };
  });

  return {
    hive: potSlug,
    rows,
    packs,
    organicCount: rows.filter((r) => !r.packId).length,
  };
}
