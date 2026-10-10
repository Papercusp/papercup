// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { OperatorWorkspaceLocationProvider } from './seam';
import { captureBrowserTelemetry, PostHogProvider } from './browser-telemetry';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('browser telemetry host consent boundary', () => {
  it('makes no desktop consent request for hosted mount or explicit guide events', async () => {
    const consentFetch = vi.fn();
    vi.stubGlobal('fetch', consentFetch);
    render(<OperatorWorkspaceLocationProvider location="cloud">
      <PostHogProvider><p>Hosted guide</p></PostHogProvider>
    </OperatorWorkspaceLocationProvider>);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' }, 'cloud');
    expect(consentFetch).not.toHaveBeenCalled();
  });

  it('rechecks the existing desktop consent endpoint for local explicit events', async () => {
    const consentFetch = vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(consentFetch).toHaveBeenCalledWith('/api/desktop/telemetry-config', { cache: 'no-store' });
  });

  it('retains the local provider consent check', () => {
    const consentFetch = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<PostHogProvider><p>Desktop</p></PostHogProvider>);
    expect(consentFetch).toHaveBeenCalledTimes(1);
  });
});
