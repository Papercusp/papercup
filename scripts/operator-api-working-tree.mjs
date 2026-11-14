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
 *
 * Limit: bundle-host.sh's own Node helpers load through committed-source-loader.mjs,
 * so an EDITED helper silently runs its HEAD version and an UNTRACKED one fails the
 * build. A change to the builder itself is exercised only once it is committed.
 * Runbook: agent-insights/operator-api-working-tree-test-route.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

Object.assign(process.env, { FORCE_COLOR: '0', TMPDIR: join(evidenceDir, 'tmp'),
  WORKING_TREE_OPERATOR_API_EVIDENCE_DIR: evidenceDir, WORKING_TREE_OPERATOR_API_CALLER_CWD: process.cwd() });
delete process.env.PC_HEAVY_PREEMPT_READY_FILE;
delete process.env.PC_HEAVY_PSI_FINALIZATION_FILE;
// PC_ISOLATED_RUNTIME_PROOF=1 makes with-test-pg send proof receipts to its
// IPC parent and hold the worker until an isolated-runtime-observed reply
// arrives. Without a supervising verifier above us (no IPC) there is no
// observer, so the proof mode must not leak in from the environment.
if (!(process.env.PC_ISOLATED_RUNTIME_PROOF === '1' && typeof process.send === 'function')) {
  delete process.env.PC_ISOLATED_RUNTIME_PROOF;
  delete process.env.PC_ISOLATED_RUNTIME_START_TOKEN;
  delete process.env.PAPERCUSP_ISOLATED_PROGRESS_FILE;
}

console.error(`[operator-api-working-tree] evidence → ${evidenceDir}`);
process.on('exit', () => rmSync(modules, { force: true }));
// This process BECOMES with-test-pg (loaded in-process, never forked): the
// isolated-runtime proof pins the supervisor as the verifier's DIRECT child
// (observeIsolatedWorkerLifetime in packages/operator-core/test/
// isolated-integration-proof.ts asserts supervisorPid === child.pid and
// supervisor.parentPid === observer.pid, measured from /proc). An intermediate
// fork here makes every observed run die with "original worker observation
// refused", and no message relay can repair a kernel-measured parentage.
// argv / cwd reproduce exactly what a direct `node scripts/with-test-pg.mjs` sees.
process.argv = [process.execPath, join(ROOT, 'scripts/with-test-pg.mjs'), '--isolated-runtime=operator-api', '--',
  process.execPath, '--import', 'tsx', join(ROOT, 'packages/operator-core/test/working-tree-operator-api-fixture.ts'),
  ...(caller.length ? ['--', ...caller] : [])];
process.chdir(ROOT);
await import(pathToFileURL(join(ROOT, 'scripts/with-test-pg.mjs')).href);
