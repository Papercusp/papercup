/**
 * Toast log read API. Function-of-truth for both:
 *   - GET /api/toast-log (HTTP route)
 *   - notifications:recent MCP tool
 *
 * Keep transport concerns (NextRequest, ctx.json) in the callers.
 */

import { getOrgPg } from '@restart/db-org';
import { ensureToastLogTable } from './ensure-schema';

export interface ToastRow {
  id: number;
  level: string;
  message: string;
  description: string | null;
  harnessSlug: string | null;
  createdAt: number;
  actionLabel: string | null;
  actionHref: string | null;
}

export interface ListToastsInput {
  limit?: number;
  since?: number;
  slug?: string | null;
}

interface DbRow {
  id: string;
  level: string;
  message: string;
  description: string | null;
  harness_slug: string | null;
  created_at: string;
  action_label: string | null;
  action_href: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function listToasts(input: ListToastsInput = {}): Promise<{ toasts: ToastRow[] }> {
  const limit = Math.min(500, Math.max(1, Number(input.limit ?? 50) || 50));
  const since = Number(input.since ?? 0) || 0;
  const slugClause = input.slug && SLUG_RE.test(input.slug) ? input.slug : null;

  await ensureToastLogTable();
  const { sql } = getOrgPg();
  const rows = slugClause
    ? ((await sql`
        SELECT id, level, message, description, harness_slug, created_at, action_label, action_href
        FROM harness_shared.toast_log
        WHERE created_at >= ${since}
          AND harness_slug = ${slugClause}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as DbRow[])
    : ((await sql`
        SELECT id, level, message, description, harness_slug, created_at, action_label, action_href
        FROM harness_shared.toast_log
        WHERE created_at >= ${since}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as DbRow[]);

  return {
    toasts: rows.map((r) => ({
      id: Number(r.id),
      level: r.level,
      message: r.message,
      description: r.description,
      harnessSlug: r.harness_slug,
      createdAt: Number(r.created_at),
      actionLabel: r.action_label,
      actionHref: r.action_href,
    })),
  };
}
