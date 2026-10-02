import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhoneOpsAlert } from '../../../../infra/phone-app/phone-ops-alert.mjs';

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phone-ops-alert-')); dirs.push(dir);
  const statePath = join(dir, 'ops-alert-state.json');
  const env = { PHONE_CONFIG_DIR: dir, PHONE_BACKUP_ARCHIVE: join(dir, 'phone.dump'),
    PHONE_BACKUP_MAX_AGE_HOURS: '24', PHONE_LIVEKIT_API_SECRET: 'secret-never-delivered' };
  const notices: Array<Record<string, string>> = [];
  let readiness = { ok: true, alerts: [] as Array<Record<string, string>> };
  const run = async (_command: string, args: string[]) => {
    if (args.includes('--status')) return { code: readiness.ok ? 0 : 1, stdout: JSON.stringify(readiness) };
    return { code: 0, stdout: JSON.stringify({ ok: true, alerts: [] }) };
  };
  const notify = async (notice: Record<string, string>) => { notices.push(notice); };
  return { dir, statePath, env, notices, run, notify,
    fail: () => { readiness = { ok: false, alerts: [{ component: 'sip', owner: 'phone-operations' }] }; },
    recover: () => { readiness = { ok: true, alerts: [] }; } };
}

describe('Phone source operations alert delivery', () => {
  it('delivers one actionable owner alert, dedupes repeats, reminds next day and stands down once', async () => {
    const f = fixture(); f.fail();
    const opts = { env: f.env, run: f.run, notify: f.notify, statePath: f.statePath };
    const first = await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-02T10:00:00Z') });
    expect(first).toMatchObject({ ok: false, conditions: ['readiness:sip'], publicPhoneVerified: false });
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0].title).toContain('sip');
    expect(JSON.stringify(f.notices)).not.toContain(f.env.PHONE_LIVEKIT_API_SECRET);
    expect(statSync(f.statePath).mode & 0o777).toBe(0o600);
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-02T10:15:00Z') });
    expect(f.notices).toHaveLength(1);
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:00:00Z') });
    expect(f.notices).toHaveLength(2);
    f.recover();
    const recovered = await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:15:00Z') });
    expect(recovered.ok).toBe(true);
    expect(f.notices).toHaveLength(3);
    expect(f.notices[2].title).toContain('recovered');
    await runPhoneOpsAlert({ ...opts, now: new Date('2026-10-03T10:30:00Z') });
    expect(f.notices).toHaveLength(3);
  });

  it('fails closed on missing backup configuration and malformed readiness without echoing output', async () => {
    const f = fixture();
    const env = { ...f.env, PHONE_BACKUP_MAX_AGE_HOURS: '' };
    const result = await runPhoneOpsAlert({ env, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z'),
      run: async () => ({ code: 0, stdout: 'secret-never-delivered' }), notify: f.notify });
    expect(result.conditions).toEqual(['backup:config-missing', 'readiness:check-unavailable', 'usage:check-unavailable']);
    expect(JSON.stringify(f.notices)).not.toContain('secret-never-delivered');
  });

  it('maps actual usage and backup CLI conditions without collapsing known faults to unknown', async () => {
    const f = fixture();
    const result = await runPhoneOpsAlert({ env: f.env, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z'), notify: f.notify,
      run: async (_cmd, args) => args.includes('usage-status')
        ? { code: 1, stdout: JSON.stringify({ ok: false, alerts: [{ condition: 'missingPolicy' }] }) }
        : args.includes('backup-status')
          ? { code: 1, stdout: JSON.stringify({ ok: false, alerts: [{ condition: 'backup-stale' }] }) }
          : { code: 0, stdout: JSON.stringify({ ok: true, alerts: [] }) },
    });
    expect(result.conditions).toEqual(['backup:backup-stale', 'usage:missingPolicy']);
    expect(result.notificationsSent).toBe(2);
    expect(f.notices.map(x => x.title)).toEqual([
      'Phone operations: usage missingPolicy', 'Phone operations: backup backup-stale',
    ]);
  });

  it('retries a failed notification instead of silently recording it as delivered', async () => {
    const f = fixture(); f.fail();
    const opts = { env: f.env, run: f.run, statePath: f.statePath,
      now: new Date('2026-10-02T10:00:00Z') };
    await expect(runPhoneOpsAlert({ ...opts, notify: async () => { throw new Error('delivery failed'); } }))
      .rejects.toThrow('delivery failed');
    expect(() => readFileSync(f.statePath, 'utf8')).toThrow();
    await runPhoneOpsAlert({ ...opts, notify: f.notify });
    expect(f.notices).toHaveLength(1);
  });
});
