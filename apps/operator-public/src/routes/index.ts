import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { harnessesRoute } from './harnesses.ts';
import { reportsRoute } from './reports.ts';
import { bindingRoute } from './binding.ts';

export function buildApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/', (c) => c.json({ service: 'papercusp-cupboard', status: 'ok' }));
  api.get('/healthz', (c) => c.json({ ok: true }));
  api.route('/', harnessesRoute());
  api.route('/', reportsRoute());
  api.route('/', bindingRoute());
  api.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'internal', detail: msg }, 500);
  });
  return api;
}
