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
  it('rechecks the current portal identity before accepting a copied receipt', async () => {
    await openSetup(); mocks.principal.mockResolvedValue({ userId: 'other', organizationId: 'org', workspaceId: 'workspace' });
    fireEvent.change(screen.getByLabelText('Local approval receipt'), { target: { value: btoa('{}') } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify approval' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('account or workspace changed'));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
