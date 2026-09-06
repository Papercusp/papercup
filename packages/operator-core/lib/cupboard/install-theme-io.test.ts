import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fixtureRepo = '';
vi.mock('./install-io', () => ({
  gitCloneShallow: async (_url: string, dest: string) => fs.cp(fixtureRepo, dest, { recursive: true }),
}));

import { _resetPapercuspRootForTests } from '../papercusp-root';
import { installThemeFromCupboard, removeInstalledTheme } from './install-theme-io';

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
});
