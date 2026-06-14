import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drive the ancestor-walk deterministically; keep the rest of node:fs real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { existsSync } from 'node:fs';
import { resolvePapercuspCli, _resetPapercuspCliCache } from './papercusp-cli';

const REPO_REL_BIN = 'libs/papercusp/packages/cli/bin/papercusp';

beforeEach(() => {
  _resetPapercuspCliCache();
  vi.mocked(existsSync).mockReset();
  vi.mocked(existsSync).mockReturnValue(false);
  delete process.env.PAPERCUSP_CLI;
});

describe('resolvePapercuspCli', () => {
  it('returns the PAPERCUSP_CLI env override verbatim, without touching the fs', () => {
    process.env.PAPERCUSP_CLI = '/opt/desktop/bin/papercusp';
    expect(resolvePapercuspCli()).toBe('/opt/desktop/bin/papercusp');
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('walks up from cwd and returns the in-repo bin found at an ancestor', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith(REPO_REL_BIN));
    const got = resolvePapercuspCli();
    expect(got.endsWith(REPO_REL_BIN)).toBe(true);
    expect(existsSync).toHaveBeenCalled();
  });

  it('falls back to bare "papercusp" when no ancestor has the in-repo bin', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolvePapercuspCli()).toBe('papercusp');
  });

  it('memoizes the resolved path for the process lifetime', () => {
    process.env.PAPERCUSP_CLI = '/first/papercusp';
    expect(resolvePapercuspCli()).toBe('/first/papercusp');
    process.env.PAPERCUSP_CLI = '/second/papercusp';
    expect(resolvePapercuspCli()).toBe('/first/papercusp'); // cached — env change ignored
  });

  it('_resetPapercuspCliCache clears the memo so a new env is re-resolved', () => {
    process.env.PAPERCUSP_CLI = '/first/papercusp';
    expect(resolvePapercuspCli()).toBe('/first/papercusp');
    _resetPapercuspCliCache();
    process.env.PAPERCUSP_CLI = '/second/papercusp';
    expect(resolvePapercuspCli()).toBe('/second/papercusp');
  });
});
