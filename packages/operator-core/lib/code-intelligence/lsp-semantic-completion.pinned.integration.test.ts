/** Candidate only: real pinned wrapper/plugin/native request seam, with authored ground truth. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { CancellationTokenSource, createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!storage.sql) throw new Error('native completion fixture PG not initialized');
    return { sql: storage.sql };
  },
}));

import { managedSpawn } from '../task-manager/managed-spawn';
import { killTask } from '../task-manager/control';
import { closeTask } from '../task-manager/store';
import { taskTerminalEventKey } from '../task-manager/task-terminal-events';
import { resolveServerBin, resolveTsserverPath, shutdownLspClient, typescriptInitializationOptions } from './lsp-adapter';
import { requestSemanticCompletion, SEMANTIC_COMPLETION_COMMAND, SEMANTIC_COMPLETION_TYPESCRIPT_VERSION,
  type SemanticCompletionRequest } from './lsp-semantic-completion';

// Reuse the task-terminal integration boundary: initialize its import graph
// before child exit callbacks, route persistence to migrated isolated PG, and
// join each terminal latch before disposing that database.
const eventEngine = await import('../events/await/engine');
const workspaceId = `test-lsp-native-completion-${process.pid}`;
let db: OrgTestDb | undefined;
let previousAutoPump = true;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  previousAutoPump = eventEngine.setAutoPumpEnabledForTests(false);
}, 120_000);
afterAll(async () => {
  eventEngine.setAutoPumpEnabledForTests(previousAutoPump);
  await db?.cleanup();
  storage.sql = undefined;
}, 30_000);

async function finishOwnedTask(taskId: string): Promise<void> {
  // A systemd-run wrapper can exit before its payload. Verify and reap the
  // exact owned scope even when the wrapper has already exited.
  const outcome = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 500 });
  if (!outcome.ok && outcome.error !== 'already_gone') {
    throw new Error(`native completion fixture cleanup refused: ${outcome.error}`);
  }
  if (!outcome.ok && outcome.error === 'already_gone') {
    await closeTask(taskId, { state: 'stranded', exitReason: 'fixture verified process gone at teardown' });
  }
  await expect.poll(async () => {
    const [row] = await storage.sql!`
      SELECT task.workspace_id, task.state, task.ended_at IS NOT NULL AS ended,
             fire.fire_count, fire.last_payload->>'taskId' AS emitted_task,
             fire.last_payload->>'state' = task.state AS matching_state
        FROM harness_shared.task_ledger task
        LEFT JOIN harness_shared.event_key_fires fire ON fire.event_key = ${taskTerminalEventKey(taskId)}
       WHERE task.task_id = ${taskId}
    `;
    return row;
  }, { timeout: 5_000, interval: 20 }).toMatchObject({
    workspace_id: workspaceId, ended: true, fire_count: 1, emitted_task: taskId, matching_state: true,
  });
}

const pluginName = 'papercusp-semantic-completion-fixture';
const controls = ['complete', 'complete-projects', 'missing-file', 'extra-file', 'missing-project', 'extra-project',
  'disabled', 'cancel-before', 'cancel-after'] as const;

// Only this fixture wrapper mutates native state. Production candidate code is
// compiled unchanged; cancellation uses tsserver's ACTUAL per-request pipe.
const controlWrapper = String.raw`
const candidate = module.exports.default;
const fs = require('node:fs');
const activationFile = require('node:path').join(__dirname, '../../../native-plugin-activations.jsonl');
const sessionIds = new WeakMap();
const fixtureInterceptors = new WeakSet();
let nextSessionId = 0;
let nextFactoryId = 0;
module.exports = function(modules) {
  const factoryId = ++nextFactoryId;
  const plugin = candidate(modules);
  return { create(info) {
    const session = info.session;
    if (!sessionIds.has(session)) sessionIds.set(session, ++nextSessionId);
    const activation = { processId: process.pid, serverMode: session.projectService.serverMode,
      factoryId, sessionId: sessionIds.get(session),
      projectName: info.project.getProjectName(), registrations: 0, registrationCalls: [], ok: false };
    const add = session.addProtocolHandler;
    session.addProtocolHandler = function(command, handler) {
      activation.registrations++;
      const receipt = { command, nestedDelegate: fixtureInterceptors.has(add), nativeSuccess: false };
      activation.registrationCalls.push(receipt);
      const result = add.call(this, command, function(request) {
        const control = request.arguments && request.arguments.nativeControl;
        let pipe;
        const references = session.getReferences;
        try {
          if (control === 'disabled') {
            const project = session.projectService.findProject(request.arguments.population[0].projectName);
            if (!project) throw new Error('fixture project missing');
            project.disableLanguageService();
          }
          if (control === 'cancel-before' || control === 'cancel-after') {
            const index = process.argv.indexOf('--cancellationPipeName');
            const pattern = process.argv[index + 1];
            if (index < 0 || !pattern.endsWith('*')) throw new Error('fixture native cancellation pipe missing');
            pipe = pattern.slice(0, -1) + request.seq;
            if (control === 'cancel-before') fs.writeFileSync(pipe, '');
            else session.getReferences = function(...args) {
              const result = references.apply(this, args);
              fs.writeFileSync(pipe, '');
              return result;
            };
          }
          return handler(request);
        } finally {
          session.getReferences = references;
          if (pipe) fs.rmSync(pipe, { force: true });
        }
      });
      receipt.nativeSuccess = !receipt.nestedDelegate;
      return result;
    };
    fixtureInterceptors.add(session.addProtocolHandler);
    try {
      const service = plugin.create(info);
      activation.ok = true;
      return service;
    } catch (error) {
      activation.error = String(error);
      throw error;
    } finally {
      session.addProtocolHandler = add;
      fs.appendFileSync(activationFile, JSON.stringify(activation) + '\n');
    }
  } };
};
`;

describe('candidate completion through the pinned native plugin package', () => {
  it.each(controls)('qualifies only the declared authored population: %s', async control => {
    const bin = resolveServerBin('typescript');
    expect(bin, 'the maintained pinned server must be provisioned').not.toBeNull();
    const tsserver = resolveTsserverPath();
    const compiler = createRequire(tsserver)('./typescript.js') as { version: string };
    expect(compiler.version).toBe(SEMANTIC_COMPLETION_TYPESCRIPT_VERSION);
    const root = mkdtempSync(join(tmpdir(), 'lsp-native-completion-'));
    const target = join(root, 'target.ts');
    const consumer = join(root, 'consumer.ts');
    const config = join(root, 'tsconfig.json');
    const source = 'export function semanticTarget() { return 1; }\nsemanticTarget();\n';
    // This declaration is authored BEFORE launching or asking the compiler.
    // noLib/types:[] excludes ambient dependencies; config is part of the graph.
    const population = [{ projectName: config, anchorFile: target, files: [target, consumer, config] }];
    writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noLib: true, types: [] },
      files: ['target.ts', 'consumer.ts'] }));
    writeFileSync(target, source);
    writeFileSync(consumer, 'import { semanticTarget } from "./target";\nsemanticTarget();\n');
    const secondConsumer = join(root, 'second', 'consumer.ts');
    if (control === 'complete-projects') {
      const secondConfig = join(root, 'second', 'tsconfig.json');
      mkdirSync(join(root, 'second'));
      writeFileSync(secondConfig, JSON.stringify({ compilerOptions: { strict: true, noLib: true, types: [] },
        files: ['consumer.ts'] }));
      writeFileSync(secondConsumer, 'import { semanticTarget } from "../target";\nsemanticTarget();\n');
      // Independently authored imported-source closure, before native startup.
      population.push({ projectName: secondConfig, anchorFile: secondConsumer,
        files: [target, secondConsumer, secondConfig] });
    }
    const pluginRoot = join(root, 'probe');
    const packageRoot = join(pluginRoot, 'node_modules', pluginName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: pluginName, version: '0.0.0', main: 'index.cjs' }));
    const candidate = readFileSync(new URL('./lsp-semantic-completion.ts', import.meta.url), 'utf8');
    writeFileSync(join(packageRoot, 'index.cjs'), transformSync(candidate, { loader: 'ts', format: 'cjs', target: 'node22' }).code + controlWrapper);
    let task: Awaited<ReturnType<typeof managedSpawn>> | undefined;
    let connection: ReturnType<typeof createMessageConnection> | undefined;
    let stderr = '';
    try {
      task = await managedSpawn(bin!, ['--stdio'], { class: 'sidecar',
        title: `lsp-native-completion-${control}`, argv: [bin!, '--stdio'], cwd: root,
        launchedBy: 'test:lsp-native-completion', planSlug: 'lsp-fleet-scale-all-languages-2026-08-21' },
      { workspaceId, spawnOptions: { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] } });
      task.child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
      connection = createMessageConnection(new StreamMessageReader(task.child.stdout!), new StreamMessageWriter(task.child.stdin!));
      connection.onRequest('window/workDoneProgress/create', () => null);
      connection.listen();
      const rpc = async <T,>(method: string, args: unknown, token?: CancellationTokenSource): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            token ? connection!.sendRequest<T>(method, args, token.token) : connection!.sendRequest<T>(method, args),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} deadline; stderr=${stderr}`)), 20_000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      };
      const rootUri = pathToFileURL(root).href;
      await rpc('initialize', { processId: process.pid, rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'authored-native-completion' }],
        initializationOptions: { ...typescriptInitializationOptions(tsserver, undefined, root),
          disableAutomaticTypingAcquisition: true, plugins: [{ name: pluginName, location: pluginRoot }] },
        capabilities: { window: { workDoneProgress: true } } });
      await connection.sendNotification('initialized', {});
      await connection.sendNotification('textDocument/didOpen', { textDocument: {
        uri: pathToFileURL(target).href, languageId: 'typescript', version: 1, text: source } });
      const native = (command: string, args: unknown, token?: CancellationTokenSource) => rpc('workspace/executeCommand', {
        command: 'typescript.tsserverRequest', arguments: [command, args, { executionTarget: 0 }] }, token);
      // projectInfo is used to wait for plugin registration, NEVER to author
      // the population or the expected reference sites.
      await native('projectInfo', { file: target, needFileNameList: false });
      if (control === 'complete-projects') {
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
          uri: pathToFileURL(secondConsumer).href, languageId: 'typescript', version: 1,
          text: 'import { semanticTarget } from "../target";\nsemanticTarget();\n' } });
        await native('projectInfo', { file: secondConsumer, needFileNameList: false });
        const activations = readFileSync(join(root, 'native-plugin-activations.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line) as {
            processId: number; serverMode: number;
            factoryId: number; sessionId: number; projectName: string; registrations: number; ok: boolean; error?: string;
            registrationCalls: { command: string; nestedDelegate: boolean; nativeSuccess: boolean }[];
          });
        console.info('WI41095_NATIVE_REGISTRATIONS', JSON.stringify(activations));
        // The wrapper also activates the plugin in its separate syntax child.
        // Session/factory counters are process-local: qualify their PID before
        // requiring one shared semantic session across configured projects.
        const configured = activations.filter(row => population.some(project => project.projectName === row.projectName));
        expect(configured.map(row => row.projectName).sort(), JSON.stringify(activations))
          .toEqual(population.map(project => project.projectName).sort());
        expect(new Set(configured.map(row => row.factoryId)).size).toBe(2);
        expect(configured.every(row => row.serverMode === 0), JSON.stringify(activations)).toBe(true);
        expect(new Set(configured.map(row => `${row.processId}:${row.sessionId}`)).size).toBe(1);
        expect(activations.every(row => row.ok), JSON.stringify(activations)).toBe(true);
        // Count actual native delegation per session, including the syntax
        // child. A duplicate attempt or failed native registration still fails.
        const sessionKeys = new Set(activations.map(row => `${row.processId}:${row.sessionId}`));
        for (const sessionKey of sessionKeys) {
          const rows = activations.filter(row => `${row.processId}:${row.sessionId}` === sessionKey);
          const calls = rows.flatMap(row => row.registrationCalls);
          expect(rows.reduce((sum, row) => sum + row.registrations, 0), JSON.stringify(rows)).toBe(1);
          expect(calls, JSON.stringify(rows)).toEqual([
            { command: SEMANTIC_COMPLETION_COMMAND, nestedDelegate: false, nativeSuccess: true },
          ]);
        }
      }
      const request: SemanticCompletionRequest & { nativeControl?: string } = {
        file: target, line: 2, offset: 2,
        population: population.map(project => ({ ...project, files: [...project.files] })),
      };
      if (control === 'missing-file') request.population[0].files.push(join(root, 'omitted.ts'));
      if (control === 'extra-file') request.population[0].files = request.population[0].files.filter(file => file !== consumer);
      if (control === 'missing-project') request.population.push({ projectName: join(root, 'missing', 'tsconfig.json'),
        anchorFile: join(root, 'missing', 'target.ts'), files: [join(root, 'missing', 'target.ts')] });
      if (control === 'extra-project') {
        const extra = join(root, 'extra');
        mkdirSync(extra);
        writeFileSync(join(extra, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ['extra.ts'] }));
        writeFileSync(join(extra, 'extra.ts'), 'export const extra = 1;\n');
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
          uri: pathToFileURL(join(extra, 'extra.ts')).href, languageId: 'typescript', version: 1, text: 'export const extra = 1;\n' } });
        await native('projectInfo', { file: join(extra, 'extra.ts'), needFileNameList: false });
      }
      if (['disabled', 'cancel-before', 'cancel-after'].includes(control)) request.nativeControl = control;
      if (control === 'complete' || control === 'complete-projects') {
        const result = await requestSemanticCompletion(request, { isCancellationRequested: false }, native);
        expect(result.population).toEqual(population.map(project => ({ ...project, files: [...project.files].sort() }))
          .sort((a, b) => a.projectName.localeCompare(b.projectName)));
        const sites = result.refs.map(ref => [ref.file.slice(root.length + 1), ref.start.line, ref.start.offset])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const expectedSites = [['consumer.ts', 1, 10], ['consumer.ts', 2, 1], ['target.ts', 1, 17], ['target.ts', 2, 1]];
        if (control === 'complete-projects') expectedSites.push(['second/consumer.ts', 1, 10], ['second/consumer.ts', 2, 1]);
        expect(sites).toEqual(expectedSites.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        // Characterize the wrapper's ignored token, then require our outer
        // boundary to refuse the same pre-cancelled caller independently.
        const cancelled = new CancellationTokenSource();
        try {
          cancelled.cancel();
          await expect(native(SEMANTIC_COMPLETION_COMMAND, request, cancelled)).resolves.toMatchObject({ success: true });
          await expect(requestSemanticCompletion(request, cancelled.token, native)).rejects.toThrow('outer-cancelled');
        } finally { cancelled.dispose(); }
        console.info('WI41095_NATIVE_COMPLETION', JSON.stringify({ control, sites, declared: population,
          certification: 'authored-fixture-only', productionReadiness: 'unchanged' }));
      } else {
        const expected = control.startsWith('cancel') ? /semantic completion refused: cancelled/
          : control === 'disabled' ? /semantic completion refused: disabled-project/
          : control === 'extra-project' ? /semantic completion refused: extra-project/
          : control === 'missing-project' ? /No Project|No project|not found|semantic completion refused/
          : /semantic completion refused: project-or-file-population-mismatch/;
        await expect(requestSemanticCompletion(request, { isCancellationRequested: false }, native)).rejects.toThrow(expected);
        console.info('WI41095_NATIVE_COMPLETION', JSON.stringify({ control, refused: true, certification: 'authored-fixture-only' }));
      }
    } finally {
      try {
        try {
          if (task && connection) await shutdownLspClient({ connection, child: task.child, taskId: task.taskId, scopeUnit: task.scopeUnit });
        } finally {
          if (task) await finishOwnedTask(task.taskId);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 60_000);
});
