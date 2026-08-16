/**
 * EI-20584279536840151 — a corestore store directory relocated with its metadata
 * intact keeps its `device-file` xattr but changes inode, so `device-file`'s
 * open guard fails forever with "Invalid device file, was modified".
 *
 * The interesting property is not "the recorded inode ends up correct" — almost
 * any implementation achieves that. It is that the heal must be an IN-PLACE
 * rewrite: the inode it records has to be the inode the file still has after the
 * write. The obvious implementation (render to a temp file, rename over) records
 * a value that its own write immediately invalidates, and re-bricks the store.
 * `naivelyHealByRename` below is that implementation, kept permanently as a
 * control so this file proves it can tell the two apart.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEVICE_FILE_NAME, healRelocatedDeviceFile } from './device-file-heal';

/** The exact on-disk shape corestore 7.x writes (verified on the macOS rig). */
function renderDeviceFile(fields: {
  platform?: string;
  inode: number | string;
  created: number;
  attribute?: string;
}): string {
  return (
    `device/platform=${fields.platform ?? process.platform}\n` +
    `device/inode=${fields.inode}\n` +
    `device/created=${fields.created}\n` +
    `device/attribute=${fields.attribute ?? 'original'}\n`
  );
}

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i !== -1) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function makeStore(seed: { inode?: number | string; created?: number; platform?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'device-file-heal-'));
  const storeDir = join(dir, 'hyperbee');
  await mkdir(storeDir, { recursive: true });
  const path = join(storeDir, DEVICE_FILE_NAME);
  // Write first, then seed the recorded inode relative to the REAL one so the
  // fixture reproduces the rig exactly rather than asserting an arbitrary number.
  await writeFile(path, 'placeholder\n', 'utf8');
  const realInode = Number((await stat(path)).ino);
  const recorded = seed.inode ?? realInode + 1_000_000; // "relocated": wrong on purpose
  await writeFile(
    path,
    renderDeviceFile({
      inode: recorded,
      created: seed.created ?? Date.now(),
      platform: seed.platform,
    }),
    'utf8',
  );
  return { storeDir, path, realInode: Number((await stat(path)).ino) };
}

/**
 * CONTROL — the plausible-but-wrong implementation. Renders the corrected file
 * elsewhere and renames it into place, which allocates a NEW inode, so the value
 * it just recorded is stale the moment it lands. Never used by production code.
 */
async function naivelyHealByRename(storeDir: string): Promise<void> {
  const path = join(storeDir, DEVICE_FILE_NAME);
  const fields = parse(await readFile(path, 'utf8'));
  const actual = Number((await stat(path)).ino);
  const tmp = `${path}.tmp`;
  await writeFile(
    tmp,
    renderDeviceFile({ platform: fields['device/platform'], inode: actual, created: Date.now() }),
    'utf8',
  );
  await rename(tmp, path);
}

/** The guard `device-file` actually applies, restated so the test asserts the REAL property. */
async function passesDeviceFileGuard(path: string): Promise<boolean> {
  const fields = parse(await readFile(path, 'utf8'));
  const st = await stat(path);
  const recorded = Number(fields['device/inode']);
  const created = Number(fields['device/created']);
  const modified = Math.max(st.mtime.getTime(), st.birthtime.getTime());
  if (Number(st.ino) !== recorded) return false;
  if (created && Math.abs(modified - created) >= 5000) return false;
  return true;
}

describe('healRelocatedDeviceFile', () => {
  it('heals a relocated device file so the real guard passes', async () => {
    const { storeDir, path, realInode } = await makeStore({});
    expect(await passesDeviceFileGuard(path)).toBe(false); // calibration: fixture IS broken

    const outcome = await healRelocatedDeviceFile(storeDir);

    expect(outcome).toMatchObject({ action: 'healed', toInode: realInode });
    expect(await passesDeviceFileGuard(path)).toBe(true);
  });

  it('rewrites IN PLACE — the healed file keeps its inode', async () => {
    const { storeDir, path, realInode } = await makeStore({});
    await healRelocatedDeviceFile(storeDir);
    expect(Number((await stat(path)).ino)).toBe(realInode);
  });

  it('CONTROL: the rename-based heal records an inode its own write invalidates', async () => {
    const { storeDir, path } = await makeStore({});
    await naivelyHealByRename(storeDir);
    // Same surface intent, opposite outcome — this is what makes the two tests
    // above meaningful rather than vacuously true.
    expect(await passesDeviceFileGuard(path)).toBe(false);
  });

  it('re-stamps device/created, because the heal write moves mtime to now', async () => {
    // A stale `created` is the second half of the guard; healing only the inode
    // trades one failure for the other.
    const { storeDir, path } = await makeStore({ created: Date.now() - 90 * 24 * 3600 * 1000 });
    await healRelocatedDeviceFile(storeDir);

    const fields = parse(await readFile(path, 'utf8'));
    const st = await stat(path);
    expect(Math.abs(st.mtime.getTime() - Number(fields['device/created']))).toBeLessThan(5000);
    expect(await passesDeviceFileGuard(path)).toBe(true);
  });

  it('preserves device/attribute and device/platform verbatim', async () => {
    const { storeDir, path } = await makeStore({});
    await healRelocatedDeviceFile(storeDir);
    const fields = parse(await readFile(path, 'utf8'));
    expect(fields['device/attribute']).toBe('original');
    expect(fields['device/platform']).toBe(process.platform);
  });

  it('leaves a healthy device file untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'device-file-heal-ok-'));
    const storeDir = join(dir, 'hyperbee');
    await mkdir(storeDir, { recursive: true });
    const path = join(storeDir, DEVICE_FILE_NAME);
    await writeFile(path, 'placeholder\n', 'utf8');
    const realInode = Number((await stat(path)).ino);
    await writeFile(path, renderDeviceFile({ inode: realInode, created: Date.now() }), 'utf8');
    const before = await readFile(path, 'utf8');

    expect(await healRelocatedDeviceFile(storeDir)).toEqual({ action: 'ok', inode: realInode });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('reports absent for a fresh store with no device file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'device-file-heal-absent-'));
    await mkdir(join(dir, 'hyperbee'), { recursive: true });
    expect(await healRelocatedDeviceFile(join(dir, 'hyperbee'))).toEqual({ action: 'absent' });
  });

  it('refuses a cross-platform copy so its own error still surfaces', async () => {
    const other = process.platform === 'linux' ? 'darwin' : 'linux';
    const { storeDir, path } = await makeStore({ platform: other });
    const before = await readFile(path, 'utf8');

    const outcome = await healRelocatedDeviceFile(storeDir);

    expect(outcome.action).toBe('skipped');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
