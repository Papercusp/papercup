import { describe, expect, it } from 'vitest';
import { computeDirectorySizeBytes, decideQuotaExceeded, enforceForeignWorkspaceQuota, type DirStatSeam } from './quota-volume';

function fakeFs(tree: Record<string, { dirs?: string[]; files?: Record<string, number> }>): DirStatSeam {
  return {
    readdir: async (path) => {
      const node = tree[path];
      if (!node) throw new Error(`ENOENT: ${path}`);
      const dirs = (node.dirs ?? []).map((name) => ({ name, isDirectory: () => true, isFile: () => false }));
      const files = Object.keys(node.files ?? {}).map((name) => ({ name, isDirectory: () => false, isFile: () => true }));
      return [...dirs, ...files];
    },
    stat: async (path) => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      const name = path.slice(path.lastIndexOf('/') + 1);
      const size = tree[parent]?.files?.[name];
      if (size === undefined) throw new Error(`ENOENT: ${path}`);
      return { size };
    },
  };
}

describe('computeDirectorySizeBytes', () => {
  it('sums file sizes at the root', async () => {
    const seam = fakeFs({ '/root': { files: { a: 100, b: 200 } } });
    expect(await computeDirectorySizeBytes('/root', seam)).toBe(300);
  });

  it('recurses into subdirectories', async () => {
    const seam = fakeFs({
      '/root': { dirs: ['sub'], files: { a: 100 } },
      '/root/sub': { files: { b: 50 } },
    });
    expect(await computeDirectorySizeBytes('/root', seam)).toBe(150);
  });

  it('fails soft (returns 0) when the root is unreadable', async () => {
    const seam = fakeFs({});
    expect(await computeDirectorySizeBytes('/missing', seam)).toBe(0);
  });

  it('skips an entry whose stat throws rather than aborting the whole walk', async () => {
    const seam: DirStatSeam = {
      readdir: async () => [
        { name: 'ok', isDirectory: () => false, isFile: () => true },
        { name: 'bad', isDirectory: () => false, isFile: () => true },
      ],
      stat: async (path) => {
        if (path.endsWith('bad')) throw new Error('EACCES');
        return { size: 42 };
      },
    };
    expect(await computeDirectorySizeBytes('/root', seam)).toBe(42);
  });
});

describe('decideQuotaExceeded', () => {
  it('is not exceeded at or under the cap', () => {
    expect(decideQuotaExceeded(100, 100)).toEqual({ exceeded: false });
    expect(decideQuotaExceeded(50, 100)).toEqual({ exceeded: false });
  });

  it('is exceeded strictly over the cap', () => {
    const d = decideQuotaExceeded(101, 100);
    expect(d.exceeded).toBe(true);
    if (d.exceeded) expect(d).toEqual({ exceeded: true, usedBytes: 101, capBytes: 100 });
  });
});

describe('enforceForeignWorkspaceQuota', () => {
  it('composes the walk and the decision', async () => {
    const seam = fakeFs({ '/root': { files: { a: 60, b: 60 } } });
    const r = await enforceForeignWorkspaceQuota('/root', 100, seam);
    expect(r.usedBytes).toBe(120);
    expect(r.decision).toEqual({ exceeded: true, usedBytes: 120, capBytes: 100 });
  });
});
