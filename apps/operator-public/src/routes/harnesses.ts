/**
 * /harnesses — publish, list, get-by-id, unlist.
 *
 * Per v5 §10.3 + addendum 1:
 *   POST /harnesses           — publish a new harness; GitHub auth + 5/hr cap
 *   GET  /harnesses           — list (public, no auth, paginated)
 *   GET  /harnesses/:id       — single listing detail
 *   DELETE /harnesses/:id     — unlist (publisher only)
 *   POST /harnesses/:id/claim — claim by maintain/admin perm (per §5.1 / P-068)
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import {
  audit,
  clientIp,
  getHarnessById,
  getHarnessByGithubRepoId,
  insertHarness,
  listHarnesses,
  markHarnessUnlisted,
  setHarnessClaim,
} from '../db.ts';
import {
  AuthError,
  extractBearer,
  resolveGithubBearer,
  checkRepoPermission,
} from '../auth.ts';
import { checkAndRecordUserPublishHourly, checkIpListPerMinute, RateLimitError } from '../ratelimit.ts';

interface PublishBody {
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title?: string;
  description?: string;
  topic_hex: string;                 // 32-byte hex Hypercore topic
}

const TOPIC_HEX_RE = /^[0-9a-f]{64}$/;

function uuidv4(): string {
  // crypto.randomUUID is available in Workers + Node 19+ + browser
  return (crypto as { randomUUID: () => string }).randomUUID();
}

export function harnessesRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // GET /harnesses — public listing.
  app.get('/harnesses', async (c) => {
    const ip = clientIp(c.req.raw);
    try {
      await checkIpListPerMinute(c.env, ip);
    } catch (e) {
      if (e instanceof RateLimitError) return c.json({ error: 'rate_limited' }, 429);
      throw e;
    }
    const url = new URL(c.req.url);
    const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
    const cursor = url.searchParams.get('cursor');
    const search = url.searchParams.get('q') ?? undefined;
    const claim_status_raw = url.searchParams.get('claim');
    const claim_status =
      claim_status_raw === 'claimed' || claim_status_raw === 'unclaimed'
        ? claim_status_raw
        : undefined;
    const rows = await listHarnesses(c.env.DB, {
      limit,
      cursor: cursor ? parseInt(cursor, 10) : null,
      search,
      claim_status,
    });
    const next_cursor =
      rows.length === limit ? rows[rows.length - 1].last_activity_at : null;
    return c.json({ results: rows, next_cursor });
  });

  // GET /harnesses/:id — single listing.
  app.get('/harnesses/:id', async (c) => {
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row || row.unlisted_at) return c.json({ error: 'not_found' }, 404);
    return c.json(row);
  });

  // POST /harnesses — publish.
  app.post('/harnesses', async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const now = Date.now();

    try {
      await checkAndRecordUserPublishHourly(c.env, user.id, now);
    } catch (e) {
      if (e instanceof RateLimitError) {
        await audit(c.env.DB, now, 'publish_rate_limited', { user_id: user.id });
        return c.json({ error: 'rate_limited', bucket: e.bucket }, 429);
      }
      throw e;
    }

    let body: PublishBody;
    try {
      body = (await c.req.json()) as PublishBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Field validation.
    if (typeof body.github_repository_id !== 'number' || body.github_repository_id <= 0) {
      return c.json({ error: 'invalid_field', field: 'github_repository_id' }, 400);
    }
    if (typeof body.github_owner !== 'string' || !body.github_owner) {
      return c.json({ error: 'invalid_field', field: 'github_owner' }, 400);
    }
    if (typeof body.github_name !== 'string' || !body.github_name) {
      return c.json({ error: 'invalid_field', field: 'github_name' }, 400);
    }
    if (typeof body.github_url !== 'string' || !/^https:\/\/github\.com\//.test(body.github_url)) {
      return c.json({ error: 'invalid_field', field: 'github_url' }, 400);
    }
    if (typeof body.topic_hex !== 'string' || !TOPIC_HEX_RE.test(body.topic_hex)) {
      return c.json({ error: 'invalid_field', field: 'topic_hex' }, 400);
    }
    if (body.description != null && (typeof body.description !== 'string' || body.description.length > 280)) {
      return c.json({ error: 'invalid_field', field: 'description' }, 400);
    }
    if (body.title != null && (typeof body.title !== 'string' || body.title.length > 200)) {
      return c.json({ error: 'invalid_field', field: 'title' }, 400);
    }

    // Reject if the GitHub repo is private. Check via authed GitHub API
    // — we already have the publisher's token, and they must have at
    // least read perm on a repo they're publishing.
    const ghCheck = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(body.github_owner)}/${encodeURIComponent(body.github_name)}`,
      {
        headers: {
          Authorization: `Bearer ${extractBearer(c.req.raw)}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'papercusp-cupboard',
        },
      },
    );
    if (!ghCheck.ok) {
      return c.json({ error: 'github_repo_unreachable', status: ghCheck.status }, 400);
    }
    const repoMeta = (await ghCheck.json()) as { id?: number; private?: boolean };
    if (repoMeta.private) {
      return c.json({ error: 'private_repo_rejected' }, 400);
    }
    if (repoMeta.id !== body.github_repository_id) {
      return c.json({ error: 'repository_id_mismatch', expected: repoMeta.id }, 400);
    }

    // Dedup: if a harness already exists for this repo_id, return it.
    const existing = await getHarnessByGithubRepoId(c.env.DB, body.github_repository_id);
    if (existing) {
      await audit(c.env.DB, now, 'publish_dedup', {
        github_repository_id: body.github_repository_id,
        existing_id: existing.id,
        user_id: user.id,
      });
      return c.json({ ok: true, id: existing.id, harness: existing, dedup: true });
    }

    const id = uuidv4();
    await insertHarness(c.env.DB, {
      id,
      github_repository_id: body.github_repository_id,
      github_owner: body.github_owner,
      github_name: body.github_name,
      github_url: body.github_url,
      title: body.title ?? body.github_name,
      description: body.description ?? null,
      topic_hex: body.topic_hex,
      publisher_github_user_id: user.id,
      publisher_github_login: user.login,
      created_at: now,
    });
    await audit(c.env.DB, now, 'published', {
      id,
      github_repository_id: body.github_repository_id,
      publisher_github_user_id: user.id,
    });
    const harness = await getHarnessById(c.env.DB, id);
    return c.json({ ok: true, id, harness });
  });

  // DELETE /harnesses/:id — unlist (publisher or claimant).
  app.delete('/harnesses/:id', async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ ok: true, already_unlisted: true });
    const isPublisher = row.publisher_github_user_id === user.id;
    const isClaimant = row.claimant_github_user_id === user.id;
    if (!isPublisher && !isClaimant) return c.json({ error: 'forbidden' }, 403);
    const now = Date.now();
    await markHarnessUnlisted(c.env.DB, id, 'by_publisher', now);
    await audit(c.env.DB, now, 'unlisted', { id, by_user_id: user.id });
    return c.json({ ok: true });
  });

  // POST /harnesses/:id/claim — claim by maintain/admin perm.
  app.post('/harnesses/:id/claim', async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const id = c.req.param('id');
    const row = await getHarnessById(c.env.DB, id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.unlisted_at) return c.json({ error: 'unlisted' }, 410);
    if (row.claim_status === 'claimed') {
      return c.json({ error: 'already_claimed', claimant_github_user_id: row.claimant_github_user_id }, 409);
    }
    const perm = await checkRepoPermission(
      extractBearer(c.req.raw),
      row.github_owner,
      row.github_name,
      'maintain',
    );
    if (!perm.has_permission) {
      return c.json({ error: 'insufficient_permission', required: 'maintain' }, 403);
    }
    const now = Date.now();
    await setHarnessClaim(c.env.DB, id, { user_id: user.id, login: user.login }, now);
    await audit(c.env.DB, now, 'claimed', { id, user_id: user.id, permission: perm.permission });
    const updated = await getHarnessById(c.env.DB, id);
    return c.json({ ok: true, harness: updated });
  });

  return app;
}
