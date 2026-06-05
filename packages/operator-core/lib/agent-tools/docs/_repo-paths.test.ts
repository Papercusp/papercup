/**
 * Unit tests for the repo-root resolution in agent-tools/docs/_repo-paths.ts.
 *
 * `findRepoRoot` is module-private and runs ONCE at load time to populate the
 * exported consts REPO_ROOT / DOCS_CONTENT_ROOT / LLMS_TXT_PATH. So the only
 * observable surface is those consts — to exercise each branch we must control
 * `process.cwd()` and the mocked `existsSync` BEFORE the module loads, then
 * `vi.resetModules()` + dynamic-import per scenario.
 *
 * `node:fs` is mocked so `existsSync` is fully controlled (no real disk walk).
 * `process.cwd` is stubbed per test. The three branches covered:
 *   1. walk-up hit — the cwd's parent chain contains the docs tree → that dir.
 *   2. apps/operator fallback — nothing found by walking, but cwd ends in
 *      apps/operator → resolve(cwd, '..', '..') (the repo root two up).
 *   3. bare-cwd fallback — nothing found and cwd is not apps/operator → cwd.
 *
 * NOTE (reported, not worked-around): because the consts are load-time, we
 * cannot test `findRepoRoot` in isolation without re-importing; this is the
 * `vi.resetModules()` + re-import strategy the task brief calls out. The
 * 16-level walk *cap* itself is not separately observable through the consts
 * (any cwd deep enough to need >16 hops would be pathological), so it is
 * exercised indirectly: a hit within 16 levels is found, and a never-hit cwd
 * falls through to the cwd/operator fallbacks rather than looping forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const DOCS_CONTENT_REL = path.join('apps', 'operator-docs', 'src', 'content', 'docs');
const LLMS_TXT_REL = path.join('apps', 'operator', 'public', 'internal', 'docs', 'llms.txt');

// The mock fn the module's `existsSync` will resolve to.
const existsSyncMock = vi.fn<(p: string) => boolean>();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
}));

const cwdSpy = vi.spyOn(process, 'cwd');

/** Reset module cache + import fresh so findRepoRoot re-runs against current stubs. */
async function loadFresh(): Promise<typeof import('./_repo-paths')> {
  vi.resetModules();
  return import('./_repo-paths');
}

beforeEach(() => {
  existsSyncMock.mockReset();
  cwdSpy.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('findRepoRoot — walk-up hit', () => {
  it('returns the ancestor dir that contains the docs content tree', async () => {
    const repoRoot = path.resolve('/home', 'me', 'workspace', 'papercup');
    const cwd = path.join(repoRoot, 'apps', 'operator');
    cwdSpy.mockReturnValue(cwd);

    // existsSync(join(dir, DOCS_CONTENT_REL)) is true only at repoRoot.
    existsSyncMock.mockImplementation((p) => p === path.join(repoRoot, DOCS_CONTENT_REL));

    const { REPO_ROOT, DOCS_CONTENT_ROOT, LLMS_TXT_PATH } = await loadFresh();
    expect(REPO_ROOT).toBe(repoRoot);
    expect(DOCS_CONTENT_ROOT).toBe(path.join(repoRoot, DOCS_CONTENT_REL));
    expect(LLMS_TXT_PATH).toBe(path.join(repoRoot, LLMS_TXT_REL));
  });

  it('finds the docs tree when cwd IS the repo root (first iteration hit)', async () => {
    const repoRoot = path.resolve('/srv', 'papercup');
    cwdSpy.mockReturnValue(repoRoot);
    existsSyncMock.mockImplementation((p) => p === path.join(repoRoot, DOCS_CONTENT_REL));

    const { REPO_ROOT } = await loadFresh();
    expect(REPO_ROOT).toBe(repoRoot);
  });

  it('walks up several levels (a deeply nested cwd) to find the docs tree', async () => {
    const repoRoot = path.resolve('/a', 'b', 'papercup');
    const cwd = path.join(repoRoot, 'packages', 'operator-core', 'lib', 'agent-tools', 'docs');
    cwdSpy.mockReturnValue(cwd);
    existsSyncMock.mockImplementation((p) => p === path.join(repoRoot, DOCS_CONTENT_REL));

    const { REPO_ROOT } = await loadFresh();
    expect(REPO_ROOT).toBe(repoRoot);
  });
});

describe('findRepoRoot — apps/operator fallback', () => {
  it('returns two-levels-up when walking finds nothing but cwd ends in apps/operator', async () => {
    const repoRoot = path.resolve('/packaged', 'build', 'root');
    const cwd = path.join(repoRoot, 'apps', 'operator');
    cwdSpy.mockReturnValue(cwd);
    // existsSync never true → walk-up exhausts → fallback fires.
    existsSyncMock.mockReturnValue(false);

    const { REPO_ROOT } = await loadFresh();
    expect(REPO_ROOT).toBe(path.resolve(cwd, '..', '..'));
    expect(REPO_ROOT).toBe(repoRoot);
  });
});

describe('findRepoRoot — bare-cwd fallback', () => {
  it('returns cwd unchanged when nothing is found and cwd is not apps/operator', async () => {
    const cwd = path.resolve('/some', 'unrelated', 'dir');
    cwdSpy.mockReturnValue(cwd);
    existsSyncMock.mockReturnValue(false);

    const { REPO_ROOT } = await loadFresh();
    expect(REPO_ROOT).toBe(cwd);
  });

  it('derived const paths hang off the bare-cwd fallback root', async () => {
    const cwd = path.resolve('/opt', 'whatever');
    cwdSpy.mockReturnValue(cwd);
    existsSyncMock.mockReturnValue(false);

    const { REPO_ROOT, DOCS_CONTENT_ROOT, LLMS_TXT_PATH } = await loadFresh();
    expect(REPO_ROOT).toBe(cwd);
    expect(DOCS_CONTENT_ROOT).toBe(path.join(cwd, DOCS_CONTENT_REL));
    expect(LLMS_TXT_PATH).toBe(path.join(cwd, LLMS_TXT_REL));
  });

  it('does not loop forever when the docs tree is never present (terminates at fs root)', async () => {
    // A cwd not ending in apps/operator + existsSync always false: the loop must
    // break at the filesystem root (parent === dir) and return cwd, not hang.
    const cwd = path.resolve('/');
    cwdSpy.mockReturnValue(cwd);
    existsSyncMock.mockReturnValue(false);

    const { REPO_ROOT } = await loadFresh();
    expect(REPO_ROOT).toBe(cwd);
  });
});
