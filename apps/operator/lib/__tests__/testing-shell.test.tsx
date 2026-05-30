/**
 * @vitest-environment jsdom
 *
 * <TestingShell> — P-005 of harness-tests-tab-and-tester-promotion-2026-05-26.
 *
 * The shell was extracted from the admin TestingClient in P-003; these
 * tests pin the behavior the harness Tests tab (Phase C) will depend on:
 *
 *  - tabsFromRegistry: TestDomain[] → nav tabs round-trip (hint = description).
 *  - tier grouping with arbitrary tier ids (Built-in / Project), in
 *    tierLabels key order, with correct counts.
 *  - dataSource injection: a non-custom tab mounts <DomainTestPanel>
 *    wired to the injected dataSource (fetches by domainId; renders the
 *    file-status chip the dataSource reports).
 *  - customTabs override: a listed tab renders its bespoke component and
 *    does NOT hit the dataSource.
 *
 * Lives under apps/operator/lib/__tests__ (alongside the existing
 * testing-domains registry tests) because @papercusp/testing-shell has no
 * vitest runner of its own; the operator's jsdom config provides
 * Testing Library + the nuqs testing adapter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import {
  TestingShell,
  tabsFromRegistry,
  type TestingDataSource,
  type TestDomain,
  type DomainDetail,
  type FileStatusEntry,
} from '@papercusp/testing-shell';

afterEach(() => cleanup());

function mockDataSource(over: Partial<TestingDataSource> = {}): TestingDataSource {
  return {
    fetchDomain: vi.fn(
      async (id: string): Promise<DomainDetail> => ({
        id,
        label: id,
        description: '',
        tier: 'domain',
        sections: [],
        totalFiles: 0,
      }),
    ),
    fetchStatuses: vi.fn(async () => ({})),
    fetchHealth: vi.fn(async () => null),
    startRun: vi.fn(async () => ({ runId: 'r1' })),
    pollRun: vi.fn(async () => null),
    fetchHistory: vi.fn(async () => []),
    ...over,
  };
}

const renderOpts = () => ({ wrapper: withNuqsTestingAdapter({ searchParams: '' }) });

describe('tabsFromRegistry', () => {
  it('maps id/label/tier and uses description as the nav hint', () => {
    const domains: TestDomain[] = [
      { id: 'alpha', label: 'Alpha', description: 'first domain', tier: 'quick', sections: [] },
      { id: 'beta', label: 'Beta', description: 'second domain', tier: 'domain', sections: [] },
    ];
    expect(tabsFromRegistry(domains)).toEqual([
      { id: 'alpha', label: 'Alpha', hint: 'first domain', tier: 'quick' },
      { id: 'beta', label: 'Beta', hint: 'second domain', tier: 'domain' },
    ]);
  });
});

describe('tier grouping (arbitrary tier ids)', () => {
  it('renders tiers in tierLabels key order with per-tier counts', () => {
    // Default tab is a custom tab so no <DomainTestPanel> mounts here.
    render(
      <TestingShell
        tabs={[
          { id: 'lint', label: 'Lint', hint: 'eslint', tier: 'built-in' },
          { id: 'types', label: 'Types', hint: 'tsc', tier: 'built-in' },
          { id: 'acceptance', label: 'Acceptance', hint: 'VALs', tier: 'project' },
        ]}
        tierLabels={{ 'built-in': 'Built-in', project: 'Project' }}
        dataSource={mockDataSource()}
        customTabs={{ lint: () => <div>noop</div> }}
        defaultTabId="lint"
      />,
      renderOpts(),
    );

    const labels = Array.from(document.querySelectorAll('.pc-test-tier-label > span:first-child')).map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(['Built-in', 'Project']); // key order, not alphabetical

    const counts = Array.from(document.querySelectorAll('.pc-test-tier-count')).map((n) => n.textContent);
    expect(counts).toEqual(['2', '1']);

    // Both tabs in a tier render their label + hint.
    screen.getByText('Acceptance');
    screen.getByText('VALs');
  });
});

describe('dataSource injection', () => {
  it('mounts DomainTestPanel for a non-custom tab and renders the reported chip', async () => {
    const detail: DomainDetail = {
      id: 'alpha',
      label: 'Alpha',
      description: 'a domain',
      tier: 'domain',
      sections: [
        {
          id: 'all',
          label: 'All',
          files: [{ path: 'apps/x/a.test.ts', sizeBytes: 10, mtimeMs: 1 }],
          runners: [],
        },
      ],
      totalFiles: 1,
    };
    const statuses: Record<string, FileStatusEntry> = {
      'apps/x/a.test.ts': {
        status: 'pass',
        durationMs: 12,
        finishedAt: '2026-05-30T00:00:00Z',
        source: 'ci',
        branch: 'main',
        stale: false,
      },
    };
    const ds = mockDataSource({
      fetchDomain: vi.fn(async () => detail),
      fetchStatuses: vi.fn(async () => statuses),
    });

    render(
      <TestingShell
        tabs={[{ id: 'alpha', label: 'Alpha', hint: 'a domain', tier: 'domain' }]}
        tierLabels={{ domain: 'Domains' }}
        dataSource={ds}
        defaultTabId="alpha"
      />,
      renderOpts(),
    );

    // Injection: the shell wired the dataSource into DomainTestPanel,
    // which fetched the active domain by id.
    await waitFor(() => expect(ds.fetchDomain).toHaveBeenCalledWith('alpha'));
    // …and the file-status chip the dataSource reported is rendered.
    await waitFor(() => expect(document.querySelector('.pc-dtp-chip-pass')).not.toBeNull());
  });
});

describe('customTabs override', () => {
  it('renders the bespoke component and never touches the dataSource', async () => {
    const ds = mockDataSource();
    render(
      <TestingShell
        tabs={[{ id: 'chaos', label: 'Chaos', hint: 'clicker', tier: 'quick' }]}
        tierLabels={{ quick: 'Quick runs' }}
        dataSource={ds}
        customTabs={{ chaos: () => <div>BESPOKE-CHAOS</div> }}
        defaultTabId="chaos"
      />,
      renderOpts(),
    );

    screen.getByText('BESPOKE-CHAOS');
    // Give any (incorrect) effect a tick to fire, then assert no fetch.
    await Promise.resolve();
    expect(ds.fetchDomain).not.toHaveBeenCalled();
  });
});
