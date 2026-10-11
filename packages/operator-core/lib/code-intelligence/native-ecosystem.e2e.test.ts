/** Required native P010 BAR: real CLI → current operator → compiler report. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const baseUrl = process.env.OPERATOR_BASE_URL;
const repoRoot = resolve(import.meta.dirname, '../../../..');

describe.runIf(Boolean(baseUrl))('native P017 required BAR real CLI runtime provenance', () => {
  it('identifies a containing current-build artifact and keeps a newer private source distinct', async () => {
    const sourcePath = 'packages/operator-core/lib/code-intelligence/source-runtime-provenance.ts';
    const route = call('dev:pipeline_position', { path: sourcePath, testClass: 'operator-api',
      projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.id).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const rootProbe = call('dev:pipeline_position', { path: sourcePath, view: 'source-runtime',
      projection: { pick: ['repoRoot'] } });
    expect(typeof rootProbe.repoRoot).toBe('string');
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const captured = hash(join(rootProbe.repoRoot, sourcePath));
    const oracle = call('dev:pipeline_position', { path: sourcePath, expectedSourceSha256: captured, view: 'source-runtime' });
    const runtime = oracle.servingRuntimes.find((row: { runtime: string }) => row.runtime === 'staging-operator');
    expect(oracle.acceptedSource.matches).toBe(true);
    expect(runtime.containsChange).toBe(true);
    const query = (name: string, file: string, selected = 'staging-operator') => call('graph:query', {
      op: 'symbol', name, file_path: file, paths: [file], runtime: selected, runtime_limit: 8,
      projection: { pick: ['error', 'evidence.sourceScope', 'evidence.siteIdentities', 'runtimeProvenance'] },
    });
    const loaded = query('sourceRuntimeProvenance', sourcePath);
    expect(loaded.error).toBeNull();
    const loadedFile = loaded.runtimeProvenance.files.find((row: { path: string }) => row.path === sourcePath);
    expect(loadedFile).toMatchObject({ capturedSourceSha256: captured, editedSourceSha256: captured,
      artifact: { buildSha: runtime.buildSha }, containsCapturedSource: true });
    expect(loaded.runtimeProvenance.repositoryId).toBe(loaded.evidence.sourceScope.repositoryId);

    // Explicit file scope lets the real compiler read this ignored, private source.
    // It cannot enter git-sync or either loaded artifact, and no product file is edited.
    const scratch = join(rootProbe.repoRoot, '.papercusp/scratch');
    mkdirSync(scratch, { recursive: true });
    const project = mkdtempSync(join(scratch, 'native-runtime-e2e-'));
    const file = join(project, 'target.ts');
    const rel = relative(rootProbe.repoRoot, file).split('\\').join('/');
    try {
      writeFileSync(file, 'export function nativeRuntimePrivateTarget() { return 1; }\n');
      const beforeHash = hash(file);
      const before = query('nativeRuntimePrivateTarget', rel);
      expect(before.error).toBeNull();
      expect(before.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: beforeHash,
        containsCapturedSource: null, artifact: expect.objectContaining({ buildSha: expect.stringMatching(/^[a-f0-9]{4,64}$/) }) })]);
      writeFileSync(file, 'export function nativeRuntimePrivateTarget() { return 2; }\n');
      const afterHash = hash(file);
      expect(afterHash).not.toBe(beforeHash);
      const after = query('nativeRuntimePrivateTarget', rel, 'release-operator');
      const negativeOracle = call('dev:pipeline_position', { path: rel, expectedSourceSha256: afterHash, view: 'source-runtime' });
      const release = negativeOracle.servingRuntimes.find((row: { runtime: string }) => row.runtime === 'release-operator');
      // The production blob reader treats an absent artifact path as unknown.
      // Preserve that uncertainty rather than upgrading it to a measured mismatch.
      expect(release.containsChange).toBeNull();
      expect(after.error).toBeNull();
      expect(after.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: afterHash,
        editedSourceSha256: afterHash, artifact: expect.objectContaining({ buildSha: release.buildSha }), containsCapturedSource: null })]);
      expect(after.runtimeProvenance.files[0].reason).toMatch(/unmeasured/);
      expect(after.runtimeProvenance.sourceFingerprint).not.toBe(before.runtimeProvenance.sourceFingerprint);
      expect(after.evidence.siteIdentities[0].contentHash).toBe(afterHash);
      expect(after.runtimeProvenance.limitations.join(' ')).toMatch(/neither establishes runtime execution/);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 360_000);
});

function call(name: string, args: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [join(repoRoot, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${baseUrl}`, '--json', '-'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 120_000, input: JSON.stringify({ name, args }),
    env: { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' },
  });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.ok).not.toBe(false);
  return parsed.data ?? parsed;
}

describe.runIf(Boolean(baseUrl))('native P010 required BAR real CLI change report', () => {
  it('cites both reference consumers and rechecks the remaining consumer after a source edit', async () => {
    const route = call('dev:pipeline_position', {
      path: 'packages/operator-core/lib/agent-tools/lsp/pack.ts', testClass: 'operator-api',
      marker: 'previousFingerprint', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] },
    });
    expect(route.currentBuildTestRoute.id).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const health = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
    expect(health.ok).toBe(true);
    const build = await health.json() as { sha: string };
    const project = mkdtempSync(join(tmpdir(), 'native-ecosystem-e2e-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 1; }\n');
      writeFileSync(join(project, 'first.ts'), 'import { changedTarget } from "./target";\nexport function first() { return changedTarget(); }\n');
      writeFileSync(join(project, 'second.ts'), 'import { changedTarget as alias } from "./target";\nexport function second() { return alias(); }\n');
      git(['init', '-q']);
      git(['config', 'user.name', 'native BAR private fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']);
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reference fixture']);
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 2; }\n');
      const args = {
        op: 'diff', include: ['*.ts'], rootPath: project, baseRef: 'HEAD',
        explain: { symbol: 'changedTarget', file: 'target.ts', paths: ['.'], phase: 'pre-review' },
        projection: { pick: ['answer.error', 'answer.backend', 'report.changed', 'report.consumers',
          'report.sourceFingerprint', 'report.freshness', 'report.provenance.runtime', 'report.limitations'] },
      };
      const first = call('code:pack', args);
      expect(first.answer.error).toBeNull();
      expect(first.answer.backend).toBe('typescript-service');
      expect(first.report.changed).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target.ts' })]));
      expect(first.report.consumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'first.ts', line1: 2 }),
        expect.objectContaining({ path: 'second.ts', line1: 2 }),
      ]));
      expect(first.report.provenance.runtime.sha).toBe(build.sha);
      writeFileSync(join(project, 'first.ts'), 'export function first() { return 2; }\n');
      const edited = call('code:pack', { ...args,
        explain: { ...args.explain, previousFingerprint: first.report.sourceFingerprint } });
      expect(edited.report.freshness).toBe('changed');
      expect(edited.report.consumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'second.ts', line1: 2 }),
      ]));
      expect(edited.report.consumers.some((consumer: { path: string }) => consumer.path === 'first.ts')).toBe(false);
      expect(edited.report.limitations.some((line: string) => line.includes('runtime execution'))).toBe(true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, 360_000);
});
