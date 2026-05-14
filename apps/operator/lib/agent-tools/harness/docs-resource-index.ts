/**
 * MCP Resource: papercusp://harness/{slug}/docs/index
 *
 * Templated resource — one entry per registered harness. `read()`
 * returns a sitemap of that harness's docs (a flat list of slug,
 * title, description for every page in its docs/ folder + state
 * files), suitable for an external MCP client to discover what
 * harness-specific documentation exists before drilling in.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents, ResourceListEntry } from '@papercusp/agent-mcp';
import { buildOutline, harnessFsAdapter } from '@papercusp/docs-engine';
import { loadHarnessRegistry } from '@/lib/harness-registry';

export default defineResource({
  name: 'harness:docs_index',
  uri: 'papercusp://harness/{slug}/docs/index',
  capability: 'harness:read',
  mimeType: 'text/plain',
  description:
    "Per-harness documentation sitemap — flat list of every page under that harness's docs/ folder + state files (one entry per registered harness).",

  async list(): Promise<ResourceListEntry[]> {
    const reg = await loadHarnessRegistry();
    return reg.projects.map((p) => ({
      uri: `papercusp://harness/${p.slug}/docs/index`,
      name: `${p.slug} — docs sitemap`,
      description: `Pages + state files for harness "${p.slug}" at ${p.path}.`,
      mimeType: 'text/plain',
    }));
  },

  async read(uri): Promise<ResourceContents> {
    const match = /^papercusp:\/\/harness\/([^/]+)\/docs\/index$/.exec(uri);
    const slug = match?.[1];
    if (!slug) throw new Error(`Invalid harness/docs URI: ${uri}`);

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) throw new Error(`harness "${slug}" not registered`);

    const adapter = harnessFsAdapter(project.path, { name: `harness:${slug}` });
    const outline = await buildOutline(adapter);

    const lines: string[] = [`# ${slug} — documentation`, ''];
    for (const section of outline.sections) {
      lines.push(`## ${section.title}`);
      if (section.description) lines.push(section.description);
      lines.push('');
      for (const page of section.pages) {
        const desc = page.description ? ` — ${page.description}` : '';
        lines.push(`- [${page.title}](${page.slug})${desc}`);
      }
      lines.push('');
    }

    return {
      uri,
      mimeType: 'text/plain',
      text: lines.join('\n'),
    };
  },
});
