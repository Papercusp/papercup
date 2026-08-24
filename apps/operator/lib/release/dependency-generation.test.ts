import { execFileSync, spawnSync } from 'node:child_process';
import {
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
const SCRIPT = join(
  REPO_ROOT,
  'apps/operator/bin/release/dependency-generation.sh',
);

const roots: string[] = [];

function makeIntegration(): string {
  const root = mkdtempSync(join(tmpdir(), 'dependency-generation-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, 'packages/a/node_modules/local'), { recursive: true });
  mkdirSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign'),
    { recursive: true },
  );
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'root-v1\n');
  writeFileSync(
    join(root, 'packages/a/node_modules/local/index.js'),
    'local-v1\n',
  );
  writeFileSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign/index.js'),
    'must-not-copy\n',
  );
  return root;
}

function publish(
  integration: string,
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT, '--integration', integration], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function publishedPath(stdout: string): string {
  const match = stdout.match(/\bpath=([^\n]+)$/m);
  if (!match) throw new Error(`missing generation path in: ${stdout}`);
  return match[1];
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

  it('refuses a torn source with rc75 and publishes no partial generation', () => {
    const integration = makeIntegration();
    const source = join(integration, 'node_modules/pkg/index.js');
    const result = publish(integration, {
      DG_TEST_SOURCE: source,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "mutated\\n" >> "$DG_TEST_SOURCE"',
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('refusing a torn snapshot');
    const entries = readdirSync(
      join(integration, '.papercusp/dependency-generations'),
    );
    expect(entries.filter((entry) => entry.startsWith('v1-'))).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith('.build-'))).toEqual([]);
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

    spawnSync('bash', ['-c', wrapper], {
      env: { ...process.env, SCRIPT, SOURCE: source, DEST: hardlinked },
      encoding: 'utf8',
    });
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
    expect(portable.status, portable.stderr).toBe(0);
    expect(statSync(join(copied, 'pkg/index.js')).ino).not.toBe(
      statSync(join(source, 'pkg/index.js')).ino,
    );
    expect(readFileSync(join(copied, 'pkg/index.js'), 'utf8')).toBe('root-v1\n');
  });
});
