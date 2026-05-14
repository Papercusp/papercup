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
  getLastUsedPhase,
  setLastUsedPhase,
  LayoutConflictError,
  LayoutValidationError,
  type LayoutDoc,
} from '../../../lib/dock-layouts';

export function registerDockLayouts(app: Hono): void {
  // Note: /api/dock-layouts (bare) collides with Next.js's catchall handling.
  // The list lives at the `_list` sub-path instead; named GET/PUT/DELETE
  // operate on /api/dock-layouts/:name as documented.
  app.get('/dock-layouts/_list', async (c) => {
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

  // ───────── Last-used phase per harness (Phase 4 of plan v4) ─────────
  //
  //   GET  /api/harness-phase-last-used/:slug         → { phase: 'staging' | … } | { phase: null }
  //   PUT  /api/harness-phase-last-used/:slug         → 204  body: { phase }
  //
  // Reopening an overview panel for a slug defaults to whatever phase
  // the user last had it in for that slug; falls back to 'staging' on
  // miss.

  app.get('/harness-phase-last-used/:slug', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const slug = c.req.param('slug');
    const phase = await getLastUsedPhase(principal, slug);
    return c.json({ phase });
  });

  app.put('/harness-phase-last-used/:slug', async (c) => {
    const principal = getUserIdForLayouts(c.req.raw);
    const slug = c.req.param('slug');
    let body: { phase?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body?.phase || typeof body.phase !== 'string') {
      return c.json({ error: 'missing { phase: string }' }, 400);
    }
    await setLastUsedPhase(principal, slug, body.phase);
    return c.body(null, 204);
  });
}
