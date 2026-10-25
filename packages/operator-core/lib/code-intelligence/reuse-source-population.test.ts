import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { collectReuseSourcePopulation } from './reuse-source-population';
import { collectReuseSourcePopulationOffthread } from './reuse-measurement';

const repo = resolve(__dirname, '../../../..');

describe('finite code-intelligence worker source collection', () => {
  let dir: string;
  let worker: string;
  let inputs: string[];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reuse-source-bundle-'));
    worker = join(dir, 'first-party-callers.worker.mjs');
    const banner = execFileSync('bash', ['-c', 'source "$1"; printf "%s" "$HOST_BANNER"',
      'worker-test', join(repo, 'apps/operator/bin/bundle-host-common.sh')], { encoding: 'utf8' });
    const result = await build({
      absWorkingDir: repo,
      entryPoints: ['packages/operator-core/lib/code-intelligence/first-party-callers.worker.ts'],
      outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
      banner: { js: banner }, define: { __dirname: '__pc_dirname', __filename: '__pc_filename' },
    });
    inputs = Object.keys(result.metafile!.inputs).map(path => relative(repo, resolve(repo, path)).replaceAll('\\', '/'));
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('keeps operator initialization, fixture payloads and database clients outside the emitted worker', () => {
    const operatorInputs = inputs.filter(path => path.startsWith('packages/operator-core/lib/'));
    expect(operatorInputs).toContain('packages/operator-core/lib/code-intelligence/reuse-source-population.ts');
    expect(operatorInputs.filter(path => !path.startsWith('packages/operator-core/lib/code-intelligence/'))).toEqual([]);
    expect(inputs.some(path => /(?:^|\/)db-org\//.test(path))).toBe(false);
    expect(readFileSync(worker, 'utf8')).not.toContain('sourceGraphQualification');
  });

  it('collects the same committed Git window inline, over plain Node IPC and through the public wrapper', async () => {
    const root = join(dir, 'source');
    execFileSync('git', ['init', '-q', root]);
    const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    writeFileSync(join(root, 'a.ts'), 'export const base = 1;\n');
    const longPath = 'odd [é].ts', longComment = '// ' + 'é'.repeat(40_000);
    writeFileSync(join(root, longPath), longComment + '\nexport const old = 1;\n');
    git('2026-10-01T00:00:00Z', 'add', '.');
    git('2026-10-01T00:00:00Z', 'commit', '-qm', 'base');
    writeFileSync(join(root, 'a.ts'), 'export function target() { return 1; }\ntarget();\n');
    // Changed payload spans stream chunks, and a multibyte/pathspec-looking
    // identity must remain attached to its exact zero-context hunk lines.
    writeFileSync(join(root, longPath), longComment + ' changed\nexport const fresh = 2;\n');
    git('2026-10-01T01:00:00Z', 'add', '.');
    git('2026-10-01T01:00:00Z', 'commit', '-qm', 'change');
    // Mutable working-tree bytes must not enter the historical population.
    writeFileSync(join(root, 'a.ts'), 'uncommitted();\n');
    const child = fork(worker, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const result = await new Promise<Record<string, any>>((resolveResult, reject) => {
        const timer = setTimeout(() => reject(new Error('worker source collection timed out: ' + stderr)), 10_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error('worker exited before answer: ' + code + ': ' + stderr)); });
        child.on('message', (value: any) => {
          if (value?.kind !== 'reuse-source-population') return;
          clearTimeout(timer); resolveResult(value);
        });
        child.send({ kind: 'reuse-source-population', root, start: '2026-10-01T00:30:00Z', end: '2026-10-01T01:30:00Z', captureRoot: dir });
      });
      expect(result.ok, result.error ?? stderr).toBe(true);
      expect(result.population).toMatchObject({ addedNonGeneratedLines: 4, duplicateAddedLines: 0,
        lineCensusComplete: true, callCensusComplete: true, method: { sourcePopulation: ['a.ts', longPath],
          addedLinePopulation: [{ path: 'a.ts', lines: [1, 2] }, { path: longPath, lines: [1, 2] }] } });
      expect(result.population.calls).toEqual([expect.objectContaining({ from: 'a.ts', to: 'a.ts', resolved: true })]);
      const start = '2026-10-01T00:30:00Z', end = '2026-10-01T01:30:00Z';
      const inline = await collectReuseSourcePopulation(root, start, end, dir);
      expect(result.population).toEqual(inline);
      // Exercise the public supervisor against these emitted working-tree bytes.
      // A source-loader fallback could otherwise test a different committed worker.
      const offthread = await collectReuseSourcePopulationOffthread(root, start, end, { workerPath: worker });
      expect(offthread).toEqual(inline);
    } finally { child.kill(); }
  });
});
