#!/usr/bin/env node
/**
 * Commit-independent operator-API test route (WI-6554700010048234).
 *
 *   node scripts/operator-api-working-tree.mjs                 # MCP probe: tools/list + coord:whoami
 *   node scripts/operator-api-working-tree.mjs -- <command…>   # run YOUR assertion against it
 *
 * Bundles the Hono host from the CURRENT WORKING TREE (uncommitted edits
 * included), boots it on auto-picked private ports against a disposable
 * migrated PG and private workspace (scripts/with-test-pg.mjs
 * --isolated-runtime=operator-api), runs the caller command with
 * PAPERCUSP_OPERATOR_URL, PAPERCUSP_OPERATOR_MCP_URL and
 * PAPERCUSP_OPERATOR_BEARER exported, then tears everything down. Exit code is
 * the caller's (or the probe's). Unlike :3170 it needs no commit, no staging
 * sync and touches no shared database. Registered as the
 * `operator-api-working-tree` class in packages/operator-core/lib/serving-runtimes.ts.
 */
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/operator-api-working-tree.mjs [-- <caller command using PAPERCUSP_OPERATOR_URL / PAPERCUSP_OPERATOR_MCP_URL / PAPERCUSP_OPERATOR_BEARER>]';
const argv = process.argv.slice(2);
if (argv[0] === '--help' || argv[0] === '-h') { console.log(USAGE); process.exit(0); }
if (argv.length > 0 && argv[0] !== '--') { console.error(USAGE); process.exit(2); }
const caller = argv.slice(1);

const scratch = join(ROOT, '.papercusp', 'scratch');
mkdirSync(scratch, { recursive: true });
const evidenceDir = process.env.WORKING_TREE_OPERATOR_API_EVIDENCE_DIR
  ?? mkdtempSync(join(scratch, 'operator-api-working-tree-'));
mkdirSync(join(evidenceDir, 'tmp'), { recursive: true });
const modules = join(evidenceDir, 'node_modules');
symlinkSync(join(ROOT, 'node_modules'), modules, 'dir');

const env = { ...process.env, FORCE_COLOR: '0', TMPDIR: join(evidenceDir, 'tmp'),
  WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir, WORKING_TREE_OPERATOR_API_CALLER_CWD: process.cwd() };
delete env.PC_HEAVY_PREEMPT_READY_FILE;
delete env.PC_HEAVY_PSI_FINALIZATION_FILE;

console.error(`[operator-api-working-tree] evidence → ${evidenceDir}`);
const child = fork(join(ROOT, 'scripts/with-test-pg.mjs'), ['--isolated-runtime=operator-api', '--',
  process.execPath, '--import', 'tsx', join(ROOT, 'packages/operator-core/test/working-tree-operator-api-fixture.ts'),
  ...(caller.length ? ['--', ...caller] : [])], { cwd: ROOT, env, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => {
  rmSync(modules, { force: true });
  process.exit(code ?? (signal ? 128 : 1));
});
