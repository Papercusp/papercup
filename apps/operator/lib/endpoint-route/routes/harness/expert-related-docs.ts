/**
 * GET /api/harness/:slug/experts/:expertId/related-docs
 *
 * Fuzzy-match an expert's title+brief against operator spec docs.
 * O(n) walk + token-overlap score.
 *
 * Ported from app/api/harness/[slug]/experts/[expertId]/related-docs/route.ts.
 * `auth: 'public'`.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';

interface DocCandidate {
  slug: string;
  path: string;
  body: string;
  title: string;
}

const DOCS_ROOTS = [
  'apps/operator/content/internal-docs/spec',
  'apps/operator/content/docs',
];

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'apps', 'operator', 'content', 'docs'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function listDocs(): DocCandidate[] {
  const root = repoRoot();
  const out: DocCandidate[] = [];
  for (const r of DOCS_ROOTS) {
    const abs = join(root, r);
    if (!existsSync(abs)) continue;
    walk(abs, r, out);
  }
  return out;
}

function walk(absDir: string, relDir: string, out: DocCandidate[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch { return; }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      walk(abs, rel, out);
      continue;
    }
    if (!e.name.endsWith('.mdx') && !e.name.endsWith('.md')) continue;
    let body: string;
    try {
      body = readFileSync(abs, 'utf8');
    } catch { continue; }
    const title = extractTitle(body) ?? basename(e.name, e.name.endsWith('.mdx') ? '.mdx' : '.md');
    out.push({
      slug: rel.replace(/\.mdx?$/, '').replace(/^apps\/operator\/content\/docs\//, ''),
      path: abs,
      body,
      title,
    });
  }
}

function extractTitle(body: string): string | null {
  const fm = body.match(/^---\s*([\s\S]*?)---\s*/);
  if (fm) {
    const t = fm[1].match(/^title:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m);
    if (t) return (t[1] ?? t[2] ?? t[3] ?? '').trim();
  }
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  return null;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'be', 'this', 'that', 'and', 'or', 'of', 'to',
  'in', 'on', 'for', 'with', 'as', 'by', 'we', 'it', 'its', 'our', 'i', 'you',
  'they', 'them', 'these', 'those', 'will', 'should', 'can', 'has', 'have', 'had',
  'how', 'when', 'where', 'why', 'what', 'which', 'who', 'do', 'does', 'did',
  'so', 'but', 'if', 'then', 'than', 'at', 'from', 'up', 'down', 'out', 'over',
  'no', 'not', 'all', 'any', 'each', 'few', 'more', 'most', 'some', 'such',
  'expert', 'experts', 'spec', 'feature', 'features',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function score(query: Set<string>, doc: DocCandidate): number {
  const titleTokens = tokenize(doc.title);
  const bodyTokens = tokenize(doc.body.slice(0, 1500));
  let s = 0;
  for (const t of query) {
    if (titleTokens.has(t)) s += 3;
    if (bodyTokens.has(t)) s += 1;
  }
  return s;
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/experts/:expertId/related-docs',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const expertId = ctx.params.expertId as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid harness slug' }, { status: 400 });
    }
    if (!/^EXP-?[\w-]+$/i.test(expertId)) {
      return Response.json({ error: 'invalid expertId' }, { status: 400 });
    }

    const detail = await fetch(
      `http://127.0.0.1:${process.env.PORT ?? '3055'}/api/harness/${encodeURIComponent(slug)}/experts/${encodeURIComponent(expertId)}`,
      { cache: 'no-store' },
    ).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (!detail || detail.error) {
      return Response.json({ error: detail?.error ?? 'expert not found' }, { status: 404 });
    }

    const queryText = `${detail.title ?? ''} ${detail.highLevelSpec ?? ''}`;
    const query = tokenize(queryText);

    const docs = listDocs();
    let best: { doc: DocCandidate; score: number } | null = null;
    for (const doc of docs) {
      const s = score(query, doc);
      if (s > 0 && (!best || s > best.score)) best = { doc, score: s };
    }
    if (!best) {
      return Response.json({ match: null, scanned: docs.length });
    }

    let body = best.doc.body;
    const fm = body.match(/^---\s*([\s\S]*?)---\s*/);
    if (fm) body = body.slice(fm[0].length);

    return Response.json({
      match: {
        title: best.doc.title,
        slug: best.doc.slug,
        score: best.score,
        body,
        mtimeMs: (() => { try { return statSync(best.doc.path).mtimeMs; } catch { return 0; } })(),
      },
      scanned: docs.length,
    });
  },
});
