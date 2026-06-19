// @vitest-environment jsdom
/**
 * StepTelemetry.test.tsx — render-tier coverage for the SetupWizard "Telemetry"
 * consent step. The component seeds `choice` from /api/desktop/setup-wizard-state
 * then renders one of three branches (undecided / declined / opted-in); the
 * accept/decline/reconsider buttons PATCH and flip the branch, and the opted-in
 * diagnostics call telemetry-report + telemetry-flush. tauri-detect + the
 * operator-core tauri-bindings (commands.appVersion) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./tauri-detect', () => ({ isTauri: () => false }));
vi.mock('@papercusp/operator-core/lib/tauri-bindings', () => ({
  commands: { appVersion: vi.fn(async () => '0.0.1') },
}));

import { StepTelemetry } from './StepTelemetry';

/* fetch router. wizardState → GET setup-wizard-state. PATCHes + telemetry-report
 * + telemetry-flush are recorded; flush returns flushResult. */
let wizardState: Record<string, unknown>;
let flushResult: unknown;
let reportFails: boolean;
let patches: unknown[];
let reportCalls: number;
let flushCalls: number;
function installFetch() {
  patches = [];
  reportCalls = 0;
  flushCalls = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/desktop/telemetry-report')) {
      reportCalls += 1;
      if (reportFails) return new Response(JSON.stringify({ error: 'report boom' }), { status: 500 });
      return new Response('{"ok":true}', { status: 200 });
    }
    if (u.includes('/api/desktop/telemetry-flush')) {
      flushCalls += 1;
      return new Response(JSON.stringify(flushResult), { status: 200 });
    }
    if (u.includes('/api/desktop/setup-wizard-state')) {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify(wizardState), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  wizardState = {}; // no telemetry_enabled → stays "undecided"
  reportFails = false;
  flushResult = {
    archived: 1, forwarded: 1, forwardFailed: 0, retentionDeleted: 0,
    posthogConfigured: true, internalBuild: false, optedIn: true,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepTelemetry (SetupWizard telemetry consent step)', () => {
  it('renders the undecided consent branch by default (OFF status + opt-in/decline buttons)', async () => {
    installFetch();
    render(<StepTelemetry />);
    expect(await screen.findByText(/Telemetry is currently OFF\./i)).toBeTruthy();
    expect(screen.getByText('What gets sent')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Yes, opt in/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /No, keep it off/i })).toBeTruthy();
  });

  it('seeds the declined branch when GET returns telemetry_enabled:false', async () => {
    wizardState = { telemetry_enabled: false };
    installFetch();
    render(<StepTelemetry />);
    expect(await screen.findByText('Telemetry is off.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reconsider/i })).toBeTruthy();
  });

  it('seeds the opted-in branch when GET returns telemetry_enabled:true', async () => {
    wizardState = { telemetry_enabled: true };
    installFetch();
    render(<StepTelemetry />);
    expect(await screen.findByText('Telemetry is on.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('opting in PATCHes telemetry_enabled:true and flips to the opted-in branch', async () => {
    installFetch();
    render(<StepTelemetry />);
    fireEvent.click(await screen.findByRole('button', { name: /Yes, opt in/i }));
    await waitFor(() => expect(screen.getByText('Telemetry is on.')).toBeTruthy());
    expect(patches.some((p) => (p as { telemetry_enabled?: boolean }).telemetry_enabled === true)).toBe(true);
  });

  it('declining PATCHes telemetry_enabled:false and flips to the declined branch', async () => {
    installFetch();
    render(<StepTelemetry />);
    fireEvent.click(await screen.findByRole('button', { name: /No, keep it off/i }));
    await waitFor(() => expect(screen.getByText('Telemetry is off.')).toBeTruthy());
    expect(patches.some((p) => (p as { telemetry_enabled?: boolean }).telemetry_enabled === false)).toBe(true);
  });

  it('Reconsider from the declined branch returns to the undecided consent', async () => {
    wizardState = { telemetry_enabled: false };
    installFetch();
    render(<StepTelemetry />);
    fireEvent.click(await screen.findByRole('button', { name: /Reconsider/i }));
    expect(await screen.findByText(/Telemetry is currently OFF\./i)).toBeTruthy();
  });

  it('opted-in: "Send test report" POSTs a telemetry report and shows the recorded-at line', async () => {
    wizardState = { telemetry_enabled: true };
    installFetch();
    render(<StepTelemetry />);
    await screen.findByText('Telemetry is on.');
    // Open the collapsible diagnostics, then send a test report.
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send test report' }));
    await waitFor(() => expect(reportCalls).toBe(1));
    expect(await screen.findByText(/Test recorded at/i)).toBeTruthy();
  });

  it('opted-in: "Flush now" POSTs a flush and renders the flush stats', async () => {
    wizardState = { telemetry_enabled: true };
    installFetch();
    render(<StepTelemetry />);
    await screen.findByText('Telemetry is on.');
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Flush now' }));
    await waitFor(() => expect(flushCalls).toBe(1));
    expect(await screen.findByText('Flushed.')).toBeTruthy();
    expect(screen.getByText(/forwarded=1/)).toBeTruthy();
  });

  it('opted-in: a failing test report surfaces the error branch', async () => {
    wizardState = { telemetry_enabled: true };
    reportFails = true;
    installFetch();
    render(<StepTelemetry />);
    await screen.findByText('Telemetry is on.');
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send test report' }));
    expect(await screen.findByText('Failed.')).toBeTruthy();
    expect(screen.getByText(/report boom/i)).toBeTruthy();
  });
});
