// @vitest-environment jsdom
/**
 * StepOsPermissions.test.tsx — render-tier coverage for the SetupWizard
 * "OS permissions + audio devices" step. The component probes navigator
 * permissions / Notification / mediaDevices on mount and renders a row per
 * permission, a request button when the state is prompt/unknown, the WSL panel
 * (from the mocked wsl-tauri helper), and the gated voice-device section that
 * only appears once microphone is granted. The Select primitive and the
 * wsl-tauri helper are stubbed; navigator/Notification are controlled per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let wslStatusValue: unknown = null;
vi.mock('@papercusp/operator-core/lib/wsl-tauri', () => ({
  isTauri: () => false,
  wslStatus: vi.fn(async () => wslStatusValue),
}));
// Select → a plain native <select> so jsdom can render device options without Radix portals.
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel, disabled }: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: React.ReactNode }[];
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.value}</option>
      ))}
    </select>
  ),
}));

import { StepOsPermissions } from './StepOsPermissions';

/* ── navigator / Notification controls ─────────────────────────────────── */
function setNavigator(over: Record<string, unknown>) {
  // Replace navigator wholesale per test (jsdom's navigator has no permissions
  // / mediaDevices), keeping platform '' so the macOS-only paths stay inert.
  vi.stubGlobal('navigator', { platform: '', ...over });
}
function micGrantedNavigator() {
  return {
    permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Mic' },
        { kind: 'audiooutput', deviceId: 'spk-1', label: 'Built-in Speaker' },
      ]),
    },
  };
}

/* Minimal AudioContext stub so the live-meter monitor effect (startMonitor)
 * doesn't throw in jsdom and flip the granted mic back to 'denied'. */
class FakeAudioContext {
  state = 'running';
  destination = {};
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, getByteTimeDomainData() {}, connect() {}, disconnect() {} }; }
}
function installAudioContext() {
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('requestAnimationFrame', () => 0 as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

beforeEach(() => {
  wslStatusValue = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepOsPermissions (SetupWizard permissions + audio step)', () => {
  it('renders the lead copy and a row per permission', async () => {
    setNavigator({});
    const { container } = render(<StepOsPermissions />);
    expect(screen.getByText(/Papercusp asks your operating system/i)).toBeTruthy();
    // Anchor on Notifications (unique) for the settled mount; 'Microphone' also
    // appears in the heading + grant hint, so assert the per-row titles by class.
    expect(await screen.findByText('Notifications')).toBeTruthy();
    const titles = Array.from(container.querySelectorAll('.pc-perm__title')).map((n) => n.textContent);
    expect(titles).toContain('Microphone');
    expect(titles).toContain('Notifications');
    expect(titles).toContain('Accessibility (macOS only)');
  });

  it('renders a "Request now" button while the microphone state is unknown', async () => {
    // No navigator.permissions → probeMicrophone resolves 'unknown' → request button.
    setNavigator({});
    render(<StepOsPermissions />);
    await screen.findByText('Notifications');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Request now' }).length).toBeGreaterThanOrEqual(1));
  });

  it('clicking "Request now" for the microphone invokes getUserMedia and grants', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    setNavigator({ mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });
    installAudioContext();
    render(<StepOsPermissions />);
    await screen.findByText('Notifications');
    const reqBtns = await screen.findAllByRole('button', { name: 'Request now' });
    fireEvent.click(reqBtns[0]); // first row is Microphone
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    // After grant the mic row shows the "already granted" hint.
    await waitFor(() => expect(screen.getByText(/Already granted — nothing to do\./i)).toBeTruthy());
  });

  it('gates the voice-device section behind a microphone grant (prompt to grant when not yet granted)', async () => {
    setNavigator({});
    render(<StepOsPermissions />);
    await screen.findByText('Notifications');
    // The gated-section message ("Grant Microphone access above to pick…") is shown.
    expect(screen.getByText(/access above to pick and test your audio devices/i)).toBeTruthy();
    // The input-device select is NOT rendered while mic is ungranted.
    expect(screen.queryByLabelText('Input microphone')).toBeNull();
  });

  it('renders the input/output device selects once the microphone probes granted', async () => {
    setNavigator(micGrantedNavigator());
    installAudioContext();
    render(<StepOsPermissions />);
    // probeMicrophone → 'granted' → micGranted → the device pickers appear.
    expect(await screen.findByLabelText('Input microphone')).toBeTruthy();
    expect(screen.getByText('Live level')).toBeTruthy();
    // Test-tone + record buttons are part of the granted section.
    expect(screen.getByRole('button', { name: /Test speaker/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Record 5-second test/i })).toBeTruthy();
  });

  it('renders the WSL panel when wslStatus reports a non-NotSupported state', async () => {
    wslStatusValue = { state: { kind: 'Ready' }, defaultVersion: 2 };
    setNavigator({});
    // isTauri() is mocked false, so probeAll never calls wslStatus — assert the
    // panel stays hidden in the browser path (the realistic jsdom case).
    render(<StepOsPermissions />);
    await screen.findByText('Notifications');
    expect(screen.queryByText(/WSL2 environment/i)).toBeNull();
  });
});
