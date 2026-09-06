/**
 * DOC-CLAIM (WI-2147371 / D-056): no plaintext hive private key or invite secret ever
 * reaches a GitHub gist.
 *
 * The bug this pins: `papercusp-shared-identity-gist.ts` published the owner's Ed25519
 * private key and the directory invite secret in the clear to a `public:false` gist,
 * and its own header asserted the gist was "readable only with the owner's gh token".
 * That is false — a secret gist is UNLISTED, not access-controlled: both the web URL
 * and `GET /gists/{id}` serve it anonymously. So the claim in the prose and the claim
 * in the code have to be pinned together, or the next reader re-derives the same wrong
 * mental model and re-opens the same hole.
 *
 * These assertions drive the REAL publish path with an injected fetch — they do not
 * inspect the sealing helpers in isolation, because the property being pinned is about
 * what crosses the network boundary.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  publishOwnerHiveIdentity,
  fetchOwnerHiveIdentity,
  sealOwnerHiveIdentity,
  openSealedOwnerHiveIdentity,
  isSealedOwnerHiveIdentity,
  MIN_IDENTITY_PASSPHRASE_LENGTH,
  __OWNER_GIST_FILENAME,
  type OwnerHiveIdentity,
} from '../harness/papercusp-shared-identity-gist';

const PRIVATE_KEY_DER = 'UFJJVkFURS1LRVktREVSLUJZVEVT'; // "PRIVATE-KEY-DER-BYTES"
const INVITE_SECRET = 'deadbeefcafef00ddeadbeefcafef00d';
const PASSPHRASE = 'correct horse battery staple';

const IDENT: OwnerHiveIdentity = {
  version: 1,
  privateKeyDer: PRIVATE_KEY_DER,
  pubkeyBase64: 'cHVia2V5LWJhc2U2NA==',
  inviteSecret: INVITE_SECRET,
};

const MODULE_PATH = path.join(__dirname, '..', 'harness', 'papercusp-shared-identity-gist.ts');

/** A fetch that records every request and answers the two gist endpoints. */
function recordingFetch(existingGistId: string | null) {
  const requests: { url: string; method: string; body: string }[] = [];
  const impl = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    requests.push({ url: u, method: init?.method ?? 'GET', body: init?.body ?? '' });
    if (u.includes('/gists?per_page')) {
      return {
        ok: true,
        json: async () =>
          existingGistId
            ? [{ id: existingGistId, created_at: '2026-01-01T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } }]
            : [],
      };
    }
    return { ok: true, json: async () => ({ id: existingGistId ?? 'new-gist-id' }) };
  }) as unknown as typeof fetch;
  return { requests, impl };
}

describe('doc-claim: no plaintext hive private key in a gist (WI-2147371)', () => {
  it('a POST-create publish sends NO request body containing the private key or invite secret', async () => {
    const { requests, impl } = recordingFetch(null);

    const res = await publishOwnerHiveIdentity('tok', IDENT, PASSPHRASE, impl);
    expect(res).toEqual({ gistId: 'new-gist-id' });

    const writes = requests.filter((r) => r.method === 'POST' || r.method === 'PATCH');
    expect(writes.length).toBe(1);
    for (const r of requests) {
      expect(r.body).not.toContain(PRIVATE_KEY_DER);
      expect(r.body).not.toContain(INVITE_SECRET);
      expect(r.body).not.toContain('privateKeyDer');
      expect(r.body).not.toContain('inviteSecret');
    }
  });

  it('a PATCH-upsert of an existing canonical gist is sealed too', async () => {
    const { requests, impl } = recordingFetch('existing-id');

    await publishOwnerHiveIdentity('tok', IDENT, PASSPHRASE, impl);

    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch!.body).not.toContain(PRIVATE_KEY_DER);
    expect(patch!.body).not.toContain(INVITE_SECRET);

    // ...and what it DID write is a well-formed sealed envelope.
    const sent = JSON.parse(patch!.body) as { files: Record<string, { content: string }> };
    const blob = JSON.parse(sent.files[__OWNER_GIST_FILENAME].content) as unknown;
    expect(isSealedOwnerHiveIdentity(blob)).toBe(true);
  });

  it('without a usable passphrase the publish refuses BEFORE any network call', async () => {
    for (const bad of ['', '   ', 'short', 'x'.repeat(MIN_IDENTITY_PASSPHRASE_LENGTH - 1)]) {
      const { requests, impl } = recordingFetch(null);
      const res = await publishOwnerHiveIdentity('tok', IDENT, bad, impl);
      // A refusal, not a plaintext fallback — and zero requests issued, so there is no
      // window in which a half-formed write could carry the secrets.
      expect(res).toBeNull();
      expect(requests.length).toBe(0);
    }
  });

  it('round-trips through the real publish/fetch pair only with the right passphrase', async () => {
    // Capture what publish actually wrote, then serve exactly that back to fetch.
    const { requests, impl } = recordingFetch(null);
    await publishOwnerHiveIdentity('tok', IDENT, PASSPHRASE, impl);
    const written = (JSON.parse(requests.find((r) => r.method === 'POST')!.body) as {
      files: Record<string, { content: string }>;
    }).files[__OWNER_GIST_FILENAME].content;

    const serve = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('/gists?per_page')) {
        return {
          ok: true,
          json: async () => [
            { id: 'g1', created_at: '2026-01-01T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } },
          ],
        };
      }
      return { ok: true, json: async () => ({ files: { [__OWNER_GIST_FILENAME]: { content: written } } }) };
    }) as unknown as typeof fetch;

    expect(await fetchOwnerHiveIdentity('tok', PASSPHRASE, serve)).toEqual(IDENT);
    // A stranger who learns the gist URL holds ciphertext, not the key.
    expect(await fetchOwnerHiveIdentity('tok', 'wrong passphrase here', serve)).toBeNull();
    expect(await fetchOwnerHiveIdentity('tok', null, serve)).toBeNull();
  });

  it('the sealed envelope leaks only the (public) pubkey', () => {
    const sealed = sealOwnerHiveIdentity(IDENT, PASSPHRASE);
    expect(sealed).not.toBeNull();
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(PRIVATE_KEY_DER);
    expect(serialized).not.toContain(INVITE_SECRET);
    expect(sealed!.pubkeyBase64).toBe(IDENT.pubkeyBase64);
    expect(openSealedOwnerHiveIdentity(sealed!, PASSPHRASE)).toEqual(IDENT);
  });

  it('a tampered ciphertext is rejected rather than half-opened (AEAD, not just encryption)', () => {
    const sealed = sealOwnerHiveIdentity(IDENT, PASSPHRASE)!;
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...sealed, ciphertext: bytes.toString('base64') };
    expect(openSealedOwnerHiveIdentity(tampered, PASSPHRASE)).toBeNull();
  });

  it('the module prose no longer claims a secret gist is access-controlled', () => {
    const src = readFileSync(MODULE_PATH, 'utf8');
    const header = src.slice(0, src.indexOf('const GIST_FILENAME'));

    // The exact false claim that produced the bug must not come back.
    expect(header).not.toMatch(/readable only with the owner's gh token/i);
    expect(header).not.toMatch(/the gist is PRIVATE/i);

    // ...and the true one has to be stated, so the next reader inherits the right model.
    expect(header).toMatch(/unlisted/i);
    expect(header).toMatch(/not\s+access-controlled|\*\*not\*\*\s+access-controlled/i);
    expect(header).toMatch(/WI-2147371/);
  });
});
