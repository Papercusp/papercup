/**
 * Coverage for getKnownRoles — walks the global prompts dir for role names,
 * deduping across phase subdirs, skipping _-prefixed entries + README, with a
 * 30s cache and an 'orchestrator' fallback. Uses real temp dirs under a mocked
 * harnessPath; resetModules per test for a fresh cache.
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
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'roles-')) };
});
vi.mock('./harness-paths', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  harnessPath: (...segs: string[]) => require('node:path').join(H.dir, ...segs),
}));

const prompts = () => join(H.dir, 'prompts');
const writeRole = (rel: string) => {
  const p = join(prompts(), rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '# role');
};

beforeEach(() => {
  vi.resetModules();
  rmSync(prompts(), { recursive: true, force: true });
});
afterAll(() => rmSync(H.dir, { recursive: true, force: true }));

describe('getKnownRoles', () => {
  it('walks subdirs, dedupes, and skips _-prefixed entries + README', async () => {
    writeRole('scoper.md');
    writeRole('worker.md');
    writeRole('README.md'); // skipped
    writeRole('_hidden.md'); // skipped
    writeRole('testing/scoper.md'); // dup of scoper → deduped
    writeRole('testing/validator.md');
    writeRole('_archived/old.md'); // under _-dir → skipped
    const { getKnownRoles } = await import('./known-roles');
    expect(getKnownRoles()).toEqual(['scoper', 'validator', 'worker']);
  });

  it("falls back to ['orchestrator'] when the prompts dir is empty/absent", async () => {
    const { getKnownRoles } = await import('./known-roles');
    expect(getKnownRoles()).toEqual(['orchestrator']);
  });

  it('caches within the TTL (a file added after the first read is not seen)', async () => {
    writeRole('a.md');
    const { getKnownRoles } = await import('./known-roles');
    expect(getKnownRoles()).toEqual(['a']);
    writeRole('b.md'); // added after the cache populated
    expect(getKnownRoles()).toEqual(['a']); // still cached, b not picked up
  });
});
