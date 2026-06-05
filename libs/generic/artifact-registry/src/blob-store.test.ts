import { describe, it, expect } from 'vitest';
import { contentAddressing, sha256Hex } from './content-address.ts';
import {
  putContentAddressed,
  getContentAddressed,
  gcIfUnreferenced,
  memoryBlobStore,
} from './blob-store.ts';

const enc = new TextEncoder();
const SCHEME = contentAddressing({ prefix: 'snapshots', ext: '.tar.gz' });
const MAX = 100 * 1024 * 1024;

const BYTES = enc.encode('fake .tar.gz bytes — artifact state');
const bodyOf = (u8: Uint8Array) => async () => u8.slice().buffer;

describe('putContentAddressed', () => {
  it('stores a content-addressed blob and is idempotent', async () => {
    const store = memoryBlobStore();
    const sha = await sha256Hex(BYTES);
    const r1 = await putContentAddressed(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    expect(r1).toEqual({ ok: true, key: SCHEME.key(sha), bytes: BYTES.byteLength, deduped: false });
    expect(store.data.has(SCHEME.key(sha))).toBe(true);

    // Re-PUT identical content ⇒ deduped, no re-write (readBody never called).
    let called = false;
    const r2 = await putContentAddressed(store, {
      hash: sha, scheme: SCHEME, maxBytes: MAX,
      readBody: async () => { called = true; return BYTES.slice().buffer; },
    });
    expect(r2).toEqual({ ok: true, key: SCHEME.key(sha), bytes: BYTES.byteLength, deduped: true });
    expect(called).toBe(false);
  });

  it('rejects a body whose sha256 does not match the key', async () => {
    const store = memoryBlobStore();
    const wrong = 'a'.repeat(64);
    const r = await putContentAddressed(store, { hash: wrong, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe('sha_mismatch');
      expect(r.detail).toEqual({ expected: wrong, actual: await sha256Hex(BYTES) });
    }
    expect(store.data.size).toBe(0);
  });

  it('rejects a non-hex hash before touching the store', async () => {
    const store = memoryBlobStore();
    let read = false;
    const r = await putContentAddressed(store, {
      hash: 'not-a-sha', scheme: SCHEME, maxBytes: MAX,
      readBody: async () => { read = true; return BYTES.slice().buffer; },
    });
    expect(r).toEqual({ ok: false, status: 400, error: 'invalid_sha' });
    expect(read).toBe(false);
  });

  it('rejects declared oversize before buffering, and actual oversize after', async () => {
    const store = memoryBlobStore();
    const sha = await sha256Hex(BYTES);

    let read = false;
    const declared = await putContentAddressed(store, {
      hash: sha, scheme: SCHEME, maxBytes: 4, declaredLength: 9999,
      readBody: async () => { read = true; return BYTES.slice().buffer; },
    });
    expect(declared).toEqual({ ok: false, status: 413, error: 'too_large', detail: { max_bytes: 4 } });
    expect(read).toBe(false); // early reject — never buffered

    const actual = await putContentAddressed(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: 4 });
    expect(actual).toEqual({ ok: false, status: 413, error: 'too_large', detail: { max_bytes: 4 } });
  });

  it('rejects an empty body', async () => {
    const store = memoryBlobStore();
    const empty = new Uint8Array(0);
    const sha = await sha256Hex(empty);
    const r = await putContentAddressed(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(empty), maxBytes: MAX });
    expect(r).toEqual({ ok: false, status: 400, error: 'empty_body' });
  });
});

describe('getContentAddressed', () => {
  it('is visibility-gated: 404 until referenced, then returns the backend object', async () => {
    const store = memoryBlobStore();
    const sha = await sha256Hex(BYTES);
    await putContentAddressed(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });

    const gated = await getContentAddressed(store, { hash: sha, scheme: SCHEME, isReferenced: () => false });
    expect(gated).toEqual({ ok: false, status: 404, error: 'not_found' });

    const ok = await getContentAddressed(store, { hash: sha, scheme: SCHEME, isReferenced: (k) => k === SCHEME.key(sha) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(new Uint8Array(ok.object.body)).toEqual(BYTES);
  });

  it('404s when the gate passes but no bytes are stored, and 400s a bad hash', async () => {
    const store = memoryBlobStore();
    const sha = await sha256Hex(BYTES);
    expect(await getContentAddressed(store, { hash: sha, scheme: SCHEME, isReferenced: () => true }))
      .toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(await getContentAddressed(store, { hash: 'nope', scheme: SCHEME }))
      .toEqual({ ok: false, status: 400, error: 'invalid_sha' });
  });
});

describe('gcIfUnreferenced', () => {
  it('deletes the blob iff no live reference remains', async () => {
    const store = memoryBlobStore();
    const sha = await sha256Hex(BYTES);
    const key = SCHEME.key(sha);
    await putContentAddressed(store, { hash: sha, scheme: SCHEME, readBody: bodyOf(BYTES), maxBytes: MAX });

    // Still referenced ⇒ kept.
    expect(await gcIfUnreferenced(store, key, () => true)).toBe(false);
    expect(store.data.has(key)).toBe(true);

    // No longer referenced ⇒ collected.
    expect(await gcIfUnreferenced(store, key, () => false)).toBe(true);
    expect(store.data.has(key)).toBe(false);
  });
});
