/**
 * POST /api/desktop/docs-qa — retrieval-augmented "Ask a question" over the
 * REAL /internal/docs. Backs BOTH the terminal onboarding tutorial's
 * "Ask a question" and the Ctrl+/ search palette's ask mode. (WI-2844.)
 *
 * WHY THIS EXISTS — the failure it fixes:
 * The tutorial's Q&A used to shell out to a user-installed `claude`/`codex`/
 * `omp` CLI (`which(1)`), which (a) is ABSENT in a clean release build (a fresh
 * user hasn't installed one) → "no agent backend", and (b) even when present, a
 * bare `claude -p` has none of the papercusp docs MCP tools, so it could not
 * actually search our real docs.
 *
 * THE FIX — retrieval-augmented, server-side:
 *   1. RETRIEVE the most relevant real-doc snippets IN-PROCESS via the same
 *      docs-engine `searchDocs` the palette/`docs:search` use (engineeringAdapter
 *      → apps/operator-docs content, baseUrl /internal/docs).
 *   2. GROUND a single prompt on those snippets (the agent needs no doc tools —
 *      the docs are already IN the prompt, so real-doc grounding is guaranteed).
 *   3. ANSWER via `runAgentChat` on the OPERATOR's CONFIGURED backend (the one
 *      set during onboarding's LLM-auth step) — no superuser token, no npx, no
 *      CLI-on-PATH. Works in a clean build whenever ANY backend is configured;
 *      emits `needs_backend` (→ route to Setup) when none is.
 *
 *   POST /desktop/docs-qa
 *     body { question: string, sectionTitle?: string, docSlugs?: string[], currentPath?: string }
 *     → SSE: citation {slug,title,url} · delta {text} · needs_backend {} ·
 *            error {message} · done {}
 *
 * Gated on FLAGS.DOCS_QA (default ON). OFF ⇒ 404 (keyword search still works).
 * `auth: {}` — matches the sibling /desktop/* endpoints the tutorial runner and
 * the desktop webviews already call.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { searchDocs } from '@papercusp/docs-engine';
import { engineeringAdapter } from '../../../agent-tools/docs/_engineering-adapter';
import { runAgentChat } from '../../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../../agent-config';
import { claudeSignedIn, codexSignedIn, ompSignedIn } from '../../../agent-auth-detect';

const NOT_FOUND = () => new Response(null, { status: 404 });

async function docsQaEnabled(): Promise<boolean> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  return getFlag(FLAGS.DOCS_QA, 'system');
}

/**
 * Is there ANY agent backend the operator can drive a turn on? Reuses the same
 * sign-in detection as /desktop/agent-auth-status (the Setup wizard's llm-auth
 * step). `PAPERCUSP_FAKE_LLM=1` always counts (the deterministic test seam).
 * Kept exported + pure-ish so tests can assert the needs_backend gate.
 */
export function backendAvailable(): boolean {
  if (process.env.PAPERCUSP_FAKE_LLM === '1') return true;
  try { if (claudeSignedIn()) return true; } catch { /* fs error → keep checking */ }
  try { if (codexSignedIn()) return true; } catch { /* */ }
  try { if (ompSignedIn()) return true; } catch { /* */ }
  return false;
}

export interface DocsContextBlock {
  slug: string;
  title: string;
  url: string;
  text: string;
}

/**
 * Retrieve the doc context for a question: the top keyword hits (excerpt), plus
 * the FULL body of the top `deepen` hits (truncated) for richer grounding, plus
 * any section-linked docSlugs the caller passed. In-process, no MCP. Bounded so
 * the composed prompt stays small.
 */
// Foundational docs seeded into EVERY tutorial/palette retrieval so core-vocabulary
// questions are always grounded, even when keyword search ranks them out. The
// owner-reported "what is a pot" failure (2026-07-05): keyword search returned
// agent-policies/plans-index/etc. and NOT branding.mdx — the one page that holds the
// whole lexicon table (Pot=project, Papercup=operator, Mug=brain, …) — so the model
// had to guess and confidently hallucinated. `branding` grounds every lexicon term.
export const FOUNDATIONAL_DOC_SLUGS = ['branding'] as const;

export async function retrieveDocsContext(
  question: string,
  opts: { docSlugs?: string[]; limit?: number; deepen?: number; bodyChars?: number; foundationalSlugs?: readonly string[]; signal?: AbortSignal } = {},
): Promise<DocsContextBlock[]> {
  const limit = opts.limit ?? 8;
  const deepen = opts.deepen ?? 3;
  const bodyChars = opts.bodyChars ?? 2200;
  const foundational = opts.foundationalSlugs ?? FOUNDATIONAL_DOC_SLUGS;
  const adapter = engineeringAdapter;

  let hits: Array<{ slug: string; url?: string; title?: string; excerpt?: string }> = [];
  try {
    const res = await searchDocs(adapter, { query: question, limit }, opts.signal ? { signal: opts.signal } : {});
    hits = Array.isArray(res?.hits) ? res.hits : [];
  } catch { hits = []; }

  // Seed with section-linked slugs (deduped, first) so the current section is
  // always represented even if it didn't rank for the raw query tokens, then the
  // foundational lexicon doc(s), then the ranked search hits.
  const orderedSlugs: string[] = [];
  const seen = new Set<string>();
  for (const s of opts.docSlugs ?? []) {
    if (s && !seen.has(s)) { seen.add(s); orderedSlugs.push(s); }
  }
  for (const s of foundational) {
    if (s && !seen.has(s)) { seen.add(s); orderedSlugs.push(s); }
  }
  for (const h of hits) {
    if (h.slug && !seen.has(h.slug)) { seen.add(h.slug); orderedSlugs.push(h.slug); }
  }

  const blocks: DocsContextBlock[] = [];
  let deepened = 0;
  for (const slug of orderedSlugs) {
    const hit = hits.find((h) => h.slug === slug);
    let title = hit?.title ?? slug;
    let url = hit?.url ?? `/internal/docs/${slug}`;
    let text = hit?.excerpt ?? '';
    // Fetch fuller body for the first `deepen` blocks (and for section-linked
    // slugs that had no excerpt) so the answer is grounded in real prose.
    if (deepened < deepen || !text) {
      try {
        const page = await adapter.getPage(slug);
        if (page) {
          title = page.title || title;
          url = page.url || url;
          const body = await adapter.getContent(page);
          if (body) { text = body.replace(/\s+/g, ' ').trim().slice(0, bodyChars); deepened += 1; }
        }
      } catch { /* keep the excerpt */ }
    }
    if (text) blocks.push({ slug, title, url, text });
    if (blocks.length >= limit) break;
  }
  return blocks;
}

/** Compose the grounded, retrieval-augmented prompt. Pure — unit-tested. */
export function composeDocsQaPrompt(
  question: string,
  ctx: { sectionTitle?: string; currentPath?: string; blocks: DocsContextBlock[] },
): string {
  const docBlock = ctx.blocks.length
    ? ctx.blocks
        .map((b) => `### ${b.title} (/internal/docs/${b.slug})\n${b.text}`)
        .join('\n\n')
    : '(no closely-matching pages were retrieved — answer from your general knowledge of Papercusp instead)';
  const section = ctx.sectionTitle
    ? `The user is currently reading the "${ctx.sectionTitle}" section of the onboarding tutorial.\n`
    : ctx.currentPath
      ? `The user is currently on: ${ctx.currentPath}\n`
      : '';
  // Prompt intent (owner-reported 2026-07-05: answers read like a canned "static
  // search" that deflects with "the documentation excerpt provided doesn't cover
  // this"). The fixes: (1) frame the model as a knowledgeable Papercusp teammate,
  // not a doc-lookup that can only parrot excerpts; (2) let it answer from general
  // Papercusp knowledge when retrieval is thin instead of dead-ending; (3) FORBID
  // leaking the retrieval mechanism ("the excerpt/provided documentation") — the
  // user can't see it, and that phrasing is exactly what made it feel like search.
  return (
    'You are a knowledgeable Papercusp teammate helping a user during onboarding. ' +
    'Answer their ONE question directly, helpfully, and in a natural voice — the way ' +
    'a colleague who knows the product well would explain it out loud.\n\n' +
    section +
    '\n## Reference material (your primary source of truth)\n\n' +
    `${docBlock}\n\n` +
    '## How to answer\n\n' +
    '- Answer the question directly, in 3–6 plain sentences, with no preamble.\n' +
    '- You have NO tools and cannot look anything up — do not narrate a process or say ' +
    '"let me check" / "let me confirm"; just state the answer immediately.\n' +
    '- Lead with the reference material above; where it is thin or missing, still give ' +
    'the best genuinely useful answer you can from it plus your own knowledge of ' +
    'Papercusp — do NOT refuse, stall, or dead-end.\n' +
    '- NEVER mention "the excerpts", "the provided documentation", "the retrieved ' +
    'docs", or that anything was looked up — the user cannot see any of that. Just ' +
    'answer as if you simply know it.\n' +
    '- When a specific page backs your answer, cite it inline by its ' +
    '`/internal/docs/<slug>` path so the user can read more.\n' +
    '- Only if the question is genuinely outside Papercusp entirely, say what you do ' +
    'know and point to the nearest area — never reply that "the docs don\'t cover this".\n\n' +
    `## Question\n\n${question}`
  );
}

const docsQa = defineTool({
  method: 'POST',
  path: '/desktop/docs-qa',
  auth: {},
  // Pure SSE transport — don't flood route_invocations per question.
  sampleRate: 0,
  async handler(req) {
    if (!(await docsQaEnabled())) return NOT_FOUND();
    const body = await req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return Response.json({ error: 'question required' }, { status: 400 });
    const sectionTitle = typeof body.sectionTitle === 'string' ? body.sectionTitle : undefined;
    const currentPath = typeof body.currentPath === 'string' ? body.currentPath : undefined;
    const docSlugs = Array.isArray(body.docSlugs)
      ? body.docSlugs.filter((s: unknown): s is string => typeof s === 'string').slice(0, 8)
      : [];

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        // No configured backend → tell the caller to set one up (route to Setup).
        if (!backendAvailable()) {
          sink.event('needs_backend', {
            message:
              'No agent backend is configured yet. Sign in to an agent (Claude, Codex, or OMP) ' +
              'in Setup to ask questions — keyword search works without one.',
          });
          sink.close();
          return;
        }

        // 1. Retrieve real-doc context in-process.
        let blocks: DocsContextBlock[] = [];
        try {
          blocks = await retrieveDocsContext(question, { docSlugs, signal: req.signal });
        } catch { blocks = []; }
        // Surface the sources up-front so the palette/tutorial can show citations
        // even before the answer streams.
        for (const b of blocks) sink.event('citation', { slug: b.slug, title: b.title, url: b.url });

        // 2. Ground the prompt. 3. Answer on the operator's configured backend.
        const promptText = composeDocsQaPrompt(question, { sectionTitle, currentPath, blocks });
        const backend = await surfaceBackend('oracle');
        const model = await surfaceModel('oracle');

        // NEVER hang the caller. The tutorial/palette showed "Searching the
        // docs…" FOREVER when the backend stalled between the citations and the
        // first token (rate-limited / wedged / gateway saturated) — the SSE
        // heartbeats keep the socket open, so with no client-side deadline the
        // spinner spins indefinitely (owner-reported 2026-07-05). Abort the turn
        // on a HARD deadline AND a shorter FIRST-TOKEN deadline so a stalled
        // backend degrades to an `error` the caller falls back on, instead of an
        // infinite spinner. Chains off req.signal so a client disconnect still
        // tears the spawn down.
        const ac = new AbortController();
        const onReqAbort = () => ac.abort();
        req.signal?.addEventListener('abort', onReqAbort);
        const HARD_MS = 90_000;
        const FIRST_TOKEN_MS = 35_000;
        let sawDelta = false;
        const hardTimer = setTimeout(() => ac.abort(), HARD_MS);
        let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          if (!sawDelta) ac.abort();
        }, FIRST_TOKEN_MS);
        const clearFirstToken = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
        };
        try {
          for await (const ev of runAgentChat({
            promptText,
            ...(model ? { model } : {}),
            ...(backend ? { backend } : {}),
            allowedTools: [],
            permissionMode: 'bypassPermissions',
            signal: ac.signal,
          })) {
            if (ev.type === 'delta') {
              if (!sawDelta) {
                sawDelta = true;
                clearFirstToken();
              }
              sink.event('delta', { text: ev.text });
            } else if (ev.type === 'error') {
              sink.event('error', { message: ev.message });
            }
          }
        } catch (err) {
          // A client disconnect (req.signal) also lands here via ac — only
          // surface an error if the client is still listening.
          if (!req.signal?.aborted) {
            sink.event('error', {
              message: ac.signal.aborted
                ? "The docs assistant timed out. It may be rate-limited — try again, or check that you're signed in under Setup."
                : err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
        } finally {
          clearTimeout(hardTimer);
          clearFirstToken();
          req.signal?.removeEventListener('abort', onReqAbort);
        }
        if (!sawDelta && !req.signal?.aborted && !ac.signal.aborted) {
          // Backend produced nothing (auth expired, crashed) — give the caller a
          // graceful, non-empty signal to fall back on.
          sink.event('error', {
            message: 'The agent did not return an answer. It may be rate-limited or need re-authentication in Setup.',
          });
        }
        sink.close();
      },
    });
  },
});

export default docsQa;
