import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findMissingDeclaredMounts,
  findDeclaredMountDeviceProblems,
  formatMissingMountsEscalation,
  parseFstabBindMounts,
  parseMountinfoTargets,
  readMissingDeclaredMounts,
  registeredScratchRoots,
} from './declared-mounts';

// Shaped like the dev box's real /etc/fstab (disk-durable-headroom-2026-10-15#P-015).
const FSTAB = [
  '# /etc/fstab: static file system information.',
  'UUID=abc / ext4 errors=remount-ro 0 1',
  'UUID=def /mnt/data xfs defaults,nofail 0 0',
  '/mnt/data/tmp /tmp none bind,nofail,x-systemd.requires-mounts-for=/mnt/data 0 0',
  '/mnt/data/papercusp-scratch/home /home/u/.papercusp/scratch none bind,nofail,x-systemd.requires-mounts-for=/mnt/data 0 0',
  '/mnt/data/with\\040space /home/u/odd\\040dir/ none rbind 0 0',
  '/mnt/data/manual /home/u/manual none bind,noauto 0 0',
  '/srv/legacy /home/u/legacy bind defaults 0 0',
  '   ',
].join('\n');

const MOUNTINFO = [
  '29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '100 29 259:1 / /mnt/data rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
  '101 29 259:1 /tmp /tmp rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
  '102 29 259:1 /with\\040space /home/u/odd\\040dir rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
].join('\n');

describe('parseFstabBindMounts', () => {
  it('keeps bind/rbind entries that auto-mount, and decodes octal escapes', () => {
    const targets = parseFstabBindMounts(FSTAB).map((m) => m.target);
    expect(targets).toEqual(['/tmp', '/home/u/.papercusp/scratch', '/home/u/odd dir', '/home/u/legacy']);
  });

  it('skips comments, real filesystems and noauto binds', () => {
    const targets = parseFstabBindMounts(FSTAB).map((m) => m.target);
    expect(targets).not.toContain('/');
    expect(targets).not.toContain('/mnt/data');
    expect(targets).not.toContain('/home/u/manual');
  });

  it('returns nothing for a box with no binds (a normal install has nothing to guard)', () => {
    expect(parseFstabBindMounts('UUID=abc / ext4 defaults 0 1\n')).toEqual([]);
  });
});

describe('findMissingDeclaredMounts', () => {
  it('names exactly the declared binds that are not mounted', () => {
    const missing = findMissingDeclaredMounts(parseFstabBindMounts(FSTAB), parseMountinfoTargets(MOUNTINFO));
    expect(missing.map((m) => m.target)).toEqual(['/home/u/.papercusp/scratch', '/home/u/legacy']);
    expect(missing[0]!.source).toBe('/mnt/data/papercusp-scratch/home');
  });

  it('reports nothing once every declared bind is mounted', () => {
    const all = MOUNTINFO + '\n103 29 259:1 /papercusp-scratch/home /home/u/.papercusp/scratch rw - xfs /dev/nvme1n1 rw'
      + '\n104 29 259:1 /legacy /home/u/legacy rw - xfs /dev/nvme1n1 rw';
    expect(findMissingDeclaredMounts(parseFstabBindMounts(FSTAB), parseMountinfoTargets(all))).toEqual([]);
  });
});

describe('readMissingDeclaredMounts', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('reads real files end to end', async () => {
    dir = mkdtempSync(join(tmpdir(), 'declared-mounts-'));
    writeFileSync(join(dir, 'fstab'), FSTAB);
    writeFileSync(join(dir, 'mountinfo'), MOUNTINFO);
    const missing = await readMissingDeclaredMounts(join(dir, 'fstab'), join(dir, 'mountinfo'), { scratchRoots: async () => [] });
    expect(missing?.map((m) => m.target)).toEqual(['/home/u/.papercusp/scratch', '/home/u/legacy']);
  });

  it('returns null (unknown), never [] (healthy), when a file cannot be read', async () => {
    expect(await readMissingDeclaredMounts('/nonexistent/fstab', '/nonexistent/mountinfo')).toBeNull();
  });

  it('discovers a newly registered scratch root without another path list, including symlinks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'declared-mounts-'));
    mkdirSync(join(dir, 'physical'));
    symlinkSync(join(dir, 'physical'), join(dir, 'new-scratch'));
    const policy = [{ id: 'new-scratch', title: 'new scratch', origin: 'agent' as const, roots: [join(dir, '*scratch')],
      offRoot: true, keep: { kind: 'keep' as const, reason: 'placement is independent of deletion' },
      enforcers: [{ kind: 'none' as const }] }];
    const roots = await registeredScratchRoots(policy);
    expect(roots).toEqual([join(dir, 'new-scratch')]);
    writeFileSync(join(dir, 'fstab'), '');
    writeFileSync(join(dir, 'mountinfo'), MOUNTINFO);
    const problems = await readMissingDeclaredMounts(join(dir, 'fstab'), join(dir, 'mountinfo'), {
      scratchRoots: async () => roots, realpath: async () => '/new-physical-scratch',
    });
    expect(problems).toEqual([{ target: roots[0], source: '/new-physical-scratch', options: [], problem: 'scratch-on-root' }]);
    expect(await readMissingDeclaredMounts(join(dir, 'fstab'), join(dir, 'mountinfo'), {
      scratchRoots: async () => roots, realpath: async () => '/mnt/data/new-physical-scratch',
    })).toEqual([]);
  });

  it.each(['inventory', 'realpath', 'mountinfo'])('retains unknown when %s cannot be completely observed', async failure => {
    dir = mkdtempSync(join(tmpdir(), 'declared-mounts-'));
    writeFileSync(join(dir, 'fstab'), '');
    writeFileSync(join(dir, 'mountinfo'), failure === 'mountinfo' ? 'malformed' : MOUNTINFO);
    expect(await readMissingDeclaredMounts(join(dir, 'fstab'), join(dir, 'mountinfo'), {
      scratchRoots: async () => { if (failure === 'inventory') throw new Error('unreadable'); return ['/new-scratch']; },
      realpath: async path => { if (failure === 'realpath') throw new Error('unreadable'); return path; },
    })).toBeNull();
  });

  it('the actual doctor CLI rejects a present wrong-device bind and a new root-side scratch path', () => {
    dir = mkdtempSync(join(tmpdir(), 'declared-mounts-'));
    const root = '1 0 8:1 / / rw - ext4 /dev/root rw';
    const data = '2 1 8:2 / /mnt/data rw - xfs /dev/data rw';
    writeFileSync(join(dir, 'fstab'), '/mnt/data/scratch /scratch none bind 0 0');
    const invoke = () => spawnSync(process.execPath, [fileURLToPath(new URL('../../../../scripts/test-doctor.mjs', import.meta.url)),
      '--scratch-only', '--fstab', join(dir!, 'fstab'), '--mountinfo', join(dir!, 'mountinfo'), '--scratch-root', dir!],
    { encoding: 'utf8', timeout: 20_000 });
    writeFileSync(join(dir, 'mountinfo'), [root, data, `3 1 8:2 / ${dir} rw - xfs /dev/data rw`,
      '4 1 8:1 /scratch /scratch rw - ext4 /dev/root rw'].join('\n'));
    const wrong = invoke();
    expect(wrong.error).toBeUndefined();
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('wrong-device');
    writeFileSync(join(dir, 'fstab'), '');
    writeFileSync(join(dir, 'mountinfo'), [root, data].join('\n'));
    const registered = invoke();
    expect(registered.error).toBeUndefined();
    expect(registered.status).toBe(1);
    expect(registered.stdout).toContain('scratch-on-root');
    writeFileSync(join(dir, 'mountinfo'), [root, data, `3 1 8:2 / ${dir} rw - xfs /dev/data rw`].join('\n'));
    const healthy = invoke();
    expect(healthy.error).toBeUndefined();
    expect(healthy.status).toBe(0);
    expect(healthy.stdout).toContain('ok  declared mounts');
  }, 60_000);
});

describe('declared backing devices', () => {
  const fstab = 'UUID=data /mnt/data xfs defaults,nofail 0 0\n/mnt/data/scratch /scratch none bind,nofail 0 0';
  const bind = (device: string) => `103 29 ${device} /scratch /scratch rw - xfs /dev/example rw`;
  it('rejects a present bind on the root device', () => {
    expect(findDeclaredMountDeviceProblems(fstab, MOUNTINFO + '\n' + bind('259:2')))
      .toEqual([expect.objectContaining({ target: '/scratch', problem: 'wrong-device' })]);
  });
  it('rejects present binds when the nofail source mount itself fell back to root', () => {
    expect(findDeclaredMountDeviceProblems(fstab, MOUNTINFO.replace('100 29 259:1', '100 29 259:2') + '\n' + bind('259:2')))
      .toEqual([expect.objectContaining({ target: '/scratch', problem: 'source-on-root' })]);
    expect(findDeclaredMountDeviceProblems(fstab, MOUNTINFO.split('\n').filter(line => !line.includes(' /mnt/data ')).join('\n') + '\n' + bind('259:2')))
      .toEqual([expect.objectContaining({ problem: 'source-on-root' })]);
  });
  it('accepts the correct data device and preserves legitimate same-root binds', () => {
    expect(findDeclaredMountDeviceProblems(fstab, MOUNTINFO + '\n' + bind('259:1'))).toEqual([]);
    expect(findDeclaredMountDeviceProblems('/srv/scratch /scratch none bind 0 0', MOUNTINFO + '\n' + bind('259:2'))).toEqual([]);
  });
  it('uses path boundaries rather than sibling prefixes', () => {
    expect(findDeclaredMountDeviceProblems('/mnt/database/scratch /scratch none bind 0 0', MOUNTINFO + '\n' + bind('259:1')))
      .toEqual([expect.objectContaining({ problem: 'wrong-device' })]);
  });
});

describe('formatMissingMountsEscalation', () => {
  it('names each missing target with its expected source', () => {
    const { body } = formatMissingMountsEscalation([{ source: '/mnt/data/x', target: '/home/u/x', options: ['bind'] }]);
    expect(body).toContain('/home/u/x (expected bind of /mnt/data/x)');
  });
});
