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
 * builders, so vectors are bit-identical either way (D-002, live-verified in
 * P-002/P-003). Since WI-4021 a configured sidecar is REQUIRED (D-003
 * retired): sidecar failures throw after brief in-budget retries instead of
 * silently failing over to an in-process model; the in-process builders are
 * the sole engine ONLY where no sidecar is configured (case 3).
 */
import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  buildSidecarFirstEmbedder,
  resolveEmbedSidecarUrl,
  type EmbedFn,
  type GemmaEmbedKind,
} from '@papercusp/memory';
import { buildSidecarFirstReranker, type RerankScoreFn } from '@papercusp/rerank';
import { describeUnfitSidecar, ensureEmbedSidecar, probeSidecarHealth } from './embed-sidecar-spawn';
import {
  EMBED_SIDECAR_CAP_EMBED,
  EMBED_SIDECAR_CAP_RERANK,
  EMBED_SIDECAR_LEGACY_CAPABILITIES,
  type RerankSidecarModel,
} from './embed-sidecar-server';
import { verifySidecarFitness } from '../process-supervision/sidecar-spawn-shared';

/** Injectable seams (tests swap the env read + the spawn side effect). */
export interface SidecarWiringDeps {
  resolveUrl: () => string | null;
  ensure: (requiredCapabilities: readonly string[]) => Promise<string | null>;
  /** /healthz probe for the EXPLICIT-URL path (that sidecar is owned by another
   *  process, so this one never saw it start and cannot know its build). */
  probeHealth: (url: string) => Promise<unknown | null>;
}

const defaultDeps: SidecarWiringDeps = {
  resolveUrl: resolveEmbedSidecarUrl,
  ensure: ensureEmbedSidecar,
  probeHealth: probeSidecarHealth,
};

/** Version-skew is a standing condition, not a per-call event — log each
 *  distinct (url, missing) once so a stale sidecar says its piece loudly and
 *  then stops shouting. */
const reportedSkew = new Set<string>();

/**
 * The sidecar URL THIS process should use for `requiredCapabilities`, or null
 * for pure in-process. Explicit URL wins over the spawn-locally opt-in (an
 * operator fleet points workers at one URL; the owner host sets the opt-in).
 *
 * ⚠ Both paths are capability-verified, and the EXPLICIT one especially: it
 * points at a sidecar owned by another process (typically
 * papercup-embed-sidecar.service), so this process never saw it start and has
 * no idea which build it is running. Before EI-19314150478401738 that path did
 * NO check at all — not even liveness — which is how a 16-day-old bundle kept
 * being handed out for a /rerank route it had never contained.
 *
 * Verification is per-CAPABILITY, not per-sidecar: a pre-advertisement build
 * still serves /embed perfectly well, so embedding keeps using it while only
 * the capability it genuinely lacks falls back. Refusing the whole sidecar
 * would turn one silent bug into a fleet-wide embedding regression.
 */
export async function resolveProcessSidecarUrl(
  deps: SidecarWiringDeps = defaultDeps,
  requiredCapabilities: readonly string[] = [],
): Promise<string | null> {
  const explicit = deps.resolveUrl();
  if (!explicit) return deps.ensure(requiredCapabilities);

  const health = await deps.probeHealth(explicit);
  // A sidecar that is merely DOWN is not a skew problem, and must NOT resolve
  // to null here: WI-4021 (D-003 retired) makes a configured sidecar REQUIRED,
  // so the URL is handed back and the client's retry-then-throw contract owns
  // the outage. Returning null for an outage would silently reinstate the
  // in-process failover that retirement removed — a much worse bug than the
  // one being fixed. ONLY a capability mismatch refuses below.
  if (health === null) return explicit;

  const fitness = verifySidecarFitness(health, requiredCapabilities, EMBED_SIDECAR_LEGACY_CAPABILITIES);
  if (fitness.fit) return explicit;

  const key = `${explicit}|${fitness.reason}|${fitness.missing.join(',')}`;
  if (!reportedSkew.has(key)) {
    reportedSkew.add(key);
    console.error(describeUnfitSidecar(explicit, fitness));
  }
  return null;
}

/** Test seam — clear the once-per-condition skew log memo. */
export function _resetSidecarSkewReportForTests(): void {
  reportedSkew.clear();
}

/**
 * Build a local embedder ('gemma' | 'local'/BGE | 'harrier') for `kind`,
 * served by the shared sidecar when one is configured/spawnable and
 * in-process otherwise. Drop-in replacement for the direct
 * `buildGemmaEmbedder({kind})` / `buildLocalEmbedder()` /
 * `buildHarrierEmbedder({kind})` calls at the cascade seams — same EmbedFn
 * shape, same vectors, same dims.
 */
export async function buildSidecarAwareEmbedder(
  model: 'gemma' | 'local' | 'harrier',
  kind: GemmaEmbedKind,
  deps: SidecarWiringDeps = defaultDeps,
): Promise<EmbedFn> {
  const url = await resolveProcessSidecarUrl(deps, [EMBED_SIDECAR_CAP_EMBED]);
  return buildSidecarFirstEmbedder({
    model,
    kind,
    url,
    // BGE is symmetric — buildLocalEmbedder has no kind knob; gemma and
    // harrier are asymmetric dual-encoders, so kind picks their task prompt
    // (both sides of this fallback match what the sidecar does server-side,
    // by construction).
    fallback:
      model === 'gemma'
        ? () => buildGemmaEmbedder({ kind })
        : model === 'harrier'
          ? () => buildHarrierEmbedder({ kind })
          : () => buildLocalEmbedder(),
  });
}

/**
 * Build a cross-encoder reranker served by the shared sidecar when one is
 * configured/spawnable, and in-process otherwise — the reranker analog of
 * buildSidecarAwareEmbedder, resolving the sidecar URL through the SAME seam
 * (one sidecar process serves both /embed and /rerank, so a host that already
 * runs one gets reranking through it for free).
 *
 * The contract is deliberately identical: with a sidecar the sidecar is
 * REQUIRED (brief retries, then throw — no silent in-process failover that
 * would duplicate a ~150M-param model per process and hide sidecar sickness);
 * the in-process engine is the sole engine only when none is configured.
 *
 * That throw is not a hazard to search: @papercusp/rerank's single fail-safe
 * seam converts it into "keep retrieval order" at the ranking layer, so an
 * outage degrades instead of erroring — it just stops being invisible.
 */
export async function buildSidecarAwareReranker(
  model: RerankSidecarModel = 'rerank',
  deps: SidecarWiringDeps = defaultDeps,
): Promise<RerankScoreFn> {
  const url = await resolveProcessSidecarUrl(deps, [EMBED_SIDECAR_CAP_RERANK]);
  return buildSidecarFirstReranker({ model, url });
}
