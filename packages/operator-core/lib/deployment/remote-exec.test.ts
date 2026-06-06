import { describe, it, expect, vi } from 'vitest';
import { createSshRemoteExec, type SpawnLike } from './remote-exec';

/** A fake child process + spawn that records calls and lets the test drive exit. */
function fakeSpawn(exitCode = 0, stderr = '') {
  const calls: Array<{ cmd: string; args: string[]; stdin: string }> = [];
  // Cast through unknown: SpawnLike's `on` is an overloaded method, which a single
  // arrow can't structurally satisfy even though this fake is behaviorally correct.
  const spawn = ((cmd: string, args: string[]) => {
    const rec = { cmd, args, stdin: '' };
    calls.push(rec);
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    return {
      stdin: {
        write: (s: string) => {
          rec.stdin += s;
        },
        end: () => {},
      },
      stdout: { on: () => {} },
      stderr: {
        on: (_ev: 'data', cb: (d: Buffer) => void) => {
          if (stderr) cb(Buffer.from(stderr));
        },
      },
      on: (ev: string, cb: (arg: unknown) => void) => {
        (handlers[ev] ??= []).push(cb);
        if (ev === 'close') queueMicrotask(() => cb(exitCode));
      },
    };
  }) as unknown as SpawnLike;
  return { spawn, calls };
}

describe('createSshRemoteExec', () => {
  it('runScript pipes the script to `bash -s` over ssh with identity + batch flags', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const exec = createSshRemoteExec({ host: '1.2.3.4', identityFile: '/k', user: 'ubuntu', port: 2222 }, { spawn });
    await exec.runScript('echo hi');
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('ssh');
    expect(calls[0].args).toContain('-i');
    expect(calls[0].args).toContain('/k');
    expect(calls[0].args).toContain('-p');
    expect(calls[0].args).toContain('2222');
    expect(calls[0].args).toContain('BatchMode=yes');
    // Only the explicit identity — a loaded ssh-agent otherwise exhausts the
    // server's MaxAuthTries before the -i key is offered (hit live 2026-06-06).
    expect(calls[0].args).toContain('IdentitiesOnly=yes');
    // Disposable frames on recycled IPs: never pin host keys in the user's
    // known_hosts (a stale pinned key fails every connection — hit live 2026-06-06).
    expect(calls[0].args).toContain('UserKnownHostsFile=/dev/null');
    expect(calls[0].args).toContain('StrictHostKeyChecking=accept-new');
    expect(calls[0].args).toContain('ConnectTimeout=10');
    expect(calls[0].args).toContain('ubuntu@1.2.3.4');
    expect(calls[0].args).toContain('bash -s');
    expect(calls[0].stdin).toBe('echo hi');
  });

  it('sudo target runs scripts under `sudo bash -s` (non-root logins, e.g. Latitude VMs)', async () => {
    const { spawn, calls } = fakeSpawn();
    const exec = createSshRemoteExec({ host: '1.2.3.4', user: 'ubuntu', sudo: true }, { spawn });
    await exec.runScript('whoami');
    expect(calls[0].args).toContain('sudo -H bash -s');
    expect(calls[0].args).not.toContain('bash -s');
  });

  it('copyFile uses scp with the host:remotePath target', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const exec = createSshRemoteExec({ host: '5.6.7.8' }, { spawn });
    await exec.copyFile('/local/f', '/remote/f');
    expect(calls[0].cmd).toBe('scp');
    expect(calls[0].args).toContain('/local/f');
    expect(calls[0].args).toContain('root@5.6.7.8:/remote/f');
  });

  it('a non-zero exit rejects with stderr context', async () => {
    const { spawn } = fakeSpawn(2, 'boom on the frame');
    const exec = createSshRemoteExec({ host: 'h' }, { spawn });
    await expect(exec.runScript('false')).rejects.toThrow(/exited 2.*boom on the frame/s);
  });

  it('defaults user to root', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const exec = createSshRemoteExec({ host: 'h' }, { spawn });
    await exec.runScript('x');
    expect(calls[0].args).toContain('root@h');
  });
});
