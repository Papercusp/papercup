// @vitest-environment jsdom
//
// ProjectsList — the per-harness project list. The progress-percent and spec-KB
// cell math (`projectProgressPct`, `specSizeKb`) is extracted + tested; a
// render-smoke drives the loading / empty / populated surfaces with a mocked
// /projects fetch. RichGrid is stubbed to a marker (virtualization is e2e), and
// the router is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/router-compat/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: { name: string }[] }) => (
    <div data-testid="projects-grid">{rows.map((r) => r.name).join(',')}</div>
  ),
}));

import ProjectsList, { projectProgressPct, specSizeKb } from './ProjectsList';

afterEach(cleanup);

describe('projectProgressPct', () => {
  it('rounds passed/total to a percent', () => {
    expect(projectProgressPct({ passed: 1, total: 3 })).toBe(33);
    expect(projectProgressPct({ passed: 3, total: 4 })).toBe(75);
  });
  it('returns 0 (not NaN) when there are no features', () => {
    expect(projectProgressPct({ passed: 0, total: 0 })).toBe(0);
  });
  it('returns 100 when everything passed', () => {
    expect(projectProgressPct({ passed: 5, total: 5 })).toBe(100);
  });
});

describe('specSizeKb', () => {
  it('renders chars as one-decimal KB', () => {
    expect(specSizeKb('a'.repeat(1234))).toBe(1.2);
    // 250 chars → round(2.5)/10 = 0.3KB (one-decimal granularity).
    expect(specSizeKb('a'.repeat(250))).toBe(0.3);
  });
  it('is 0 for an empty spec', () => {
    expect(specSizeKb('')).toBe(0);
  });
});

const COUNTS = { todo: 0, in_progress: 0, validating: 0, failing: 0, blocked: 0, passed: 2, rejected: 0, total: 4 };

describe('<ProjectsList />', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state before the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<ProjectsList slug="h" />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('renders the empty state when the harness has no projects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects: [] }) }) as unknown as Response));
    render(<ProjectsList slug="h" />);
    await waitFor(() => expect(screen.getByText(/no projects yet for harness/i)).toBeTruthy());
  });

  it('surfaces an error banner when the API responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) as unknown as Response));
    render(<ProjectsList slug="h" />);
    await waitFor(() => expect(screen.getByText(/failed to load: boom/i)).toBeTruthy());
  });

  it('renders the project grid when projects come back', async () => {
    const projects = [
      { id: 'P-1', name: 'Alpha', status: 'active', budget_cents: null, spent_cents: 0, spec: null, spec_updated_at: null, spec_manually_edited_at: null, feature_counts: COUNTS },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projects }) }) as unknown as Response));
    render(<ProjectsList slug="h" />);
    await waitFor(() => expect(screen.getByTestId('projects-grid').textContent).toBe('Alpha'));
  });
});
