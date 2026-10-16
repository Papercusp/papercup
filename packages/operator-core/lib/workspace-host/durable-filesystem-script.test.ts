import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_HOST_DATA_ROOT } from '@papercusp/deployment-driver';
import {
  renderDurableFilesystemScript,
  WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT,
} from './durable-filesystem-script';

/**
 * The provider-neutral durable data mount (plan aws-byoc-gcp-parity-2026-10-01 D-013 point 2).
 * GCP's output was compared byte-for-byte against its pre-extraction function when this moved
 * (WI-10005172), and gcp-provider.test.ts keeps pinning GCP's startup-script behaviour; this file
 * pins the parts AWS relies on.
 */

const AWS_DEVICE = '/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0';

function executeProbe(input: { dataMode: 'fresh' | 'existing'; probeStatus: number; type: string;
  wipeStatus: number; signatures: string; stateDir: string; uuid?: string }) {
  const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30, dataMode: input.dataMode });
  const probe = script.slice(script.indexOf('data_mode='), script.indexOf('install -d -m 0750 "$data_mount"'))
    .replace('data_probe_state_dir=/var/lib/papercusp-host-bootstrap/data-identity', `data_probe_state_dir='${input.stateDir}'`);
  return spawnSync('bash', ['-c', [
    'set -euo pipefail', 'data_device=/dev/fixture',
    `blkid() { if [[ "$*" == *TYPE* ]]; then printf '%s' '${input.type}'; return ${input.probeStatus}; fi; printf '%s' '${input.uuid ?? '01234567-89ab-cdef-0123-456789abcdef'}'; }`,
    `wipefs() { printf '%s' '${input.signatures}'; return ${input.wipeStatus}; }`,
    'mkfs.ext4() { echo FORMATTED; }', probe,
    // A new bootstrap child must be able to acquire this lock independently.
    'flock -n "${data_probe_marker}.lock" true',
  ].join('\n')], { encoding: 'utf8', timeout: 5000 });
}

describe('renderDurableFilesystemScript', () => {
  it('renders valid bash that waits for, formats-if-blank, and mounts the named device', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 180 });
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain(`data_device='${AWS_DEVICE}'`);
    expect(script).toContain(`data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`);
    expect(script).toContain('for attempt in $(seq 1 180); do test -b "$data_device"');
    expect(script).toContain('wipefs --no-act --noheadings --output TYPE "$data_device"');
    expect(script).not.toContain('mkfs.ext4 -F');
    // Survives a reboot without re-running: every mount is in fstab, and the data mount is nofail.
    expect(script).toContain('defaults,nofail,discard');
    expect(script).toContain('none bind 0 0\\n" "$data_mount/home" "$home_target" >> /etc/fstab');
    expect(script).toContain(`${WORKSPACE_HOST_DATA_ROOT} none bind 0 0`);
  });

  it.each([
    ['fresh', 0, 'ext4', 0, '', false, 0],
    ['existing', 0, 'ext4', 0, '', false, 0],
    ['fresh', 2, '', 0, '', true, 0],
    ['existing', 2, '', 0, '', false, 1],
    ['fresh', 8, '', 0, '', false, 1],
    ['existing', 4, '', 0, '', false, 1],
    ['fresh', 2, '', 1, '', false, 1],
    ['fresh', 2, '', 0, 'ext4', false, 1],
    ['fresh', 0, 'xfs', 0, '', false, 1],
    ['existing', 0, 'xfs', 0, '', false, 1],
  ] as const)('executes safe %s probe (blkid=%s,type=%s,wipefs=%s,signatures=%s)',
    (dataMode, probeStatus, type, wipeStatus, signatures, formatted, exitStatus) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'durable-probe-'));
      try {
        const run = executeProbe({ dataMode, probeStatus, type, wipeStatus, signatures, stateDir });
        expect(run.status, run.stderr).toBe(exitStatus);
        expect(run.stdout.includes('FORMATTED')).toBe(formatted);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });

  it('never restores fresh-format permission on reboot and refuses a changed filesystem identity', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'durable-reboot-'));
    const input = { dataMode: 'fresh' as const, probeStatus: 2, type: '', wipeStatus: 0, signatures: '', stateDir };
    try {
      const first = executeProbe(input);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('FORMATTED');
      const lostSignature = executeProbe(input);
      expect(lostSignature.status).toBe(1);
      expect(lostSignature.stdout).not.toContain('FORMATTED');
      const foreign = executeProbe({ ...input, probeStatus: 0, type: 'ext4', uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
      expect(foreign.status).toBe(1);
      expect(foreign.stderr).toContain('UUID changed');
      const resumed = executeProbe({ ...input, probeStatus: 0, type: 'ext4' });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).not.toContain('FORMATTED');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it('binds the canonical home on a bootc image, where /home is a symlink to var/home (WI-10006838)', () => {
    // Measured 2026-10-06 on AMI A-r62b (CentOS Stream 10 bootc): /home -> var/home. The script
    // refused that layout outright, so every bootc host failed bootstrap on AWS and GCP. Run the
    // real rendered home block against a bootc-shaped root and an ordinary one.
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    expect(script).not.toMatch(/-L \/home\b/);
    const start = script.indexOf('home_target="$(readlink -f -- /home)"');
    const end = script.indexOf('install -d -m 0755 "$home_target"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);

    const root = mkdtempSync(join(tmpdir(), 'durable-home-'));
    const run = (homePath: string) =>
      spawnSync(
        'bash',
        ['-c', ['set -euo pipefail', block.replaceAll('-- /home)', `-- ${homePath})`), 'echo "TARGET=$home_target"'].join('\n')],
        { encoding: 'utf8', env: { ...process.env, data_mount: join(root, 'data') }, timeout: 5000 },
      );
    try {
      mkdirSync(join(root, 'data'));
      // bootc: <root>/home -> var/home (relative, exactly as ostree writes it).
      mkdirSync(join(root, 'var', 'home', 'papercusp-workspace'), { recursive: true });
      writeFileSync(join(root, 'var', 'home', 'papercusp-workspace', '.auth-fixture'), 'customer-login');
      symlinkSync('var/home', join(root, 'home'));
      const bootc = run(join(root, 'home'));
      expect(bootc.status, bootc.stderr).toBe(0);
      expect(bootc.stdout).toContain(`TARGET=${realpathSync(join(root, 'var', 'home'))}`);
      expect(readFileSync(join(root, 'data', 'home', 'papercusp-workspace', '.auth-fixture'), 'utf8')).toBe(
        'customer-login',
      );

      // An ordinary image: a real /home resolves to itself.
      mkdirSync(join(root, 'plain-home'));
      const plain = run(join(root, 'plain-home'));
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stdout).toContain(`TARGET=${realpathSync(join(root, 'plain-home'))}`);

      // A /home that resolves to nothing is still refused.
      symlinkSync('missing', join(root, 'dangling-home'));
      const dangling = run(join(root, 'dangling-home'));
      expect(dangling.status).toBe(1);
      expect(dangling.stderr).toContain('workspace home mount target is not a real directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('relabels the fresh mount root on SELinux hosts before creating its children, never recursively (WI-10006903)', () => {
    // A new ext4 has no security.selinux xattrs, so its root reads unlabeled_t and every child
    // inherits it (measured on a P-012 bootc host). The relabel must come after the mount and
    // before the first child directory, and must not recurse: a recursive relabel by the backing
    // path would rewrite the home bind's copied labels to var_lib_t.
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    const lines = script.split('\n');
    const mount = lines.findIndex((l) => l.includes('mount "$data_mount"'));
    const relabel = lines.findIndex((l) => l.includes('restorecon'));
    const firstChild = lines.findIndex((l) => l.startsWith('install -d') && l.includes('"$data_mount"/'));
    expect(mount).toBeGreaterThan(0);
    expect(relabel).toBeGreaterThan(mount);
    expect(firstChild).toBeGreaterThan(relabel);
    expect(lines.filter((l) => l.includes('restorecon'))).toHaveLength(1);
    expect(lines[relabel]).not.toMatch(/restorecon\s+-\w*R/);

    const stubs = mkdtempSync(join(tmpdir(), 'durable-selinux-'));
    const run = (selinux: boolean) => {
      writeFileSync(join(stubs, 'selinuxenabled'), `#!/bin/sh\nexit ${selinux ? 0 : 1}\n`, { mode: 0o755 });
      writeFileSync(join(stubs, 'restorecon'), '#!/bin/sh\necho "restorecon $*"\n', { mode: 0o755 });
      return spawnSync('bash', ['-c', `set -euo pipefail\ndata_mount=/var/lib/papercusp\n${lines[relabel]}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
        timeout: 5000,
      });
    };
    try {
      const enforcing = run(true);
      expect(enforcing.status, enforcing.stderr).toBe(0);
      expect(enforcing.stdout.trim()).toBe(`restorecon -F ${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}`);
      const ubuntu = run(false);
      expect(ubuntu.status, ubuntu.stderr).toBe(0);
      expect(ubuntu.stdout).toBe('');
    } finally {
      rmSync(stubs, { recursive: true, force: true });
    }
  });

  it('runs the host bootstrap only after every durable mount, without its shebang', () => {
    const script = renderDurableFilesystemScript({
      devicePath: AWS_DEVICE,
      deviceWaitSec: 30,
      hostBootstrapScript: '#!/usr/bin/env bash\necho papercusp-bootstrap\n',
    });
    const bootstrapAt = script.indexOf('echo papercusp-bootstrap');
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/workspaces"`));
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/home"`));
    expect(script.match(/^#!/gm)).toHaveLength(1);
  });

  it('emits the mount alone when there is no bootstrap', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    expect(script).not.toContain('# User-supplied bootstrap follows the durable mount.');
  });

  it('refuses a device that is not named by a stable /dev/disk/by-id path', () => {
    // The script formats a blank device, so a guessed kernel name could format the wrong disk.
    for (const devicePath of ['/dev/nvme1n1', '/dev/xvdf', '/dev/disk/by-id/', "/dev/disk/by-id/x'; rm -rf /"]) {
      expect(() => renderDurableFilesystemScript({ devicePath, deviceWaitSec: 30 })).toThrow(/by-id/);
    }
  });

  it('refuses a wait that is not a positive whole number of seconds', () => {
    for (const deviceWaitSec of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec })).toThrow(/wait/);
    }
  });
});
