// @vitest-environment jsdom
//
// DiscordBadge — the per-harness "join the Discord" pill. Fetches
// /api/harness/<slug>/discord and renders NULL unless the harness is shared
// with a discord guild; otherwise an invite <a> whose label/dot/title reflect
// the live presence count. These tests pin the render guards (null slug,
// !isShared, null discord), the populated render (count → "N online" + dot +
// invite href), the empty-inviteUrl fallback, the count-null "Discord" path,
// the silent-on-failure path, and clean unmount-before-resolve (no leak warning,
// which fail-on-console would catch).
//
// Real timers throughout: the component's 5-min re-poll setTimeout never fires
// inside a test, and `waitFor` needs real timers to poll. We assert post-load
// state via waitFor (success) and via a microtask flush + a no-DOM check
// (guards/failures, where nothing ever renders so there's nothing to waitFor).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import DiscordBadge from './DiscordBadge';

interface DiscordData {
  isShared: boolean;
  discord: { guildId: string; inviteUrl: string } | null;
  widget: { presenceCount: number | null; name: string | null } | null;
}

function stubFetch(impl: (url: string) => unknown) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}
const ok = (body: DiscordData) => ({ ok: true, json: async () => body });

/** Flush the load() chain: await fetch → (await res.json) → setState/schedule. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<DiscordBadge>', () => {
  it('renders nothing and fetches nothing for a null slug', () => {
    const mock = stubFetch(() => ok({ isShared: true, discord: { guildId: 'g', inviteUrl: 'x' }, widget: null }));
    const { container } = render(<DiscordBadge slug={null} />);
    expect(container.innerHTML).toBe('');
    expect(mock).not.toHaveBeenCalled();
  });

  it('renders an invite link with "N online" + the pulse dot when shared with a presence count', async () => {
    const mock = stubFetch(() =>
      ok({ isShared: true, discord: { guildId: 'g1', inviteUrl: 'https://discord.gg/abc' }, widget: { presenceCount: 7, name: 'Pot' } }),
    );
    const { container } = render(<DiscordBadge slug="pot-a" />);
    const link = (await waitFor(() => screen.getByRole('link'))) as HTMLAnchorElement;

    expect(mock).toHaveBeenCalledWith('/api/harness/pot-a/discord');
    expect(link.getAttribute('href')).toBe('https://discord.gg/abc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('7 online')).toBeTruthy();
    expect(link.textContent).toContain('7 online');
    expect(container.querySelector('.pc-discord-badge__dot')).not.toBeNull();
  });

  it('renders the generic "Discord" label and NO dot when the presence count is null', async () => {
    stubFetch(() =>
      ok({ isShared: true, discord: { guildId: 'g', inviteUrl: 'https://discord.gg/zzz' }, widget: { presenceCount: null, name: null } }),
    );
    const { container } = render(<DiscordBadge slug="pot-b" />);
    await waitFor(() => screen.getByRole('link'));
    expect(screen.getByText('Discord')).toBeTruthy();
    expect(screen.queryByText(/online/)).toBeNull();
    expect(container.querySelector('.pc-discord-badge__dot')).toBeNull();
    expect(screen.getByRole('link').textContent).toContain('Discord');
  });

  it('falls back to the canonical gg invite when inviteUrl is empty', async () => {
    stubFetch(() =>
      ok({ isShared: true, discord: { guildId: 'g', inviteUrl: '' }, widget: { presenceCount: 0, name: null } }),
    );
    render(<DiscordBadge slug="pot-c" />);
    const link = (await waitFor(() => screen.getByRole('link'))) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://discord.gg/Q2GZV9Jw');
    // 0 is a real count → "0 online" (not the generic label)
    expect(screen.getByText('0 online')).toBeTruthy();
  });

  it('renders nothing when the harness is not shared', async () => {
    const mock = stubFetch(() => ok({ isShared: false, discord: { guildId: 'g', inviteUrl: 'x' }, widget: null }));
    const { container } = render(<DiscordBadge slug="pot-d" />);
    await flush();
    expect(mock).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when shared but discord is null', async () => {
    const mock = stubFetch(() => ok({ isShared: true, discord: null, widget: { presenceCount: 3, name: null } }));
    const { container } = render(<DiscordBadge slug="pot-e" />);
    await flush();
    expect(mock).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent (renders nothing) on a non-ok response', async () => {
    const mock = stubFetch(() => ({ ok: false, json: async () => ({}) }));
    const { container } = render(<DiscordBadge slug="pot-f" />);
    await flush();
    expect(mock).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent on a fetch reject (network error swallowed)', async () => {
    const mock = stubFetch(() => {
      throw new Error('offline');
    });
    const { container } = render(<DiscordBadge slug="pot-g" />);
    await flush();
    expect(mock).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('clears data when the slug goes null after a successful load', async () => {
    stubFetch(() =>
      ok({ isShared: true, discord: { guildId: 'g', inviteUrl: 'https://discord.gg/abc' }, widget: { presenceCount: 2, name: null } }),
    );
    const { container, rerender } = render(<DiscordBadge slug="pot-h" />);
    await waitFor(() => screen.getByRole('link'));
    rerender(<DiscordBadge slug={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('unmounting before the fetch resolves does not throw or warn (cancelled flag)', async () => {
    let resolve!: (v: unknown) => void;
    stubFetch(
      () =>
        new Promise((res) => {
          resolve = res;
        }),
    );
    const { unmount } = render(<DiscordBadge slug="pot-i" />);
    unmount();
    // resolve the in-flight fetch AFTER unmount — the cancelled guard must
    // prevent a setState-after-unmount (fail-on-console catches the warning).
    await act(async () => {
      resolve({ ok: true, json: async () => ({ isShared: true, discord: { guildId: 'g', inviteUrl: 'x' }, widget: null }) });
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
