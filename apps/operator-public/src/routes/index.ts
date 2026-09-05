import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { listingsRoute } from './listings.ts';
import { reportsRoute } from './reports.ts';
import { bindingRoute } from './binding.ts';
import { adminRoute } from './admin.ts';
import { workspaceHostArtifactsRoute } from './workspace-host-artifacts.ts';
import { creatorDraftsRoute } from './creator-drafts.ts';
import { commerceRoute } from './commerce.ts';
import type { Organization } from '@papercusp/operator-core/lib/cupboard/commerce-accounts';

/**
 * `fetchImpl` is threaded through to the commerce checkout route so its outbound
 * provider call can be exercised without network access. `loadOrgs` is threaded
 * for the same reason and one more: production has no org writer yet, so the
 * MEMBER-permitted branch of the checkout authorization gate is only reachable
 * from a test until one lands, and an unexercised authorization branch is the
 * one that rots. Production calls `buildApi()` with no options and gets the
 * runtime's own fetch plus the real (empty) org loader.
 */
export function buildApi(
  options: {
    fetchImpl?: typeof fetch;
    loadOrgs?: (db: D1Database) => Promise<ReadonlyMap<string, Organization>>;
  } = {},
): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/', (c) => c.json({ service: 'papercusp-cupboard', status: 'ok' }));
  api.get('/healthz', (c) => c.json({ ok: true }));
  // Generalized storefront: /listings (kind-aware) + /harnesses (kind='harness' view).
  api.route('/', listingsRoute());
  api.route('/', reportsRoute());
  api.route('/', bindingRoute());
  api.route('/', adminRoute());
  api.route('/', workspaceHostArtifactsRoute());
  api.route('/', creatorDraftsRoute());
  api.route('/', commerceRoute({ fetchImpl: options.fetchImpl, loadOrgs: options.loadOrgs }));
  api.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal', detail: msg }, 500);
  });
  return api;
}
