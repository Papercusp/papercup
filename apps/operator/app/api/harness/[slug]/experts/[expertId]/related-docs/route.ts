/**
 * Fuzzy-match an expert's title (and high-level brief, if present) against
 * the operator's spec docs so the experts panel can fill its empty space
 * with reading material that's relevant to what the expert is drafting.
 *
 * Approach:
 *  - Walk apps/operator/content/docs/spec/ + a few sibling dirs
 *  - Score each .mdx by token overlap against the expert title +
 *    highLevelSpec (after stripping markdown noise).
 *  - Return the top match's path + raw markdown body.
 *
 * O(n) over the docs tree — single-digit MB at most, so we don't need an
 * index. Caching is a future concern; right now the UI calls this once
 * per expert selection and re-fetches the doc body each time.
 */
import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface DocCandidate {
  /** Filesystem-relative slug (e.g. 'spec/experts'). Used for the docs URL. */
  slug: string;
  /** Absolute filesystem path. */
  path: string;
  /** Raw markdown body. */
  body: string;
  /** Plaintext-extracted title from frontmatter / first H1 / filename. */
  title: string;
}

const DOCS_ROOTS = [
  'apps/operator/content/docs/spec',
  'apps/operator/content/docs',
];

function repoRoot(): string {
  // process.cwd() in the dev server is apps/operator; walk up to repo root.
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
  // Frontmatter title: a markdown frontmatter block at top with `title: ...`
  const fm = body.match(/^---\s*([\s\S]*?)---\s*/);
  if (fm) {
    const t = fm[1].match(/^title:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m);
    if (t) return (t[1] ?? t[2] ?? t[3] ?? '').trim();
  }
  // First H1
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
  'expert', 'experts', 'spec', 'feature', 'features',  // common to every expert
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
  // Token overlap between query and doc.title + first 1500 chars of body.
  // Weight title matches 3x — they correlate strongly with relevance.
  const titleTokens = tokenize(doc.title);
  const bodyTokens = tokenize(doc.body.slice(0, 1500));
  let s = 0;
  for (const t of query) {
    if (titleTokens.has(t)) s += 3;
    if (bodyTokens.has(t)) s += 1;
  }
  return s;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; expertId: string }> },
) {
  const { slug, expertId } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid harness slug' }, { status: 400 });
  }
  if (!/^EXP-?[\w-]+$/i.test(expertId)) {
    return NextResponse.json({ error: 'invalid expertId' }, { status: 400 });
  }

  // Pull the expert detail directly via the existing route. Cleaner than
  // re-implementing the registry walk here.
  const detail = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? '3055'}/api/harness/${encodeURIComponent(slug)}/experts/${encodeURIComponent(expertId)}`,
    { cache: 'no-store' },
  ).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (!detail || detail.error) {
    return NextResponse.json({ error: detail?.error ?? 'expert not found' }, { status: 404 });
  }

  // Use title + the high-level brief as the query corpus.
  const queryText = `${detail.title ?? ''} ${detail.highLevelSpec ?? ''}`;
  const query = tokenize(queryText);

  // Score every doc; return top one (or null if no useful match).
  const docs = listDocs();
  let best: { doc: DocCandidate; score: number } | null = null;
  for (const doc of docs) {
    const s = score(query, doc);
    if (s > 0 && (!best || s > best.score)) best = { doc, score: s };
  }
  if (!best) {
    return NextResponse.json({ match: null, scanned: docs.length });
  }

  // Strip frontmatter from the body before returning so the UI's
  // ReactMarkdown doesn't render the YAML header inline.
  let body = best.doc.body;
  const fm = body.match(/^---\s*([\s\S]*?)---\s*/);
  if (fm) body = body.slice(fm[0].length);

  return NextResponse.json({
    match: {
      title: best.doc.title,
      slug: best.doc.slug,
      score: best.score,
      body,
      // Stat-based ts so the UI can show 'updated 3d ago' etc.
      mtimeMs: (() => { try { return statSync(best.doc.path).mtimeMs; } catch { return 0; } })(),
    },
    scanned: docs.length,
  });
}
