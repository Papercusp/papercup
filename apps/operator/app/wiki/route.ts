/**
 * /wiki?target=<filename>[&harness=<slug>]
 *
 * Resolves Obsidian-style [[wiki-links]] expanded by `expandWikiLinks` into
 * actual harness file destinations. Searches each registered project for a
 * matching `<target>.md` in the conventional locations:
 *   .harness/<target>.md, <root>/<target>.md, .claude/skills/<target>.md
 *
 * Found:    302 redirect to /harness/<slug>?panel=config&specTab=<tab>
 * Missing:  302 redirect to /wiki/missing?... with candidate hints
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { loadHarnessRegistry } from '@/lib/harness-registry';

const SEARCH_DIRS = ['.harness', '', '.claude/skills'] as const;

// Maps known SpecEditor TAB ids to the on-disk filenames they edit.
// Used to translate a hit at `<root>/.harness/supervisor-notes.md` into
// the URL `?specTab=supervisor`.
const TAB_BY_FILENAME: Record<string, string> = {
  'SPEC.md': 'spec',
  'AGENTS.md': 'agents',
  'validation-contract.md': 'contract',
  'supervisor-notes.md': 'supervisor',
  'knowledge.md': 'knowledge',
};

function findInProject(projectPath: string, target: string): { dir: string; filename: string } | null {
  const filename = target.endsWith('.md') ? target : `${target}.md`;
  for (const dir of SEARCH_DIRS) {
    const candidate = dir ? join(projectPath, dir, filename) : join(projectPath, filename);
    if (existsSync(candidate)) return { dir, filename };
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = (url.searchParams.get('target') ?? '').trim();
  const harnessHint = url.searchParams.get('harness')?.trim() ?? null;

  if (!target) {
    return NextResponse.json({ error: 'missing target' }, { status: 400 });
  }

  const reg = await loadHarnessRegistry();
  const projects = reg.projects ?? [];

  const ordered = harnessHint
    ? [...projects.filter((p) => p.slug === harnessHint), ...projects.filter((p) => p.slug !== harnessHint)]
    : projects;

  const matches: Array<{ slug: string; filename: string; tab: string | null }> = [];
  for (const p of ordered) {
    const hit = findInProject(p.path, target);
    if (!hit) continue;
    const tab = TAB_BY_FILENAME[hit.filename] ?? null;
    matches.push({ slug: p.slug, filename: hit.filename, tab });
    if (harnessHint && p.slug === harnessHint) break;
  }

  if (matches.length === 0) {
    const params = new URLSearchParams({ target });
    if (harnessHint) params.set('harness', harnessHint);
    return NextResponse.redirect(new URL(`/wiki/missing?${params.toString()}`, url.origin));
  }

  // First match wins (registry order, harness-hint preferred).
  const best = matches[0];
  const dest = new URL(`/harness/${encodeURIComponent(best.slug)}`, url.origin);
  dest.searchParams.set('panel', 'config');
  if (best.tab) dest.searchParams.set('specTab', best.tab);
  // Multi-match: hint to the destination page that other hits exist.
  if (matches.length > 1) {
    dest.searchParams.set('wikiAlts', matches.slice(1).map((m) => m.slug).join(','));
  }
  return NextResponse.redirect(dest);
}
