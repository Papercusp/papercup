/**
 * provisioner/recommend — pure hardware→catalog-entry matching (local-concurrent-inference-
 * 2026-07-02 P-009, D-006's "recommend" step). No I/O: takes a `DetectedHardware` (from
 * hardware-detect.ts) and the catalog (catalog.ts) and picks the best-fitting entry, or
 * explains why nothing fits (including the "no local GPU → use the cloud gateway" case).
 */
import type { DetectedHardware } from './hardware-detect';
import { CERTIFIED_CATALOG, type CatalogEntry } from './catalog';
import type { HardwareTier } from './recommend-types';

export type { HardwareTier } from './recommend-types';

/** Bucket detected hardware into a coarse tier the catalog is keyed on. Pure, total (every
 *  input maps to a tier — 'cpu-only' is the floor, never a null/undefined result). */
export function tierOf(hw: DetectedHardware): HardwareTier {
  const gpu = hw.gpu;
  if (!gpu) return 'cpu-only';
  if (gpu.vendor === 'apple') return 'apple-silicon';
  if (gpu.vendor === 'nvidia') {
    const vram = gpu.vramGB ?? 0;
    if (vram >= 24) return 'nvidia-24gb-plus';
    if (vram >= 12) return 'nvidia-mid';
    return 'nvidia-low';
  }
  // AMD (and any future vendor without its own tier) — no catalog entries target it yet;
  // fall through to cpu-only so recommend() gives the honest "no combo yet" / cloud-fallback
  // answer rather than silently mis-bucketing it into an NVIDIA tier.
  return 'cpu-only';
}

export interface Recommendation {
  entry: CatalogEntry | null;
  tier: HardwareTier;
  /** Human-readable justification, surfaced verbatim by the CLI/UI. */
  reason: string;
}

/**
 * Recommend a catalog entry for the given hardware. Picks the largest-model entry that fits
 * the tier and the detected VRAM budget; returns `entry: null` with an explanatory `reason`
 * when nothing in the catalog targets this hardware (including the CPU-only → cloud case).
 */
export function recommendCombo(hw: DetectedHardware, catalog: readonly CatalogEntry[] = CERTIFIED_CATALOG): Recommendation {
  const tier = tierOf(hw);

  if (tier === 'cpu-only') {
    return {
      entry: null,
      tier,
      reason: hw.gpu
        ? `detected a ${hw.gpu.vendor} GPU the catalog doesn't target yet — no local combo fits; route through the cloud gateway`
        : 'no GPU detected — no local combo fits; route through the cloud gateway',
    };
  }

  const vramGB = hw.gpu?.vramGB ?? 0;
  const candidates = catalog
    .filter((e) => e.hardwareTier === tier && vramGB >= e.minVramGB)
    .sort((a, b) => b.model.sizeGB - a.model.sizeGB); // biggest model that still fits, first

  if (candidates.length === 0) {
    return {
      entry: null,
      tier,
      reason: `no catalog combo targets tier '${tier}' yet (${vramGB}GB VRAM detected) — catalog currently covers: ${[...new Set(catalog.map((e) => e.hardwareTier))].join(', ') || '(empty)'}`,
    };
  }

  const entry = candidates[0];
  return {
    entry,
    tier,
    reason: `matched '${entry.displayName}' for tier '${tier}' (${vramGB}GB VRAM)${entry.status === 'provisional' ? ' — catalog entry is PROVISIONAL, not yet through the certification battery (P-006/P-007)' : ''}`,
  };
}
