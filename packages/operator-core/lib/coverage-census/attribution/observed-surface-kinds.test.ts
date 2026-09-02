/**
 * P-008 (plan `design-to-code-coverage-seam-2026-09-02`).
 *
 * `OBSERVED_SURFACE_KINDS` is the set the coverage floor spends to tell an ACTIONABLE gap
 * queue from an unactionable one: a censused surface whose kind nothing observes can never
 * acquire traffic evidence, so it sits at the bottom of the ladder forever no matter how
 * many tests are written for it. That makes the set load-bearing, and a hand-maintained
 * list of what some other module emits is exactly the code-describing metadata the
 * derived-truth ladder says will drift — silently, and in the direction that flatters.
 *
 * So this file does not compare the set against a second list. It DRIVES the real `record*`
 * entry points with the sink armed and reads back what they actually emitted, which makes
 * the set derived from behaviour (rung 2: pinned) rather than asserted.
 *
 * THE PART THAT CATCHES THE REAL REGRESSION IS THE REFLECTIVE ENUMERATION. Adding a third
 * observer — `recordSyncQueryTraffic`, say — while leaving the set at two would make every
 * sync-query surface keep counting as unobservable, so the floor would keep excusing a gap
 * queue that had just become real work. A test naming only the two known entry points
 * cannot see that; enumerating the module's `record*` exports can, because the new function
 * appears in the enumeration the moment it is exported.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncQueriesProvider, SYNC_QUERY_KIND } from '../providers/sync-queries';
import { ATTRIBUTION_ENV, resetAttributionArmingForTests, setAmbientTestContext } from './context';
import * as sinkModule from './sink';
import {
  HTTP_ROUTE_KIND,
  MCP_TOOL_KIND,
  OBSERVED_SURFACE_KINDS,
  peekBufferedEvidence,
  recordHttpTraffic,
  recordMcpTraffic,
  resetAttributionSinkForTests,
} from './sink';

let priorArming: string | undefined;

beforeEach(() => {
  priorArming = process.env[ATTRIBUTION_ENV];
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  process.env[ATTRIBUTION_ENV] = '1';
  resetAttributionArmingForTests();
});

afterEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  if (priorArming === undefined) delete process.env[ATTRIBUTION_ENV];
  else process.env[ATTRIBUTION_ENV] = priorArming;
  resetAttributionArmingForTests();
});

/** Every kind the sink actually buffered, deduplicated. */
function emittedKinds(): string[] {
  return [...new Set(peekBufferedEvidence().map((b) => b.kind))].sort();
}

describe('OBSERVED_SURFACE_KINDS is derived from what the entry points emit', () => {
  it('every declared kind is emitted by a real entry point', () => {
    recordHttpTraffic({ method: 'GET', path: '/probe', status: 'ok', httpStatus: 200 });
    recordMcpTraffic({ toolName: 'probe:verb', status: 'ok' });

    expect(emittedKinds()).toEqual([...OBSERVED_SURFACE_KINDS].sort());
  });

  it('every emitted kind is declared — neither direction may drift alone', () => {
    recordHttpTraffic({ method: 'GET', path: '/probe', status: 'ok', httpStatus: 200 });
    recordMcpTraffic({ toolName: 'probe:verb', status: 'ok' });

    for (const kind of emittedKinds()) {
      expect(OBSERVED_SURFACE_KINDS).toContain(kind);
    }
    expect(OBSERVED_SURFACE_KINDS).toEqual([HTTP_ROUTE_KIND, MCP_TOOL_KIND]);
  });

  /**
   * The regression this file exists for. Not a style check: the count of `record*` exports
   * is the only signal available BEFORE someone remembers to update the set, and a third
   * observer landing silently is what would make the floor excuse real work.
   */
  it('no record* entry point exists that the declared set does not account for', () => {
    const entryPoints = Object.keys(sinkModule)
      .filter((k) => /^record[A-Z]/.test(k))
      .sort();

    expect(entryPoints).toEqual(['recordHttpTraffic', 'recordMcpTraffic']);
    expect(entryPoints).toHaveLength(OBSERVED_SURFACE_KINDS.length);
  });
});

describe('the unobservable population is real, not a modelling artifact', () => {
  /**
   * NEGATIVE CONTROL. The census enumerates `sync-query` surfaces and nothing observes
   * them — the 251-surface finding D-013 reports. If this ever fails because an observer
   * was added, the set above is what must change with it; if it fails because the provider
   * was retired, the coverage floor's `unobservable` slice shrinks to match.
   */
  it('sync-query is censused but no entry point emits it', () => {
    expect(syncQueriesProvider.kinds).toContain(SYNC_QUERY_KIND);
    expect(OBSERVED_SURFACE_KINDS).not.toContain(SYNC_QUERY_KIND);

    recordHttpTraffic({ method: 'GET', path: '/probe', status: 'ok', httpStatus: 200 });
    recordMcpTraffic({ toolName: 'probe:verb', status: 'ok' });

    expect(emittedKinds()).not.toContain(SYNC_QUERY_KIND);
  });

  /**
   * CALIBRATION. Without this, every assertion above would still pass if the sink silently
   * stopped buffering — an empty `emittedKinds()` satisfies "contains no sync-query" just
   * as well as a correct one does. Proving the instrument observes SOMETHING is what makes
   * the negative results above evidence rather than a broken probe reading zero.
   */
  it('the probe observes something — the negatives are evidence, not an empty instrument', () => {
    recordHttpTraffic({ method: 'GET', path: '/probe', status: 'ok', httpStatus: 200 });

    expect(peekBufferedEvidence().length).toBeGreaterThan(0);
    expect(emittedKinds()).toContain(HTTP_ROUTE_KIND);
  });
});
