/**
 * Papercup demo API entrypoint. Mounts:
 *   /api/org/*               — cross-dept message bus, departments, directives
 *   /api/briefings/*         — briefing pipeline coordination
 *   /api/public/papercup/*   — read-only sanitised data for papercupai.com
 */
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { briefings } from '../_hono/briefings';
import { publicPapercup } from '../_hono/public-papercup';

export const dynamic = 'force-dynamic';

const app = new Hono().basePath('/api');

const adminPreviewCors = async (c: any, next: any) => {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type, x-actor');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
};

app.use('/briefings/*', adminPreviewCors);

// CORS for the public read-only API: any origin can hit /api/public/*
// from a browser. Used by papercupai.com when it's hosted on a different domain.
app.use('/public/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'content-type');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.route('/briefings', briefings);
app.route('/public/papercup', publicPapercup);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
