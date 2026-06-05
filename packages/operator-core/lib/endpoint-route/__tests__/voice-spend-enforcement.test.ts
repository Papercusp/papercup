/**
 * Spend hard-cap ENFORCEMENT at the server seam — the spend routes that turn
 * the cap math (covered by stt-spend.test.ts / tts-spend.test.ts) into the
 * signal a live voice client obeys.
 *
 *   - operator-stt-spend POST records a usage slice and returns
 *     {todayUsd, fireSoftCap, hardCapTripped}. The STT client (deepgram.ts)
 *     reads hardCapTripped and self-stops the mic + WS — so this route IS the
 *     "refuse / stop" decision point. Input is validated (0..60 min) so a
 *     buggy/hostile client can't under/over-report.
 *   - The PUT routes set the caps (knobs) that define when the trip fires;
 *     the TTS PUT also recomputes today's estimatedUsd when the rate changes.
 *
 * The browser-side actuation (deepgram self-stop, voice-mode refuse-to-speak)
 * is browser-coupled and is exercised at the E2E layer (per the cloud-adapters
 * note + P-007).
 *
 * P-006 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDefinition } from '../define-route';

vi.mock('../../stt-spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stt-spend')>();
  return {
    ...actual, // keep DEFAULT_STT_SPEND_STATE + the (separately-tested) cap math
    loadSttSpend: vi.fn(),
    recordSttSpend: vi.fn(),
    saveSttSpend: vi.fn(async () => {}),
  };
});
vi.mock('../../tts-spend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tts-spend')>();
  return { ...actual, loadSpend: vi.fn(), saveSpend: vi.fn(async () => {}) };
});

import { loadSttSpend, recordSttSpend, saveSttSpend } from '../../stt-spend';
import { loadSpend, saveSpend } from '../../tts-spend';
import sttRoutes from '../routes/agent-mcp/operator-stt-spend';
import ttsRoutes from '../routes/agent-mcp/operator-tts-spend';

function route(routes: unknown, method: string, path: string): RouteDefinition<never> {
  const def = (routes as RouteDefinition<never>[]).find((r) => r.method === method && r.path === path);
  if (!def) throw new Error(`no ${method} ${path}`);
  return def;
}
const sttPath = '/agent-mcp/operator-stt-spend';
const ttsPath = '/agent-mcp/operator-tts-spend';

function jsonReq(path: string, method: string, body: unknown, raw?: string): Request {
  return new Request(`http://localhost/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

const STT_STATE = {
  perMinuteRate: 0.0043,
  softCapUsd: 1,
  hardCapUsd: 5,
  spend: [{ date: '2026-06-01', minutes: 10, estimatedUsd: 0.043 }],
  softCapAcknowledgedDate: null,
};
const TTS_STATE = {
  perKCharRate: 0.18,
  softCapUsd: 5,
  hardCapUsd: 20,
  spend: [{ date: '2026-06-01', chars: 10_000, estimatedUsd: 1.8 }],
  softCapAcknowledgedDate: null,
};

beforeEach(() => {
  vi.mocked(loadSttSpend).mockResolvedValue(structuredClone(STT_STATE) as never);
  vi.mocked(saveSttSpend).mockResolvedValue(undefined);
  vi.mocked(loadSpend).mockResolvedValue(structuredClone(TTS_STATE) as never);
  vi.mocked(saveSpend).mockResolvedValue(undefined);
  vi.mocked(recordSttSpend).mockResolvedValue({
    todayUsd: 0.05,
    fireSoftCap: false,
    hardCapTripped: false,
  } as never);
});
afterEach(() => vi.clearAllMocks());

describe('operator-stt-spend POST — the hard-cap stop signal', () => {
  const post = () => route(sttRoutes, 'POST', sttPath);

  it('records a usage slice and surfaces {todayUsd, fireSoftCap, hardCapTripped}', async () => {
    const res = await post().handler(jsonReq(sttPath, 'POST', { minutes: 2 }), {} as never);
    expect(res.status).toBe(200);
    expect(recordSttSpend).toHaveBeenCalledWith(2);
    expect(await res.json()).toEqual({ todayUsd: 0.05, fireSoftCap: false, hardCapTripped: false });
  });

  it('propagates hardCapTripped:true — the signal the STT client self-stops on', async () => {
    vi.mocked(recordSttSpend).mockResolvedValue({
      todayUsd: 6.2,
      fireSoftCap: false,
      hardCapTripped: true,
    } as never);
    const res = await post().handler(jsonReq(sttPath, 'POST', { minutes: 1 }), {} as never);
    expect(((await res.json()) as { hardCapTripped: boolean }).hardCapTripped).toBe(true);
  });

  it('propagates fireSoftCap:true', async () => {
    vi.mocked(recordSttSpend).mockResolvedValue({
      todayUsd: 1.2,
      fireSoftCap: true,
      hardCapTripped: false,
    } as never);
    const res = await post().handler(jsonReq(sttPath, 'POST', { minutes: 1 }), {} as never);
    expect(((await res.json()) as { fireSoftCap: boolean }).fireSoftCap).toBe(true);
  });

  it('400 on non-JSON body', async () => {
    const res = await post().handler(jsonReq(sttPath, 'POST', null, 'not-json'), {} as never);
    expect(res.status).toBe(400);
    expect(recordSttSpend).not.toHaveBeenCalled();
  });

  it.each([['NaN', 'x'], ['negative', -1], ['over 60 min', 61]])(
    'rejects bad minutes (%s) with 400 and does not bill',
    async (_label, minutes) => {
      const res = await post().handler(jsonReq(sttPath, 'POST', { minutes }), {} as never);
      expect(res.status).toBe(400);
      expect(recordSttSpend).not.toHaveBeenCalled();
    },
  );
});

describe('operator-stt-spend GET / PUT', () => {
  it('GET returns the current spend state', async () => {
    const res = await route(sttRoutes, 'GET', sttPath).handler(jsonReq(sttPath, 'GET', undefined), {} as never);
    expect(((await res.json()) as { hardCapUsd: number }).hardCapUsd).toBe(5);
  });

  it('PUT updates the cap knob, preserving accumulated spend', async () => {
    const res = await route(sttRoutes, 'PUT', sttPath).handler(
      jsonReq(sttPath, 'PUT', { hardCapUsd: 12, softCapUsd: 3 }),
      {} as never,
    );
    expect(saveSttSpend).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveSttSpend).mock.calls[0][0] as typeof STT_STATE;
    expect(saved.hardCapUsd).toBe(12);
    expect(saved.softCapUsd).toBe(3);
    expect(saved.spend).toEqual(STT_STATE.spend); // not clobbered by the PUT
    expect(((await res.json()) as { hardCapUsd: number }).hardCapUsd).toBe(12);
  });
});

describe('operator-tts-spend GET / PUT', () => {
  it('GET returns the current TTS spend state', async () => {
    const res = await route(ttsRoutes, 'GET', ttsPath).handler(jsonReq(ttsPath, 'GET', undefined), {} as never);
    expect(((await res.json()) as { hardCapUsd: number }).hardCapUsd).toBe(20);
  });

  it('PUT sets soft/hard caps', async () => {
    const res = await route(ttsRoutes, 'PUT', ttsPath).handler(
      jsonReq(ttsPath, 'PUT', { softCapUsd: 8, hardCapUsd: 40 }),
      {} as never,
    );
    const body = (await res.json()) as { softCapUsd: number; hardCapUsd: number };
    expect(body.softCapUsd).toBe(8);
    expect(body.hardCapUsd).toBe(40);
    expect(saveSpend).toHaveBeenCalledTimes(1);
  });

  it('PUT changing the per-1k-char rate recomputes today’s estimatedUsd', async () => {
    const res = await route(ttsRoutes, 'PUT', ttsPath).handler(
      jsonReq(ttsPath, 'PUT', { perKCharRate: 0.3 }),
      {} as never,
    );
    const body = (await res.json()) as { perKCharRate: number; spend: Array<{ estimatedUsd: number }> };
    expect(body.perKCharRate).toBe(0.3);
    // 10_000 chars / 1000 * 0.3 = 3.0
    expect(body.spend[0].estimatedUsd).toBeCloseTo(3.0, 5);
  });

  it('PUT ignores a negative rate (guard) and leaves the rate unchanged', async () => {
    const res = await route(ttsRoutes, 'PUT', ttsPath).handler(
      jsonReq(ttsPath, 'PUT', { perKCharRate: -1 }),
      {} as never,
    );
    expect(((await res.json()) as { perKCharRate: number }).perKCharRate).toBe(0.18);
  });

  it('PUT 400 on invalid JSON', async () => {
    const res = await route(ttsRoutes, 'PUT', ttsPath).handler(
      jsonReq(ttsPath, 'PUT', null, '{bad'),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(saveSpend).not.toHaveBeenCalled();
  });
});
