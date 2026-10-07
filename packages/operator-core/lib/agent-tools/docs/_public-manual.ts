/** Public manual only: reuse Starlight rendering and the docs engine, never private adapters. */
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { getDocs, searchDocs, starlightContentAdapter, type DocSource } from '@papercusp/docs-engine';
import { REPO_ROOT } from './_repo-paths';

export function resolvePublicManualRoot(cwd = process.cwd()): string {
  const source = path.join(REPO_ROOT, 'apps/papercusp-docs/src/content/docs');
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
    getSectionMeta: (slug) => validSlug(slug) ? base.getSectionMeta(slug) : Promise.resolve({}),
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
    const result = await searchDocs(source, args);
    return { ...result, surface: 'public', revision, legs: { lexical: { status: 'ran' }, semantic: { status: 'not-run', reason: 'public-manual lexical fallback' } } };
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
