/**
 * plans:search — keyword search across plan content.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 * Scope-aware: search within { title, now, items, decisions, prose }
 * subsets. Defaults to all.
 *
 * Implementation note: this is a small-corpus search (~50 plans).
 * A real BM25 is overkill — we use TF-style scoring with case-
 * insensitive token matching and a position-weighted boost for
 * title/now hits. If/when corpus size or query complexity grows,
 * lift this to a proper index.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readAllPlans } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';

const SCOPES = ['title', 'now', 'items', 'decisions', 'prose'] as const;
type Scope = (typeof SCOPES)[number];

const argsSchema = z.object({
  query: z.string().min(1).describe('Search query (case-insensitive, whitespace-tokenized).'),
  scope: z
    .array(z.enum(SCOPES as unknown as [Scope, ...Scope[]]))
    .optional()
    .describe('Scopes to search. Default: all.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results. Default 20.'),
  includeArchived: z.boolean().optional().describe('Search archived plans too. Default true (the dispersal problem was *unfindable*).'),
  includeLegacy: z.boolean().optional().describe('Search legacy plans (prose only). Default true.'),
  harness: harnessArg,
});

interface Hit {
  plan: string;
  score: number;
  matches: Array<{ scope: Scope; snippet: string }>;
  /** Matches beyond MAX_MATCHES_PER_PLAN that were trimmed to keep the
   *  response under the token limit (a high-hit plan can match dozens of
   *  items/decisions). 0 → omitted. */
  matches_omitted?: number;
}

// Bound the per-plan snippet count: matches are pushed in scope order
// (title → now → items → decisions → prose), so the first few are the
// highest-signal. A plan matching 50 items previously emitted 50 snippets;
// across the default 20 results that overflowed the token limit.
const MAX_MATCHES_PER_PLAN = 4;

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
}

function scoreScope(text: string, queryTokens: string[]): number {
  if (!text) return 0;
  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;
  // Term-frequency tally: count every occurrence of every query token,
  // not just distinct presence. A doc that mentions `mem0` 20× should
  // rank above one that mentions it once — the prior Set-based check
  // gave both the same `1`, burying high-relevance plans in the long
  // score-1 tail.
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let hits = 0;
  for (const q of queryTokens) hits += tf.get(q) ?? 0;
  return hits;
}

function snippet(text: string, queryTokens: string[], maxLen = 160): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const q of queryTokens) {
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + maxLen - 40);
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }
  }
  return text.slice(0, maxLen);
}

export default defineTool({
  name: 'plans:search',
  description:
    'Search across SU plans by keyword. Scopes: title, now, items, decisions, prose. Includes archived + legacy by default.',
  guidance: {
    when: 'You\'re looking for prior work, decisions, or items by topic and don\'t have a slug.',
    notWhen:
      'You already know the slug — use plans:get. For full prose recall across the project (chats, escalations), use search:fulltext.',
    chaining:
      'plans:search { query } → plans:get { slug } on the top hit.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const scopes: Scope[] = (args.scope as Scope[] | undefined) ?? [...SCOPES];
    const limit = args.limit ?? 20;
    const includeArchived = args.includeArchived !== false;
    const includeLegacy = args.includeLegacy !== false;
    const queryTokens = tokenize(args.query);
    if (queryTokens.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ hits: [] }) }],
      };
    }

    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);
    const parsedPlans = await readAllPlans({ includeArchived, ...opts });
    const hits: Hit[] = [];

    for (const { parsed } of parsedPlans) {
      if (parsed.isLegacy && !includeLegacy) continue;

      const matches: Hit['matches'] = [];
      let score = 0;

      if (parsed.isLegacy) {
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      } else {
        if (scopes.includes('title') && parsed.frontmatter.title) {
          const s = scoreScope(parsed.frontmatter.title, queryTokens);
          if (s > 0) {
            score += s * 4;
            matches.push({ scope: 'title', snippet: parsed.frontmatter.title });
          }
        }
        if (scopes.includes('now') && parsed.now) {
          const text = parsed.now.raw;
          const s = scoreScope(text, queryTokens);
          if (s > 0) {
            score += s * 3;
            matches.push({ scope: 'now', snippet: snippet(text, queryTokens) });
          }
        }
        if (scopes.includes('items')) {
          for (const it of parsed.items) {
            const s = scoreScope(it.text, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({ scope: 'items', snippet: `${it.id}: ${snippet(it.text, queryTokens, 120)}` });
            }
          }
        }
        if (scopes.includes('decisions')) {
          for (const d of parsed.decisions) {
            const s = scoreScope(d.title + ' ' + d.body, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({ scope: 'decisions', snippet: `${d.id} ${d.title}: ${snippet(d.body, queryTokens, 120)}` });
            }
          }
        }
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      }

      if (score > 0) {
        const omitted = Math.max(0, matches.length - MAX_MATCHES_PER_PLAN);
        hits.push({
          plan: parsed.frontmatter.slug ?? parsed.slug,
          score,
          matches: omitted > 0 ? matches.slice(0, MAX_MATCHES_PER_PLAN) : matches,
          ...(omitted > 0 ? { matches_omitted: omitted } : {}),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const trimmed = hits.slice(0, limit);

    ctxAny.metadata?.({ query: args.query, scopes, count: trimmed.length });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ hits: trimmed }) }],
    };
  },
});
