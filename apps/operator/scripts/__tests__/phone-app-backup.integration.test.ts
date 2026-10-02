import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import postgres from 'postgres';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';

const execFileAsync = promisify(execFile);
const script = resolve(import.meta.dirname, '../../../../infra/phone-app/phone-db-backup.mjs');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no fixture port')); return; }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

it('backs up Phone rows and restores them in an isolated database without replacing the recovery point', async () => {
  const work = await mkdtemp(join(tmpdir(), 'phone-db-backup-test-'));
  const server = await startEmbeddedPostgresServer({ dataDir: join(work, 'source-pg'),
    dbName: 'phone', port: await freePort(), onLog: () => {} });
  const sql = postgres(server.urls.admin, { max: 1, onnotice: () => {} });
  const archive = join(work, 'backup', 'phone.dump');
  const env = { ...process.env, PHONE_APP_DATABASE_URL: server.urls.admin,
    PHONE_DATABASE_URL: '', DATABASE_URL: '', PHONE_HOME: join(work, 'unused-home') };
  const run = (args: string[]) => execFileAsync(process.execPath, [script, ...args],
    { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
  try {
    await sql.unsafe('CREATE TABLE public.phone_calls (id text PRIMARY KEY, note text NOT NULL)');
    await sql.unsafe("INSERT INTO public.phone_calls VALUES ('call-1', 'restorable-row')");
    const backup = await run(['backup', '--out', archive]);
    expect(JSON.parse(backup.stdout)).toMatchObject({ ok: true, action: 'backup', archive });
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect((await stat(`${archive}.sha256`)).mode & 0o777).toBe(0o600);
    const original = await readFile(archive);
    await expect(run(['backup', '--out', archive])).rejects.toThrow();
    expect(await readFile(archive)).toEqual(original);

    const drill = await run(['restore-drill', '--archive', archive]);
    expect(drill.stdout, `restore drill must emit its verification result; ${drill.stderr}`).not.toBe('');
    expect(JSON.parse(drill.stdout)).toMatchObject({ ok: true, action: 'restore-drill',
      tablesVerified: 1, nonEmptyTables: ['phone_calls'] });
    expect(backup.stdout + backup.stderr + drill.stdout + drill.stderr).not.toContain(new URL(server.urls.admin).password);

    await writeFile(archive, Buffer.concat([original, Buffer.from('tamper')]));
    await expect(run(['restore-drill', '--archive', archive])).rejects.toThrow('digest mismatch');

    await sql.unsafe('DROP TABLE public.phone_calls');
    await expect(run(['backup', '--out', join(work, 'backup', 'wrong-db.dump')]))
      .rejects.toThrow('no Phone call ledger');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);

it('emits actionable cost alerts from existing usage accounts without disclosing tenant or database credentials', async () => {
  const work = await mkdtemp(join(tmpdir(), 'phone-usage-status-test-'));
  const server = await startEmbeddedPostgresServer({ dataDir: join(work, 'source-pg'),
    dbName: 'phone', port: await freePort(), onLog: () => {} });
  const sql = postgres(server.urls.admin, { max: 1, onnotice: () => {} });
  const env = { ...process.env, PHONE_APP_DATABASE_URL: server.urls.admin,
    PHONE_DATABASE_URL: '', DATABASE_URL: '' };
  const check = async () => execFileAsync(process.execPath, [script, 'usage-status'], {
    env, timeout: 20_000,
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout as string, stderr: error.stderr as string }));
  const now = Date.now();
  const policy = {
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 3_600_000).toISOString(),
    approvedBy: 'fixture-approver', approvalRef: 'fixture-approval',
    status: 'active', hardCapMicros: 1_000_000,
    rateSheet: { id: 'fixture-rates', currency: 'USD', sourceRefs: ['fixture-reference'],
      effectiveAt: new Date(now - 60_000).toISOString(), capturedAt: new Date(now - 60_000).toISOString() },
  };
  const account = { policy, spentMicros: 100_000, reservedMicros: 200_000 };
  try {
    const missingLedger = await check();
    expect(missingLedger.code).not.toBe(0);
    expect(JSON.parse(missingLedger.stdout).alerts[0].condition).toBe('usage-telemetry-unavailable');
    await sql.unsafe('CREATE TABLE public.phone_usage_accounts (owner_id text PRIMARY KEY, state jsonb NOT NULL)');
    await sql`INSERT INTO phone_usage_accounts (owner_id, state)
      VALUES (${'private-owner-id'}, ${sql.json(account)})`;
    const healthy = await check();
    expect(healthy.code, healthy.stdout + healthy.stderr).toBe(0);
    expect(JSON.parse(healthy.stdout)).toMatchObject({
      ok: true, action: 'usage-status', accountsChecked: 1,
      alerts: [], liveProviderSpendVerified: false,
    });
    for (const [state, expected] of [
      [{ ...account, policy: { ...policy, status: 'suspended' } }, 'suspended'],
      [{ ...account, spentMicros: 900_000 }, 'exhausted'],
      [{ ...account, policy: { ...policy, periodEnd: new Date(now - 1_000).toISOString() } }, 'expired'],
      [{ ...account, policy: null }, 'missingPolicy'],
      [{ ...account, spentMicros: 'invalid' }, 'malformed'],
      [{ ...account, policy: { ...policy, approvedBy: {} } }, 'malformed'],
      [{ ...account, policy: { ...policy, approvalRef: {} } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, sourceRefs: 'x' } } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, sourceRefs: [{}] } } }, 'malformed'],
      [{ ...account, policy: { ...policy, rateSheet: { ...policy.rateSheet, id: [] } } }, 'malformed'],
    ] as const) {
      await sql`UPDATE phone_usage_accounts SET state = ${sql.json(state)}`;
      const report = await check();
      expect(report.code, report.stdout).not.toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({
        ok: false, alerts: expect.arrayContaining([{
          condition: expected, count: 1, owner: 'phone-operations',
          action: expect.any(String),
        }]),
      });
      expect(report.stdout + report.stderr).not.toContain('private-owner-id');
      expect(report.stdout + report.stderr).not.toContain(new URL(server.urls.admin).password);
    }
    await sql.unsafe('DELETE FROM phone_usage_accounts');
    expect(JSON.parse((await check()).stdout).alerts[0].condition).toBe('usage-telemetry-unavailable');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop().catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
