/**
 * `resolveCensusScope` — the shared scope resolver (P-004, Decision D-011).
 *
 * WHAT THIS FILE IS REALLY GUARDING. The defect D-011 fixed was not a wrong value; it was
 * an UNRESOLVABLE one. Attribution demanded env variables that nothing sets, so its scope
 * lookup returned null on every flush and the layer silently wrote nothing. The property
 * that prevents a recurrence is TOTALITY — the resolver must always answer — so the
 * totality case below is the load-bearing test, not the precedence ones.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_PIN_ENV,
  WORKSPACE_PIN_ENV,
  resolveCensusScope,
} from './scope';

const ALL_PINS = [...WORKSPACE_PIN_ENV, ...HARNESS_PIN_ENV];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ALL_PINS.map((k) => [k, process.env[k]]));
  for (const k of ALL_PINS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveCensusScope', () => {
  it('ALWAYS resolves both halves, with no pins set at all', () => {
    // The regression test for the original defect. Before D-011 the equivalent lookup
    // returned null here — which is exactly the state every real run was in.
    const scope = resolveCensusScope();

    expect(scope.workspaceId).toBeTruthy();
    expect(scope.harnessSlug).toBeTruthy();
    expect(typeof scope.workspaceId).toBe('string');
    expect(typeof scope.harnessSlug).toBe('string');
  });

  it('prefers an explicit pin over the ambient answer, on both halves', () => {
    const ambient = resolveCensusScope();
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-pinned';
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'harness-pinned';

    expect(resolveCensusScope()).toEqual({
      workspaceId: 'ws-pinned',
      harnessSlug: 'harness-pinned',
    });
    // Guard against a vacuous pass: the pin must have actually CHANGED something.
    expect(ambient.workspaceId).not.toBe('ws-pinned');
  });

  it('pins each half independently — one pin does not force the other to a default', () => {
    const ambient = resolveCensusScope();
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'harness-only';

    const scope = resolveCensusScope();
    expect(scope.harnessSlug).toBe('harness-only');
    expect(scope.workspaceId).toBe(ambient.workspaceId);
  });

  it('reads the pin lists in their declared order', () => {
    // `HARNESS_PIN_ENV` mirrors the test-runs reporter's own precedence, so a run pinned
    // for `test_runs` attributes to the same harness. Asserting the order keeps the two
    // from silently diverging.
    expect(WORKSPACE_PIN_ENV[0]).toBe('PAPERCUSP_WORKSPACE_ID');
    expect(HARNESS_PIN_ENV[0]).toBe('PAPERCUSP_TEST_RUN_HARNESS');

    process.env[HARNESS_PIN_ENV[1]] = 'second';
    expect(resolveCensusScope().harnessSlug).toBe('second');

    process.env[HARNESS_PIN_ENV[0]] = 'first';
    expect(resolveCensusScope().harnessSlug).toBe('first');
  });

  it('treats a blank or whitespace-only pin as absent, not as an empty scope', () => {
    // An empty string is falsy in the old `||` chain but TRUTHY as a SQL literal — it
    // would have written evidence scoped to '' and joined it to nothing.
    const ambient = resolveCensusScope();
    process.env.PAPERCUSP_WORKSPACE_ID = '   ';

    expect(resolveCensusScope().workspaceId).toBe(ambient.workspaceId);
  });

  it('trims a pin rather than carrying stray whitespace into the join key', () => {
    process.env.PAPERCUSP_WORKSPACE_ID = '  ws-padded \n';
    expect(resolveCensusScope().workspaceId).toBe('ws-padded');
  });
});
