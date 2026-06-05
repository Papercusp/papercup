// @vitest-environment jsdom
/**
 * AudienceModeSelector — the engineer/novice voice-audience toggle.
 *
 * Covers:
 *  - Initial mode derived from voice prefs (loadVoicePrefsClient.audienceMode).
 *  - Click → PUT to /api/agent-mcp/operator-voice-prefs + aria-pressed flips +
 *    setVoicePrefsClient called with the server echo.
 *  - Cross-tab sync: a `storage` event on the workspace-scoped LS key updates
 *    the displayed mode (engineer ⇄ novice) without a click.
 *
 * voice-prefs-client is mocked (the real one lazy-fetches on first read);
 * `wsLocalKey` is the REAL helper so the storage-key scoping is exercised
 * end-to-end (resolves to `pc:ws:default:pc:audienceMode` in jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import type { VoicePrefs } from '@papercusp/operator-core/lib/voice-prefs';

// ── voice-prefs-client mock ─────────────────────────────────────────
// A mutable mock cache + the subscribe fan-out, so the component's
// useEffect reads a deterministic initial mode and same-tab notifies work.
const prefsState: { current: Partial<VoicePrefs> } = { current: { audienceMode: 'engineer' } };
const subscribers = new Set<(p: VoicePrefs) => void>();

const loadVoicePrefsClient = vi.fn(() => prefsState.current as VoicePrefs);
const setVoicePrefsClient = vi.fn((next: VoicePrefs) => {
  prefsState.current = next;
  for (const fn of subscribers) fn(next);
});
const subscribeVoicePrefsClient = vi.fn((fn: (p: VoicePrefs) => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
});

vi.mock('@/app/_components/voice/voice-prefs-client', () => ({
  loadVoicePrefsClient: () => loadVoicePrefsClient(),
  setVoicePrefsClient: (next: VoicePrefs) => setVoicePrefsClient(next),
  subscribeVoicePrefsClient: (fn: (p: VoicePrefs) => void) => subscribeVoicePrefsClient(fn),
}));

import { AudienceModeSelector } from './AudienceModeSelector';

// jsdom's localStorage is unreliable under Node's experimental webstorage on
// this box; back it with a Map (same pattern as OperatorChatSidebar's test).
const localStorageState = new Map<string, string>();

const LS_KEY = wsLocalKey('pc:audienceMode');

function mockFetchOk(echo: Partial<VoicePrefs>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => echo as VoicePrefs,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  prefsState.current = { audienceMode: 'engineer' };
  subscribers.clear();
  loadVoicePrefsClient.mockClear();
  setVoicePrefsClient.mockClear();
  subscribeVoicePrefsClient.mockClear();
  localStorageState.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      clear: () => {
        localStorageState.clear();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function btn(name: 'Engineer' | 'Novice') {
  return screen.getByRole('button', { name });
}

describe('AudienceModeSelector — initial mode', () => {
  it('defaults engineer-pressed when prefs.audienceMode is engineer', () => {
    mockFetchOk({ audienceMode: 'engineer' });
    render(<AudienceModeSelector />);
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Novice').getAttribute('aria-pressed')).toBe('false');
  });

  it('derives novice-pressed from prefs.audienceMode = novice', () => {
    prefsState.current = { audienceMode: 'novice' };
    mockFetchOk({ audienceMode: 'novice' });
    render(<AudienceModeSelector />);
    expect(btn('Novice').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('false');
  });

  it('falls back to engineer when prefs has no audienceMode', () => {
    prefsState.current = {};
    mockFetchOk({});
    render(<AudienceModeSelector />);
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('AudienceModeSelector — click persists + flips', () => {
  it('clicking Novice flips aria-pressed and PUTs the new mode', async () => {
    const fetchMock = mockFetchOk({ audienceMode: 'novice' });
    render(<AudienceModeSelector />);
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(btn('Novice'));

    // Optimistic flip is synchronous.
    expect(btn('Novice').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('false');

    // PUT to the voice-prefs endpoint with the chosen mode in the body.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/agent-mcp/operator-voice-prefs');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ audienceMode: 'novice' });

    // The server echo is pushed into the client cache.
    await waitFor(() =>
      expect(setVoicePrefsClient).toHaveBeenCalledWith({ audienceMode: 'novice' }),
    );
  });

  it('writes the workspace-scoped LS key so other tabs see the change', async () => {
    mockFetchOk({ audienceMode: 'novice' });
    render(<AudienceModeSelector />);
    fireEvent.click(btn('Novice'));
    // saveAudienceMode writes LS before the fetch resolves.
    await waitFor(() => expect(localStorageState.get(LS_KEY)).toBe('novice'));
  });
});

describe('AudienceModeSelector — cross-tab storage sync', () => {
  it('a storage event for the scoped key updates the displayed mode', async () => {
    mockFetchOk({ audienceMode: 'engineer' });
    render(<AudienceModeSelector />);
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');

    // Simulate another tab writing the workspace-scoped key.
    fireEvent(
      window,
      new StorageEvent('storage', { key: LS_KEY, newValue: 'novice' }),
    );

    await waitFor(() => expect(btn('Novice').getAttribute('aria-pressed')).toBe('true'));
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores storage events for an unrelated key', () => {
    mockFetchOk({ audienceMode: 'engineer' });
    render(<AudienceModeSelector />);
    fireEvent(
      window,
      new StorageEvent('storage', { key: 'some:other:key', newValue: 'novice' }),
    );
    // Mode unchanged.
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores a storage event with a non-mode value', () => {
    mockFetchOk({ audienceMode: 'engineer' });
    render(<AudienceModeSelector />);
    fireEvent(
      window,
      new StorageEvent('storage', { key: LS_KEY, newValue: 'garbage' }),
    );
    expect(btn('Engineer').getAttribute('aria-pressed')).toBe('true');
  });

  it('same-tab subscribe push (setVoicePrefsClient) updates the mode', async () => {
    mockFetchOk({ audienceMode: 'engineer' });
    render(<AudienceModeSelector />);
    // The component subscribed on mount.
    expect(subscribeVoicePrefsClient).toHaveBeenCalled();

    // Another surface in THIS tab pushes a prefs update.
    setVoicePrefsClient({ audienceMode: 'novice' } as VoicePrefs);

    await waitFor(() => expect(btn('Novice').getAttribute('aria-pressed')).toBe('true'));
  });
});
