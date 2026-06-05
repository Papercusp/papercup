/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SupportChatButton } from '../SupportChatButton';

const navigateClient = vi.fn();
const clipboardWriteText = vi.fn();

vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

afterEach(() => {
  cleanup();
  navigateClient.mockReset();
  vi.useRealTimers();
  document.body.innerHTML = '';
  clipboardWriteText.mockReset();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: (...args: unknown[]) => { clipboardWriteText(...args); return Promise.resolve(); } },
  });
});

describe('SupportChatButton', () => {
  it('navigates to /support when the oracle dock is absent', () => {
    render(<SupportChatButton>Open support</SupportChatButton>);

    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    vi.advanceTimersByTime(300);

    expect(navigateClient).toHaveBeenCalledWith('/support');
  });
  it('dispatches the support-open event immediately on click', () => {
    const onOpenSupport = vi.fn();
    window.addEventListener('papercusp:open-support', onOpenSupport as EventListener);

    render(<SupportChatButton>Open support</SupportChatButton>);
    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));

    expect(onOpenSupport).toHaveBeenCalledTimes(1);

    window.removeEventListener('papercusp:open-support', onOpenSupport as EventListener);
  });


  it('does not navigate when the oracle dock is already mounted', () => {
    const dock = document.createElement('div');
    dock.setAttribute('data-oracle-dock', 'true');
    document.body.appendChild(dock);

    render(<SupportChatButton>Open support</SupportChatButton>);

    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    vi.advanceTimersByTime(300);

    expect(navigateClient).not.toHaveBeenCalled();
  });
  it('copies the optional message to the clipboard when provided', () => {
    render(<SupportChatButton message="Need help with route churn">Open support</SupportChatButton>);

    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));

    expect(clipboardWriteText).toHaveBeenCalledWith('Need help with route churn');
  });
});
