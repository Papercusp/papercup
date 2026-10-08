import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { installIdentityFixture, prepareIdentityFixture } from '../../../scripts/fixtures/dao-workbench-identity.mjs';

let cleanup = () => {};
afterEach(() => cleanup());
describe('native DAO synthetic identity isolation', () => {
  it('refuses installation outside explicit isolated verification', () => {
    expect(() => installIdentityFixture({ kind: 'dao-workbench-synthetic-identity-v1' }, {})).toThrow('isolated');
  });
  it('uses generated private fixtures, intercepts keychain and rejects outbound GitHub operations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dao-fixture-test-'));
    const path = prepareIdentityFixture(dir), fixture = JSON.parse(readFileSync(path, 'utf8'));
    const restore = installIdentityFixture(fixture, { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1' });
    cleanup = () => { restore(); rmSync(dir, { recursive: true, force: true }); };
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const exec = promisify(childProcess.execFile);
    expect((await exec('secret-tool', ['lookup', 'service', 'papercusp-device-keypair', 'account', fixture.keychainId])).stdout).toBe(fixture.device.privateKeyDer);
    await expect(exec('secret-tool', ['store', 'service', 'papercusp-device-keypair', 'account', 'real-owner'])).rejects.toThrow('writes');
    await expect(exec('security', ['find-generic-password'])).rejects.toThrow('writes');
    await expect(exec('gh', ['gist', 'create'])).rejects.toThrow('refuses');
    const user = await fetch('https://api.github.com/user', { headers: { authorization: 'token synthetic-workbench-token' } });
    expect(await user.json()).toEqual({ id: fixture.githubUserId, login: fixture.githubLogin });
    await expect(fetch('https://api.github.com/gists', { method: 'POST' })).rejects.toThrow('outbound');
    await expect(fetch('https://api.github.com/user', { headers: { authorization: 'token real-credential' } })).rejects.toThrow('real GitHub credentials');
  });
});

describe('native DAO viewport launch contract', () => {
  const root = resolve(__dirname, '../../..');
  const exec = promisify(childProcess.execFile);
  function verifier(exitCode = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'dao-native-launch-'));
    const script = join(dir, 'verifier.sh'), log = join(dir, 'boots.log');
    writeFileSync(script, '#!/usr/bin/env bash\nset -eu\nprintf "%s|%s|%s|%s|%s\\n" "$VERIFY_TAURI_WINDOW" "$DAO_WORKBENCH_VIEWPORT" "$VERIFY_TAURI_ISOLATED_DB" "$VERIFY_TAURI_ISOLATED_SEED" "$*" >> "$DAO_NATIVE_BOOT_LOG"\nexit ' + exitCode + '\n', { mode: 0o700 });
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    return { log, env: { ...process.env, TAURI_SURFACE_VERIFY_SUITE_VERIFIER: script, DAO_NATIVE_BOOT_LOG: log } };
  }
  it('boots separate isolated desktop and narrow windows through the maintained verifier', async () => {
    const fixture = verifier();
    await exec('bash', ['scripts/tauri-surface-verify-dao-workbench.sh'], { cwd: root, env: fixture.env, timeout: 45_000 });
    const boots = readFileSync(fixture.log, 'utf8').trim().split('\n');
    expect(boots).toHaveLength(2);
    expect(boots[0]).toMatch(/^1440x1000\|1440x1000\|1\|ready\|/);
    expect(boots[0]).not.toContain('--viewport-only');
    expect(boots[1]).toMatch(/^390x844\|390x844\|1\|ready\|/);
    expect(boots[1]).toContain('--viewport-only');
  }, 50_000);
  it('stops before the narrow boot when desktop acceptance fails', async () => {
    const fixture = verifier(17);
    await expect(exec('bash', ['scripts/tauri-surface-verify-dao-workbench.sh'], { cwd: root, env: fixture.env, timeout: 45_000 }))
      .rejects.toMatchObject({ code: 17 });
    expect(readFileSync(fixture.log, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 50_000);
});
