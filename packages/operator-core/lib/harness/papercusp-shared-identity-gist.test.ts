import { describe, it, expect } from 'vitest';
import {
  fetchOwnerHiveIdentity,
  publishOwnerHiveIdentity,
  isOwnerHiveIdentity,
  __OWNER_GIST_FILENAME,
  type OwnerHiveIdentity,
} from './papercusp-shared-identity-gist';

function jsonRes(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const IDENT: OwnerHiveIdentity = {
  version: 1,
  privateKeyDer: 'ZGVyLWJ5dGVz',
  pubkeyBase64: 'cHVia2V5',
  inviteSecret: 'a1b2c3d4',
};

describe('fetchOwnerHiveIdentity', () => {
  it('finds the owner gist by well-known filename and parses the blob', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      if (String(url).endsWith('/gists?per_page=100')) {
        return jsonRes(true, [
          { id: 'other', files: { 'README.md': {} } },
          { id: 'g1', files: { [__OWNER_GIST_FILENAME]: {} } },
        ]);
      }
      if (String(url).endsWith('/gists/g1')) {
        return jsonRes(true, { files: { [__OWNER_GIST_FILENAME]: { content: JSON.stringify(IDENT) } } });
      }
      return jsonRes(false, {});
    }) as unknown as typeof fetch;

    const got = await fetchOwnerHiveIdentity('tok', fetchImpl);
    expect(got).toEqual(IDENT);
    // It re-fetched the matching gist by id to read content (the list omits it).
    expect(seen.some((u) => u.endsWith('/gists/g1'))).toBe(true);
  });

  it('dedups divergent duplicate gists — resolves to the OLDEST by created_at', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string) => {
      requested.push(String(url));
      if (String(url).endsWith('/gists?per_page=100')) {
        return jsonRes(true, [
          { id: 'newer', created_at: '2026-06-20T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } },
          { id: 'oldest', created_at: '2026-01-01T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } },
          { id: 'mid', created_at: '2026-03-01T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } },
        ]);
      }
      if (String(url).endsWith('/gists/oldest')) {
        return jsonRes(true, { files: { [__OWNER_GIST_FILENAME]: { content: JSON.stringify(IDENT) } } });
      }
      return jsonRes(false, {});
    }) as unknown as typeof fetch;

    const got = await fetchOwnerHiveIdentity('tok', fetchImpl);
    expect(got).toEqual(IDENT);
    // Resolved the OLDEST gist (deterministic dedup), not the first-listed one.
    expect(requested.some((u) => u.endsWith('/gists/oldest'))).toBe(true);
    expect(requested.some((u) => u.endsWith('/gists/newer'))).toBe(false);
  });

  it('returns null when no gist holds the well-known file', async () => {
    const fetchImpl = (async () =>
      jsonRes(true, [{ id: 'x', files: { 'notes.txt': {} } }])) as unknown as typeof fetch;
    expect(await fetchOwnerHiveIdentity('tok', fetchImpl)).toBeNull();
  });

  it('returns null when the gist list call fails (e.g. missing scope)', async () => {
    const fetchImpl = (async () => jsonRes(false, {})) as unknown as typeof fetch;
    expect(await fetchOwnerHiveIdentity('tok', fetchImpl)).toBeNull();
  });

  it('returns null on a malformed / hand-edited identity blob', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('per_page')) {
        return jsonRes(true, [{ id: 'g', files: { [__OWNER_GIST_FILENAME]: {} } }]);
      }
      return jsonRes(true, { files: { [__OWNER_GIST_FILENAME]: { content: '{"nope":1}' } } });
    }) as unknown as typeof fetch;
    expect(await fetchOwnerHiveIdentity('tok', fetchImpl)).toBeNull();
  });

  it('never throws on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchOwnerHiveIdentity('tok', fetchImpl)).toBeNull();
  });
});

describe('publishOwnerHiveIdentity', () => {
  it('creates (POST) a PRIVATE gist when none exists yet, and returns the new id', async () => {
    let captured: { public?: boolean; files?: Record<string, { content: string }> } | undefined;
    let method: string | undefined;
    let writeUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith('/gists?per_page=100')) return jsonRes(true, []); // no existing gist
      method = init?.method;
      writeUrl = String(url);
      captured = JSON.parse(init!.body!);
      return jsonRes(true, { id: 'newid' });
    }) as unknown as typeof fetch;

    const res = await publishOwnerHiveIdentity('tok', IDENT, fetchImpl);
    expect(res).toEqual({ gistId: 'newid' });
    expect(method).toBe('POST');
    expect(writeUrl?.endsWith('/gists')).toBe(true);
    expect(captured?.public).toBe(false); // never public — strangers must not read it
    expect(captured?.files?.[__OWNER_GIST_FILENAME].content).toContain('inviteSecret');
  });

  it('UPSERTs in place (PATCH) when a canonical gist already exists — no duplicate POST', async () => {
    let method: string | undefined;
    let writeUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith('/gists?per_page=100')) {
        return jsonRes(true, [
          { id: 'canon', created_at: '2026-01-01T00:00:00Z', files: { [__OWNER_GIST_FILENAME]: {} } },
        ]);
      }
      method = init?.method;
      writeUrl = String(url);
      return jsonRes(true, { id: 'canon' });
    }) as unknown as typeof fetch;

    const res = await publishOwnerHiveIdentity('tok', IDENT, fetchImpl);
    expect(res).toEqual({ gistId: 'canon' });
    expect(method).toBe('PATCH'); // update-in-place, not a new POST
    expect(writeUrl?.endsWith('/gists/canon')).toBe(true);
  });

  it('returns null on a failed write (never throws)', async () => {
    const fetchImpl = (async () => jsonRes(false, {})) as unknown as typeof fetch;
    expect(await publishOwnerHiveIdentity('tok', IDENT, fetchImpl)).toBeNull();
  });
});

describe('isOwnerHiveIdentity', () => {
  it('accepts a well-formed blob and rejects junk', () => {
    expect(isOwnerHiveIdentity(IDENT)).toBe(true);
    expect(isOwnerHiveIdentity({ privateKeyDer: '', pubkeyBase64: 'p', inviteSecret: 's' })).toBe(false);
    expect(isOwnerHiveIdentity({ pubkeyBase64: 'p', inviteSecret: 's' })).toBe(false);
    expect(isOwnerHiveIdentity(null)).toBe(false);
    expect(isOwnerHiveIdentity('nope')).toBe(false);
  });
});
