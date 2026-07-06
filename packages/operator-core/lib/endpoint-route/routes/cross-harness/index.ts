/**
 * Cross-harness coordination routes — Phase A1
 * (endpoint-hono-elimination-2026-05-21). Ported off the legacy
 * `_hono/cross-harness.ts` Hono sub-app (mounted via `registerCrossHarness`).
 *
 *   GET  /api/harness/:slug/inbox
 *   GET  /api/harness/:slug/outbox
 *   GET  /api/harness/:slug/supervisor-notes
 *   POST /api/harness/:slug/messages       — user-facing send_message wrapper
 *   GET  /api/harness/all/recent-activity
 *
 * All `auth: 'public'` — the legacy sub-app gated none of these (reads
 * are operator-local dashboard polls; the POST shells through
 * `/api/admin/execute-action` with the sender's own token). Posture
 * preserved verbatim. The `getSpawnableTemplates` helper that lived in
 * the legacy file moved to `lib/spawnable-templates.ts`.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readRecentActivity } from '../../../cross-harness-data';
import { operatorApiBase } from '../../../operator-api-base';

/* eslint-disable @typescript-eslint/no-explicit-any */

function slugToSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

function clampLimit(raw: string | null | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const inbox = defineTool({
  method: 'GET',
  path: '/harness/:slug/inbox',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const q = new URL(req.url).searchParams;
    const status = q.get('status') ?? 'pending';
    const role = q.get('role');
    const limit = clampLimit(q.get('limit'), 20, 200);
    const schema = slugToSchema(slug);
    try {
      const { sql } = getOrgPg();
      let rows: any;
      if (role && /^[a-z][a-z0-9_-]*$/i.test(role)) {
        rows = await sql.unsafe(
          `SELECT id, from_slug, to_slug, to_role, kind, subject, body, parent_message_id, status, created_at, acknowledged_at
           FROM ${schema}.messages
           WHERE to_slug = $1 AND ($2 = 'all' OR status = $2)
             AND (to_role IS NULL OR to_role = $3)
           ORDER BY created_at DESC
           LIMIT $4`,
          [slug, status, role, limit],
        );
      } else {
        rows = await sql.unsafe(
          `SELECT id, from_slug, to_slug, to_role, kind, subject, body, parent_message_id, status, created_at, acknowledged_at
           FROM ${schema}.messages
           WHERE to_slug = $1 AND ($2 = 'all' OR status = $2)
           ORDER BY created_at DESC
           LIMIT $3`,
          [slug, status, limit],
        );
      }
      return Response.json({ slug, status, role: role ?? null, messages: rows });
    } catch (e: any) {
      // scaffoldHarnessSchema is best-effort at join time (join-link.ts) — a
      // harness can be legitimately "usable without schema" (comment there),
      // so an undefined-table/relation error here means "no schema yet", not
      // a real failure. Degrade to an empty inbox instead of a 500 (EI-8xxx).
      if (e?.code === '42P01' || /relation .* does not exist/i.test(String(e?.message))) {
        return Response.json({ slug, status, role: role ?? null, messages: [] });
      }
      return Response.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, { status: 500 });
    }
  },
});

const outbox = defineTool({
  method: 'GET',
  path: '/harness/:slug/outbox',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 20, 200);
    try {
      const { sql } = getOrgPg();
      // Outbox = messages this harness sent; they live in recipients'
      // schemas, so scan every harness_%.messages for from_slug match.
      const schemas = await sql<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace
        WHERE nspname LIKE 'harness\\_%' AND nspname <> 'harness_shared'
      `;
      const rows: any[] = [];
      for (const { nspname } of schemas) {
        const r = await sql.unsafe(
          `SELECT id, from_slug, to_slug, kind, subject, body, status, created_at
           FROM ${nspname}.messages
           WHERE from_slug = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [slug, limit],
        );
        rows.push(...(r as any[]));
      }
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return Response.json({ slug, messages: rows.slice(0, limit) });
    } catch (e: any) {
      return Response.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, { status: 500 });
    }
  },
});

const supervisorNotes = defineTool({
  method: 'GET',
  path: '/harness/:slug/supervisor-notes',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 10, 100);
    const schema = slugToSchema(slug);
    try {
      const { sql } = getOrgPg();
      const rows = await sql.unsafe(
        `SELECT id, body, source, created_at
         FROM ${schema}.supervisor_notes
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return Response.json({ slug, notes: rows });
    } catch (e: any) {
      // Same best-effort-schema rationale as inbox above.
      if (e?.code === '42P01' || /relation .* does not exist/i.test(String(e?.message))) {
        return Response.json({ slug, notes: [] });
      }
      return Response.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, { status: 500 });
    }
  },
});

const messages = defineTool({
  method: 'POST',
  path: '/harness/:slug/messages',
  auth: 'loopback',
  async handler(req, ctx) {
    const fromSlug = ctx.params.slug;
    const body = await req.json().catch(() => ({}));
    if (!body || !Array.isArray(body.to) || !body.kind || !body.subject) {
      return Response.json(
        { error: 'validation_error', detail: 'to[], kind, subject required' },
        { status: 400 },
      );
    }
    // The slug in the URL is the SENDER — read its token from PG (workspace-scoped).
    const rows = await withWorkspace(activeWorkspaceId(), async (tx) => {
      return await tx<{ token: string }[]>`
        SELECT token FROM harness_shared.token_index WHERE harness_slug = ${fromSlug} LIMIT 1
      `;
    });
    if (rows.length === 0) {
      return Response.json(
        { error: 'not_found', detail: `harness ${fromSlug} has no token registered` },
        { status: 404 },
      );
    }
    const token = rows[0].token;
    const operatorBase = operatorApiBase();
    const r = await fetch(`${operatorBase}/api/admin/execute-action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        actionId: body.actionId ?? randomUUID(),
        action: {
          op: 'send_message',
          to: body.to,
          kind: body.kind,
          subject: body.subject,
          body: body.body,
          reason: body.reason ?? `user-curl wrapper from ${fromSlug}`,
        },
      }),
    });
    const json = await r.json().catch(() => ({}));
    return Response.json(json, { status: r.status });
  },
});

const recentActivity = defineTool({
  method: 'GET',
  path: '/harness/all/recent-activity',
  auth: 'public',
  async handler(req) {
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 20, 200);
    try {
      return Response.json({ events: await readRecentActivity(limit) });
    } catch (e: unknown) {
      return Response.json(
        { error: 'failed', detail: String((e as Error)?.message).slice(0, 300) },
        { status: 500 },
      );
    }
  },
});

export default [inbox, outbox, supervisorNotes, messages, recentActivity];

// Note: the `getSpawnableTemplates` helper that the legacy file also
// exported now lives in `lib/spawnable-templates.ts`; `/marketplace/spawnable`
// (routes/marketplace/spawnable.ts) imports it from there.
