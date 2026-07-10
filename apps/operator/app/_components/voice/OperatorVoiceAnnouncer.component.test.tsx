// @vitest-environment jsdom
/**
 * OperatorVoiceAnnouncer — closed-panel spoken status (v4 §2d Phase 3c +
 * §C.4 open-card announcer + §2e pause nudge). Pure listener component
 * (renders null); all behavior is the gating matrix + message composition,
 * none of it covered anywhere. Pins:
 *   - scan-start: speaks only when mode=always-on AND panel closed AND
 *     speakCadenceStatus; 30s dedup window between scan-starts.
 *   - scan-done: 0/N/N+M message variants; adaptive median-ack suffix only
 *     when stats deviate >60s from the 4-min static fallback; stats-fetch
 *     failure still speaks the base line.
 *   - cardOpen: requires correlationId + non-blank text + speakOpenCards +
 *     any non-off mode + panel closed; fallbackText preferred over prompt.
 *   - pause flip: first observation anchors silently; flips speak only when
 *     the server nudge arbitration returns fired:true and speakNudges is on.
 *   - unmount removes both window listeners and the operator-state sub.
 *
 * Seams mocked: ./voice-mode (speak/getVoiceState), ./voice-prefs-client,
 * operator-shared-state (panel open flag + state sub), global fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  speak: vi.fn(),
  getVoiceState: vi.fn(() => ({ mode: 'always-on' as string })),
  loadVoicePrefsClient: vi.fn(() => ({
    speakCadenceStatus: true,
    speakOpenCards: true,
    speakNudges: true,
  })),
  sharedState: { open: false },
  stateSubscribers: [] as Array<(s: { paused?: boolean }) => void>,
  unsubPause: vi.fn(),
}));

vi.mock('./voice-mode', () => ({
  speak: h.speak,
  getVoiceState: h.getVoiceState,
}));
vi.mock('./voice-prefs-client', () => ({
  loadVoicePrefsClient: h.loadVoicePrefsClient,
}));
vi.mock('@papercusp/operator-core/lib/operator-shared-state', () => ({
  sharedState: h.sharedState,
  subscribeOperatorState: (fn: (s: { paused?: boolean }) => void) => {
    h.stateSubscribers.push(fn);
    return h.unsubPause;
  },
}));

import { OperatorVoiceAnnouncer } from './OperatorVoiceAnnouncer';

/** fetch stub: route → response factory. Unrouted URLs reject. */
let fetchRoutes: Record<string, () => Promise<Partial<Response>>>;
const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  const key = Object.keys(fetchRoutes).find((k) => String(url).includes(k));
  if (!key) throw new Error(`unrouted fetch: ${url}`);
  return (await fetchRoutes[key]()) as Response;
});

const scanEvent = (detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent('operator:scan', { detail }));
const cardEvent = (detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent('operator:cardOpen', { detail }));
const modeEvent = (mode: string) =>
  window.dispatchEvent(new CustomEvent('papercusp:operatorMode', { detail: { mode } }));

/** Default: stats endpoint says "no data" so scan-done speaks the base line. */
const statsOk = (medianAckLatencyMs: number | null) => async () =>
  ({ ok: true, json: async () => ({ medianAckLatencyMs }) }) as Partial<Response>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); // real setTimeout (waitFor), fake Date (dedup window)
  vi.setSystemTime(new Date('2026-06-09T12:00:00Z'));
  vi.stubGlobal('fetch', fetchMock);
  fetchRoutes = { 'operator-stats': statsOk(null) };
  h.speak.mockClear();
  h.getVoiceState.mockReturnValue({ mode: 'always-on' });
  h.loadVoicePrefsClient.mockReturnValue({
    speakCadenceStatus: true,
    speakOpenCards: true,
    speakNudges: true,
    speakModeFlips: true,
  });
  h.sharedState.open = false;
  h.stateSubscribers.length = 0;
  h.unsubPause.mockClear();
  fetchMock.mockClear();
  window.sessionStorage.clear(); // the mode-flip anchor seeds from sessionStorage
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('scan-start', () => {
  it('speaks "Scanning workspace." politely when fully gated on', () => {
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-start' });
    expect(h.speak).toHaveBeenCalledWith('Scanning workspace.', 'system:operator', 'polite');
  });

  it.each([
    ['voice mode is not always-on', () => h.getVoiceState.mockReturnValue({ mode: 'push-to-talk' })],
    ['the panel is open', () => { h.sharedState.open = true; }],
    ['speakCadenceStatus is off', () =>
      h.loadVoicePrefsClient.mockReturnValue({ speakCadenceStatus: false, speakOpenCards: true, speakNudges: true })],
  ])('stays silent when %s', (_label, arrange) => {
    render(<OperatorVoiceAnnouncer />);
    arrange();
    scanEvent({ kind: 'scan-start' });
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('dedups back-to-back scan-starts inside 30s, speaks again after', () => {
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-start' });
    scanEvent({ kind: 'scan-start' });
    expect(h.speak).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31_000);
    scanEvent({ kind: 'scan-start' });
    expect(h.speak).toHaveBeenCalledTimes(2);
  });
});

describe('scan-done message composition', () => {
  it('0 suggestions → "No new suggestions."', async () => {
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 0, autoDispatched: 0 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Scan complete. No new suggestions.', 'system:operator', 'polite'));
  });

  it('N suggestions, none dispatched → pluralized surfaced line', async () => {
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 2, autoDispatched: 0 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Scan complete. Surfaced 2 suggestions.', 'system:operator', 'polite'));
  });

  it('singular suggestion with auto-dispatch → combined line', async () => {
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 1, autoDispatched: 1 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith(
        'Scan complete. Surfaced 1 suggestion, 1 auto-dispatched.', 'system:operator', 'polite'));
  });

  it('appends the adaptive median-ack suffix when stats deviate >60s from the 4-min fallback', async () => {
    fetchRoutes = { 'operator-stats': statsOk(600_000) }; // 10 min, deviates 6 min
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 0 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith(
        'Scan complete. No new suggestions. Median ack 600 seconds.', 'system:operator', 'polite'));
  });

  it('skips the suffix when stats sit within 60s of the fallback', async () => {
    fetchRoutes = { 'operator-stats': statsOk(250_000) }; // 10s off 240s
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 0 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Scan complete. No new suggestions.', 'system:operator', 'polite'));
  });

  it('still speaks the base line when the stats fetch fails', async () => {
    fetchRoutes = { 'operator-stats': async () => { throw new Error('down'); } };
    render(<OperatorVoiceAnnouncer />);
    scanEvent({ kind: 'scan-done', suggestions: 3 });
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Scan complete. Surfaced 3 suggestions.', 'system:operator', 'polite'));
  });
});

describe('open-card announcer', () => {
  it('speaks fallbackText (preferred over prompt) when gated on', () => {
    render(<OperatorVoiceAnnouncer />);
    cardEvent({ correlationId: 'c1', prompt: 'long prompt', fallbackText: 'short spoken form' });
    expect(h.speak).toHaveBeenCalledWith('short spoken form', 'system:operator', 'polite');
  });

  it('falls back to prompt when fallbackText is blank', () => {
    render(<OperatorVoiceAnnouncer />);
    cardEvent({ correlationId: 'c2', prompt: 'the prompt', fallbackText: '  ' });
    expect(h.speak).toHaveBeenCalledWith('the prompt', 'system:operator', 'polite');
  });

  it('works in push-to-talk mode too (any non-off mode)', () => {
    h.getVoiceState.mockReturnValue({ mode: 'push-to-talk' });
    render(<OperatorVoiceAnnouncer />);
    cardEvent({ correlationId: 'c3', fallbackText: 'speak me' });
    expect(h.speak).toHaveBeenCalledWith('speak me', 'system:operator', 'polite');
  });

  it.each([
    ['voice is off', () => h.getVoiceState.mockReturnValue({ mode: 'off' })],
    ['the panel is open', () => { h.sharedState.open = true; }],
    ['speakOpenCards is off', () =>
      h.loadVoicePrefsClient.mockReturnValue({ speakCadenceStatus: true, speakOpenCards: false, speakNudges: true })],
  ])('stays silent when %s', (_label, arrange) => {
    render(<OperatorVoiceAnnouncer />);
    arrange();
    cardEvent({ correlationId: 'c4', fallbackText: 'nope' });
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('ignores cards without a correlationId or without any text', () => {
    render(<OperatorVoiceAnnouncer />);
    cardEvent({ fallbackText: 'no id' });
    cardEvent({ correlationId: 'c5', prompt: '', fallbackText: '' });
    expect(h.speak).not.toHaveBeenCalled();
  });
});

describe('pause nudge', () => {
  const flipPause = (paused: boolean) => h.stateSubscribers.forEach((fn) => fn({ paused }));

  it('anchors on first observation, then speaks on a flip when arbitration fires', async () => {
    fetchRoutes['operator-nudge'] = async () =>
      ({ ok: true, json: async () => ({ fired: true }) }) as Partial<Response>;
    render(<OperatorVoiceAnnouncer />);
    flipPause(false); // anchor — silent
    expect(h.speak).not.toHaveBeenCalled();
    flipPause(true);
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Papercup paused.', 'system:operator-nudge', 'polite'));
    flipPause(false);
    await waitFor(() =>
      expect(h.speak).toHaveBeenCalledWith('Papercup resumed.', 'system:operator-nudge', 'polite'));
  });

  it('stays silent when the server arbitration declines (fired:false)', async () => {
    fetchRoutes['operator-nudge'] = async () =>
      ({ ok: true, json: async () => ({ fired: false }) }) as Partial<Response>;
    render(<OperatorVoiceAnnouncer />);
    flipPause(false);
    flipPause(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('does not even ask the server when speakNudges is off or voice is off', () => {
    h.loadVoicePrefsClient.mockReturnValue({ speakCadenceStatus: true, speakOpenCards: true, speakNudges: false });
    render(<OperatorVoiceAnnouncer />);
    flipPause(false);
    flipPause(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('repeated same-value observations never speak', () => {
    render(<OperatorVoiceAnnouncer />);
    flipPause(true);
    flipPause(true);
    flipPause(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.speak).not.toHaveBeenCalled();
  });
});

// settings-audit 2026-07-09. `speakModeFlips` (formerly `speakReceivingFlips`)
// gated a card "flips to consumed" event deleted by the card-lifecycle collapse,
// so the toggle could never fire. Repointed at the live active↔passive flip.
describe('mode flips', () => {
  it('speaks on a flip away from the anchored mode', () => {
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive');
    expect(h.speak).toHaveBeenCalledWith('Papercup passive.', 'system:operator', 'polite');
  });

  it('speaks both directions', () => {
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive');
    modeEvent('active');
    expect(h.speak).toHaveBeenNthCalledWith(2, 'Papercup active.', 'system:operator', 'polite');
  });

  it('stays silent when speakModeFlips is off', () => {
    h.loadVoicePrefsClient.mockReturnValue({ speakModeFlips: false });
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive');
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('stays silent when voice is off', () => {
    h.getVoiceState.mockReturnValue({ mode: 'off' });
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive');
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('ignores an idempotent re-broadcast of the current mode', () => {
    render(<OperatorVoiceAnnouncer />);
    modeEvent('active'); // anchor defaults to 'active' — not a flip
    expect(h.speak).not.toHaveBeenCalled();
    modeEvent('passive');
    expect(h.speak).toHaveBeenCalledTimes(1);
    modeEvent('passive'); // repeat of the now-current mode
    expect(h.speak).toHaveBeenCalledTimes(1);
  });

  // The provider DISPATCHES 'passive' during startup when operatorActiveOnStartup
  // is false. Anchoring from sessionStorage (not from the first event) keeps that
  // boot broadcast silent instead of announcing on every app launch.
  it('does not announce the startup passive broadcast when the session is already passive', () => {
    window.sessionStorage.setItem('papercusp.operatorMode', 'passive');
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive');
    expect(h.speak).not.toHaveBeenCalled();
  });

  it('a flip with voice off still advances the anchor (no stale replay later)', () => {
    h.getVoiceState.mockReturnValue({ mode: 'off' });
    render(<OperatorVoiceAnnouncer />);
    modeEvent('passive'); // silent, but anchor moves to 'passive'
    h.getVoiceState.mockReturnValue({ mode: 'always-on' });
    modeEvent('passive'); // same mode → must stay silent
    expect(h.speak).not.toHaveBeenCalled();
    modeEvent('active');
    expect(h.speak).toHaveBeenCalledWith('Papercup active.', 'system:operator', 'polite');
  });

  it('ignores a malformed mode payload', () => {
    render(<OperatorVoiceAnnouncer />);
    modeEvent('bogus');
    expect(h.speak).not.toHaveBeenCalled();
  });
});

describe('cleanup', () => {
  it('unmount removes the window listeners and unsubscribes the state watch', () => {
    const { unmount } = render(<OperatorVoiceAnnouncer />);
    unmount();
    expect(h.unsubPause).toHaveBeenCalledTimes(1);
    scanEvent({ kind: 'scan-start' });
    cardEvent({ correlationId: 'c9', fallbackText: 'late' });
    modeEvent('passive');
    expect(h.speak).not.toHaveBeenCalled();
  });
});
