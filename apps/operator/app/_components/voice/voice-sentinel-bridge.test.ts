/**
 * voice-sentinel-bridge unit tests (voice-unified-sentinel-pipeline-2026-07-01,
 * P-004 — this seam is the webview's live utterance path and had zero coverage).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeVoiceToSentinelPane, drainSentinelOutput, drainHindsightForSpeech } from './voice-sentinel-bridge';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe('routeVoiceToSentinelPane', () => {
  it('POSTs the trimmed transcript to /api/operator/papercup-input', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(routeVoiceToSentinelPane('  status of the hive  ')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/operator/papercup-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'status of the hive', spoken: true }),
    });
  });

  it('refuses a blank transcript without a network call', async () => {
    await expect(routeVoiceToSentinelPane('   ')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false on a non-ok response (exited pane / no dock)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    await expect(routeVoiceToSentinelPane('hello')).resolves.toBe(false);
  });

  it('returns false instead of throwing when the dock is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(routeVoiceToSentinelPane('hello')).resolves.toBe(false);
  });
});

describe('drainSentinelOutput', () => {
  it('returns the drained lines, filtering non-strings', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ says: ['first', 42, 'second', null] }),
    });
    await expect(drainSentinelOutput()).resolves.toEqual(['first', 'second']);
    expect(fetchMock).toHaveBeenCalledWith('/api/operator/papercup-output', { method: 'GET' });
  });

  it('returns [] on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(drainSentinelOutput()).resolves.toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } });
    await expect(drainSentinelOutput()).resolves.toEqual([]);
  });

  it('returns [] when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(drainSentinelOutput()).resolves.toEqual([]);
  });
});

// WI-5174: a settled deep-delegation answer whose Sentinel-pane write fails
// (no dock — the normal desktop case) falls back to notifyOperatorHindsight,
// which appends the answer to the chat thread as TEXT ONLY. This drain is the
// local-mode (Kokoro/whisper) counterpart of voice-mode.ts's full-agent-only
// drainHindsightOnConnect, so those answers get spoken too.
describe('drainHindsightForSpeech', () => {
  it('hits the drain=1 endpoint and prefixes each headline for speech', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ headline: 'papercusp harness is green.' }] }),
    });
    await expect(drainHindsightForSpeech()).resolves.toEqual([
      'While you were away: papercusp harness is green.',
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent-mcp/operator-hindsight?drain=1', {
      method: 'GET',
    });
  });

  it('strips the machine-readable [deep-answer WI-NNN] marker before speaking', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ headline: '[deep-answer WI-5174] papercusp harness is green.' }],
      }),
    });
    await expect(drainHindsightForSpeech()).resolves.toEqual([
      'While you were away: papercusp harness is green.',
    ]);
  });

  it('filters malformed / empty items', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ headline: '' }, { headline: 42 }, {}, null] }),
    });
    await expect(drainHindsightForSpeech()).resolves.toEqual([]);
  });

  it('returns [] on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(drainHindsightForSpeech()).resolves.toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('bad json'); } });
    await expect(drainHindsightForSpeech()).resolves.toEqual([]);
  });

  it('returns [] when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(drainHindsightForSpeech()).resolves.toEqual([]);
  });
});
