/**
 * Coverage for resolvePluginCliSlug — translates a manifest name / dir basename
 * / @scope form into the global-plugins dir slug the CLI expects. Real temp
 * global-plugins tree under a mocked papercuspPath.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), 'pslug-')) };
});
vi.mock('./papercusp-root', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  papercuspPath: (...segs: string[]) => require('node:path').join(H.root, ...segs),
}));

import { resolvePluginCliSlug } from './plugin-slug';

const GP = () => join(H.root, 'global-plugins');
function writePlugin(rel: string, manifest?: unknown) {
  const dir = join(GP(), rel);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, 'papercusp.json'), JSON.stringify(manifest));
}

beforeEach(() => rmSync(GP(), { recursive: true, force: true }));
afterEach(() => rmSync(GP(), { recursive: true, force: true }));

describe('resolvePluginCliSlug', () => {
  it('returns empty input unchanged', async () => {
    expect(await resolvePluginCliSlug('')).toBe('');
  });

  it('returns the input verbatim when it is already a top-level dir', async () => {
    writePlugin('my-plugin', { name: 'whatever' });
    expect(await resolvePluginCliSlug('my-plugin')).toBe('my-plugin');
  });

  it('returns the input when the global-plugins dir does not exist', async () => {
    // GP() was rmSync'd in beforeEach and not recreated.
    expect(await resolvePluginCliSlug('anything')).toBe('anything');
  });

  it('resolves a manifest name to its top-level dir basename', async () => {
    writePlugin('dir-a', { name: 'cool-plugin' });
    expect(await resolvePluginCliSlug('cool-plugin')).toBe('dir-a');
  });

  it('resolves a manifest name inside an @scope/<name> subdir', async () => {
    writePlugin('@scope/inner', { name: 'scoped-tool' });
    expect(await resolvePluginCliSlug('scoped-tool')).toBe('@scope/inner');
  });

  it('resolves a bare basename of a scoped plugin to the scoped path', async () => {
    writePlugin('@org/widget', { name: 'something-else' });
    expect(await resolvePluginCliSlug('widget')).toBe('@org/widget');
  });

  it('falls back to the input when nothing matches', async () => {
    writePlugin('dir-a', { name: 'cool-plugin' });
    expect(await resolvePluginCliSlug('no-such-plugin')).toBe('no-such-plugin');
  });
});
