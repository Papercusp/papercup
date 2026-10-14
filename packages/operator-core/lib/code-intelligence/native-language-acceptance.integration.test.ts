/** P026: authored, preregistered controls through the exposed graph handler.
 * These are calibration cases, not real-task or backend-cost certification.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, tasks: [] as string[] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!storage.sql) throw new Error('native language acceptance database is not initialized');
    return { sql: storage.sql };
  },
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => true,
}));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    const result = await actual.managedSpawn(args[0], args[1], args[2], { ...args[3], workspaceId });
    storage.tasks.push(result.taskId);
    const [row] = await storage.sql!`SELECT workspace_id FROM harness_shared.task_ledger WHERE task_id = ${result.taskId}`;
    expect(row).toMatchObject({ workspace_id: workspaceId });
    return result;
  } };
});
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import { killTask } from '../task-manager/control';
import { closeTask } from '../task-manager/store';
import { taskTerminalEventKey } from '../task-manager/task-terminal-events';
import type { CodeIntelAnswer } from './contracts';
import { nativeLanguageControls } from './fair-comparison-corpus';
import { shutdownAllLspClients } from './lsp-adapter';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { runLspDaemonServer } from './lsp-daemon-server';

// Reuse the pinned LSP fixtures' real dispatcher, private persistence and
// terminal-latch cleanup. An exposed-tool test must never borrow a live daemon.
const eventEngine = await import('../events/await/engine');
const workspaceId = `test-native-language-acceptance-${process.pid}`;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
let socketRoot: string | undefined;
let server: Server | undefined;
let db: OrgTestDb | undefined;
let previousAutoPump: boolean | undefined;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  previousAutoPump = eventEngine.setAutoPumpEnabledForTests(false);
  socketRoot = mkdtempSync(join(tmpdir(), 'native-language-daemon-'));
  process.env[LSP_DAEMON_SOCKET_ENV] = join(socketRoot, 'fixture.sock');
  server = runLspDaemonServer();
  await once(server, 'listening');
}, 120_000);
afterAll(async () => {
  try {
    await shutdownAllLspClients();
    if (server) await new Promise<void>(done => server!.close(() => done()));
    for (const taskId of storage.tasks.splice(0)) {
      const outcome = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 500 });
      if (!outcome.ok && outcome.error !== 'already_gone') throw new Error(`LSP fixture cleanup refused: ${outcome.error}`);
      if (!outcome.ok) await closeTask(taskId, { state: 'stranded', exitReason: 'fixture verified process gone at teardown' });
      // Suite hooks have no active test for expect.poll; use the maintained hook-safe wait.
      await vi.waitFor(async () => {
        const [row] = await storage.sql!`
          SELECT task.state, task.ended_at IS NOT NULL AS ended,
                 fire.last_payload->>'taskId' AS emitted_task,
                 fire.last_payload->>'state' = task.state AS matching_state
            FROM harness_shared.task_ledger task
            LEFT JOIN harness_shared.event_key_fires fire ON fire.event_key = ${taskTerminalEventKey(taskId)}
           WHERE task.task_id = ${taskId}`;
        expect(row).toMatchObject({ ended: true, emitted_task: taskId, matching_state: true });
      }, { timeout: 5_000, interval: 20 });
    }
  } finally {
    if (previousAutoPump !== undefined) eventEngine.setAutoPumpEnabledForTests(previousAutoPump);
    if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
    if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
    await db?.cleanup();
    storage.sql = undefined;
  }
}, 60_000);

const controls = nativeLanguageControls();
const operations = { callers: 'callers', callees: 'callees', definition: 'symbol', impact: 'impact' } as const;
const cases = controls.cases.filter(kase => kase.intent in operations);
const keys = new Map(controls.keys.map(key => [key.caseId, key]));

describe('native P026 multilingual authored graph acceptance', () => {
  it.each(cases)('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-language-acceptance-'));
    const path = kase.anchorFile!;
    const source = controls.files[path]!;
    const configured = kase.configuration === 'configured';
    try {
      for (const [file, text] of Object.entries(controls.files)) {
        if (dirname(file) !== dirname(path) || (!configured && file !== path)) continue;
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      if (kase.sourceState === 'stale') writeFileSync(join(root, path),
        source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }'));
      if (kase.sourceState === 'deleted') rmSync(join(root, path));
      const op = operations[kase.intent as keyof typeof operations];
      const answer = (await graphQuery.handler(graphQuery.args.parse({
        op, name: kase.subject, paths: [path],
        ...(op === 'callers' ? {} : { file_path: path }),
        ...(op === 'impact' ? { max_depth: kase.depth } : {}),
      }), { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
      const unsupported = !['javascript', 'typescript'].includes(kase.language!);
      // The tool emits call sites for callees; the preregistered answer unit is
      // its measured callee declaration. Retain raw sites as well as scored units.
      const sites = (op === 'callees' ? answer.evidence?.relationships.map(edge => edge.target?.site)
        .filter((site): site is NonNullable<typeof site> => Boolean(site)) ?? [] : answer.sites)
        .map(site => `${site.path}:${site.line1}`).sort();
      console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
        source: kase.source, language: kase.language, configuration: kase.configuration,
        sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
        currentSourceHash: kase.sourceState === 'deleted' ? null : createHash('sha256').update(
          kase.sourceState === 'stale' ? source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }') : source).digest('hex'),
        tool: 'graph:query', op, sites, rawSites: answer.sites, expectedSites: keys.get(kase.id)!.sites,
        error: answer.error, latencyMs: answer.latencyMs,
        evidence: answer.evidence, authoredControlOnly: true }));
      if (unsupported) {
        expect(answer.error, kase.id).toMatch(/unsupported/i);
        expect(sites).toEqual([]);
        expect(answer.freshness.health).not.toBe('healthy');
        expect(answer.evidence?.languageCapabilities).toContainEqual(expect.objectContaining({
          language: kase.language, status: 'unsupported' }));
      } else if (kase.sourceState === 'deleted' || (kase.tags.includes('absence') && op !== 'callers')) {
        // No declaration or a missing file is an explicit unavailable answer;
        // preserve it instead of scoring it as certified semantic absence.
        expect(answer.error, kase.id).not.toBeNull();
        expect(sites).toEqual([]);
      } else {
        expect(answer.error, kase.id).toBeNull();
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
        expect(answer.evidence?.sourceScope.repositoryId).toBeTruthy();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe('native P026 remaining authored language acceptance', () => {
  it.each(controls.cases.filter(kase => !(kase.intent in operations)))('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-language-acceptance-'));
    const path = kase.anchorFile!, source = controls.files[path]!;
    const absent = kase.tags.includes('absence');
    try {
      for (const [file, text] of Object.entries(controls.files)) {
        if (dirname(file) !== dirname(path)) continue;
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      if (kase.intent === 'text-search') {
        // Text search is the documented native command route. It is lexical
        // evidence; it cannot certify a compiler or language-server intent.
        const started = performance.now();
        const command = ['--with-filename', '-n', '-F', '--', kase.subject, path];
        const result = spawnSync('rg', command,
          { cwd: root, encoding: 'utf8' });
        const sites = result.stdout.split('\n').filter(Boolean).map(line => {
          const match = /^(.*?):(\d+):/.exec(line);
          expect(match, line).not.toBeNull();
          return `${match![1]}:${match![2]}`;
        }).sort();
        console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
          source: kase.source, language: kase.language, configuration: kase.configuration,
          sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
          currentSourceHash: createHash('sha256').update(source).digest('hex'),
          tool: 'native-command:rg', intent: kase.intent, command: ['rg', ...command],
          sites, expectedSites: keys.get(kase.id)!.sites, error: result.error?.message ?? null,
          exitCode: result.status, latencyMs: performance.now() - started,
          stdout: result.stdout, stderr: result.stderr, authoredControlOnly: true }));
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(absent ? 1 : 0);
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
        return;
      }
      const language = kase.language === 'javascript' ? 'typescript' : kase.language;
      const symbols = (await lspQuery.handler(lspQuery.args.parse({ op: 'workspace_symbols',
        rootPath: root, file: path, language, name: kase.subject, limit: 20 }),
      { projectDir: root, workspaceId } as never) as { data: CodeIntelAnswer }).data;
      let answer = symbols;
      if (kase.intent === 'references' && !symbols.error && symbols.sites.length) {
        const cursor = symbols.sites.find(site => site.path === path)!;
        expect(cursor, JSON.stringify(symbols)).toBeDefined();
        const line = source.split('\n')[cursor.line1! - 1]!;
        answer = (await lspQuery.handler(lspQuery.args.parse({ op: 'references', rootPath: root,
          file: path, line1: cursor.line1, character: line.indexOf(kase.subject), limit: 20 }),
        { projectDir: root, workspaceId } as never) as { data: CodeIntelAnswer }).data;
      }
      const neutral = new Set(keys.get(kase.id)!.neutral);
      const sites = answer.sites.map(site => `${site.path}:${site.line1}`)
        .filter(site => !neutral.has(site)).sort();
      console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
        source: kase.source, language: kase.language, configuration: kase.configuration,
        sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
        currentSourceHash: createHash('sha256').update(source).digest('hex'),
        tool: 'lsp:query', intent: kase.intent, symbols, answer, sites,
        expectedSites: keys.get(kase.id)!.sites, authoredControlOnly: true }));
      if (answer.error) {
        // Preserve unsupported/unavailable as a coverage gap. A truthful
        // refusal passes this honesty guard, never the task-accuracy bar.
        expect(answer.error.length).toBeGreaterThan(0);
        expect(answer.freshness.health).not.toBe('healthy');
        expect(sites).toEqual([]);
      } else {
        // Captured server input hashes establish this fixture's exact version;
        // they do not turn unmeasured project readiness into a fresh/healthy claim.
        expect(answer.freshness.staleVsDisk).not.toBe(true);
        if (answer.freshness.staleVsDisk === null) expect(answer.freshness.health).not.toBe('healthy');
        expect(answer.evidence?.sourceScope.supportingFiles).toContainEqual(expect.objectContaining({
          path, contentHash: createHash('sha256').update(source).digest('hex'),
        }));
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
      }
    } finally {
      await shutdownAllLspClients();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
