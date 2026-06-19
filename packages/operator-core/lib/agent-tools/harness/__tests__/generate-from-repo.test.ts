/**
 * P-009 — harness:generate-from-repo tool envelope tests. The dryRun / skip /
 * bad-path branches are PG-free (they never reach harness:create), so the ctx is
 * a minimal stub. The create branch is covered indirectly by the create tool's
 * own path; here we prove detection → override → validate → preview composes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import tool from '../generate_from_repo';

const CTX = { log() {}, workspaceId: 'ws', role: 'operator' } as never;
const run = async (args: Record<string, unknown>) => {
  const res = (await tool.handler(args as never, CTX)) as { content: { text: string }[] };
  return JSON.parse(res.content[0].text);
};

const created: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'p009-tool-'));
  created.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('harness:generate-from-repo', () => {
  it('dryRun: detects + builds + validates an extends:coding override without creating', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'true' }, dependencies: { vue: '^3' } }),
      'pnpm-lock.yaml': '',
      'CLAUDE.md': '# rules\n',
    });
    const r = await run({ slug: 'my-app', path: root, dryRun: true, runTests: false });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.override.extends).toBe('coding-factory');
    expect(r.override.knobs.testCommand).toBe('pnpm test');
    expect(r.override.knobs.uiQa).toEqual({ enabled: true }); // vue → frontend → ui-qa
    expect(r.validation.ok).toBe(true);
    expect(r.validation.errors).toEqual([]);
    // The previewed YAML round-trips.
    expect(parseYaml(r.yaml).extends).toBe('coding-factory');
    expect(r.detection.testCommand.verified).toBeNull(); // runTests:false
    expect(r.detection.flags.frontend).toBe(true);
  });

  it('skips a repo that already has a blueprint', async () => {
    const root = fixture({ '.papercusp/blueprint.yaml': 'id: existing\n' });
    const r = await run({ slug: 'dup', path: root, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('already has');
  });

  it('errors on a non-existent path', async () => {
    const r = await run({ slug: 'nope', path: '/no/such/path/xyz', dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not exist');
  });
});
