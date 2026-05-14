/**
 * MCP Resource: papercusp://docs/section/{section}
 *
 * Templated resource. `list()` expands the template into one entry per
 * section in the public docs tree. `read()` returns the concatenated
 * markdown for every page in that section — same rendering pipeline
 * as /llms.mdx (JSX cleanup applied) via @papercusp/docs-engine.
 */

import * as path from 'node:path';
import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import {
  buildOutline,
  fumadocsAdapter,
  renderMdxToMarkdown,
  withPreamble,
} from '@papercusp/docs-engine';
import { internalSource as source } from '@/lib/source';

const adapter = fumadocsAdapter(source as never, {
  name: 'papercusp-public',
  contentRoot: path.join(process.cwd(), 'content', 'internal-docs'),
});

export default defineResource({
  name: 'docs:section',
  uri: 'papercusp://docs/section/{section}',
  capability: 'docs:read',
  mimeType: 'text/markdown',
  description:
    'Whole-section consolidated documentation (markdown). One entry per top-level docs section; reading returns every page in that section joined.',

  async list(): Promise<ResourceListEntry[]> {
    const outline = await buildOutline(adapter);
    return outline.sections
      .filter((s) => s.slug !== '_root')
      .map((s) => ({
        uri: `papercusp://docs/section/${s.slug}`,
        name: s.title,
        description: s.description ?? `Consolidated markdown for every page under /docs/${s.slug}.`,
        mimeType: 'text/markdown',
      }));
  },

  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/docs\/section\/([^/]+)$/.exec(uri);
    const section = match?.[1];
    if (!section) throw new Error(`Invalid docs/section URI: ${uri}`);

    // fumadocs source still drives page enumeration — we need the raw
    // MDX text per page and the engine's adapter only exposes
    // getContent(page), so route via adapter.listPages → adapter.getContent.
    const pages = await adapter.listPages();
    const sectionPages = pages
      .filter((p) => p.slugs[0] === section && p.slugs.length > 1)
      .sort((a, b) => a.slug.localeCompare(b.slug));

    if (sectionPages.length === 0) throw new Error(`No pages found under section "${section}"`);

    const rendered = await Promise.all(
      sectionPages.map(async (p) => {
        const body = await adapter.getContent(p);
        return withPreamble(body, {
          title: p.title,
          url: p.url,
          ...(p.description ? { description: p.description } : {}),
        });
      }),
    );
    return {
      uri,
      mimeType: 'text/markdown',
      text: rendered.join('\n\n---\n\n'),
    };
  },
});

// Side-effect import keeps remark-mdx-to-markdown reachable from
// renderMdxToMarkdown (re-export not needed but documented).
void renderMdxToMarkdown;
