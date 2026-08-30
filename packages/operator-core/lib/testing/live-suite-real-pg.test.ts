/**
 * The recurrence guard for WI-1199821.
 *
 * `allowRealPgForLiveSuite` deliberately punches a hole in the unit layer's
 * PAPERCUSP_FORBID_REAL_PG rail so an env-gated LIVE-HARDWARE suite can drive the real
 * production path. The value of that hole is entirely in its edges: it must open ONLY
 * under the caller's own live gate, and it must close again. A leak is not loud — the
 * symptom is some unrelated unit test quietly opening a real Postgres connection later in
 * the same vitest worker, which surfaces nowhere near the file that caused it. So these
 * assertions are the only thing standing between the deliberate opt-in and a silent
 * tree-wide disarm.
 *
 * Every case below manipulates only its own copy of the env var and restores it in
 * afterEach, so this file cannot itself disturb the rail for its neighbours.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeRealPgGateForLiveSuite } from './live-suite-real-pg';

const VAR = 'PAPERCUSP_FORBID_REAL_PG';

describe('makeRealPgGateForLiveSuite — the live-suite real-PG opt-out', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[VAR];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it('does NOTHING when the suite is not live — the rail stays armed', () => {
    process.env[VAR] = '1';
    const gate = makeRealPgGateForLiveSuite(false);

    gate.lift();
    expect(process.env[VAR]).toBe('1');

    gate.restore();
    expect(process.env[VAR]).toBe('1');
  });

  it('lifts the rail for a live suite and puts it back exactly as it found it', () => {
    process.env[VAR] = '1';
    const gate = makeRealPgGateForLiveSuite(true);

    gate.lift();
    expect(process.env[VAR]).toBeUndefined();

    gate.restore();
    expect(process.env[VAR]).toBe('1');
  });

  it('restores ABSENCE rather than inventing a value the rail never had', () => {
    // The integration layer never sets this var. If a live suite ran there, restoring a
    // fabricated '1' would arm a rail that was deliberately off — the mirror-image bug.
    delete process.env[VAR];
    const gate = makeRealPgGateForLiveSuite(true);

    gate.lift();
    expect(process.env[VAR]).toBeUndefined();

    gate.restore();
    expect(VAR in process.env).toBe(false);
  });

  it('writes nothing when restore runs without its lift', () => {
    // The security-relevant case: a hook-ordering surprise or an aborted suite can fire
    // the teardown alone. Guarding restore on `lifted` rather than on `liveEnabled` is
    // what stops that from writing the env — which, for a live gate, would DISARM the
    // rail for whatever file runs next in this worker.
    process.env[VAR] = '1';
    const gate = makeRealPgGateForLiveSuite(true);

    gate.restore();
    expect(process.env[VAR]).toBe('1');
  });

  it('is idempotent — a second restore cannot re-write the env', () => {
    process.env[VAR] = '1';
    const gate = makeRealPgGateForLiveSuite(true);

    gate.lift();
    gate.restore();
    expect(process.env[VAR]).toBe('1');

    // Simulate the rail having been legitimately changed by someone else after this gate
    // was done with it. A second restore must not clobber that.
    process.env[VAR] = 'someone-elses-value';
    gate.restore();
    expect(process.env[VAR]).toBe('someone-elses-value');
  });

  it('keeps two concurrent gates independent', () => {
    // Suites share a worker, so two gates can exist at once. Neither may observe or undo
    // the other's state.
    process.env[VAR] = '1';
    const live = makeRealPgGateForLiveSuite(true);
    const inert = makeRealPgGateForLiveSuite(false);

    live.lift();
    inert.lift();
    expect(process.env[VAR]).toBeUndefined();

    inert.restore();
    // The inert gate lifted nothing, so it must not resurrect the rail while the live
    // suite is still running against it.
    expect(process.env[VAR]).toBeUndefined();

    live.restore();
    expect(process.env[VAR]).toBe('1');
  });
});
