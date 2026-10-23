import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('./store', () => ({ registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => {}), closeTask: vi.fn(async () => {}) }));

import { managedSpawn, probeScopeSupport, resetScopeProbe } from './managed-spawn';
import { registerTask } from './store';
import { CGROUP_ROOT, type CgroupFs } from './cgroup-read';

const manager = `/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service`;
const unit = 'pc-parent123.scope';
const path = `${manager}/papercusp.slice/papercusp-test.slice/${unit}`;
function filesystem(cgroup = path, member = true): CgroupFs {
  return { readFile: p => p === `/proc/${process.pid}/cgroup` ? `0::${cgroup}\n`
    : p === `${CGROUP_ROOT}${cgroup}/cgroup.procs` && member ? `${process.pid}\n` : null,
  readDir: () => [], isDir: () => false };
}
const child = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(),
  stderr: new PassThrough(), pid: 4242, kill: vi.fn() });

describe('managed spawn current-scope evidence (P026)', () => {
  beforeEach(() => { resetScopeProbe(); vi.clearAllMocks(); });

  it('enrolls and confines the real payload without launching a disposable bootstrap scope', async () => {
    const attestation = child();
    const payload = child();
    const spawnFn = vi.fn().mockReturnValueOnce(attestation).mockReturnValueOnce(payload);
    const pending = managedSpawn('language-server', ['--stdio'], { class: 'sidecar', title: 'LSP', argv: [],
      launchedBy: 'test:scope-probe' },
      { spawnFn: spawnFn as unknown as typeof spawn, fs: filesystem(), taskId: 'lspchild123' });
    // The flag read is asynchronous; wait only for this deterministic promise turn.
    await Promise.resolve();
    expect(spawnFn.mock.calls[0]?.[0]).toBe('systemctl');
    attestation.stdout.end(`Id=${unit}\nControlGroup=${path}\nActiveState=active\nTransient=yes\n`);
    await once(attestation.stdout, 'end');
    attestation.emit('close', 0);
    const launched = await pending;
    expect(launched.confined).toBe(true);
    expect(launched.scopeUnit).toBe('pc-lspchild123.scope');
    expect(registerTask).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ taskId: 'lspchild123', reserveScope: true }), undefined, undefined);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(spawnFn.mock.calls[1]?.[0]).toBe('systemd-run');
    expect(spawnFn.mock.calls[1]?.[1]).toContain('--unit=pc-lspchild123.scope');
    expect(spawnFn.mock.calls[1]?.[1]).toContain('language-server');
    expect(spawnFn.mock.calls.flat(2)).not.toContain('/usr/bin/true');
    expect(vi.mocked(registerTask).mock.invocationCallOrder[0]).toBeLessThan(spawnFn.mock.invocationCallOrder[1]!);
  });

  it.each([
    [path, false],
    [path.replace('.scope', '.service'), true],
    [`${manager}/app.slice/${unit}`, true],
    [path.replace(`user@${process.getuid!()}.service`, 'user@99999.service'), true],
  ] as const)('does not infer support from an unverified kernel membership: %s %s', async (cgroup, member) => {
    const probe = child();
    const spawnFn = vi.fn(() => probe) as unknown as typeof spawn;
    const pending = probeScopeSupport(spawnFn, filesystem(cgroup, member));
    expect(spawnFn).toHaveBeenCalledWith('systemd-run', expect.arrayContaining(['/usr/bin/true']), expect.anything());
    probe.emit('exit', 1);
    await expect(pending).resolves.toMatchObject({ ok: false });
  });
});
