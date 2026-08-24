/**
 * orient assignments-scope disclosure (EI-18763132241176410).
 *
 * THE BUG: `coord:orient`'s roster leg (`me`) is read via `fleet:assignments` scoped
 * `{ agent: ownerId }` whenever the caller belongs to no fleet. That returns
 * `agents:1, claims:0` — and NOTHING in the payload said the query had been narrowed
 * to the caller, so an unmeasured zero rendered identically to a measured-empty one.
 * Measured live 2026-08-24 on harness papercusp, same minute, same harness:
 *   coord:orient .................... agents: 1,  claims: 0,  stalled_claims: 0
 *   fleet:assignments {harness} ..... agents: 39, claims: 51, stalled_claims: 3
 * `me.summary.population` does not close this: it reports which RESOLVED ROWS were
 * kept ("a row is in scope if this query resolved it"), never which population was
 * asked about, so the self-scoped read is self-consistently `candidates:1, counted:1`.
 * A Mug is deliberately fleetless and steers fleet-wide placement off this reading,
 * so it concludes the fleet is idle and ends the wake without seeing the stalled work.
 *
 * THE GUARD, per the filed recurrence criterion — a fleetless caller's orient must
 * either cover the harness or carry an EXPLICIT narrowing marker, never a bare
 * `agents:1`. Asserted against the real exported code, not a mirrored fixture.
 */
import { describe, expect, it } from 'vitest';
import { deriveAssignmentsScope, assembleOrientOutput } from './orient';
import { ORIENT_CORE_RESULT_KEYS, ORIENT_OPTIONAL_PRIORITY } from './orient-priority';

describe('deriveAssignmentsScope', () => {
  it('marks a fleetless (self-scoped) read as NOT covering peers — the recurrence guard', () => {
    const scope = deriveAssignmentsScope({ agent: 'su-e40dceb1', harness: 'papercusp' });

    // The one field that makes `agents:1 / claims:0` readable as NOT MEASURED.
    expect(scope.scope).toBe('self');
    expect(scope.coversPeers).toBe(false);
    expect(scope.ref).toBe('su-e40dceb1');

    // It must SAY so, not merely encode it — this is what a reader acts on.
    expect(scope.note).toMatch(/NARROW READING/);
    expect(scope.note).toMatch(/NOT MEASURED/);

    // And it must hand over the wider read rather than leaving it as an exercise.
    expect(scope.widerRead).toEqual({
      tool: 'fleet:assignments',
      args: { harness: 'papercusp', include_stale: true },
    });
  });

  it('marks a fleet-scoped read as covering peers', () => {
    const scope = deriveAssignmentsScope({ fleet: 'drain-squad', harness: 'papercusp' });
    expect(scope.scope).toBe('fleet');
    expect(scope.ref).toBe('drain-squad');
    expect(scope.coversPeers).toBe(true);
    expect(scope.note).toMatch(/MEASURED zero/);
  });

  it('marks an unfiltered harness read as covering peers', () => {
    const scope = deriveAssignmentsScope({ harness: 'papercusp' });
    expect(scope.scope).toBe('harness');
    expect(scope.ref).toBe('papercusp');
    expect(scope.coversPeers).toBe(true);
  });

  it('never claims peer coverage without an agent-widening scope', () => {
    // The invariant behind the field: coversPeers is TRUE only when the query was
    // not narrowed to a single agent. Stated as a property so a future scope value
    // cannot be added that quietly defaults to "covered".
    for (const args of [
      { agent: 'su-1', harness: 'papercusp' },
      { agent: 'su-1' },
      { fleet: 'f', harness: 'papercusp' },
      { harness: 'papercusp' },
      {},
    ]) {
      const scope = deriveAssignmentsScope(args);
      expect(scope.coversPeers).toBe(!('agent' in args && args.agent));
    }
  });

  it('reports the widest reading when nothing filters the query', () => {
    const scope = deriveAssignmentsScope({});
    expect(scope.scope).toBe('harness');
    expect(scope.ref).toBeNull();
    expect(scope.coversPeers).toBe(true);
    // No wider read exists to point at, so the pointer is absent rather than fabricated.
    expect(scope.widerRead).toBeUndefined();
  });
});

describe('assignmentsScope survives the result door', () => {
  it('is a CORE key, never an evictable optional leg', () => {
    // A disclosure evicted under budget pressure is missing exactly when payloads are
    // tight — which restores the silent narrow read it exists to make legible. Same
    // rationale that put `leaderBrief` in CORE.
    expect(ORIENT_CORE_RESULT_KEYS).toContain('assignmentsScope');

    const optionalFields = [...ORIENT_OPTIONAL_PRIORITY.tier3, ...ORIENT_OPTIONAL_PRIORITY.tier4].flatMap(
      (leg) => leg.fields as readonly string[],
    );
    expect(optionalFields).not.toContain('assignmentsScope');
  });

  it('is emitted by the real assembler ahead of the discretionary folds', () => {
    const out = assembleOrientOutput({
      result: {
        ok: true,
        me: { summary: { agents: 1, claims: 0 } },
        assignmentsScope: deriveAssignmentsScope({ agent: 'su-1', harness: 'papercusp' }),
        memory: { hits: [] },
      },
    });

    expect(out.assignmentsScope).toBeDefined();
    expect((out.assignmentsScope as { coversPeers: boolean }).coversPeers).toBe(false);

    const keys = Object.keys(out);
    expect(keys.indexOf('assignmentsScope')).toBeGreaterThan(-1);
    expect(keys.indexOf('assignmentsScope')).toBeLessThan(keys.indexOf('memory'));
  });
});
