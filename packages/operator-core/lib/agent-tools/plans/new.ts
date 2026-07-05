/**
 * plans:new — create a new plan from a template.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Slug uniqueness check + frontmatter write happen inside one
 * locks:acquire on the destination path (§4.4). Two concurrent
 * calls with the same slug get one winner; the loser sees the file
 * already exists.
 *
 * The body it writes is the exact bytes a human would type — same
 * template as the worked example in §3.7 of the plan spec.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import * as fs from 'node:fs/promises';
import { withPlanLock } from './with-plan-lock';
import { listPlanIndexRows } from './source';
import { PLAN_STATUSES } from './parser';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitPlanAuthored } from '../../harness/usage-emitters';

/**
 * A boolean flag that ALSO accepts the exact wire strings `'true'`/`'false'`.
 *
 * EI-302: a long-lived MCP session's `tools/list` schema is manifest-PINNED
 * (tool-manifest.ts freezes the exposed surface so the prompt-prefix cache
 * stays warm), so a session that began before `force` was added to plans:new
 * cannot see `force` in its cached schema. An agent that passes `force` anyway
 * sends the JSON string `"true"` (the value was never typed as a boolean), and
 * a bare `z.boolean()` rejected it → the dispatch layer threw `invalid_args`
 * (define-tool.ts), forcing a hand-call of the raw HTTP MCP projection.
 *
 * Coerce ONLY the two exact strings — never `z.coerce.boolean()`, whose
 * `"false"` → `true` footgun is exactly why `_plans-args.ts` keeps an explicit
 * allowlist instead. Every other value (including a real boolean, or a typo
 * like `"yes"`) passes through to `z.boolean()` unchanged, so a genuine mistake
 * still fails loudly AND the advertised JSON schema stays `type: boolean`
 * (the `tools/list` projection renders the pipe's boolean output).
 */
const stringTolerantBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

export const argsSchema = z.object({
  harness: harnessArg,
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'kebab-case, ends with alphanum')
    .describe(
      'Topic slug in kebab-case. A -YYYY-MM-DD suffix is appended automatically if not already present (plan filename convention, §3.1).',
    ),
  title: hardText(LIMITS.SHORT_TITLE),
  status: z.enum([...PLAN_STATUSES] as [string, ...string[]]).optional(),
  owner: z.string().email().optional(),
  rationale: z
    .string()
    .optional()
    .describe(
      "Optional — why this plan exists / what prompted its creation. Stored as the rationale of the plan's first revision (D-009).",
    ),
  body: z
    .string()
    .max(200_000)
    .optional()
    .describe(
      'Optional — the FULL plan body (the markdown BELOW the frontmatter: ## Now, ## Background, ## Phase 1 with items, ## Decisions). When provided, plans:new writes valid frontmatter + this body in ONE call, so you do NOT need a follow-up plans:set-content round-trip. Do NOT include your own --- frontmatter block — it is generated from slug/title/status/owner. Omit to get the empty starter template.',
    ),
  force: stringTolerantBool
    .optional()
    .describe(
      'Creation is rejected with `similar_exists` + the overlapping plans when existing slugs/titles share this topic (EI-134 — duplicate plans split project history). Review the candidates; pass force: true only when this is genuinely a NEW effort, not a continuation. Accepts the wire strings "true"/"false" too (EI-302: stale manifest-pinned tools/list schemas).',
    ),
});

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Ensure a slug carries the §3.1 `-YYYY-MM-DD` filename suffix.
 * Appends `today` when the slug doesn't already end with a date, so
 * the plan filename convention holds regardless of what the caller
 * passed. Exported for unit testing.
 */
export function ensureDatedSlug(slug: string, today: string): string {
  return /-\d{4}-\d{2}-\d{2}$/.test(slug) ? slug : `${slug}-${today}`;
}

function buildFrontmatter(args: {
  slug: string;
  title: string;
  status: string;
  owner: string | null;
  date: string;
}): string {
  const ownerLine = args.owner ? `owner: ${args.owner}\n` : '';
  return `---
title: ${args.title}
slug: ${args.slug}
status: ${args.status}
created: ${args.date}
updated: ${args.date}
${ownerLine}---
`;
}

export function buildTemplate(args: {
  slug: string;
  title: string;
  status: string;
  owner: string | null;
  date: string;
  /** When provided, use this as the whole body BELOW the frontmatter instead of
   *  the empty starter template (one-call create-with-content). */
  body?: string;
}): string {
  const fm = buildFrontmatter(args);
  if (args.body != null && args.body.trim().length > 0) {
    // Caller supplied the full body — write frontmatter + body. Strip any
    // leading --- frontmatter the caller mistakenly included (we own it), and
    // guarantee exactly one blank line between frontmatter and body.
    const raw = args.body.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\n+/, '');
    return `${fm}\n${raw}\n`;
  }
  return `${fm}
# ${args.title}

## Now

**State:** Draft. Plan body to be filled in.

**Next:** human reviews scope and lists Phase 1 items.

## Background

(Why this plan exists; what problem it addresses.)

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)
`;
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type NewPlanValue = { ok: true; slug: string } | { ok: false; code: 'slug_exists' };

/** Stopwords + boilerplate that would over-match between any two plans. */
const DEDUP_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'over', 'under',
  'plan', 'plans', 'fix', 'fixes', 'new', 'add', 'update', 'phase',
]);

/** Meaningful topic tokens from a slug + title (date suffix dropped). */
export function dedupTokens(slug: string, title: string): string[] {
  const text = `${slug.replace(/-\d{4}-\d{2}-\d{2}$/, '')} ${title}`.toLowerCase();
  return [
    ...new Set(
      text
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !DEDUP_STOPWORDS.has(t)),
    ),
  ];
}

export interface SimilarPlan {
  slug: string;
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Topic tokens shared with the proposed plan. */
  sharedTokens: string[];
}

/**
 * A token is "corpus-generic" only on a LARGE index — it appears in more than
 * GENERIC_DF_FRACTION of all plans. On a small corpus, document-frequency is
 * noise, so DF suppression is skipped entirely (nothing is generic) and the
 * matcher behaves exactly like the pre-P-003 absolute-count version.
 *
 * WHY (cross-platform-hardening-and-agent-ergonomics-2026-07-05 P-003): the old
 * matcher flagged `similar_exists` on any two shared tokens, so a plan like
 * `cross-platform-hardening-and-agent-ergonomics` false-matched unrelated plans
 * that merely also contain the project-ubiquitous words `agent`/`platform` — the
 * false positive that forced a spurious `force: true`. Suppressing corpus-generic
 * tokens (self-tuning, no stopword maintenance) fixes the class without regressing
 * EI-134 dup detection: a GENUINE duplicate always shares a *distinctive* topic
 * word (by definition not ubiquitous), so it still flags.
 */
const GENERIC_MIN_CORPUS = 25;
const GENERIC_DF_FRACTION = 0.25;

/**
 * Search-first dedup for plans:new (audit P-049 / EI-134) — like
 * improvements:capture, surface overlapping existing plans BEFORE a
 * duplicate splits the project history. Pure scoring over the index
 * rows' slug+title (no content).
 *
 * A candidate matches when it shares ≥2 TOPIC TOKENS (or the single token, for
 * one-token proposals) AND at least one shared token is DISTINCTIVE — i.e. not
 * corpus-generic (P-003). Matching is on tokenized SETS, not raw substrings, so
 * `cross` no longer matches `across` (the substring false-match class). Top 5 by
 * overlap, ties to non-archived.
 */
export function findSimilarPlans(
  tokens: string[],
  rows: Array<{ planSlug: string; title: string | null; status: string | null; archived: boolean }>,
): SimilarPlan[] {
  if (tokens.length === 0) return [];

  // Tokenize every row ONCE (reusing the same stopword/date/short-token filter),
  // then compute per-token document frequency across the corpus.
  const rowTokenSets = rows.map((r) => new Set(dedupTokens(r.planSlug, r.title ?? '')));
  const df = new Map<string, number>();
  for (const set of rowTokenSets) {
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const bigCorpus = rows.length >= GENERIC_MIN_CORPUS;
  const isGeneric = (t: string): boolean =>
    bigCorpus && (df.get(t) ?? 0) / rows.length > GENERIC_DF_FRACTION;

  const threshold = Math.min(2, tokens.length);
  const scored: Array<SimilarPlan & { n: number; d: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const rowSet = rowTokenSets[i]!;
    // Token-SET intersection (not substring): `cross` ∉ "across".
    const shared = tokens.filter((t) => rowSet.has(t));
    if (shared.length < threshold) continue;
    // Require ≥1 distinctive (non-corpus-generic) shared token. On a small corpus
    // isGeneric is always false, so this is a no-op and old behavior is preserved.
    const distinctive = shared.filter((t) => !isGeneric(t));
    if (distinctive.length === 0) continue;
    const r = rows[i]!;
    scored.push({
      slug: r.planSlug,
      title: r.title,
      status: r.status,
      archived: r.archived,
      sharedTokens: shared,
      n: shared.length,
      d: distinctive.length,
    });
  }
  // Rank: most distinctive overlap first, then most total overlap, then live plans.
  scored.sort((a, b) => b.d - a.d || b.n - a.n || Number(a.archived) - Number(b.archived));
  return scored.slice(0, 5).map(({ n: _n, d: _d, ...rest }) => rest);
}

export default defineTool({
  name: 'plans:new',
  description:
    'Create a new plan in the plan STORE. This is the ONLY way to create a plan — never write a plan file on disk yourself (a raw file is not registered in the store and collides here). Pass `body` to author the whole plan in ONE call (frontmatter is generated for you); omit it for an empty starter template. Slug uniqueness enforced inside a lock.',
  guidance: {
    when: 'Starting a new plan. The one-shot path: plans:new { slug, title, body } — pass the full markdown body (## Now / ## Background / ## Phase 1 items / ## Decisions) and it lands in one call, no set-content round-trip.',
    notWhen:
      'You want to edit an existing plan — use plans:set-content / set-now / add-decision / add-item. Never create a plan by writing a .md file under docs/plans/ — it is not in the store; always use this tool.',
    chaining:
      'Author-in-one: plans:new { slug, title, body }. Incremental: plans:new → plans:set-now → plans:add-item × N. Then plans:start to promote items to work-items.',
    seeAlso: [
      'plans:add-item (populate the plan with work items)',
      'plans:set-frontmatter (fill/adjust the templated frontmatter)',
      'plans:start (begin the plan once it is filled in)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const date = todayISO();
    const status = args.status ?? 'draft';
    // §3.1: plan filenames carry a -YYYY-MM-DD suffix; ensureDatedSlug
    // appends today's date when the caller didn't already include one.
    const slug = ensureDatedSlug(args.slug, date);

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);

    // Search-first dedup (audit P-049 / EI-134): surface overlapping plans
    // before creating. Index-only read (slug/title columns — no blobs);
    // archived plans count as candidates (a superseded plan on the same
    // topic is exactly the "this exists, continue it instead" signal).
    // Best-effort: an index-read failure never blocks creation.
    if (args.force !== true) {
      try {
        const rows = await listPlanIndexRows({
          ...(harnessSlug ? { harnessSlug } : {}),
          includeArchived: true,
        });
        const similar = findSimilarPlans(dedupTokens(slug, args.title), rows);
        if (similar.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'similar_exists',
                  slug,
                  similar,
                  hint:
                    'Existing plans overlap this topic. Continue one of them (plans:get → set-now/add-item), or re-call with force: true if this is genuinely a new effort.',
                }),
              },
            ],
            isError: true,
          };
        }
      } catch {
        /* dedup is advisory — never block creation on an index hiccup */
      }
    }

    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      slug,
      args.rationale,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<NewPlanValue>(
      ctx as never,
      {
        slug,
        intent: `plans:new ${slug}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        afterWrite: rev.afterWrite,
      },
      async (current): Promise<{ newBody: string | null; value: NewPlanValue }> => {
        if (current !== null) {
          // Slug collision — leave existing untouched, signal via value.
          return { newBody: null, value: { ok: false, code: 'slug_exists' } };
        }
        const body = buildTemplate({
          slug,
          title: args.title,
          status,
          owner: args.owner ?? null,
          date,
          ...(args.body != null ? { body: args.body } : {}),
        });
        return { newBody: body, value: { ok: true, slug } };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    const value = result.value;
    if (!value.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: value.code, slug }),
          },
        ],
        isError: true,
      };
    }

    await emitPlanEventForCaller(ctx, {
      planSlug: value.slug,
      event: 'created',
      after: args.title,
      detail: args.title,
    });
    // P-070 usage ledger (best-effort): authoring a plan is contributor activity
    // on a managed harness. Operator-level plans (harness:'all') have no harness
    // slug and the ledger is per-harness, so skip those.
    if (harnessSlug) void emitPlanAuthored(harnessSlug, value.slug);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: value.slug,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
          }),
        },
      ],
    };
  },
});

// Re-export for test convenience; unused otherwise.
export { fs };
