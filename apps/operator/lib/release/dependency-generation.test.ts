import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
// Overridable so a mutation probe can point the suite at a COPY of the script
// outside the tree; mutating the tracked file in place would race git-sync's
// whole-tree sweep and can commit the mutant.
const SCRIPT =
  process.env.DEPENDENCY_GENERATION_SCRIPT ??
  join(REPO_ROOT, 'apps/operator/bin/release/dependency-generation.sh');

const roots: string[] = [];

interface ShellResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function makeIntegration(): string {
  const root = mkdtempSync(join(tmpdir(), 'dependency-generation-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, 'packages/a/node_modules/local'), { recursive: true });
  mkdirSync(join(root, 'packages/b/node_modules/other'), { recursive: true });
  mkdirSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign'),
    { recursive: true },
  );
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'root-v1\n');
  writeFileSync(
    join(root, 'packages/a/node_modules/local/index.js'),
    'local-v1\n',
  );
  writeFileSync(join(root, 'packages/a/package.json'), '{"name":"a"}\n');
  writeFileSync(
    join(root, 'packages/b/node_modules/other/index.js'),
    'other-v1\n',
  );
  writeFileSync(join(root, 'packages/b/package.json'), '{"name":"b"}\n');
  writeFileSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign/index.js'),
    'must-not-copy\n',
  );
  return root;
}

function publish(
  integration: string,
  env: NodeJS.ProcessEnv = {},
  generationRoot?: string,
  workspaceDirs: string[] = [],
): ShellResult {
  const args = [SCRIPT, '--integration', integration];
  if (generationRoot) args.push('--generation-root', generationRoot);
  for (const workspaceDir of workspaceDirs) {
    args.push('--workspace-dir', workspaceDir);
  }
  const result = spawnSync('bash', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function publishedPath(stdout: string): string {
  const match = stdout.match(/\bpath=([^\n]+)$/m);
  if (!match) throw new Error(`missing generation path in: ${stdout}`);
  return match[1];
}

function publishedIdentity(stdout: string): string {
  const match = stdout.match(/\bidentity=(v1-[0-9a-f]{64})\b/);
  if (!match) throw new Error(`missing generation identity in: ${stdout}`);
  return match[1];
}

function selectGeneration(
  generationRoot: string,
  identity: string,
): ShellResult {
  const wrapper = [
    'set -euo pipefail',
    'source "$SCRIPT"',
    'dependency_generation_select "$GENERATION_ROOT" "$GENERATION_ID"',
    'printf "SELECTED identity=%s source=%s path=%s\\n" "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_SOURCE_FINGERPRINT" "$DEPENDENCY_GENERATION_PATH"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SCRIPT,
      GENERATION_ROOT: generationRoot,
      GENERATION_ID: identity,
    },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('immutable dependency generation', () => {
  it('publishes the whole product dependency set atomically and reuses its identity', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('DEPENDENCY_GENERATION_RESULT schema=1');
    expect(first.stdout).toContain('reused=false');

    const generation = publishedPath(first.stdout);
    expect(
      readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8'),
    ).toBe('root-v1\n');
    expect(
      readFileSync(
        join(generation, 'tree/packages/a/node_modules/local/index.js'),
        'utf8',
      ),
    ).toBe('local-v1\n');
    expect(
      existsSync(
        join(
          generation,
          'tree/.papercusp/worktrees/repair/node_modules/foreign/index.js',
        ),
      ),
    ).toBe(false);
    expect(
      statSync(join(generation, 'tree/node_modules/pkg/index.js')).mode & 0o222,
    ).toBe(0);
    expect(readFileSync(join(generation, '.papercusp-dependency-generation'), 'utf8')).toContain(
      'schema=1',
    );
    expect(
      readdirSync(join(integration, '.papercusp/dependency-generations')).filter(
        (entry) => entry.startsWith('.build-'),
      ),
    ).toEqual([]);

    const second = publish(integration);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedPath(second.stdout)).toBe(generation);
  });

  it('P-007: publishes only root plus the selected workspace closure and binds it into identity', () => {
    const integration = makeIntegration();
    const full = publish(integration);
    expect(full.status, full.stderr).toBe(0);

    const selected = publish(integration, {}, undefined, ['packages/a']);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toContain('scope=selected');
    expect(selected.stdout).toMatch(/\bclosure=[0-9a-f]{64}\b/);
    expect(publishedIdentity(selected.stdout)).not.toBe(
      publishedIdentity(full.stdout),
    );

    const generation = publishedPath(selected.stdout);
    expect(
      readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8'),
    ).toBe('root-v1\n');
    expect(
      readFileSync(
        join(generation, 'tree/packages/a/node_modules/local/index.js'),
        'utf8',
      ),
    ).toBe('local-v1\n');
    expect(
      existsSync(
        join(generation, 'tree/packages/b/node_modules/other/index.js'),
      ),
    ).toBe(false);

    const marker = readFileSync(
      join(generation, '.papercusp-dependency-generation'),
      'utf8',
    );
    expect(marker).toContain('scope=selected\n');
    expect(marker).toContain('workspace_dir=packages/a\n');

    const reused = publish(
      integration,
      {},
      undefined,
      ['packages/a', 'packages/a'],
    );
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(publishedPath(reused.stdout)).toBe(generation);
  });

  it('P-007: rejects a workspace closure that is not a safe repo-relative package directory', () => {
    const integration = makeIntegration();
    const result = publish(
      integration,
      {},
      undefined,
      ['packages/a/../a'],
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'invalid repo-relative --workspace-dir: packages/a/../a',
    );
    expect(
      existsSync(join(integration, '.papercusp/dependency-generations')),
    ).toBe(false);
  });

  it('selects an exact published identity without re-reading mutable live node_modules', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const identity = publishedIdentity(published.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );

    // Selection happens after the checkpoint may have waited for capacity. The
    // live source can disappear or change during that wait; the exact immutable
    // generation must remain the input.
    rmSync(join(integration, 'node_modules'), { recursive: true, force: true });
    rmSync(join(integration, 'packages/a/node_modules'), {
      recursive: true,
      force: true,
    });

    const selected = selectGeneration(generationRoot, identity);
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout).toContain(`SELECTED identity=${identity}`);
    expect(selected.stdout).toContain(
      `path=${join(generationRoot, identity)}`,
    );
  });

  it('replaces a corrupt same-identity generation instead of trusting its marker', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const publishedFile = join(generation, 'tree/node_modules/pkg/index.js');
    const validationTrace = join(integration, 'validation.trace');

    // Preserve the identity/snapshot marker while corrupting the tree. The next
    // publisher's initial full validation fails, it builds a valid replacement,
    // then reaches the publish-lock race where a marker-only check used to
    // discard that replacement as "reused" and leave this corruption in place.
    chmodSync(publishedFile, 0o644);
    writeFileSync(publishedFile, 'corrupt\n');

    const repaired = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain('reused=false');
    expect(publishedPath(repaired.stdout)).toBe(generation);
    expect(readFileSync(publishedFile, 'utf8')).toBe('root-v1\n');
    expect(repaired.stderr).toContain('quarantined invalid generation');
    expect(repaired.stderr).toContain(
      'skipping repeat validation under publish lock',
    );
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(
      readdirSync(join(integration, '.papercusp/dependency-generations')).some(
        (entry) => entry.startsWith(`.invalid-${identity}-`),
      ),
    ).toBe(true);

    const selected = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      identity,
    );
    expect(selected.status, selected.stderr).toBe(0);
  });

  it('fully revalidates a changed incumbent and reuses a valid concurrent winner', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const corruptedFile = join(generation, 'tree/node_modules/pkg/index.js');
    const winnerRoot = mkdtempSync(join(tmpdir(), 'dependency-generation-winner-'));
    roots.push(winnerRoot);
    // Build the concurrent winner through the real publisher. Copying a
    // published generation with cp -a is NOT a valid fixture: the snapshot
    // fingerprint intentionally includes inode metadata, so the copied
    // marker would (correctly) fail full validation before the race branch.
    const concurrent = publish(integration, {}, winnerRoot);
    expect(concurrent.status, concurrent.stderr).toBe(0);
    expect(publishedIdentity(concurrent.stdout)).toBe(identity);
    const winner = publishedPath(concurrent.stdout);
    chmodSync(corruptedFile, 0o644);
    writeFileSync(corruptedFile, 'corrupt\n');

    const replacement = join(generationRoot, '.concurrent-winner');
    const validationTrace = join(integration, 'validation.trace');
    const raced = publish(integration, {
      DG_GENERATION: generation,
      DG_WINNER: winner,
      DG_REPLACEMENT: replacement,
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'rm -rf "$DG_REPLACEMENT"; mv "$DG_WINNER" "$DG_REPLACEMENT"; rm -rf "$DG_GENERATION"; mv "$DG_REPLACEMENT" "$DG_GENERATION"',
    });

    expect(raced.status, raced.stderr).toBe(0);
    expect(raced.stdout).toContain('reused=true');
    expect(publishedPath(raced.stdout)).toBe(generation);
    expect(readFileSync(join(generation, 'tree/node_modules/pkg/index.js'), 'utf8')).toBe(
      'root-v1\n',
    );
    expect(raced.stderr).not.toContain(
      'skipping repeat validation under publish lock',
    );
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('rejects a malformed explicit identity before it can escape the generation root', () => {
    const integration = makeIntegration();
    const selected = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      '../../node_modules',
    );

    expect(selected.status).toBe(2);
    expect(selected.stderr).toContain(
      'invalid dependency-generation identity',
    );
  });

  it('refuses a torn source with rc75 and publishes no partial generation', () => {
    const integration = makeIntegration();
    const source = join(integration, 'node_modules/pkg/index.js');
    const result = publish(integration, {
      DG_TEST_SOURCE: source,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "mutated\\n" >> "$DG_TEST_SOURCE"',
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain(
      'changed input: node_modules (metadata fingerprint changed)',
    );
    expect(result.stderr).toContain('refusing a torn snapshot');
    const entries = readdirSync(
      join(integration, '.papercusp/dependency-generations'),
    );
    expect(entries.filter((entry) => entry.startsWith('v1-'))).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith('.build-'))).toEqual([]);
  });

  it('ignores and prunes npm/Vitest metadata churn without weakening dependency drift detection', () => {
    const integration = makeIntegration();
    const npmMetadata = join(integration, 'node_modules/.package-lock.json');
    const tempCache = join(
      integration,
      'packages/a/node_modules/.vite-temp',
    );
    const resultsCache = join(
      integration,
      'packages/a/node_modules/.vite/vitest/project-hash',
    );
    writeFileSync(npmMetadata, '{"before":true}\n');
    mkdirSync(tempCache, { recursive: true });
    mkdirSync(resultsCache, { recursive: true });
    writeFileSync(join(tempCache, 'before.tmp'), 'ephemeral\n');
    writeFileSync(join(resultsCache, 'results.json'), '{}\n');
    const result = publish(integration, {
      DG_TEST_NPM_METADATA: npmMetadata,
      DG_TEST_TEMP_CACHE: tempCache,
      DG_TEST_RESULTS_CACHE: resultsCache,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "{\\"during\\":true}\\n" > "$DG_TEST_NPM_METADATA"; printf "churn\\n" > "$DG_TEST_TEMP_CACHE/during.tmp"; printf "{\\"updated\\":true}\\n" > "$DG_TEST_RESULTS_CACHE/results.json"',
    });

    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    expect(
      existsSync(join(generation, 'tree/node_modules/.package-lock.json')),
    ).toBe(false);
    expect(
      existsSync(
        join(generation, 'tree/packages/a/node_modules/.vite-temp'),
      ),
    ).toBe(false);
    expect(
      existsSync(join(generation, 'tree/packages/a/node_modules/.vite')),
    ).toBe(false);
  });

  it('reclaims a same-host dead writer before publishing', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const abandoned = join(generationRoot, '.build-dead-writer');
    mkdirSync(join(abandoned, 'tree/node_modules/partial'), { recursive: true });
    writeFileSync(
      join(abandoned, '.papercusp-generation-writer'),
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\npid=99999999\nstarted=1\n`,
    );

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(abandoned)).toBe(false);
    expect(result.stderr).toContain('removing abandoned build');
  });

  it('preserves live and freshly-created owner state during cleanup', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const live = join(generationRoot, '.build-live-writer');
    const freshWithoutMarker = join(generationRoot, '.build-fresh-no-marker');
    mkdirSync(live, { recursive: true });
    mkdirSync(freshWithoutMarker, { recursive: true });
    writeFileSync(
      join(live, '.papercusp-generation-writer'),
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\npid=${process.pid}\nstarted=${Math.floor(Date.now() / 1000)}\n`,
    );

    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(freshWithoutMarker)).toBe(true);
  });

  it('publishes and reuses via the BSD-compatible metadata fallback', () => {
    const integration = makeIntegration();
    const env = { DEPENDENCY_GENERATION_FORCE_PORTABLE_STAT: '1' };
    const first = publish(integration, env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('reused=false');

    const second = publish(integration, env);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedPath(second.stdout)).toBe(publishedPath(first.stdout));
  });

  it('hardlinks on one filesystem and has an independent portable-copy fallback', () => {
    const integration = makeIntegration();
    const result = publish(integration);
    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    const source = join(generation, 'tree/node_modules');
    const hardlinked = join(integration, 'materialized-hardlink');
    const copied = join(integration, 'materialized-copy');
    const wrapper = [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST"',
    ].join('\n');

    const hardlinkResult = spawnSync('bash', ['-c', wrapper], {
      env: { ...process.env, SCRIPT, SOURCE: source, DEST: hardlinked },
      encoding: 'utf8',
    });
    expect(hardlinkResult.status, String(hardlinkResult.stderr ?? '')).toBe(0);
    expect(statSync(join(hardlinked, 'pkg/index.js')).ino).toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );

    const portable = spawnSync('bash', ['-c', wrapper], {
      env: {
        ...process.env,
        SCRIPT,
        SOURCE: source,
        DEST: copied,
        DEPENDENCY_GENERATION_FORCE_COPY: '1',
      },
      encoding: 'utf8',
    });
    expect(portable.status, String(portable.stderr ?? '')).toBe(0);
    expect(statSync(join(copied, 'pkg/index.js')).ino).not.toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );
    expect(readFileSync(join(copied, 'pkg/index.js'), 'utf8')).toBe('root-v1\n');
  });

  it('does not mutate immutable generation modes during repeated hardlink cleanup', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generation = publishedPath(published.stdout);
    const source = join(generation, 'tree');
    const sourceFile = join(source, 'node_modules/pkg/index.js');
    const markerPath = join(generation, '.papercusp-dependency-generation');
    const initialMode = statSync(sourceFile).mode & 0o777;
    const initialMarker = readFileSync(markerPath, 'utf8');
    // Keep the disposable checkout outside the integration root: a
    // package-local node_modules there is a real source input for the next
    // publisher and would change the generation identity unrelated to this
    // cleanup regression.
    const destinationRoot = mkdtempSync(
      join(tmpdir(), 'dependency-generation-materialized-'),
    );
    roots.push(destinationRoot);
    const destination = join(destinationRoot, 'tree');
    const wrapper = [
      'set -euo pipefail',
      'source "$SCRIPT"',
      'dependency_generation_materialize_tree "$SOURCE" "$DEST"',
    ].join('\n');

    for (let pass = 0; pass < 2; pass += 1) {
      const materialized = spawnSync('bash', ['-c', wrapper], {
        env: { ...process.env, SCRIPT, SOURCE: source, DEST: destination },
        encoding: 'utf8',
      });
      expect(materialized.status, String(materialized.stderr ?? '')).toBe(0);
    }

    expect(statSync(sourceFile).mode & 0o777).toBe(initialMode);
    expect(readFileSync(markerPath, 'utf8')).toBe(initialMarker);
    const reused = publish(integration);
    expect(reused.status, reused.stderr).toBe(0);
    expect(reused.stdout).toContain('reused=true');
    expect(publishedPath(reused.stdout)).toBe(generation);
  });

  // The manifest walk fingerprints each node_modules tree independently and
  // sorts globally, so it runs in parallel. Parallelism must remain an
  // invisible scheduling detail: if a walker ever emitted a partial or
  // out-of-order record, the manifest — and therefore the generation IDENTITY
  // derived from it — would differ run to run, and exact-id consumers would be
  // pinned against a tree that never existed. (EI-21322804786723906)
  function manifest(root: string, jobs: string): ShellResult {
    const wrapper = [
      // The publisher main runs under `set -euo pipefail`, and the serial walk
      // reports a failed tree through its pipeline status, so the walk must be
      // exercised in that same mode to be measuring the real contract.
      'set -o pipefail',
      'source "$SCRIPT"',
      'dependency_generation_set_manifest "$ROOT"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: root,
        DEPENDENCY_GENERATION_WALK_JOBS: jobs,
      },
    });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  it('produces a byte-identical manifest whether the walk is serial or parallel', () => {
    const integration = makeIntegration();
    // Names that punish naive word-splitting, plus enough trees that a
    // parallel pool genuinely overlaps rather than running one at a time.
    mkdirSync(join(integration, 'has space/node_modules/pkg'), {
      recursive: true,
    });
    writeFileSync(
      join(integration, 'has space/node_modules/pkg/index.js'),
      'spaced\n',
    );
    for (let i = 0; i < 24; i += 1) {
      mkdirSync(join(integration, `gen${i}/node_modules/p${i}`), {
        recursive: true,
      });
      writeFileSync(
        join(integration, `gen${i}/node_modules/p${i}/index.js`),
        `v${i}\n`,
      );
    }

    const serial = manifest(integration, '1');
    const parallel = manifest(integration, '8');

    expect(serial.status, serial.stderr).toBe(0);
    expect(parallel.status, parallel.stderr).toBe(0);
    // Calibration: without this the assertion below would also hold for two
    // empty manifests, i.e. for a walk that silently measured nothing.
    expect(serial.stdout.trimEnd().split('\n').length).toBeGreaterThan(20);
    expect(parallel.stdout).toBe(serial.stdout);
  });

  it('fails the manifest in both walk modes when a tree cannot be read', () => {
    const integration = makeIntegration();
    const unreadable = join(integration, 'blocked/node_modules');
    mkdirSync(unreadable, { recursive: true });
    chmodSync(unreadable, 0o000);
    try {
      // A truncated manifest must never reach the caller as a valid identity,
      // so a failed walker fails the whole walk under either scheduler.
      expect(manifest(integration, '1').status).not.toBe(0);
      expect(manifest(integration, '8').status).not.toBe(0);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });
});
