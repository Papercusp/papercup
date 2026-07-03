/**
 * accept-delegated-seats.test — the per-host "accept delegated seats" trust gate
 * (agent-allocation-framework P-008 / D-006). Verifies the gate is FAIL-CLOSED by
 * default and that the enforcement guard throws a stable-coded error when the host
 * has not opted in.
 *
 * The flag is forced via the highest-precedence `PAPERCUSP_FLAG_*` env override, so
 * these are pure unit tests (no DB / no PostHog): resolveEnvOverride short-circuits
 * getFlag before it touches the stored-override store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FLAG_DEFAULTS, FLAGS } from '@papercusp/flags';
import {
  DelegatedSeatsDisabledError,
  assertHostAcceptsDelegatedSeats,
  hostAcceptsDelegatedSeats,
} from './accept-delegated-seats';

// PAPERCUSP_FLAG_${KEY.toUpperCase().replace(/-/g,'_')} — see libs/flags/src/server.ts resolveEnvOverride.
const ENV_KEY = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPT_DELEGATED_SEATS';

describe('accept-delegated-seats gate (P-008 / D-006)', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prev;
  });

  it('is FAIL-CLOSED: the ACCEPT_DELEGATED_SEATS flag defaults OFF', () => {
    // The whole trust model rests on this default — a fresh host must honor no
    // remote-owner spawns until its owner opts in.
    expect(FLAG_DEFAULTS[FLAGS.ACCEPT_DELEGATED_SEATS]).toBe(false);
  });

  it('hostAcceptsDelegatedSeats() is false when the host has not opted in', async () => {
    process.env[ENV_KEY] = 'false';
    expect(await hostAcceptsDelegatedSeats()).toBe(false);
  });

  it('hostAcceptsDelegatedSeats() is true once the host opts in', async () => {
    process.env[ENV_KEY] = 'true';
    expect(await hostAcceptsDelegatedSeats()).toBe(true);
  });

  it('assertHostAcceptsDelegatedSeats() throws DelegatedSeatsDisabledError when OFF', async () => {
    process.env[ENV_KEY] = 'false';
    await expect(assertHostAcceptsDelegatedSeats()).rejects.toBeInstanceOf(
      DelegatedSeatsDisabledError,
    );
    // stable machine code for the honor path to branch on
    await assertHostAcceptsDelegatedSeats().catch((e: unknown) => {
      expect((e as DelegatedSeatsDisabledError).code).toBe('accept_delegated_seats_disabled');
    });
  });

  it('assertHostAcceptsDelegatedSeats() resolves when the host has opted in', async () => {
    process.env[ENV_KEY] = 'true';
    await expect(assertHostAcceptsDelegatedSeats()).resolves.toBeUndefined();
  });
});
