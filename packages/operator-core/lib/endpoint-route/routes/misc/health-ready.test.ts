/**
 * /api/health/ready (EI-368): readiness semantics — DBOS-enabled hosts are
 * ready only once DBOS launched; non-DBOS hosts are ready as soon as HTTP
 * serves. dbosStarted() reads a global flag, so the handler is testable by
 * setting the global directly (no PG, no DBOS).
 */
import { afterEach, describe, expect, it } from 'vitest';
import healthReady, { isReady } from './health-ready';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };
const ENV_KEYS = ['PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_HONO_PORT'] as const;
const origEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const origStarted = G.__papercuspDbosStarted;

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = origEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
  it('503 while a DBOS-LAUNCHING host (background-workers) is still migrating/launching', async () => {
    process.env.PAPERCUSP_DBOS_ENABLE = '1';
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1'; // a host that actually runs DBOS
    G.__papercuspDbosStarted = false;
    const { status, body } = await invoke();
    expect(status).toBe(503);
    expect(body).toMatchObject({ ready: false, dbos: false, dbosEnabled: true });
  });

  it('200 once DBOS launched (on a DBOS-launching host)', async () => {
    process.env.PAPERCUSP_DBOS_ENABLE = '1';
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    G.__papercuspDbosStarted = true;
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, dbos: true, dbosEnabled: true });
  });

  it('200 on a request-only host (BACKGROUND_WORKERS=0) with DBOS enabled but not launched (the false-503 fix)', async () => {
    // A request-only host (e.g. :3070) sources the shared .env.local (DBOS_ENABLE=1)
    // but delegates DBOS to the bg-host, so dbosStarted() is false BY DESIGN. It must
    // be READY — it serves requests fine — not perpetually 503.
    process.env.PAPERCUSP_DBOS_ENABLE = '1';
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    G.__papercuspDbosStarted = false;
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, dbos: false, dbosEnabled: false });
  });

  it('200 immediately on a host that never enables DBOS', async () => {
    delete process.env.PAPERCUSP_DBOS_ENABLE;
    G.__papercuspDbosStarted = false;
    const { status, body } = await invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, dbos: false, dbosEnabled: false });
  });
});
