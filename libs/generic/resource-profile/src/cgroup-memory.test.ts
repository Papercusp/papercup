import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectiveCgroupMemoryBytes } from './cgroup-memory';
import { deriveDatabaseTuning } from './index';

const GiB = 2 ** 30;
const host = 64 * GiB;

function hierarchy(version: 1 | 2, root: string, parent: string, leaf?: string) {
  const v2 = version === 2;
  const file = v2 ? 'memory.max' : 'memory.limit_in_bytes';
  const files = new Map([
    ['/proc/self/cgroup', v2 ? '0::/slice/parent/session:1' : '5:cpu:/elsewhere\n8:memory:/slice/parent/session:1'],
    ['/proc/self/mountinfo', '31 26 0:28 /slice /mounted\\040here ro - ' +
      (v2 ? 'cgroup2 cgroup rw' : 'cgroup cgroup rw,memory')],
    ['/mounted here/' + file, root], ['/mounted here/parent/' + file, parent],
    ['/mounted here/parent/session:1/memory.high', '4096'],
  ]);
  if (leaf !== undefined) files.set('/mounted here/parent/session:1/' + file, leaf);
  return files;
}

describe('embedded PostgreSQL memory detection', () => {
  it('loads the package entry and computes database settings in plain Node', () => {
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    const script = "import { detectEmbeddedDatabaseSettings } from '@papercusp/resource-profile';" +
      "process.stdout.write(detectEmbeddedDatabaseSettings().shared_buffers)";
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script],
      { cwd, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' });
    expect(output).toMatch(/^\d+MB$/);
  });

  it('selects the tightest finite memory ceiling with host fallback at the boundary', () => {
    for (const version of [1, 2] as const) {
      const unlimited = version === 1 ? '9223372036854771712' : 'max';
      for (const limit of [host - 1, host, host + 1]) {
        const files = hierarchy(version, unlimited, unlimited, String(limit));
        expect(effectiveCgroupMemoryBytes(host, path => files.get(path))).toBe(Math.min(limit, host));
      }
      for (const [root, parent, leaf, expected] of [
        [String(8 * GiB), unlimited, String(16 * GiB), 8 * GiB],
        [unlimited, String(8 * GiB), undefined, 8 * GiB],
        [unlimited, String(16 * GiB), String(8 * GiB), 8 * GiB],
        [unlimited, unlimited, unlimited, host],
        [unlimited, unlimited, undefined, host],
      ] as const) {
        const files = hierarchy(version, root, parent, leaf);
        expect(effectiveCgroupMemoryBytes(host, path => files.get(path))).toBe(expected);
      }
    }
    expect(effectiveCgroupMemoryBytes(host, () => undefined)).toBe(host);
  });

  it('uses only the current memory hierarchy and handles a private cgroup namespace', () => {
    const files = new Map([
      ['/proc/self/cgroup', '0::/'],
      ['/proc/self/mountinfo', '3 1 0:2 / /cg ro - cgroup2 cgroup rw\n4 1 0:2 /other /foreign ro - cgroup2 cgroup rw'],
      ['/foreign/memory.max', '1024'], ['/cg/memory.max', String(8 * GiB)],
    ]);
    expect(effectiveCgroupMemoryBytes(host, path => files.get(path))).toBe(8 * GiB);
  });

  it.each([[4, 100, 17], [128, 512, 4]])('sizes an 8 GiB embedded database with %i physical cores',
    (physicalCores, maxConnections, workMemMb) => {
      const limits = hierarchy(2, 'max', String(8 * GiB), 'max');
      const totalMemBytes = effectiveCgroupMemoryBytes(host, path => limits.get(path));
      expect(deriveDatabaseTuning({ cores: 2, physicalCores, totalMemBytes, freeMemBytes: GiB,
        embeddedPg: true, hostRole: 'full' })).toMatchObject({
        maxConnections, sharedBuffersMb: 1229, effectiveCacheSizeMb: 4096,
        maintenanceWorkMemMb: 512, workMemMb, walBuffersMb: 37, maxWalSizeMb: 1024,
      });
    });
});
