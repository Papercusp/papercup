/**
 * reserved-service-ports (EI-294) — the canonical never-squat port set, and
 * BOTH voice-WS port-walks honoring it. The incident class: a walker's
 * EADDRINUSE fallback steps onto a core service's canonical port during its
 * restart window, then the service crash-loops on EADDRINUSE behind a
 * WS-only listener answering 426s.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructedPorts: number[] = [];

vi.mock('ws', () => ({
  WebSocketServer: class extends EventEmitter {
    constructor(opts: { port: number }) {
      super();
      constructedPorts.push(opts.port);
      setTimeout(() => this.emit('listening'), 0);
    }
    close(cb?: () => void) {
      cb?.(); // no real socket — resolve the close immediately
    }
  },
}));
// Heavy transitive graphs irrelevant to the port walk (the device-voice unit
// test mocks the dispatch sibling for the same reason).
vi.mock('./device-voice-dispatch', () => ({ dispatchTranscript: async () => {} }));
vi.mock('./device-jwt', () => ({ verifyDeviceToken: () => null }));
vi.mock('./voice-node/local-audio-socket', () => ({ startLocalVoiceSocket: () => () => {} }));

import { RESERVED_SERVICE_PORTS, isReservedServicePort } from './reserved-service-ports';
import { startMobileVoiceWs, getMobileVoicePort, _stopMobileVoiceWsForTests } from './device-voice-ws';
import {
  startDesktopVoiceWs,
  getDesktopVoicePort,
  _stopDesktopVoiceWsForTests,
} from './voice-node/desktop-voice-ws';

const tick = () => new Promise((r) => setTimeout(r, 25));

// The reserved-skip path warns by design; vitest-fail-on-console re-patches
// per test, so the spy must be per-test too (agent-insights/
// testing-await-event-emit-paths).
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await _stopMobileVoiceWsForTests();
  await _stopDesktopVoiceWsForTests();
  constructedPorts.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reserved-service-ports', () => {
  it('carries every canonical core-service port', () => {
    for (const p of [3055, 3056, 3057, 3060, 3070, 3170, 3270, 3274]) {
      expect(isReservedServicePort(p), `${p} must be reserved`).toBe(true);
    }
    expect(isReservedServicePort(3068)).toBe(false); // mobile-voice base is walkable
    expect(RESERVED_SERVICE_PORTS.has(3076)).toBe(false); // desktop-voice base is walkable
  });

  it('mobile-voice walk skips a reserved base instead of binding it', async () => {
    vi.stubEnv('MOBILE_VOICE_WS_PORT', '3070'); // the EI-294 port
    startMobileVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3071); // 3070 skipped, never constructed
    expect(constructedPorts).not.toContain(3070);
    expect(getMobileVoicePort()).toBe(3071);
  });

  it('desktop-voice walk skips a reserved base instead of binding it', async () => {
    vi.stubEnv('DESKTOP_VOICE_WS_PORT', '3170');
    startDesktopVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3171);
    expect(constructedPorts).not.toContain(3170);
    expect(getDesktopVoicePort()).toBe(3171);
  });

  it('a walk crossing consecutive reserved ports steps over all of them', async () => {
    vi.stubEnv('MOBILE_VOICE_WS_PORT', '3056');
    startMobileVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3058); // 3056 + 3057 reserved → lands on 3058
  });
});
