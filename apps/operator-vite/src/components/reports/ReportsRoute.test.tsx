// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const fixture = vi.hoisted(() => ({ enabled: true, queries: [] as { queryName: string; args: Record<string, unknown>; enabled?: boolean }[],
  list: [] as Record<string, unknown>[], detail: [] as Record<string, unknown>[], history: [] as Record<string, unknown>[], error: null as Error | null }));
vi.mock('@papercusp/flags/client', () => ({ useFlag: () => fixture.enabled }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (opts: { queryName: string; args: Record<string, unknown>; enabled?: boolean }) => {
  fixture.queries.push(opts);
  return { data: opts.queryName === 'reports.list' ? fixture.list
    : opts.queryName === 'reports.get' ? fixture.detail : fixture.history, loading: false,
    error: fixture.error, invalidate: vi.fn() };
} }));
vi.mock('@/app/_components/MarkdownEditor', () => ({ MarkdownPreview: ({ value }: { value: string }) => <div data-testid="markdown-preview">{value}</div> }));
import ReportsRoute from './ReportsRoute';
import { reportFullFixture as report, reportSummaryFixture } from './reports-test-fixture';

beforeEach(() => { fixture.enabled = true; fixture.queries = []; fixture.list = []; fixture.detail = []; fixture.history = []; fixture.error = null; });
afterEach(cleanup);
const mount = (searchParams = '', onUrlUpdate = vi.fn()) => {
  render(<NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}><ReportsRoute /></NuqsTestingAdapter>);
  return onUrlUpdate;
};

describe('Reports route', () => {
  it('gates the UI and all sync subscriptions when disabled', () => {
    fixture.enabled = false;
    mount('?sel=edition-2');
    expect(screen.getByText('Reports library is disabled.')).toBeTruthy();
    expect(fixture.queries).toEqual([]);
  });
  it('restores every filter and an exact report pin from a deep link', () => {
    fixture.detail = [report];
    mount('?kind=audit&subject=plan%3Aexample-plan&pot=pot-a&vis=owner&q=findings&tag=operations&since=2026-10-01&sel=edition-2&hist=true');
    expect(fixture.queries.find(q => q.queryName === 'reports.list')?.args).toEqual({ kind: 'audit',
      subject: { kind: 'plan', ref: 'example-plan' }, originHarnessSlug: 'pot-a', visibility: 'owner', query: 'findings',
      tags: ['operations'], since: '2026-10-01T00:00:00.000Z', limit: 200 });
    expect(fixture.queries.find(q => q.queryName === 'reports.get')?.args).toEqual({ reportId: 'edition-2' });
    expect(fixture.queries.find(q => q.queryName === 'reports.lineage')?.enabled).toBe(true);
    expect(screen.getByTestId('markdown-preview').textContent).toBe(report.body_md);
    expect(screen.getByText('writer')).toBeTruthy();
  });
  it('renders every contract field in the report metadata strip, including kind', () => {
    fixture.detail = [report];
    mount('?sel=edition-2');
    const metadata = screen.getByRole('article').querySelector('.reports-metadata');
    expect(metadata).not.toBeNull();
    const fields = Object.fromEntries(Array.from(metadata!.querySelectorAll('div'), row => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ] as const));
    expect(fields).toMatchObject({
      Kind: report.kind,
      Subject: report.subject.label,
      'Written by': report.origin.author_owner_id,
      Pot: report.origin.harness_slug || 'Workspace',
      Visibility: report.visibility,
      Published: expect.any(String),
      Source: report.source,
      'Report ID': report.report_id,
    });
    expect(fields.Published).toBeTruthy();
  });
  it('writes selection to the URL and preserves filters', async () => {
    fixture.list = [reportSummaryFixture];
    const update = mount('?q=findings');
    fireEvent.click(screen.getByRole('button', { name: /Private audit/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const params = update.mock.calls.at(-1)![0].searchParams as URLSearchParams;
    expect(params.get('sel')).toBe('edition-2');
    expect(params.get('q')).toBe('findings');
  });
  it('hides a cached reader snapshot when the selection is cleared', () => {
    fixture.detail = [report];
    fixture.history = [reportSummaryFixture];
    mount('?q=findings&hist=true');
    expect(screen.getByText('Select a report to read it.')).toBeTruthy();
    expect(screen.queryByTestId('markdown-preview')).toBeNull();
    expect(screen.queryByRole('heading', { name: report.title })).toBeNull();
    expect(fixture.queries.find(q => q.queryName === 'reports.get')?.enabled).toBe(false);
    expect(fixture.queries.find(q => q.queryName === 'reports.lineage')?.enabled).toBe(false);
  });
  it('hides the previous cached edition while a different exact citation loads', async () => {
    fixture.detail = [report];
    const update = mount('?sel=edition-2&q=findings');
    expect(screen.getByTestId('markdown-preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('markdown-preview')).toBeNull());
    expect(fixture.queries.filter(q => q.queryName === 'reports.get').at(-1)?.args).toEqual({ reportId: 'edition-1' });
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('q')).toBe('findings');
  });
  it('copies complete Markdown with Mermaid fences and navigates to the previous edition', async () => {
    fixture.detail = [report];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const update = mount('?sel=edition-2');
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`# ${report.title}\n\n${report.body_md}`));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect((update.mock.calls.at(-1)![0].searchParams as URLSearchParams).get('sel')).toBe('edition-1');
  });
  it('shows an actionable query failure and a clear empty library', () => {
    mount();
    expect(screen.getByText('No reports match these filters.')).toBeTruthy();
    cleanup(); fixture.error = new Error('Connection unavailable'); mount();
    expect(screen.getAllByRole('alert')[0].textContent).toContain('Connection unavailable');
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
});
