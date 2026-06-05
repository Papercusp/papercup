/**
 * Agent-insights index — compact title + description list for the
 * session-start prelude.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 3, P-011 + P-012).
 *
 * Why not just use the Starlight-emitted `llms-small.txt`?
 * The Starlight `llms-small.txt` output for the agent-insights section
 * includes the full body of every insight (~50 lines × 35 insights),
 * blowing out the prelude token budget. For the prelude we only want
 * slug + title + 1-line description so the agent knows the surface
 * area; the full body is one `docs:get` call away when needed.
 *
 * This module reads the .mdx files in
 * `apps/operator-docs/src/content/docs/agent-insights/`, parses the
 * YAML frontmatter, filters out `status: retired|superseded`, and
 * emits a markdown list ready to splice into a system prompt.
 *
 * Pure-IO module: only `fs.promises` + a small frontmatter parser.
 * No fumadocs, no starlight runtime dep.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface InsightEntry {
  slug: string;
  title: string;
  description: string;
  status: string;
  tags: string[];
}

/**
 * Minimal YAML frontmatter parser — handles the shapes the
 * agent-insights files actually use: top-level string scalars + an
 * inline array of tags. Not a general YAML parser; explicitly
 * single-purpose so this module has zero deps.
 */
export function parseFrontmatter(
  raw: string,
): Record<string, string | string[]> | null {
  // Frontmatter block is `---\n...\n---\n` at the very start
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return null;
  const block = raw.slice(4, end);

  const out: Record<string, string | string[]> = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.startsWith('  ')) continue; // skip nested
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key) continue;

    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) =>
          (s.startsWith('"') && s.endsWith('"')) ||
          (s.startsWith("'") && s.endsWith("'"))
            ? s.slice(1, -1)
            : s,
        );
      out[key] = items;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isVisible(status: string): boolean {
  const s = status.toLowerCase();
  return s !== 'retired' && s !== 'superseded';
}

/**
 * Read one .mdx file and produce its InsightEntry (or null when the
 * file lacks valid frontmatter / is the section index page).
 */
export async function readInsight(
  filePath: string,
): Promise<InsightEntry | null> {
  const slug = path.basename(filePath, '.mdx');
  if (slug === 'index') return null; // section landing page, not an insight

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const fm = parseFrontmatter(raw);
  if (!fm) return null;

  const title = typeof fm.title === 'string' ? fm.title : '';
  const description = typeof fm.description === 'string' ? fm.description : '';
  const status = typeof fm.status === 'string' ? fm.status : 'active';
  const tags = Array.isArray(fm.tags) ? fm.tags : [];

  if (!title) return null;

  return { slug, title, description, status, tags };
}

/**
 * Read the entire insights directory. Filters out retired/superseded.
 */
export async function readInsightsDir(
  dir: string,
): Promise<InsightEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const out: InsightEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith('.mdx')) continue;
    const entry = await readInsight(path.join(dir, name));
    if (!entry) continue;
    if (!isVisible(entry.status)) continue;
    out.push(entry);
  }
  // Stable order: alpha by slug, so the index doesn't churn run-to-run
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Render the prelude block. Format:
 *
 *   ## Agent insights
 *
 *   Project-specific runbook entries. Drill in with
 *   `docs:get { slugs: ['<slug>'] }` if any look relevant.
 *
 *   - <slug> — <description first sentence>
 *   - …
 *
 * Returns `null` when there are no visible insights — caller can
 * conditionally skip the section.
 */
export function renderInsightsPrelude(entries: InsightEntry[]): string | null {
  if (entries.length === 0) return null;

  const lines = entries.map((e) => {
    const oneLine = firstSentence(e.description) || e.title;
    return `- ${e.slug} — ${oneLine}`;
  });

  return [
    '## Agent insights',
    '',
    "Project-specific runbook entries. Drill in with `docs:get { slugs: ['<slug>'] }` if any look relevant.",
    '',
    ...lines,
  ].join('\n');
}

function firstSentence(text: string): string {
  const s = text.trim();
  if (!s) return '';
  // Match first . / ! / ? followed by whitespace or end-of-string
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}
