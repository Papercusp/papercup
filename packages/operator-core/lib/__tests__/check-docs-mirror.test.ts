/**
 * check-docs-mirror.test.ts — source-to-served docs completeness guard
 * (EI-20041752458165941).
 *
 * A clean mirror run proves only that today's mirror is complete. These tests
 * pin the path mapping and the missing-twin failure that a clean run cannot
 * exercise.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import {
  findMissingDocMirrors,
  isVisibleDocPath,
  sourceToMirrorPaths,
} from '../../../../scripts/check-docs-mirror.mjs';

describe('check-docs-mirror detector (EI-20041752458165941)', () => {
  it('maps root and nested index pages to Astro file-format HTML paths', () => {
    expect(sourceToMirrorPaths('index.mdx')).toEqual({
      source: 'index.mdx',
      html: 'index.html',
      markdown: 'index.md',
    });
    expect(sourceToMirrorPaths('agent-insights/index.mdx')).toEqual({
      source: 'agent-insights/index.mdx',
      html: 'agent-insights.html',
      markdown: 'agent-insights/index.md',
    });
    expect(sourceToMirrorPaths('agent-insights/new-page.mdx')).toEqual({
      source: 'agent-insights/new-page.mdx',
      html: 'agent-insights/new-page.html',
      markdown: 'agent-insights/new-page.md',
    });
  });

  it('ignores hidden path segments and non-doc files', () => {
    expect(isVisibleDocPath('agent-insights/.papercusp/raw.md')).toBe(false);
    expect(sourceToMirrorPaths('agent-insights/.papercusp/raw.md')).toBeNull();
    expect(sourceToMirrorPaths('agent-insights/readme.txt')).toBeNull();
    expect(sourceToMirrorPaths('./agent-insights/page.mdx')).toEqual({
      source: 'agent-insights/page.mdx',
      html: 'agent-insights/page.html',
      markdown: 'agent-insights/page.md',
    });
  });

  it('flags a source page when either served twin is absent', () => {
    const missing = findMissingDocMirrors({
      sourceFiles: [
        'index.mdx',
        'agent-insights/index.mdx',
        'agent-insights/new-page.mdx',
        'agent-insights/.papercusp/raw.md',
      ],
      htmlFiles: ['index.html', 'agent-insights.html', 'agent-insights/new-page.html'],
      markdownFiles: ['index.md'],
    });

    expect(missing).toEqual([
      {
        source: 'agent-insights/index.mdx',
        expected: {
          html: 'agent-insights.html',
          markdown: 'agent-insights/index.md',
        },
        missing: ['markdown'],
      },
      {
        source: 'agent-insights/new-page.mdx',
        expected: {
          html: 'agent-insights/new-page.html',
          markdown: 'agent-insights/new-page.md',
        },
        missing: ['markdown'],
      },
    ]);
  });

  it('passes when every visible source page has exact Markdown and mapped HTML twins', () => {
    expect(findMissingDocMirrors({
      sourceFiles: ['index.mdx', 'agent-insights/index.mdx', 'agent-insights/page.md'],
      htmlFiles: ['index.html', 'agent-insights.html', 'agent-insights/page.html', '404.html'],
      markdownFiles: ['index.md', 'agent-insights/index.md', 'agent-insights/page.md'],
    })).toEqual([]);
  });
});
