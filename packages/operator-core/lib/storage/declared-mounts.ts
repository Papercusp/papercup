/**
 * Declared-mount guard (disk-durable-headroom-2026-10-15#P-015).
 *
 * This box keeps agent-generated volume off `/` with `/etc/fstab` bind mounts:
 * `/tmp`, coredumps, `.gitnexus`, and both agent scratch roots all come from
 * `/mnt/data`. Each is declared `nofail`. If a boot leaves one of those binds
 * unmounted, boot carries on and every writer silently lands on `/` again,
 * which is how the root disk filled before. Nothing failed, so nothing paged.
 *
 * The expectation is DERIVED from fstab itself, never from a hand-kept path
 * list. A new bind added to fstab is guarded the moment it is declared, and a
 * box with no binds (a normal install) has nothing to report.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { RetentionClass } from './retention-policy';

export interface DeclaredBindMount {
  source: string;
  target: string;
  options: string[];
  problem?: 'missing' | 'wrong-device' | 'source-on-root' | 'scratch-on-root';
}

/** fstab and mountinfo encode space, tab, newline and backslash as octal escapes (`\040`). */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function normalizeTarget(target: string): string {
  const trimmed = target.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The bind mounts fstab expects to be mounted at boot. A `noauto` entry is
 * excluded because nothing promises to mount it.
 */
export function parseFstabBindMounts(text: string): DeclaredBindMount[] {
  const out: DeclaredBindMount[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [source, target, fstype, opts = ''] = line.split(/\s+/);
    if (!source || !target || !fstype) continue;
    const options = opts.split(',').filter(Boolean);
    const isBind = fstype === 'bind' || options.includes('bind') || options.includes('rbind');
    if (!isBind || options.includes('noauto')) continue;
    out.push({ source: unescapeMountPath(source), target: normalizeTarget(unescapeMountPath(target)), options });
  }
  return out;
}

/** Mount points currently visible to this process (`/proc/self/mountinfo` field 5). */
export function parseMountinfoTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const mountPoint = fields[4];
    if (mountPoint) out.add(normalizeTarget(unescapeMountPath(mountPoint)));
  }
  return out;
}

export function findMissingDeclaredMounts(declared: readonly DeclaredBindMount[], mounted: ReadonlySet<string>): DeclaredBindMount[] {
  return declared.filter((mount) => !mounted.has(mount.target));
}

/** Kernel device identities distinguish a mounted bind from a correct bind. */
export function parseMountinfoDevices(text: string): Map<string, string> {
  const devices = new Map<string, string>();
  for (const line of text.split('\n').filter(Boolean)) {
    const fields = line.split(' ');
    if (!/^\d+:\d+$/.test(fields[2] ?? '') || !fields[4]?.startsWith('/') || !line.includes(' - ')) {
      throw new Error('Unreadable mount device identity');
    }
    devices.set(normalizeTarget(unescapeMountPath(fields[4]!)), fields[2]!);
  }
  if (!devices.has('/')) throw new Error('Root device identity unavailable');
  return devices;
}

function backingDevice(path: string, devices: ReadonlyMap<string, string>): string {
  let ancestor = resolve(path);
  while (!devices.has(ancestor) && ancestor !== '/') ancestor = dirname(ancestor);
  return devices.get(ancestor)!;
}

/** Reuse policy pattern discovery, following scratch symlinks read-only. */
export async function registeredScratchRoots(policy?: readonly RetentionClass[]): Promise<string[]> {
  const [{ RETENTION_POLICY, compilePolicy }, { policyRoots }] = await Promise.all([
    import('./retention-policy'), import('./disk-reclaim'),
  ]);
  const errors: string[] = [];
  const roots = await policyRoots(compilePolicy((policy ?? RETENTION_POLICY).filter(cls => cls.offRoot)), homedir(), errors,
    { lstat: stat, readdir }, 'placement');
  if (errors.length) throw new Error(errors.join('\n'));
  return roots.map(root => root.path);
}

export function findDeclaredMountDeviceProblems(fstab: string, mountinfo: string): DeclaredBindMount[] {
  const devices = parseMountinfoDevices(mountinfo);
  const rootDevice = devices.get('/')!;
  const filesystemTargets = fstab.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/\s+/)).filter(([, target, type, options = '']) => target && type !== 'bind' &&
      !options.split(',').some(option => ['bind', 'rbind', 'noauto'].includes(option)))
    .map(([, target]) => normalizeTarget(unescapeMountPath(target!))).filter(target => target !== '/');
  const problems: DeclaredBindMount[] = [];
  for (const mount of parseFstabBindMounts(fstab)) {
    if (!devices.has(mount.target)) { problems.push({ ...mount, problem: 'missing' }); continue; }
    const sourceDevice = backingDevice(mount.source, devices);
    if (filesystemTargets.some(target => mount.source === target || mount.source.startsWith(target + '/')) && sourceDevice === rootDevice) {
      problems.push({ ...mount, problem: 'source-on-root' });
    } else if (devices.get(mount.target) !== sourceDevice) problems.push({ ...mount, problem: 'wrong-device' });
  }
  return problems;
}

/**
 * Declared bind mounts that are not mounted right now. Returns `null` when either
 * file cannot be read. Unreadable is NOT healthy, so a caller must not resolve an
 * open alarm on `null`.
 */
export async function readMissingDeclaredMounts(
  fstabPath = '/etc/fstab',
  mountinfoPath = '/proc/self/mountinfo',
  deps: { scratchRoots?: () => Promise<string[]>; realpath?: (path: string) => Promise<string> } = {},
): Promise<DeclaredBindMount[] | null> {
  try {
    const [fstab, mountinfo] = await Promise.all([readFile(fstabPath, 'utf8'), readFile(mountinfoPath, 'utf8')]);
    const devices = parseMountinfoDevices(mountinfo);
    const problems = findDeclaredMountDeviceProblems(fstab, mountinfo);
    for (const path of await (deps.scratchRoots ?? registeredScratchRoots)()) {
      const physical = await (deps.realpath ?? realpath)(path);
      if (backingDevice(physical, devices) === devices.get('/') && !problems.some(mount => mount.target === path)) {
        problems.push({ target: path, source: physical, options: [], problem: 'scratch-on-root' });
      }
    }
    return problems;
  } catch {
    return null;
  }
}

export const DECLARED_MOUNT_ALARM_CONDITION_KEY = 'alarm:declared-mount-missing';
export const DECLARED_MOUNT_ALARM_TITLE = 'Declared disk mount missing: writes are landing on the wrong disk';

export function formatMissingMountsEscalation(missing: readonly DeclaredBindMount[]): { title: string; body: string } {
  const lines = missing.map((mount) => `• ${mount.target} (expected bind of ${mount.source})${mount.problem ? `: ${mount.problem}` : ''}`);
  return {
    title: DECLARED_MOUNT_ALARM_TITLE,
    body:
      `${missing.length} declared mount or registered scratch placement problem(s). Writers may be filling the wrong disk:\n` +
      `${lines.join('\n')}\n` +
      'Check source filesystems and backing devices before restoring a bind. Preserve existing data through the governed offload route. ' +
      'A mounted target alone is insufficient: `nofail` can leave the source volume on the root disk.',
  };
}
