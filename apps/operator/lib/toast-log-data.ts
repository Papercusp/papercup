/**
 * Toast log read API. Function-of-truth for both:
 *   - GET /api/toast-log (HTTP route)
 *   - notifications:recent MCP tool
 *
 * Keep transport concerns (NextRequest, ctx.json) in the callers.
 */

import { getOrgPg, generated } from '@restart/db-org';
import { and, desc, eq, gte } from 'drizzle-orm';
import { ensureToastLogTable } from './ensure-schema';

const t = generated.toast_logInHarness_shared;

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
  const { db } = getOrgPg();
  const where = slugClause
    ? and(gte(t.created_at, since), eq(t.harness_slug, slugClause))
    : gte(t.created_at, since);
  const rows = (await db
    .select({
      id: t.id,
      level: t.level,
      message: t.message,
      description: t.description,
      harness_slug: t.harness_slug,
      created_at: t.created_at,
      action_label: t.action_label,
      action_href: t.action_href,
    })
    .from(t)
    .where(where)
    .orderBy(desc(t.created_at))
    .limit(limit)) as unknown as DbRow[];

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
