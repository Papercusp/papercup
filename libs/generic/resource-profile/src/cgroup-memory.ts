/** Linux spells spaces, backslashes, tabs and newlines as octal in mountinfo. */
function mountPath(field: string): string {
  return field.replace(/\\(040|134|011|012)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** The embedded database inherits its launcher's cgroup. Account for hard
 * limits at its leaf and visible ancestors, even with a nonstandard mountpoint.
 * Unbounded v1 sentinels are larger than physical RAM. v2 "max", soft limits
 * and unavailable files do not lower the detected total.
 */
export function effectiveCgroupMemoryBytes(hostBytes: number, read: (path: string) => string | undefined): number {
  const groups = new Map<string, string>();
  for (const line of (read('/proc/self/cgroup') ?? '').split('\n')) {
    const fields = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    if (!fields || fields[3].split('/').includes('..')) continue;
    if (fields[1] === '0' && !fields[2]) groups.set('cgroup2', fields[3]);
    if (fields[2].split(',').includes('memory')) groups.set('cgroup', fields[3]);
  }

  let ceiling = hostBytes;
  for (const line of (read('/proc/self/mountinfo') ?? '').split('\n')) {
    const [mount, filesystem] = line.split(' - ');
    if (!filesystem) continue;
    const [type, , options] = filesystem.split(' ');
    const group = groups.get(type);
    if (!group || (type === 'cgroup' && !options?.split(',').includes('memory'))) continue;
    const fields = mount.split(' ');
    if (!fields[3] || !fields[4]) continue;
    const root = mountPath(fields[3]);
    const directory = mountPath(fields[4]);
    if (group !== root && root !== '/' && !group.startsWith(root + '/')) continue;
    const components = group.slice(root.length).split('/').filter(Boolean);
    const filename = type === 'cgroup2' ? 'memory.max' : 'memory.limit_in_bytes';
    let path = directory === '/' ? '' : directory;
    for (const component of ['', ...components]) {
      if (component) path += '/' + component;
      const value = read(path + '/' + filename)?.trim();
      if (value && /^\d+$/.test(value)) ceiling = Math.min(ceiling, Number(value));
    }
  }
  return ceiling;
}
