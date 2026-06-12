/**
 * /api/health/ready (EI-368): readiness semantics — DBOS-enabled hosts are
 * ready only once DBOS launched; non-DBOS hosts are ready as soon as HTTP
 * serves. dbosStarted() reads a global flag, so the handler is testable by
 * setting the global directly (no PG, no DBOS).
 */
import { afterEach, describe, expect, it } from 'vitest';
import healthReady, { isReady } from './health-ready';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };
const origEnable = process.env.PAPERCUSP_DBOS_ENABLE;
const origStarted = G.__papercuspDbosStarted;

afterEach(() => {
  if (origEnable === undefined) delete process.env.PAPERCUSP_DBOS_ENABLE;
  else process.env.PAPERCUSP_DBOS_ENABLE = origEnable;
  G.__papercuspDbosStarted = origStarted;
});

async function invoke(): Promise<{ status: number; body: { ready: boolean; dbos: boolean; dbosEnabled: boolean } }> {
  const handler = (healthReady as unknown as { handler: () => Response | Promise<Response> }).handler;
  const res = await handler();
  return { status: res.status, body: (await res.json()) as { ready: boolean; dbos: boolean; dbosEnabled: boolean } };
}

describe('isReady', () => {
  it('gates on DBOS launch only when DBOS is enabled', () => {
    expect(isReady({ dbosEnabled: true, dbosLaunched: false })).toBe(false);
    expect(isReady({ dbosEnabled: true, dbosLaunched: true })).toBe(true);
    expect(isReady({ dbosEnabled: false, dbosLaunched: false })).toBe(true);
  });
});

describe('GET /api/health/ready', () => {
  it('503 while a DBOS-enabled host is still migrating/launching', async () => {
    process.env.PAPERCUSP_DBOS_ENABLE = '1';
    G.__papercuspDbosStarted = false;
    const { status, body } = await invoke();
    expect(status).toBe(503);
    expect(body).toMatchObject({ ready: false, dbos: false, dbosEnabled: true });
  });

  it('200 once DBOS launched', async () => {
    process.env.PAPERCUSP_DBOS_ENABLE = '1';
    G.__papercuspDbosStarted = true;
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, dbos: true, dbosEnabled: true });
  });

  it('200 immediately on a host that never enables DBOS', async () => {
    delete process.env.PAPERCUSP_DBOS_ENABLE;
    G.__papercuspDbosStarted = false;
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, dbos: false, dbosEnabled: false });
  });
});
