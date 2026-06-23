/**
 * capture-recipe.ts — the code:run → recipe CAPTURE path
 * (code-recipes-2026-06-21 Phase 1, P-003).
 *
 * On a SUCCESSFUL, non-dry-run code:run the handler ALWAYS saves the script as a
 * reusable recipe (D-012: every run saves; the only non-save path is a Phase-2
 * dedup-reuse). title + description are OPTIONAL on the tool — when the agent
 * omits them we DERIVE a deterministic fallback so a recipe is always captured
 * and the call never fails for a missing title (non-breaking for the live
 * fleet's existing code:run calls).
 *
 * Everything here is BEST-EFFORT: `captureRecipe` wraps the whole thing in
 * try/catch (logs + swallows) so capture can NEVER break a code:run. The pure
 * helpers (slug/title/description derivation, tools_used extraction) are split
 * out so they unit-test without PG or an embedder.
 *
 * Server-only.
 */
import { createHash } from 'node:crypto';
import type { ProjectedTool } from '@papercusp/agent-mcp';
import { checkScript } from '@papercusp/tooldef';
import {
  upsertRecipe,
  recordRecipeRun,
  type CodeRecipeRow,
} from '../../code-recipes-store';
import { searchSimilarRecipes, type SimilarRecipe } from '../../code-recipes-search';

/** Stable kebab slug from a title (the recipe PRIMARY KEY). Matches the
 *  plans:apply-plan-block toKebab so recipe ids look like every other slug. */
export function recipeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Resolve the recipe PRIMARY KEY id (P-003 collision-fix).
 *
 * When the agent GAVE a title, `id = recipeSlug(title)` — the intended EXPLICIT
 * dedup key (re-running the same titled recipe upserts in place, bumping its
 * run_count). When the title was AUTO-DERIVED (no `given.title`), suffix the slug
 * with a short content-hash of the script: two DIFFERENT scripts that happen to
 * derive the SAME tool-set fallback title (`recipe: a + b`) must not clobber each
 * other and pollute one another's run_count. Cross-title semantic dedup is the
 * SearchSource (#1); this only stops auto-derived-title collisions.
 */
export function recipeId(
  title: string,
  description: string,
  script: string,
  given: { title?: string },
): string {
  const base = recipeSlug(title) || recipeSlug(description) || 'untitled-recipe';
  if (given.title?.trim()) return base; // explicit title ⇒ stable dedup key
  const hash = createHash('sha1').update(script).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` — mirrors parse-check. */
const camelVerb = (verb: string): string =>
  verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());

/**
 * The canonical `ns:verb` tool names a script references, via the SAME static
 * resolver the parse-check uses (`checkScript` resolves dotted access, the
 * `tools.call('ns:verb')` hatch, aliasing, and destructuring). `checkScript`
 * returns `refs` in MEMBER form (`ns.camelVerb`) for dotted access and FULL form
 * (`ns:verb`) for the call-hatch; we reverse-map members back to canonical full
 * names via the same camelVerb keying the parse-check builds internally, and keep
 * any already-canonical full names as-is. Result is sorted + de-duped.
 */
export function extractToolsUsed(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): string[] {
  const memberToName = new Map<string, string>(); // "ns.camelVerb" → full "ns:verb"
  const fullNames = new Set<string>();
  for (const t of tools) {
    const name = t.expose?.mcp?.name;
    if (!name || name.indexOf(':') <= 0) continue;
    if (allowed && !allowed.has(name)) continue;
    const ci = name.indexOf(':');
    memberToName.set(`${name.slice(0, ci)}.${camelVerb(name.slice(ci + 1))}`, name);
    fullNames.add(name);
  }
  const out = new Set<string>();
  for (const ref of checkScript(script, tools, allowed).refs) {
    if (ref.includes(':')) {
      if (fullNames.has(ref)) out.add(ref); // call-hatch full name
    } else {
      const full = memberToName.get(ref); // dotted member → canonical
      if (full) out.add(full);
    }
  }
  return [...out].sort();
}

/** First `// …` line comment in the script, trimmed — the agent's own label. */
function firstCommentTitle(script: string): string | null {
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//')) {
      const text = line.replace(/^\/+\s*/, '').trim();
      if (text) return text.slice(0, 120);
    }
    // stop at the first non-blank, non-comment line — the title is a leading comment
    if (line && !line.startsWith('//')) break;
  }
  return null;
}

/**
 * Derive a fallback title + description when the agent omits them, so a recipe is
 * ALWAYS captured. Preference: the script's first `//` comment for the title,
 * else the sorted tool-set ("recipe: <tools>"); the description names the tools.
 */
export function deriveTitleDescription(
  script: string,
  toolsUsed: string[],
  given: { title?: string; description?: string },
): { title: string; description: string } {
  const toolList = toolsUsed.length > 0 ? toolsUsed.join(', ') : 'no tools';
  const title =
    given.title?.trim() ||
    firstCommentTitle(script) ||
    (toolsUsed.length > 0 ? `recipe: ${toolsUsed.join(' + ')}`.slice(0, 120) : 'untitled recipe');
  const description =
    given.description?.trim() || `auto-captured recipe: calls ${toolList}`;
  return { title, description };
}

export interface CaptureRecipeDeps {
  /** PG handle (caller passes getOrgPg().sql — RLS-bypass; the store filters by workspace). */
  sql: import('postgres').Sql;
  /** Resolve the embedding for `title\ndescription` (384-dim) or null when unavailable. */
  embed: (text: string) => Promise<number[] | null>;
  /** harness → home-hive slug (the sharing boundary), or null. */
  resolveHive: (workspaceId: string, harness: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

export interface CaptureRecipeInput {
  script: string;
  workspaceId: string;
  harness: string | null;
  /** The acting agent's coord ownerId (distinct-agent + author attribution). */
  ownerId: string | null;
  /** The acting agent's role. */
  role: string | null;
  /** Agent-supplied title/description (optional — derived when absent). */
  title?: string;
  description?: string;
  /** All projected tools + the role-scoped allow-list (for tools_used extraction). */
  tools: readonly ProjectedTool[];
  allowed?: ReadonlySet<string>;
}

export interface CaptureRecipeResult {
  /** The upserted recipe row. */
  row: CodeRecipeRow;
  /**
   * Top-N prior recipes that ALREADY do something similar (semantic + structural
   * dedup, P-004 / D-003). SOFT/ADVISORY — surfaced in the code:run result so the
   * LLM can choose `recipes:run(<id>)` next time instead of re-authoring. Empty
   * when nothing was similar (or the search degraded). EXCLUDES the just-upserted
   * recipe itself.
   */
  similarRecipes: SimilarRecipe[];
}

/**
 * Capture a successful code:run as a recipe AND surface near-duplicates (P-004).
 * ALWAYS best-effort: any failure is logged + swallowed so capture never breaks
 * the run. Returns the saved row + the top similar recipes (or null when capture
 * was skipped/failed).
 *
 * The embedding is computed ONCE (`title\ndescription`, 384-dim) and reused for
 * BOTH the dedup search and the upsert. Dedup runs BEFORE the upsert — excluding
 * the new recipe's id — so a re-run of an existing recipe doesn't match itself,
 * and the result reflects the PRIOR corpus. Dedup is SOFT: a search failure
 * degrades to `similarRecipes: []` and never blocks the capture/run.
 */
export async function captureRecipe(
  deps: CaptureRecipeDeps,
  input: CaptureRecipeInput,
): Promise<CaptureRecipeResult | null> {
  const log = deps.log ?? (() => {});
  try {
    const toolsUsed = safe(() => extractToolsUsed(input.script, input.tools, input.allowed), []);
    const { title, description } = deriveTitleDescription(input.script, toolsUsed, {
      title: input.title,
      description: input.description,
    });
    // P-003 collision-fix: explicit title ⇒ slug; auto-derived ⇒ slug+scriptHash.
    const id = recipeId(title, description, input.script, { title: input.title });

    const hiveSlug = input.harness
      ? await deps.resolveHive(input.workspaceId, input.harness).catch(() => null)
      : null;

    // Compute the embedding ONCE and reuse it for both dedup + the upsert.
    const embedding = await deps.embed(`${title}\n${description}`).catch(() => null);

    // DEDUP (SOFT, P-004): rank prior recipes BEFORE the upsert (exclude the new
    // id so a re-run never matches itself). Best-effort — a failure must not break
    // the run, so degrade to [].
    let similarRecipes: SimilarRecipe[] = [];
    try {
      similarRecipes = await searchSimilarRecipes(
        deps.sql,
        {
          title,
          description,
          toolsUsed,
          embedding,
          excludeId: id,
          limit: 5,
        },
        { log },
      );
    } catch (err) {
      log(`code:run recipe dedup failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    }

    const row = await upsertRecipe(deps.sql, {
      id,
      title,
      description,
      script: input.script,
      authorRole: input.role,
      toolsUsed,
      embedding,
      createdBy: input.ownerId,
    });

    await recordRecipeRun(deps.sql, {
      recipeId: id,
      workspaceId: input.workspaceId,
      hiveSlug,
      agentOwner: input.ownerId,
      agentRole: input.role,
      success: true,
      reused: false,
    });

    // Live-update the /admin/recipes dashboard (code-recipes-2026-06-21 P-009):
    // a fresh capture / re-run shifts the recipe list AND the candidate worklist,
    // so invalidate both sync queries. Best-effort + lazy-imported so the pure
    // capture helper stays PG-only and unit-testable without the sync-sse bus.
    await notifyRecipesChanged(log);

    return { row, similarRecipes };
  } catch (err) {
    log(`code:run recipe capture failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Fire the sync-invalidation for BOTH recipe dashboard queries after a recipe
 * write (capture, sweep, or merge) commits — the SINGLE invalidate point so every
 * write site stays consistent (code-recipes-2026-06-21 P-009). A list change can
 * also change the candidate worklist (a swept/merged recipe drops out, a re-run
 * crosses the promote threshold), so both names are invalidated together. Lazy
 * import + best-effort: a missing/erroring bus must NEVER break the underlying
 * write (the capture path is already wrapped in try/catch; the tools call this
 * AFTER their commit returns).
 */
export async function notifyRecipesChanged(log: (msg: string) => void = () => {}): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('codeRecipes');
    await notifySyncInvalidate('recipeCandidates');
  } catch (err) {
    log(`recipe sync-invalidate failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
  }
}
