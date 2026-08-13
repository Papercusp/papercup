// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GitStats } from '@papercusp/operator-core/lib/harness/git-stats';
import AdvStatsTab from './AdvStatsTab';

function fixture(overrides: Partial<GitStats> = {}): GitStats {
  return {
    measuredAt: new Date().toISOString(),
    cache: { hit: false, head: '1234567890abcdef', generatedAt: new Date().toISOString(), ttlMs: 300_000 },
    repository: {
      head: '1234567890abcdef', branch: 'staging', detached: false, shallow: false, clean: false,
      changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
      refs: { localBranches: 4, remoteBranches: 5, tags: 6 },
    },
    push: {
      upstream: 'origin/staging', remote: 'origin', remoteUrl: 'git@github.com:papercusp/papercusp.git',
      provider: 'github', ahead: 2, behind: 0, status: 'ahead',
    },
    history: {
      commits: 1_234, firstCommitAt: Date.UTC(2025, 0, 1), latestCommitAt: Date.UTC(2026, 7, 13),
      commitsLast7Days: 14, commitsLast30Days: 55, commitsLast90Days: 121,
    },
    contributors: {
      identities: 12,
      top: [
        { name: 'Ada Lovelace', email: 'ada@example.test', commits: 420 },
        { name: 'Grace Hopper', email: null, commits: 260 },
      ],
      truncated: false,
    },
    footprint: {
      trackedFiles: 2_345, trackedBytes: 12_582_912, gitObjectBytes: 33_554_432,
      submodules: { count: 1, entries: [{ path: 'libs/example', head: 'abc123' }], detailsTruncated: false },
    },
    composition: {
      total: { files: 2_300, bytes: 11_000_000, lines: 100_000, codeLines: 72_000, commentLines: 18_000, blankLines: 10_000 },
      production: { files: 1_900, bytes: 9_000_000, lines: 82_000, codeLines: 61_000, commentLines: 13_000, blankLines: 8_000 },
      testsAndFixtures: { files: 400, bytes: 2_000_000, lines: 18_000, codeLines: 11_000, commentLines: 5_000, blankLines: 2_000 },
      languages: [
        { language: 'TypeScript', files: 900, bytes: 7_000_000, analyzedFiles: 900, lines: 64_000, codeLines: 49_000, commentLines: 10_000, blankLines: 5_000, testFiles: 220, testLines: 12_000 },
        { language: 'Rust', files: 200, bytes: 2_000_000, analyzedFiles: 200, lines: 21_000, codeLines: 15_000, commentLines: 4_000, blankLines: 2_000, testFiles: 30, testLines: 3_000 },
      ],
    },
    coverage: {
      treeComplete: true, analyzedFiles: 2_300, analyzedBytes: 11_000_000, binaryFiles: 19,
      skippedLargeFiles: 2, unclassifiedFiles: 7, truncated: false, reasons: [],
      limits: { maxTreeOutputBytes: 64_000_000, maxAnalysisFiles: 25_000, maxAnalysisBytes: 64_000_000, maxSingleBlobBytes: 2_000_000 },
    },
    ...overrides,
  };
}

function response(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvStatsTab', () => {
  it('asks for a single pot and does not fetch in All Pots mode', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AdvStatsTab slug={null} allMode ready />);
    expect(screen.getByText(/Pick one pot/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the selected pot without browser caching and renders every statistics section', async () => {
    const stats = fixture({
      coverage: {
        ...fixture().coverage,
        treeComplete: false,
        truncated: true,
        reasons: ['analysis byte limit reached'],
      },
    });
    const fetchMock = vi.fn(async () => response({ stats }));
    vi.stubGlobal('fetch', fetchMock);

    render(<AdvStatsTab slug="papercusp" allMode={false} ready />);
    expect(screen.getByText(/Measuring papercusp/i)).toBeTruthy();
    await screen.findByRole('heading', { name: 'What the repository contains' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/harness/papercusp/git/stats');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText(/2 commits ready to push/i)).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Tests & fixtures')).toBeTruthy();
    expect(screen.getByText(/Partial repository coverage/i)).toBeTruthy();
    expect(screen.getByText(/Measured just now/i)).toBeTruthy();
  });

  it('keeps cached data visible during a forced refresh and reports revalidation failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ stats: fixture() }))
      .mockRejectedValueOnce(new Error('refresh exploded'));
    vi.stubGlobal('fetch', fetchMock);

    render(<AdvStatsTab slug="cached-pot" allMode={false} ready />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe('/api/harness/cached-pot/git/stats?refresh=1');
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(await screen.findByText(/Showing the last measurement/i)).toBeTruthy();
    expect(screen.getByText(/refresh exploded/i)).toBeTruthy();
  });

  it('renders explicit error and non-Git states', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: 'permission denied' }, false, 500))
      .mockResolvedValueOnce(response({ stats: null, notAGitRepo: true }));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<AdvStatsTab slug="broken-pot" allMode={false} ready />);
    expect(await screen.findByText(/Could not load Git statistics/i)).toBeTruthy();
    expect(screen.getByText('permission denied')).toBeTruthy();

    view.rerender(<AdvStatsTab slug="plain-folder" allMode={false} ready />);
    expect(await screen.findByText(/is not a Git repository/i)).toBeTruthy();
  });

  it('aborts the old pot request when the scope changes', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<AdvStatsTab slug="pot-a" allMode={false} ready />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstSignal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal as AbortSignal;

    view.rerender(<AdvStatsTab slug="pot-b" allMode={false} ready />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
  });
});
