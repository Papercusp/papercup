import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { starlightContentAdapter } from './starlight';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('starlightContentAdapter concurrent cold reads', () => {
  it('shares one in-flight content read across concurrent searches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'starlight-concurrency-'));
    roots.push(root);
    const file = path.join(root, 'guide.md');
    await fs.writeFile(file, '# Guide\n\nneedle');
    const adapter = starlightContentAdapter({ contentRoot: root });
    const [page] = await adapter.listPages();

    const originalReadFile = fs.readFile.bind(fs);
    let contentReads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === file) contentReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalReadFile(...args as Parameters<typeof fs.readFile>);
    });

    const bodies = await Promise.all(Array.from({ length: 8 }, () => adapter.getContent(page)));
    expect(new Set(bodies)).toEqual(new Set(['# Guide\n\nneedle']));
    expect(contentReads).toBe(1);
  });
});
