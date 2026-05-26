// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeatureDescriptionPanel } from '../FeatureDescriptionPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stub the vditor-backed editor/preview — neither runs cleanly under
// jsdom; we only care about state + PATCH behavior here.
vi.mock('../HarnessMarkdownView', () => ({
  HarnessMarkdownView: ({ value }: { value: string }) => (
    <div data-testid="harness-md-view">{value}</div>
  ),
}));
vi.mock('../../_components/MarkdownEditor', () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

describe('FeatureDescriptionPanel — load', () => {
  it('shows loading state before fetch resolves', () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    expect(screen.getByTestId('feature-description-loading')).toBeTruthy();
  });

  it('fetches GET /api/harness/:slug/features/:id', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ feature: { metadata: {} } }));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(String(fetchImpl.mock.calls[0][0])).toBe('/api/harness/sheets/features/F-1');
  });

  it('shows "No description yet" when metadata.description absent', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ feature: { metadata: {} } }));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('feature-description-empty')).toBeTruthy());
  });

  it('renders description via HarnessMarkdownView when present', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ feature: { metadata: { description: '# hi' } } }),
    );
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('harness-md-view')).toBeTruthy());
    expect(screen.getByTestId('harness-md-view').textContent).toBe('# hi');
  });

  it('falls back to empty on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('feature-description-error')).toBeTruthy());
  });
});

describe('FeatureDescriptionPanel — edit + save', () => {
  it('Edit button switches to editor', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ feature: { metadata: { description: 'orig' } } }),
    );
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('feature-description-edit'));
    expect(screen.queryByTestId('feature-description-editor')).toBeTruthy();
    expect(screen.queryByTestId('feature-description-save')).toBeTruthy();
    expect(screen.queryByTestId('feature-description-cancel')).toBeTruthy();
  });

  it('Edit affordance reads "Add description" when empty', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ feature: { metadata: {} } }),
    );
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    expect(screen.getByTestId('feature-description-edit').textContent).toBe('Add description');
  });

  it('Save disabled until value changes', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ feature: { metadata: { description: 'orig' } } }),
    );
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('feature-description-edit'));
    expect((screen.getByTestId('feature-description-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('PATCHes metadata.description on Save', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => jsonRes({ feature: { metadata: { foo: 'bar', description: 'orig' } } }))
      .mockImplementationOnce(async () => jsonRes({ ok: true }));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('feature-description-edit'));
    await act(async () => {
      fireEvent.change(screen.getByTestId('md-editor'), { target: { value: 'new body' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('feature-description-save'));
    });
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const [url, opts] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe('/api/harness/sheets/features/F-1');
    expect((opts as RequestInit).method).toBe('PATCH');
    const body = JSON.parse(String((opts as RequestInit).body));
    expect(body.metadata).toEqual({ foo: 'bar', description: 'new body' });
  });

  it('Cancel reverts edits + exits edit mode', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ feature: { metadata: { description: 'orig' } } }),
    );
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('feature-description-edit'));
    fireEvent.change(screen.getByTestId('md-editor'), { target: { value: 'temp' } });
    fireEvent.click(screen.getByTestId('feature-description-cancel'));
    expect(screen.queryByTestId('feature-description-editor')).toBeFalsy();
    expect(screen.getByTestId('harness-md-view').textContent).toBe('orig');
  });

  it('shows save error + stays in edit mode on PATCH 500', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => jsonRes({ feature: { metadata: { description: '' } } }))
      .mockImplementationOnce(async () => new Response('boom', { status: 500 }));
    render(
      <FeatureDescriptionPanel
        slug="sheets"
        featureId="F-1"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId('feature-description-edit')).toBeTruthy());
    fireEvent.click(screen.getByTestId('feature-description-edit'));
    await act(async () => {
      fireEvent.change(screen.getByTestId('md-editor'), { target: { value: 'x' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('feature-description-save'));
    });
    await waitFor(() => expect(screen.queryByTestId('feature-description-error')).toBeTruthy());
    expect(screen.getByTestId('feature-description-error').textContent).toMatch(/500/);
    // still in edit mode
    expect(screen.queryByTestId('feature-description-editor')).toBeTruthy();
  });
});
