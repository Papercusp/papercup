/**
 * Cross-harness coordination endpoints. Companion to
 * apps/operator/app/api/admin/execute-action/route.ts.
 *
 * - GET    /api/harness/:slug/inbox
 * - GET    /api/harness/:slug/outbox
 * - GET    /api/harness/:slug/supervisor-notes
 * - POST   /api/harness/:slug/messages       — user-facing send_message wrapper
 *                                               (uses the receiving slug's own token internally)
 * - GET    /api/harness/all/recent-activity
 * - GET    /api/marketplace/spawnable
 *
 * The inbox/outbox/supervisor-notes endpoints are reads only — they require
 * no auth (operator-local, dashboard polls them). The POST messages
 * endpoint shells the request through the slug-less /api/admin/execute-action
 * using the SOURCE harness's own token, so the user-facing curl doesn't
 * need to manage tokens. Cross-harness writes from agents go directly to
 * /api/admin/execute-action with their own bearer.
 */
import type { Hono } from 'hono';
import { getOrgPg, withWorkspace } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readRecentActivity } from '@/lib/cross-harness-data';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { papercuspPath } from '@/lib/papercusp-root';

function slugToSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function registerCrossHarness(harness: Hono) {
  // ── inbox / outbox / supervisor-notes ─────────────────────────────────

  harness.get('/:slug/inbox', async (c) => {
    const slug = c.req.param('slug');
    const status = c.req.query('status') ?? 'pending';
    const role = c.req.query('role'); // optional: filter to messages addressed to this role (or unaddressed)
    const limit = clampLimit(c.req.query('limit'), 20, 200);
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
      return c.json({ slug, status, role: role ?? null, messages: rows });
    } catch (e: any) {
      return c.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, 500);
    }
  });

  harness.get('/:slug/outbox', async (c) => {
    const slug = c.req.param('slug');
    const limit = clampLimit(c.req.query('limit'), 20, 200);
    const schema = slugToSchema(slug);
    try {
      const { sql } = getOrgPg();
      // Outbox = messages this harness sent. They live in the recipient's schema,
      // so we collect across all schemas via a simple per-target lookup. For v1
      // we return the rows from this harness's OWN schema (sent here when this
      // slug is a recipient via cross-target reads), AND scan known schemas.
      // Simplest correct query: scan all `harness_%.messages` for from_slug match.
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
      return c.json({ slug, messages: rows.slice(0, limit) });
    } catch (e: any) {
      return c.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, 500);
    }
  });

  harness.get('/:slug/supervisor-notes', async (c) => {
    const slug = c.req.param('slug');
    const limit = clampLimit(c.req.query('limit'), 10, 100);
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
      return c.json({ slug, notes: rows });
    } catch (e: any) {
      return c.json({ error: 'failed', detail: String(e?.message).slice(0, 300) }, 500);
    }
  });

  // ── User-facing send_message wrapper ───────────────────────────────────
  // POST /api/harness/:slug/messages
  // Body: { to[], kind, subject, body, reason }
  // Uses the receiving slug's own token (the slug in the URL is the SENDER).
  // This is the operator-local convenience wrapper for users to drop a
  // message from a harness without dealing with tokens.
  harness.post('/:slug/messages', async (c) => {
    const fromSlug = c.req.param('slug');
    const body = await c.req.json().catch(() => ({}));
    if (!body || !Array.isArray(body.to) || !body.kind || !body.subject) {
      return c.json({ error: 'validation_error', detail: 'to[], kind, subject required' }, 400);
    }
    // Read the sender's token from PG (we have it indexed already).
    // Workspace-scoped: only tokens belonging to the active workspace.
    const rows = await withWorkspace(activeWorkspaceId(), async (tx) => {
      return await tx<{ token: string }[]>`
        SELECT token FROM harness_shared.token_index WHERE harness_slug = ${fromSlug} LIMIT 1
      `;
    });
    if (rows.length === 0) {
      return c.json({ error: 'not_found', detail: `harness ${fromSlug} has no token registered` }, 404);
    }
    const token = rows[0].token;
    const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
    const r = await fetch(`${operatorBase}/api/admin/execute-action`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'content-type': 'application/json',
      },
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
    return c.json(json, r.status as any);
  });

  // ── Global recent activity feed (Tier 3) ──────────────────────────────
  // Backed by lib/cross-harness-data.ts so the MCP tool
  // cross_harness:recent_activity sees the same shape. Fixed
  // 2026-05-10: previous impl SELECTed `harness_slug` (column doesn't
  // exist in audit_log) and used to_char on a bigint ts (now
  // to_timestamp(ts/1000)).
  harness.get('/all/recent-activity', async (c) => {
    const limit = clampLimit(c.req.query('limit'), 20, 200);
    try {
      const events = await readRecentActivity(limit);
      return c.json({ events });
    } catch (e: unknown) {
      return c.json({ error: 'failed', detail: String((e as Error)?.message).slice(0, 300) }, 500);
    }
  });
}

// Marketplace spawnable catalog — registered separately on the operator's
// /api/marketplace path (NOT on the harness Hono app).
// TTL cache for the spawnable list. The endpoint is read every time
// the prompt-builder validates a 'scaffold_harness' verb and on every
// dashboard mount; under c=10 contention it was 96 ms p50 / 644 ms p99
// because each call did a cross-port self-fetch (operator -> operator
// -> marketplace) plus a per-harness fs walk. Snapshots/templates change
// rarely; a 10 s TTL keeps the data fresh enough for UX while collapsing
// concurrent callers via the in-flight promise pattern used elsewhere.
interface SpawnableCacheEntry {
  expires: number;
  inflight: Promise<{ spawnable: any[] }> | null;
  value: { spawnable: any[] } | null;
}
const __spawnableCacheKey = Symbol.for('papercusp.spawnableCache');
type SpawnableCacheGlobals = typeof globalThis & { [__spawnableCacheKey]?: SpawnableCacheEntry };
const __spawnableCache: SpawnableCacheEntry = (() => {
  const g = globalThis as SpawnableCacheGlobals;
  if (!g[__spawnableCacheKey]) g[__spawnableCacheKey] = { expires: 0, inflight: null, value: null };
  return g[__spawnableCacheKey]!;
})();

async function computeSpawnableTemplates(): Promise<{ spawnable: any[] }> {
  // Read from the existing catalog endpoint, filter by spawnable field.
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  let catalog: any[] = [];
  try {
    const r = await fetch(`${operatorBase}/api/marketplace/catalog`);
    if (r.ok) {
      const d: any = await r.json();
      catalog = Array.isArray(d?.templates) ? d.templates : Array.isArray(d) ? d : [];
    }
  } catch { /* fall through */ }

  // Also scan locally-installed templates for spawnable fields.
  // Parallelized: serial fs.readFile in Next.js dev costs ~150ms per call
  // due to HMR file-tracking instrumentation. See /docs/performance #A1.
  const harnessesDir = process.env.PAPERCUSP_HARNESSES_DIR ?? papercuspPath('harnesses');
  const localSpawnable: any[] = [];
  if (existsSync(harnessesDir)) {
    try {
      const entries = await fs.readdir(harnessesDir);
      const results = await Promise.all(entries.map(async (name) => {
        const manifestPath = join(harnessesDir, name, 'papercusp.json');
        if (!existsSync(manifestPath)) return null;
        try {
          const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          if (m.spawnable && typeof m.spawnable === 'object') {
            return {
              name: m.name ?? name,
              version: m.version ?? '0.0.0',
              description: m.description,
              spawnable: m.spawnable,
              source: 'local' as const,
            };
          }
        } catch { /* skip */ }
        return null;
      }));
      for (const r of results) if (r) localSpawnable.push(r);
    } catch { /* skip */ }
  }

  // Merge: local-installed overrides catalog entries with same name.
  const catalogSpawnable = catalog
    .filter((t) => t && typeof t === 'object' && t.spawnable && typeof t.spawnable === 'object')
    .map((t) => ({ ...t, source: 'catalog' }));
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const t of localSpawnable) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
  }
  for (const t of catalogSpawnable) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    merged.push(t);
  }
  return { spawnable: merged };
}

export async function getSpawnableTemplates(): Promise<{ spawnable: any[] }> {
  const now = Date.now();
  const TTL_MS = 10_000;
  if (__spawnableCache.value && __spawnableCache.expires > now) return __spawnableCache.value;
  if (!__spawnableCache.inflight) {
    __spawnableCache.inflight = (async () => {
      const result = await computeSpawnableTemplates();
      __spawnableCache.value = result;
      __spawnableCache.expires = Date.now() + TTL_MS;
      __spawnableCache.inflight = null;
      return result;
    })();
  }
  return __spawnableCache.inflight;
}
