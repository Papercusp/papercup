/**
 * COMPACT-tier catalog projection for the in-process `su` SUT
 * (deterministic-tool-definition-delivery-2026-09-21 P-011 / D-008 / D-012).
 *
 * WHY THIS EXISTS. D-008 makes agent COMPREHENSION a ship condition: a
 * projection that saves bytes but causes malformed calls is a regression, and
 * byte measurements cannot detect it. D-012 then measured that the obvious
 * instrument cannot answer it — `llm-test --target su` builds its Anthropic
 * `tools` array from `SU_CATALOG`, a HAND-AUTHORED constant, and nothing in
 * `lib/llm-testing` imports `applyCompactTier` / `compactInputSchema` /
 * `summaryGuidanceDescription`. So a green `llm-test` run says nothing about
 * the delivered projection, and recording one as P-011 evidence would be a
 * vacuous green: an instrument that measured none of the space, whose clean
 * result is indistinguishable from a real pass.
 *
 * WHAT THIS DOES. It rebuilds a `BuiltCatalog` by pushing every offered tool
 * through the SAME two functions the transport ships
 * (`summaryGuidanceDescription` + `compactInputSchema`, the pair
 * `applyCompactTier` applies and `compactWireBytes` prices), preferring the
 * LIVE registry's definition for each tool over the harness's curated stand-in.
 * That is the `buildCatalog(entries)` seam D-012 named; no parallel harness is
 * forked, and the scenarios, asserts and tool NAME set are untouched, so a
 * control-vs-compact A/B differs in exactly one variable: how much of each
 * definition the model was told.
 *
 * WHY EVERY TOOL AND NOT THE POLICY'S SUBSET. `CLAUDE_TOOL_DELIVERY.counts` is
 * `{ full: 0, compact: 63 }` — on the client this plan actually changed, EVERY
 * advertised tool ships compact. Projecting the whole offered set is therefore
 * the shipping condition, not a pessimisation.
 *
 * ⚠ FAILS LOUD, NEVER FALLS BACK WHOLESALE. `listAllProjectedTools()` returns
 * an EMPTY array when the agent-tools barrel has not registered
 * (EI-19377066316560032), and a silent fallback to the curated definitions
 * would produce exactly the vacuous green D-012 forbids — the run would look
 * like a compact-tier run and would not be one. A catalog below the plausible
 * floor throws.
 */
import type { BuiltCatalog } from './su-catalog';
import { sanitizeToolName } from './su-catalog';

/**
 * Below this, the registry did not finish registering. Kept well under the
 * real catalog size (~899 at authoring time) so ordinary catalog churn never
 * trips it, and well above any partial-registration slice.
 */
const MIN_PLAUSIBLE_CATALOG = 400;

export interface CompactTierProjection {
  /** The offered catalog, every definition projected onto its COMPACT form. */
  catalog: BuiltCatalog;
  /** Canonical names whose LIVE registry definition was projected. */
  usedLive: string[];
  /**
   * Canonical names absent from the live registry (plugin-provided tools such
   * as `design-phase:*` / `repomix:pack`), whose curated harness definition was
   * projected through the same functions instead. Reported so the evidence can
   * state its own coverage rather than imply the whole set was live.
   */
  fallback: string[];
  /** Serialized `{name, description, inputSchema}` bytes, before and after. */
  bytes: { full: number; compact: number };
  /** Tools the live registry advertises in total (the denominator's witness). */
  liveCatalogSize: number;
}

interface LiveDefinition {
  description?: string;
  inputSchema?: unknown;
}

/**
 * Memoised because the barrel import is the expensive part (~15 s) and a run
 * opens many sessions. Deliberately NOT `pinModuleState`: this is pure
 * memoisation of a deterministic read, so a duplicated module record costs one
 * recompute and can never split correctness — the condition that primitive
 * exists for.
 */
let liveDefinitionsPromise: Promise<Map<string, LiveDefinition>> | undefined;

async function loadLiveDefinitions(): Promise<Map<string, LiveDefinition>> {
  liveDefinitionsPromise ??= (async () => {
    // Side-effect import FIRST — it registers the catalog `listAllProjectedTools`
    // reads. Dynamic, because a bare static import of the barrel from here would
    // pull the whole agent-tool surface into every llm-testing consumer.
    await import('../../agent-tools/index.js');
    const { listAllProjectedTools } = await import('@papercusp/tooldef');
    const projected = listAllProjectedTools() as ReadonlyArray<{
      expose?: { mcp?: { name?: string } };
      description?: string;
      inputSchema?: unknown;
    }>;
    if (projected.length < MIN_PLAUSIBLE_CATALOG) {
      throw new Error(
        `su compact-tier catalog: the live registry returned only ${projected.length} tool(s), below the ` +
          `${MIN_PLAUSIBLE_CATALOG} floor — the agent-tools barrel did not finish registering. Refusing to ` +
          'project curated stand-ins as if they were the shipped definitions (that would be a vacuous green).',
      );
    }
    const live = new Map<string, LiveDefinition>();
    for (const t of projected) {
      const name = t.expose?.mcp?.name;
      if (name) live.set(name, { description: t.description, inputSchema: t.inputSchema });
    }
    return live;
  })();
  return liveDefinitionsPromise;
}

/** Exported for tests only — drop the memoised registry read. */
export function __resetLiveDefinitionsCache(): void {
  liveDefinitionsPromise = undefined;
}

function wireBytes(name: string, description: string, inputSchema: unknown): number {
  return Buffer.byteLength(JSON.stringify({ name, description, inputSchema }));
}

/**
 * Project an offered catalog onto the COMPACT delivery tier.
 *
 * Operates on a `BuiltCatalog` rather than on `SuCatalogEntry[]` so every
 * SuTarget-derived SUT (su, onboarding-tutor, pui-loop) can be projected with
 * no per-target wiring, and so the caller's own `opts.catalog` override is
 * honoured instead of silently replaced by `SU_CATALOG`.
 */
export async function projectCatalogToCompactTier(
  catalog: BuiltCatalog,
): Promise<CompactTierProjection> {
  const live = await loadLiveDefinitions();
  const { summaryGuidanceDescription, compactInputSchema } = await import('@papercusp/tooldef');

  const usedLive: string[] = [];
  const fallback: string[] = [];
  let fullBytes = 0;
  let compactBytes = 0;

  const tools: BuiltCatalog['tools'] = catalog.tools.map((t) => {
    const canonical = catalog.canonicalBySanitized.get(t.name) ?? t.name;
    const liveRow = live.get(canonical);
    if (liveRow) usedLive.push(canonical);
    else fallback.push(canonical);

    const sourceDescription = liveRow ? (liveRow.description ?? '') : t.description;
    const sourceSchema = liveRow ? (liveRow.inputSchema ?? {}) : t.input_schema;

    const description = summaryGuidanceDescription(sourceDescription);
    const projected = compactInputSchema(sourceSchema);
    // Anthropic requires input_schema.type === 'object'; the compact projection
    // preserves it, but a tool whose source schema was not an object would
    // otherwise smuggle a malformed request into the run and fail as if the
    // model had erred.
    const input_schema =
      projected && typeof projected === 'object' && (projected as { type?: unknown }).type === 'object'
        ? (projected as Record<string, unknown>)
        : { type: 'object' as const };

    fullBytes += wireBytes(canonical, sourceDescription, sourceSchema);
    compactBytes += wireBytes(canonical, description, input_schema);

    return { name: sanitizeToolName(canonical), description, input_schema };
  });

  return {
    catalog: { tools, canonicalBySanitized: catalog.canonicalBySanitized },
    usedLive,
    fallback,
    bytes: { full: fullBytes, compact: compactBytes },
    liveCatalogSize: live.size,
  };
}
