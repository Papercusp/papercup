/**
 * Sidecar-aware embedder builders (P-004, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * The ONE wiring seam between the operator's embedder cascade and the shared
 * embedding sidecar. Every production site that used to call
 * `buildGemmaEmbedder` / `buildLocalEmbedder` directly (configure.ts's
 * `buildEmbedderForMode` + `resolveEmbedder`, agent-tools/search's
 * `buildQueryEmbedder`, embed-backfill's `resolveBackfillEmbedder`) now
 * injects `buildSidecarAwareEmbedder` instead, so the sidecar-vs-in-process
 * decision lives HERE, once:
 *
 *   1. PAPERCUSP_EMBED_SIDECAR_URL set  → use that sidecar (it may be owned
 *      by another process, e.g. the bg-host spawned it for the whole box).
 *   2. PAPERCUSP_EMBED_SIDECAR=1        → lazily ensure the host-local
 *      sidecar (spawn once, or adopt a sibling's — embed-sidecar-spawn.ts)
 *      and use its loopback URL.
 *   3. neither                          → null URL: buildSidecarFirstEmbedder
 *      degenerates to the plain in-process embedder — byte-for-byte today's
 *      behavior, zero per-call overhead.
 *
 * Space safety is inherited, not re-argued: the sidecar wraps the SAME
 * builders the fallback uses, so vectors are bit-identical either way
 * (D-002, live-verified in P-002/P-003) and a mid-stream failover can never
 * mix embedding spaces (D-003).
 */
import {
  buildGemmaEmbedder,
  buildLocalEmbedder,
  buildSidecarFirstEmbedder,
  resolveEmbedSidecarUrl,
  type EmbedFn,
  type GemmaEmbedKind,
} from '@papercusp/memory';
import { ensureEmbedSidecar } from './embed-sidecar-spawn';

/** Injectable seams (tests swap the env read + the spawn side effect). */
export interface SidecarWiringDeps {
  resolveUrl: () => string | null;
  ensure: () => Promise<string | null>;
}

const defaultDeps: SidecarWiringDeps = {
  resolveUrl: resolveEmbedSidecarUrl,
  ensure: ensureEmbedSidecar,
};

/**
 * The sidecar URL THIS process should embed through, or null for pure
 * in-process. Explicit URL wins over the spawn-locally opt-in (an operator
 * fleet points workers at one URL; the owner host sets the opt-in).
 */
export async function resolveProcessSidecarUrl(deps: SidecarWiringDeps = defaultDeps): Promise<string | null> {
  const explicit = deps.resolveUrl();
  if (explicit) return explicit;
  return deps.ensure();
}

/**
 * Build a local embedder ('gemma' | 'local'/BGE) for `kind`, served by the
 * shared sidecar when one is configured/spawnable and in-process otherwise.
 * Drop-in replacement for the direct `buildGemmaEmbedder({kind})` /
 * `buildLocalEmbedder()` calls at the cascade seams — same EmbedFn shape,
 * same vectors, same dims.
 */
export async function buildSidecarAwareEmbedder(
  model: 'gemma' | 'local',
  kind: GemmaEmbedKind,
  deps: SidecarWiringDeps = defaultDeps,
): Promise<EmbedFn> {
  const url = await resolveProcessSidecarUrl(deps);
  return buildSidecarFirstEmbedder({
    model,
    kind,
    url,
    // BGE is symmetric — buildLocalEmbedder has no kind knob; gemma is the
    // asymmetric dual-encoder, so kind picks its task prompt (both sides of
    // this fallback match what the sidecar does server-side, by construction).
    fallback: model === 'gemma' ? () => buildGemmaEmbedder({ kind }) : () => buildLocalEmbedder(),
  });
}
