/** Preregistered comparison over actual compiler/worker answers, with tamper controls. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, reads: 0,
  adminDsn: '', appDsn: '', workerStderr: '' }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!storage.sql) throw new Error('fair worker private database is not initialized');
    storage.reads += 1;
    return { sql: storage.sql };
  },
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => true,
}));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    if (!storage.adminDsn || !storage.appDsn) throw new Error('fair worker private database routing is not initialized');
    // Vitest mocks do not cross the real process boundary. Route every native
    // tool dependency in that child to the same throwaway database as its parent.
    const launched = await actual.managedSpawn(args[0], args[1], args[2], {
      ...args[3], workspaceId: `test-fair-worker-${process.pid}`,
      spawnOptions: { ...args[3]?.spawnOptions, stdio: ['pipe', 'pipe', 'pipe'], env: {
        ...args[3]?.spawnOptions?.env, HARNESS_ADMIN_DATABASE_URL: storage.adminDsn,
        DATABASE_URL: storage.adminDsn, HARNESS_DATABASE_URL: storage.appDsn,
      } },
    });
    launched.child.stderr?.setEncoding('utf8');
    launched.child.stderr?.on('data', (chunk: string) => {
      storage.workerStderr += chunk;
      process.stderr.write(chunk);
    });
    return launched;
  } };
});
import { hashCases, hashKeys, preregister, type AnswerKey, type FairCase, type Preregistration } from './fair-comparison';
import { runArm, scoreRuns } from './fair-comparison-run';
import type { FairArm } from './fair-comparison-arms';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import { LSP_VENDOR_DIR } from './lsp-adapter';
import { dispatchFrozenGraphRequest, freshFactory, type FrozenFairInputs } from './fair-comparison-cli';
import { absCgroupDir, sampleCgroup } from '../task-manager/cgroup-read';

const source = 'export function frozenTarget() { return 1; }\n' +
  'export const result = frozenTarget();\n' +
  '// absentTarget() is a comment, not a call\n';
const sourceFingerprint = createHash('sha256').update(source).digest('hex');
const cases: FairCase[] = [
  { id: 'native-frozen-positive', intent: 'callers', subject: 'frozenTarget',
    anchorFile: 'src/fixture.ts', language: 'typescript', configuration: 'configured',
    sourceState: 'current', sourceFingerprint, taskRef: 'native-plan-P002-positive-control',
    tags: [], source: 'authored' },
  { id: 'native-frozen-empty', intent: 'callers', subject: 'absentTarget',
    anchorFile: 'src/fixture.ts', language: 'typescript', configuration: 'configured',
    sourceState: 'current', sourceFingerprint, taskRef: 'native-plan-P002-false-empty-control',
    tags: ['absence'], source: 'authored' },
];
const keys: AnswerKey[] = [
  { caseId: cases[0]!.id, sites: ['src/fixture.ts:2'], aliases: {}, rejected: [], neutral: [] },
  { caseId: cases[1]!.id, sites: [], aliases: {}, rejected: [], neutral: [] },
];
let root = '';
let indexCalls = 0;
let queryCalls = 0;
let db: OrgTestDb | undefined;
const arm: FairArm = {
  capabilities: { armId: 'native-compiler-fixture', version: 'test-v1', intents: ['callers'], licence: 'first-party' },
  unavailable: null,
  index: async () => {
    indexCalls += 1;
    return { wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null };
  },
  query: async kase => {
    queryCalls += 1;
    const answer = await firstPartyCallersOffthread({ root, name: kase.subject, vendorDir: LSP_VENDOR_DIR, limit: 10 });
    return { caseId: kase.id, status: answer.error ? 'crashed' : 'answered', sites: answer.sites,
      latencyMs: answer.latencyMs, ...(answer.error ? { detail: answer.error } : {}) };
  },
};
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  storage.adminDsn = db.adminDsn;
  storage.appDsn = db.appDsn;
  // Exercise the lazy role-scoped client before a task enrollment can attribute
  // a connection failure to the worker. Keep the private database identity.
  const [database] = await storage.sql`SELECT current_database() AS name`;
  expect(database?.name).toBe(db.dbName);
  root = mkdtempSync(join(tmpdir(), 'native-frozen-comparison-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/fixture.ts'), source);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022' } }));
});
afterAll(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  await db?.cleanup();
  storage.sql = undefined;
});

describe('native frozen comparison through the compiler pipeline', () => {
  it('observes configuration changes that alter module resolution on the same native dispatcher', async () => {
    const configuredRoot = mkdtempSync(join(tmpdir(), 'native-config-invalidation-'));
    try {
      mkdirSync(join(configuredRoot, 'src'));
      writeFileSync(join(configuredRoot, 'src/first.ts'), 'export function configTarget() { return 1; }\n');
      writeFileSync(join(configuredRoot, 'src/second.ts'), 'export function configTarget() { return 2; }\n');
      writeFileSync(join(configuredRoot, 'src/use.ts'),
        "import { configTarget } from '@configured-target';\nexport function callConfigured() { return configTarget(); }\n");
      const ctx = { projectDir: configuredRoot, role: 'operator' as const, transport: 'in_process' as const,
        codeMode: true, contextTier: 'full' as const, transportCapExempt: true,
        log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {} };
      const request = { op: 'callees', name: 'callConfigured', file_path: 'src/use.ts', paths: ['src'] };
      const observations = [];
      // This is a distinct causal detector, not another frozen benchmark case:
      // its answers MUST change, so stale compiler options cannot pass it.
      for (const target of ['first', 'second', 'first']) {
        writeFileSync(join(configuredRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
          baseUrl: '.', paths: { '@configured-target': [`./src/${target}.ts`] },
        } }));
        const replay = await dispatchFrozenGraphRequest(request, ctx);
        expect(replay.response.error, JSON.stringify(replay.response)).toBeNull();
        const sites = replay.response.sites.map(site => `${site.path}:${site.line1}`).sort();
        expect(sites).toEqual(['src/use.ts:2']);
        const targets = replay.response.evidence?.relationships.map(row => row.target?.site.path);
        expect(targets).toEqual([`src/${target}.ts`]);
        observations.push({ target, sites, targets, dispatchWitness: replay.dispatchWitness });
      }
      expect(new Set(observations.map(row => row.dispatchWitness.callId)).size).toBe(3);
    } finally { rmSync(configuredRoot, { recursive: true, force: true }); }
  }, 180_000);

  it('uses the registered dispatch gates before native graph execution', async () => {
    const ctx = { projectDir: root, role: 'operator' as const, transport: 'in_process' as const,
      codeMode: true, contextTier: 'full' as const, transportCapExempt: true,
      log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {} };
    const request = { op: 'symbol', name: 'frozenTarget', file_path: 'src/fixture.ts', paths: ['src/fixture.ts'] };
    await expect(dispatchFrozenGraphRequest(request, { ...ctx, role: 'not-an-admitted-role' as never }))
      .rejects.toThrow(/role_not_allowed/);
    await expect(dispatchFrozenGraphRequest({ ...request, op: 'not-a-graph-operation' }, ctx))
      .rejects.toThrow(/invalid_input/);
    const replay = await dispatchFrozenGraphRequest(request, ctx);
    expect(replay.response.error, JSON.stringify(replay.response)).toBeNull();
    expect(replay.response.sites.map(site => `${site.path}:${site.line1}`)).toEqual(['src/fixture.ts:1']);
    expect(replay.dispatchWitness).toMatchObject({ entrypoint: 'dispatchProjectedTool',
      transport: 'in_process', toolName: 'graph:query', callId: expect.any(String) });
    expect(replay.dispatchWitness.callId.length).toBeGreaterThan(0);
  }, 60_000);

  it('reconstructs the saved multilingual edition and refuses a changed measurement protocol before work', async () => {
    const saved = JSON.parse(readFileSync(new URL('../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json', import.meta.url), 'utf8')) as {
      cases: FairCase[]; keys: AnswerKey[]; preregistration: Preregistration; observations: unknown[]; verdict: string;
    };
    const registered = saved.preregistration;
    expect(hashCases(saved.cases)).toBe(registered.corpusHash);
    expect(hashKeys(saved.keys)).toBe(registered.keyHash);
    expect(preregister({ cases: saved.cases, keys: saved.keys, arms: registered.arms,
      reps: registered.reps, seed: registered.seed, budgets: registered.budgets, protocol: registered.protocol }).hash).toBe(registered.hash);
    expect(saved.observations).toEqual([]);
    expect(saved.verdict).toBe('not-run');
    const before = { indexCalls, queryCalls };
    const admitted: FairArm = { ...arm, capabilities: registered.arms[0]!, unavailable: 'protocol-only control; no backend measurement' };
    expect((await runArm(admitted, saved.cases, registered)).reps).toEqual([]);
    const changed = { ...registered, protocol: { ...registered.protocol!, measurements:
      registered.protocol!.measurements.map(m => m.metric === 'peak-memory' ? { ...m, method: 'parent-only RSS' } : m) } };
    await expect(runArm(admitted, saved.cases, changed)).rejects.toThrow(/content or budget/);
    expect(() => scoreRuns([], saved.cases, saved.keys, {}, changed)).toThrow(/changed preregistration/);
    expect({ indexCalls, queryCalls }).toEqual(before);
  });

  it('executes the frozen positive and absence controls and reconstructs their scores', async () => {
    const prereg = preregister({ cases, keys, arms: [arm.capabilities], reps: 3, seed: 20261009 });
    const run = await runArm(arm, cases, prereg);
    expect(run.index?.ok).toBe(true);
    expect(run.reps).toHaveLength(3);
    for (const rep of run.reps) {
      const positive = rep.answers.find(answer => answer.caseId === cases[0]!.id)!;
      expect(positive.status).toBe('answered');
      expect(positive.sites.map(site => `${site.path}:${site.line1}`)).toEqual(['src/fixture.ts:2']);
      const absence = rep.answers.find(answer => answer.caseId === cases[1]!.id)!;
      expect(absence.status).toBe('answered');
      expect(absence.sites).toEqual([]);
    }
    const scored = scoreRuns([run], cases, keys, {}, prereg);
    expect(scored.pending).toEqual([]);
    expect(scored.aggregates[0]?.reps).toBe(3);
    expect(scoreRuns([JSON.parse(JSON.stringify(run))], cases, keys, {}, JSON.parse(JSON.stringify(prereg))))
      .toEqual(scored);
    const before = { indexCalls, queryCalls };
    await expect(runArm(arm, [{ ...cases[0]!, subject: 'absentTarget' }, cases[1]!], prereg))
      .rejects.toThrow(/corpus semantics/);
    await expect(runArm(arm, cases, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 2 } }))
      .rejects.toThrow(/budget differs/);
    expect({ indexCalls, queryCalls }).toEqual(before);
    expect(() => scoreRuns([run], [{ ...cases[0]!, sourceState: 'deleted' }, cases[1]!], keys, {}, prereg))
      .toThrow(/corpus semantics changed/);
    expect(() => scoreRuns([run], cases, keys, {}, { ...prereg, budgets: { ...prereg.budgets, rssMbMax: 2 } }))
      .toThrow(/changed preregistration content or budget/);
    // This fixture measures the freeze/scoring seam, not a final backend verdict:
    // one callers-only arm cannot certify matched graph intent coverage.
    expect(scored.decision.kind).toBe('inconclusive');
  }, 60_000);
});

describe('native protocol real confined worker lifecycle', () => {
  it('loads the saved edition, measures its real task scope and drains it before deleting its private files', async () => {
    const frozenPath = new URL('../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json', import.meta.url);
    const saved = JSON.parse(readFileSync(frozenPath, 'utf8')) as FrozenFairInputs;
    const factory = await freshFactory('rg', saved, frozenPath.pathname);
    // This is a lifecycle/control calibration, not a backend benchmark or a replay
    // of the frozen three-repetition experiment. It writes no arm.run.json.
    const readsBeforeEnrollment = storage.reads;
    const repetition = await factory.create(0);
    expect(storage.reads).toBeGreaterThan(readsBeforeEnrollment);
    const identity = repetition.identity;
    try {
      expect(identity.taskId).toBeTruthy();
      expect(identity.cgroupPath).toContain('papercusp-test-run');
      expect(identity.sourceCommit).toBe(saved.preregistration.protocol!.sourceCommit);
      expect(identity.treeRoot).not.toBe(root);
      expect(identity.treeRoot).not.toBe(identity.home);
      expect((await repetition.arm.index()).ok).toBe(true);
      const ready = await repetition.sampleResources!('ready');
      expect(ready.memoryCurrentBytes).toBeGreaterThan(0);
      expect(ready.memoryPeakBytes).toBeGreaterThan(0);
      expect(ready.indexFiles).not.toBeNull();
      expect(ready.processCensus?.taskId).toBe(identity.taskId);
      expect(ready.processCensus?.unknown).toEqual([]);
      expect(ready.processCensus?.processes).toContainEqual(expect.objectContaining({
        pid: ready.processCensus!.rootPid, cgroupPath: identity.cgroupPath,
      }));
      expect(ready.processCensus?.childProcesses).toBeGreaterThanOrEqual(0);
      expect(ready.observedChildProcessesMax).toBeGreaterThanOrEqual(ready.processCensus!.childProcesses!);
      expect(ready.peakChildProcesses).toBeNull();
      expect(ready.unknown).toContain('descendant-process-lifetime-peak-not-measured');
      // Unknown native tool/configuration proof remains visible even when the
      // subprocess and resource measurements are actually working.
      expect(ready.unknown).toContain('native-tool-seam-and-configuration-invalidation-not-verified');
      const selected = (state: string) => saved.cases.find(kase => kase.language === 'typescript' &&
        kase.source === 'authored' && kase.intent === 'callers' && kase.subject === 'target' &&
        kase.configuration === 'configured' && kase.sourceState === state)!;
      for (const state of ['current', 'stale', 'deleted', 'current']) {
        const kase = selected(state);
        const answer = await repetition.arm.query(kase) as Awaited<ReturnType<FairArm['query']>> & {
          control: { sourceState: string; originalSourceHash: string; currentSourceHash: string | null };
        };
        expect(answer.caseId).toBe(kase.id);
        expect(answer.status).toBe('answered');
        expect(answer.control.sourceState).toBe(state);
        if (state === 'deleted') expect(answer.control.currentSourceHash).toBeNull();
        else if (state === 'stale') expect(answer.control.currentSourceHash).not.toBe(answer.control.originalSourceHash);
        else expect(answer.control.currentSourceHash).toBe(answer.control.originalSourceHash);
      }
      expect(repetition.nativeGraphQuery).toBeTypeOf('function');
      const nativeReplays = [];
      // These are original frozen questions through the registered graph dispatcher
      // inside the managed payload, not answers from the rg comparison arm.
      for (const kase of saved.cases.filter(candidate => candidate.source === 'repository-task' &&
        candidate.intent === 'definition')) {
        const replay = await repetition.nativeGraphQuery!(kase);
        const sites = replay.response.sites.map(site => `${site.path}:${site.line1}`).sort();
        expect(replay.tool).toBe('graph:query');
        expect(replay.dispatchWitness).toMatchObject({ entrypoint: 'dispatchProjectedTool',
          transport: 'in_process', toolName: 'graph:query', callId: expect.any(String) });
        expect(replay.question).toEqual(kase);
        expect(replay.sourceWitness.contentHash).toBe(kase.sourceFingerprint);
        expect(replay.tokenWitness.requestHash).toBe(createHash('sha256')
          .update(JSON.stringify(replay.request)).digest('hex'));
        expect(replay.tokenWitness.responseHash).toBe(createHash('sha256')
          .update(JSON.stringify(replay.response)).digest('hex'));
        if (kase.language === 'javascript') {
          expect(replay.response.error, JSON.stringify(replay.response)).toBeNull();
          expect(sites).toEqual([...saved.keys.find(key => key.caseId === kase.id)!.sites].sort());
        } else {
          expect(replay.response.error).toMatch(/unsupported/i);
          expect(sites).toEqual([]);
          expect(replay.response.freshness.health).not.toBe('healthy');
        }
        nativeReplays.push(replay);
      }
      for (const state of ['current', 'stale', 'deleted', 'current']) {
        const kase = selected(state), replay = await repetition.nativeGraphQuery!(kase);
        if (state === 'deleted') expect(replay.response.error).not.toBeNull();
        else expect(replay.response.error, JSON.stringify(replay.response)).toBeNull();
        expect(replay.response.sites.map(site => `${site.path}:${site.line1}`).sort())
          .toEqual([...saved.keys.find(key => key.caseId === kase.id)!.sites].sort());
        nativeReplays.push(replay);
      }
      // Reuse one worker across configuration removal/restoration. A fresh
      // process per question would conceal a stale compiler configuration cache.
      for (const configuration of ['configured', 'unconfigured', 'configured']) {
        const kase = saved.cases.find(candidate => candidate.language === 'typescript' &&
          candidate.source === 'authored' && candidate.intent === 'callers' && candidate.subject === 'target' &&
          candidate.sourceState === 'current' && candidate.configuration === configuration)!;
        const replay = await repetition.nativeGraphQuery!(kase);
        const control = replay.control as { configurationFiles: { path: string; hash: string | null }[] };
        expect(control.configurationFiles.length).toBeGreaterThan(0);
        expect(control.configurationFiles.every(file => configuration === 'configured'
          ? /^[a-f0-9]{64}$/.test(file.hash ?? '') : file.hash === null)).toBe(true);
        expect(replay.response.error, JSON.stringify(replay.response)).toBeNull();
        expect(replay.response.sites.map(site => `${site.path}:${site.line1}`).sort())
          .toEqual([...saved.keys.find(key => key.caseId === kase.id)!.sites].sort());
        nativeReplays.push(replay);
      }
      const final = await repetition.sampleResources!('final');
      expect(final.memoryPeakBytes).toBeGreaterThanOrEqual(ready.memoryPeakBytes!);
      expect(storage.workerStderr).toContain('[db] target source=env');
      expect(storage.workerStderr).not.toContain('protected live Postgres target');
      console.log('NATIVE_FRESH_GRAPH_TASK=' + JSON.stringify({ preregHash: saved.preregistration.hash,
        identity, ready, final, replays: nativeReplays,
        backendVerdict: 'unqualified',
        notMeasured: ['complete-descendant-process-lifetime-peak', 'separate-lsp-task-costs',
          'full-143-case-backend-comparison', 'repository-project-config-byte-custody'] }));
      const [task] = await storage.sql!`SELECT confined, scope_unit, workspace_id FROM harness_shared.task_ledger
        WHERE task_id = ${identity.taskId}`;
      expect(task).toMatchObject({ confined: true, workspace_id: `test-fair-worker-${process.pid}` });
      expect(task.scope_unit).toBeTruthy();
    } finally { await repetition.arm.close!(); }
    expect(existsSync(identity.treeRoot)).toBe(false);
    expect(existsSync(identity.home)).toBe(false);
    expect(sampleCgroup(absCgroupDir(identity.cgroupPath)).pidsCurrent ?? 0).toBe(0);
    // close() now awaits the managed terminal receipt, so a separate polling
    // window must not be needed to observe the durable postcondition.
    const [task] = await storage.sql!`SELECT ended_at IS NOT NULL AS ended FROM harness_shared.task_ledger
      WHERE task_id = ${identity.taskId}`;
    expect(task).toMatchObject({ ended: true });
  }, 180_000);
});
