/**
 * getLLMText — fumadocs-typed shim over @papercusp/docs-engine's
 * MDX→markdown pipeline. The engine owns the remark stack; this file
 * stays for backward compatibility with the HTTP /llms.* routes and
 * the MCP resource handlers.
 *
 * Prefer direct engine imports in new code:
 *   import { renderMdxToMarkdown, withPreamble } from '@papercusp/docs-engine';
 */

import type { InferPageType } from 'fumadocs-core/source';
import type { source } from '@/lib/source';
import { renderMdxToMarkdown, withPreamble } from '@papercusp/docs-engine';

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const raw = await page.data.getText('raw');
  const body = await renderMdxToMarkdown(raw, page.absolutePath);
  return withPreamble(body, {
    title: page.data.title,
    url: page.url,
    ...(page.data.description ? { description: page.data.description } : {}),
  });
}
