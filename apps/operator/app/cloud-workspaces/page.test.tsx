// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as Error | null,
  loading: false,
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: H.rows,
    error: H.error,
    loading: H.loading,
    fetching: false,
    invalidate: H.invalidate,
  }),
  useSyncMutate: () => H.mutate,
}));

vi.mock('nuqs', async () => {
  const React = await import('react');
  const parser = (defaultValue: unknown = null) => ({
    defaultValue,
    withDefault(value: unknown) { return parser(value); },
  });
  return {
    parseAsString: parser(),
    parseAsStringEnum: () => parser(),
    useQueryState: (_key: string, config?: { defaultValue?: unknown }) => React.useState(config?.defaultValue ?? null),
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, options, ariaLabel }: { value: string; options: Array<{ value: string; label: unknown }>; ariaLabel: string }) => (
    <div role="combobox" aria-label={ariaLabel}>{String(options.find((option) => option.value === value)?.label ?? '')}</div>
  ),
}));

vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? <section role="dialog" aria-label={title}>{children}</section> : null,
}));

import CloudWorkspacesPage, { type CloudWorkspacesControlRow } from './page';

const rows: CloudWorkspacesControlRow[] = [
  {
    kind: 'connection',
    id: 'gcp-main',
    target: 'gcp',
    label: 'Production GCP',
    status: 'connected',
    credentialRef: 'env:GCP_APPLICATION_CREDENTIALS',
    lastValidatedAt: '2026-08-22T05:00:00.000Z',
    scopes: [{ id: 'papercusp-prod', label: 'papercusp-prod' }],
    regions: [{ id: 'us-central1', label: 'Iowa · us-central1' }],
    sizes: [{ id: 'e2-standard-4', label: 'e2-standard-4', vcpu: 4, memoryGiB: 16, hourlyUsd: 0.08 }],
    images: [{ id: 'ubuntu-2404', label: 'Ubuntu 24.04 LTS' }],
    networks: [{ id: 'default', label: 'default' }],
    diskPricePerGiBMonth: 0.145,
  },
  {
    kind: 'workspace',
    id: 'host-1',
    name: 'research-control',
    connectionId: 'gcp-main',
    target: 'gcp',
    scopeLabel: 'papercusp-prod',
    region: 'us-central1',
    size: 'e2-standard-4',
    image: 'ubuntu-2404',
    diskGiB: 100,
    network: 'default',
    estimatedMonthlyUsd: 72.9,
    desiredState: 'running',
    observedState: 'running',
    observedAt: '2026-08-22T05:10:00.000Z',
    providerResourceId: 'projects/papercusp-prod/zones/us-central1-a/instances/research-control',
    endpoint: 'ssh://10.0.0.8',
    recoverability: { kind: 'snapshot', label: 'snapshot-20260822', updatedAt: '2026-08-22T04:50:00.000Z' },
    capabilities: { start: false, stop: true, repair: true, snapshot: true, destroy: true },
    operation: {
      id: 'op-1',
      action: 'provision',
      status: 'succeeded',
      percent: 100,
      message: 'Host attested',
      events: [{ id: 'evt-1', ts: '2026-08-22T05:09:00.000Z', phase: 'attest', status: 'succeeded', message: 'Bootstrap healthy' }],
    },
  },
];

beforeEach(() => {
  H.rows = rows;
  H.error = null;
  H.loading = false;
  H.mutate.mockReset().mockResolvedValue({ ok: true });
  H.invalidate.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('CloudWorkspacesPage', () => {
  it('renders provider state, URL-backed provisioning selections, estimate, lifecycle, and progress', () => {
    render(<CloudWorkspacesPage />);

    expect(screen.getByRole('heading', { name: 'Cloud Workspaces' })).toBeTruthy();
    expect(screen.getByText('Production GCP')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Project, account, or subscription' }).textContent).toContain('papercusp-prod');
    expect(screen.getByLabelText('Estimated workspace cost').textContent).toContain('$72.90');
    expect(screen.getByLabelText('Desired running; observed running')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Progress for research-control' }).textContent).toContain('Bootstrap healthy');
    expect(screen.getByText(/Recoverability · snapshot/)).toBeTruthy();
  });

  it('routes connection and lifecycle actions through the sync mutation seam', async () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: 'validate-connection', connectionId: 'gcp-main' }));

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({ action: 'stop', workspaceId: 'host-1' }));
  });

  it('requires an explicit recoverability disposition before destroy', async () => {
    render(<CloudWorkspacesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }));
    expect(screen.getByRole('dialog', { name: 'Destroy research-control' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Create a snapshot first/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Discard recoverability/ }));

    const confirmButton = screen.getByRole('button', { name: 'Confirm destroy' });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type research-control to confirm discard'), { target: { value: 'research-control' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(H.mutate).toHaveBeenCalledWith({
      action: 'destroy',
      workspaceId: 'host-1',
      disposition: 'discard',
    }));
  });

  it('fails closed when the sync control-plane read is unavailable', () => {
    H.rows = [];
    H.error = new Error('workspaceHosts.control is not registered');
    render(<CloudWorkspacesPage />);

    expect(screen.getByRole('alert').textContent).toContain('Local cloud control plane unavailable');
    expect(screen.getByText('Connect a provider to begin')).toBeTruthy();
  });
});
