/**
 * seed — copy a learning pack into a hive's mem0 store
 * (learning-packs-2026-06-11 P-005, D-001 copy-not-link).
 *
 * Each pack item becomes one ordinary memory row in the `hive:<slug>` pool
 * (P-004), written VERBATIM (no extract/transform — the corpus is curated)
 * with provenance metadata `{source:'pack', pack_id, pack_version,
 * pack_item_id}` so the Learnings view can badge it, uninstall can find it,
 * and the upgrade diff (P-013) can tell user-edited from pristine.
 *
 * Shape filter (D-002/D-008): `shapes` comes from blueprint detection —
 * `shapesFromDetection` maps the detector's coarse signals (today only
 * `flags.frontend` → 'ui'; service/library/cli have no reliable detector
 * signal yet, so those learnings activate via install or a future detector
 * upgrade — conservative beats wrongly-seeded). Repo-less hives pass
 * undefined ⇒ `any`-tagged items only.
 *
 * Used by pot:create (best-effort, undo-stacked) and the
 * learning_packs:install verb (P-009, which adds the conflict review —
 * creation-time seeding into an EMPTY pool needs none).
 */

import { getMemoryBackend } from '../memory/backend';
import { hiveScopeKey } from '../memory/hive-scope';
import {
  filterByShapes,
  memoryTextOf,
  provenanceOf,
  type AppliesTo,
  type LearningPack,
} from './pack-format';

/** Map a DetectionResult-shaped value onto applies_to shapes. Defensive on shape. */
export function shapesFromDetection(detection: unknown): AppliesTo[] | undefined {
  if (!detection || typeof detection !== 'object') return undefined;
  const flags = (detection as { flags?: unknown }).flags;
  const shapes: AppliesTo[] = [];
  if (flags && typeof flags === 'object' && (flags as { frontend?: unknown }).frontend === true) {
    shapes.push('ui');
  }
  return shapes.length > 0 ? shapes : undefined;
}

export interface SeedPackInput {
  workspaceId: string;
  /** The hive's home slug — rows land in scope `hive:<slug>`. */
  potSlug: string;
  pack: LearningPack;
  /** Project shapes from detection; undefined ⇒ `any`-only (D-008/OQ-3). */
  shapes?: readonly AppliesTo[];
  /** Stamped as metadata.created_by. Default 'system' (creation-time seed). */
  createdBy?: string;
}

export interface SeedPackResult {
  ok: boolean;
  packId: string;
  packVersion: string;
  /** Rows actually written. */
  seeded: number;
  ids: string[];
  /** Items excluded by the shape filter (not an error). */
  skippedByShape: number;
  /** Items whose write failed (logged; never aborts the batch). */
  failed: number;
  error?: string;
  /** Forget every row this call wrote — for the create-flow undo stack. */
  undo: () => Promise<void>;
}

/** Write concurrency — bounded so a 30-item seed doesn't stampede the embedder. */
const SEED_CONCURRENCY = 4;

/**
 * Write ONE pack item into a hive pool — the single canonical row shape,
 * shared by creation-time seeding (below) and the install/upgrade verbs
 * (./manage). Returns the new ids.
 */
export async function rememberPackItem(opts: {
  workspaceId: string;
  potSlug: string;
  pack: LearningPack;
  item: LearningPack['items'][number];
  createdBy?: string;
}): Promise<string[]> {
  const backend = getMemoryBackend();
  const { ids } = await backend.remember(memoryTextOf(opts.item), {
    scope: hiveScopeKey(opts.potSlug),
    kind: opts.item.kind,
    verbatim: true,
    metadata: {
      scope: 'hive',
      hive_slug: opts.potSlug,
      workspace_id: opts.workspaceId,
      created_by: opts.createdBy ?? 'system',
      applies_to: opts.item.appliesTo,
      ...provenanceOf(opts.pack, opts.item),
    },
  });
  return ids;
}

export async function seedPackIntoHive(input: SeedPackInput): Promise<SeedPackResult> {
  const { pack } = input;
  const base = {
    packId: pack.manifest.id,
    packVersion: pack.manifest.version,
    seeded: 0,
    ids: [] as string[],
    skippedByShape: 0,
    failed: 0,
  };
  const undoFor = (ids: string[]) => async () => {
    const backend = getMemoryBackend();
    await Promise.all(ids.map((id) => backend.forget(id).catch(() => {})));
  };

  const backend = getMemoryBackend();
  const avail = await backend.available().catch((e) => ({ ok: false as const, reason: String(e) }));
  if (!avail.ok) {
    return { ...base, ok: false, error: `memory_unavailable: ${avail.reason}`, undo: async () => {} };
  }

  const items = filterByShapes(pack.items, input.shapes);
  const skippedByShape = pack.items.length - items.length;
  const ids: string[] = [];
  let failed = 0;

  // Bounded-concurrency batches (never a serial per-item loop, never a
  // 30-wide stampede).
  for (let i = 0; i < items.length; i += SEED_CONCURRENCY) {
    const batch = items.slice(i, i + SEED_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          return await rememberPackItem({
            workspaceId: input.workspaceId,
            potSlug: input.potSlug,
            pack,
            item,
            ...(input.createdBy ? { createdBy: input.createdBy } : {}),
          });
        } catch (e) {
          console.warn(
            `[learning-packs] seed write failed (${pack.manifest.id}/${item.id}): ${e instanceof Error ? e.message : e}`,
          );
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) ids.push(...r);
      else failed += 1;
    }
  }

  // Live-refresh the Learnings view (P-008 registers `learning.hive`).
  // Fire-and-forget; a missing SSE bus / unregistered name is a no-op.
  void import('../sync-sse')
    .then((m) => m.notifySyncInvalidate('learning.hive'))
    .catch(() => {});

  return {
    ...base,
    ok: failed === 0,
    seeded: ids.length,
    ids,
    skippedByShape,
    failed,
    ...(failed > 0 ? { error: `${failed} write(s) failed` } : {}),
    undo: undoFor(ids),
  };
}
