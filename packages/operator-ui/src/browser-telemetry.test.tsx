// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OperatorWorkspaceLocationProvider } from './seam';
import { captureBrowserTelemetry, CloudMonitoringPreferences, PostHogProvider } from './browser-telemetry';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '@papercusp/operator-core/lib/telemetry-kinds';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('browser telemetry host consent boundary', () => {
  it('observes a hosted return without a desktop consent probe or vendor SDK', async () => {
    const consentFetch = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<OperatorWorkspaceLocationProvider location="cloud">
      <PostHogProvider><p>Hosted guide</p></PostHogProvider>
    </OperatorWorkspaceLocationProvider>);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' }, 'cloud');
    expect(consentFetch).toHaveBeenCalledTimes(1);
    const [url, init] = consentFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/hosted/browser/monitoring/event');
    expect(JSON.parse(String(init.body))).toMatchObject({ event: 'cloud_portal_session', properties: { action: 'returned' } });
  });

  it('rechecks the existing desktop consent endpoint for local explicit events', async () => {
    const consentFetch = vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(consentFetch).toHaveBeenCalledWith('/api/desktop/telemetry-config', { cache: 'no-store' });
  });

  it('uses only authenticated explicit hosted metadata, without desktop consent or a vendor SDK', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', captureFetch);
    await captureBrowserTelemetry('cloud_portal_session', { action: 'returned' }, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
    const [path, options] = captureFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/hosted/browser/monitoring/event');
    expect(options.credentials).toBe('include');
    const body = JSON.parse(String(options.body));
    expect(body.properties).toEqual({ action: 'returned' });
    expect(body.operation_id).toMatch(/^[a-f0-9-]{36}$/);
    for (const [event, properties] of [
      ['cloud_portal_session', { action: 'returned', prompt: 'secret' }],
      ['cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'step_confirmed', step: 'task' }],
      ['cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'complete' }],
    ] as const) await captureBrowserTelemetry(event, properties, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
  });

  it('retains the local provider consent check', () => {
    const consentFetch = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<PostHogProvider><p>Desktop</p></PostHogProvider>);
    expect(consentFetch).toHaveBeenCalledTimes(1);
  });

  it('exports fixed public guide navigation but leaves saved reviews to the server witness', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 })); vi.stubGlobal('fetch', captureFetch);
    const properties = { lesson_id: 'product-guide', lesson_version: 3, action: 'lesson_displayed', lesson: 'welcome' };
    await captureBrowserTelemetry('product_tutorial', properties, 'cloud');
    await captureBrowserTelemetry('product_tutorial', { ...properties, action: 'explanation_reviewed' }, 'cloud');
    await captureBrowserTelemetry('product_tutorial', { ...properties, lesson: 'private-task-title' }, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((captureFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).properties).toEqual(properties);
  });

  it('discloses separate opt-in choices and saves a server-confirmed choice without local consent probes', async () => {
    const consentFetch = vi.fn(async (_url, options?: RequestInit) => new Response(JSON.stringify({ consent: options?.method === 'POST'
      ? { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2026-10-14T00:00:00Z' } }
      : DEFAULT_CLOUD_TELEMETRY_CONSENT }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    const analytics = screen.getByRole('checkbox', { name: 'Share portal analytics' }) as HTMLInputElement;
    const diagnostics = screen.getByRole('checkbox', { name: 'Allow aggregate diagnostic export' }) as HTMLInputElement;
    await waitFor(() => expect(analytics.disabled).toBe(false));
    expect(analytics.checked).toBe(false); expect(diagnostics.checked).toBe(false);
    fireEvent.click(analytics);
    await waitFor(() => expect(analytics.checked).toBe(true));
    expect(diagnostics.checked).toBe(false);
    const preferenceCalls = consentFetch.mock.calls.filter(([url]) => url === '/api/hosted/browser/monitoring');
    const options = preferenceCalls[1][1];
    expect(JSON.parse(String(options?.body))).toEqual({ disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, analytics: true });
    expect(screen.getByText(/no enforced event-deletion limit/)).toBeTruthy();
    const adoption = consentFetch.mock.calls.find(([url]) => url === '/api/hosted/browser/monitoring/event');
    expect(JSON.parse(String(adoption?.[1]?.body))).toMatchObject({ event: 'cloud_feature_adoption', properties: { feature: 'monitoring' } });
  });

  it('keeps failed preference reads unknown and never renders hosted choices locally', async () => {
    const consentFetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', consentFetch);
    const view = render(<CloudMonitoringPreferences />);
    expect(consentFetch).not.toHaveBeenCalled();
    view.rerender(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    await screen.findByRole('alert');
    expect((screen.getByRole('checkbox', { name: 'Share portal analytics' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('explains an administrator grant refusal and keeps the saved diagnostic choice disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options?: RequestInit) => options?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'diagnostic_export_admin_required' }), { status: 403 })
      : new Response(JSON.stringify({ consent: DEFAULT_CLOUD_TELEMETRY_CONSENT }), { status: 200 })));
    render(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    const diagnostics = screen.getByRole('checkbox', { name: 'Allow aggregate diagnostic export' }) as HTMLInputElement;
    await waitFor(() => expect(diagnostics.disabled).toBe(false));
    fireEvent.click(diagnostics);
    expect((await screen.findByRole('alert')).textContent).toContain('owner or administrator');
    expect(diagnostics.checked).toBe(false);
    expect(diagnostics.disabled).toBe(false);
  });
});
