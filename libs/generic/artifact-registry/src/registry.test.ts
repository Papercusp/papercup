import { describe, it, expect } from 'vitest';
import {
  ArtifactRegistry,
  type ArtifactRegistryPolicies,
  type ListingStore,
} from './registry.ts';
import { memoryBlobStore } from './blob-store.ts';

// ── A minimal domain to exercise the generic core ───────────────────────────
interface Row {
  id: string;
  kind: string;
  ref: string;
  unlisted_at: number | null;
  claim_status: 'unclaimed' | 'claimed';
  claimant: string | null;
  blob_key: string | null;
}
interface Insert {
  id: string;
  kind: string;
  ref: string;
  blob_key: string | null;
  created_at: number;
}
interface Input {
  kind: string;
  ref: string;
  blob_key?: string | null;
}

function harness() {
  const rows = new Map<string, Row>();
  const store: ListingStore<Row, Insert> = {
    insert: async (i) => {
      rows.set(i.id, {
        id: i.id, kind: i.kind, ref: i.ref, unlisted_at: null,
        claim_status: 'unclaimed', claimant: null, blob_key: i.blob_key,
      });
    },
    getById: async (id) => rows.get(id) ?? null,
    list: async (q) => {
      const query = q as { kind?: string } | undefined;
      return [...rows.values()].filter((r) => r.unlisted_at === null && (!query?.kind || r.kind === query.kind));
    },
    markUnlisted: async (id, _reason, now) => {
      const r = rows.get(id);
      if (r) r.unlisted_at = now;
    },
    setClaim: async (id, claim, _now) => {
      const r = rows.get(id);
      if (r) { r.claim_status = 'claimed'; r.claimant = String(claim.user_id); }
    },
  };

  const policies: ArtifactRegistryPolicies<Row, Input, Insert> = {
    validate: (input) => (input.ref ? { ok: true } : { ok: false, status: 400, error: 'invalid_field', field: 'ref' }),
    findDuplicate: async (input) =>
      [...rows.values()].find((r) => r.kind === input.kind && r.ref === input.ref && r.unlisted_at === null) ?? null,
    toInsert: (input, ctx) => ({ id: ctx.id, kind: input.kind, ref: input.ref, blob_key: input.blob_key ?? null, created_at: ctx.now }),
    idOf: (r) => r.id,
    isUnlisted: (r) => r.unlisted_at !== null,
    isClaimed: (r) => r.claim_status === 'claimed',
    authorizeClaim: (_r, claimant) => claimant.user_id === 'maintainer',
    blobKeyOf: (r) => r.blob_key,
    isBlobStillReferenced: async (key) => [...rows.values()].some((r) => r.unlisted_at === null && r.blob_key === key),
  };

  const blobStore = memoryBlobStore();
  let n = 0;
  const registry = new ArtifactRegistry(store, policies, {
    genId: () => `id_${++n}`,
    now: () => 1000 + n,
    blobStore,
  });
  return { rows, registry, blobStore };
}

describe('ArtifactRegistry.publish', () => {
  it('validates, then inserts a fresh listing', async () => {
    const { registry } = harness();
    const bad = await registry.publish({ kind: 'plugin', ref: '' });
    expect(bad).toEqual({ ok: false, status: 400, error: 'invalid_field', field: 'ref' });

    const ok = await registry.publish({ kind: 'plugin', ref: 'cool-plugin' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.deduped).toBe(false);
      expect(ok.id).toBe('id_1');
      expect(ok.row.ref).toBe('cool-plugin');
    }
  });

  it('dedupes an active (repo,kind,ref) instead of minting a second', async () => {
    const { registry, rows } = harness();
    const first = await registry.publish({ kind: 'plugin', ref: 'dup' });
    const second = await registry.publish({ kind: 'plugin', ref: 'dup' });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);
    }
    expect(rows.size).toBe(1);
  });

  it('mints a new listing once the duplicate is unlisted', async () => {
    const { registry, rows } = harness();
    const first = await registry.publish({ kind: 'plugin', ref: 'reborn' });
    if (first.ok) await registry.unlist(first.id, { user_id: 'pub' });
    const second = await registry.publish({ kind: 'plugin', ref: 'reborn' });
    expect(second.ok && second.deduped).toBe(false);
    expect(rows.size).toBe(2);
  });
});

describe('ArtifactRegistry.get / list', () => {
  it('gets by id and lists only active rows, with a domain filter', async () => {
    const { registry } = harness();
    const a = await registry.publish({ kind: 'plugin', ref: 'a' });
    await registry.publish({ kind: 'snapshot', ref: 'b' });
    if (a.ok) await registry.unlist(a.id, { user_id: 'pub' });

    expect((await registry.list())).toHaveLength(1); // the unlisted plugin is hidden
    expect((await registry.list({ kind: 'snapshot' }))).toHaveLength(1);
    expect((await registry.list({ kind: 'plugin' }))).toHaveLength(0);
    if (a.ok) expect((await registry.get(a.id))?.unlisted_at).not.toBe(null);
  });
});

describe('ArtifactRegistry.unlist + refcounted blob GC', () => {
  it('keeps a blob alive while a sibling listing references it, then GCs it', async () => {
    const { registry, blobStore } = harness();
    const KEY = 'snapshots/deadbeef.tar.gz';
    blobStore.data.set(KEY, new Uint8Array([1, 2, 3]));

    // Two snapshot listings (distinct refs) pointing at the SAME content-addressed blob.
    const one = await registry.publish({ kind: 'snapshot', ref: 's1', blob_key: KEY });
    const two = await registry.publish({ kind: 'snapshot', ref: 's2', blob_key: KEY });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    const u1 = await registry.unlist(one.id, { user_id: 'pub' });
    expect(u1.ok && u1.blobCollected).toBe(false); // sibling still references it
    expect(blobStore.data.has(KEY)).toBe(true);

    const u2 = await registry.unlist(two.id, { user_id: 'pub' });
    expect(u2.ok && u2.blobCollected).toBe(true); // last reference gone
    expect(blobStore.data.has(KEY)).toBe(false);
  });

  it('is idempotent on an already-unlisted listing and 404s a missing one', async () => {
    const { registry } = harness();
    const r = await registry.publish({ kind: 'plugin', ref: 'x' });
    if (!r.ok) return;
    expect(await registry.unlist(r.id, { user_id: 'pub' })).toMatchObject({ ok: true });
    expect(await registry.unlist(r.id, { user_id: 'pub' })).toMatchObject({ ok: true, alreadyUnlisted: true });
    expect(await registry.unlist('ghost', { user_id: 'pub' })).toEqual({ ok: false, status: 404, error: 'not_found' });
  });
});

describe('ArtifactRegistry.claim', () => {
  it('enforces authorization, claim conflicts, and unlisted/missing rows', async () => {
    const { registry } = harness();
    const r = await registry.publish({ kind: 'plugin', ref: 'claimable' });
    if (!r.ok) return;

    expect(await registry.claim(r.id, { user_id: 'rando' }))
      .toEqual({ ok: false, status: 403, error: 'insufficient_permission' });

    const ok = await registry.claim(r.id, { user_id: 'maintainer', login: 'm' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.row.claim_status).toBe('claimed');

    expect(await registry.claim(r.id, { user_id: 'maintainer' }))
      .toEqual({ ok: false, status: 409, error: 'already_claimed' });
    expect(await registry.claim('ghost', { user_id: 'maintainer' }))
      .toEqual({ ok: false, status: 404, error: 'not_found' });
  });
});
