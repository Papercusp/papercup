/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SupportChatButton } from '../SupportChatButton';

const navigateClient = vi.fn();

vi.mock('../../../lib/client-navigation', () => ({
  navigateClient: (...args: unknown[]) => navigateClient(...args),
}));

afterEach(() => {
  cleanup();
  navigateClient.mockReset();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe('SupportChatButton', () => {
  it('navigates to /support when the oracle dock is absent', () => {
    render(<SupportChatButton>Open support</SupportChatButton>);

    fireEvent.click(screen.getByRole('button', { name: 'Open support' }));
    vi.advanceTimersByTime(300);

    expect(navigateClient).toHaveBeenCalledWith('/support');
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
});
