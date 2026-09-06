import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishThemeToCupboard, type PublishThemeDeps } from './publish-theme-core';
import { writeThemePackageDir } from './theme-store';

function deps(root: string): PublishThemeDeps {
  return {
    listThemes: async () => [{ id: 'aurora', label: 'Aurora', tokens: { bg: '#fff', fg: '#111' } }],
    writePackage: (theme, opts) => writeThemePackageDir(theme, { ...opts, targetDir: root }),
    fetchRepo: vi.fn(async () => ({ id: 24, html_url: 'https://github.com/acme/themes' })),
    publish: vi.fn(async (input) => ({
      ok: true as const,
      status: 201,
      data: { id: 'listing-24', ...input },
    })),
  };
}

describe('publishThemeToCupboard', () => {
  it('exports theme.json/listing.json then publishes the theme kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-publish-theme-'));
    try {
      const collaborators = deps(root);
      const result = await publishThemeToCupboard({
        themeId: 'aurora', github_url: 'https://github.com/acme/themes',
        version: '1.0.0', baseTheme: 'portal-light', description: 'Cool and bright',
      }, collaborators);
      expect(result).toMatchObject({ ok: true, exportedOnly: false, export: { ref: 'aurora' } });
      expect(collaborators.publish).toHaveBeenCalledWith(expect.objectContaining({
        listing_kind: 'theme', listing_ref: 'aurora', title: 'Aurora',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unknown local theme and supports export-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-publish-theme-'));
    try {
      const collaborators = deps(root);
      await expect(publishThemeToCupboard({
        themeId: 'missing', github_url: 'https://github.com/acme/themes',
      }, collaborators)).resolves.toMatchObject({ ok: false, status: 404 });
      await expect(publishThemeToCupboard({
        themeId: 'aurora', github_url: 'https://github.com/acme/themes', exportOnly: true,
      }, collaborators)).resolves.toMatchObject({ ok: true, exportedOnly: true });
      expect(collaborators.publish).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
