import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../../..');
const managedPath = resolve(import.meta.dirname, 'generated-repair-managed.ts');
const payload = 'x'.repeat(256 * 1024);
type Entry = 'bin' | 'hono' | 'serve';
type Outcome = 'success' | 'worker-error' | 'invalid' | 'startup-error';

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function entrySource(entry: Entry): string {
  if (entry === 'bin') return readFileSync(resolve(import.meta.dirname, 'generated-repair-worker-bin.ts'), 'utf8');
  const source = parse(resolve(root, `apps/operator/bin/${entry === 'hono' ? 'hono-host' : 'serve'}.ts`));
  let branch: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(source) === (entry === 'hono'
      ? "sidecarMode === 'generated-repair'"
      : 'process.env.PAPERCUSP_GENERATED_REPAIR_WORKER_MODE === "1"')) branch = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!branch) throw new Error(`missing ${entry} generated repair worker branch`);
  if (entry === 'serve') return `async function main() { ${branch.getText(source)} } void main();`;
  const workerImport = source.statements.find(node => ts.isImportDeclaration(node)
    && node.moduleSpecifier.getText(source).includes('/release/generated-repair-managed'));
  if (!workerImport) throw new Error('missing Hono generated repair worker import');
  return `${workerImport.getText(source)}\nconst sidecarMode = 'generated-repair';\n${branch.getText(source)}`;
}

function compile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
}

function childProgram(entry: Entry, outcome: Outcome): string {
  const source = parse(managedPath);
  const main = source.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === 'runGeneratedRepairWorkerMain');
  if (!main) throw new Error('missing generated repair worker main');
  // Execute the real entry and finite main; replace shared-service boundaries only.
  const dependencies = `
    const GENERATED_REPAIR_WORKER_INPUT_ENV = 'PAPERCUSP_GENERATED_REPAIR_WORKER_INPUT';
    function parseGeneratedRepairWorkerInput() {
      if (${JSON.stringify(outcome)} === 'startup-error') throw new Error('startup marker');
      return ${JSON.stringify(outcome)} === 'invalid' ? null : { queueTarget: { workspaceId: 'fixture' } };
    }
    async function withWorkspace(workspace, run) {
      if (workspace !== 'fixture') throw new Error('wrong workspace');
      return await run();
    }
    async function runGeneratedRepairWorker() {
      process.send({ kind: 'ready' });
      await new Promise(resolve => process.once('message', resolve));
      process.stdout.write('x'.repeat(256 * 1024));
      process.stderr.write('x'.repeat(256 * 1024));
      process.send({ kind: 'work-done' });
      if (${JSON.stringify(outcome)} === 'worker-error') throw new Error('worker marker');
    }
  `;
  return `
    // This live handle makes exitCode-only termination fail deterministically.
    setInterval(() => {}, 1000);
    process.env.PAPERCUSP_GENERATED_REPAIR_WORKER_MODE = '1';
    const workerModule = {};
    (function(exports) { ${compile(dependencies + main.getText(source))} })(workerModule);
    (function(require, exports) { ${compile(entrySource(entry))} })(() => workerModule, {});
  `;
}

async function runChild(entry: Entry, outcome: Outcome) {
  const child = spawn(process.execPath, ['-e', childProgram(entry, outcome)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32',
  });
  let stdout = '', stderr = '', awaitedWork = false;
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolveResult, reject) => {
      deadline = setTimeout(() => reject(new Error(`${entry}/${outcome} did not exit`)), 10_000);
      child.on('error', reject);
      child.on('message', (message: { kind?: string }) => {
        if (message.kind === 'ready') {
          if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('exited before awaited work'));
          child.send({ finish: true });
        }
        if (message.kind === 'work-done') {
          awaitedWork = true;
          clearTimeout(deadline);
          deadline = setTimeout(() => reject(new Error(`${entry}/${outcome} did not exit after completion`)), 2000);
        }
      });
      child.on('close', (code, signal) => resolveResult({ code, signal }));
    });
    return { ...result, stdout, stderr, awaitedWork };
  } finally {
    clearTimeout(deadline!);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid!, 'SIGKILL');
      await closed;
    }
  }
}

describe.each(['bin', 'hono', 'serve'] as const)('%s finite generated repair worker entry', entry => {
  it.each(['success', 'worker-error'] as const)('awaits %s and drains both pipes despite a live handle', async outcome => {
    const result = await runChild(entry, outcome);
    expect(result).toMatchObject({ code: outcome === 'success' ? 0 : 1, signal: null, awaitedWork: true });
    expect(result.stdout).toBe(payload);
    expect(result.stderr).toContain(payload);
    if (outcome === 'worker-error') expect(result.stderr).toContain('worker marker');
  });
  it.each(['invalid', 'startup-error'] as const)('exits with the diagnostic for %s', async outcome => {
    const result = await runChild(entry, outcome);
    expect(result).toMatchObject({ code: outcome === 'invalid' ? 2 : 1, signal: null, awaitedWork: false });
    expect(result.stderr).toContain(outcome === 'invalid' ? 'worker input is missing or invalid' : 'startup marker');
  });
});
