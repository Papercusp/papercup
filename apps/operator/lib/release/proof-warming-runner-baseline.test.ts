import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRunnerIdentity } from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { captureRuntimeProofIdentity } from '../../../../scripts/lib/runtime-compatibility.mjs';
import { captureNpmTaskRuntimeIdentity } from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { resolveRecordedGitDir } from '../../../../scripts/lib/executed-source-map.mjs';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SETUP = join(REPO_ROOT, 'apps/operator/bin/release/setup-release-checkout.sh');
const GENERATIONS = join(REPO_ROOT, 'apps/operator/bin/release/dependency-generation.sh');

describe('P001 proof-warming materialization baseline', () => {
  it('measures real runner identities separately from the object-store admission fence', () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'proof-warming-baseline-')));
    const integration = join(scratch, 'integration');
    mkdirSync(integration);
    // Every root uses the installed judging environment's actual Vitest bin.
    // Measure the maintained npm-task predictor separately from direct node;
    // neither measurement establishes that an intended child consumed a proof.
    const installedVitest = join(REPO_ROOT, 'node_modules/.bin/vitest');
    const installedVitestBytes = readFileSync(installedVitest);
    expect(installedVitestBytes.toString()).toMatch(/^#!\/usr\/bin\/env node\r?\n/);
    const env: NodeJS.ProcessEnv = { ...process.env,
      PATH: [join(REPO_ROOT, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter),
      NODE_OPTIONS: undefined, NODE_PATH: undefined, BUN_OPTIONS: undefined,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      DEPENDENCY_GENERATION_HEADROOM_RESERVE_PCT: '0',
      DEPENDENCY_GENERATION_HEADROOM_MARGIN_BYTES: '0',
      DEPENDENCY_GENERATION_COPY_LOCK_FILE: join(scratch, 'copy.lock'),
    };
    function command(cwd: string, executable: string, args: string[]) {
      const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout.trim();
    }
    function git(root: string, ...args: string[]) {
      return command(root, 'git', ['-c', 'user.name=proof-baseline',
        '-c', 'user.email=proof-baseline@example.invalid', ...args]);
    }
    try {
      const pkg = { name: 'proof-warming-fixture', version: '1.0.0', private: true,
        scripts: { test: 'vitest run' } };
      writeFileSync(join(integration, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(integration, 'package-lock.json'), JSON.stringify({
        name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg },
      }));
      writeFileSync(join(integration, '.gitignore'), 'node_modules/\n');
      git(integration, 'init', '-q');
      git(integration, 'add', '.');
      git(integration, 'commit', '-qm', 'fixed baseline workload');
      const candidate = git(integration, 'rev-parse', 'HEAD');
      // Publish an actual empty dependency generation using the maintained
      // publisher. Never substitute a hand-authored runner fingerprint or pin.
      mkdirSync(join(integration, 'node_modules'));
      const published = command(integration, 'bash', ['-c', [
        'set -euo pipefail',
        'source "$1"',
        'dependency_generation_ensure "$2" "$3"',
        'printf "BASELINE_GENERATION=%s\\n" "$DEPENDENCY_GENERATION_ID"',
      ].join('\n'), 'baseline', GENERATIONS, integration, join(scratch, 'generations')]);
      const generation = /^BASELINE_GENERATION=(v1-([a-f0-9]{64}))$/m.exec(published);
      expect(generation, published).not.toBeNull();
      const writer = readFileSync(SETUP, 'utf8')
        .match(/record_node_modules_copy_metadata\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(writer).toBeDefined();
      const roots = [
        { mechanism: 'checkpoint-worktree', mode: 'worktree' },
        { mechanism: 'linked-judging-worktree', mode: 'worktree' },
        { mechanism: 'separate-source-clone', mode: 'clone' },
      ];
      const observations = roots.map(({ mechanism, mode }) => {
        const root = join(scratch, mechanism);
        command(integration, 'bash', [SETUP, '--source-only', '--source-root-mode', mode,
          '--source-integrity', 'object-sourced', '--integration', integration,
          '--release', root, '--ref', candidate]);
        command(integration, 'bash', ['-c', [
          'set -euo pipefail',
          writer!,
          'log() { :; }',
          'INTEGRATION_ROOT="$1" RELEASE_ROOT="$2"',
          'PINNED_DEPENDENCY_GENERATION_ID="$3" DEPENDENCY_GENERATION_SOURCE_FINGERPRINT="$4"',
          'record_node_modules_copy_metadata',
        ].join('\n'), 'baseline', integration, root, generation![1], generation![2]]);
        const runtime = captureRuntimeProofIdentity({ root, environment: env });
        const runnerIdentity = defaultRunnerIdentity(root, env);
        const task = { workspaceRoot: root, scriptText: pkg.scripts.test };
        const npmRuntime = captureNpmTaskRuntimeIdentity({ root, environment: env, ...task });
        const npmRunnerIdentity = defaultRunnerIdentity(root, env, undefined, task);
        expect(runtime).not.toBeNull();
        expect(runnerIdentity).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
        expect(npmRuntime).not.toBeNull();
        expect(npmRunnerIdentity).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
        expect(git(root, 'rev-parse', 'HEAD')).toBe(candidate);
        expect(git(root, 'status', '--porcelain')).toBe('');
        return { mechanism, root, candidate, runtime, runnerIdentity, task,
          npmRuntime, npmRunnerIdentity,
          recordedGitDir: resolveRecordedGitDir(root) };
      });
      const [checkpoint, linked, clone] = observations;
      expect(linked.runnerIdentity).toBe(checkpoint.runnerIdentity);
      expect(clone.runnerIdentity).toBe(checkpoint.runnerIdentity);
      expect(linked.npmRunnerIdentity).toBe(checkpoint.npmRunnerIdentity);
      expect(clone.npmRunnerIdentity).toBe(checkpoint.npmRunnerIdentity);
      expect(linked.recordedGitDir).toBe(checkpoint.recordedGitDir);
      expect(clone.recordedGitDir).not.toBe(checkpoint.recordedGitDir);
      expect(checkpoint.recordedGitDir).toBe(resolveRecordedGitDir(integration));
      // A real invocation change must invalidate identity even at the same SHA.
      const mismatch = defaultRunnerIdentity(linked.root,
        { ...env, NODE_OPTIONS: '--conditions=proof-warming-control' });
      expect(mismatch).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
      expect(mismatch).not.toBe(checkpoint.runnerIdentity);
      const npmMismatch = defaultRunnerIdentity(linked.root,
        { ...env, NODE_OPTIONS: '--conditions=proof-warming-control' }, undefined, linked.task);
      expect(npmMismatch).toMatch(/^proof-v3 runtime-v1 [a-f0-9]{64}$/);
      expect(npmMismatch).not.toBe(checkpoint.npmRunnerIdentity);
      console.info('P001_RUNNER_MATERIALIZATION_BASELINE', JSON.stringify({
        schemaVersion: 1, plane: 'controlled-native-fixture',
        implementation: { sourceFiles: [SETUP, GENERATIONS,
          join(REPO_ROOT, 'scripts/lib/targeted-task-reuse.mjs'),
          join(REPO_ROOT, 'scripts/lib/runtime-compatibility.mjs')].map(path => ({
            path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          })) },
        workloadManifest: roots, workloadSourceIdentity: candidate,
        dependencyGeneration: generation![1], disturbance: 'real NODE_OPTIONS condition change',
        installedVitest: { path: realpathSync(installedVitest),
          sha256: createHash('sha256').update(installedVitestBytes).digest('hex') },
        observations, mismatch, npmMismatch,
        dispositions: {
          'linked-judging-worktree': 'runtime and object-store identities match; child consumption still unverified',
          'separate-source-clone': 'runtime matches; distinct object store prevents cross-repository proof reuse',
        },
        acceptancePending: ['intended-child proof consumption'],
      }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
