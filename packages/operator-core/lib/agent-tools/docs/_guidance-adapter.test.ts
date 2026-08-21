/**
 * _guidance-adapter.test.ts — the guidance corpus (plan
 * guidance-overlap-contradiction-scan-2026-08-08, P-001).
 *
 * The load-bearing assertions here are about CORPUS MEMBERSHIP, not rendering.
 * Per plan D-002, a glob-derived corpus on this tree returns 6-9 copies of every
 * prompt (build sidecars, dist trees, cargo target dirs), and the consumer is a
 * pairwise-cosine overlap scan — so duplicates become perfect-score clusters
 * that look like findings. Every membership assertion below is therefore paired
 * with a CONTROL that fails when the check itself is broken; a bare "0
 * duplicates" is indistinguishable from a detector that never ran.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { guidanceAdapter, renderToolGuidancePage, GUIDANCE_SOURCE_NAME } from './_guidance-adapter';

async function tmpRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guidance-adapter-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, 'utf-8');
  }
  return root;
}

const P = (n: string) => path.join('apps', 'operator', 'prompts', n);
const B = (bp: string, n: string) =>
  path.join('libs', 'papercusp', 'packages', 'harness', 'blueprints', bp, 'prompts', n);

describe('guidanceAdapter — corpus membership', () => {
  it('indexes the canonical roots: CLAUDE.md, prompt sources, blueprint role prompts', async () => {
    const root = await tmpRepo({
      'CLAUDE.md': '# Repo guide\n\nSome standing rule about locks.',
      [P('worker.tools.md')]: '# Worker tools\n\nUse the router, not a bare vitest.',
      [P('kickoffs/coding.md')]: '# Coding kickoff\n\nClaim before you edit.',
      [B('coding', 'reviewer.md')]: '# Reviewer\n\nRead the plan decisions first.',
    });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    const pages = await a.listPages();
    const slugs = pages.map((p) => p.slug).sort();

    expect(slugs).toEqual([
      'blueprints/coding/prompts/reviewer',
      'prompts/kickoffs/coding',
      'prompts/worker.tools',
      'repo/claude-md',
    ]);

    const census = a.lastCensus();
    expect(census).toBeDefined();
    expect(census!.claudeMd).toBe(1);
    expect(census!.prompts).toBe(2);
    expect(census!.blueprints).toBe(1);
    expect(census!.total).toBe(4);
  });

  it('ignores non-prompt files under the blueprints root', async () => {
    const root = await tmpRepo({
      'CLAUDE.md': '# g',
      [B('coding', 'reviewer.md')]: '# Reviewer\n\nbody',
      [path.join('libs', 'papercusp', 'packages', 'harness', 'blueprints', 'coding', 'README.md')]:
        '# Not a prompt\n\nbody',
    });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    const slugs = (await a.listPages()).map((p) => p.slug);
    expect(slugs).toContain('blueprints/coding/prompts/reviewer');
    expect(slugs.some((s) => s.includes('README'))).toBe(false);
  });

  it('CONTROL: byte-identical pages are dropped and reported (a re-introduced copy root)', async () => {
    const dupe = '# Worker\n\nExactly the same words in two places.';
    const root = await tmpRepo({
      'CLAUDE.md': '# g',
      [P('worker.tools.md')]: dupe,
      [P('kickoffs/worker.md')]: dupe,
    });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    const pages = await a.listPages();
    const census = a.lastCensus()!;

    expect(census.duplicatesDropped).toBe(1);
    expect(census.warnings.join(' ')).toMatch(/duplicate content/);
    expect(pages.filter((p) => p.slug.startsWith('prompts/')).length).toBe(1);
  });

  it('reports a missing canonical file rather than silently shrinking the corpus', async () => {
    const root = await tmpRepo({ [P('worker.tools.md')]: '# Worker\n\nbody' });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    await a.listPages();
    expect(a.lastCensus()!.warnings.join(' ')).toMatch(/missing canonical file: CLAUDE\.md/);
  });

  it('getContent round-trips the indexed body; getPage misses return null', async () => {
    const body = '# Worker\n\n## Rule\n\nClaim before you edit.';
    const root = await tmpRepo({ 'CLAUDE.md': '# g', [P('worker.tools.md')]: body });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    const page = await a.getPage('prompts/worker.tools');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Worker');
    expect(page!.toc.map((h) => h.text)).toEqual(['Worker', 'Rule']);
    expect(await a.getContent(page!)).toBe(body);
    expect(await a.getPage('prompts/nope')).toBeNull();
  });
});

describe('renderToolGuidancePage', () => {
  const tool = (guidance: unknown) => ({ description: 'Does a thing.', guidance }) as never;

  it('renders when/notWhen/chaining/returns and byRole overrides', () => {
    const md = renderToolGuidancePage(
      'work_items:claim',
      tool({
        when: 'You are about to edit.',
        notWhen: 'Read-only investigation.',
        chaining: 'Then work_items:complete.',
        returns: '{ ok, id }',
        byRole: { reviewer: { when: 'Never — reviewers do not claim.' } },
      }),
    );
    expect(md).toContain('# work_items:claim');
    expect(md).toContain('## When');
    expect(md).toContain('## Not when');
    expect(md).toContain('## Chaining');
    expect(md).toContain('## Returns');
    expect(md).toContain('## Role override: reviewer — when');
    expect(md).toContain('Never — reviewers do not claim.');
  });

  it('returns null for a tool with no guidance, and for guidance with no authored fields', () => {
    expect(renderToolGuidancePage('x:y', { description: 'd' })).toBeNull();
    expect(renderToolGuidancePage('x:y', tool({ byRole: {} }))).toBeNull();
    expect(renderToolGuidancePage('x:y', tool({ when: '   ' }))).toBeNull();
  });

  it('renders only registry-validated corrective calls as executable guidance', () => {
    const md = renderToolGuidancePage(
      'work_items:update',
      tool({ argRedirects: { tags: { tool: 'work_items:tag', args: { id: 'x', topic: 'y' } } } }),
      [{
        rejectedArg: 'tags',
        rendered: 'work_items:tag {"id":"<work-item-id>","topic":"<topic>"}',
        note: 'canonical tag writer',
      }],
    );
    expect(md).toContain('## Correction for rejected arg: tags');
    expect(md).toContain('`work_items:tag {"id":"<work-item-id>","topic":"<topic>"}`');
    expect(md).toContain('canonical tag writer');
  });
});

describe('guidanceAdapter — tool registry leg', () => {
  it('an EMPTY corpus is reported as a warning, never as a clean census (D-001)', async () => {
    const root = await tmpRepo({ 'CLAUDE.md': '# g' });
    const a = guidanceAdapter({ repoRoot: root, includeToolGuidance: false });
    await a.listPages();
    const census = a.lastCensus()!;
    expect(census.toolGuidance).toBe(0);
    // The zero is ACCOMPANIED by the reason it is zero — that pairing is the
    // whole point: a downstream reader can tell "excluded" from "measured none".
    expect(census.warnings.join(' ')).toMatch(/tool guidance intentionally excluded/);
  });

  it('the source name is the source_key the read leg filters on', () => {
    expect(GUIDANCE_SOURCE_NAME).toBe('papercusp-guidance');
    expect(guidanceAdapter({ repoRoot: '/nonexistent' }).name).toBe('papercusp-guidance');
  });
});
