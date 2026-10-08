import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
