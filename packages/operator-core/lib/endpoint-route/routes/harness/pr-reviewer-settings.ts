/**
 * PR-reviewer settings routes — Phase 8 P-049.
 *
 *   GET  /api/harness/:slug/pr-reviewer-settings
 *        → PrReviewerSettingsResponse:
 *          { settings, trustList[], audit[], viewer, editable }
 *
 *   POST /api/harness/:slug/pr-reviewer-settings
 *        body: PrReviewerSettingsPatch (subset of toggles + merge_method)
 *        → { ok: true, settings } | { error }
 *
 *   POST /api/harness/:slug/pr-reviewer-settings/trust/remove
 *        body: { trusted_github_user_id: number }
 *        → { ok: true } | { error }
 *
 * Data sources (all LOCAL, never synced — v5 §7.5):
 *   - settings:  harness_shared.pr_reviewer_settings  (per harness, per viewer github id)
 *   - trustList: harness_shared.trusted_authors       (per harness, trusted-by viewer)
 *   - audit:     harness_shared.auto_review_audit      (recent auto-review/merge actions)
 *
 * Identity / gating: settings + trust are keyed by the VIEWER's GitHub
 * user id, resolved server-side from the local `gh` token
 * (`resolveLocalGithubIdentity`) — single-user loopback desktop means the
 * local identity IS the viewer (same model as the P-072 privacy filter +
 * the P-069 claim-status route). Writes REQUIRE a resolved viewer id;
 * anonymous (no gh auth) → 401, so the UI renders read-only. The settings
 * UI never passes an id from the client — the server is the trust boundary.
 *
 * Auth: 'public' — loopback gate is the trust boundary (same as sibling
 * harness routes); the per-viewer scoping above is the write gate.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-049.
 */

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';
import {
  defaultPrReviewerSettings,
  applyPrReviewerSettingsPatch,
  type PrReviewerSettingsRow,
  type PrReviewerSettingsPatch,
} from '../../../pr-host/pr-reviewer-settings-types';
import { PR_MERGE_METHODS, type PrMergeMethod } from '../../../pr-host/types';

// ─── Wire shapes ──────────────────────────────────────────────────

/** A trust-list entry as returned to the client. */
export interface TrustListEntry {
  trusted_github_user_id: number;
  trusted_login: string | null;
  trusted_at: string;
}

/** An audit-log row as returned to the client. */
export interface AuditEntry {
  id: number;
  pr_number: number;
  pr_url: string | null;
  author_github_id: number | null;
  action: string;
  detail: string | null;
  ts: string;
}

/** The four UI-relevant toggles (mirrors the PG row minus identity). */
export interface SettingsToggles {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: PrMergeMethod;
}

export interface PrReviewerSettingsResponse {
  settings: SettingsToggles;
  trustList: TrustListEntry[];
  audit: AuditEntry[];
  /** Resolved viewer identity (null when no gh auth). */
  viewer: { github_user_id: number; github_login: string } | null;
  /** Whether this viewer may write (true iff a viewer id resolved). */
  editable: boolean;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────

/** Project a full settings row down to the UI-relevant toggles. */
export function toToggles(row: PrReviewerSettingsRow): SettingsToggles {
  return {
    pr_reviewer_role_enabled: row.pr_reviewer_role_enabled,
    auto_review: row.auto_review,
    auto_merge: row.auto_merge,
    merge_method: row.merge_method,
  };
}

/**
 * Validate + normalise a raw settings-patch body into a typed
 * `PrReviewerSettingsPatch`. Only the four known fields are accepted;
 * unknown fields are dropped, bad types rejected. Returns `{ ok:false }`
 * when the body is empty (nothing to update) or a field is malformed.
 */
export function parseSettingsPatch(
  body: unknown,
): { ok: true; patch: PrReviewerSettingsPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;
  const patch: PrReviewerSettingsPatch = {};

  for (const key of ['pr_reviewer_role_enabled', 'auto_review', 'auto_merge'] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
      patch[key] = b[key] as boolean;
    }
  }
  if (b.merge_method !== undefined) {
    if (
      typeof b.merge_method !== 'string' ||
      !(PR_MERGE_METHODS as readonly string[]).includes(b.merge_method)
    ) {
      return { ok: false, error: `merge_method must be one of ${PR_MERGE_METHODS.join(', ')}` };
    }
    patch.merge_method = b.merge_method as PrMergeMethod;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'no recognised fields to update' };
  }
  return { ok: true, patch };
}

/** Validate the trust-remove body → the numeric id to remove. */
export function parseTrustRemoveBody(
  body: unknown,
): { ok: true; trustedId: number } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const raw = (body as { trusted_github_user_id?: unknown }).trusted_github_user_id;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'trusted_github_user_id must be a positive integer' };
  }
  return { ok: true, trustedId: n };
}

// ─── DB row → wire mappers ────────────────────────────────────────

interface SettingsDbRow {
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: string;
  updated_at: string | Date;
}

function dbRowToSettings(
  row: SettingsDbRow | undefined,
  slug: string,
  githubUserId: number,
  now: number,
): PrReviewerSettingsRow {
  if (!row) return defaultPrReviewerSettings({ harness_slug: slug, github_user_id: githubUserId, now });
  return {
    harness_slug: slug,
    github_user_id: githubUserId,
    pr_reviewer_role_enabled: !!row.pr_reviewer_role_enabled,
    auto_review: !!row.auto_review,
    auto_merge: !!row.auto_merge,
    merge_method: (PR_MERGE_METHODS as readonly string[]).includes(row.merge_method)
      ? (row.merge_method as PrMergeMethod)
      : 'squash',
    updated_at: new Date(row.updated_at).getTime(),
  };
}

// ─── Shared identity resolution ───────────────────────────────────

async function viewer(): Promise<{ id: number; login: string } | null> {
  try {
    const r = await resolveLocalGithubIdentity();
    return r.kind === 'ok' ? { id: r.githubUserId, login: r.githubLogin } : null;
  } catch {
    return null;
  }
}

// ─── GET /harness/:slug/pr-reviewer-settings ──────────────────────

const getSettings = defineTool({
  method: 'GET',
  path: '/harness/:slug/pr-reviewer-settings',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const v = await viewer();
    const now = Date.now();

    try {
      const { sql } = getOrgPg();

      // Settings are per-viewer; with no viewer id, return the safe defaults
      // (all-off) read-only.
      const githubUserId = v?.id ?? 0;
      let settingsRow: PrReviewerSettingsRow = defaultPrReviewerSettings({
        harness_slug: slug,
        github_user_id: githubUserId,
        now,
      });
      if (v) {
        const rows = (await sql`
          SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at
            FROM harness_shared.pr_reviewer_settings
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${slug}
             AND github_user_id = ${v.id}
           LIMIT 1
        `) as unknown as SettingsDbRow[];
        settingsRow = dbRowToSettings(rows[0], slug, v.id, now);
      }

      // Trust list — the entries THIS viewer trusts on this harness. Join
      // contributors for display logins (best-effort). With no viewer, empty.
      const trustList: TrustListEntry[] = [];
      if (v) {
        const trustRows = (await sql`
          SELECT t.trusted_github_user_id, t.trusted_at, c.github_username
            FROM harness_shared.trusted_authors t
            LEFT JOIN harness_shared.contributors c
              ON c.workspace_id = t.workspace_id
             AND c.github_user_id = t.trusted_github_user_id
           WHERE t.workspace_id = ${workspaceId}
             AND t.harness_slug = ${slug}
             AND t.trusted_by_github_user_id = ${v.id}
           ORDER BY t.trusted_at DESC
        `) as unknown as Array<{
          trusted_github_user_id: number | string;
          trusted_at: string | Date;
          github_username: string | null;
        }>;
        for (const r of trustRows) {
          trustList.push({
            trusted_github_user_id: Number(r.trusted_github_user_id),
            trusted_login: r.github_username ?? null,
            trusted_at: new Date(r.trusted_at).toISOString(),
          });
        }
      }

      // Recent audit — auto-review + auto-merge actions for this harness.
      // Not viewer-scoped: the audit log is per-machine and shows what
      // auto-actions THIS install took. Cap at 50 most-recent.
      const auditRows = (await sql`
        SELECT id, pr_number, pr_url, author_github_id, action, detail, ts
          FROM harness_shared.auto_review_audit
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${slug}
         ORDER BY ts DESC
         LIMIT 50
      `) as unknown as Array<{
        id: number | string;
        pr_number: number;
        pr_url: string | null;
        author_github_id: number | string | null;
        action: string;
        detail: string | null;
        ts: string | Date;
      }>;
      const audit: AuditEntry[] = auditRows.map((r) => ({
        id: Number(r.id),
        pr_number: Number(r.pr_number),
        pr_url: r.pr_url,
        author_github_id: r.author_github_id == null ? null : Number(r.author_github_id),
        action: r.action,
        detail: r.detail,
        ts: new Date(r.ts).toISOString(),
      }));

      const resp: PrReviewerSettingsResponse = {
        settings: toToggles(settingsRow),
        trustList,
        audit,
        viewer: v ? { github_user_id: v.id, github_login: v.login } : null,
        editable: !!v,
      };
      return Response.json(resp);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Missing schema / PG unreachable → safe-default read-only shape, not 500.
      if (/does not exist|relation .* does not exist/i.test(msg)) {
        const resp: PrReviewerSettingsResponse = {
          settings: toToggles(
            defaultPrReviewerSettings({ harness_slug: slug, github_user_id: v?.id ?? 0, now }),
          ),
          trustList: [],
          audit: [],
          viewer: v ? { github_user_id: v.id, github_login: v.login } : null,
          editable: !!v,
        };
        return Response.json(resp);
      }
      throw e;
    }
  },
});

// ─── POST /harness/:slug/pr-reviewer-settings ─────────────────────

const postSettings = defineTool({
  method: 'POST',
  path: '/harness/:slug/pr-reviewer-settings',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const v = await viewer();
    if (!v) {
      return Response.json(
        { error: 'gh auth required to change PR-reviewer settings' },
        { status: 401 },
      );
    }
    const parsed = parseSettingsPatch(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const { sql } = getOrgPg();
    const now = Date.now();

    const existingRows = (await sql`
      SELECT pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at
        FROM harness_shared.pr_reviewer_settings
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
         AND github_user_id = ${v.id}
       LIMIT 1
    `) as unknown as SettingsDbRow[];
    const existing = dbRowToSettings(existingRows[0], slug, v.id, now);
    const merged = applyPrReviewerSettingsPatch(existing, parsed.patch, now);

    await sql`
      INSERT INTO harness_shared.pr_reviewer_settings
        (workspace_id, harness_slug, github_user_id,
         pr_reviewer_role_enabled, auto_review, auto_merge, merge_method, updated_at)
      VALUES
        (${workspaceId}, ${slug}, ${v.id},
         ${merged.pr_reviewer_role_enabled}, ${merged.auto_review}, ${merged.auto_merge},
         ${merged.merge_method}, now())
      ON CONFLICT (workspace_id, harness_slug, github_user_id) DO UPDATE SET
        pr_reviewer_role_enabled = EXCLUDED.pr_reviewer_role_enabled,
        auto_review              = EXCLUDED.auto_review,
        auto_merge               = EXCLUDED.auto_merge,
        merge_method             = EXCLUDED.merge_method,
        updated_at               = now()
    `;

    return Response.json({ ok: true, settings: toToggles(merged) });
  },
});

// ─── POST /harness/:slug/pr-reviewer-settings/trust/remove ────────

const postTrustRemove = defineTool({
  method: 'POST',
  path: '/harness/:slug/pr-reviewer-settings/trust/remove',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const v = await viewer();
    if (!v) {
      return Response.json({ error: 'gh auth required to edit the trust list' }, { status: 401 });
    }
    const parsed = parseTrustRemoveBody(await req.json().catch(() => null));
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const { sql } = getOrgPg();
    // Only the viewer's own trust entries are removable (trusted_by gate).
    await sql`
      DELETE FROM harness_shared.trusted_authors
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
         AND trusted_by_github_user_id = ${v.id}
         AND trusted_github_user_id = ${parsed.trustedId}
    `;
    return Response.json({ ok: true });
  },
});

export default [getSettings, postSettings, postTrustRemove];
