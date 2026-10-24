import { describe, expect, it } from 'vitest';
import { gcsObjectStore, GcsStorageError } from './gcs-object-store.js';
import { sha256Hex } from './content-address.js';
import { objectStoreAsBlobStore } from './object-store.js';
import { putContentAddressed } from './blob-store.js';
import { contentAddressing } from './content-address.js';

const enc = new TextEncoder();
function provider() {
  type Stored = { bytes: Uint8Array; metadata: Record<string, unknown>; generation: string };
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; metadata: Record<string, unknown>; condition: string | null }>();
  const requests: { url: URL; method: string; init: RequestInit }[] = [];
  let generation = 100;
  let denied = false;
  let loseResponse = false;
  let vanishBeforeMedia = false;
  let beforeUploadCommit: (() => void) | undefined;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  const describeObject = (key: string, o: Stored) => ({ name: key, size: String(o.bytes.length), generation: o.generation, updated: '2026-10-24T00:00:00Z', ...o.metadata });
  function seed(key: string, body: string | Uint8Array, metadata: Record<string, unknown> = {}) {
    const object = { bytes: typeof body === 'string' ? enc.encode(body) : body, metadata, generation: String(++generation) };
    objects.set(key, object); return object;
  }
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    requests.push({ url, method, init });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
    if (denied) return json({ error: 'denied' }, 403);
    const id = url.searchParams.get('upload_id');
    if (id && method === 'PUT') {
      const upload = uploads.get(id)!;
      beforeUploadCommit?.(); beforeUploadCommit = undefined;
      const existing = objects.get(upload.key);
      if (upload.condition === '0' ? Boolean(existing) : upload.condition && existing?.generation !== upload.condition) return json({}, 412);
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const o = seed(upload.key, bytes, upload.metadata);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after provider commit'); }
      return json(describeObject(upload.key, o));
    }
    if (url.searchParams.get('uploadType') === 'resumable') {
      const key = url.searchParams.get('name')!;
      const uploadId = String(uploads.size + 1);
      uploads.set(uploadId, { key, metadata: JSON.parse(String(init.body)), condition: url.searchParams.get('ifGenerationMatch') });
      return new Response(null, { status: 200, headers: { location: `https://storage.googleapis.com/upload/storage/v1/b/test-bucket/o?upload_id=${uploadId}` } });
    }
    const marker = '/storage/v1/b/test-bucket/o';
    const compose = url.pathname.endsWith('/compose');
    const key = decodeURIComponent(url.pathname.slice(marker.length + 1, compose ? -8 : undefined));
    if (compose && method === 'POST') {
      if (objects.has(key) && url.searchParams.get('ifGenerationMatch') === '0') return json({}, 412);
      const b = JSON.parse(String(init.body));
      const sources = b.sourceObjects.map((s: { name: string; generation: string }) => {
        const o = objects.get(s.name); return o?.generation === s.generation ? o : null;
      });
      if (sources.some((x: Stored | null) => !x)) return json({}, 404);
      expect(sources.length).toBeLessThanOrEqual(32);
      const bytes = new Uint8Array(sources.reduce((n: number, x: Stored) => n + x.bytes.length, 0));
      let offset = 0; for (const o of sources as Stored[]) { bytes.set(o.bytes, offset); offset += o.bytes.length; }
      const result = seed(key, bytes, b.destination);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after provider commit'); }
      return json(describeObject(key, result));
    }
    if (url.pathname === marker && method === 'GET') {
      const keys = [...objects.keys()].filter(k => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const limit = Number(url.searchParams.get('maxResults'));
      return json({ items: keys.slice(offset, offset + limit).map(k => describeObject(k, objects.get(k)!)),
        ...(offset + limit < keys.length ? { nextPageToken: String(offset + limit) } : {}) });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    const o = objects.get(key);
    if (!o) return json({}, 404);
    if (url.searchParams.get('alt') === 'media') {
      if (vanishBeforeMedia || url.searchParams.get('generation') !== o.generation) return json({}, 404);
      return new Response(new Uint8Array(o.bytes).buffer);
    }
    return json(describeObject(key, o));
  }) as typeof fetch;
  const store = gcsObjectStore({ bucket: 'test-bucket', accessToken: async () => 'test-token', fetchImpl });
  return { store, objects, requests, seed, setDenied: () => { denied = true; },
    loseNextCommitResponse: () => { loseResponse = true; }, vanishBeforeMedia: () => { vanishBeforeMedia = true; },
    beforeUploadCommit: (f: () => void) => { beforeUploadCommit = f; } };
}

describe('private GCS object storage port', () => {
  it('preserves exact bytes, custom/HTTP metadata and generation-pinned reads', async () => {
    const p = provider();
    const bytes = enc.encode('private creator bytes');
    const object = await p.store.put('tenant/private.bin', bytes, {
      sha256: await sha256Hex(bytes), customMetadata: { visibility: 'private', tenant: 'one' },
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private' },
    });
    const read = await p.store.get('tenant/private.bin');
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(bytes);
    expect(read!.customMetadata).toEqual({ visibility: 'private', tenant: 'one' });
    const headers = new Headers(); read!.writeHttpMetadata(headers);
    expect(headers.get('cache-control')).toBe('private');
    expect(p.requests.find(x => x.url.searchParams.get('alt') === 'media')!.url.searchParams.get('generation')).toBe(object!.version);
  });

  it('retains the existing hash-verifying BlobStore seam', async () => {
    const p = provider(); const bytes = enc.encode('registry artifact'); const hash = await sha256Hex(bytes);
    const result = await putContentAddressed(objectStoreAsBlobStore(p.store), {
      hash, scheme: contentAddressing({ prefix: 'registry', ext: '.tgz' }), readBody: async () => bytes.buffer, maxBytes: 100,
    });
    expect(result).toMatchObject({ ok: true, deduped: false });
    expect(p.objects.get(`registry/${hash}.tgz`)!.bytes).toEqual(bytes);
  });

  it('refuses a wrong SHA256 before sending bytes to the provider', async () => {
    const p = provider();
    await expect(p.store.put('bad', 'wrong', { sha256: '0'.repeat(64) })).rejects.toThrow('sha_mismatch');
    expect(p.requests).toHaveLength(0);
  });

  it('fences a create-only race at commit and preserves occupied bytes', async () => {
    const p = provider();
    p.beforeUploadCommit(() => { p.seed('occupied', 'first-writer'); });
    expect(await p.store.put('occupied', 'second-writer', { onlyIf: { etagDoesNotMatch: '*' } })).toBeNull();
    expect(await (await p.store.get('occupied'))!.text()).toBe('first-writer');
  });

  it('fences stale conditional updates by generation', async () => {
    const p = provider(); const first = await p.store.put('state', 'one');
    await p.store.put('state', 'two');
    expect(await p.store.put('state', 'stale', { onlyIf: { etagMatches: first!.httpEtag } })).toBeNull();
    expect(await (await p.store.get('state'))!.text()).toBe('two');
  });

  it('does not turn permission or pinned-generation failures into absence', async () => {
    const denied = provider(); denied.setDenied();
    await expect(denied.store.head('private')).rejects.toMatchObject({ code: 403 });
    await expect(denied.store.get('private')).rejects.toBeInstanceOf(GcsStorageError);
    const raced = provider(); raced.seed('private', 'x'); raced.vanishBeforeMedia();
    await expect(raced.store.get('private')).rejects.toMatchObject({ code: 404 });
  });

  it('streams request bytes and paginates a tenant prefix without listing siblings', async () => {
    const p = provider();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('streamed')); c.close(); } });
    await p.store.put('tenant/a', stream); await p.store.put('tenant/b', 'two'); await p.store.put('other/a', 'hidden');
    expect(p.requests.find(x => x.method === 'PUT')!.init.body).toBe(stream);
    const one = await p.store.list({ prefix: 'tenant/', limit: 1 });
    const two = await p.store.list({ prefix: 'tenant/', limit: 1, cursor: one.cursor });
    expect(one.objects.map(x => x.key)).toEqual(['tenant/a']); expect(one.truncated).toBe(true);
    expect(two.objects.map(x => x.key)).toEqual(['tenant/b']); expect(two.truncated).toBe(false);
  });
});

describe('GCS multipart generation and retry integrity', () => {
  it('resumes the same upload and preserves exact ordered bytes and metadata', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle', { customMetadata: { sha256: 'admitted', visibility: 'private' } });
    const first = await upload.uploadPart(1, 'abc');
    const resumed = p.store.resumeMultipartUpload('bundle', upload.uploadId);
    const second = await resumed.uploadPart(2, 'def');
    await resumed.complete([first, second]);
    expect(await (await p.store.get('bundle'))!.text()).toBe('abcdef');
    expect((await p.store.head('bundle'))!.customMetadata.visibility).toBe('private');
    expect((await p.store.head('bundle'))!.customMetadata.gcsUploadId).toBe(upload.uploadId);
  });

  it('reconciles a lost completion response without composing or replacing again', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const part = await upload.uploadPart(1, 'signed bytes');
    p.loseNextCommitResponse(); await expect(upload.complete([part])).rejects.toThrow('response lost');
    const generation = p.objects.get('bundle')!.generation;
    expect((await p.store.resumeMultipartUpload('bundle', upload.uploadId).complete([part])).version).toBe(generation);
    expect(p.requests.filter(x => x.url.pathname.endsWith('/compose'))).toHaveLength(1);
  });

  it('refuses replacement of an occupied destination and mismatched tenant sessions', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('tenant/bundle'); const part = await upload.uploadPart(1, 'new');
    p.seed('tenant/bundle', 'retained');
    await expect(upload.complete([part])).rejects.toMatchObject({ code: 412 });
    expect(await (await p.store.get('tenant/bundle'))!.text()).toBe('retained');
    await expect(p.store.resumeMultipartUpload('other/bundle', upload.uploadId).uploadPart(2, 'x')).rejects.toThrow('does not match');
  });

  it('rejects stale part generations and reordered/duplicate receipts', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const first = await upload.uploadPart(1, 'old');
    await upload.uploadPart(1, 'different');
    await expect(upload.complete([first])).rejects.toMatchObject({ code: 404 });
    await expect(upload.complete([first, first])).rejects.toThrow('invalid multipart receipts');
    expect(await p.store.head('bundle')).toBeNull();
  });

  it('composes more than 32 parts in bounded generation-pinned stages', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const parts = [];
    for (let n = 1; n <= 65; n++) parts.push(await upload.uploadPart(n, String(n) + ','));
    await upload.complete(parts);
    expect(await (await p.store.get('bundle'))!.text()).toBe(Array.from({ length: 65 }, (_, i) => `${i + 1},`).join(''));
    expect(p.requests.filter(x => x.url.pathname.endsWith('/compose'))).toHaveLength(4);
  });

  it('aborts only that session, preserving published and unrelated tenant objects', async () => {
    const p = provider(); p.seed('other/object', 'private'); const upload = await p.store.createMultipartUpload('bundle');
    const part = await upload.uploadPart(1, 'published'); await upload.complete([part]); await upload.abort();
    expect([...p.objects.keys()].sort()).toEqual(['bundle', 'other/object']);
    await expect(upload.uploadPart(2, 'late')).rejects.toThrow('session missing');
  });
});
