/**
 * Single owner of the MDX → markdown pipeline used by:
 *   - the /llms-full.txt and /llms.mdx/<slug> HTTP routes
 *   - the docs:get agent tool
 *
 * Centralising it here keeps the rendering one source of truth — if we
 * ever swap remark plugins (e.g. add a JSX-to-markdown converter, per
 * the Phase 2 deferred plan), every consumer picks it up.
 */

import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { remarkInclude } from 'fumadocs-mdx/config';
import type { InferPageType } from 'fumadocs-core/source';
import type { source } from '@/lib/source';

const processor = remark().use(remarkMdx).use(remarkInclude).use(remarkGfm);

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  // page.data.getText('raw') returns the original .mdx file content from disk.
  // 'processed' would require includeProcessedMarkdown on the collection;
  // 'raw' + our own remark pipeline gives us full control over the output.
  const raw = await page.data.getText('raw');
  const processed = await processor.process({
    path: page.absolutePath,
    value: raw,
  });
  const description = page.data.description ?? '';
  return `# ${page.data.title}\nURL: ${page.url}\n\n${description}\n\n${String(processed)}`;
}
