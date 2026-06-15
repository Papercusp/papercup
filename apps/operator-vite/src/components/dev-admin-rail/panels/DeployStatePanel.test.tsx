// @vitest-environment jsdom
/**
 * DeployStatePanel.test — the dev-admin-rail "Deploy / release gate" glance
 * (P-006, D-004). Reads `dev.deployState` (snapshot → data[0]).
 *
 * Covers: empty / error / loading via PanelState; the deployedBehindMain headline
 * branch (===0 → is-up + "current with" + "matches main"; >0 → is-absent +
 * "N commits behind" + "NOT-YET-DEPLOYED"); behindPill(readyBehindMain) and the
 * deployedBehindReady pill (null/0/N); the shortSha vs "—"/"— unset" KV fallbacks;
 * and the errors[] strip. Refresh invalidates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | undefined; loading: boolean; fetching: boolean; error: Error | null; invalidate: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));

import DeployStatePanel from './DeployStatePanel';

const commit = (shortSha: string) => ({ sha: `${shortSha}full`, shortSha, committedAtMs: Date.now() - 60_000, subject: 's' });

function state(over: Record<string, unknown> = {}) {
  return {
    integrationBranch: 'main',
    releaseRef: 'release/green',
    releaseRoot: '/x',
    mainHead: commit('aaa1111'),
    ready: commit('bbb2222'),
    deployed: commit('ccc3333'),
    deployedAtMs: Date.now() - 120_000,
    deployedBehindMain: 0,
    readyBehindMain: 0,
    deployedBehindReady: 0,
    readyAtMainHead: true,
    errors: [] as string[],
    ...over,
  };
}

function seed(over: Partial<(typeof H.results)[string]> = {}) {
  H.results['dev.deployState'] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results['dev.deployState'];
}

beforeEach(() => {
  H.results = {};
});
afterEach(() => cleanup());

describe('<DeployStatePanel>', () => {
  it('shows the empty hint when there is no deploy state', () => {
    seed({ data: [] });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('No deploy state.')).toBeTruthy();
  });

  it('surfaces an error', () => {
    seed({ data: undefined, error: new Error('git failed') });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('Failed to load: git failed')).toBeTruthy();
  });

  it('shows the loading placeholder while loading with no snapshot', () => {
    seed({ data: undefined, loading: true });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('deployedBehindMain===0 → is-up dot, "current with", "matches main"', () => {
    seed({ data: [state({ deployedBehindMain: 0 })] });
    const { container } = render(<DeployStatePanel active={true} />);
    expect(container.querySelector('.pcdar-dot.is-up')).toBeTruthy();
    expect(screen.getByText(':3070 is current with main')).toBeTruthy();
    expect(screen.getByText('the live host matches main')).toBeTruthy();
  });

  it('deployedBehindMain>0 → is-absent dot, "N commits behind", NOT-YET-DEPLOYED', () => {
    seed({ data: [state({ deployedBehindMain: 4 })] });
    const { container } = render(<DeployStatePanel active={true} />);
    expect(container.querySelector('.pcdar-dot.is-absent')).toBeTruthy();
    expect(screen.getByText(':3070 is 4 commits behind main')).toBeTruthy();
    expect(screen.getByText('a missing edit here is NOT-YET-DEPLOYED, not reverted')).toBeTruthy();
  });

  it('behindPill: readyBehindMain===0 → "caught up" is-good', () => {
    seed({ data: [state({ readyBehindMain: 0 })] });
    render(<DeployStatePanel active={true} />);
    const pill = screen.getByText('caught up');
    expect(pill.className).toContain('is-good');
  });

  it('behindPill: readyBehindMain===N → "N behind" is-warn', () => {
    seed({ data: [state({ readyBehindMain: 3 })] });
    render(<DeployStatePanel active={true} />);
    const pill = screen.getByText('3 behind');
    expect(pill.className).toContain('is-warn');
  });

  it('behindPill: readyBehindMain===null → "—"', () => {
    seed({ data: [state({ readyBehindMain: null, deployedBehindReady: 1 })] });
    render(<DeployStatePanel active={true} />);
    // The em-dash pill is the readyBehindMain one (deployedBehindReady is "1").
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('deployedBehindReady: 0 → "none" is-good; N → N is-warn', () => {
    seed({ data: [state({ deployedBehindReady: 0 })] });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('none').className).toContain('is-good');
    cleanup();
    seed({ data: [state({ deployedBehindReady: 5 })] });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('5').className).toContain('is-warn');
  });

  it('renders short SHAs and "— unset" for a missing ready pin', () => {
    seed({ data: [state({ ready: null, deployed: commit('ccc3333'), mainHead: commit('aaa1111') })] });
    render(<DeployStatePanel active={true} />);
    expect(screen.getByText('ccc3333')).toBeTruthy();
    expect(screen.getByText('aaa1111')).toBeTruthy();
    expect(screen.getByText('— unset')).toBeTruthy();
  });

  it('renders "—" for a missing deployed commit', () => {
    seed({ data: [state({ deployed: null })] });
    render(<DeployStatePanel active={true} />);
    // deployed shortSha cell falls back to "—"
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders the joined errors strip when errors are present', () => {
    seed({ data: [state({ errors: ['no upstream', 'detached HEAD'] })] });
    const { container } = render(<DeployStatePanel active={true} />);
    expect(container.querySelector('.pcdar-panel__error')!.textContent).toBe('no upstream · detached HEAD');
  });

  it('refresh invalidates the query', () => {
    const r = seed({ data: [state()] });
    render(<DeployStatePanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Deploy / release gate' }));
    expect(r.invalidate).toHaveBeenCalled();
  });
});
