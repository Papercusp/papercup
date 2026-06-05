/**
 * Coverage for getKnownHooks — derives lifecycle hook names by grepping
 * runHook('<name>') out of the orchestrator main-loop, deduped + sorted, 30s
 * cache, 'pre-worker' floor. Real temp main-loop file under a mocked harnessPath.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { base: fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-')) };
});
// getKnownHooks reads `${harnessPath('..')}/orchestrator/src/main-loop.ts`;
// return our temp base for any arg so the path resolves under it.
vi.mock('./harness-paths', () => ({ harnessPath: () => H.base }));

const mainLoop = () => join(H.base, 'orchestrator', 'src', 'main-loop.ts');
const writeMainLoop = (src: string) => {
  mkdirSync(join(H.base, 'orchestrator', 'src'), { recursive: true });
  writeFileSync(mainLoop(), src);
};

beforeEach(() => {
  vi.resetModules();
  rmSync(join(H.base, 'orchestrator'), { recursive: true, force: true });
});
afterAll(() => rmSync(H.base, { recursive: true, force: true }));

describe('getKnownHooks', () => {
  it('extracts + dedupes + sorts runHook names from the main-loop', async () => {
    writeMainLoop(`
      await runHook('pre-worker');
      foo(); await runHook("post-validate");
      await runHook('pre-worker'); // dup
      await runHook('pre-review');
    `);
    const { getKnownHooks } = await import('./known-hooks');
    expect(getKnownHooks()).toEqual(['post-validate', 'pre-review', 'pre-worker']);
  });

  it("floors to ['pre-worker'] when the main-loop is missing", async () => {
    const { getKnownHooks } = await import('./known-hooks');
    expect(getKnownHooks()).toEqual(['pre-worker']);
  });

  it('caches within the TTL', async () => {
    writeMainLoop(`runHook('alpha')`);
    const { getKnownHooks } = await import('./known-hooks');
    expect(getKnownHooks()).toEqual(['alpha']);
    writeMainLoop(`runHook('alpha'); runHook('beta')`); // added after first read
    expect(getKnownHooks()).toEqual(['alpha']); // still cached
  });
});
