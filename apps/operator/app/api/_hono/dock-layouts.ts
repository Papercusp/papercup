/**
 * /api/dock-layouts/* — per-user named dock layouts.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4.9
 *
 *   GET    /api/dock-layouts/:name   → LayoutDoc + meta (seeds on miss)
 *   PUT    /api/dock-layouts/:name   → 200 | 409 (If-Match: <updated_ts>)
 *   DELETE /api/dock-layouts/:name   → 204 (reseeds on next GET)
 *   GET    /api/dock-layouts         → [{ name, updated_ts }]
 */
import type { Hono } from 'hono';
import {
  getLayout,
  saveLayout,
  deleteLayout,
  listLayouts,
  getUserIdForLayouts,
  validateLayoutDoc,
  LayoutConflictError,
  LayoutValidationError,
  type LayoutDoc,
} from '../../../lib/dock-layouts';

export function registerDockLayouts(app: Hono): void {
  app.get('/dock-layouts', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const list = await listLayouts(principal);
    return c.json({ layouts: list });
  });

  app.get('/dock-layouts/:name', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const name = c.req.param('name');
    try {
      const row = await getLayout(principal, name);
      return c.json(row);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.put('/dock-layouts/:name', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const name = c.req.param('name');
    let body: { layout: LayoutDoc };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body?.layout) {
      return c.json({ error: 'missing { layout }' }, 400);
    }
    try {
      validateLayoutDoc(body.layout);
    } catch (err) {
      if (err instanceof LayoutValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    const ifMatchHeader = c.req.header('if-match');
    const expectedTs = ifMatchHeader ? Number(ifMatchHeader) : undefined;
    if (ifMatchHeader && Number.isNaN(expectedTs)) {
      return c.json({ error: 'If-Match must be numeric updated_ts' }, 400);
    }
    try {
      const row = await saveLayout(principal, name, body.layout, expectedTs);
      return c.json(row);
    } catch (err) {
      if (err instanceof LayoutConflictError) {
        return c.json({ error: err.message }, 409);
      }
      if (err instanceof LayoutValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  app.delete('/dock-layouts/:name', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const name = c.req.param('name');
    await deleteLayout(principal, name);
    return c.body(null, 204);
  });
}
