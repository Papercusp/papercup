// @vitest-environment jsdom
/**
 * StepAutoUpdate.test.tsx — render-tier coverage for the SetupWizard "release
 * channel" step. The channel radiogroup is always shown; the update controls
 * are tauri-gated. We mock ./tauri-detect (isTauri) + the tauri-bindings
 * `commands` (checkForUpdate / installUpdate), and seed the saved channel from
 * a per-URL fetch router. Covers: channel seeding + PATCH-on-pick, the
 * browser-dev hint vs the tauri Check button, and the check-result branches
 * (up-to-date / available / error).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let isTauriValue: boolean;
vi.mock('./tauri-detect', () => ({ isTauri: () => isTauriValue }));

const checkForUpdate = vi.fn();
const installUpdate = vi.fn();
vi.mock('@papercusp/operator-core/lib/tauri-bindings', () => ({
  commands: {
    checkForUpdate: () => checkForUpdate(),
    installUpdate: () => installUpdate(),
  },
}));

import { StepAutoUpdate } from './StepAutoUpdate';

let savedChannel: string | undefined;
let patches: unknown[];
function installFetch() {
  patches = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/desktop/setup-wizard-state')) {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ update_channel: savedChannel }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  isTauriValue = false;
  savedChannel = undefined;
  checkForUpdate.mockReset();
  installUpdate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('StepAutoUpdate (SetupWizard release-channel step)', () => {
  it('renders the three channel radio cards, defaulting to alpha checked', async () => {
    installFetch();
    render(<StepAutoUpdate />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(3);
    const alpha = screen.getByRole('radio', { name: /Alpha/i });
    expect(alpha.getAttribute('aria-checked')).toBe('true');
  });

  it('seeds the selected channel from the saved setup-wizard-state', async () => {
    savedChannel = 'beta';
    installFetch();
    render(<StepAutoUpdate />);
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Beta/i }).getAttribute('aria-checked')).toBe('true');
    });
  });

  it('picking a channel PATCHes the new choice and checks it', async () => {
    installFetch();
    render(<StepAutoUpdate />);
    fireEvent.click(screen.getByRole('radio', { name: /Stable/i }));
    expect(screen.getByRole('radio', { name: /Stable/i }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(patches.length).toBeGreaterThanOrEqual(1));
    expect(patches[patches.length - 1]).toEqual({ update_channel: 'stable' });
  });

  it('outside tauri it shows the desktop-only hint and no Check button', async () => {
    installFetch();
    render(<StepAutoUpdate />);
    expect(screen.getByText(/Update controls appear here when running inside the desktop app/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Check for updates/i })).toBeNull();
  });

  it('inside tauri, an up-to-date check shows the "Up to date" progress', async () => {
    isTauriValue = true;
    checkForUpdate.mockResolvedValue({ status: 'ok', data: { available: false, current_version: '1.2.3' } });
    installFetch();
    render(<StepAutoUpdate />);
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/i }));
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    expect(screen.getByText(/Running v1\.2\.3\./i)).toBeTruthy();
  });

  it('inside tauri, an available update shows the version delta and an Install button', async () => {
    isTauriValue = true;
    checkForUpdate.mockResolvedValue({
      status: 'ok',
      data: { available: true, current_version: '1.2.3', new_version: '1.3.0', notes: 'fixes' },
    });
    installFetch();
    render(<StepAutoUpdate />);
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/i }));
    expect(await screen.findByText('Update available.')).toBeTruthy();
    expect(screen.getByText(/v1\.2\.3 → v1\.3\.0/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Install 1\.3\.0/i })).toBeTruthy();
    // Release notes are surfaced behind a <details>.
    expect(screen.getByText('Release notes')).toBeTruthy();
  });

  it('inside tauri, a check error surfaces the error branch', async () => {
    isTauriValue = true;
    checkForUpdate.mockResolvedValue({ status: 'error', error: 'network down' });
    installFetch();
    render(<StepAutoUpdate />);
    fireEvent.click(screen.getByRole('button', { name: /Check for updates/i }));
    expect(await screen.findByText("Couldn't check.")).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });
});
