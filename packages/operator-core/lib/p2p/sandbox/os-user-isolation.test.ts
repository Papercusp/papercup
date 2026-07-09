import { describe, expect, it } from 'vitest';
import {
  assertCredentialPathsUnreadable,
  buildIsolationPrincipalPlan,
  provisionIsolationPrincipal,
} from './os-user-isolation';

describe('buildIsolationPrincipalPlan', () => {
  it('defaults to a dedicated OS user plan (useradd, nologin shell, no home)', () => {
    const p = buildIsolationPrincipalPlan({ sessionId: 'sess-abc' });
    expect(p.kind).toBe('dedicated-os-user');
    expect(p.principalName).toBe('p105-sess-abc');
    expect(p.provisionCommand.cmd).toBe('useradd');
    expect(p.provisionCommand.args).toContain('--no-create-home');
    expect(p.provisionCommand.args).toContain('p105-sess-abc');
  });

  it('builds a userns plan when preferUserns is set', () => {
    const p = buildIsolationPrincipalPlan({ sessionId: 'sess-abc', preferUserns: true });
    expect(p.kind).toBe('user-namespace');
    expect(p.provisionCommand.cmd).toBe('unshare');
  });

  it('rejects a blank sessionId', () => {
    expect(() => buildIsolationPrincipalPlan({ sessionId: '  ' })).toThrow();
  });
});

describe('assertCredentialPathsUnreadable', () => {
  it('passes when every path is owner-only readable by a different uid', async () => {
    const r = await assertCredentialPathsUnreadable(['/x/token'], 1500, {
      statPath: async () => ({ mode: 0o600, uid: 1000 }),
    });
    expect(r).toEqual({ ok: true });
  });

  it('flags a world-readable credential path', async () => {
    const r = await assertCredentialPathsUnreadable(['/x/token'], 1500, {
      statPath: async () => ({ mode: 0o644, uid: 1000 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].detail).toMatch(/world-readable/);
  });

  it('flags a group-readable credential path', async () => {
    const r = await assertCredentialPathsUnreadable(['/x/token'], 1500, {
      statPath: async () => ({ mode: 0o640, uid: 1000 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].detail).toMatch(/group-readable/);
  });

  it('flags a same-uid escape even when mode bits are tight (owner-only + same uid = still a leak)', async () => {
    const r = await assertCredentialPathsUnreadable(['/x/token'], 1500, {
      statPath: async () => ({ mode: 0o600, uid: 1500 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].detail).toMatch(/same-uid escape/);
  });

  it('treats a missing path as nothing to leak (not a violation)', async () => {
    const r = await assertCredentialPathsUnreadable(['/nope'], 1500, {
      statPath: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(r).toEqual({ ok: true });
  });
});

describe('provisionIsolationPrincipal', () => {
  it('succeeds when the provision command exits 0', async () => {
    const plan = buildIsolationPrincipalPlan({ sessionId: 'sess-abc' });
    const r = await provisionIsolationPrincipal(plan, { run: async () => ({ code: 0, stderr: '' }) });
    expect(r).toEqual({ ok: true });
  });

  it('surfaces a non-zero exit as a typed refusal', async () => {
    const plan = buildIsolationPrincipalPlan({ sessionId: 'sess-abc' });
    const r = await provisionIsolationPrincipal(plan, { run: async () => ({ code: 1, stderr: 'permission denied' }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('provision-failed');
  });
});
