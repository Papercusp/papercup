/** Required native P010 BAR: real CLI → current operator → compiler report. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeCliCall, nativeCliTestTimeout } from './native-cli.fixture';

const baseUrl = process.env.OPERATOR_BASE_URL;
const taskBriefItem = process.env.NATIVE_TASK_BRIEF_ITEM;

describe.runIf(Boolean(baseUrl && taskBriefItem))('native P012 required BAR real CLI claim and resume', () => {
  it('attributes claim/resume source to the held task and registered repository', () => {
    const identity = call('coord:whoami', {});
    const item = call('work_items:get', { id: taskBriefItem, harness: 'papercusp',
      projection: { pick: ['results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.payload.paths'] } });
    const subject = item.results[0].workItem;
    // A current-build acceptance run may idempotently claim only its own task.
    // This test creates no work items and does not steal another session's lane.
    expect(subject.assignee).toBe(identity.ownerId);
    const route = call('dev:pipeline_position', { path: 'packages/operator-core/lib/code-intelligence/task-brief.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const claimed = call('work_items:claim', { row: `${taskBriefItem},self,papercusp`,
      projection: { pick: ['taskBrief'] } });
    const brief = claimed.taskBrief;
    expect(brief?.status, JSON.stringify(claimed)).toBe('current');
    expect(brief.repository.workspaceId).toBe(identity.workspaceId);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: brief.repository.rootPath } });
    expect(brief.scope.paths.length).toBeGreaterThan(0);
    expect(brief.scope.paths.every((path: string) => subject.payload.paths.includes(path))).toBe(true);
    for (const file of brief.files) {
      expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(brief.repository.rootPath, file.path))).digest('hex'));
    }
    const resumed = call('work_items:get', { id: taskBriefItem, harness: 'papercusp', resume: true,
      projection: { pick: ['results[].resume.taskBrief'] } });
    const refreshed = resumed.results[0].resume.taskBrief;
    expect(refreshed?.status, JSON.stringify(resumed)).toBe('current');
    expect(refreshed.repository).toEqual(brief.repository);
    expect(refreshed.sourceFingerprint).toBe(brief.sourceFingerprint);
    expect(refreshed.scope.paths).toEqual(brief.scope.paths);
  }, nativeCliTestTimeout(['coord:whoami', 'work_items:get', 'dev:pipeline_position', 'work_items:claim', 'work_items:get']));
});

describe.runIf(Boolean(baseUrl))('native P017 required BAR real CLI runtime provenance', () => {
  it('identifies a containing current-build artifact and keeps a newer private source distinct', async () => {
    const sourcePath = 'packages/operator-core/lib/code-intelligence/source-runtime-provenance.ts';
    const route = call('dev:pipeline_position', { path: sourcePath, testClass: 'operator-api',
      projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.id).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const rootProbe = call('dev:pipeline_position', { path: sourcePath, sourceRuntimeOnly: true,
      projection: { pick: ['repoRoot'] } });
    expect(typeof rootProbe.repoRoot).toBe('string');
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const captured = hash(join(rootProbe.repoRoot, sourcePath));
    const oracle = call('dev:pipeline_position', { path: sourcePath, expectedSourceSha256: captured, sourceRuntimeOnly: true });
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
      const negativeOracle = call('dev:pipeline_position', { path: rel, expectedSourceSha256: afterHash, sourceRuntimeOnly: true });
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
  }, nativeCliTestTimeout(['dev:pipeline_position', 'dev:pipeline_position', 'dev:pipeline_position',
    'graph:query', 'graph:query', 'graph:query', 'dev:pipeline_position']));
});

function call(name: string, args: Record<string, unknown>) {
  return nativeCliCall(baseUrl!, name, args);
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
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', 'code:pack']) + 80_000);
});
