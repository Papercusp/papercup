/** Public manual only: reuse Starlight rendering and the docs engine, never private adapters. */
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { getDocs, searchDocs, starlightContentAdapter, tokenize, levenshtein, type DocSource } from '@papercusp/docs-engine';
import { REPO_ROOT } from './_repo-paths';

export function isPublicManualRole(role: unknown): boolean {
  return role === 'papercup' || role === 'papercup-deep';
}

export function resolvePublicManualRoot(cwd = process.cwd(), repoRoot = REPO_ROOT): string {
  const source = path.join(repoRoot, 'apps/papercusp-docs/src/content/docs');
  if (existsSync(path.join(source, 'faq.mdx'))) return source;
  let dir = path.resolve(cwd);
  for (let i = 0; i < 16; i += 1) {
    for (const relative of ['public/manual-source', 'apps/operator/public/manual-source']) {
      const candidate = path.join(dir, relative);
      if (existsSync(path.join(candidate, 'faq.mdx'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A missing public bundle is an outage, never permission to read another corpus.
  return source;
}

export function createPublicManualSource(contentRoot: string): DocSource & { revision(): Promise<string> } {
  const root = path.resolve(contentRoot);
  async function revision(): Promise<string> {
    const canonicalRoot = await fs.realpath(root);
    const files = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name)).map((entry) => entry.name).sort();
    if (!files.includes('faq.mdx')) throw new Error('public manual FAQ is unavailable');
    const hash = createHash('sha256');
    for (const filename of files) {
      const file = path.join(root, filename);
      if (path.dirname(await fs.realpath(file)) !== canonicalRoot) throw new Error('public manual source escaped its root');
      hash.update(filename).update('\0').update(await fs.readFile(file)).update('\0');
    }
    return hash.digest('hex');
  }
  const base = starlightContentAdapter({ name: 'public-manual', contentRoot: root, baseUrl: '/docs', maxDepth: 0, getRevision: revision });
  // No caller-controlled paths, namespaces, traversal or nested private documents.
  const validSlug = (slug: string) => slug === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  return {
    name: base.name,
    revision,
    listPages: () => base.listPages(),
    getPage: (slug) => validSlug(slug) ? base.getPage(slug) : Promise.resolve(null),
    getContent: (page) => base.getContent(page),
    getSectionMeta: (slug) => validSlug(slug) ? (base.getSectionMeta?.(slug) ?? Promise.resolve({})) : Promise.resolve({}),
    // This read-only surface intentionally exposes rendered public content only.
  };
}

let publicSource: ReturnType<typeof createPublicManualSource> | undefined;
export function publicManualSource() {
  return publicSource ??= createPublicManualSource(resolvePublicManualRoot());
}

export async function searchPublicManual(args: { query: string; limit?: number }, source = publicManualSource()) {
  try {
    const revision = await source.revision();
    // Reuse the docs engine's tokenizer and edit distance. Correct only an
    // unknown long word with a unique nearest public-corpus word; keep exact
    // terms and ambiguous inputs intact. Never consult a private vocabulary.
    const vocabulary = new Set<string>();
    for (const page of await source.listPages()) {
      for (const word of tokenize(`${page.title} ${await source.getContent(page)}`)) {
        if (/^[a-z]{5,}$/.test(word)) vocabulary.add(word);
      }
    }
    const corrected = tokenize(args.query).map((word) => {
      if (!/^[a-z]{5,}$/.test(word) || vocabulary.has(word)) return word;
      const maxDistance = word.length >= 7 ? 2 : 1;
      let distance = maxDistance + 1;
      let nearest = word;
      let tied = false;
      for (const candidate of vocabulary) {
        if (Math.abs(candidate.length - word.length) > maxDistance) continue;
        const d = levenshtein(word, candidate);
        if (d < distance) { distance = d; nearest = candidate; tied = false; }
        else if (d === distance) tied = true;
      }
      return distance <= maxDistance && !tied ? nearest : word;
    }).join(' ');
    const changed = corrected !== tokenize(args.query).join(' ');
    const result = await searchDocs(source, { ...args, query: changed ? corrected : args.query });
    return { ...result, query: args.query, ...(changed ? { correctedQuery: corrected } : {}), surface: 'public', revision, legs: { lexical: { status: 'ran' }, semantic: { status: 'not-run', reason: 'public-manual lexical fallback' } } };
  } catch {
    return { error: 'public_docs_unavailable', surface: 'public', hits: [], hitCount: 0, recoverable: true, fallbackUrl: '/docs/faq' };
  }
}

export async function getPublicManual(args: { slugs: string[]; heading?: string; offset?: number; source?: boolean }, source = publicManualSource()) {
  if (args.source) return { error: 'public_source_read_forbidden', surface: 'public' };
  try {
    const revision = await source.revision();
    return { ...await getDocs(source, args), surface: 'public', revision };
  } catch {
    return { error: 'public_docs_unavailable', surface: 'public', recoverable: true, fallbackUrl: '/docs/faq' };
  }
}
