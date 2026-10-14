import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPTS = ['workspace-test.mjs', 'check-vitest-config-enrollment.mjs'];

/** Exercise the real entry guards without starting another test runner. */
async function withScript(script: string, bundled: boolean, run: (entry: string, root: string) => void, rawGuard = false) {
  const root = mkdtempSync(join(tmpdir(), 'cli-entry-scripts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/bad'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(join(root, 'packages/bad/package.json'), JSON.stringify({ name: 'bad' }));
    writeFileSync(join(root, 'packages/bad/vitest.config.ts'), 'export default { test: {} };');
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    const entry = join(root, 'scripts', script);
    await build({
      entryPoints: [join(REPO_ROOT, 'scripts', script)],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['typescript', 'vite'],
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: String(bundled) },
      plugins: [{
        name: 'record-workspace-child',
        setup(build) {
          if (rawGuard) {
            build.onLoad({ filter: /(?:workspace-test|check-vitest-config-enrollment)\.mjs$/ }, ({ path }) => {
              const source = readFileSync(path, 'utf8');
              const guard = 'if (isCliEntry(import.meta.url))';
              if (!source.includes(guard)) throw new Error('Expected the production CLI-entry guard');
              return {
                contents: source.replace(guard, 'if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))'),
                loader: 'js',
              };
            });
          }
          build.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export function spawnSync(command, args) { console.log(JSON.stringify({ command, args })); return { status: 7 }; }',
            loader: 'js',
          }));
        },
      }],
    });
    run(entry, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function execute(args: string[], root: string) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    // The fixture is an isolated executable, not another Vitest worker.
    env: { ...process.env, NODE_OPTIONS: '' },
  });
}

describe.each(SCRIPTS)('%s CLI entry', (script) => {
  it('detects the original raw entry guard firing inside an executable bundle', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      if (script === 'workspace-test.mjs') {
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout)).toEqual({ command: 'npx', args: ['vitest', 'run'] });
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('packages/bad/vitest.config.ts');
      }
    }, true);
  });

  it('stays inert when inlined into an executable host bundle', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  it('stays inert when imported by a separate executable', async () => {
    await withScript(script, false, (entry, root) => {
      const importer = join(root, 'importer.mjs');
      writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import complete');`);
      const result = execute([importer], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('import complete');
      expect(result.stderr).toBe('');
    });
  });

  it.each([false, true])('runs as a standalone CLI (symlink=%s) and preserves its failure status', async (symlink) => {
    await withScript(script, false, (entry, root) => {
      const invoked = symlink ? join(root, 'entry-link.mjs') : entry;
      if (symlink) symlinkSync(entry, invoked);
      const result = execute([invoked, '--passWithNoTests'], root);
      expect(result.error).toBeUndefined();
      if (script === 'workspace-test.mjs') {
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout)).toEqual({ command: 'npx', args: ['vitest', 'run', '--passWithNoTests'] });
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('packages/bad/vitest.config.ts');
      }
    });
  });
});
