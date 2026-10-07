import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';

const root = resolve(__dirname, '../../..');
const composer = join(root, 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh');
const workers = [
  'local-embedder-worker.script.mjs',
  'cpu-task-worker.script.mjs',
  'local-reranker-worker.script.mjs',
  'event-loop-sentinel.worker.mjs',
  'snapshot-fold.worker.mjs',
];

describe('current-build local rig payload (not a two-machine acceptance result)', () => {
  it('emits a hash-bound payload with every required plain-Node worker without touching the remote rig', () => {
    const out = mkdtempSync(join(tmpdir(), 'current-build-rig-e2e-'));
    const compilerDir = mkdtempSync(join(tmpdir(), 'current-build-rig-compiler-'));
    try {
      const build = spawnSync('bash', [composer, '--no-push'], {
        cwd: root,
        env: { ...process.env, PATH: localEsbuildNpxPath(compilerDir, root), PCUSP_RIG_COMPOSE_OUT: out },
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const manifest = readFileSync(join(out, 'PAYLOAD-MANIFEST.sha256'), 'utf8');
      for (const worker of workers) {
        expect(manifest, worker).toContain(worker);
        const check = spawnSync('node', ['--check', join(out, worker)], { encoding: 'utf8' });
        expect(check.status, `${worker}: ${check.stderr}`).toBe(0);
      }
      const check = spawnSync('sha256sum', ['-c', 'PAYLOAD-MANIFEST.sha256'], {
        cwd: out,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(compilerDir, { recursive: true, force: true });
    }
  }, 200_000);
});
