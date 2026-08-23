import { describe, expect, it, vi } from 'vitest';
import type { DocPage, DocSource } from '@papercusp/docs-engine';
import { overlayCanonicalDocs } from './_engineering-adapter';

const releasePage: DocPage = {
  slug: 'agent-insights/existing',
  slugs: ['agent-insights', 'existing'],
  url: '/internal/docs/agent-insights/existing',
  title: 'Release projection',
  toc: [],
};

function releaseSource(): DocSource & { invalidate: ReturnType<typeof vi.fn> } {
  return {
    name: 'release-rooted-engineering',
    listPages: vi.fn(async () => [releasePage]),
    getPage: vi.fn(async (slug: string) => (slug === releasePage.slug ? releasePage : null)),
    getContent: vi.fn(async () => 'release checkout body'),
    invalidate: vi.fn(),
  };
}

describe('overlayCanonicalDocs', () => {
  it('lets a release-rooted reader see a staging-authored page and canonical replacement content', async () => {
    const base = releaseSource();
    const readCanonical = vi.fn(async () =>
      new Map([
        [
          'agent-insights/existing.mdx',
          '---\ntitle: Canonical title\ndescription: Canonical description\n---\n# Canonical heading\n\nStaging-authored body',
        ],
        ['agent-insights/new-page.mdx', '---\ntitle: New page\n---\n# New heading\n\nNew body'],
      ]),
    );
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');

    const pages = await source.listPages();
    expect(pages.map((page) => page.slug)).toEqual(['agent-insights/existing', 'agent-insights/new-page']);
    expect(pages.find((page) => page.slug === 'agent-insights/existing')?.title).toBe('Canonical title');
    expect(await source.getContent((await source.getPage('agent-insights/existing'))!)).toContain('Staging-authored body');
    expect(await source.getPage('agent-insights/new-page')).toMatchObject({
      slug: 'agent-insights/new-page',
      title: 'New page',
    });
    expect(await source.getContent((await source.getPage('agent-insights/new-page'))!)).toContain('New body');
    expect(readCanonical).toHaveBeenCalledOnce();
    expect(base.getContent).not.toHaveBeenCalled();
  });

  it('drops the canonical cache when docs:author invalidates the shared adapter', async () => {
    const base = releaseSource();
    let contents = new Map<string, string>();
    const readCanonical = vi.fn(async () => contents);
    const source = overlayCanonicalDocs(base, readCanonical, 'papercusp');

    expect(await source.getPage('agent-insights/new-page')).toBeNull();
    contents = new Map([
      ['agent-insights/new-page.mdx', '---\ntitle: Arrived after author\n---\n# Heading\n\nBody'],
    ]);
    source.invalidate?.();

    expect(await source.getPage('agent-insights/new-page')).toMatchObject({
      title: 'Arrived after author',
    });
    expect(readCanonical).toHaveBeenCalledTimes(2);
    expect(base.invalidate).toHaveBeenCalledOnce();
  });
});
