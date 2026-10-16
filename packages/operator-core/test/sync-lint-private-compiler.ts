/** Shared by the private PG journey and its cheap compiler-only preflight. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildSyncBatchDeltaDeps, runBoundedArgv } from '../lib/release/sync-batch-delta-check-deps';

export const SYNC_LINT_TYPE_ERROR_FILE = 'src/type-error.ts';

export async function prepareSyncLintPrivateCompiler(root: string, fixtureRoot: string) {
  await mkdir(join(fixtureRoot, 'src'), { recursive: true });
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
  await writeFile(join(fixtureRoot, SYNC_LINT_TYPE_ERROR_FILE), 'export const value: number = "wrong";\n');
  await writeFile(join(fixtureRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true }, include: [SYNC_LINT_TYPE_ERROR_FILE],
  }));
  const compiler = join(root, 'node_modules/typescript/lib/tsc.js');
  const script = join(fixtureRoot, 'scripts/lint-tsc.mjs');
  await writeFile(script,
    `process.argv = [process.execPath, ${JSON.stringify(compiler)}, '--project', 'tsconfig.json', '--pretty', 'false'];\n` +
    `await import(${JSON.stringify(pathToFileURL(compiler).href)});\n`);
  return script;
}

/** Fail before allocating private PG if the exact fixture/compiler is unusable. */
export async function preflightSyncLintPrivateCompiler(root: string) {
  const fixture = await mkdtemp(join(tmpdir(), 'p037-compiler-'));
  try {
    await prepareSyncLintPrivateCompiler(root, fixture);
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'compiler-preflight',
      workspaceId: 'test-runtime-compiler-preflight', root: fixture, branch: 'staging',
      exec: (cmd, args, opts) => runBoundedArgv(cmd, args, { ...opts, timeoutMs: 10_000 }) });
    const red = await deps.runTsc([SYNC_LINT_TYPE_ERROR_FILE]);
    assert.equal(red.ok, false, JSON.stringify(red));
    assert.deepEqual(red.failing, [SYNC_LINT_TYPE_ERROR_FILE], JSON.stringify(red));
    assert.equal(red.diagnostic?.exitCode, 2);
    await writeFile(join(fixture, SYNC_LINT_TYPE_ERROR_FILE), 'export const value: number = 1;\n');
    const green = await deps.runTsc([SYNC_LINT_TYPE_ERROR_FILE]);
    assert.equal(green.ok, true, JSON.stringify(green));
    assert.equal(green.diagnostic?.exitCode, 0);
    return { red: red.diagnostic, green: green.diagnostic, privatePgAllocated: false };
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
