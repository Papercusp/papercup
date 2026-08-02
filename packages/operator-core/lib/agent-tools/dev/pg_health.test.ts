/**
 * dev:pg_health surfaces a latched store-identity violation
 * (plan outage-must-not-be-silent-2026-08-02, D-004).
 *
 * The guard's DETECTION is tested in the db package. What is tested here is DELIVERY — that
 * the verdict reaches a surface an agent actually reads while diagnosing. On 2026-08-02 six
 * separate guards were active and the outage still read as silence, because every one of them
 * reported into a log file or a service journal. A guard nobody is shown has not spoken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dev-data', () => ({
  pgHealth: vi.fn(async () => ({ version: 'PostgreSQL 16.4', total: 12, active: 3, idle: 9 })),
}));

import {
  _resetStoreIdentityForTests,
  pinOrVerifyStoreIdentity,
} from '@papercusp/db-org';
import pgHealthTool from './pg_health';

const OURS = { systemIdentifier: '7635091775813704249', database: 'papercusp' };
const IMPOSTOR = { systemIdentifier: '7111222333444555666', database: 'papercusp' };

// Via `unknown`: the tool's declared arg/event generics do not overlap this narrowed shape,
// and TS2352 correctly refuses the direct assertion.
const run = () =>
  (pgHealthTool as unknown as {
    handler: (a: unknown) => Promise<{ data: Record<string, any> }>;
  }).handler({});

beforeEach(() => {
  _resetStoreIdentityForTests();
});

describe('dev:pg_health store-identity delivery', () => {
  it('OMITS the field entirely when no violation is latched', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    const { data } = await run();

    // Deliberately absent rather than `false`: an absent check and a passed check must not
    // look alike, so a reader can never mistake "never ran" for "cleared".
    expect(data).not.toHaveProperty('storeIdentityViolation');
    expect(data.version).toBe('PostgreSQL 16.4');
  });

  it('SURFACES the violation, and says the thing that stops the wrong conclusion', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const { data } = await run();
    const v = data.storeIdentityViolation;

    expect(v).toBeTruthy();
    expect(v.severity).toBe('critical');
    // The single most costly misreading of this outage: `not_found` taken as deletion.
    expect(v.whatThisMeans).toMatch(/NOT evidence of data loss/i);
    expect(v.whatThisMeans).toMatch(/do not delete/i);
    expect(v.observed.url).toContain('22060');
    expect(v.pinned.systemIdentifier).toBe(OURS.systemIdentifier);
  });

  it('still returns the ordinary health payload alongside the violation', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const { data } = await run();

    // The violation must AUGMENT the answer, never replace it — an agent polling health
    // during an incident still needs the connection counts.
    expect(data.version).toBe('PostgreSQL 16.4');
    expect(data.active).toBe(3);
    expect(data.storeIdentityViolation).toBeTruthy();
  });

  it('leaks no credentials into the surfaced verdict', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://harness_admin:secret@localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://harness_admin:secret@127.0.0.1:22060/papercusp');

    const { data } = await run();

    expect(JSON.stringify(data)).not.toContain('secret');
  });
});
