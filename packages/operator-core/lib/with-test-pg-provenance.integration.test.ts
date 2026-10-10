import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

describe('private PostgreSQL pool admission', () => {
  it('bounds non-Vitest org pools to the owned server and serves a concurrent request burst without admission refusals', async () => {
    const child = `
      (async () => {
        const assert = require('node:assert/strict');
        assert.equal(process.env.VITEST, undefined);
        const db = await import('./libs/papercusp/libs/db/src/connection.ts');
        const { getOrgPg, processConnectionCeiling } = { ...db.default, ...db };
        const { sql } = getOrgPg();
        try {
          const [settings] = await sql.unsafe("SELECT current_setting('max_connections')::int AS capacity, current_setting('superuser_reserved_connections')::int AS reserved");
          const ceiling = processConnectionCeiling();
          assert.ok(ceiling.poolMax >= 2, 'nested requests need more than one slot');
          assert.ok(ceiling.poolMax * 2 * 3 + 13 * 3 + 32 + settings.reserved <= settings.capacity,
            JSON.stringify({ settings, ceiling }));
          await Promise.all(Array.from({ length: 12 }, () => sql.unsafe('SELECT pg_sleep(0.02)')));
          console.log('PRIVATE_POOL_ADMISSION_CONTROL=' + JSON.stringify({ settings, ceiling, completed: 12 }));
        } finally { await sql.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout, stderr } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '-e', child], {
      cwd: root, env: { ...process.env, PAPERCUSP_DB_POOL_MAX: '1000' },
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find(line => line.startsWith('PRIVATE_POOL_ADMISSION_CONTROL='));
    expect(line, stderr.slice(-1000)).toBeDefined();
    const result = JSON.parse(line!.slice('PRIVATE_POOL_ADMISSION_CONTROL='.length));
    expect(result.completed).toBe(12);
    expect(result.settings.capacity).toBe(100);
    expect(result.ceiling.poolMax).toBeLessThanOrEqual(4);
    expect(stdout + stderr).not.toContain('remaining connection slots');
    expect(stdout).toContain('"runtimeRemoved":true,"pgDataRemoved":true');
  }, 200_000);
});

describe('isolated PostgreSQL mutation evidence', () => {
  it('preserves reporter provenance while replacing ambient product endpoints and identity', async () => {
    const probe = {
      PAPERCUSP_MUTATION_PROBE: '1',
      PAPERCUSP_MUTATION_PHASE: 'mutant',
      PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT: root,
      PAPERCUSP_MUTATION_PROBE_SUBJECT: join(root, 'scripts/with-test-pg.mjs'),
    };
    const child = `
      const keys = ${JSON.stringify(Object.keys(probe))};
      const provenance = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const privateDatabase = new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port !== '5432';
      console.log('TEST_PROVENANCE_ENV_RESULT=' + JSON.stringify({
        provenance, privateDatabase,
        isolatedWorkspace: process.env.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'),
        ambientSocketRemoved: process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET === undefined,
        ambientEndpointReplaced: process.env.PAPERCUSP_OPERATOR_URL !== 'http://ambient.invalid:3070',
      }));
    `;
    const { stdout } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e', child], {
      cwd: root,
      env: { ...process.env, ...probe,
        PAPERCUSP_WORKSPACE_ID: 'ambient-workspace',
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/ambient/operator.sock',
        PAPERCUSP_OPERATOR_URL: 'http://ambient.invalid:3070',
        HARNESS_ADMIN_DATABASE_URL: 'postgresql://unused@localhost:5432/ambient',
      },
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find(line => line.startsWith('TEST_PROVENANCE_ENV_RESULT='));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('TEST_PROVENANCE_ENV_RESULT='.length))).toEqual({
      provenance: probe, privateDatabase: true, isolatedWorkspace: true,
      ambientSocketRemoved: true, ambientEndpointReplaced: true,
    });
    const dataDir = stdout.match(/booting throwaway PG[^\n]*\(datadir ([^\)]+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
  }, 200_000);
});

describe('isolated PostgreSQL signal cleanup', () => {
  it.each(['supervisor', 'process-group'] as const)('finishes owned cleanup after SIGINT to %s', async target => {
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e',
      "console.log('SIGNAL_CLEANUP_WORKER_READY');setInterval(() => {}, 1000)"], {
      cwd: root, env: process.env, detached: target === 'process-group', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    let finished = false;
    try {
      const deadline = Date.now() + 180_000;
      while (!output.includes('SIGNAL_CLEANUP_WORKER_READY') && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 100));
      }
      expect(output, errors.slice(-1500)).toContain('SIGNAL_CLEANUP_WORKER_READY');
      if (target === 'process-group') process.kill(-child.pid!, 'SIGINT');
      else child.kill('SIGINT');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([closed, new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error('Private signal cleanup did not close: ' + output.slice(-2000) + errors.slice(-500))), 30_000);
      })]).finally(() => clearTimeout(timer));
      finished = true;
      expect(result.code === 130 || result.signal === 'SIGINT').toBe(true);
      const receipt = output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)))
        .find(row => row.stage === 'complete');
      expect(receipt, output.slice(-2000) + errors.slice(-500)).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(receipt.dataDir)).toBe(false);
      expect(existsSync(receipt.runtimeRoot)).toBe(false);
    } finally {
      if (!finished && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          try { target === 'process-group' ? process.kill(-child.pid!, 'SIGKILL') : child.kill('SIGKILL'); } catch { /* already closed */ }
        }, 5000);
        await closed.finally(() => clearTimeout(timer));
      }
    }
  }, 220_000);
});
