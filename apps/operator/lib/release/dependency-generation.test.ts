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

// EI-21475576623166605: these tests launch several real shells and copy/hardlink/prune
// filesystem trees. Under fleet I/O contention they have measured 7–53s, so Vitest's
// 5s unit-test default fabricates a red before their product assertions run. Keep the
// larger budget local to those native-I/O cases; pure tests retain the default detector.
const NATIVE_SHELL_TIMEOUT_MS = 120_000;

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

type TelemetryRecord = Record<string, string>;

function telemetryRecords(
  stderr: string,
  kind: 'PHASE' | 'SUMMARY',
): TelemetryRecord[] {
  const prefix = `[dependency-generation] ${kind} `;
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) =>
      Object.fromEntries(
        line
          .slice(prefix.length)
          .trim()
          .split(/\s+/)
          .map((field) => {
            const separator = field.indexOf('=');
            if (separator < 1)
              throw new Error(`malformed telemetry field: ${field}`);
            return [field.slice(0, separator), field.slice(separator + 1)];
          }),
      ),
    );
}

function lastSummary(result: ShellResult): TelemetryRecord {
  const summaries = telemetryRecords(result.stderr, 'SUMMARY');
  const summary = summaries.at(-1);
  if (!summary)
    throw new Error(
      `missing dependency-generation summary in: ${result.stderr}`,
    );
  return summary;
}

function makeIntegration(): string {
  // Retention intentionally imports DIRECT sibling checkout markers. Put each
  // fixture under a private parent so that contract scans only this test's
  // siblings instead of every concurrently-active directory in the shared
  // /tmp/pcv root (which made five tiny publishes take ~59s and the full file
  // exceed the workspace's 300s watchdog).
  const parent = mkdtempSync(join(tmpdir(), 'dependency-generation-suite-'));
  const root = join(parent, 'integration');
  mkdirSync(root, { recursive: true });
  roots.push(parent);
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, 'packages/a/node_modules/local'), { recursive: true });
  mkdirSync(join(root, 'packages/b/node_modules/other'), { recursive: true });
  mkdirSync(
    join(root, '.papercusp/worktrees/repair/node_modules/foreign'),
    { recursive: true },
  );
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'root-v1\n');
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"name":"fixture","lockfileVersion":3,"packages":{}}\n',
  );
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

function publishedToken(stdout: string): string {
  const match = stdout.match(/\btoken=([^\s]+)/);
  if (!match) throw new Error(`missing generation token in: ${stdout}`);
  return match[1];
}

function selectPrewarmed(
  generationRoot: string,
  inputRoot: string,
  env: NodeJS.ProcessEnv = {},
): ShellResult {
  const result = spawnSync(
    'bash',
    [
      SCRIPT,
      '--integration',
      inputRoot,
      '--generation-root',
      generationRoot,
      '--select-inputs-from',
      inputRoot,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function ensureRef(
  integration: string,
  ref: string,
  env: NodeJS.ProcessEnv = {},
): ShellResult {
  const result = spawnSync(
    'bash',
    [SCRIPT, '--integration', integration, '--ensure-ref', ref],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function fingerprintRef(integration: string, ref: string): ShellResult {
  const result = spawnSync(
    'bash',
    [SCRIPT, '--integration', integration, '--fingerprint-ref', ref],
    { encoding: 'utf8', env: process.env },
  );
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function publishedInputFingerprint(stdout: string): string {
  const match = stdout.match(/\binput=([0-9a-f]{64})\b/);
  if (!match) throw new Error(`missing dependency input fingerprint in: ${stdout}`);
  return match[1];
}

function commitFixture(integration: string, message: string): string {
  if (!existsSync(join(integration, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'staging'], { cwd: integration });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
      cwd: integration,
    });
    execFileSync('git', ['config', 'user.name', 'fixture'], {
      cwd: integration,
    });
  }
  execFileSync(
    'git',
    [
      'add',
      'package-lock.json',
      'packages/a/package.json',
      'packages/b/package.json',
    ],
    { cwd: integration },
  );
  execFileSync('git', ['commit', '-qm', message], { cwd: integration });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: integration,
    encoding: 'utf8',
  }).trim();
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

function deepAuditGeneration(generation: string): ShellResult {
  const wrapper = [
    'set -euo pipefail',
    'source "$SCRIPT"',
    'dependency_generation_deep_audit "$GENERATION"',
    'printf "DEEP_AUDIT_OK\\n"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', wrapper], {
    encoding: 'utf8',
    env: { ...process.env, SCRIPT, GENERATION: generation },
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function invalidatePublicationToken(generation: string): void {
  const marker = join(generation, '.papercusp-dependency-generation');
  chmodSync(marker, 0o644);
  writeFileSync(
    marker,
    readFileSync(marker, 'utf8').replace(
      /^publication_token=.*$/m,
      `publication_token=v2:${'0'.repeat(64)}`,
    ),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('immutable dependency generation', () => {
  it('WI-322485: parses the whole long-running script before executing it', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const guardOpen = source.indexOf(
      '# ── Self-read guard (WI-322485):',
    );
    const firstFunction = source.indexOf('dependency_generation_log()');
    const mainCall = source.lastIndexOf('dependency_generation_main "$@"');
    const guardClose = source.lastIndexOf(
      '}  # ── end self-read guard (WI-322485) ──',
    );

    expect(guardOpen).toBeGreaterThan(source.indexOf('#!/usr/bin/env bash'));
    expect(firstFunction).toBeGreaterThan(guardOpen);
    expect(mainCall).toBeGreaterThan(firstFunction);
    expect(guardClose).toBeGreaterThan(mainCall);
    expect(source.slice(guardClose).trim()).toBe(
      '}  # ── end self-read guard (WI-322485) ──',
    );

    const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('publishes the whole product dependency set atomically and reuses its identity', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('DEPENDENCY_GENERATION_RESULT schema=1');
    expect(first.stdout).toContain('reused=false');
    expect(first.stderr).toContain(
      'capturing live dependency manifest (before copy)',
    );
    expect(first.stderr).toContain(
      'captured live dependency manifest (after copy)',
    );
    expect(first.stderr).toContain(
      'fingerprinted immutable copied dependency snapshot',
    );

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

  it(
    'P-001: reports writer-owned phases and deterministic full/hit/one-change counters',
    () => {
      const integration = makeIntegration();

      const full = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(full.status, full.stderr).toBe(0);
      const fullSummary = lastSummary(full);
      expect(fullSummary).toMatchObject({
        schema: '1',
        result: 'published',
        predecessor: 'none',
        trees_total: '3',
        trees_reused: '0',
        trees_copied: '3',
        trees_removed: '0',
      });
      expect(fullSummary.source).toMatch(/^[0-9a-f]{64}$/);
      expect(fullSummary.identity).toBe(`v1-${fullSummary.source}`);
      const fullPath = publishedPath(full.stdout);
      const fullIdentity = publishedIdentity(full.stdout);
      const fullMarker = readFileSync(
        join(fullPath, '.papercusp-dependency-generation'),
        'utf8',
      );
      expect(fullMarker).toContain('tree_manifest_schema=1\n');
      expect(fullMarker).toMatch(/tree_manifest_sha256=[0-9a-f]{64}\n/);
      expect(fullMarker).toContain('predecessor=none\n');
      expect(readFileSync(join(fullPath, '.tree-manifest'), 'utf8')).toBe(
        readFileSync(join(fullPath, '.source-after'), 'utf8'),
      );
      const fullPhases = telemetryRecords(full.stderr, 'PHASE');
      expect(fullPhases.map(({ phase }) => phase)).toEqual(
        expect.arrayContaining([
          'source-manifest-before',
          'cache-validation',
          'tree-copy',
          'source-manifest-after-copy',
          'freeze',
          'snapshot-fingerprint',
          'publish',
        ]),
      );
      for (const phase of fullPhases) {
        expect(Number(phase.duration_ms)).toBeGreaterThanOrEqual(0);
      }
      expect(Number(fullSummary.total_ms)).toBeGreaterThanOrEqual(0);

      const hit = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(hit.status, hit.stderr).toBe(0);
      expect(lastSummary(hit)).toMatchObject({
        result: 'cache-hit',
        trees_total: '3',
        trees_reused: '3',
        trees_copied: '0',
        trees_removed: '0',
      });
      expect(
        telemetryRecords(hit.stderr, 'PHASE').map(({ phase }) => phase),
      ).toEqual([
        'source-manifest-before',
        'cache-validation',
        'source-manifest-after-cache',
      ]);

      writeFileSync(
        join(integration, 'packages/a/node_modules/local/index.js'),
        'local-v2-with-one-tree-change\n',
      );
      const oneChanged = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(oneChanged.status, oneChanged.stderr).toBe(0);
      const oneChangedPath = publishedPath(oneChanged.stdout);
      const oneChangedIdentity = publishedIdentity(oneChanged.stdout);
      expect(lastSummary(oneChanged)).toMatchObject({
        result: 'published',
        predecessor: fullIdentity,
        trees_total: '3',
        trees_reused: '2',
        trees_copied: '1',
        trees_removed: '0',
      });
      expect(oneChangedIdentity).not.toBe(fullIdentity);
      expect(
        statSync(join(oneChangedPath, 'tree/node_modules/pkg/index.js')).ino,
      ).toBe(statSync(join(fullPath, 'tree/node_modules/pkg/index.js')).ino);
      expect(
        statSync(
          join(oneChangedPath, 'tree/packages/b/node_modules/other/index.js'),
        ).ino,
      ).toBe(
        statSync(join(fullPath, 'tree/packages/b/node_modules/other/index.js')).ino,
      );
      expect(
        statSync(
          join(oneChangedPath, 'tree/packages/a/node_modules/local/index.js'),
        ).ino,
      ).not.toBe(
        statSync(join(fullPath, 'tree/packages/a/node_modules/local/index.js')).ino,
      );

      rmSync(join(integration, 'packages/b/node_modules'), {
        recursive: true,
        force: true,
      });
      const oneRemoved = publish(integration, {
        DEPENDENCY_GENERATION_WALK_JOBS: '1',
      });
      expect(oneRemoved.status, oneRemoved.stderr).toBe(0);
      expect(lastSummary(oneRemoved)).toMatchObject({
        result: 'published',
        predecessor: oneChangedIdentity,
        trees_total: '2',
        trees_reused: '2',
        trees_copied: '0',
        trees_removed: '1',
      });
      expect(
        existsSync(
          join(
            publishedPath(oneRemoved.stdout),
            'tree/packages/b/node_modules',
          ),
        ),
      ).toBe(false);
    },
    NATIVE_SHELL_TIMEOUT_MS,
  );

  it('P-002: rejects corrupt reuse metadata and full-rebuilds from a valid legacy generation', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const identity = publishedIdentity(first.stdout);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const marker = join(generation, '.papercusp-dependency-generation');
    const manifest = join(generation, '.tree-manifest');

    chmodSync(manifest, 0o644);
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}corrupt\tmetadata\n`);
    const corrupt = selectGeneration(generationRoot, identity);
    expect(corrupt.status).toBe(74);
    expect(corrupt.stderr).toContain('is missing or invalid');

    rmSync(manifest);
    chmodSync(marker, 0o644);
    writeFileSync(
      marker,
      readFileSync(marker, 'utf8')
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('tree_manifest_') &&
            !line.startsWith('publication_schema=') &&
            !line.startsWith('publication_token=') &&
            !line.startsWith('predecessor=') &&
            !line.startsWith('trees_'),
        )
        .join('\n'),
    );
    const legacy = selectGeneration(generationRoot, identity);
    expect(legacy.status, legacy.stderr).toBe(0);

    writeFileSync(
      join(integration, 'packages/a/node_modules/local/index.js'),
      'legacy-fallback-change\n',
    );
    const rebuilt = publish(integration, {
      DEPENDENCY_GENERATION_WALK_JOBS: '1',
    });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(lastSummary(rebuilt)).toMatchObject({
      result: 'published',
      predecessor: 'none',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: selects a prewarmed input by immutable identity without a generation walk', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const validationTrace = join(integration, 'selection-validation.trace');

    const selected = selectPrewarmed(generationRoot, integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(
      publishedIdentity(published.stdout),
    );
    expect(publishedToken(selected.stdout)).toBe(
      publishedToken(published.stdout),
    );
    expect(existsSync(validationTrace)).toBe(false);
  });

  it('P-003: validates an ordinary cache hit from the v2 publication token without a generation walk', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    expect(publishedToken(first.stdout)).toMatch(/^v2:[0-9a-f]{64}$/);
    const generation = publishedPath(first.stdout);
    const marker = readFileSync(
      join(generation, '.papercusp-dependency-generation'),
      'utf8',
    );
    expect(marker).toContain('publication_schema=2\n');
    expect(marker).toContain(`publication_token=${publishedToken(first.stdout)}\n`);
    const validationTrace = join(integration, 'hot-validation.trace');

    const second = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('reused=true');
    expect(publishedToken(second.stdout)).toBe(publishedToken(first.stdout));
    expect(existsSync(validationTrace)).toBe(false);
    expect(
      telemetryRecords(second.stderr, 'PHASE').find(
        ({ phase }) => phase === 'cache-validation',
      ),
    ).toMatchObject({ outcome: 'hot-hit' });
  });

  it('P-003: deep-audits but rebuilds a content-valid generation whose publication token was tampered', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    invalidatePublicationToken(generation);

    const deepAudit = deepAuditGeneration(generation);
    expect(deepAudit.status, deepAudit.stderr).toBe(0);
    expect(deepAudit.stdout).toContain('DEEP_AUDIT_OK');
    const unsafeSelection = selectGeneration(
      join(integration, '.papercusp/dependency-generations'),
      publishedIdentity(first.stdout),
    );
    expect(unsafeSelection.status).toBe(74);

    const repaired = publish(integration, {
      DEPENDENCY_GENERATION_WALK_JOBS: '1',
    });
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain('reused=false');
    expect(repaired.stderr).toContain(
      'publication token invalid for content-valid generation',
    );
    expect(lastSummary(repaired)).toMatchObject({
      result: 'published',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
    expect(publishedToken(repaired.stdout)).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(publishedToken(repaired.stdout)).not.toBe(`v2:${'0'.repeat(64)}`);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('P-003: reads a pre-token generation through the legacy deep-validation fallback', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generation = publishedPath(first.stdout);
    const marker = join(generation, '.papercusp-dependency-generation');
    chmodSync(marker, 0o644);
    writeFileSync(
      marker,
      readFileSync(marker, 'utf8')
        .split('\n')
        .filter(
          (line) =>
            !line.startsWith('publication_schema=') &&
            !line.startsWith('publication_token='),
        )
        .join('\n'),
    );
    const validationTrace = join(integration, 'legacy-validation.trace');

    const legacyHit = publish(integration, {
      DEPENDENCY_GENERATION_VALIDATION_TRACE: validationTrace,
    });

    expect(legacyHit.status, legacyHit.stderr).toBe(0);
    expect(legacyHit.stdout).toContain('reused=true');
    expect(readFileSync(validationTrace, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(
      telemetryRecords(legacyHit.stderr, 'PHASE').find(
        ({ phase }) => phase === 'cache-validation',
      ),
    ).toMatchObject({ outcome: 'legacy-deep-hit' });
    expect(publishedToken(legacyHit.stdout)).not.toMatch(/^v2:/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: invalidates the selector when dependency inputs change and rewarms the new key', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );

    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/new":{}}}\n',
    );
    const miss = selectPrewarmed(generationRoot, integration);
    expect(miss.status).toBe(74);
    expect(miss.stderr).toContain('no prewarmed dependency generation');

    const rewarmed = publish(integration);
    expect(rewarmed.status, rewarmed.stderr).toBe(0);
    const selected = selectPrewarmed(generationRoot, integration);
    expect(selected.status, selected.stderr).toBe(0);
    expect(publishedIdentity(selected.stdout)).toBe(
      publishedIdentity(rewarmed.stdout),
    );
  });

  it('D-081: an unseen exact-ref fingerprint is published and selected before checkpoint serialization', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');

    const first = ensureRef(integration, candidate);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain('has unseen dependency inputs');
    expect(first.stderr).toContain('prewarming before checkpoint serialization');
    expect(first.stdout).toMatch(/\binput=[0-9a-f]{64}\b/);
    expect(first.stdout).toMatch(/\btoken=\S+/);

    // The second exact-candidate pass is the selector hit: no live generation
    // manifest walk or publication is allowed back onto the serialized path.
    const second = ensureRef(integration, candidate);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain('capturing live dependency manifest');
    expect(publishedIdentity(second.stdout)).toBe(publishedIdentity(first.stdout));
    expect(publishedToken(second.stdout)).toBe(publishedToken(first.stdout));
  });

  it('P-004: exposes the cheap immutable candidate/input key without reading mutable live lockfiles', () => {
    const integration = makeIntegration();
    const firstCandidate = commitFixture(integration, 'first dependency inputs');
    const first = fingerprintRef(integration, firstCandidate);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(
      new RegExp(
        `^DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${firstCandidate} input=[0-9a-f]{64}\\n$`,
      ),
    );

    // The producer keys the immutable candidate, never the churning worktree.
    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/live-drift":{}}}\n',
    );
    const stable = fingerprintRef(integration, firstCandidate);
    expect(stable.status, stable.stderr).toBe(0);
    expect(publishedInputFingerprint(stable.stdout)).toBe(
      publishedInputFingerprint(first.stdout),
    );

    const secondCandidate = commitFixture(integration, 'second dependency inputs');
    const second = fingerprintRef(integration, secondCandidate);
    expect(second.status, second.stderr).toBe(0);
    expect(publishedInputFingerprint(second.stdout)).not.toBe(
      publishedInputFingerprint(first.stdout),
    );
  });

  it('WI-313670: an unseen exact ref can bind a cache-hit generation without an unbound after-manifest', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'cache-hit candidate');
    const prewarmed = publish(integration);
    expect(prewarmed.status, prewarmed.stderr).toBe(0);
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    // Force only the cheap candidate-input selector to miss; the immutable
    // dependency generation itself remains a valid cache hit. This is the exact
    // main-path branch that the audited desktop build reached before set -u
    // exposed an uninitialized after_manifest.
    rmSync(join(generationRoot, '.inputs'), { recursive: true, force: true });

    const rebound = ensureRef(integration, candidate);

    expect(rebound.status, rebound.stderr).toBe(0);
    expect(rebound.stdout).toContain('reused=true');
    expect(publishedIdentity(rebound.stdout)).toBe(
      publishedIdentity(prewarmed.stdout),
    );
    expect(publishedToken(rebound.stdout)).toBe(publishedToken(prewarmed.stdout));
    expect(rebound.stderr).toContain('has unseen dependency inputs');
    expect(rebound.stderr).toContain(
      'capturing live dependency manifest (after existing-generation validation)',
    );
    expect(rebound.stderr).not.toContain('building v1-');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('D-081: exact-ref ensure fails closed when live dependency inputs no longer match the candidate', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');
    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/live-only":{}}}\n',
    );

    const result = ensureRef(integration, candidate);
    expect(result.status).toBe(74);
    expect(result.stderr).toContain('no prewarmed dependency generation');
  });

  it('keeps a completed prewarm when live lockfiles drift mid-build, indexing the pre-build inputs', () => {
    const integration = makeIntegration();
    const candidate = commitFixture(integration, 'candidate');

    // The candidate's own git-content key: the value this generation has to end
    // up indexed under for the exact-ref re-open to bind it.
    const exact = fingerprintRef(integration, candidate);
    expect(exact.status, exact.stderr).toBe(0);
    const exactInput = /\binput=([0-9a-f]{64})\b/.exec(exact.stdout)?.[1];
    expect(exactInput).toBeTruthy();

    // A peer edits a lockfile DURING the copy. node_modules cannot move here —
    // every build caller holds npm-install-safe's --exec-under-lock reader
    // mutex — but lockfiles are ordinary tracked files that mutex does not
    // cover, so this is the drift that a live/live bracket used to read as a
    // torn build and discard a ~24-minute published generation over.
    const result = ensureRef(integration, candidate, {
      DG_TEST_LOCK: join(integration, 'package-lock.json'),
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf \'{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/peer-drift":{}}}\\n\' > "$DG_TEST_LOCK"',
    });

    // The build completed and stayed published rather than aborting rc75.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'live dependency inputs changed during generation prewarm',
    );
    expect(result.stderr).not.toContain('refusing a stale selector');

    // Load-bearing: indexed under the PRE-build inputs the copied trees
    // actually reflect (which here equal the candidate's), never the drifted
    // lockfile state that was never reified into them.
    expect(publishedInputFingerprint(result.stdout)).toBe(exactInput);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('WI-41491: refuses a selector whose immutable generation token changed after prewarm', () => {
    const integration = makeIntegration();
    const published = publish(integration);
    expect(published.status, published.stderr).toBe(0);
    const generation = publishedPath(published.stdout);
    const marker = join(generation, '.papercusp-dependency-generation');
    chmodSync(marker, 0o644);
    writeFileSync(marker, `${readFileSync(marker, 'utf8')}tampered=1\n`);

    const selected = selectPrewarmed(
      join(integration, '.papercusp/dependency-generations'),
      integration,
    );
    expect(selected.status).toBe(74);
    expect(selected.stderr).toContain('has an invalid publication token');
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

    // A nested file edit is intentionally outside the O(1) publication-token
    // threat model, but the explicit deep audit must catch it. Once an audit (or
    // any immutable-object watcher) invalidates the token, the next publisher
    // rebuilds rather than trusting the still-matching identity/snapshot fields.
    chmodSync(publishedFile, 0o644);
    writeFileSync(publishedFile, 'corrupt\n');
    expect(deepAuditGeneration(generation).status).not.toBe(0);
    invalidatePublicationToken(generation);

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
    // WI-888766: this assertion used to require the `.invalid-*` quarantine to
    // still be SITTING THERE after the republish, which quietly codified the leak
    // as expected behaviour — it is the reason a permanently-uncollected 13 GiB
    // directory survived review for so long. Retention now finishes the quarantine
    // in the same publish, so absence is the correct expectation.
    //
    // The behaviour this test actually exists to prove — that a corrupt incumbent
    // is REPLACED rather than trusted — is not weakened by the flip: it is already
    // established independently above by `expect(repaired.stderr).toContain(
    // 'quarantined invalid generation')` plus the republished content check. That
    // asserts the quarantine HAPPENED; this now asserts it was also CLEANED UP.
    expect(
      readdirSync(join(integration, '.papercusp/dependency-generations')).some(
        (entry) => entry.startsWith(`.invalid-${identity}-`),
      ),
    ).toBe(false);

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
    expect(deepAuditGeneration(generation).status).not.toBe(0);
    invalidatePublicationToken(generation);

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
    expect(lastSummary(result)).toMatchObject({
      result: 'torn-source',
      trees_total: '3',
      trees_reused: '0',
      trees_copied: '3',
      trees_removed: '0',
    });
    const entries = readdirSync(
      join(integration, '.papercusp/dependency-generations'),
    );
    expect(entries.filter((entry) => entry.startsWith('v1-'))).toEqual([]);
    expect(entries.filter((entry) => entry.startsWith('.build-'))).toEqual([]);
  });

  it('P-002: refuses a torn incremental build and releases its predecessor lease', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    writeFileSync(
      join(integration, 'packages/a/node_modules/local/index.js'),
      'changed-before-incremental-build\n',
    );
    const source = join(integration, 'node_modules/pkg/index.js');

    const result = publish(integration, {
      DG_TEST_SOURCE: source,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "mutated-during-incremental-build\\n" >> "$DG_TEST_SOURCE"',
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('refusing a torn snapshot');
    expect(lastSummary(result)).toMatchObject({
      result: 'torn-source',
      predecessor: firstIdentity,
      trees_total: '3',
      trees_reused: '2',
      trees_copied: '1',
      trees_removed: '0',
    });
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('v1-')),
    ).toEqual([firstIdentity]);
    const leases = join(generationRoot, '.leases');
    expect(!existsSync(leases) || readdirSync(leases).length === 0).toBe(true);
    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('.build-')),
    ).toEqual([]);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('ignores and prunes npm/Astro/Vitest/Storybook cache churn without weakening dependency drift detection', () => {
    const integration = makeIntegration();
    const npmMetadata = join(integration, 'node_modules/.package-lock.json');
    const storybookCache = join(
      integration,
      'node_modules/.cache/storybook/10.3.6/default/dev-server',
    );
    const astroCache = join(
      integration,
      'packages/a/node_modules/.astro',
    );
    const tempCache = join(
      integration,
      'packages/a/node_modules/.vite-temp',
    );
    const resultsCache = join(
      integration,
      'packages/a/node_modules/.vite/vitest/project-hash',
    );
    writeFileSync(npmMetadata, '{"before":true}\n');
    mkdirSync(storybookCache, { recursive: true });
    mkdirSync(astroCache, { recursive: true });
    mkdirSync(tempCache, { recursive: true });
    mkdirSync(resultsCache, { recursive: true });
    writeFileSync(
      join(astroCache, 'data-store.json'),
      '{"before":true}\n',
    );
    writeFileSync(
      join(storybookCache, 'storybook-before'),
      'ephemeral\n',
    );
    writeFileSync(join(tempCache, 'before.tmp'), 'ephemeral\n');
    writeFileSync(join(resultsCache, 'results.json'), '{}\n');
    const result = publish(integration, {
      DG_TEST_NPM_METADATA: npmMetadata,
      DG_TEST_STORYBOOK_CACHE: storybookCache,
      DG_TEST_ASTRO_CACHE: astroCache,
      DG_TEST_TEMP_CACHE: tempCache,
      DG_TEST_RESULTS_CACHE: resultsCache,
      DEPENDENCY_GENERATION_AFTER_COPY_HOOK:
        'printf "{\\"during\\":true}\\n" > "$DG_TEST_NPM_METADATA"; printf "churn\\n" > "$DG_TEST_STORYBOOK_CACHE/storybook-during"; printf "{\\"during\\":true}\\n" > "$DG_TEST_ASTRO_CACHE/data-store.json"; printf "churn\\n" > "$DG_TEST_TEMP_CACHE/during.tmp"; printf "{\\"updated\\":true}\\n" > "$DG_TEST_RESULTS_CACHE/results.json"',
    });

    expect(result.status, result.stderr).toBe(0);
    const generation = publishedPath(result.stdout);
    expect(
      existsSync(join(generation, 'tree/node_modules/.package-lock.json')),
    ).toBe(false);
    expect(
      existsSync(join(generation, 'tree/node_modules/.cache')),
    ).toBe(false);
    expect(
      existsSync(
        join(generation, 'tree/packages/a/node_modules/.astro'),
      ),
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

  it('ignores crash-left deployment swap siblings in both input and dependency manifests (WI-2144371)', () => {
    const integration = makeIntegration();
    const first = publish(integration);
    expect(first.status, first.stderr).toBe(0);

    const deployTmp = join(
      integration,
      'node_modules.deploy-tmp.1592326/nested/node_modules/stale-package',
    );
    const deployOld = join(
      integration,
      'packages/a/node_modules.deploy-old.1592326/nested/node_modules/stale-package',
    );
    mkdirSync(deployTmp, { recursive: true });
    mkdirSync(deployOld, { recursive: true });
    writeFileSync(join(deployTmp, 'index.js'), 'stale temp dependency\n');
    writeFileSync(join(deployOld, 'index.js'), 'stale old dependency\n');
    writeFileSync(
      join(integration, 'node_modules.deploy-tmp.1592326/package-lock.json'),
      '{"name":"runtime-debris","lockfileVersion":3,"packages":{}}\n',
    );

    const afterDebris = publish(integration);
    expect(afterDebris.status, afterDebris.stderr).toBe(0);
    expect(afterDebris.stdout).toContain('reused=true');
    expect(publishedIdentity(afterDebris.stdout)).toBe(
      publishedIdentity(first.stdout),
    );
    expect(afterDebris.stderr).not.toContain('node_modules.deploy-tmp.1592326');
    expect(afterDebris.stderr).not.toContain('node_modules.deploy-old.1592326');
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

  it('keeps a live completed build owned until its atomic publication rename (WI-2144383)', () => {
    const integration = makeIntegration();
    const generationRoot = join(
      integration,
      '.papercusp/dependency-generations',
    );
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      // Interpose only the under-lock concurrent-winner validation. This is the
      // exact point where the publisher used to remove its build-owner marker.
      // Age the pending directory beyond cleanup's five-minute fallback and run
      // the same cleanup a contending waiter performs on every failed mkdir.
      'eval "$(declare -f dependency_generation_is_valid | sed \'1s/dependency_generation_is_valid/dependency_generation_is_valid_original/\')"',
      'dependency_generation_is_valid() {',
      '  local pending',
      '  pending="$(find "$DG_ROOT" -maxdepth 1 -type d -name \'.build-*\' -print -quit)"',
      '  test -n "$pending"',
      '  touch -d "10 minutes ago" "$pending"',
      '  dependency_generation_cleanup_abandoned "$DG_ROOT"',
      '  if test -d "$pending"; then printf "LIVE_BUILD_SURVIVED\\n" >&2; else printf "LIVE_BUILD_DELETED\\n" >&2; fi',
      '  dependency_generation_is_valid_original "$@"',
      '}',
      'dependency_generation_configure_workspace_dirs "$ROOT"',
      'dependency_generation_ensure "$ROOT" "$DG_ROOT"',
      'printf "PUBLISHED identity=%s path=%s\\n" "$DEPENDENCY_GENERATION_ID" "$DEPENDENCY_GENERATION_PATH"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SCRIPT,
        ROOT: integration,
        DG_ROOT: generationRoot,
      },
    });

    expect(result.status, String(result.stderr ?? '')).toBe(0);
    expect(String(result.stderr ?? '')).toContain('LIVE_BUILD_SURVIVED');
    expect(String(result.stderr ?? '')).not.toContain('LIVE_BUILD_DELETED');
    expect(String(result.stdout ?? '')).toMatch(
      /PUBLISHED identity=v1-[0-9a-f]{64} path=/,
    );
    expect(
      readdirSync(generationRoot).some((entry) => entry.startsWith('.build-')),
    ).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

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
  }, NATIVE_SHELL_TIMEOUT_MS);

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
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('bounds published growth to the newest set and finishes crash-left prune quarantines', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    let newestPath = '';

    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `root-v${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
      });
      expect(result.status, result.stderr).toBe(0);
      newestPath = publishedPath(result.stdout);
    }

    expect(
      readdirSync(generationRoot).filter((entry) => entry.startsWith('v1-')),
    ).toHaveLength(2);
    expect(existsSync(newestPath)).toBe(true);

    const orphan = join(generationRoot, `.prune-v1-${'f'.repeat(64)}-stale`);
    mkdirSync(join(orphan, 'tree/pkg'), { recursive: true });
    writeFileSync(join(orphan, 'tree/pkg/index.js'), 'stale\n');
    chmodSync(join(orphan, 'tree/pkg/index.js'), 0o444);
    const reused = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(reused.status, reused.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('removes input selectors before pruning the generation they reference (WI-2144343)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const originalLockfile = readFileSync(join(integration, 'package-lock.json'), 'utf8');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstPath = publishedPath(first.stdout);
    const firstInput = publishedInputFingerprint(first.stdout);
    const firstSelector = join(generationRoot, '.inputs', firstInput);
    expect(existsSync(firstSelector)).toBe(true);

    writeFileSync(
      join(integration, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/new-input":{}}}\n',
    );
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'new-generation\n');
    const second = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(second.status, second.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(firstSelector)).toBe(false);
    expect(second.stderr).toContain(
      `removed input selector ${firstInput} for pruned generation`,
    );

    // Restoring the old dependency inputs now produces a rebuildable miss. The
    // pre-fix dangling selector instead resolved the deleted identity forever
    // and failed as an invalid publication token.
    writeFileSync(join(integration, 'package-lock.json'), originalLockfile);
    const oldInput = selectPrewarmed(generationRoot, integration);
    expect(oldInput.status).toBe(74);
    expect(oldInput.stderr).toContain('no prewarmed dependency generation');
    expect(oldInput.stderr).not.toContain('invalid publication token');
  }, NATIVE_SHELL_TIMEOUT_MS);

  // WI-888766. The sibling case above has guarded `.prune-*` collection for a long
  // time while `.invalid-*` leaked permanently, which is precisely why the leak
  // survived: the only other `.invalid-` assertion in this file checks that the
  // quarantine is CREATED, and a create-only assertion passes just as happily when
  // nothing ever collects it. Being a dotfile, it was also invisible to the `v1-*`
  // census glob, so it never registered as a generation at all.
  //
  // Cost of the gap in production: each quarantine is a full node_modules
  // materialization (~13 GiB), three had stranded 39 GiB for 2-4 days, and the
  // resulting 95%-full root filesystem made the cargo lane's disk-headroom
  // admission REFUSE to spawn — surfacing as a red @papercusp/desktop in the gate,
  // i.e. a disk leak wearing a test failure's clothes.
  it('finishes crash-left INVALID quarantines, not just prune ones (WI-888766)', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(first.status, first.stderr).toBe(0);

    // Shaped exactly like a real one: `.invalid-<identity>-<epoch>.<pid>`, with a
    // read-only payload, since generations are published immutable and the
    // collector has to chmod directories before it can unlink.
    const orphan = join(
      generationRoot,
      `.invalid-v1-${'e'.repeat(64)}-1787702669.1654514`,
    );
    mkdirSync(join(orphan, 'tree/pkg'), { recursive: true });
    writeFileSync(join(orphan, 'tree/pkg/index.js'), 'stale\n');
    chmodSync(join(orphan, 'tree/pkg/index.js'), 0o444);

    const reused = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(reused.status, reused.stderr).toBe(0);
    expect(existsSync(orphan)).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('imports direct sibling checkout pins and prunes them after their marker goes stale', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const checkout = `${integration}-checkpoint`;
    roots.push(checkout);
    mkdirSync(join(checkout, 'node_modules'), { recursive: true });
    writeFileSync(
      join(checkout, 'node_modules/.papercusp-dependency-generation'),
      `identity=${firstIdentity}\nsource=${firstIdentity.slice(3)}\n`,
    );

    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `new-${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '2',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(existsSync(firstPath)).toBe(true);
    expect(
      readdirSync(join(generationRoot, '.pins')).some((entry) =>
        readFileSync(join(generationRoot, '.pins', entry), 'utf8').includes(
          `identity=${firstIdentity}\n`,
        ),
      ),
    ).toBe(true);

    rmSync(join(checkout, 'node_modules/.papercusp-dependency-generation'));
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'after-stale-pin\n');
    const after = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
    expect(
      readdirSync(join(generationRoot, '.pins')).some((entry) =>
        readFileSync(join(generationRoot, '.pins', entry), 'utf8').includes(
          `identity=${firstIdentity}\n`,
        ),
      ),
    ).toBe(false);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('protects a live exact-identity selector lease and reclaims it after the reader is gone', () => {
    const integration = makeIntegration();
    const generationRoot = join(integration, '.papercusp/dependency-generations');
    const first = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(first.status, first.stderr).toBe(0);
    const firstIdentity = publishedIdentity(first.stdout);
    const firstPath = publishedPath(first.stdout);
    const lease = join(generationRoot, '.leases/live-test');
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(
      lease,
      `host=${execFileSync('hostname', { encoding: 'utf8' }).trim()}\n` +
        `pid=${process.pid}\nstarted=1\nidentity=${firstIdentity}\n`,
    );

    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(join(integration, 'node_modules/pkg/index.js'), `leased-${i}\n`);
      const result = publish(integration, {
        DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
      });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(existsSync(firstPath)).toBe(true);

    rmSync(lease);
    writeFileSync(join(integration, 'node_modules/pkg/index.js'), 'reader-gone\n');
    const after = publish(integration, {
      DEPENDENCY_GENERATION_RETAIN_COUNT: '1',
    });
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(firstPath)).toBe(false);
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

describe('WI-42354: the generation store is born un-committable', () => {
  // The store is host-local runtime state (leases, materialized trees, and pins whose
  // only mutating field is `updated=<epoch>`) that happens to live INSIDE a git working
  // tree. While it was tracked, every run rewrote a pin heartbeat, git-sync committed
  // the churn, the pot's tip moved, and the NEXT run saw "changes" and re-materialized
  // from scratch — perpetual motion that kept ~20 hourly gates redoing full setup.
  // Untracking the 7 existing repos was the data fix; these tests guard the CLASS, so a
  // store created in a pot that does not exist yet cannot reintroduce it.

  it('writes a self-ignoring .gitignore into the store root on publish', () => {
    const integration = makeIntegration();
    expect(publish(integration).status).toBe(0);
    const ignore = join(integration, '.papercusp/dependency-generations/.gitignore');
    expect(existsSync(ignore)).toBe(true);
    // '*' also ignores the .gitignore itself — deliberate: nothing under this root
    // should ever reach git, and the marker must not depend on the enclosing repo's
    // .gitignore, which a newly-created pot will not yet have.
    expect(readFileSync(ignore, 'utf8').trim()).toBe('*');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('git reports NOTHING to commit for a store that has published pins', () => {
    const integration = makeIntegration();
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', integration, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    // CALIBRATION: before the store exists, this fixture is full of untracked files, so
    // an empty `git status` would mean the probe is broken rather than the guard working.
    expect(git('status', '--porcelain').stdout.trim()).not.toBe('');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    expect(git('status', '--porcelain').stdout.trim()).toBe('');

    expect(publish(integration).status).toBe(0);
    const pins = join(integration, '.papercusp/dependency-generations/.pins');
    mkdirSync(pins, { recursive: true });
    writeFileSync(join(pins, 'checkout-deadbeef'), 'schema=1\nupdated=1787000000\n');

    // THE REGRESSION: publishing + a pin heartbeat must leave git with nothing to say.
    // Without the guard this reports `?? .papercusp/` — the exact churn that moved
    // dormant pot tips every hour and defeated the gate's up-to-date short-circuit.
    expect(git('status', '--porcelain').stdout.trim()).toBe('');
  }, NATIVE_SHELL_TIMEOUT_MS);
});

// The publish lock is documented as "short", and its waiter used to give up after a
// fixed 300 attempts (30s) and return 73 — which every one of its six call sites
// propagates as a hard failure. That combination is a BOUNDED waiter against an
// UNBOUNDED holder: acquire()'s retry loop calls cleanup_abandoned on EVERY failed
// mkdir, so a same-host lock whose writer PID is dead is reclaimed within one 0.1s
// tick. The budget is therefore never spent on an abandoned lock — it can only ever
// be reached while the holder is genuinely ALIVE, doing legitimate work (the
// full-tree validation walk on the replacement/removal race, or a retention prune),
// which on a multi-GB generation runs for minutes. Reaching it crashed the caller
// outright: green-checkpoint recorded `inconclusive: error` and never ran a suite.
describe('dependency-generation publish-lock waiter', () => {
  function publishLockScenario(
    scenario: 'dead-writer' | 'live-then-release' | 'live-holder',
    env: Record<string, string> = {},
    timeoutMs?: number,
  ): ShellResult & { signal: NodeJS.Signals | null } {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-publish-lock-'));
    roots.push(root);
    const wrapper = [
      'set -uo pipefail',
      'source "$SCRIPT"',
      'lock="$ROOT/.publish-lock"',
      'mkdir "$lock"',
      // Every background holder gets its OWN stdio. Inheriting the pipes makes an
      // orphaned holder outlive the spawnSync timeout still holding them open, so
      // the parent blocks on EOF long after the child was killed — the run then
      // takes ~40s per timeout case instead of the budget under test.
      'case "$SCENARIO" in',
      // A pid we have already reaped is definitively dead, so cleanup_abandoned
      // must reclaim it rather than the waiter burning its budget on it.
      '  dead-writer) sleep 0 </dev/null >/dev/null 2>&1 & holder=$!; wait "$holder" 2>/dev/null || true ;;',
      '  live-then-release) sleep 300 </dev/null >/dev/null 2>&1 & holder=$!; ( sleep 2; rm -rf -- "$lock" ) </dev/null >/dev/null 2>&1 & ;;',
      '  live-holder) sleep 45 </dev/null >/dev/null 2>&1 & holder=$! ;;',
      'esac',
      'printf "host=%s\\npid=%s\\nstarted=%s\\n" \\',
      '  "$(dependency_generation_host)" "$holder" "$(date +%s)" > "$lock/writer"',
      'if dependency_generation_acquire_publish_lock "$ROOT"; then',
      '  printf "ACQUIRED\\n"',
      'else',
      '  printf "FAILED rc=%s\\n" "$?"',
      'fi',
      'kill "$holder" 2>/dev/null || true',
    ].join('\n');
    const result = spawnSync('bash', ['-c', wrapper], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, SCRIPT, ROOT: root, SCENARIO: scenario, ...env },
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  it('reclaims a lock whose writer PID is dead instead of waiting out the budget', () => {
    // This is the premise that makes a generous budget safe: an abandoned lock is
    // never what the waiter is waiting for. A 1s budget is far too short to outlast
    // anything, so acquiring proves the reclaim path ran, not that we waited it out.
    const result = publishLockScenario('dead-writer', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '1',
    });
    expect(result.stdout).toContain('ACQUIRED');
    expect(result.stderr).toContain('quarantined abandoned publish lock');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('waits for a LIVE holder and acquires the lock once it is released', () => {
    const result = publishLockScenario('live-then-release', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '30',
    });
    expect(result.stdout).toContain('ACQUIRED');
    expect(result.stdout).not.toContain('FAILED');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('honours the configured budget and NAMES the live holder when it times out', () => {
    // A bare "timed out" left the reader unable to tell contention from a wedged
    // writer; the message must identify who held it and for how long.
    const result = publishLockScenario('live-holder', {
      DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: '1',
    });
    expect(result.stdout).toContain('FAILED rc=73');
    expect(result.stderr).toMatch(
      /FATAL: timed out waiting for the short dependency-generation publish lock after \d+s of 1s/,
    );
    expect(result.stderr).toMatch(/holder host=\S+ pid=\d+ held=\d+s/);
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('falls back to the default budget when the override is not a number', () => {
    // A non-numeric override must not degrade to 0 attempts (an instant exit 73).
    const result = publishLockScenario(
      'live-holder',
      { DEPENDENCY_GENERATION_PUBLISH_LOCK_TIMEOUT_SEC: 'not-a-number' },
      5_000,
    );
    expect(result.stdout).not.toContain('FAILED');
    expect(result.signal).toBe('SIGTERM');
  }, NATIVE_SHELL_TIMEOUT_MS);

  it('THE REGRESSION: the default budget outlasts the old 30s hard-fail', () => {
    // Directly falsifies the pre-fix behaviour. With a live holder and no override,
    // the waiter must STILL be waiting after 30s rather than having returned 73 —
    // and its progress heartbeat must name the resolved default, so this asserts the
    // magnitude behaviourally instead of regex-matching the constant in the source.
    // 38s, not 33s: the heartbeat lands at 30s and each loop iteration also scans
    // the generation store, so a loaded box can push it out by a second or two.
    const result = publishLockScenario('live-holder', {}, 38_000);
    expect(result.stdout).not.toContain('FAILED');
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toMatch(
      /still waiting for the dependency-generation publish lock after 3\ds of 900s/,
    );
  }, NATIVE_SHELL_TIMEOUT_MS);
});
