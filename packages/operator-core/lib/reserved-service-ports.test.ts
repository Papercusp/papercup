/**
 * reserved-service-ports (EI-294) — the canonical never-squat port set, and
 * BOTH voice-WS port-walks honoring it. The incident class: a walker's
 * EADDRINUSE fallback steps onto a core service's canonical port during its
 * restart window, then the service crash-loops on EADDRINUSE behind a
 * WS-only listener answering 426s.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const constructedPorts: number[] = [];

vi.mock('ws', () => ({
  WebSocketServer: class extends EventEmitter {
    constructor(opts: { port: number }) {
      super();
      constructedPorts.push(opts.port);
      setTimeout(() => this.emit('listening'), 0);
    }
    close() {
      /* no socket */
    }
  },
}));

import { RESERVED_SERVICE_PORTS, isReservedServicePort } from './reserved-service-ports';

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  constructedPorts.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
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
    const mod = await import('./device-voice-ws');
    mod.startMobileVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3071); // 3070 skipped, never constructed
    expect(constructedPorts).not.toContain(3070);
    expect(mod.getMobileVoicePort()).toBe(3071);
    await mod._stopMobileVoiceWsForTests();
  });

  it('desktop-voice walk skips a reserved base instead of binding it', async () => {
    vi.stubEnv('DESKTOP_VOICE_WS_PORT', '3170');
    const mod = await import('./voice-node/desktop-voice-ws');
    mod.startDesktopVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3171);
    expect(constructedPorts).not.toContain(3170);
    expect(mod.getDesktopVoicePort()).toBe(3171);
    await mod._stopDesktopVoiceWsForTests();
  });

  it('a walk crossing consecutive reserved ports steps over all of them', async () => {
    vi.stubEnv('MOBILE_VOICE_WS_PORT', '3056');
    const mod = await import('./device-voice-ws');
    mod.startMobileVoiceWs();
    await tick();
    expect(constructedPorts[0]).toBe(3058); // 3056 + 3057 reserved → lands on 3058
    await mod._stopMobileVoiceWsForTests();
  });
});
