import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fixtureRepo = '';
let resolvedVersion = '1.0.0';
// importOriginal + spread, NOT a hand-listed factory. install-theme-io.ts imports
// `cupboardGitDeps` from this module, and a factory listing only the exports it
// happened to need makes every OTHER export `undefined` the moment the module under
// test reaches for one — while still typechecking, because a vi.mock factory is not
// checked against the real module. That is exactly what red-pinned the green gate
// here (WI-10001674): the installer moved from calling gitCloneShallow directly to
// cupboardGitDeps(), this mock was never updated, and every install threw
// "cupboardGitDeps is not a function" and surfaced only as an opaque status 500.
// Spreading `actual` means a newly-added export can never strand this file again.
vi.mock('./install-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install-io')>();
  const cloneRepo = async (_url: string, dest: string): Promise<void> => {
    await fs.cp(fixtureRepo, dest, { recursive: true });
  };
  return { ...actual, gitCloneShallow: cloneRepo, cupboardGitDeps: () => ({ ...actual.cupboardGitDeps(), cloneRepo }) };
});
vi.mock('./resolve-listing-by-kind', () => ({
  resolveListingByKind: async () => ({
    githubUrl: 'https://github.com/acme/themes',
    ref: 'aurora',
    listingId: 'listing-aurora',
    releaseVersion: resolvedVersion,
  }),
}));

import { _resetPapercuspRootForTests } from '../papercusp-root';
import { listCustomThemes, saveCustomTheme } from '../custom-themes';
import { installThemeFromCupboard, removeInstalledTheme } from './install-theme-io';
import { resolveInstalledTheme } from './theme-store';

let root = '';

async function writeTheme(version: string, bg: string): Promise<void> {
  const dir = join(fixtureRepo, 'aurora');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'theme.json'), JSON.stringify({
    schemaVersion: 1, id: 'aurora', label: 'Aurora', version,
    baseTheme: 'portal-light', colorScheme: 'light', tokens: { bg, fg: '#111111' },
  }));
  await fs.writeFile(join(dir, 'listing.json'), JSON.stringify({
    kind: 'theme', ref: 'aurora', title: 'Aurora', version,
    source: 'https://github.com/acme/themes',
  }));
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pc-install-theme-'));
  fixtureRepo = join(root, 'mirror');
  await fs.mkdir(fixtureRepo, { recursive: true });
  process.env.PAPERCUSP_HOME = join(root, 'home');
  _resetPapercuspRootForTests();
  resolvedVersion = '1.0.0';
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('theme install lifecycle', () => {
  it('installs, refuses an implicit overwrite, atomically updates, and removes', async () => {
    await writeTheme('1.0.0', '#ffffff');
    const first = await installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora',
    });
    expect(first).toMatchObject({ ok: true, result: { operation: 'install', version: '1.0.0' } });

    await expect(installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora',
    })).resolves.toMatchObject({ ok: false, status: 409 });

    await writeTheme('2.0.0', '#fafafa');
    const updated = await installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora', update: true,
    });
    expect(updated).toMatchObject({ ok: true, result: { operation: 'update', version: '2.0.0', tokens: { bg: '#fafafa' } } });
    if (!updated.ok) throw new Error('update failed');

    await expect(removeInstalledTheme(updated.result.id)).resolves.toMatchObject({
      ok: true, theme: { id: updated.result.id },
    });
    await expect(removeInstalledTheme(updated.result.id)).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it('treats the same served release as a no-op', async () => {
    await writeTheme('1.0.0', '#ffffff');
    const first = await installThemeFromCupboard({ listingId: 'listing-aurora' });
    const second = await installThemeFromCupboard({ listingId: 'listing-aurora' });

    expect(first).toMatchObject({ ok: true, result: { operation: 'install', version: '1.0.0' } });
    expect(second).toMatchObject({ ok: true, result: { operation: 'no-op', version: '1.0.0' } });
    if (!first.ok || !second.ok) throw new Error('install unexpectedly failed');
    expect(second.result.id).toBe(first.result.id);
  });

  it('keeps the prior valid package when an update fails validation', async () => {
    await writeTheme('1.0.0', '#ffffff');
    const first = await installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora',
    });
    if (!first.ok) throw new Error('initial install failed');

    await writeTheme('2.0.0', 'red; } html {');
    await expect(installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora', update: true,
    })).resolves.toMatchObject({ ok: false, status: 422 });

    expect(resolveInstalledTheme(first.result.id)).toMatchObject({
      version: '1.0.0',
      tokens: { bg: '#ffffff' },
    });
  });

  it('serializes concurrent explicit updates into a valid final package', async () => {
    await writeTheme('1.0.0', '#ffffff');
    const first = await installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora',
    });
    if (!first.ok) throw new Error('initial install failed');

    await writeTheme('2.0.0', '#fafafa');
    const updates = await Promise.all([
      installThemeFromCupboard({ githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora', update: true }),
      installThemeFromCupboard({ githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora', update: true }),
    ]);

    expect(updates.some((result) => result.ok)).toBe(true);
    expect(resolveInstalledTheme(first.result.id)).toMatchObject({
      version: '2.0.0',
      tokens: { bg: '#fafafa' },
    });
  });

  it('removes only package bytes and preserves an independent local theme', async () => {
    await saveCustomTheme({ id: 'local-copy', label: 'Local copy', tokens: { bg: '#222222' } });
    await writeTheme('1.0.0', '#ffffff');
    const installed = await installThemeFromCupboard({
      githubUrl: 'https://github.com/acme/themes', listingRef: 'aurora',
    });
    if (!installed.ok) throw new Error('install failed');

    await removeInstalledTheme(installed.result.id);

    expect(await listCustomThemes()).toEqual([
      { id: 'local-copy', label: 'Local copy', tokens: { bg: '#222222' } },
    ]);
    expect(resolveInstalledTheme(installed.result.id)).toBeNull();
  });
});
