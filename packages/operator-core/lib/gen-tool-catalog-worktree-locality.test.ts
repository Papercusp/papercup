import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const GENERATOR = join(REPO_ROOT, 'scripts', 'gen-tool-catalog.ts');
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

function writeFixtureTool(indexPath: string, name: string): void {
  writeFileSync(
    indexPath,
    `import { registerFixtureTool } from '@papercusp/agent-mcp';\nregisterFixtureTool(${JSON.stringify(name)});\n`,
    'utf8',
  );
}

describe('gen-tool-catalog frozen-worktree source locality', () => {
  it('projects the divergent linked-worktree tool source even when only the parent checkout has node_modules', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'papercusp-tool-catalog-locality-'));
    cleanup.push(fixtureRoot);
    const canonical = join(fixtureRoot, 'repo');
    const scriptsDir = join(canonical, 'scripts');
    const operatorCore = join(canonical, 'packages', 'operator-core');
    const toolDir = join(operatorCore, 'lib', 'agent-tools');
    const agentMcp = join(canonical, 'node_modules', '@papercusp', 'agent-mcp');
    const operatorCoreLink = join(canonical, 'node_modules', '@papercusp', 'operator-core');

    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(toolDir, { recursive: true });
    mkdirSync(agentMcp, { recursive: true });
    mkdirSync(join(canonical, '.papercusp', 'worktrees'), { recursive: true });
    copyFileSync(GENERATOR, join(scriptsDir, 'gen-tool-catalog.ts'));
    writeFileSync(
      join(agentMcp, 'package.json'),
      JSON.stringify({ name: '@papercusp/agent-mcp', type: 'module', exports: './index.js' }),
      'utf8',
    );
    writeFileSync(
      join(agentMcp, 'index.js'),
      `const key = Symbol.for('papercusp.catalog-locality-fixture');\n` +
        `const registry = globalThis[key] ?? (globalThis[key] = []);\n` +
        `export function registerFixtureTool(name) {\n` +
        `  registry.push({ expose: { mcp: { name } }, description: name, capabilities: ['testing:run'] });\n` +
        `}\n` +
        `export function listAllProjectedTools() { return [...registry]; }\n`,
      'utf8',
    );
    writeFileSync(
      join(operatorCore, 'package.json'),
      JSON.stringify({ name: '@papercusp/operator-core', type: 'module', exports: { './*': './*' } }),
      'utf8',
    );
    writeFixtureTool(join(toolDir, 'index.ts'), 'sentinel-canonical');
    symlinkSync(operatorCore, operatorCoreLink, 'dir');
    writeFileSync(
      join(scriptsDir, 'probe-alias.ts'),
      `import '@papercusp/operator-core/lib/agent-tools/index.ts';\n` +
        `import { listAllProjectedTools } from '@papercusp/agent-mcp';\n` +
        `process.stdout.write(JSON.stringify(listAllProjectedTools().map((t) => t.expose?.mcp?.name)));\n`,
      'utf8',
    );

    run(canonical, 'git', 'init', '-q');
    run(canonical, 'git', 'config', 'user.name', 'Catalog Locality Test');
    run(canonical, 'git', 'config', 'user.email', 'catalog-locality@example.invalid');
    run(canonical, 'git', 'add', 'scripts', 'packages');
    run(canonical, 'git', 'commit', '-qm', 'fixture');

    const repair = join(canonical, '.papercusp', 'worktrees', 'repair-1');
    run(canonical, 'git', 'worktree', 'add', '--detach', repair, 'HEAD');
    expect(existsSync(join(repair, 'node_modules'))).toBe(false);

    writeFixtureTool(
      join(repair, 'packages', 'operator-core', 'lib', 'agent-tools', 'index.ts'),
      'sentinel-repair',
    );
    mkdirSync(join(repair, '.papercusp'), { recursive: true });

    // Fixture calibration: the PRE-FIX bare alias escapes the node_modules-less
    // repair worktree and imports the canonical source.
    expect(JSON.parse(run(repair, TSX, join(repair, 'scripts', 'probe-alias.ts')))).toEqual([
      'sentinel-canonical',
    ]);

    run(repair, TSX, join(repair, 'scripts', 'gen-tool-catalog.ts'));
    const catalog = JSON.parse(
      readFileSync(join(repair, '.papercusp', 'tool-catalog.json'), 'utf8'),
    ) as { tools: Array<{ name: string | null }> };
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['sentinel-repair']);
  });
});
