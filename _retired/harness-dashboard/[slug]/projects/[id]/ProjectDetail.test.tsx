// @vitest-environment jsdom
/**
 * ProjectDetail.test.tsx — render-tier coverage for the per-project detail
 * page (Roadmap / History / Spec tabs).
 *
 * Mocked seams:
 *  - `@papercusp/sync` → useSyncQuery feeds the spec-revision list (the
 *    History/Spec revisions browser);
 *  - `@papercusp/grid-core` → RichGrid stubbed to a marker list (the feature
 *    tables); `@papercusp/ui-primitives` → MarkdownView stubbed (spec body);
 *  - the heavy `MarkdownEditor` (vditor) and `useConfirmDialog` stubbed;
 *  - `fetch` stubbed per-URL for loadProject (/projects/:id) + loadFeatures
 *    (/status) + saveEdit (/spec PUT).
 *
 * Link: ProjectDetail.tsx imports `Link` from '@/lib/router-compat/link'
 * (this session fixed a latent `Link is not defined` bug — the source used
 * <Link> without importing it); we mock that module to a plain anchor.
 *
 * Branches covered: error banner, loading state, the three tabs + their
 * empty/populated feature tables, the spec view/edit toggle, the save-error
 * surface, and the revisions browser (toggle + rows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[]; loading: boolean };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, error: null, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows }: { rows: { id: string; title: string }[] }) => (
    <div data-testid="feature-grid">{rows.map((r) => r.id).join(',')}</div>
  ),
}));
vi.mock('@papercusp/ui-primitives', () => ({
  MarkdownView: ({ source }: { source: string }) => <div data-testid="md-view">{source}</div>,
}));
// Heavy vditor-backed editor — stub to a textarea so edit-mode is observable.
vi.mock('../../../../_components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="md-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('../../../useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), element: null }),
}));
// Router-compat Link (now imported by the source) → a plain anchor.
vi.mock('@/lib/router-compat/link', () => ({
  default: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import ProjectDetail from './ProjectDetail';

function renderDetail(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

const COUNTS = {
  todo: 1, in_progress: 1, validating: 0, failing: 0, blocked: 0,
  passed: 2, rejected: 0, total: 4,
};

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: 'PRJ-1', name: 'Alpha Project', status: 'active', spec: '# Spec body\n\nhello',
    spec_updated_at: null, spec_manually_edited_at: null,
    feature_counts: COUNTS, last_spec_revision: null,
    ...over,
  };
}

/** Feature rows the /status endpoint returns; project_id steers the
 *  client-side filter, status steers the roadmap/history split. */
function feature(over: Record<string, unknown> = {}) {
  return { id: 'F-1', title: 'feat one', status: 'todo', attempts: 0, project_id: 'PRJ-1', ...over };
}

/** Install a per-URL fetch stub. project = /projects/:id ; status = /status. */
function stubFetch({ project, features = [], specOk = true }: {
  project?: Record<string, unknown> | null;
  features?: Record<string, unknown>[];
  specOk?: boolean;
}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return specOk
        ? ({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)
        : ({ ok: false, status: 500, json: async () => ({ error: 'save boom' }) } as unknown as Response);
    }
    if (url.includes('/status')) {
      return { ok: true, json: async () => ({ features }) } as unknown as Response;
    }
    // /projects/:id
    if (project === null) {
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response;
    }
    if (project === undefined) {
      // never resolve → loading state
      return new Promise(() => {}) as unknown as Response;
    }
    return { ok: true, json: async () => project } as unknown as Response;
  }));
}

beforeEach(() => {
  syncResult = { data: [], loading: false };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectDetail (Roadmap / History / Spec)', () => {
  it('shows the loading state until the project resolves', () => {
    stubFetch({ project: undefined });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    expect(screen.getByText(/loading project/i)).toBeTruthy();
  });

  it('surfaces the error banner when /projects responds non-OK', async () => {
    stubFetch({ project: null });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
  });

  it('renders the project header (id, name, status, feature counts) when loaded', async () => {
    stubFetch({ project: projectRow() });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeTruthy());
    expect(screen.getByText('PRJ-1')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText(/4 features · 2 passed/)).toBeTruthy();
  });

  it('renders the last-spec-revision curated line when present', async () => {
    stubFetch({ project: projectRow({ last_spec_revision: { id: 3, summary: 'curated', author_role: 'curator', ts: '2026-06-01T12:00:00Z' } }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByText(/spec last curated/i)).toBeTruthy());
    expect(screen.getByText('curator')).toBeTruthy();
  });

  /* ── Roadmap tab (default) ─────────────────────────────────────────── */

  it('roadmap tab: empty state when no in-flight features', async () => {
    stubFetch({ project: projectRow(), features: [] });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeTruthy());
    expect(screen.getByText(/No work in flight for this project/i)).toBeTruthy();
  });

  it('roadmap tab: renders the feature grid with in-flight features', async () => {
    stubFetch({ project: projectRow(), features: [feature({ id: 'F-9', status: 'in_progress' })] });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByTestId('feature-grid')).toBeTruthy());
    expect(screen.getByTestId('feature-grid').textContent).toBe('F-9');
  });

  it('filters out features that belong to a different project', async () => {
    stubFetch({
      project: projectRow(),
      features: [feature({ id: 'F-MINE', status: 'todo' }), feature({ id: 'F-OTHER', status: 'todo', project_id: 'PRJ-OTHER' })],
    });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    await waitFor(() => expect(screen.getByTestId('feature-grid').textContent).toBe('F-MINE'));
  });

  /* ── History tab ───────────────────────────────────────────────────── */

  it('history tab: switching shows the history features (passed/rejected)', async () => {
    stubFetch({
      project: projectRow(),
      features: [feature({ id: 'F-DONE', status: 'passed' }), feature({ id: 'F-WIP', status: 'in_progress' })],
    });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=history');
    await waitFor(() => expect(screen.getByTestId('feature-grid').textContent).toBe('F-DONE'));
  });

  it('history tab: empty state when no completed work', async () => {
    stubFetch({ project: projectRow(), features: [feature({ id: 'F-WIP', status: 'todo' })] });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=history');
    await waitFor(() => expect(screen.getByText(/No completed work yet/i)).toBeTruthy());
  });

  it('clicking the History tab button switches tabs from roadmap', async () => {
    stubFetch({
      project: projectRow(),
      features: [feature({ id: 'F-DONE', status: 'passed' }), feature({ id: 'F-WIP', status: 'in_progress' })],
    });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />);
    // Start on roadmap → in_progress feature visible.
    await waitFor(() => expect(screen.getByTestId('feature-grid').textContent).toBe('F-WIP'));
    fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await waitFor(() => expect(screen.getByTestId('feature-grid').textContent).toBe('F-DONE'));
  });

  /* ── Spec tab ──────────────────────────────────────────────────────── */

  it('spec tab: renders the markdown spec body when present', async () => {
    stubFetch({ project: projectRow({ spec: '# Hello spec' }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec');
    await waitFor(() => expect(screen.getByTestId('md-view')).toBeTruthy());
    expect(screen.getByTestId('md-view').textContent).toBe('# Hello spec');
  });

  it('spec tab: empty spec shows the "run Project Manager" placeholder', async () => {
    stubFetch({ project: projectRow({ spec: null }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec');
    await waitFor(() => expect(screen.getByText(/No spec yet/i)).toBeTruthy());
  });

  it('spec tab: Edit toggles into the markdown editor, Cancel returns to the viewer', async () => {
    stubFetch({ project: projectRow({ spec: '# editable' }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec');
    await waitFor(() => expect(screen.getByTestId('md-view')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    expect(screen.getByTestId('md-editor')).toBeTruthy();
    expect((screen.getByTestId('md-editor') as HTMLTextAreaElement).value).toBe('# editable');
    // Viewer is gone in edit mode.
    expect(screen.queryByTestId('md-view')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByTestId('md-editor')).toBeNull();
    expect(screen.getByTestId('md-view')).toBeTruthy();
  });

  it('spec tab: a failed save surfaces the error banner', async () => {
    stubFetch({ project: projectRow({ spec: '# x' }), specOk: false });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec');
    await waitFor(() => expect(screen.getByTestId('md-view')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save manual edit/i }));
    await waitFor(() => expect(screen.getByText(/Save failed: save boom/i)).toBeTruthy());
  });

  it('spec tab: Show revisions toggles the revisions browser', async () => {
    syncResult = {
      data: [
        { id: 5, summary: 'first rev', authorRole: 'curator', author: null, ts: 1_700_000_000_000, includeDecisions: null, tokensIn: 0, tokensOut: 0, costUsdCents: 0 },
      ],
      loading: false,
    };
    stubFetch({ project: projectRow({ spec: '# x' }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec');
    await waitFor(() => expect(screen.getByTestId('md-view')).toBeTruthy());

    // Collapsed: the revision summary is not shown.
    expect(screen.queryByText('first rev')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show revisions/i }));
    // Expanded: the revision row (summary + author role) appears.
    expect(screen.getByText('first rev')).toBeTruthy();
    expect(screen.getByText('r5')).toBeTruthy();
  });

  it('spec tab: revisions browser shows the empty hint when there are none', async () => {
    syncResult = { data: [], loading: false };
    stubFetch({ project: projectRow({ spec: '# x' }) });
    renderDetail(<ProjectDetail slug="h" projectId="PRJ-1" />, '?projectTab=spec&revisions=true');
    await waitFor(() => expect(screen.getByText(/No revisions yet/i)).toBeTruthy());
  });
});
