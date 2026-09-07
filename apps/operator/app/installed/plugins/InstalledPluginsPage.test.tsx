/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({ confirm: vi.fn(async (_options: unknown) => true), syncRows: [] as unknown[] }));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: h.syncRows }),
}));
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => null }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => key === 'pot' ? 'pot' : key,
}));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, element: null }),
}));
vi.mock('../../_components/RouteLink', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import InstalledPluginsPage from './page';

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe('InstalledPluginsPage capability-provider uninstall', () => {
  it('renders the dependent warning flow, resubmits its exact token, and surfaces live typed outcomes', async () => {
    const review = {
      providerPackage: 'mail-pro',
      providerVersion: '2.1.0',
      bindings: [{ potSlug: 'sales-hive', classRef: 'crm.email@1.0.0' }],
      dependents: [{
        potSlug: 'sales-hive',
        identityRef: 'sales-agent@3.0.0',
        classRef: 'crm.email@1.0.0',
        optional: false,
      }],
      capabilityUnsatisfied: [{
        code: 'capability_unsatisfied',
        potSlug: 'sales-hive',
        classRef: 'crm.email@1.0.0',
        providerPackage: 'mail-pro',
        providerVersion: '2.1.0',
        requiredBy: ['sales-agent@3.0.0'],
        optionalFor: [],
        routes: ['operator-notify', 'suggest-provider', 'needs_human'],
        detail: 'Capability class crm.email@1.0.0 becomes unbound in sales-hive.',
      }],
      reviewToken: 'a'.repeat(64),
    };
    const uninstallBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/plugins/global') {
        return new Response(JSON.stringify({ plugins: [{
          name: 'mail-pro',
          version: '2.1.0',
          source: 'global',
          path: '/plugins/mail-pro',
        }] }), { status: 200 });
      }
      if (path === '/api/plugins/updates') return new Response(JSON.stringify({ updates: [] }), { status: 200 });
      if (path === '/api/plugins/host/runtime-status') return new Response(JSON.stringify({ rows: [] }), { status: 200 });
      if (path === '/api/plugins/uninstall') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        uninstallBodies.push(body);
        if (!body.capabilityReviewToken) {
          return new Response(JSON.stringify({
            ok: false,
            error: 'provider_has_capability_dependents',
            review,
          }), { status: 409 });
        }
        return new Response(JSON.stringify({
          ok: true,
          slug: 'mail-pro',
          review,
          capabilityUnsatisfied: review.capabilityUnsatisfied,
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<InstalledPluginsPage />);

    fireEvent.click(await screen.findByText('Uninstall'));

    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(2));
    expect(h.confirm.mock.calls[1]?.[0]).toMatchObject({
      title: 'mail-pro provides capabilities to 1 pot binding',
      confirmLabel: 'Unbind and remove',
      destructive: true,
    });
    await waitFor(() => expect(uninstallBodies).toEqual([
      { slug: 'mail-pro' },
      { slug: 'mail-pro', capabilityReviewToken: review.reviewToken },
    ]));
    const outcomes = await screen.findByTestId('plugin-uninstall-capability-outcomes');
    expect(outcomes.textContent).toContain('capability_unsatisfied');
    expect(outcomes.textContent).toContain('sales-hive');
    expect(outcomes.textContent).toContain('crm.email@1.0.0');
    expect(outcomes.textContent).toContain('operator notification');
    expect(outcomes.textContent).toContain('needs_human');
  });
});
