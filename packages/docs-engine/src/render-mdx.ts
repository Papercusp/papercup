/**
 * Pure MDX → clean markdown rendering pipeline.
 *
 * Source-agnostic: takes raw MDX text + an absolute path and returns
 * rendered markdown with JSX nodes converted (Callout/Aside →
 * blockquote, Tabs/Steps unwrapped, etc.) per the rules in
 * remark-mdx-to-markdown.ts. Used by adapters (starlight, harness-fs).
 */

import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import remarkMdxToMarkdown from './remark-mdx-to-markdown.js';

const processor = remark()
  .use(remarkMdx)
  .use(remarkGfm)
  .use(remarkMdxToMarkdown);

export async function renderMdxToMarkdown(rawMdx: string, absolutePath: string): Promise<string> {
  const processed = await processor.process({ path: absolutePath, value: rawMdx });
  return String(processed);
}

/** Format a page body with the standard agent-readable preamble. */
export function withPreamble(
  body: string,
  meta: { title: string; url: string; description?: string },
): string {
  const desc = meta.description ?? '';
  return `# ${meta.title}\nURL: ${meta.url}\n\n${desc}\n\n${body}`;
}
