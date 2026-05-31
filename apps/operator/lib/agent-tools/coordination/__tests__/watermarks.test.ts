/**
 * Operator-level tests for watermarks (F-H2 — turn-start inbox scoping).
 *
 * Run against an in-memory WatermarkStore double — NO Postgres, NO live
 * `harness_shared.coord_watermarks`. After the FS→PG cutover the adapter
 * routes through `PgWatermarkStore`, so the old "pure filesystem, no PG"
 * fixture (PAPERCUSP_COORD_DIR + a malformed-file case) read/wrote the live
 * (workspace, owner) row and leaked state across tests. Injecting
 * `InMemoryWatermarkStore` via `configureWatermarkStore` is the fix. The
 * store's own read/write semantics (incl. defensive parse of a malformed
 * persisted value) are covered by the package watermark-store conformance
 * suite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryWatermarkStore } from '@papercusp/coordination/watermark-store';

import {
  configureWatermarkStore,
  emptyWatermark,
  readWatermark,
  resetWatermarkStore,
  writeWatermark,
} from '../watermarks';

beforeEach(() => {
  configureWatermarkStore(new InMemoryWatermarkStore());
});
afterEach(() => {
  resetWatermarkStore();
});

describe('readWatermark', () => {
  it('returns an empty watermark when nothing was ever written', async () => {
    expect(await readWatermark('agent-a')).toEqual(emptyWatermark());
  });

  it('round-trips a written watermark', async () => {
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T10:00:00.000Z' });
    const wm = await readWatermark('agent-a');
    expect(wm.messages_since_ts).toBe('2026-05-20T10:00:00.000Z');
  });
});

describe('writeWatermark', () => {
  it('is a partial update — omitted fields keep their value', async () => {
    await writeWatermark('agent-a', {
      messages_since_ts: '2026-05-20T10:00:00.000Z',
      escalations_since_ts: '2026-05-20T09:00:00.000Z',
    });
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T11:00:00.000Z' });
    const wm = await readWatermark('agent-a');
    expect(wm.messages_since_ts).toBe('2026-05-20T11:00:00.000Z');
    // escalations_since_ts untouched by the second partial write.
    expect(wm.escalations_since_ts).toBe('2026-05-20T09:00:00.000Z');
  });

  it('replaces subscriptions_fired wholesale when supplied', async () => {
    await writeWatermark('agent-a', { subscriptions_fired: ['m1', 'm2'] });
    await writeWatermark('agent-a', { subscriptions_fired: ['m3'] });
    expect((await readWatermark('agent-a')).subscriptions_fired).toEqual(['m3']);
  });

  it('keeps two agents independent', async () => {
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T10:00:00.000Z' });
    await writeWatermark('agent-b', { messages_since_ts: '2026-05-20T20:00:00.000Z' });
    expect((await readWatermark('agent-a')).messages_since_ts).toBe('2026-05-20T10:00:00.000Z');
    expect((await readWatermark('agent-b')).messages_since_ts).toBe('2026-05-20T20:00:00.000Z');
  });

  it('returns the merged watermark it persisted', async () => {
    const ret = await writeWatermark('agent-a', { plan_events_since_ts: '2026-05-20T12:00:00.000Z' });
    expect(ret.plan_events_since_ts).toBe('2026-05-20T12:00:00.000Z');
    expect(ret).toEqual(await readWatermark('agent-a'));
  });
});
