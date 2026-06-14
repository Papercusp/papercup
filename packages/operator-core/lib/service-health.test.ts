/**
 * diffHealth — pure transition detector (fleet-coordination-painpoints P-017).
 */
import { describe, it, expect } from 'vitest';
import { diffHealth, HEALTH_ENDPOINTS, type ProbeResult } from './service-health';

const r = (name: string, up: boolean): ProbeResult => ({
  name,
  up,
  status: up ? 200 : null,
  latencyMs: 1,
});

describe('diffHealth', () => {
  it('alerts a first-seen DOWN but stays silent on a first-seen UP (no startup spam)', () => {
    const { transitions, next } = diffHealth({}, [r('a', false), r('b', true)]);
    expect(transitions).toEqual([{ name: 'a', to: 'down' }]);
    expect(next).toEqual({ a: false, b: true });
  });

  it('reports only the endpoints that changed (up→down and down→up)', () => {
    const { transitions } = diffHealth({ a: true, b: false, c: true }, [
      r('a', false),
      r('b', true),
      r('c', true),
    ]);
    expect(transitions).toEqual([
      { name: 'a', to: 'down' },
      { name: 'b', to: 'up' },
    ]);
  });

  it('no change → no transitions', () => {
    expect(diffHealth({ a: true }, [r('a', true)]).transitions).toEqual([]);
  });

  // A `present: false` result is a legitimately-absent service (the desktop is
  // not running) — it must never produce a phantom DOWN/recovered (P-019).
  const absent = (name: string): ProbeResult => ({
    name,
    up: false,
    present: false,
    status: null,
    latencyMs: 1,
  });

  it('skips an absent (present:false) service — no transition, drops its state', () => {
    const { transitions, next } = diffHealth({}, [absent('desktop'), r('a', true)]);
    expect(transitions).toEqual([]); // desktop absent → no DOWN; a first-seen-up → silent
    expect(next).toEqual({ a: true }); // desktop not carried forward
  });

  it('a previously-up service going absent does NOT alert and is forgotten', () => {
    const { transitions, next } = diffHealth({ desktop: true }, [absent('desktop')]);
    expect(transitions).toEqual([]);
    expect(next.desktop).toBeUndefined();
  });

  it('a present desktop that is down DOES alert (running but unhealthy)', () => {
    const present: ProbeResult = { name: 'desktop', up: false, present: true, status: null, latencyMs: 1 };
    const { transitions } = diffHealth({ desktop: true }, [present]);
    expect(transitions).toEqual([{ name: 'desktop', to: 'down' }]);
  });
});

describe('HEALTH_ENDPOINTS', () => {
  // EI-188: the retired standalone web app (:3001 — the "old Restart web app",
  // never running in this deployment) must NOT be monitored, or the watchdog
  // re-captures a phantom "web is DOWN" improvement every cycle.
  it('does not monitor the retired web app (:3001)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'web')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':3001'))).toBe(false);
  });

  // EI-276: the Restart shop storefront (:4321) is not part of the running stack;
  // probing it re-broadcast a phantom "shop is DOWN" on every restart/deploy and
  // fed the EI-187 CRITICAL. Must NOT be monitored.
  it('does not monitor the retired shop storefront (:4321)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'shop')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':4321'))).toBe(false);
  });

  // The live set we DO watch — a guard so a retired surface can't quietly creep
  // back in (any new entry here is a deliberate edit + a failing test to update).
  it('watches exactly the live dev services', () => {
    expect(HEALTH_ENDPOINTS.map((e) => e.name).sort()).toEqual(
      ['code-server', 'operator', 'scout', 'vite'].sort(),
    );
  });
});
