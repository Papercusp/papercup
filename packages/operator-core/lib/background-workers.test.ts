import { afterEach, describe, expect, it } from 'vitest';
import { backgroundWorkersEnabled } from './background-workers';

const saved = {
  VITEST: process.env.VITEST,
  PAPERCUSP_BACKGROUND_WORKERS: process.env.PAPERCUSP_BACKGROUND_WORKERS,
  PAPERCUSP_HONO_PORT: process.env.PAPERCUSP_HONO_PORT,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('backgroundWorkersEnabled (EI-126 / EI-312 leg 1)', () => {
  it('vitest workers NEVER run background machinery, whatever the env says', () => {
    process.env.VITEST = 'true'; // (it already is — explicit for the contract)
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(backgroundWorkersEnabled()).toBe(false);
  });

  it('explicit flag wins outside tests: 0 → off, anything else → on', () => {
    delete process.env.VITEST;
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    expect(backgroundWorkersEnabled()).toBe(false);
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    expect(backgroundWorkersEnabled()).toBe(true);
  });

  it('no flag: default ON, except the :3170 staging host (request-only by design)', () => {
    delete process.env.VITEST;
    delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
    process.env.PAPERCUSP_HONO_PORT = '3170';
    expect(backgroundWorkersEnabled()).toBe(false);
    process.env.PAPERCUSP_HONO_PORT = '3070';
    expect(backgroundWorkersEnabled()).toBe(true);
    delete process.env.PAPERCUSP_HONO_PORT;
    expect(backgroundWorkersEnabled()).toBe(true);
  });
});
