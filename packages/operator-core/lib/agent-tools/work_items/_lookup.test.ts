/**
 * WI-6746 — a failed work-item read must never render as "the item is absent".
 *
 * `getWorkItem` returns null ONLY for a zero-row result; it never catches, so a PG
 * fault throws through it. The `.catch(() => null)` idiom these sites used erased
 * that distinction, and two SAFETY GUARDS derived their refusal from the erased
 * value — so both failed OPEN exactly when the database was unhealthy.
 *
 * These suites pin the distinction itself (lookupWorkItem) and the two fail-closed
 * guards it exists to protect. The guard suites inject a THROWING read, which is
 * the only way to tell a fail-open guard from a working one: with a healthy read
 * both versions behave identically, which is why this survived in the source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getWorkItem = vi.fn();
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
}));

import { lookupWorkItem, itemOrNullForDecoration, type WorkItemLookup } from './_lookup';

const ITEM = { id: 'WI-1', harness: 'papercusp', assignee: null, payload: {} } as never;

beforeEach(() => {
  getWorkItem.mockReset();
});

describe('lookupWorkItem — the three outcomes are distinct', () => {
  it('a matched row is `found` and carries the item', async () => {
    getWorkItem.mockResolvedValue(ITEM);
    const r = await lookupWorkItem('WI-1', 'papercusp');
    expect(r.status).toBe('found');
    expect(r.status === 'found' && r.item).toBe(ITEM);
  });

  it('a zero-row result is `missing` — the honest not-found', async () => {
    getWorkItem.mockResolvedValue(null);
    expect((await lookupWorkItem('WI-1')).status).toBe('missing');
  });

  it('a THROWN read is `unreadable`, NOT `missing` — the whole point', async () => {
    getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const r = await lookupWorkItem('WI-1');
    expect(r.status).toBe('unreadable');
    expect(r.status === 'unreadable' && r.error).toContain('connection terminated');
  });

  it('never throws — callers still get a value to branch on', async () => {
    getWorkItem.mockRejectedValue(new Error('boom'));
    await expect(lookupWorkItem('WI-1')).resolves.toBeDefined();
  });

  it('a non-Error throw still renders, and a huge message is bounded', async () => {
    getWorkItem.mockRejectedValue('plain string failure');
    expect((await lookupWorkItem('WI-1')) as WorkItemLookup).toMatchObject({
      status: 'unreadable',
      error: 'plain string failure',
    });

    getWorkItem.mockRejectedValue(new Error('x'.repeat(5000)));
    const big = await lookupWorkItem('WI-1');
    expect(big.status === 'unreadable' && big.error.length).toBeLessThanOrEqual(200);
  });

  it('the union has no value a read failure can be truthy-tested into', async () => {
    // The regression this type exists to prevent: `if (lookup)` is true for ALL
    // three outcomes, so a caller MUST match on `status`. This asserts the shape
    // that forces it — an `unreadable` result carries no `item` to fall back on.
    getWorkItem.mockRejectedValue(new Error('down'));
    const r = await lookupWorkItem('WI-1');
    expect(r).toBeTruthy();
    expect(r).not.toHaveProperty('item');
  });
});

describe('itemOrNullForDecoration — the explicitly-opted-in benign form', () => {
  it('collapses missing AND unreadable to null, but only where opted in by name', async () => {
    getWorkItem.mockResolvedValue(null);
    expect(itemOrNullForDecoration(await lookupWorkItem('WI-1'))).toBeNull();
    getWorkItem.mockRejectedValue(new Error('down'));
    expect(itemOrNullForDecoration(await lookupWorkItem('WI-1'))).toBeNull();
    getWorkItem.mockResolvedValue(ITEM);
    expect(itemOrNullForDecoration(await lookupWorkItem('WI-1'))).toBe(ITEM);
  });
});
