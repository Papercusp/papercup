import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDetachedRetentionTrees, RETENTION_CENSUS_LIFETIME_MS } from './retention-census-walk';
import { readWalkState, walkAttemptFiles, type WalkLauncher } from './disk-census-detached-walk';

// Mutex admission is verified by its own suite; these tests control only the
// detached wait/measurement lifecycle, with no machine-speed admission race.
vi.mock('../../../../scripts/lib/fs-mutex.mjs', () => ({ withFsMutex: async (_name: string, action: () => Promise<unknown>) => action() }));

let dir: string, root: string, slot: string;
const options = { retainAfterMs: Infinity, includeRecent: true };
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'retention-adopt-unit-'));
  root = join(dir, 'root'); slot = join(dir, 'slot');
  await fs.mkdir(root); await fs.writeFile(join(root, 'entry'), 'data');
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function finish(overrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}, code = 0) {
  const state = (await readWalkState(slot))!;
  const stat = await fs.lstat(join(root, 'entry'));
  const result = { entries: [{ path: join(root, 'entry'), dev: stat.dev, ino: stat.ino,
    newestWriteMs: Math.max(stat.mtimeMs, stat.ctimeMs), bytes: stat.blocks * 512 }],
    retained: [], inspectedNodes: 1, retainedRecentTrees: 0, ...resultOverrides };
  const files = walkAttemptFiles(slot, state.attempt);
  await fs.writeFile(files.out, JSON.stringify({ version: 1, requestKey: state.requestKey,
    startedAt: state.launchedAt, finishedAt: Date.now(), result, ...overrides }));
  await fs.writeFile(files.err, ''); await fs.writeFile(files.exit, String(code));
}
const launch = (done = true) => vi.fn<WalkLauncher>(async () => {
  if (done) await finish();
  return { pid: 999_999_999, taskId: 'fixture', confined: true };
});
const walk = (launcher: WalkLauncher, waitMs = 1000) => ({ dir: slot, launch: launcher, waitMs,
  pollMs: 2, isAlive: () => !existsSync(walkAttemptFiles(slot, 1).exit) });

describe('complete retention census adoption', () => {
  it('abandons only the wait, then adopts the same complete measurement exactly once', async () => {
    const launcher = launch(false);
    const first = await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    expect(first.error).toContain('pending'); expect(first.entries).toEqual([]);
    await finish();
    const second = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(second.error).toBeUndefined(); expect(second.entries.map(e => e.path)).toEqual([join(root, 'entry')]);
    expect(launcher).toHaveBeenCalledOnce(); expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'new', confined: true }; });
    expect((await inspectDetachedRetentionTrees(root, options, walk(launcher))).error).toBeUndefined();
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  it.each(['partial', 'exit', 'foreign-key', 'outside-root', 'malformed'] as const)('refuses terminal %s output before selection', async mode => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    if (mode === 'partial') await finish({}, { error: 'retention native census timed out' });
    if (mode === 'exit') await finish({}, {}, 1);
    if (mode === 'foreign-key') await finish({ requestKey: 'different' });
    if (mode === 'outside-root') await finish({}, { entries: [{ path: '/outside/root', dev: 1, ino: 1, bytes: 1, newestWriteMs: 1 }] });
    if (mode === 'malformed') {
      await finish(); const state = (await readWalkState(slot))!;
      await fs.writeFile(walkAttemptFiles(slot, state.attempt).out, '{truncated');
    }
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toBeDefined(); expect(result.entries).toEqual([]); expect(result.retained).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce(); expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
  });
  it('reports a finished changed-input census before replacing its live slot', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    await fs.writeFile(join(root, 'arrival'), 'new');
    expect((await inspectDetachedRetentionTrees(root, options, walk(launcher))).error).toContain('still active');
    expect(launcher).toHaveBeenCalledOnce();
    await finish();
    const changed = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(changed.error).toBe('retention census input changed since previous measurement');
    expect(changed.entries).toEqual([]); expect(changed.retained).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce();
    expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'new', confined: true }; });
    await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  it('rejects expired successful output without treating it as a cap total', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    const state = (await readWalkState(slot))!;
    state.launchedAt = Date.now() - RETENTION_CENSUS_LIFETIME_MS * 3;
    await fs.writeFile(join(slot, 'state.json'), JSON.stringify(state));
    await finish({ startedAt: state.launchedAt, finishedAt: Date.now() - RETENTION_CENSUS_LIFETIME_MS - 1000 });
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toContain('stale'); expect(result.entries).toEqual([]);
  });
  it.each(['consumed', 'changed-input'] as const)('retires a dead %s attempt even when no exit receipt survived', async mode => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    if (mode === 'consumed') await fs.writeFile(join(slot, 'consumed'), 'consumed\n');
    else await fs.writeFile(join(root, 'arrival'), 'new');
    launcher.mockImplementation(async () => { await finish(); return { pid: 999_999_999, taskId: 'replacement', confined: true }; });
    if (mode === 'changed-input') {
      const changed = await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), isAlive: () => false });
      expect(changed.error).toBe('retention census input changed since previous measurement');
      expect(launcher).toHaveBeenCalledOnce();
      expect(await fs.readFile(join(slot, 'consumed'), 'utf8')).toBe('consumed\n');
    }
    const replacement = await inspectDetachedRetentionTrees(root, options, { ...walk(launcher), isAlive: () => false });
    expect(replacement.error).toBeUndefined();
    expect(launcher).toHaveBeenCalledTimes(2);
  });
  it('preserves a live worker when census options change', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    const result = await inspectDetachedRetentionTrees(root, { ...options, collectBuildDirs: true }, walk(launcher));
    expect(result.error).toContain('still active'); expect(result.entries).toEqual([]);
    expect(launcher).toHaveBeenCalledOnce();
  });
  it('keeps bounded worker stderr when a terminal command fails', async () => {
    const launcher = launch(false);
    await inspectDetachedRetentionTrees(root, options, walk(launcher, 15));
    await finish({}, {}, 1);
    const state = (await readWalkState(slot))!;
    await fs.writeFile(walkAttemptFiles(slot, state.attempt).err, 'discarded-prefix' + 'x'.repeat(6000) + '\nworker diagnostic');
    const result = await inspectDetachedRetentionTrees(root, options, walk(launcher));
    expect(result.error).toContain('worker diagnostic'); expect(result.error).not.toContain('discarded-prefix');
    expect(result.error!.length).toBeLessThan(4200); expect(result.entries).toEqual([]);
  });
  it('refuses a non-initial or uncompacted-pin request', async () => {
    await expect(inspectDetachedRetentionTrees(root, { ...options, paths: [join(root, 'entry')] }, walk(launch()))).rejects.toThrow('unsupported');
  });
});
