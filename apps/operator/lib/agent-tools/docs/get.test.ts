/**
 * Unit tests for the docs:get builder.
 *
 * Tests against a hand-rolled minimal GetSource — no fumadocs in
 * scope. Tool-registration / live-source integration is verified via
 * the /api/agent-tools/docs/get curl gate in the rollout.
 */

import { describe, it, expect } from 'vitest';
import { executeDocsGet, type GetSource } from './get-builder';
import type { OutlineSourcePage } from './outline-builder';
import { MAX_PAYLOAD_BYTES } from './shared';

function page(
  slugs: string[],
  body: string,
  toc: Array<{ url: string; title: unknown; depth: number }> = [],
): OutlineSourcePage & { _body: string } {
  return {
    slugs,
    url: '/docs/' + slugs.join('/'),
    data: { title: slugs.at(-1) ?? 'Index', toc },
    _body: body,
  };
}

function source(pages: Array<OutlineSourcePage & { _body: string }>): GetSource {
  const byKey = new Map(pages.map((p) => [p.slugs.join('/'), p]));
  return {
    getPages: () => pages,
    getPage: (slugs: string[]) => byKey.get(slugs.join('/')) ?? null,
  };
}

const render = async (p: OutlineSourcePage): Promise<string> =>
  (p as OutlineSourcePage & { _body?: string })._body ?? '';

describe('executeDocsGet', () => {
  it('single-slug happy path', async () => {
    const src = source([page(['endpoint-system', 'overview'], 'Body content here')]);
    const res = await executeDocsGet({ slugs: ['endpoint-system/overview'] }, src, render);
    expect(res.results).toHaveLength(1);
    const r = res.results[0];
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.content).toBe('Body content here');
      expect(r.bytes).toBe('Body content here'.length);
      expect(r.truncated).toBeUndefined();
      expect(r.sliced).toBeUndefined();
    }
  });

  it('batch of 3 returns results in input order', async () => {
    const src = source([
      page(['a', 'one'], 'aaa'),
      page(['b', 'two'], 'bbb'),
      page(['c', 'three'], 'ccc'),
    ]);
    const res = await executeDocsGet(
      { slugs: ['c/three', 'a/one', 'b/two'] },
      src,
      render,
    );
    expect(res.results.map((r) => r.slug)).toEqual(['c/three', 'a/one', 'b/two']);
    expect(res.results.map((r) => (r.found ? r.content : null))).toEqual([
      'ccc',
      'aaa',
      'bbb',
    ]);
  });

  it('mixed valid + invalid: per-slug error envelope', async () => {
    const src = source([page(['endpoint-system', 'overview'], 'ok')]);
    const res = await executeDocsGet(
      { slugs: ['endpoint-system/overview', 'does/not/exist'] },
      src,
      render,
    );
    expect(res.results).toHaveLength(2);
    expect(res.results[0].found).toBe(true);
    expect(res.results[1].found).toBe(false);
    if (!res.results[1].found) {
      expect(res.results[1].error).toBe('not_found');
    }
  });

  it('not_found returns near-match suggestions when ratio fits', async () => {
    const src = source([page(['endpoint-system', 'overview'], 'ok')]);
    // 'endpoint-system/overvew' — 1 edit from 'endpoint-system/overview' (len 22)
    const res = await executeDocsGet(
      { slugs: ['endpoint-system/overvew'] },
      src,
      render,
    );
    expect(res.results[0].found).toBe(false);
    if (!res.results[0].found) {
      expect(res.results[0].suggestions).toContain('endpoint-system/overview');
    }
  });

  it('not_found with no close candidates returns empty suggestions', async () => {
    const src = source([page(['endpoint-system', 'overview'], 'ok')]);
    const res = await executeDocsGet({ slugs: ['xyz'] }, src, render);
    expect(res.results[0].found).toBe(false);
    if (!res.results[0].found) {
      expect(res.results[0].suggestions).toEqual([]);
    }
  });

  it('heading slice on single-slug call', async () => {
    const md = `# Title

intro

## First Section

first body

## Second Section

second body
`;
    const src = source([
      page(['sec', 'a'], md, [
        { url: '#first-section', title: 'First Section', depth: 2 },
        { url: '#second-section', title: 'Second Section', depth: 2 },
      ]),
    ]);
    const res = await executeDocsGet(
      { slugs: ['sec/a'], heading: 'first-section' },
      src,
      render,
    );
    const r = res.results[0];
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.sliced).toBe(true);
      expect(r.content).toContain('## First Section');
      expect(r.content).toContain('first body');
      expect(r.content).not.toContain('Second Section');
    }
  });

  it('heading_not_found returns sibling heading ids', async () => {
    const src = source([
      page(['sec', 'a'], '## H1\n\n## H2', [
        { url: '#h1', title: 'H1', depth: 2 },
        { url: '#h2', title: 'H2', depth: 2 },
      ]),
    ]);
    const res = await executeDocsGet(
      { slugs: ['sec/a'], heading: 'h99' },
      src,
      render,
    );
    const r = res.results[0];
    expect(r.found).toBe(false);
    if (!r.found) {
      expect(r.error).toBe('heading_not_found');
      expect(r.suggestions).toEqual(['h1', 'h2']);
    }
  });

  it('truncates content over MAX_PAYLOAD_BYTES and adds tail', async () => {
    const huge = 'x'.repeat(MAX_PAYLOAD_BYTES + 1000);
    const src = source([
      page(['big', 'page'], huge, [{ url: '#first', title: 'First', depth: 2 }]),
    ]);
    const res = await executeDocsGet({ slugs: ['big/page'] }, src, render);
    const r = res.results[0];
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.truncated).toBe(true);
      expect(r.bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
      expect(r.content.length).toBeGreaterThan(MAX_PAYLOAD_BYTES);
      // Tail includes the first H2 id for the agent to re-fetch slice
      expect(r.content).toContain('first');
      expect(r.content).toContain('truncated');
    }
  });

  it('truncation tail acknowledges when page has no H2 headings', async () => {
    const huge = 'x'.repeat(MAX_PAYLOAD_BYTES + 100);
    const src = source([page(['big', 'page'], huge, [])]);
    const res = await executeDocsGet({ slugs: ['big/page'] }, src, render);
    const r = res.results[0];
    if (r.found) {
      expect(r.content).toContain('no H2 headings');
    }
  });

  it('every result preserves slug order even when all miss', async () => {
    const src = source([]);
    const res = await executeDocsGet({ slugs: ['a', 'b', 'c'] }, src, render);
    expect(res.results.map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    expect(res.results.every((r) => !r.found)).toBe(true);
  });
});
