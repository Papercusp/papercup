/** Required native P010 BAR: real CLI → current operator → compiler report. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeCliCall, nativeCliTestTimeout, nativeFixtureProcess } from './native-cli.fixture';
import './scoped-contracts.e2e.test';

const baseUrl = process.env.OPERATOR_BASE_URL;
const taskBriefItem = process.env.NATIVE_TASK_BRIEF_ITEM;
const planningPlan = process.env.NATIVE_PLANNING_PLAN;

describe('native P018 private operator CLI incident claim and resume', () => {
  it('carries an actual failed assertion and compiler candidate, then clears the incident after a passing rerun', async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    // Prepare the maintained ESM handler artifact before allocating private PG.
    // A direct tsx import of apps/operator's CommonJS entry is intentionally
    // refused by the committed-source guard.
    const artifactRoot = mkdtempSync(join(tmpdir(), 'native-incident-handler-'));
    const handlerPath = join(artifactRoot, 'handler.mjs');
    const build = spawnSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/host-handler.ts', handlerPath], {
      cwd: root, env: process.env, encoding: 'utf8', timeout: 120_000,
    });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const handlerHash = createHash('sha256').update(readFileSync(handlerPath)).digest('hex');
    try {
    let lastStage = 'private-pg-bootstrap';
    const progress = setInterval(() => console.log(`NATIVE_INCIDENT_API_PROGRESS=${lastStage}`), 10_000);
    let result;
    try {
      result = await nativeFixtureProcess(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        join(import.meta.dirname, '__fixtures__/incident-api-client.ts'),
        join(homedir(), '.papercusp/vendor/repomix'), join(homedir(), '.papercusp/vendor/lsp'), handlerPath, handlerHash], {
        cwd: root, env: { ...process.env, TMPDIR: '/dev/shm' }, timeoutMs: 180_000,
        onOutput: text => {
          for (const line of text.split('\n')) if (line.startsWith('NATIVE_INCIDENT_API_STAGE=')) {
            lastStage = line.slice('NATIVE_INCIDENT_API_STAGE='.length);
            console.log(line);
          }
        },
      });
    } finally { clearInterval(progress); }
    expect(result.code, result.output).toBe(0);
    const line = result.output.split('\n').find(row => row.startsWith('NATIVE_INCIDENT_API_PROOF='));
    expect(line, result.output).toBeDefined();
    expect(JSON.parse(line!.slice('NATIVE_INCIDENT_API_PROOF='.length))).toMatchObject({
      transport: 'real-cli-http', failure: 'actual-node-assertion', staticCandidate: true,
      cause: 'unknown', runtimeExecution: 'unmeasured', resume: 'current', repaired: true,
    });
    } finally { rmSync(artifactRoot, { recursive: true, force: true }); }
  // The build and private journey have separate producer deadlines. The test
  // deadline must allow both plus the maintained process-group exit fence.
  }, 120_000 + 180_000 + 20_000);
});

describe.runIf(Boolean(baseUrl && planningPlan))('native P013 real CLI graph planning advice', () => {
  it('orders scoped producer/consumer references and reports overlap without changing live assignments or file claims', () => {
    const identity = call('coord:whoami', {});
    const producer = 'packages/operator-core/lib/agent-tools/plans/plan-dag-parallelism.ts';
    const consumer = 'packages/operator-core/lib/agent-tools/plans/lint.ts';
    const shared = 'packages/operator-core/lib/agent-tools/plans/native-planning-advice.integration.test.ts';
    const itemIds = (process.env.NATIVE_PLANNING_ITEMS ?? 'P-019,P-024').split(',');
    const itemArgs = { slug: planningPlan, harness: 'papercusp', itemIds,
      projection: { pick: ['items[].item.id', 'items[].item.storedStatus', 'items[].item.blockedBy',
        'items[].coverage.workers', 'items[].coverage.holder.ownerId'] } };
    const before = call('plans:items', itemArgs);
    expect(before.items).toHaveLength(2);
    expect(before.items.every((row: { coverage?: { workers?: string[] } }) =>
      row.coverage?.workers?.includes(identity.ownerId)), `Planning fixture needs two current caller-held items: ${JSON.stringify(before)}`).toBe(true);
    const claimArgs = { paths: [producer, consumer, shared],
      projection: { pick: ['active_locks[].lock_id', 'active_locks[].path', 'active_locks[].owner',
        'active_locks[].intent', 'active_locks[].coordination_domain'] } };
    const claims = call('locks:queue', claimArgs);
    for (const path of [consumer, 'packages/operator-core/lib/code-intelligence/first-party-callers.ts',
      'packages/operator-core/lib/code-intelligence/first-party-traversal.ts']) {
      const route = call('dev:pipeline_position', { path, testClass: 'operator-api',
        projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
      expect(route.currentBuildTestRoute.readiness).toBe('ready');
      expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
        row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    }
    // These held IDs are reference task labels for the caller-supplied code scope.
    // The advisory must not rewrite their authoritative paths or dependencies.
    const advice = (reverse: boolean) => call('plans:lint', { slug: planningPlan, harness: 'papercusp',
      codeScope: { symbol: 'nativePlanGraphAdvice', file: producer, paths: [producer, consumer], taskPaths: [
        { itemId: itemIds[0], paths: [reverse ? consumer : producer, shared] },
        { itemId: itemIds[1], paths: [reverse ? producer : consumer, shared] },
      ] }, projection: { pick: ['results[].ok', 'results[].report.codeAdvice.status',
        'results[].report.codeAdvice.ordering', 'results[].report.codeAdvice.proposedOrder',
        'results[].report.codeAdvice.overlaps', 'results[].report.codeAdvice.scope.repositoryId',
        'results[].report.codeAdvice.ownership[].itemId', 'results[].report.codeAdvice.ownership[].coverage.workers',
        'results[].report.codeAdvice.fileClaims.status'] } }).results[0].report.codeAdvice;
    for (const reverse of [false, true]) {
      const result = advice(reverse);
      expect(result.status, JSON.stringify(result)).toBe('measured');
      const [first, second] = reverse ? [...itemIds].reverse() : itemIds;
      expect(result.ordering).toContainEqual(expect.objectContaining({ producer: first, consumer: second,
        sourcePath: consumer, targetPath: producer }));
      expect(result.proposedOrder.indexOf(first)).toBeLessThan(result.proposedOrder.indexOf(second));
      expect(result.overlaps).toContainEqual({ items: itemIds, paths: [shared] });
      expect(result.scope.repositoryId).toBeTruthy();
      expect(result.ownership.every((row: { coverage: { workers: string[] } }) => row.coverage.workers.includes(identity.ownerId))).toBe(true);
      expect(result.fileClaims.status).toBe('measured');
    }
    expect(call('plans:items', itemArgs)).toEqual(before);
    expect(call('locks:queue', claimArgs)).toEqual(claims);
  }, nativeCliTestTimeout(['coord:whoami', 'plans:items', 'locks:queue', ...Array<string>(3).fill('dev:pipeline_position'),
    'plans:lint', 'plans:lint', 'plans:items', 'locks:queue']));
});

describe.runIf(Boolean(baseUrl))('native P021 real CLI source/path expansion', () => {
  it('expands budget-omitted captured records through capability:read after the source changes', () => {
    const route = call('dev:pipeline_position', { path: 'packages/operator-core/lib/code-intelligence/packer-facade.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const project = mkdtempSync(join(tmpdir(), 'native-bundle-cli-'));
    let artifact: string | null = null;
    try {
      writeFileSync(join(project, 'target.ts'), 'export function cliBundleTarget() { return "CAPTURED_CLI_LITERAL"; }\n');
      for (let index = 0; index < 4; index++) writeFileSync(join(project, `client${index}.ts`),
        `import { cliBundleTarget } from "./target";\nexport function client${index}() { return cliBundleTarget(); }\n`);
      const result = call('code:pack', { op: 'diff', rootPath: project, include: ['*.ts'],
        explain: { symbol: 'cliBundleTarget', file: 'target.ts', paths: ['.'], phase: 'pre-edit' },
        projection: { pick: ['answer.error', 'report.bundle'] } });
      expect(result.answer.error).toBeNull();
      const bundle = result.report.bundle;
      expect(bundle.omitted.symbols + bundle.omitted.edges + bundle.omitted.paths).toBeGreaterThan(0);
      expect(bundle.coverage.sourceCompleteness).toBe('unverified');
      artifact = bundle.expansion.args.file_path;
      writeFileSync(join(project, 'target.ts'), 'export function cliBundleTarget() { return "NEW_CLI_LITERAL"; }\n');
      const pages: Buffer[] = [];
      let cursor = bundle.expansion;
      for (let pageIndex = 0; cursor && pageIndex < 16; pageIndex++) {
        const page = call(cursor.tool, cursor.args);
        expect(page.ok).toBe(true);
        const bytes = Buffer.from(page.data, 'base64');
        expect(bytes.toString('base64')).toBe(page.data);
        expect(bytes.length).toBe(page.byte_length);
        expect(page.byte_offset).toBe(pages.reduce((total, row) => total + row.length, 0));
        pages.push(bytes);
        expect(Boolean(page.next_cursor)).toBe(!page.eof);
        cursor = page.next_cursor;
      }
      expect(cursor).toBeNull();
      const document = Buffer.concat(pages).toString('utf8');
      expect(createHash('sha256').update(document).digest('hex')).toBe(bundle.expansion.sha256);
      const expanded = JSON.parse(document);
      expect(expanded.context.paths).toHaveLength(4);
      expect(expanded.context.edges).toHaveLength(4);
      expect(document).toContain('CAPTURED_CLI_LITERAL');
      expect(document).not.toContain('NEW_CLI_LITERAL');
    } finally {
      if (artifact) rmSync(artifact, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', ...Array<string>(16).fill('capability:read')]));
});

describe.runIf(Boolean(baseUrl))('native P014 required BAR real CLI interface change report', () => {
  it('exposes the changed response field and its incompatible registered fixture client, then clears the mismatch after the client adapts', () => {
    const route = call('dev:pipeline_position', { path: 'packages/operator-core/lib/code-intelligence/first-party-callers.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const project = mkdtempSync(join(tmpdir(), 'native-interface-cli-'));
    const args = { op: 'diff', include: ['*.ts'], rootPath: project,
      explain: { symbol: 'readApi', file: 'target.ts', paths: ['.'], phase: 'pre-edit' },
      projection: { pick: ['answer.error', 'report.interfaces', 'report.sourceFingerprint', 'report.freshness'] } };
    try {
      writeFileSync(join(project, 'target.ts'), 'export interface Response { value: string; }\nexport function readApi(): Response { return { value: "ok" }; }\n');
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().value.length; }\n');
      writeFileSync(join(project, 'contract.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\nimport { z } from "zod";\nimport { readApi } from "./target";\nconst request = z.object({}); const result = z.object({ value: z.string() });\nexport const tool = defineTool({ name: "native-p014-fixture:read", args: request, result, handler: readApi });\n');
      const before = call('code:pack', args);
      expect(before.answer.error).toBeNull();
      expect(before.report.interfaces.status).toBe('measured');
      expect(before.report.interfaces.mismatchedConsumers).toEqual([]);
      expect(before.report.interfaces.registrations).toContainEqual(expect.objectContaining({ name: 'native-p014-fixture:read',
        factoryAuthority: 'maintained-import', responseValidator: expect.objectContaining({ path: 'contract.ts' }), runtimeRegistered: 'unmeasured' }));
      writeFileSync(join(project, 'target.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
      const after = call('code:pack', { ...args, explain: { ...args.explain, previousFingerprint: before.report.sourceFingerprint } });
      expect(after.report.freshness).toBe('changed');
      expect(after.report.interfaces.diagnostics).toContainEqual(expect.objectContaining({ code: 2339,
        site: expect.objectContaining({ path: 'client.ts', line1: 2 }), message: expect.stringContaining("'value'") }));
      expect(after.report.interfaces.mismatchedConsumers).toContainEqual(expect.objectContaining({ path: 'client.ts', line1: 2 }));
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().label.length; }\n');
      expect(call('code:pack', args).report.interfaces.mismatchedConsumers).toEqual([]);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', 'code:pack', 'code:pack']) + 60_000);
});

describe.runIf(Boolean(baseUrl && taskBriefItem))('native P012 required BAR real CLI claim and resume', () => {
  it('attributes claim/resume source to the held task and registered repository', () => {
    const identity = call('coord:whoami', {});
    const item = call('work_items:get', { id: taskBriefItem, harness: 'papercusp',
      projection: { pick: ['results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.payload.paths'] } });
    const subject = item.results[0].workItem;
    // A current-build acceptance run may idempotently claim only its own task.
    // This test creates no work items and does not steal another session's lane.
    expect(subject.assignee).toBe(identity.ownerId);
    expect(subject.payload?.paths?.length, 'Task brief fixture requires stored payload.paths on its caller-owned item').toBeGreaterThan(0);
    const route = call('dev:pipeline_position', { path: 'packages/operator-core/lib/code-intelligence/task-brief.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const claimed = call('work_items:claim', { row: `${taskBriefItem},self,papercusp`,
      projection: { pick: ['results[].taskBrief.status', 'results[].taskBrief.repository',
        'results[].taskBrief.recover', 'results[].taskBrief.scope.paths', 'results[].taskBrief.files[].path',
        'results[].taskBrief.files[].sha256', 'results[].taskBrief.sourceFingerprint'] } });
    const brief = claimed.results?.[0]?.taskBrief;
    expect(brief?.status, JSON.stringify(claimed)).toBe('current');
    expect(brief.repository.workspaceId).toBe(identity.workspaceId);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: brief.repository.rootPath } });
    expect(brief.scope.paths.length).toBeGreaterThan(0);
    expect(brief.scope.paths.every((path: string) => subject.payload.paths.includes(path))).toBe(true);
    for (const file of brief.files) {
      expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(brief.repository.rootPath, file.path))).digest('hex'));
    }
    const resumed = call('work_items:get', { id: taskBriefItem, harness: 'papercusp', resume: true,
      projection: { pick: ['results[].resume.taskBrief.status', 'results[].resume.taskBrief.repository',
        'results[].resume.taskBrief.sourceFingerprint', 'results[].resume.taskBrief.scope.paths'] } });
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
