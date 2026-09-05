import { describe, expect, it } from 'vitest';
import {
  CUPBOARD_ARTIFACT_PREFIX,
  contentHashHex,
  cupboardArtifactKey,
  isPresignedTransport,
  isTicketExpired,
  memoryArtifactStore,
  resolveReleaseArtifact,
  validateArtifactRef,
  type ArtifactRef,
  type ArtifactStoreCapabilities,
} from './artifact-store';

const HASH = `sha256:${'b'.repeat(64)}`;
const caps = (o: Partial<ArtifactStoreCapabilities> = {}): ArtifactStoreCapabilities => ({
  presigned: false,
  multipart: false,
  maxObjectBytes: 1024,
  ...o,
});
const ref = (o: Partial<ArtifactRef> = {}): ArtifactRef => ({
  contentHash: HASH,
  sizeBytes: 128,
  contentType: 'application/octet-stream',
  ...o,
});

describe('Cupboard provider-neutral artifact store seam (P-007 / D-024)', () => {
  it('derives a content-addressed key that depends only on the bytes', () => {
    expect(cupboardArtifactKey(HASH)).toBe(`${CUPBOARD_ARTIFACT_PREFIX}/${'b'.repeat(64)}`);
    expect(contentHashHex(HASH)).toBe('b'.repeat(64));
    // Case-insensitive input must not produce a second key for the same bytes.
    expect(cupboardArtifactKey(`sha256:${'B'.repeat(64)}`)).toBe(cupboardArtifactKey(HASH));
  });

  it('accepts the manifest hash grammar and rejects bad refs and oversize objects', () => {
    expect(validateArtifactRef(ref(), caps())).toEqual({ ok: true, ref: ref() });
    expect(validateArtifactRef(ref({ contentHash: 'sha256:nope' }), caps())).toMatchObject({ code: 'invalid-hash' });
    expect(validateArtifactRef(ref({ sizeBytes: 0 }), caps())).toMatchObject({ code: 'invalid-size' });
    expect(validateArtifactRef(ref({ contentType: '' }), caps())).toMatchObject({ code: 'invalid-content-type' });
    expect(validateArtifactRef(ref({ sizeBytes: 4096 }), caps())).toMatchObject({ code: 'too-large' });
  });

  it('lets the adapter — not the interface — decide whether upload is presigned', async () => {
    const proxied = memoryArtifactStore();
    const direct = memoryArtifactStore({ capabilities: { presigned: true, multipart: true } });

    const proxiedTicket = await proxied.createUploadTicket(ref(), 0);
    expect(proxiedTicket.transport).toBe('proxied-put');
    expect(isPresignedTransport(proxiedTicket.transport)).toBe(false);
    expect(proxiedTicket.url).toBeUndefined();

    const directTicket = await direct.createUploadTicket(ref(), 0);
    expect(directTicket.transport).toBe('presigned-multipart');
    expect(isPresignedTransport(directTicket.transport)).toBe(true);
    expect(directTicket.url).toBe(`memory://${cupboardArtifactKey(HASH)}`);
    expect(directTicket.maxPartBytes).toBeGreaterThan(0);
  });

  it('expires tickets so a caller re-mints instead of retrying a dead URL', async () => {
    const store = memoryArtifactStore({ ticketTtlMs: 1_000 });
    const ticket = await store.createUploadTicket(ref(), 10_000);
    expect(ticket.expiresAtMs).toBe(11_000);
    expect(isTicketExpired(ticket, 10_999)).toBe(false);
    expect(isTicketExpired(ticket, 11_000)).toBe(true);
  });

  it('refuses to resolve a signed manifest whose bytes are not actually stored', async () => {
    const store = memoryArtifactStore();
    // The integrity join P-007 exists to protect: a manifest can be validly
    // signed over a content hash that no artifact backs.
    await expect(resolveReleaseArtifact({ store }, { contentHash: HASH })).resolves.toMatchObject({
      ok: false,
      code: 'missing-artifact',
    });

    store.put(ref());
    await expect(resolveReleaseArtifact({ store }, { contentHash: HASH })).resolves.toMatchObject({
      ok: true,
      providerId: 'memory',
    });
    await expect(resolveReleaseArtifact({ store }, { contentHash: HASH }, 999)).resolves.toMatchObject({
      ok: false,
      code: 'size-mismatch',
    });
  });
});
