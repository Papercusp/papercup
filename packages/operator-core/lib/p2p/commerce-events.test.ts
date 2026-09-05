import { describe, expect, it } from 'vitest';
import { commerceEventDigest, commerceEventSigningBytes, reduceCommerceEvents, validateCommerceEvent, type CommerceEvent } from './commerce-events';

const event = (overrides: Partial<CommerceEvent> = {}): CommerceEvent => ({
  eventId: 'evt-1', streamId: 'order-1', kind: 'order', version: 1, issuer: 'buyer-1', sequence: 0,
  occurredAtMs: 1_000, idempotencyKey: 'idem-1', payload: { offerId: 'offer-1' }, signature: 'sig', ...overrides,
});

describe('P2P commerce events', () => {
  it('canonicalizes and validates signed event envelopes', () => {
    const e = event();
    expect(commerceEventSigningBytes({ ...e, signature: undefined as never })).toBeInstanceOf(Buffer);
    expect(commerceEventDigest({ ...e, signature: undefined as never })).toMatch(/^[0-9a-f]{64}$/);
    expect(validateCommerceEvent(e)).toEqual({ ok: true, event: e });
    expect(validateCommerceEvent({ ...e, kind: 'not-a-kind' }).ok).toBe(false);
  });

  it('deduplicates exact retries and quarantines sequence/idempotency conflicts', () => {
    const same = event();
    const sequenceConflict = event({ eventId: 'evt-2', idempotencyKey: 'idem-2' });
    const idempotencyConflict = event({ eventId: 'evt-3', sequence: 1 });
    const result = reduceCommerceEvents([same, same, sequenceConflict, idempotencyConflict]);
    expect(result.duplicates).toEqual(['evt-1']);
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'sequence-conflict' }),
      expect.objectContaining({ reason: 'idempotency-conflict' }),
    ]));
    expect(result.accepted).toHaveLength(0);
  });

  it('sorts independent streams deterministically and rejects malformed facts', () => {
    const result = reduceCommerceEvents([event({ eventId: 'b', streamId: 'z', sequence: 1, idempotencyKey: 'idem-b' }), event({ eventId: 'a', streamId: 'a', sequence: 2, idempotencyKey: 'idem-a' }), { eventId: 'bad' }]);
    expect(result.accepted.map((e) => e.eventId)).toEqual(['a', 'b']);
    expect(result.invalid).toHaveLength(1);
  });
});
