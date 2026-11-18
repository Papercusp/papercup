// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstalledComputerLauncher } from './InstalledComputerLauncher';

const mocks = vi.hoisted(() => ({ principal: vi.fn(), save: vi.fn(), read: vi.fn() }));
vi.mock('./installed-computer-connection', () => ({
  installedBrowserKey: async () => ({ publicKey: { toString: () => btoa('b'.repeat(32)) } }),
  installedComputerPrincipal: mocks.principal, saveInstalledComputerApproval: mocks.save,
  readInstalledComputerApproval: mocks.read,
}));
beforeEach(() => {
  mocks.principal.mockResolvedValue({ userId: 'user', organizationId: 'org', workspaceId: 'workspace' });
  mocks.read.mockReturnValue({ grant: { installId: 'install' } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function openSetup() {
  render(<InstalledComputerLauncher />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect your computer' }));
  await waitFor(() => expect((screen.getByLabelText('Public connection code') as HTMLTextAreaElement).value).not.toBe(''));
}
describe('installed computer launcher', () => {
  it('keeps setup outside the sticky header and restores access after closing', async () => {
    render(<header className="topbar"><InstalledComputerLauncher /></header>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect your computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect your computer' });
    expect(dialog.closest('.topbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close connection setup' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Connect your computer' })).toBeTruthy();
  });
  it('opens only an explicit loopback window and carries public request data in the fragment', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Open Papercusp' }));
    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.origin).toBe('http://127.0.0.1:3070');
    expect(url.search).toBe('');
    const data = JSON.parse(atob(url.hash.split('=')[1]));
    expect(Object.keys(data).sort()).toEqual(['browserPublicKey', 'portalOrigin', 'requestId', 'version']);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Waiting for local approval');
  });
  it('shows a copy fallback when the browser cannot open the app, without claiming connection', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await openSetup(); fireEvent.click(screen.getByRole('button', { name: 'Open Papercusp' }));
    expect(screen.getByRole('status').textContent).toContain('blocked the app window');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('refuses a remote app address and unsolicited approval windows', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    await openSetup();
    fireEvent.change(screen.getByLabelText('Papercusp app address'), { target: { value: 'https://attacker.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Papercusp' }));
    expect(open).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'papercusp.local-desktop-approved' }, origin: 'http://127.0.0.1:3070', source: window }));
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('accepts an approval from the exact opened local window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window);
    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Open Papercusp' }));
    const receipt = { type: 'papercusp.local-desktop-approved', requestId: 'from-local-app' };
    window.dispatchEvent(new MessageEvent('message', { data: receipt, origin: 'http://127.0.0.1:3070', source: window }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Approval saved'));
    expect(mocks.read).toHaveBeenCalledWith(receipt, expect.any(Object), await mocks.principal());
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it('preserves copyable code and recovery guidance when the opened app has not approved', async () => {
    vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    try {
      await openSetup();
      const code = screen.getByLabelText('Public connection code') as HTMLTextAreaElement;
      const before = code.value;
      fireEvent.click(screen.getByRole('button', { name: 'Open Papercusp' }));
      expect(screen.getByRole('status').textContent).toContain('Waiting for local approval');
      expect(screen.getByRole('status').textContent).toContain('start or update it');
      expect(code.value).toBe(before);
      expect(code.readOnly).toBe(true);
      expect(screen.getByRole('button', { name: 'Verify approval' })).toHaveProperty('disabled', true);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Copy connection code' }));
      await waitFor(() => expect(copy).toHaveBeenCalledWith(before));
      expect(mocks.save).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('verifies the copied public receipt when the isolated app cannot notify its opener', async () => {
    await openSetup();
    const receipt = { type: 'papercusp.local-desktop-approved', requestId: 'copied-from-isolated-app' };
    fireEvent.change(screen.getByLabelText('Local approval receipt'), { target: { value: btoa(JSON.stringify(receipt)) } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify approval' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Approval saved'));
    expect(mocks.read).toHaveBeenCalledWith(receipt, expect.any(Object), await mocks.principal());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('verify its encrypted desktop connection');
  });
  it('rechecks the current portal identity before accepting a copied receipt', async () => {
    await openSetup(); mocks.principal.mockResolvedValue({ userId: 'other', organizationId: 'org', workspaceId: 'workspace' });
    fireEvent.change(screen.getByLabelText('Local approval receipt'), { target: { value: btoa('{}') } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify approval' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('account or workspace changed'));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
