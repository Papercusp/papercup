import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { listingsRoute } from './listings.ts';
import { reportsRoute } from './reports.ts';
import { bindingRoute } from './binding.ts';
import { adminRoute } from './admin.ts';
import { blobsRoute } from './blobs.ts';

export function buildApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/', (c) => c.json({ service: 'papercusp-cupboard', status: 'ok' }));
  api.get('/healthz', (c) => c.json({ ok: true }));
  // Generalized storefront: /listings (kind-aware) + /harnesses (kind='harness' view).
  api.route('/', listingsRoute());
  api.route('/', reportsRoute());
  api.route('/', bindingRoute());
  api.route('/', adminRoute());
  api.route('/', blobsRoute());
  api.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal', detail: msg }, 500);
  });
  return api;
}
