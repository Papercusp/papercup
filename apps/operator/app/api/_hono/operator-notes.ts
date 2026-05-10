/**
 * /api/harness/:slug/features/:featureId/notes — feature-scoped operator notes.
 *
 * Phase A "Steer" primitive: the user appends guidance for the worker working
 * on a specific feature. Stored at `<projectDir>/.harness/notes/<featureId>.md`,
 * which the worker prompt's Required Reads pulls on each invocation.
 *
 * Endpoints:
 *   GET  /:slug/features/:featureId/notes  → { raw, blocks: [{author, ts, body}] }
 *   POST /:slug/features/:featureId/notes  body: { content, author? }
 */
import type { Hono } from 'hono';
import { appendOperatorNote, readOperatorNotes } from '../../../lib/operator-notes';

export function registerOperatorNotes(harness: Hono): void {
  harness.get('/:slug/features/:featureId/notes', async (c) => {
    const slug = c.req.param('slug');
    const featureId = c.req.param('featureId');
    const result = await readOperatorNotes(slug, featureId);
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json(result);
  });

  harness.post('/:slug/features/:featureId/notes', async (c) => {
    const slug = c.req.param('slug');
    const featureId = c.req.param('featureId');
    let body: { content?: string; author?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const result = await appendOperatorNote({
      slug,
      featureId,
      content: body.content ?? '',
      author: body.author,
    });
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, ...result });
  });
}
