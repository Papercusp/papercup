/**
 * catalog-fields.test.ts — the migration-018 catalog axes on the /listings
 * surface (shared-pot-dao-cupboard-v1-2026-09-04 P-008).
 *
 * Six axes: visibility, SKU/pricing, compatibility, permissions, immutable
 * release identity, and tenant isolation — plus the search/filter surface that
 * makes them queryable.
 *
 * The load-bearing property here is TENANT ISOLATION, and it is asymmetric on
 * purpose: every catalog filter NARROWS, and the only thing that widens the
 * visible set is an authorized `tenant_scope` the public HTTP route never sets.
 * A filter that accidentally widened would hand any caller another pot's private
 * catalog, so the widening/narrowing distinction gets its own tests rather than
 * being implied by the happy path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, makeListingRow, stubGithub } from './fake-d1.ts';
import { listPublicHarnessesPage, summarizePublicHarnesses } from '../db.ts';

function publish(
  api: ReturnType<typeof buildApi>,
  env: ReturnType<typeof makeEnv>['env'],
  body: Record<string, unknown>,
) {
  return api.request(
    '/listings',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

const BASE = {
  github_owner: 'papercupai',
  github_name: 'demo-project',
  github_url: 'https://github.com/papercupai/demo-project',
  project_ref: 'papercupai/demo-project',
  listing_kind: 'plugin',
  listing_ref: 'demo-plugin',
  github_repository_id: 7,
};

async function listingIds(res: Response): Promise<string[]> {
  const body = (await res.json()) as { results: Array<{ id: string }> };
  return body.results.map((r) => r.id);
}

describe('Cupboard catalog fields (migration 018 / P-008)', () => {
  let api: ReturnType<typeof buildApi>;
  beforeEach(() => {
    api = buildApi();
  });

  describe('visibility + tenant isolation', () => {
    it('browse returns only public rows — unlisted and private are invisible', async () => {
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'pub', visibility: 'public' }),
        makeListingRow({ id: 'unl', visibility: 'unlisted' }),
        makeListingRow({ id: 'priv', visibility: 'private', tenant_id: 'pot-a' }),
      );
      const res = await api.request('/listings', {}, env);
      expect(res.status).toBe(200);
      expect(await listingIds(res)).toEqual(['pub']);
    });

    it('a pre-018 row with no explicit visibility still browses (column default)', async () => {
      // The migration gives `visibility` a NOT NULL DEFAULT 'public', so every
      // row that existed before 018 must keep browsing exactly as it did. A
      // fail-closed default would have silently emptied the live storefront.
      const { env, store } = makeEnv();
      const row = makeListingRow({ id: 'legacy' });
      expect(row.visibility).toBe('public');
      store.tables.harnesses.push(row);
      expect(await listingIds(await api.request('/listings', {}, env))).toEqual(['legacy']);
    });

    it('?tenant= NARROWS within public rows and cannot reveal another tenant', async () => {
      // The public route is unauthenticated, so `tenant` maps to the narrowing
      // `tenant_ref`. Asking for pot-a must not surface pot-a's PRIVATE row.
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'a-pub', visibility: 'public', tenant_id: 'pot-a' }),
        makeListingRow({ id: 'a-priv', visibility: 'private', tenant_id: 'pot-a' }),
        makeListingRow({ id: 'b-pub', visibility: 'public', tenant_id: 'pot-b' }),
      );
      const res = await api.request('/listings?tenant=pot-a', {}, env);
      expect(await listingIds(res)).toEqual(['a-pub']);
    });

    it('an authorized tenant_scope WIDENS to that tenant only', async () => {
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'global', visibility: 'public' }),
        makeListingRow({ id: 'a-priv', visibility: 'private', tenant_id: 'pot-a' }),
        makeListingRow({ id: 'a-unl', visibility: 'unlisted', tenant_id: 'pot-a' }),
        makeListingRow({ id: 'b-priv', visibility: 'private', tenant_id: 'pot-b' }),
      );
      const page = await listPublicHarnessesPage(env.DB, { tenant_scope: 'pot-a' });
      expect(page.results.map((r) => r.id).sort()).toEqual(['a-priv', 'a-unl', 'global']);
      // pot-b's private row is absent — the widening is scoped, not global.
      expect(page.results.some((r) => r.id === 'b-priv')).toBe(false);
    });

    it('facet counts obey the same visibility scope as the rows', async () => {
      // A summary computed over a wider population than the rows would leak the
      // EXISTENCE of private listings through the facet numbers alone.
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'pub', visibility: 'public', listing_kind: 'plugin' }),
        makeListingRow({ id: 'priv', visibility: 'private', tenant_id: 'pot-a', listing_kind: 'plugin' }),
      );
      const scoped = await summarizePublicHarnesses(env.DB, {});
      expect(scoped.total).toBe(1);
      expect(scoped.kind_facets.plugin).toBe(1);
      const widened = await summarizePublicHarnesses(env.DB, { tenant_scope: 'pot-a' });
      expect(widened.total).toBe(2);
      expect(widened.kind_facets.plugin).toBe(2);
    });

    it('rejects an unknown visibility filter rather than ignoring it', async () => {
      // Silently dropping an unrecognized filter is how a caller believes it
      // asked for a narrow set and receives a wide one.
      const { env } = makeEnv();
      const res = await api.request('/listings?visibility=secret', {}, env);
      expect(res.status).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('visibility');
    });

    it('publishes a private listing and refuses one with no owning tenant', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const bad = await publish(api, env, { ...BASE, visibility: 'private' });
      expect(bad.status).toBe(400);
      expect((await bad.json() as { field: string }).field).toBe('tenant_id');

      const ok = await publish(api, env, { ...BASE, visibility: 'private', tenant_id: 'pot-a' });
      expect(ok.status).toBe(200);
      const { listing } = (await ok.json()) as { listing: { visibility: string; tenant_id: string } };
      expect(listing.visibility).toBe('private');
      expect(listing.tenant_id).toBe('pot-a');
    });
  });

  describe('SKU + pricing (provider-neutral)', () => {
    it('publishes a priced listing and filters by pricing model', async () => {
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'free' }),
        makeListingRow({ id: 'sub', sku_ref: 'sku_1', pricing_model: 'subscription', price_amount_micros: 9_000_000, price_currency: 'USD' }),
        makeListingRow({ id: 'use', sku_ref: 'sku_2', pricing_model: 'per-use', price_amount_micros: 250, price_currency: 'USDC' }),
      );
      expect(await listingIds(await api.request('/listings?pricing=per-use', {}, env))).toEqual(['use']);
      expect((await listingIds(await api.request('/listings?paid=1', {}, env))).sort()).toEqual(['sub', 'use']);
      expect(await listingIds(await api.request('/listings?paid=0', {}, env))).toEqual(['free']);
    });

    it('refuses a half-declared price', async () => {
      // sku_ref without amount/currency is an unchargeable listing that only
      // fails at purchase time, when a buyer is already committed.
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const res = await publish(api, env, { ...BASE, pricing_model: 'one-time', sku_ref: 'sku_1' });
      expect(res.status).toBe(400);
      expect((await res.json() as { field: string }).field).toBe('price_amount_micros');
    });

    it('rejects a fractional or negative price amount', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      for (const amount of [-1, 1.5]) {
        const res = await publish(api, env, {
          ...BASE, pricing_model: 'one-time', sku_ref: 'sku_1', price_currency: 'USD', price_amount_micros: amount,
        });
        expect(res.status).toBe(400);
        expect((await res.json() as { field: string }).field).toBe('price_amount_micros');
      }
    });

    it('accepts free without a SKU', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const res = await publish(api, env, { ...BASE, pricing_model: 'free' });
      expect(res.status).toBe(200);
    });
  });

  describe('compatibility + permissions', () => {
    it('filters by platform, runtime, and requested permission', async () => {
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({
          id: 'mac',
          compatibility_json: JSON.stringify({ runtime: 'node>=22', platforms: ['darwin-aarch64'] }),
          required_permissions: JSON.stringify(['fs.read']),
        }),
        makeListingRow({
          id: 'linux',
          compatibility_json: JSON.stringify({ runtime: 'node>=20', platforms: ['linux-x86_64'] }),
          required_permissions: JSON.stringify(['fs.read', 'net.fetch']),
        }),
        makeListingRow({ id: 'plain' }),
      );
      expect(await listingIds(await api.request('/listings?platform=linux-x86_64', {}, env))).toEqual(['linux']);
      expect(await listingIds(await api.request('/listings?runtime=node%3E%3D22', {}, env))).toEqual(['mac']);
      expect(await listingIds(await api.request('/listings?permission=net.fetch', {}, env))).toEqual(['linux']);
      expect((await listingIds(await api.request('/listings?permission=fs.read', {}, env))).sort()).toEqual(['linux', 'mac']);
    });

    it('a malformed compatibility column filters like an absent one, never a 500', async () => {
      // A single bad row must not take down the whole storefront page — the
      // predicate carries json_valid() for exactly this.
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'broken', compatibility_json: '{not json' }),
        makeListingRow({ id: 'good', compatibility_json: JSON.stringify({ platforms: ['linux-x86_64'] }) }),
      );
      const res = await api.request('/listings?platform=linux-x86_64', {}, env);
      expect(res.status).toBe(200);
      expect(await listingIds(res)).toEqual(['good']);
    });

    it('round-trips compatibility and permissions through publish', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const res = await publish(api, env, {
        ...BASE,
        compatibility: { runtime: 'node>=22', platforms: ['darwin-aarch64'], architectures: ['arm64'] },
        required_permissions: ['fs.read', 'net.fetch'],
      });
      expect(res.status).toBe(200);
      const { listing } = (await res.json()) as {
        listing: { compatibility_json: string; required_permissions: string };
      };
      expect(JSON.parse(listing.compatibility_json)).toEqual({
        runtime: 'node>=22', platforms: ['darwin-aarch64'], architectures: ['arm64'],
      });
      expect(JSON.parse(listing.required_permissions)).toEqual(['fs.read', 'net.fetch']);
    });

    it('rejects a duplicate permission and a non-string permission', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const dup = await publish(api, env, { ...BASE, required_permissions: ['fs.read', 'fs.read'] });
      expect((await dup.json() as { reason: string }).reason).toBe('duplicate_permission');
      const bad = await publish(api, env, { ...BASE, required_permissions: [42] });
      expect((await bad.json() as { field: string }).field).toBe('required_permissions');
    });

    it('rejects a non-object compatibility', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const res = await publish(api, env, { ...BASE, compatibility: ['darwin'] });
      expect((await res.json() as { field: string }).field).toBe('compatibility');
    });
  });

  describe('immutable release identity', () => {
    it('publishes a release and requires content identity alongside a version', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const hash = `sha256:${'a'.repeat(64)}`;

      const noHash = await publish(api, env, { ...BASE, release_version: '1.0.0' });
      expect((await noHash.json() as { field: string }).field).toBe('release_content_hash');

      const noVersion = await publish(api, env, { ...BASE, release_content_hash: hash });
      expect((await noVersion.json() as { field: string }).field).toBe('release_version');

      const ok = await publish(api, env, {
        ...BASE,
        release_version: '1.0.0',
        release_content_hash: hash.toUpperCase(),
        release_manifest_digest: 'b'.repeat(64),
        release_signature: 'sig',
      });
      expect(ok.status).toBe(200);
      const { listing } = (await ok.json()) as {
        listing: { release_version: string; release_content_hash: string; release_published_at: number };
      };
      expect(listing.release_version).toBe('1.0.0');
      // Normalized to lowercase so a hash comparison never fails on case alone.
      expect(listing.release_content_hash).toBe(hash);
      expect(typeof listing.release_published_at).toBe('number');
    });

    it('rejects a content hash that is not sha256:<64 hex>', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      for (const bad of ['deadbeef', 'sha256:xyz', `sha1:${'a'.repeat(40)}`]) {
        const res = await publish(api, env, { ...BASE, release_version: '1.0.0', release_content_hash: bad });
        expect(res.status).toBe(400);
        expect((await res.json() as { field: string }).field).toBe('release_content_hash');
      }
    });

    it('yanked and revoked releases leave browse but keep their row', async () => {
      // Withdrawal is additive: the row (and its version) survives forever, so a
      // dependency pinned to it can still be RESOLVED and reported as yanked
      // rather than vanishing into a 404.
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'live' }),
        makeListingRow({ id: 'yanked', yanked_at: 1, yanked_reason: 'bad build' }),
        makeListingRow({ id: 'revoked', revoked_at: 2, revoked_reason: 'compromised key' }),
      );
      expect(await listingIds(await api.request('/listings', {}, env))).toEqual(['live']);
      expect(store.tables.harnesses).toHaveLength(3);

      const withWithdrawn = await listPublicHarnessesPage(env.DB, { include_withdrawn: true });
      expect(withWithdrawn.results.map((r) => r.id).sort()).toEqual(['live', 'revoked', 'yanked']);
    });
  });

  describe('identity facet (migration 035 / portable-identity-packages P-016)', () => {
    const IDENTITY = {
      ...BASE,
      listing_kind: 'blueprint',
      listing_ref: 'reviewer',
      blueprint_kind: 'identity',
    };
    const SURFACE = JSON.stringify({ schemaVersion: 1, id: 'reviewer', slots: ['reviewer'] });

    it('stores and returns the declared surface of an identity listing', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const res = await publish(api, env, { ...IDENTITY, identity_surface: SURFACE });
      expect(res.status).toBe(200);
      const { listing } = (await res.json()) as {
        listing: { blueprint_kind: string; identity_surface: string };
      };
      expect(listing.blueprint_kind).toBe('identity');
      // Stored verbatim: the installer recomputes the surface and compares, so the
      // Worker must not re-serialize what the publisher signed off on.
      expect(listing.identity_surface).toBe(SURFACE);
    });

    it('refuses an identity listing without a surface, and a surface on anything else', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      const missing = await publish(api, env, IDENTITY);
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({
        field: 'identity_surface',
        reason: 'required_with_identity_blueprint_kind',
      });

      for (const body of [
        { ...IDENTITY, blueprint_kind: 'harness', identity_surface: SURFACE },
        { ...BASE, identity_surface: SURFACE },
      ]) {
        const res = await publish(api, env, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ field: 'identity_surface', reason: 'blueprint_identity_only' });
      }
    });

    it('refuses a surface that is not a bounded JSON object', async () => {
      const { env } = makeEnv();
      stubGithub({ user: { id: 1, login: 'alice' }, repo: { id: 7, private: false } });
      for (const [surface, reason] of [
        ['not json', 'json_object'],
        ['[1,2]', 'json_object'],
        ['null', 'json_object'],
        [JSON.stringify({ pad: 'x'.repeat(16001) }), 'non_empty_string_max_16000'],
        [{ inline: 'object' }, 'non_empty_string_max_16000'],
      ] as const) {
        const res = await publish(api, env, { ...IDENTITY, identity_surface: surface });
        expect(res.status, JSON.stringify(surface).slice(0, 40)).toBe(400);
        expect(await res.json()).toMatchObject({ field: 'identity_surface', reason });
      }
    });

    it('?blueprint_kind= narrows browse to that blueprint facet and rejects an unknown one', async () => {
      const { env, store } = makeEnv();
      store.tables.harnesses.push(
        makeListingRow({ id: 'identity', listing_kind: 'blueprint', blueprint_kind: 'identity', identity_surface: SURFACE }),
        makeListingRow({ id: 'hive', listing_kind: 'blueprint', blueprint_kind: 'hive' }),
        makeListingRow({ id: 'plain', listing_kind: 'blueprint' }),
        makeListingRow({ id: 'plugin', listing_kind: 'plugin' }),
      );
      expect(await listingIds(await api.request('/listings?blueprint_kind=identity', {}, env))).toEqual(['identity']);
      expect(await listingIds(await api.request('/listings?blueprint_kind=hive', {}, env))).toEqual(['hive']);
      // Composes with the kind filter rather than overriding it.
      expect(await listingIds(await api.request('/listings?kind=plugin&blueprint_kind=identity', {}, env))).toEqual([]);

      const bad = await api.request('/listings?blueprint_kind=persona', {}, env);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: 'invalid_field', field: 'blueprint_kind' });
    });
  });

  describe('filters compose', () => {
    it('narrows on kind, pricing, platform, and permission together', async () => {
      const { env, store } = makeEnv();
      const compat = JSON.stringify({ platforms: ['linux-x86_64'] });
      const perms = JSON.stringify(['net.fetch']);
      store.tables.harnesses.push(
        makeListingRow({ id: 'match', listing_kind: 'plugin', sku_ref: 's', pricing_model: 'per-use', compatibility_json: compat, required_permissions: perms }),
        makeListingRow({ id: 'wrong-kind', listing_kind: 'template', sku_ref: 's', pricing_model: 'per-use', compatibility_json: compat, required_permissions: perms }),
        makeListingRow({ id: 'wrong-price', listing_kind: 'plugin', compatibility_json: compat, required_permissions: perms }),
        makeListingRow({ id: 'wrong-platform', listing_kind: 'plugin', sku_ref: 's', pricing_model: 'per-use', compatibility_json: JSON.stringify({ platforms: ['darwin-aarch64'] }), required_permissions: perms }),
      );
      const res = await api.request(
        '/listings?kind=plugin&pricing=per-use&platform=linux-x86_64&permission=net.fetch',
        {},
        env,
      );
      expect(await listingIds(res)).toEqual(['match']);
    });
  });
});
