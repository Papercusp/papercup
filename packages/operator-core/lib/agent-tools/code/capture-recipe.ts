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
import type { ProjectedTool } from '@papercusp/agent-mcp';
import { checkScript } from '@papercusp/tooldef';
import {
  upsertRecipe,
  recordRecipeRun,
  type CodeRecipeRow,
} from '../../code-recipes-store';

/** Stable kebab slug from a title (the recipe PRIMARY KEY). Matches the
 *  plans:apply-plan-block toKebab so recipe ids look like every other slug. */
export function recipeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
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

/**
 * Capture a successful code:run as a recipe. ALWAYS best-effort: any failure is
 * logged + swallowed so capture never breaks the run. Returns the saved row (or
 * null when capture was skipped/failed). DEDUP is NOT done here (Phase 2) — this
 * only upserts + records the run.
 */
export async function captureRecipe(
  deps: CaptureRecipeDeps,
  input: CaptureRecipeInput,
): Promise<CodeRecipeRow | null> {
  const log = deps.log ?? (() => {});
  try {
    const toolsUsed = safe(() => extractToolsUsed(input.script, input.tools, input.allowed), []);
    const { title, description } = deriveTitleDescription(input.script, toolsUsed, {
      title: input.title,
      description: input.description,
    });
    const id = recipeSlug(title) || recipeSlug(description) || 'untitled-recipe';

    const hiveSlug = input.harness
      ? await deps.resolveHive(input.workspaceId, input.harness).catch(() => null)
      : null;

    const embedding = await deps.embed(`${title}\n${description}`).catch(() => null);

    const row = await upsertRecipe(deps.sql, {
      id,
      workspaceId: input.workspaceId,
      hiveSlug,
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

    return row;
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
