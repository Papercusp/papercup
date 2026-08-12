/**
 * starlightContentAdapter tests — synthetic fixture on disk + smoke against
 * the real apps/operator-docs/ tree.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { starlightContentAdapter } from '../src/adapters/starlight';
import { buildOutline } from '../src/outline';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const OPERATOR_DOCS_ROOT = path.join(
  REPO_ROOT,
  'apps',
  'operator-docs',
  'src',
  'content',
  'docs',
);

describe('starlightContentAdapter — synthetic fixture', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-adapter-test-'));
    await fs.mkdir(path.join(tmp, 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'index.mdx'),
      `---\ntitle: Root\ndescription: Top-level index\n---\n\n## Hello\n\nbody\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'agent-policies.mdx'),
      `---\ntitle: Agent Policies\n---\n\n## Rules\n\n## More rules\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'agents', 'index.mdx'),
      `---\ntitle: Agents\ndescription: Section intro\n---\n\nintro\n`,
    );
    await fs.writeFile(
      path.join(tmp, 'agents', 'operator.mdx'),
      `---\ntitle: Operator agent\nsidebar:\n  order: 2\n---\n\n## Voice\n\n## Pi\n`,
    );
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists all pages with correct slugs and urls', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp, baseUrl: '/internal/docs' });
    const pages = await src.listPages();
    const bySlug = new Map(pages.map((p) => [p.slug, p]));
    expect(bySlug.has('')).toBe(true);
    expect(bySlug.has('agent-policies')).toBe(true);
    expect(bySlug.has('agents')).toBe(true);
    expect(bySlug.has('agents/operator')).toBe(true);
    expect(bySlug.size).toBe(4);

    expect(bySlug.get('')!.url).toBe('/internal/docs/');
    expect(bySlug.get('agent-policies')!.url).toBe('/internal/docs/agent-policies');
    expect(bySlug.get('agents')!.url).toBe('/internal/docs/agents');
    expect(bySlug.get('agents/operator')!.url).toBe('/internal/docs/agents/operator');
  });

  it('parses title and description from frontmatter', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const root = await src.getPage('');
    expect(root!.title).toBe('Root');
    expect(root!.description).toBe('Top-level index');

    const policies = await src.getPage('agent-policies');
    expect(policies!.title).toBe('Agent Policies');
    expect(policies!.description).toBeUndefined();
  });

  it('extracts headings into TOC', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const op = await src.getPage('agents/operator');
    expect(op!.toc).toEqual([
      { id: 'voice', text: 'Voice', depth: 2 },
      { id: 'pi', text: 'Pi', depth: 2 },
    ]);
  });

  it('returns section meta from <section>/index.mdx', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const meta = await src.getSectionMeta('agents');
    expect(meta).toEqual({ title: 'Agents', description: 'Section intro' });
  });

  it('returns getContent body without frontmatter', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const op = await src.getPage('agents/operator');
    const body = await src.getContent(op!);
    expect(body).not.toContain('---');
    expect(body).toContain('Voice');
  });

  it('invalidates cached metadata and rendered content after a projection write', async () => {
    const src = starlightContentAdapter({ contentRoot: tmp });
    const file = path.join(tmp, 'agents', 'operator.mdx');
    const original = await fs.readFile(file, 'utf8');
    try {
      const before = await src.getPage('agents/operator');
      expect(before!.title).toBe('Operator agent');
      expect(await src.getContent(before!)).toContain('Voice');

      await fs.writeFile(
        file,
        `---\ntitle: Updated operator\n---\n\n## Changed\n\nnew body\n`,
        'utf8',
      );
      src.invalidate();

      const after = await src.getPage('agents/operator');
      expect(after!.title).toBe('Updated operator');
      expect(await src.getContent(after!)).toContain('Changed');
      expect(await src.getContent(after!)).not.toContain('Voice');
    } finally {
      await fs.writeFile(file, original, 'utf8');
      src.invalidate();
    }
  });
});

describe('starlightContentAdapter — real operator-docs tree', () => {
  it('discovers expected page count and known pages', async () => {
    // Skip if the operator-docs tree doesn't exist (e.g. running on a checkout where
    // the F1-F5 migration hasn't been done yet).
    try {
      await fs.access(OPERATOR_DOCS_ROOT);
    } catch {
      return;
    }

    const src = starlightContentAdapter({
      contentRoot: OPERATOR_DOCS_ROOT,
      baseUrl: '/internal/docs',
    });
    const pages = await src.listPages();

    // We copied 127 MDX files in F2; allow some drift but assert non-trivial floor.
    expect(pages.length).toBeGreaterThanOrEqual(100);

    const slugs = new Set(pages.map((p) => p.slug));
    expect(slugs.has('agent-policies')).toBe(true);
    expect(slugs.has('agents')).toBe(true); // agents/index.mdx
    expect(slugs.has('endpoint-system/overview')).toBe(true);

    const policies = await src.getPage('agent-policies');
    expect(policies).not.toBeNull();
    expect(policies!.title.length).toBeGreaterThan(0);
    expect(policies!.url).toBe('/internal/docs/agent-policies');
  });

  it('buildOutline runs against real tree without error', async () => {
    try {
      await fs.access(OPERATOR_DOCS_ROOT);
    } catch {
      return;
    }
    const src = starlightContentAdapter({
      contentRoot: OPERATOR_DOCS_ROOT,
      baseUrl: '/internal/docs',
    });
    const outline = await buildOutline(src, {});
    expect(outline.sectionCount).toBeGreaterThan(5);
    expect(outline.pageCount).toBeGreaterThan(100);
    expect(outline.sections.length).toBe(outline.sectionCount);
  });
});
