// @vitest-environment jsdom
/**
 * SentinelTab.test (left sidebar) — the Sentinel-as-Herald settings panel
 * (sentinel-as-herald-2026-06-21). Mirrors OverwatchTab.test's idiom but for the
 * two-layer voice-prefs wiring SentinelTab loads on open:
 *   - workspace DEFAULT ← GET /api/agent-mcp/operator-voice-prefs?layer=workspace
 *   - per-user OVERRIDE ← GET /api/user/preferences → { payload }
 *   - write override     → PATCH /api/user/preferences { [key]: value }
 *   - clear override     → DELETE /api/user/preferences?key=<key>  (the reset ↺)
 *
 * Pins (through the shared <OverridableSetting> primitive): the settings rows
 * render; a key whose user override DIFFERS from the workspace default shows the
 * "override" badge while a matching/absent one shows "default"; and clicking the
 * reset ↺ issues the DELETE clear for that key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { effectiveFor, keyOverridden } from './SentinelTab';

// SentinelTab pulls in @tanstack/react-router's useNavigate — stub it so the panel
// renders without a router context (we only assert the badge/reset behaviour).
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import SentinelTab from './SentinelTab';

/** A fetch double that routes by URL+method, mirroring the real endpoints. The
 *  PATCH/DELETE handlers record their calls so the tests can assert the writes. */
function makeFetch(opts: {
  workspace?: Record<string, unknown> | null;
  user?: Record<string, unknown>;
  patches?: Array<{ url: string; body: unknown }>;
  deletes?: string[];
}) {
  const { workspace = {}, user = {}, patches = [], deletes = [] } = opts;
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/agent-mcp/operator-voice-prefs')) {
      return { ok: true, json: async () => workspace };
    }
    if (url.startsWith('/api/user/preferences')) {
      if (method === 'PATCH') {
        patches.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (method === 'DELETE') {
        deletes.push(url);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ payload: user }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SentinelTab pure layer helpers', () => {
  it('effectiveFor prefers a set user override, else the workspace default, else the fallback', () => {
    expect(effectiveFor({ audienceMode: 'engineer' }, { audienceMode: 'novice' }, 'audienceMode', 'engineer')).toBe('novice');
    expect(effectiveFor({ audienceMode: 'novice' }, {}, 'audienceMode', 'engineer')).toBe('novice');
    expect(effectiveFor({}, {}, 'audienceMode', 'engineer')).toBe('engineer');
    // a null user value is "not overriding" ⇒ falls through to the workspace value
    expect(effectiveFor({ speakSuggestions: true }, { speakSuggestions: null }, 'speakSuggestions', true)).toBe(true);
  });

  it('keyOverridden is true only when a set user value differs from the workspace default', () => {
    expect(keyOverridden({ audienceMode: 'engineer' }, {}, 'audienceMode', 'engineer')).toBe(false);
    expect(keyOverridden({ audienceMode: 'engineer' }, { audienceMode: 'engineer' }, 'audienceMode', 'engineer')).toBe(false);
    expect(keyOverridden({ audienceMode: 'engineer' }, { audienceMode: 'novice' }, 'audienceMode', 'engineer')).toBe(true);
    expect(keyOverridden({ silenceVoice: false }, { silenceVoice: null }, 'silenceVoice', false)).toBe(false);
  });
});

describe('SentinelTab rendering', () => {
  it('renders the settings rows once the layers load', async () => {
    vi.stubGlobal('fetch', makeFetch({ workspace: {}, user: {} }));
    render(<SentinelTab active />);
    await waitFor(() => expect(screen.getByText('Audience mode')).toBeTruthy());
    // "Voice" is both the section title and the speakSuggestions row label.
    expect(screen.getAllByText('Voice').length).toBeGreaterThan(0);
    expect(screen.getByText('Proactive nudges')).toBeTruthy();
    expect(screen.getByText('Speak status / cadence')).toBeTruthy();
    expect(screen.getByText('Pause the herald')).toBeTruthy();
    expect(screen.getByText('Do not disturb')).toBeTruthy();
  });

  it('does NOT fetch while the tab is inactive', () => {
    const fetchMock = makeFetch({});
    vi.stubGlobal('fetch', fetchMock);
    render(<SentinelTab active={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Audience mode')).toBeNull();
  });

  it('shows the "override" badge for a key whose user value differs from the workspace default, and "default" for one that matches', async () => {
    // workspace: speakSuggestions=true; user overrides it to false (a real override).
    // proactiveTicksEnabled: user matches the workspace default ⇒ NOT an override.
    vi.stubGlobal(
      'fetch',
      makeFetch({
        workspace: { speakSuggestions: true, proactiveTicksEnabled: true },
        user: { speakSuggestions: false, proactiveTicksEnabled: true },
      }),
    );
    render(<SentinelTab active />);
    await waitFor(() => expect(screen.getByText('Proactive nudges')).toBeTruthy());

    // The "Voice" row (speakSuggestions) is overridden — its reset is present.
    expect(screen.getByRole('button', { name: 'Reset Voice to default' })).toBeTruthy();
    // The "Proactive nudges" row matches the default — no reset button.
    expect(screen.queryByRole('button', { name: 'Reset Proactive nudges to default' })).toBeNull();
    // At least one override badge + at least one default badge are on screen.
    expect(screen.getAllByText('override').length).toBeGreaterThan(0);
    expect(screen.getAllByText('default').length).toBeGreaterThan(0);
  });

  it('clicking the reset ↺ on an overridden setting issues the DELETE clear for that key', async () => {
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({
        workspace: { silenceVoice: false },
        user: { silenceVoice: true },
        deletes,
      }),
    );
    render(<SentinelTab active />);
    await waitFor(() => expect(screen.getByText('Pause the herald')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Reset Pause the herald to default' }));
    await waitFor(() => expect(deletes.length).toBeGreaterThan(0));
    expect(deletes.some((u) => u === '/api/user/preferences?key=silenceVoice')).toBe(true);
  });

  it('a segmented audience click PATCHes the per-user override', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', makeFetch({ workspace: { audienceMode: 'engineer' }, user: {}, patches }));
    render(<SentinelTab active />);
    await waitFor(() => expect(screen.getByText('Audience mode')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'User-friendly' }));
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0].body).toEqual({ audienceMode: 'novice' });
  });
});
