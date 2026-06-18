// @vitest-environment jsdom
//
// DiscordChannelLink — the harness Discord deep-link button. The real logic is the
// click handler: it attempts a discord:// deep-link via a hidden iframe, then after
// 500ms falls back to the https://discord.com equivalent (cancelled if the window
// blurs, i.e. the Discord app actually opened). A bug in the discord://↔https URL
// transform sends users to a dead link, so both directions + the fallback/cancel
// are pinned here. window.open is spied (jsdom's is "Not implemented" → would trip
// fail-on-console); timers are faked to drive the 500ms fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('lucide-react', () => ({ MessageSquare: () => <span data-testid="icon" /> }));

import { DiscordChannelLink } from './DiscordChannelLink';

let openSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  openSpy.mockRestore();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('DiscordChannelLink', () => {
  it('renders nothing when there is no channel url', () => {
    const { container } = render(<DiscordChannelLink discordChannelUrl={null} />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders a link to the channel url when present', () => {
    render(<DiscordChannelLink discordChannelUrl="https://discord.com/channels/1/2" />);
    const a = screen.getByRole('link', { name: 'Open Discord channel' });
    expect(a.getAttribute('href')).toBe('https://discord.com/channels/1/2');
  });

  it('attempts the discord:// deep-link then falls back to https after 500ms', () => {
    render(<DiscordChannelLink discordChannelUrl="https://discord.com/channels/1/2" />);
    fireEvent.click(screen.getByRole('link', { name: 'Open Discord channel' }));
    // A hidden iframe is appended with the discord:// protocol equivalent.
    const iframe = document.body.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('discord://channels/1/2');
    expect(openSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(openSpy).toHaveBeenCalledWith('https://discord.com/channels/1/2', '_blank', 'noopener,noreferrer');
  });

  it('transforms a discord:// url to https for the fallback', () => {
    render(<DiscordChannelLink discordChannelUrl="discord://channels/9/8" />);
    fireEvent.click(screen.getByRole('link', { name: 'Open Discord channel' }));
    expect(document.body.querySelector('iframe')?.getAttribute('src')).toBe('discord://channels/9/8');
    vi.advanceTimersByTime(500);
    expect(openSpy).toHaveBeenCalledWith('https://discord.com/channels/9/8', '_blank', 'noopener,noreferrer');
  });

  it('cancels the https fallback when the page blurs (Discord app opened)', () => {
    render(<DiscordChannelLink discordChannelUrl="https://discord.com/channels/1/2" />);
    fireEvent.click(screen.getByRole('link', { name: 'Open Discord channel' }));
    window.dispatchEvent(new Event('blur')); // Discord grabbed focus before the timeout
    vi.advanceTimersByTime(500);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('removes the probe iframe after cleanup', () => {
    render(<DiscordChannelLink discordChannelUrl="https://discord.com/channels/1/2" />);
    fireEvent.click(screen.getByRole('link', { name: 'Open Discord channel' }));
    expect(document.body.querySelector('iframe')).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(document.body.querySelector('iframe')).toBeNull();
  });
});
