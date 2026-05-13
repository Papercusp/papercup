/**
 * MCP Resource: papercusp://docs/section/{section}
 *
 * Templated resource. `list()` expands the template into one entry per
 * section in the docs tree (e.g. endpoint-system, agent-spawning,
 * data-sync). `read()` returns the concatenated markdown for every
 * page in that section — same rendering pipeline as /llms.mdx (JSX
 * cleanup applied).
 *
 * Use case: an MCP client (Cursor, Claude Desktop) listing resources
 * sees one entry per architectural area; reading one fetches the
 * entire section at once, which is the right unit for an LLM seeking
 * design context.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';

const CONTENT_DOCS_DIR = path.join(process.cwd(), 'content', 'docs');

async function readSectionMeta(
  sectionSlug: string,
): Promise<{ title?: string; description?: string }> {
  try {
    const raw = await fs.readFile(
      path.join(CONTENT_DOCS_DIR, sectionSlug, 'meta.json'),
      'utf-8',
    );
    return JSON.parse(raw) as { title?: string; description?: string };
  } catch {
    return {};
  }
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export default defineResource({
  name: 'docs:section',
  uri: 'papercusp://docs/section/{section}',
  capability: 'docs:read',
  mimeType: 'text/markdown',
  description:
    'Whole-section consolidated documentation (markdown). One entry per top-level docs section; reading returns every page in that section joined.',

  async list(): Promise<ResourceListEntry[]> {
    const pages = (source as unknown as {
      getPages(): Array<{ slugs: string[] }>;
    }).getPages();

    const sectionSlugs = new Set<string>();
    for (const p of pages) {
      if (p.slugs.length > 1) sectionSlugs.add(p.slugs[0]);
    }

    const out: ResourceListEntry[] = [];
    for (const slug of [...sectionSlugs].sort()) {
      const meta = await readSectionMeta(slug);
      out.push({
        uri: `papercusp://docs/section/${slug}`,
        name: meta.title ?? humanize(slug),
        description:
          meta.description ??
          `Consolidated markdown for every page under /docs/${slug}.`,
        mimeType: 'text/markdown',
      });
    }
    return out;
  },

  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/docs\/section\/([^/]+)$/.exec(uri);
    const section = match?.[1];
    if (!section) {
      throw new Error(`Invalid docs/section URI: ${uri}`);
    }

    const pages = (source as unknown as {
      getPages(): Array<{
        slugs: string[];
        data: { getText: (k: 'raw' | 'processed') => Promise<string> };
        url: string;
        absolutePath?: string;
      }>;
    }).getPages();

    const sectionPages = pages
      .filter((p) => p.slugs[0] === section && p.slugs.length > 1)
      .sort((a, b) => a.slugs.join('/').localeCompare(b.slugs.join('/')));

    if (sectionPages.length === 0) {
      throw new Error(`No pages found under section "${section}"`);
    }

    const rendered = await Promise.all(sectionPages.map((p) => getLLMText(p as never)));
    return {
      uri,
      mimeType: 'text/markdown',
      text: rendered.join('\n\n---\n\n'),
    };
  },
});
