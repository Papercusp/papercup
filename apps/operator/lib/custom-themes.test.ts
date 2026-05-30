/**
 * File-persistence tests for lib/custom-themes.ts. Drives a real temp dir via the
 * PAPERCUSP_HOME escape hatch (see lib/papercusp-root.ts) — no PG, no Docker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPapercuspRootForTests } from './papercusp-root';
import { listCustomThemes, saveCustomTheme, deleteCustomTheme } from './custom-themes';

let home: string;
// listCustomThemes() warns on hand-edited bad data; silence it (the repo's
// vitest-fail-on-console setup fails on unexpected console output) and assert
// it fired where relevant.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pc-themes-'));
  process.env.PAPERCUSP_HOME = home;
  _resetPapercuspRootForTests();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  delete process.env.PAPERCUSP_HOME;
  _resetPapercuspRootForTests();
  rmSync(home, { recursive: true, force: true });
});

const themesFile = () => join(home, 'themes', 'custom.json');

describe('custom-themes persistence', () => {
  it('returns [] when no file exists yet', async () => {
    expect(await listCustomThemes()).toEqual([]);
  });

  it('save → list round-trips and creates themes/custom.json', async () => {
    const saved = await saveCustomTheme({ label: 'Midnight', tokens: { bg: '#000000', accent: '#88aaff' } });
    expect(saved.id).toBe('midnight');
    expect(existsSync(themesFile())).toBe(true);

    const list = await listCustomThemes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'midnight', label: 'Midnight' });
    expect(list[0].tokens.bg).toBe('#000000');

    // On-disk shape is { themes: [...] }
    const onDisk = JSON.parse(readFileSync(themesFile(), 'utf8'));
    expect(Array.isArray(onDisk.themes)).toBe(true);
    expect(onDisk.themes).toHaveLength(1);
  });

  it('upserts by id (second save with same id replaces)', async () => {
    await saveCustomTheme({ id: 'm', label: 'M', tokens: { bg: '#000000' } });
    await saveCustomTheme({ id: 'm', label: 'M v2', tokens: { bg: '#111111' } });
    const list = await listCustomThemes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'm', label: 'M v2' });
    expect(list[0].tokens.bg).toBe('#111111');
  });

  it('keeps distinct themes and deletes by id', async () => {
    await saveCustomTheme({ id: 'a', label: 'A', tokens: { bg: '#000000' } });
    await saveCustomTheme({ id: 'b', label: 'B', tokens: { bg: '#111111' } });
    expect((await listCustomThemes()).map((t) => t.id)).toEqual(['a', 'b']);

    await deleteCustomTheme('a');
    expect((await listCustomThemes()).map((t) => t.id)).toEqual(['b']);

    // Deleting a missing id is a no-op (no throw).
    await expect(deleteCustomTheme('does-not-exist')).resolves.toBeUndefined();
    expect((await listCustomThemes()).map((t) => t.id)).toEqual(['b']);
  });

  it('rejects a theme that violates the token contract (save validates)', async () => {
    await expect(
      saveCustomTheme({ label: 'Bad', tokens: { 'sky-400': '#000000' } }),
    ).rejects.toThrow();
    // nothing persisted
    expect(await listCustomThemes()).toEqual([]);
  });

  it('drops invalid rows on read instead of corrupting the whole list', async () => {
    await saveCustomTheme({ id: 'ok', label: 'OK', tokens: { bg: '#000000' } });
    // Hand-edit the file to inject an invalid row (file is user-editable).
    const data = JSON.parse(readFileSync(themesFile(), 'utf8'));
    data.themes.push({ id: 'bad', label: 'Bad', tokens: { 'not-a-real-token': '#000000' } });
    data.themes.push({ id: 'unsafe', label: 'Unsafe', tokens: { bg: 'red; } html{}' } });
    writeFileSync(themesFile(), JSON.stringify(data));

    const list = await listCustomThemes();
    expect(list.map((t) => t.id)).toEqual(['ok']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('treats malformed JSON as empty rather than throwing', async () => {
    await saveCustomTheme({ id: 'ok', label: 'OK', tokens: { bg: '#000000' } });
    writeFileSync(themesFile(), '{ this is not json');
    expect(await listCustomThemes()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
