import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { listingsRoute } from './listings.ts';
import { reportsRoute } from './reports.ts';
import { bindingRoute } from './binding.ts';
import { adminRoute } from './admin.ts';
import { workspaceHostArtifactsRoute } from './workspace-host-artifacts.ts';
import { creatorDraftsRoute } from './creator-drafts.ts';
import { commerceRoute } from './commerce.ts';
import { walletBindingRoute } from './wallet-binding.ts';
import { prepaidCreditsRoute } from './prepaid-credits.ts';
import type { Organization } from '@papercusp/operator-core/lib/cupboard/commerce-accounts';
import { prepaidCreditCatalogEvents } from '@papercusp/operator-core/lib/cupboard/prepaid-credits.ts';
import { appendLedgerEvents, projectLedger } from '../commerce-store.ts';
import { projectPrepaidCredits } from '../prepaid-credit-store.ts';

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
  // The top-up SKU is a fixed idempotent catalog fact. Install it immediately
  // before the existing Checkout handler reads the commerce ledger, without
  // modifying that shared route while parallel commerce work is in flight.
  api.use('/commerce/checkout-sessions', async (c, next) => {
    await appendLedgerEvents(c.env.DB, prepaidCreditCatalogEvents());
    await projectLedger(c.env.DB);
    await next();
  });
  // A signed accepted webhook has already updated the commerce authority when
  // control returns here. Rebuild the dependent credit projection before the
  // 200 reaches Stripe. Duplicates run the same repair path, so a prior
  // projection failure is recovered by the provider's normal retry.
  api.use('/commerce/webhooks/*', async (c, next) => {
    await next();
    if (c.res.status === 200) await projectPrepaidCredits(c.env.DB);
  });
  api.route('/', commerceRoute({ fetchImpl: options.fetchImpl, loadOrgs: options.loadOrgs }));
  api.route('/', walletBindingRoute());
  api.route('/', prepaidCreditsRoute());
  api.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal', detail: msg }, 500);
  });
  return api;
}
