/**
 * provisioner/catalog — the certified-combo catalog the provisioner wizard recommends from
 * (local-concurrent-inference-2026-07-02 D-005 "catalog is a HARNESS, not a list", D-006).
 *
 * D-005's certification battery (plan items P-006/P-007, lib/inference-gateway/cert-battery)
 * is the thing that PRODUCES a catalog entry. Each entry carries an explicit `status`:
 *   - 'provisional': grounded in a real, currently-running config (verified against this
 *     box's live `llama-ornith.service` unit) but NOT yet run through the cert battery.
 *   - 'certified':   passed the cert battery — the `certification` field records the verdict,
 *     run timestamp, and mangling rate. ornith-35b IQ3_M @ llama-server is entry #1. Flip an
 *     entry here when the battery certifies it live; never add a parallel "real" catalog.
 *
 * The wizard is honest about this in the UI/CLI (recommend.ts's `reason` string surfaces
 * `status`), rather than presenting a provisional entry as fully vetted.
 */
import type { LocalBackendKind } from '../inference-gateway/local-backend-store';
import type { HardwareTier } from './recommend-types';

export type CatalogEntryStatus = 'provisional' | 'certified';

/** Certification evidence attached to a `status: 'certified'` entry — a compact stamp of the
 *  cert-battery run that certified this locked config (lib/inference-gateway/cert-battery). The
 *  full per-probe report is transient run data; the durable audit fact is this summary. */
export interface CatalogCertification {
  /** The battery verdict at certification (a certified entry is always 'certified' here). */
  verdict: 'certified' | 'failed';
  /** ISO timestamp of the certifying run. */
  ranAt: string;
  /** Aggregate tool-call mangling rate at certification (0..1) — the metric that separates a
   *  healthy model from a tool-JSON storm. */
  manglingRate: number;
  /** Critical probes that passed / total, e.g. "3/3" (behavior · trimmed-shape · comms). */
  criticalProbes: string;
  /** The battery's one-line summary. */
  summary: string;
  /** How it was certified (battery + endpoint), for the audit trail. */
  method: string;
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  backend: LocalBackendKind;
  model: {
    /** ollama-style reference, e.g. "maxwell1500/ornith-35b:IQ3_M" — used both to resolve an
     *  already-pulled ollama blob (weights.ts) and as the `ollama pull` hint when it's missing.
     *  For a `backend: 'vllm'` entry this doubles as the gateway registry's model id / OpenAI
     *  `/v1/models` id (kept equal to `serve`'s rendered `--served-model-name` — see
     *  vllm-container.ts) rather than an actual ollama reference. */
    ollamaRef: string;
    quant: string;
    /** Approximate on-disk weights size, for the wizard's "this will download ~NGB" messaging. */
    sizeGB: number;
    /** HF model repo id for a vLLM backend's `--model` (an AWQ/GPTQ requant repo). Only
     *  meaningful when `backend === 'vllm'`; llama-server/ollama entries resolve weights via
     *  `ollamaRef` (weights.ts) instead and leave this unset. */
    hfRepo?: string;
    /** vLLM quantization method for `--quantization`. Only meaningful when `backend === 'vllm'`
     *  (vllm-container.ts's `renderVllmContainerUnit` defaults to 'awq' when unset). */
    quantization?: 'awq' | 'gptq';
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
    /** vLLM `--gpu-memory-utilization` (0-1). Only meaningful when `backend === 'vllm'`;
     *  defaults to 0.9 in provision.ts's rendering when unset. */
    gpuMemoryUtilization?: number;
    /** llama-server `--jinja` — required for structured tool-call parsing on models whose
     *  tool format needs the jinja chat template (e.g. Qwen3's `<tool_call>`; WI-1596).
     *  Only meaningful when `backend === 'llama-server'`. */
    jinja?: boolean;
    /** llama-server `--reasoning-budget N` (0 = disable thinking-mode preambles — part of
     *  the certified qwen3 config; WI-1596). Only meaningful when `backend === 'llama-server'`. */
    reasoningBudget?: number;
  };
  status: CatalogEntryStatus;
  /** Present iff `status === 'certified'` — the cert-battery run that certified this config. */
  certification?: CatalogCertification;
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
    status: 'certified',
    certification: {
      verdict: 'certified',
      ranAt: '2026-07-02T20:21:49.813Z',
      manglingRate: 0,
      criticalProbes: '3/3',
      summary:
        '[certified] maxwell1500/ornith-35b:IQ3_M IQ3_M @ llama-server (2×90112 ctx): 3/3 critical probes pass, mangling 0.0%',
      method:
        'cert-battery (behavior · trimmed-shape · comms · mangling-rate) run live via the D-011 sanitizer at :11435',
    },
    sourceRef:
      'local-concurrent-inference-2026-07-02 D-005/D-006 — config verified against the live llama-ornith.service unit; certified 2026-07-02 by the P-006 cert battery (lib/inference-gateway/cert-battery)',
  },
  {
    id: 'qwen3-8b-q4km-llama-server',
    displayName: 'Qwen3-8B (Q4_K_M) via llama-server',
    backend: 'llama-server',
    model: { ollamaRef: 'qwen3:8b', quant: 'Q4_K_M', sizeGB: 5.0 },
    hardwareTier: 'nvidia-low',
    minVramGB: 10,
    serve: {
      host: '127.0.0.1',
      portDefault: 11437,
      parallelSlots: 2,
      ctxTotal: 16384,
      kvCacheType: 'f16',
      flashAttn: false,
      jinja: true,
      reasoningBudget: 0,
    },
    status: 'certified',
    certification: {
      verdict: 'certified',
      ranAt: '2026-07-03T23:18:26.415Z',
      manglingRate: 0,
      criticalProbes: '3/3',
      summary:
        '[certified] qwen3:8b Q4_K_M @ llama-server (2×8192 ctx): 3/3 critical probes pass, mangling 0.0%',
      method:
        'cert-battery (behavior · trimmed-shape · comms · mangling-rate) run live via cert:run against a CPU-only llama-server serve (CUDA_VISIBLE_DEVICES= — GPU held by the live ornith backend; probes measure model+template+parser behavior, placement-independent) of the official Qwen/Qwen3-8B-GGUF Q4_K_M with --jinja --reasoning-budget 0. Without --jinja the tool-call parser never engages (qwen2.5-coder:14b failed 1/3 under BOTH the embedded and official templates — wrong-tag `<tools>` emissions; that model is NOT catalog-eligible).',
    },
    sourceRef:
      'local-concurrent-inference-2026-07-02 P-007 (WI-1596) — certified 2026-07-03 on the tower via cert:run; serve flags are the exact certified config (jinja + reasoning-budget 0)',
  },
  {
    id: 'qwen3-8b-q4km-llama-server-metal',
    displayName: 'Qwen3-8B (Q4_K_M) via llama-server (Apple Silicon)',
    backend: 'llama-server',
    model: { ollamaRef: 'qwen3:8b', quant: 'Q4_K_M', sizeGB: 5.0 },
    hardwareTier: 'apple-silicon',
    minVramGB: 12,
    serve: {
      host: '127.0.0.1',
      portDefault: 11437,
      parallelSlots: 2,
      ctxTotal: 16384,
      kvCacheType: 'f16',
      flashAttn: false,
      jinja: true,
      reasoningBudget: 0,
    },
    status: 'provisional',
    sourceRef:
      'local-concurrent-inference-2026-07-02 P-007 (WI-1596) — same (model, quant, backend, template-flags) combo as qwen3-8b-q4km-llama-server, which certified 3/3 / 0% mangling on x86 CPU serve 2026-07-03; stays provisional until the cert battery runs on a real Metal serve (mac lane su-a1a71 — flip to certified with that run\'s stamp)',
  },
] as const;

/** Look up a catalog entry by id (returns undefined if unknown — never throws). */
export function findCatalogEntry(id: string, catalog: readonly CatalogEntry[] = CERTIFIED_CATALOG): CatalogEntry | undefined {
  return catalog.find((e) => e.id === id);
}
