// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
// Enroll the spawned controller in this package's actual compiler program
// without executing its DBOS boot in the Vitest parent.
import type {} from '../../test/_session-interruption-dbos-child';

let db: OrgTestDb;
beforeAll(async () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const required = ['packages/operator-core/test/_session-interruption-dbos-child.ts',
    'packages/operator-core/lib/dbos/session-interruption-workflow.ts',
    'packages/operator-core/lib/harness/routines/session-interruption-runtime.ts',
    'apps/operator/scripts/psu-pty-host.mjs'];
  for (const path of required) {
    const absolute = join(repo, path);
    expect(existsSync(absolute), `crash fixture missing source: ${path}`).toBe(true);
    if (process.env.NODE_OPTIONS?.includes('committed-source-loader')) {
      const committed = spawnSync('git', ['show', 'HEAD:' + path], { cwd: repo, maxBuffer: 4 * 1024 * 1024 });
      expect(committed.status, `await git-sync before crash proof: ${path}`).toBe(0);
      expect(readFileSync(absolute).equals(committed.stdout), `await git-sync; loader would substitute ${path}`).toBe(true);
    }
  }
  db = await createOrgTestDb();
  await db.adminSql`CREATE SCHEMA test_recovery`;
  await db.adminSql`CREATE TABLE test_recovery.creations (owner_id text, pid integer)`;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });
const childPath = fileURLToPath(new URL('../../test/_session-interruption-dbos-child.ts', import.meta.url));

describe('real DBOS interruption-controller death with a surviving native PTY', () => {
  it.each(['before-reservation', 'after-reservation', 'after-dispatch-intent',
    'after-native-creation', 'before-settlement', 'after-settlement'])(
    'reconciles %s without refunding or duplicating native creation', async target => {
      const owner = 'su-crash-' + randomUUID();
      const root = mkdtempSync(join(tmpdir(), 'recovery-dbos-'));
      const sql = db.adminSql;
      const at = Date.now();
      const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
      const [adv] = await sql`INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, coord_owner_id, session_id, started_at, ended_at, launch_spec)
        VALUES ('recovery-dbos-crash', 'codex', 'console', ${owner}, ${native}, now(), now(), '{"headless":true}') RETURNING id`;
      const payload = { workspaceId: 'recovery-dbos-crash', ownerId: owner, nativeSessionId: native,
        advSessionId: String(adv.id), hostPid: 99999999, hostStartedAt: at - 10_000,
        execution: { ownerId: owner, hostPid: 99999999, observedAt: at - 1, phase: 'running',
          turnStartedAt: at - 5000, lastProgressAt: at - 1, pendingTools: 0 } };
      await sql`INSERT INTO harness_shared.psu_pty_host_events (workspace_id, owner_id, ts, kind, payload, row_digest)
        VALUES ('recovery-dbos-crash', ${owner}, now(), 'session-execution-observed', ${JSON.stringify(payload)}::jsonb, ${owner})`;
      const run = (mode: string) => spawnSync(process.execPath, ['--import', 'tsx', childPath], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, RECOVERY_CRASH_DSN: db.adminDsn, RECOVERY_CRASH_OWNER: owner,
          RECOVERY_CRASH_ROOT: root, RECOVERY_CRASH_TARGET: target, RECOVERY_CRASH_MODE: mode },
      });
      const marker = async () => (await sql`SELECT control_state #> '{lifecycle,interruption}' AS marker
        FROM harness_shared.session_briefs WHERE owner_id = ${owner}`)[0]?.marker;
      try {
        const crashed = run('crash');
        expect(crashed.signal, crashed.stdout + crashed.stderr).toBe('SIGKILL');
        const before = await marker();
        const recovered = run('recover');
        expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
        const line = recovered.stdout.split('\n').find(row => row.startsWith('RECOVERY_OUTCOME '));
        expect(line, recovered.stdout).toBeTruthy();
        const proof = JSON.parse(line!.slice('RECOVERY_OUTCOME '.length));
        const held = target === 'after-dispatch-intent';
        expect(proof.outcome).toMatchObject({ verified: !held,
          reason: held ? 'uncertain-native-creation' : 'exact-native-host-verified' });
        const after = await marker();
        expect(after).toMatchObject({ attempts: 1, state: held ? 'blocked' : 'restored',
          actionId: proof.workflowId, leaseKey: null });
        if (before) expect(after.actionId).toBe(before.actionId);
        const creations = await sql`SELECT pid FROM test_recovery.creations WHERE owner_id = ${owner}`;
        expect(creations).toHaveLength(held ? 0 : 1);
        for (const creation of creations) expect(() => process.kill(creation.pid, 0)).not.toThrow();
        const steps = await sql`SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = ${proof.workflowId}
          ORDER BY function_id`;
        expect(steps.map(row => row.function_name)).toEqual(['recovery:0:admission', 'recovery:0:reservation',
          'recovery:0:guarded-launch', 'recovery:0:native-identity', 'recovery:0:settlement']);
        const replay = run('recover');
        expect(replay.status, replay.stdout + replay.stderr).toBe(0);
        expect(await marker()).toEqual(after);
        expect(await sql`SELECT pid FROM test_recovery.creations WHERE owner_id = ${owner}`).toEqual(creations);
      } finally {
        for (const row of await sql`SELECT pid FROM test_recovery.creations WHERE owner_id = ${owner}`) {
          try { process.kill(-row.pid, 'SIGKILL'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    }, 240_000);
});
