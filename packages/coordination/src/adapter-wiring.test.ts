/**
 * adapter-wiring.test.ts — proves the @papercusp/coordination PG-adapter
 * package's public surface is intact after the generic core was extracted to
 * @papercusp/pubsub-substrate (generalize-libs-to-generic #6).
 *
 * Two things to prove, without a live database:
 *  1. Every subpath barrel re-exports the generic seam + portable backends
 *     (from @papercusp/pubsub-substrate) AND the papercusp-bound PG backends.
 *  2. The conformance shim + a generic backend both resolve THROUGH the adapter
 *     package — so we run the in-memory CoordEventLog conformance suite via the
 *     `@papercusp/coordination/*` import paths the operator actually uses.
 *
 * The Pg* backends themselves are exercised against these same conformance
 * suites over a live `harness_shared` schema in the operator's integration
 * tests (packages/operator-core/.../coordination/__tests__/*-conformance.test.ts).
 */

import { describe, expect, it } from 'vitest';

import { newMsgId } from '@papercusp/coordination/core';
import {
  FsCoordLog,
  InMemoryCoordLog,
  PgCoordLog,
  ensureCoordEventLogTable,
  DEFAULT_COORD_WORKSPACE,
} from '@papercusp/coordination/event-log';
import { describeCoordEventLogConformance } from '@papercusp/coordination/event-log/conformance';
import { InMemoryPresenceStore, PgPresenceStore, PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { InMemoryWatermarkStore, PgWatermarkStore, ensureCoordWatermarksTable } from '@papercusp/coordination/watermark-store';

describe('@papercusp/coordination adapter wiring', () => {
  it('re-exports the generic event-log seam + portable backends', () => {
    expect(FsCoordLog).toBeTypeOf('function');
    expect(InMemoryCoordLog).toBeTypeOf('function');
    expect(newMsgId()).toMatch(/.+/);
    expect(DEFAULT_COORD_WORKSPACE).toBe('default');
  });

  it('keeps the papercusp-bound PG backends', () => {
    expect(PgCoordLog).toBeTypeOf('function');
    expect(ensureCoordEventLogTable).toBeTypeOf('function');
    expect(PgPresenceStore).toBeTypeOf('function');
    expect(PgWatermarkStore).toBeTypeOf('function');
    expect(ensureCoordWatermarksTable).toBeTypeOf('function');
  });

  it('re-exports the generic presence + watermark seams', () => {
    expect(InMemoryPresenceStore).toBeTypeOf('function');
    expect(InMemoryWatermarkStore).toBeTypeOf('function');
    expect(PRESENCE_STALE_MS).toBeGreaterThan(0);
  });
});

// The conformance shim + a generic backend both resolve through the adapter
// package — the strongest proof the re-export wiring is sound.
describeCoordEventLogConformance('InMemoryCoordLog (via @papercusp/coordination re-export)', async () => ({
  log: new InMemoryCoordLog(),
  cleanup: async () => {},
}));
