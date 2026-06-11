// @vitest-environment jsdom
//
// TestingClient render coverage — the /admin/testing tabbed test-domain UI.
// TestingClient is a thin wrapper over the shared <TestingShell>
// (@papercusp/testing-shell): it supplies the admin tab inventory, the
// three-tier labels (Quick runs / Domains / Surfaces), the
// adminTestingDataSource, and the bespoke custom panels. These tests render
// the REAL TestingShell + DomainTestPanel (nuqs + fetch mocked, the pinned
// sibling pattern — see admin/GitClient.test.tsx and
// adv/AdvConversationsTab.test.tsx) and assert:
//   - the three-tier rail renders the full admin tab inventory,
//   - the universal panels are re-tiered into the Quick runs group,
//   - desktop-tagged tabs show because the shell runs as platform "both",
//   - the default tab renders its bespoke panel without hitting the API,
//   - rail clicks route through the nuqs `tab` setter (URL state),
//   - registry-driven domain tabs render via <DomainTestPanel> against the
//     /api/admin/testing/* wire shapes (loading / data / error states),
//   - per-file history + run actions wire to the URL params and run endpoint.
// The bespoke operator tab components (TestRunsTab etc.) are stubbed — they
// pull desktop-only deps and have their own surfaces; this file covers the
// wiring TestingClient owns.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// nuqs: every useQueryState call needs the adapter context — stub each param
// to [value, recorded setter]. TestingShell reads `tab`; DomainTestPanel reads
// `runFile`, `historyFile`, `k6cat`.
const nuqsState: Record<string, unknown> = { tab: 'test-runs', runFile: null, historyFile: null, k6cat: 'all' };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn();
    return [nuqsState[key] ?? null, nuqsSetters[key]];
  },
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

// The bespoke operator panels (TestRunsTab, LiveMetricsTab, …) drag in
// desktop-only deps — stub the shared id→panel map with inert markers. The
// UNIVERSAL_TESTING_TABS metadata mirrors the real shape (TestingClient
// re-tiers these into the "quick" group itself).
vi.mock('@/app/admin/testing/testing-custom-tabs', () => {
  const stub = (text: string) => () => <div>{text}</div>;
  return {
    UNIVERSAL_TESTING_TABS: [
      { id: 'live-web', label: 'Live (web)', hint: 'in-page observer' },
      { id: 'chaos-web', label: 'Chaos (web)', hint: 'random clicker (browser)' },
    ],
    TESTING_CUSTOM_TABS: {
      'live-web': stub('LiveWebPanelStub'),
      'chaos-web': stub('ChaosWebPanelStub'),
      'test-runs': stub('TestRunsPanelStub'),
      vitals: stub('VitalsPanelStub'),
      memory: stub('MemoryPanelStub'),
      routes: stub('RoutesPanelStub'),
      packaged: stub('PackagedPanelStub'),
    },
  };
});

import TestingClient from './TestingClient';

// ── /api/admin/testing wire fixtures (shapes from @papercusp/testing-shell
//    data-source.ts: DomainDetail / FileStatusResponse / HealthStripData) ──

const ENGINES_FILE = 'apps/operator/lib/voice/engines.test.ts';
const PERSONA_FILE = 'apps/operator/lib/voice/persona.test.ts';

const VOICE_DOMAIN = {
  id: 'voice',
  label: 'Voice',
  description: 'Voice cards, engines, persona coverage.',
  tier: 'domain',
  totalFiles: 2,
  sections: [
    {
      id: 'engines',
      label: 'Engines',
      description: 'TTS/STT engine wiring',
      files: [
        { path: ENGINES_FILE, sizeBytes: 2048, mtimeMs: Date.now() - 60_000 },
        { path: PERSONA_FILE, sizeBytes: 4096, mtimeMs: Date.now() - 60_000 },
      ],
      runners: [{ kind: 'shell', cmd: 'npm', args: ['run', 'voice:smoke'], label: 'voice smoke' }],
    },
  ],
};

const VOICE_STATUSES = {
  domainId: 'voice',
  branch: 'staging',
  commit: 'abc123',
  statuses: {
    [ENGINES_FILE]: { status: 'pass', durationMs: 1500, finishedAt: new Date().toISOString(), source: 'ci', branch: 'staging', stale: false },
    [PERSONA_FILE]: { status: 'fail', durationMs: 900, finishedAt: new Date().toISOString(), source: 'local', branch: 'staging', stale: true },
  },
};

const VOICE_HEALTH = {
  domainId: 'voice',
  branch: 'staging',
  lastSuiteDurationMs: 4200,
  lastFailureFinishedAt: new Date(Date.now() - 3_600_000).toISOString(),
  flakyFileCount: 1,
  totalFilesTracked: 2,
};

/**
 * Stub fetch to answer the admin testing REST surface by URL fragment
 * (first matching key wins — keep more-specific fragments first).
 */
function stubTestingApi(byUrl: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const match = Object.keys(byUrl).find((frag) => url.includes(frag));
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => byUrl[match] };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const VOICE_API = {
  '/api/admin/testing/domains/voice': VOICE_DOMAIN,
  '/api/admin/testing/file-status?domainId=voice': VOICE_STATUSES,
  '/api/admin/testing/health-strip?domainId=voice': VOICE_HEALTH,
};

function railGroup(container: HTMLElement, tier: string): HTMLElement {
  const el = container.querySelector(`.pc-test-tab-group[data-tier="${tier}"]`);
  if (!el) throw new Error(`no rail group for tier "${tier}"`);
  return el as HTMLElement;
}

beforeEach(() => {
  nuqsState.tab = 'test-runs';
  nuqsState.runFile = null;
  nuqsState.historyFile = null;
  nuqsState.k6cat = 'all';
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TestingClient — rail + tab inventory', () => {
  it('renders the three-tier rail with the full admin tab inventory', () => {
    const { container } = render(<TestingClient />);

    expect(screen.getByRole('heading', { level: 2, name: 'Testing' })).toBeTruthy();

    const quick = railGroup(container, 'quick');
    const domain = railGroup(container, 'domain');
    const surface = railGroup(container, 'surface');

    expect(within(quick).getByText('Quick runs')).toBeTruthy();
    expect(within(domain).getByText('Domains')).toBeTruthy();
    expect(within(surface).getByText('Surfaces')).toBeTruthy();

    // test-runs / vitals / memory / 2 universal stubs / packaged
    expect(within(quick).getAllByRole('button')).toHaveLength(6);
    // harness…llm (13 registry domains)
    expect(within(domain).getAllByRole('button')).toHaveLength(13);
    // routes / transport / docs
    expect(within(surface).getAllByRole('button')).toHaveLength(3);

    for (const label of ['Test Runs', 'Memory', 'Packaged build']) {
      expect(within(quick).getByText(label)).toBeTruthy();
    }
    for (const label of ['Harness', 'Voice', 'Papercusp-SU', 'LLM']) {
      expect(within(domain).getByText(label)).toBeTruthy();
    }
    for (const label of ['Routes', 'Transport', 'Docs']) {
      expect(within(surface).getByText(label)).toBeTruthy();
    }
  });

  it('re-tiers the universal panels into the Quick runs group', () => {
    const { container } = render(<TestingClient />);
    const quick = railGroup(container, 'quick');
    expect(within(quick).getByText('Live (web)')).toBeTruthy();
    expect(within(quick).getByText('Chaos (web)')).toBeTruthy();
  });

  it('shows desktop-tagged tabs because the shell runs as platform "both"', () => {
    render(<TestingClient />);
    expect(screen.getByText('Live metrics')).toBeTruthy();
    expect(screen.getByText('passive observer (desktop)')).toBeTruthy();
  });

  it('marks the active rail tab with aria-current', () => {
    render(<TestingClient />);
    const active = screen.getByRole('button', { name: /^Test Runs/ });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.className).toContain('is-active');
    const inactive = screen.getByRole('button', { name: /^Voice/ });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('routes rail clicks through the nuqs tab setter', () => {
    render(<TestingClient />);
    fireEvent.click(screen.getByRole('button', { name: /^Voice/ }));
    expect(nuqsSetters['tab']).toHaveBeenCalledWith('voice');
    fireEvent.click(screen.getByRole('button', { name: /^Docs/ }));
    expect(nuqsSetters['tab']).toHaveBeenCalledWith('docs');
  });
});

describe('TestingClient — panel selection', () => {
  it('renders the bespoke Test Runs panel for the default tab without hitting the domain API', () => {
    render(<TestingClient />);
    expect(screen.getByText('TestRunsPanelStub')).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('renders a universal custom panel in place of the domain panel', () => {
    nuqsState.tab = 'live-web';
    render(<TestingClient />);
    expect(screen.getByText('LiveWebPanelStub')).toBeTruthy();
    expect(screen.queryByText('TestRunsPanelStub')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('TestingClient — registry domain tabs (DomainTestPanel)', () => {
  it('shows the loading state while the domain fetch is in flight', () => {
    nuqsState.tab = 'voice';
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never resolves */ })));
    render(<TestingClient />);
    expect(screen.getByText('Loading voice…')).toBeTruthy();
  });

  it('renders domain detail, file statuses, runners, and the health strip', async () => {
    nuqsState.tab = 'voice';
    stubTestingApi(VOICE_API);
    render(<TestingClient />);

    // Header: label + file count + run-all + description.
    expect(await screen.findByRole('heading', { level: 2, name: 'Voice' })).toBeTruthy();
    expect(screen.getByText('2 files')).toBeTruthy();
    expect(screen.getByText('▶ Run all')).toBeTruthy();
    expect(screen.getByText('Voice cards, engines, persona coverage.')).toBeTruthy();

    // Section + files + the non-k6 runner row.
    expect(screen.getByText('Engines')).toBeTruthy();
    expect(screen.getByText('2 files, 1 runner')).toBeTruthy();
    expect(screen.getByText(ENGINES_FILE)).toBeTruthy();
    expect(screen.getByText(PERSONA_FILE)).toBeTruthy();
    expect(screen.getByText('⚙ voice smoke')).toBeTruthy();

    // Status chips: pass ✓, stale fail ✗.
    expect(screen.getByText('✓').className).toContain('pc-dtp-chip-pass');
    const failChip = screen.getByText('✗');
    expect(failChip.className).toContain('pc-dtp-chip-fail');
    expect(failChip.className).toContain('is-stale');

    // Health strip pills.
    expect(screen.getByText('4.2s')).toBeTruthy(); // last suite duration
    expect(screen.getByText('2/2')).toBeTruthy(); // tracked / total
    expect(screen.getByText('flaky:')).toBeTruthy();
    expect(screen.getByText('last fail:')).toBeTruthy();
  });

  it('opens per-file run history through the URL-backed historyFile param', async () => {
    nuqsState.tab = 'voice';
    stubTestingApi(VOICE_API);
    render(<TestingClient />);

    fireEvent.click(await screen.findByText('✓'));
    expect(nuqsSetters['historyFile']).toHaveBeenCalledWith(ENGINES_FILE);
  });

  it('starts a vitest run for a file through the admin run endpoint', async () => {
    nuqsState.tab = 'voice';
    const fetchMock = stubTestingApi({
      // more-specific poll fragment first: /run/<id> also contains /run
      '/api/admin/testing/run/': { status: 'pass', exitCode: 0, output: 'ok', finishedAt: Date.now() },
      '/api/admin/testing/run': { runId: 'r-1' },
      ...VOICE_API,
    });
    render(<TestingClient />);

    const runButtons = await screen.findAllByTitle('Run via vitest');
    fireEvent.click(runButtons[0]);

    // The drawer-open state is URL-backed (?runFile=<path>).
    expect(nuqsSetters['runFile']).toHaveBeenCalledWith(ENGINES_FILE);

    // POST /api/admin/testing/run with the vitest runner descriptor.
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === '/api/admin/testing/run' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        runner: { kind: 'vitest', filePath: ENGINES_FILE },
      });
    });

    // The run polls to completion (finishedAt set) and re-enables the button,
    // refetching statuses on the way out.
    await waitFor(() => {
      expect(screen.getAllByTitle('Run via vitest')[0].textContent).toBe('▶');
    });
    await waitFor(() => {
      const statusCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/file-status'));
      expect(statusCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('surfaces a domain fetch failure as the panel error state', async () => {
    nuqsState.tab = 'voice';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<TestingClient />);

    expect(await screen.findByText('Could not load voice')).toBeTruthy();
    expect(screen.getByText('HTTP 500')).toBeTruthy();
  });
});
