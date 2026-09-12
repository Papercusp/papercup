import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findMdxCompileError as realDetector } from '../../../../../../packages/operator-core/lib/content-lint/mdx';

const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = process.env.PROBE_HOOK
  ? resolve(process.env.PROBE_HOOK)
  : resolve(__dirname, '../posttooluse-mdx-nudge.mjs');

type Hit = { line: number | null; col: number | null; reason: string };
type MdxDeps = {
  compile: (value: string, opts?: Record<string, unknown>) => Promise<unknown>;
  remarkGfm: unknown;
  yamlLoad: (value: string) => unknown;
};
type HookModule = {
  findMdxCompileError: (file: string, text: string, deps: MdxDeps) => Promise<Hit | null>;
  isCandidateFile: (file: string, root: string) => boolean;
  isDocsAuthorTool: (tool: string) => boolean;
  loadMdxDeps: (root: string) => Promise<MdxDeps | null>;
  mirrorNudgeFor: (payload: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<string | null>;
  nudgeFor: (file: string, deps?: Record<string, unknown>) => Promise<string | null>;
};

async function hookModule(): Promise<HookModule> {
  return (await import(`file://${HOOK}`)) as unknown as HookModule;
}

const SPLIT_INLINE = 'text `some:tool\n{ a:"b", c:{ d, e? } }` more text\n';
const CORPUS: Array<[string, string]> = [
  ['# Clean\n\nInline `code` stays on one line.\n', 'clean body'],
  [SPLIT_INLINE, 'reported split inline-code span'],
  ['# Broken\n\n<date>\n', 'bare placeholder token'],
  ['---\ntitle: Clean\n---\n\n# Body\n', 'clean frontmatter'],
  ['---\ntitle: broken: mapping\n---\n\n# Body\n', 'broken frontmatter'],
  ['# Components\n\n<Card>content</Card>\n', 'valid component'],
];

describe('posttooluse-mdx-nudge', () => {
  it('DRIFT GUARD: agrees with the real MDX detector on clean and failing corpus cases', async () => {
    const hook = await hookModule();
    const deps = await hook.loadMdxDeps(ROOT);
    expect(deps).toBeTruthy();

    const disagreements: string[] = [];
    for (const [text, name] of CORPUS) {
      const mine = await hook.findMdxCompileError(`${name}.mdx`, text, deps!);
      const real = await realDetector(`${name}.mdx`, text);
      if (JSON.stringify(mine) !== JSON.stringify(real)) {
        disagreements.push(`${name}: hook=${JSON.stringify(mine)} real=${JSON.stringify(real)}`);
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
    expect((await realDetector('broken.mdx', SPLIT_INLINE))?.reason).toMatch(/acorn|expression/i);
  });

  it('fires on the reported split inline-code span and explains the consequence', async () => {
    const hook = await hookModule();
    const deps = await hook.loadMdxDeps(ROOT);
    const file = join(ROOT, 'apps/operator-docs/src/content/docs/agent-insights/probe.mdx');
    const message = await hook.nudgeFor(file, {
      repoRoot: ROOT,
      sizeOf: () => SPLIT_INLINE.length,
      readFile: () => SPLIT_INLINE,
      loadMdxDeps: async () => deps,
    });
    expect(message).toMatch(/does NOT COMPILE/);
    expect(message).toMatch(/git-sync will quarantine/);
    expect(message).toMatch(/inline code span split across a newline/);
  });

  it('nudges successful docs:author MCP variants only when the affected twin is missing', async () => {
    const hook = await hookModule();
    const payload = {
      tool_name: 'mcp__papercusp-su__docs_author',
      tool_input: { section: 'agent-insights', slug: 'mirror-probe' },
      tool_response: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              path: 'agent-insights/mirror-probe.mdx',
              absPath: join(ROOT, 'apps/operator-docs/src/content/docs/agent-insights/mirror-probe.mdx'),
            }),
          },
        ],
      },
    };
    const scanDocsMirror = () => ({
      missing: [
        {
          source: 'agent-insights/mirror-probe.mdx',
          expected: { html: 'agent-insights/mirror-probe.html', markdown: 'agent-insights/mirror-probe.md' },
          missing: ['html', 'markdown'],
        },
      ],
    });

    expect(hook.isDocsAuthorTool('docs:author')).toBe(true);
    expect(hook.isDocsAuthorTool('mcp__papercusp-su__docs_author')).toBe(true);
    expect(hook.isDocsAuthorTool('mcp__papercusp-su__docs-author')).toBe(true);
    expect(hook.isDocsAuthorTool('mcp__papercusp-su__docs_get')).toBe(false);
    await expect(hook.mirrorNudgeFor(payload, { repoRoot: ROOT, scanDocsMirror })).resolves.toMatch(
      /DOCS_AUTHOR[\s\S]*missing generated served-doc twins|missing generated served-doc twins/,
    );

    await expect(
      hook.mirrorNudgeFor(
        { ...payload, tool_response: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'rejected' }) }] } },
        { repoRoot: ROOT, scanDocsMirror },
      ),
    ).resolves.toBeNull();
    await expect(
      hook.mirrorNudgeFor({ ...payload, tool_name: 'mcp__papercusp-su__docs_get' }, { repoRoot: ROOT, scanDocsMirror }),
    ).resolves.toBeNull();
  });

  it('stays silent outside the Astro docs corpus and on clean MDX', async () => {
    const hook = await hookModule();
    const deps = await hook.loadMdxDeps(ROOT);
    expect(hook.isCandidateFile(join(ROOT, 'apps/operator-docs/src/content/docs/x.mdx'), ROOT)).toBe(true);
    expect(hook.isCandidateFile(join(ROOT, 'apps/operator-docs/src/content/docs/x.md'), ROOT)).toBe(false);
    expect(hook.isCandidateFile(join(ROOT, 'notes/x.mdx'), ROOT)).toBe(false);

    const clean = '# Clean\n\nInline `code` stays on one line.\n';
    expect(
      await hook.nudgeFor(join(ROOT, 'apps/operator-docs/src/content/docs/x.mdx'), {
        repoRoot: ROOT,
        sizeOf: () => clean.length,
        readFile: () => clean,
        loadMdxDeps: async () => deps,
      }),
    ).toBeNull();
  });

  it('fails open on unreadable, oversized, and dependency-less inputs', async () => {
    const hook = await hookModule();
    const file = join(ROOT, 'apps/operator-docs/src/content/docs/x.mdx');
    const boom = () => {
      throw new Error('unreadable');
    };
    expect(await hook.nudgeFor(file, { repoRoot: ROOT, sizeOf: () => 1, readFile: boom })).toBeNull();
    expect(await hook.nudgeFor(file, { repoRoot: ROOT, sizeOf: () => 99_000_000, readFile: boom })).toBeNull();
    expect(
      await hook.nudgeFor(file, {
        repoRoot: ROOT,
        sizeOf: () => SPLIT_INLINE.length,
        readFile: () => SPLIT_INLINE,
        loadMdxDeps: async () => null,
      }),
    ).toBeNull();
  });

  it('passes its embedded self-test', () => {
    expect(execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' })).toMatch(/all cases passed/);
  });

  it('emits PostToolUse additionalContext through the real hook binary', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mdx-hook-'));
    const docs = join(sandbox, 'apps/operator-docs/src/content/docs');
    try {
      mkdirSync(docs, { recursive: true });
      mkdirSync(join(sandbox, 'node_modules/@mdx-js'), { recursive: true });
      writeFileSync(join(sandbox, 'package.json'), '{"name":"mdx-hook-probe"}\n');
      symlinkSync(join(ROOT, 'node_modules/@mdx-js/mdx'), join(sandbox, 'node_modules/@mdx-js/mdx'));
      symlinkSync(join(ROOT, 'node_modules/remark-gfm'), join(sandbox, 'node_modules/remark-gfm'));
      symlinkSync(join(ROOT, 'node_modules/js-yaml'), join(sandbox, 'node_modules/js-yaml'));
      const broken = join(docs, 'broken.mdx');
      const clean = join(docs, 'clean.mdx');
      writeFileSync(broken, SPLIT_INLINE);
      writeFileSync(clean, '# Clean\n');

      const run = (file: string, tool = 'Edit') =>
        execFileSync('node', [HOOK], {
          input: JSON.stringify({ tool_name: tool, tool_input: { file_path: file } }),
          encoding: 'utf8',
        });
      const emitted = JSON.parse(run(broken));
      expect(emitted.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(emitted.hookSpecificOutput.additionalContext).toMatch(/does NOT COMPILE/);
      expect(run(clean).trim()).toBe('');
      expect(run(broken, 'Read').trim()).toBe('');
      expect(
        run('missing.mdx', 'mcp__papercusp-su__docs_author').trim(),
      ).toBe('');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
