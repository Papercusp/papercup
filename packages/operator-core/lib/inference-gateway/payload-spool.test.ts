import { describe, expect, it } from 'vitest';
import { sha256Hex, type BlobStore } from '@papercusp/artifact-registry';
import {
  DEFAULT_MAX_SPOOL_BYTES,
  GATEWAY_PAYLOAD_ADDRESSING,
  PayloadSpoolPersistenceError,
  PayloadTooLargeError,
  memoryGatewayPayloadSpool,
} from './payload-spool';

const body = (text: string) => Buffer.from(text, 'utf8');

describe('gateway payload spool — content addressing', () => {
  it('returns the sha256 of the body as the payloadRef', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('{"model":"claude-3","messages":[]}');

    const result = await spool.spool(bytes);

    expect(result.payloadRef).toBe(await sha256Hex(bytes));
    expect(result.bytes).toBe(bytes.byteLength);
  });

  // REGRESSION GUARD. contentAddressing({ prefix: '' }) yields `/<hash>` because the
  // helper always joins with a separator. That leading slash would travel as the
  // admission payloadRef and violate migration 1022's
  // `blob_key ~ '^[0-9a-f]{64}$'` CHECK — a failure that only surfaces against a real
  // Postgres, long after the unit suite is green. Assert the shape here instead.
  it('produces a bare 64-char lowercase hex ref with no prefix or separator', async () => {
    const spool = memoryGatewayPayloadSpool();

    const { payloadRef } = await spool.spool(body('payload'));

    expect(payloadRef).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadRef).not.toContain('/');
  });

  it('keeps the storage key identical to the ref, so a reader holding the bytes can recompute it', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('recomputable');

    const { payloadRef } = await spool.spool(bytes);

    expect(GATEWAY_PAYLOAD_ADDRESSING.key(payloadRef!)).toBe(payloadRef);
    expect([...spool.data.keys()]).toEqual([payloadRef]);
  });
});

describe('gateway payload spool — D-004 retry idempotency', () => {
  it('dedupes an identical retried body onto one stored blob', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('{"idempotent":true}');

    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes)); // a distinct buffer, identical content

    expect(second.payloadRef).toBe(first.payloadRef);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    // The point of the property: a retry cannot spawn a second stored payload.
    expect(spool.data.size).toBe(1);
  });

  it('gives different bodies different refs', async () => {
    const spool = memoryGatewayPayloadSpool();

    const a = await spool.spool(body('request-a'));
    const b = await spool.spool(body('request-b'));

    expect(a.payloadRef).not.toBe(b.payloadRef);
    expect(spool.data.size).toBe(2);
  });
});

describe('gateway payload spool — round trip', () => {
  it('reads back the exact bytes, including non-UTF8 content', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xfe]);

    const { payloadRef } = await spool.spool(bytes);
    const readBack = await spool.read(payloadRef!);

    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack!, bytes)).toBe(0);
  });

  it('returns null for a ref that does not resolve', async () => {
    const spool = memoryGatewayPayloadSpool();

    expect(await spool.read('a'.repeat(64))).toBeNull();
  });

  it('returns null rather than throwing for a malformed ref', async () => {
    const spool = memoryGatewayPayloadSpool();

    expect(await spool.read('not-a-hash')).toBeNull();
  });
});

describe('gateway payload spool — bodies that are not spooled', () => {
  it('treats an empty body as nothing to spool rather than an error', async () => {
    const spool = memoryGatewayPayloadSpool();

    const result = await spool.spool(Buffer.alloc(0));

    // A null ref is the contract: there is nothing to replay, so admission simply
    // carries no payloadRef. An error here would reject legitimate bodyless requests.
    expect(result.payloadRef).toBeNull();
    expect(result.bytes).toBe(0);
    expect(spool.data.size).toBe(0);
  });

  it('rejects an oversize body with a typed error and stores nothing', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 16 });

    await expect(spool.spool(body('x'.repeat(17)))).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(spool.data.size).toBe(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 16 });

    const result = await spool.spool(body('x'.repeat(16)));

    expect(result.payloadRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults the ceiling to 32 MiB', () => {
    expect(DEFAULT_MAX_SPOOL_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('gateway payload spool — D-003 persistence failure never yields a false receipt', () => {
  // The whole point of D-003: a request may fail for "inability to persist truthfully".
  // What it must NEVER do is hand back a ref the gateway cannot later honour.
  const explodingStore = (): BlobStore<{ body: Uint8Array; size: number }> => ({
    head: async () => null,
    put: async () => {
      throw new Error('pg: connection terminated');
    },
    get: async () => null,
    delete: async () => {},
  });

  it('propagates a backend write failure instead of returning a ref', async () => {
    const { createGatewayPayloadSpool } = await import('./payload-spool');
    const spool = createGatewayPayloadSpool({ store: explodingStore() });

    await expect(spool.spool(body('will not persist'))).rejects.toThrow(/connection terminated/);
  });

  it('surfaces a non-413 store rejection as a typed persistence error', async () => {
    const { createGatewayPayloadSpool } = await import('./payload-spool');
    // A store that silently accepts the write but never stores it would make
    // putContentAddressed report success; the failure mode we guard is the store
    // REPORTING a problem, which must become PayloadSpoolPersistenceError.
    const rejectingStore: BlobStore<{ body: Uint8Array; size: number }> = {
      head: async () => null,
      put: async () => {
        throw new PayloadSpoolPersistenceError('inference-gateway: store unavailable', 503);
      },
      get: async () => null,
      delete: async () => {},
    };
    const spool = createGatewayPayloadSpool({ store: rejectingStore });

    await expect(spool.spool(body('nope'))).rejects.toBeInstanceOf(PayloadSpoolPersistenceError);
  });
});

describe('gateway payload spool — refcounted retention', () => {
  it('does not sweep a payload a live receipt still names', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('pinned by a receipt'));

    await spool.retain(payloadRef!);
    const removed = await spool.sweep();

    expect(removed).toBe(0);
    expect(await spool.read(payloadRef!)).not.toBeNull();
  });

  it('sweeps a payload once its last reference is released', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('unreferenced'));

    await spool.retain(payloadRef!);
    await spool.release(payloadRef!);
    const removed = await spool.sweep();

    expect(removed).toBe(1);
    expect(await spool.read(payloadRef!)).toBeNull();
  });

  it('keeps a shared payload alive while any receipt still holds it', async () => {
    const spool = memoryGatewayPayloadSpool();
    // Two requests carrying identical bodies dedupe onto ONE blob, so releasing
    // one receipt must not collect the payload the other is still going to execute.
    const bytes = body('shared between two receipts');
    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes));
    expect(second.payloadRef).toBe(first.payloadRef);

    await spool.retain(first.payloadRef!);
    await spool.retain(second.payloadRef!);
    await spool.release(first.payloadRef!);

    expect(await spool.sweep()).toBe(0);
    expect(await spool.read(first.payloadRef!)).not.toBeNull();
  });

  it('does not drive the refcount negative on a repeated release', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('double released'));

    await spool.retain(payloadRef!);
    await spool.release(payloadRef!);
    await spool.release(payloadRef!); // a retried settle path
    await spool.retain(payloadRef!); // a fresh receipt takes it

    // If the double release had gone to -1, this retain would leave it at 0 and the
    // sweep would collect a payload that a live receipt is about to execute.
    expect(await spool.sweep()).toBe(0);
    expect(await spool.read(payloadRef!)).not.toBeNull();
  });
});
