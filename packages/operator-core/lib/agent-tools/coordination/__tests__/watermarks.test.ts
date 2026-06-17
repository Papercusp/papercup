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

describe('writeWatermark ts-cursor ordering (P1-11 — at-least-once, NOT clamped)', () => {
  // P1-11 investigated whether writeWatermark should be MONOTONIC (clamp each ts
  // cursor to max(current, patch)) to stop re-delivery. It must NOT: the
  // watermark protocol is *at-least-once, never a skip* — a consumer that ends
  // consumption mid-(same-ts)-group commits the previous DISTINCT ts, which
  // ROLLS THE CURSOR BACK so the unconsumed siblings are re-seen on restart
  // (the documented safe-commit recovery, watermark-crash-restart.integration).
  // A max-clamp here would turn that deliberate re-delivery into a SKIP. So the
  // cursor is plain last-write-wins and a backward write is honoured; these
  // tests pin that contract so a future "add a monotonic guard" change has to
  // confront the at-least-once recovery it would break.
  const T1 = '2026-05-20T10:00:00.000Z';
  const T2 = '2026-05-20T12:00:00.000Z';

  it('a later ts advances the cursor (the normal forward turn-end commit)', async () => {
    await writeWatermark('agent-a', { messages_since_ts: T1 });
    const ret = await writeWatermark('agent-a', { messages_since_ts: T2 });
    expect(ret.messages_since_ts).toBe(T2);
    expect((await readWatermark('agent-a')).messages_since_ts).toBe(T2);
  });

  it('an EARLIER ts rolls the cursor back — the safe-commit at-least-once recovery', async () => {
    await writeWatermark('agent-a', { messages_since_ts: T2 });
    const ret = await writeWatermark('agent-a', { messages_since_ts: T1 });
    // Honoured, not clamped: re-delivery of the T1..T2 window is at-least-once
    // by design (never a skip), so the persisted cursor is the rolled-back T1.
    expect(ret.messages_since_ts).toBe(T1);
    expect((await readWatermark('agent-a')).messages_since_ts).toBe(T1);
  });

  it('every ts cursor is independently last-write-wins (backward rolls all three)', async () => {
    await writeWatermark('agent-a', {
      messages_since_ts: T2,
      escalations_since_ts: T2,
      plan_events_since_ts: T2,
    });
    await writeWatermark('agent-a', {
      messages_since_ts: T1,
      escalations_since_ts: T1,
      plan_events_since_ts: T1,
    });
    const wm = await readWatermark('agent-a');
    expect(wm.messages_since_ts).toBe(T1);
    expect(wm.escalations_since_ts).toBe(T1);
    expect(wm.plan_events_since_ts).toBe(T1);
  });

  it('a non-cursor-only write (subscriptions_fired) leaves an established ts cursor untouched', async () => {
    await writeWatermark('agent-a', { messages_since_ts: T2 });
    // Omitted ts fields keep their value — a subscriptions_fired write must not
    // reset messages_since_ts to ''.
    const ret = await writeWatermark('agent-a', { subscriptions_fired: ['m1'] });
    expect(ret.messages_since_ts).toBe(T2);
    expect(ret.subscriptions_fired).toEqual(['m1']);
  });
});
