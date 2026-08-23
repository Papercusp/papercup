/**
 * Exact-slug scope recovery for the plans:* read tools.
 *
 * EI-21194994217912029: a recovery call often has an exact plan slug but NO
 * resolvable harness — `plans:get`/`plans:items` answered `harness_required`,
 * and the documented `harness:'all'` escape is rejected as `harness_forbidden`
 * in a workspace-scoped session. Correct state (per the filing): exact-slug
 * recovery RESOLVES the scope itself from the PG-canonical plan index, and
 * when it cannot, the error reports what it searched and found instead of
 * demanding an undiscoverable input.
 *
 * Explicit-`harness` calls and harness-scoped sessions never enter this path
 * (the handlers consult it only when resolveHarnessScope returns 'none').
 */

import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { planHarnessesForSlugs } from './source';

/** Per-slug candidate harnesses, most-recently-updated first — index 0 is the
 *  same deterministic pick `resolvePlanHarnessSlug` makes. */
export type SlugCandidates = Record<string, string[]>;

export type SlugScopeDecision =
  | {
      /** Every requested slug is store-backed and resolves to ONE harness. */
      status: 'resolved';
      harnessSlug: string;
      bySlug: Record<string, string>;
      /** Slugs whose mapping was ambiguous (store-backed rows in >1 harness). */
      ambiguous: SlugCandidates;
    }
  | {
      status: 'missing';
      missing: string[];
      /** Slugs that DID resolve, for context in the error. */
      found: Record<string, string>;
      workspaceId: string;
    }
  | { status: 'split'; mapping: Record<string, string>; workspaceId: string };

/**
 * Pure decision over the candidate map. Ambiguity inside a single slug does
 * NOT block resolution: index 0 wins (the `resolvePlanHarnessSlug`
 * most-recently-updated precedent), but the ambiguity is carried on the
 * resolved decision so handlers can surface it in metadata.
 */
export function decideSlugScope(
  slugs: readonly string[],
  candidates: SlugCandidates,
  workspaceId = '',
): SlugScopeDecision {
  const bySlug: Record<string, string> = {};
  const ambiguous: SlugCandidates = {};
  const missing: string[] = [];
  for (const slug of slugs) {
    const list = candidates[slug] ?? [];
    if (list.length === 0) {
      missing.push(slug);
      continue;
    }
    bySlug[slug] = list[0];
    if (list.length > 1) ambiguous[slug] = list;
  }
  if (missing.length > 0) {
    return { status: 'missing', missing, found: bySlug, workspaceId };
  }
  const distinct = [...new Set(Object.values(bySlug))];
  if (distinct.length > 1) {
    return { status: 'split', mapping: bySlug, workspaceId };
  }
  return { status: 'resolved', harnessSlug: distinct[0], bySlug, ambiguous };
}

/** The workspace the recovery searches: a concrete session workspace passes
 *  through; an unscoped ('*') session searches the operator's own workspace —
 *  the same default resolvePlanScope applies for operator-home scope. */
function callerWorkspaceId(ctx: unknown): string {
  const raw = (ctx as { workspaceId?: string | null }).workspaceId?.trim();
  return raw && raw !== '*' ? raw : PAPERCUSP_WORKSPACE_ID;
}

/**
 * Run the recovery for a handler whose harness scope came back 'none'.
 * One indexed query; absent or invalid slugs are not an error here — they
 * come back as a 'missing' decision.
 */
export async function recoverHarnessFromSlugs(
  ctx: unknown,
  slugs: readonly string[],
): Promise<SlugScopeDecision> {
  const workspaceId = callerWorkspaceId(ctx);
  const rowsBySlug = await planHarnessesForSlugs(workspaceId, slugs);
  const candidates: SlugCandidates = {};
  for (const [slug, list] of rowsBySlug) candidates[slug] = list;
  return decideSlugScope(slugs, candidates, workspaceId);
}

/**
 * The fail-loud error result for the non-resolved outcomes — same envelope
 * convention as `_harness-scope.ts`'s harnessRequiredResult. Each names what
 * was searched and what was found, so the caller never has to guess the next
 * input (the exact complaint EI-21194994217912029 recorded).
 */
export function slugScopeErrorResult(
  toolName: string,
  decision: Extract<SlugScopeDecision, { status: 'missing' | 'split' }>,
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const hint =
    "Pass an explicit `harness` on this call (for example 'papercusp' for " +
    "Papercusp's own plans), or find the slug via cross_harness:plans_search.";
  const body =
    decision.status === 'missing'
      ? {
          error: 'plan_not_found_in_workspace',
          missing: decision.missing,
          ...(Object.keys(decision.found).length > 0 ? { foundIn: decision.found } : {}),
          detail:
            `No store-backed plan named ${decision.missing.map((s) => `'${s}'`).join(', ')} ` +
            `in workspace '${decision.workspaceId}' — exact-slug auto-resolution found no owning ` +
            `harness there. ${hint}`,
        }
      : {
          error: 'harness_split_across_plans',
          mapping: decision.mapping,
          detail:
            `The requested slugs live in different harnesses (${JSON.stringify(decision.mapping)}); ` +
            'one call reads a single harness — pass an explicit `harness`, or split the slugs across calls.',
        };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ tool: toolName, ...body }) }],
  };
}
