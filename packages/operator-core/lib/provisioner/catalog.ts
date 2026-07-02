/**
 * provisioner/catalog — the certified-combo catalog the provisioner wizard recommends from
 * (local-concurrent-inference-2026-07-02 D-005 "catalog is a HARNESS, not a list", D-006).
 *
 * D-005's certification battery (plan items P-006/P-007) is the thing that's supposed to
 * PRODUCE a catalog entry — it hasn't run yet (P-006 is still `todo`, and P-009/this wizard
 * is plan-blockedBy it). So every entry here carries an explicit `status`:
 *   - 'provisional': grounded in a real, currently-running config (verified against this
 *     box's live `llama-ornith.service` unit) but NOT yet run through the cert battery.
 *   - 'certified':   passed the P-006/P-007 battery. None yet — flip the first entry once
 *     that lands, don't add a parallel "real" catalog.
 *
 * The wizard is honest about this in the UI/CLI (recommend.ts's `reason` string surfaces
 * `status`), rather than presenting a provisional entry as fully vetted.
 */
import type { LocalBackendKind } from '../inference-gateway/local-backend-store';
import type { HardwareTier } from './recommend-types';

export type CatalogEntryStatus = 'provisional' | 'certified';

export interface CatalogEntry {
  id: string;
  displayName: string;
  backend: LocalBackendKind;
  model: {
    /** ollama-style reference, e.g. "maxwell1500/ornith-35b:IQ3_M" — used both to resolve an
     *  already-pulled ollama blob (weights.ts) and as the `ollama pull` hint when it's missing. */
    ollamaRef: string;
    quant: string;
    /** Approximate on-disk weights size, for the wizard's "this will download ~NGB" messaging. */
    sizeGB: number;
  };
  hardwareTier: HardwareTier;
  /** Minimum VRAM (GB) required to run this combo at the tuning below. */
  minVramGB: number;
  serve: {
    host: string;
    portDefault: number;
    parallelSlots: number;
    ctxTotal: number;
    kvCacheType: string;
    flashAttn: boolean;
  };
  status: CatalogEntryStatus;
  /** Plan/decision this entry's config was sourced from, for audit trail. */
  sourceRef: string;
}

export const CERTIFIED_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'ornith-35b-iq3m-llama-server',
    displayName: 'ornith-35b (IQ3_M) via llama-server',
    backend: 'llama-server',
    model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M', quant: 'IQ3_M', sizeGB: 15.5 },
    hardwareTier: 'nvidia-24gb-plus',
    minVramGB: 24,
    serve: {
      host: '127.0.0.1',
      portDefault: 11436,
      parallelSlots: 2,
      ctxTotal: 180224,
      kvCacheType: 'q8_0',
      flashAttn: true,
    },
    status: 'provisional',
    sourceRef: 'local-concurrent-inference-2026-07-02 D-005/D-006 — config verified against the live llama-ornith.service unit; awaiting P-006/P-007 certification battery',
  },
] as const;

/** Look up a catalog entry by id (returns undefined if unknown — never throws). */
export function findCatalogEntry(id: string, catalog: readonly CatalogEntry[] = CERTIFIED_CATALOG): CatalogEntry | undefined {
  return catalog.find((e) => e.id === id);
}
