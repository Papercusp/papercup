import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

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
