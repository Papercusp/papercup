/**
 * docs:section MCP-resource tests (resource-section.ts) — the templated
 * `papercusp://docs/section/{section}` resource that serves whole-section
 * consolidated engineering markdown (the /llms-full.txt twin).
 *
 * Previously uncovered. Pins:
 *   - list(): one entry per top-level section, the synthetic `_root` section
 *     filtered out, title/description/uri/mimeType shape, and the description
 *     fallback when a section has none;
 *   - read(): URI parse → section extraction, page filtering by section
 *     (`slugs[0] === section`), per-page render via withPreamble, and the
 *     join of every page in the section;
 *   - read() error paths — an out-of-range/unknown section and a malformed URI
 *     both THROW (the correct not-found behavior for a resource read; a clamp
 *     would silently serve the wrong section, so the throw is load-bearing).
 *
 * The docs-engine (buildOutline/withPreamble) and the on-disk engineering
 * adapter (listPages/getContent) are mocked, so nothing touches the real docs
 * tree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  buildOutline: vi.fn(),
  listPages: vi.fn(),
  getContent: vi.fn(),
}));
const { buildOutline, listPages, getContent } = M;

vi.mock('@papercusp/docs-engine', () => ({
  buildOutline: M.buildOutline,
  // withPreamble: prefix a recognizable header so the join + per-page render is observable.
  withPreamble: (body: string, meta: { title?: string }) => `[${meta.title ?? ''}]${body}`,
}));

// Engineering adapter is the DocSource the resource reads from.
vi.mock('../_engineering-adapter', () => ({
  engineeringAdapter: {
    listPages: (...a: unknown[]) => M.listPages(...a),
    getContent: (...a: unknown[]) => M.getContent(...a),
  },
}));

import resource from '../resource-section';
const RESOURCE_CTX = {} as never;

beforeEach(() => {
  buildOutline.mockReset();
  listPages.mockReset();
  getContent.mockReset();
});

describe('docs:section — list()', () => {
  it('emits one entry per section, filtering the synthetic _root section', async () => {
    buildOutline.mockResolvedValueOnce({
      sections: [
        { slug: '_root', title: 'Root', description: 'top-level pages' },
        { slug: 'system', title: 'System', description: 'system docs' },
        { slug: 'agents', title: 'Agents', description: 'agent docs' },
      ],
    });
    const entries = await resource.list!(RESOURCE_CTX);
    expect(entries.map((e) => e.uri)).toEqual([
      'papercusp://docs/section/system',
      'papercusp://docs/section/agents',
    ]);
    expect(entries[0]).toMatchObject({
      uri: 'papercusp://docs/section/system',
      name: 'System',
      description: 'system docs',
      mimeType: 'text/markdown',
    });
  });

  it('falls back to a generated description when a section has none', async () => {
    buildOutline.mockResolvedValueOnce({
      sections: [{ slug: 'testing', title: 'Testing', description: undefined }],
    });
    const [entry] = await resource.list!(RESOURCE_CTX);
    expect(entry.description).toBe(
      'Consolidated markdown for every page under /internal/docs/testing.',
    );
  });
});

describe('docs:section — read()', () => {
  it('joins every page under the section, each rendered through withPreamble', async () => {
    listPages.mockResolvedValueOnce([
      { slugs: ['system', 'a'], title: 'A', url: '/internal/docs/system/a' },
      { slugs: ['system', 'b'], title: 'B', url: '/internal/docs/system/b', description: 'B desc' },
      { slugs: ['agents', 'x'], title: 'X', url: '/internal/docs/agents/x' }, // other section — excluded
    ]);
    getContent.mockImplementation(async (p: { title: string }) => `body-of-${p.title}`);

    const out = await resource.read('papercusp://docs/section/system', RESOURCE_CTX);
    expect(out).toMatchObject({ uri: 'papercusp://docs/section/system', mimeType: 'text/markdown' });
    // Only the two `system` pages, each wrapped with its title preamble, joined.
    expect(out.text).toBe('[A]body-of-A\n\n[B]body-of-B');
    // The agents page was NOT rendered.
    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it('THROWS on an out-of-range / unknown section (no pages) rather than serving empty', async () => {
    listPages.mockResolvedValueOnce([{ slugs: ['system', 'a'], title: 'A', url: '/u' }]);
    await expect(resource.read('papercusp://docs/section/nonexistent', RESOURCE_CTX)).rejects.toThrow(
      /no pages found under section 'nonexistent'/,
    );
  });

  it('THROWS on a malformed URI (wrong scheme/shape)', async () => {
    await expect(resource.read('papercusp://docs/section/a/b', RESOURCE_CTX)).rejects.toThrow(/Invalid docs\/section URI/);
    await expect(resource.read('not-a-docs-uri', RESOURCE_CTX)).rejects.toThrow(/Invalid docs\/section URI/);
    // listPages is never reached when the URI doesn't parse.
    expect(listPages).not.toHaveBeenCalled();
  });
});
