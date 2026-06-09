/**
 * Shared user-memory list projection (memory-settings-page-refresh P-007).
 *
 * One implementation behind BOTH read surfaces:
 *  - the REST route `GET /api/user/memory` (settings page fallback), and
 *  - the `userMemory.list` sync resolver (the audited @papercusp/sync path).
 *
 * Rows are the neutral entry shape (generalize-memory-backend-swappable
 * D-003) enriched with canonical audit state + timestamps where the mem0
 * canonical store exists. The enrichment is best-effort BY CONTRACT: any
 * failure (pre-085 schema, non-uuid ids from another backend, PG down)
 * degrades to un-enriched rows and can never break the list.
 */
import { getMemoryBackend, type MemoryEntry } from './backend';
import { activeWorkspaceId } from '../workspace-registry';
import { loadHarnessRegistry } from '../harness-registry';
import { getOrgPg } from '@papercusp/db-org';

export interface UserMemoryAudit {
  state: string;
  last_validated_at: string | null;
  last_surfaced_at: string | null;
  broken_anchors: Array<{ kind: string; value: string; reason: string | null }>;
}

export interface UserMemoryRow {
  id: string;
  text: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
  created_at?: string | null;
  updated_at?: string | null;
  audit?: UserMemoryAudit;
}

interface AuditEnrichment extends UserMemoryAudit {
  created_at: string | null;
  updated_at: string | null;
}

// Normalize PG timestamps to ISO here: Node's Date.parse handles the
// driver's '2026-06-09 16:08:51.83-04' string form, but the WebKit
// webview's does not — the client must only ever see ISO.
const iso = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? v : new Date(ms).toISOString();
  }
  return null;
};

/**
 * Enrichment over the mem0 canonical tables — audit state + anchors +
 * timestamps. The uuid columns are compared as text (`id::text = ANY(...)`)
 * because entry ids are opaque backend strings, not guaranteed uuids.
 */
async function loadAuditEnrichment(
  ids: string[],
): Promise<Map<string, AuditEnrichment>> {
  const out = new Map<string, AuditEnrichment>();
  if (ids.length === 0) return out;
  try {
    const { sql } = getOrgPg();

    type CanonRow = {
      id: string;
      state: string | null;
      last_validated_at: Date | string | null;
      last_surfaced_at: Date | string | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
    };
    const canon = await sql<CanonRow[]>`
      SELECT id::text AS id, state, last_validated_at, last_surfaced_at,
             created_at, updated_at
      FROM harness_shared.memory_canonical
      WHERE id::text = ANY(${ids})`;
    for (const r of canon) {
      out.set(r.id, {
        state: r.state ?? 'active',
        last_validated_at: iso(r.last_validated_at),
        last_surfaced_at: iso(r.last_surfaced_at),
        created_at: iso(r.created_at),
        updated_at: iso(r.updated_at),
        broken_anchors: [],
      });
    }

    // Pull broken anchors so the UI can surface a per-row reason.
    try {
      type AnchorRow = {
        memory_id: string;
        kind: string;
        value: string;
        last_check_ok: boolean | null;
      };
      const anchors = await sql<AnchorRow[]>`
        SELECT memory_id::text AS memory_id, kind, value, last_check_ok
        FROM harness_shared.memory_anchors
        WHERE memory_id::text = ANY(${ids}) AND last_check_ok = false`;
      for (const a of anchors) {
        const e = out.get(a.memory_id);
        if (!e) continue;
        e.broken_anchors.push({
          kind: a.kind,
          value: a.value,
          reason: a.last_check_ok === false ? 'check_failed' : null,
        });
      }
    } catch { /* memory_anchors absent → leave list empty */ }
  } catch { /* canonical store absent / unreachable → no enrichment */ }
  return out;
}

/**
 * Map a neutral entry's opaque scope string onto the display grouping
 * the settings page renders: the session user's pool → 'user',
 * `harness:<slug>` → 'harness' (+ slug), legacy `workspace:<id>` →
 * 'workspace', anything else → 'user' (still the user's own view).
 */
function displayScope(e: MemoryEntry, userId: string): {
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
} {
  if (e.scope.startsWith('harness:')) {
    return { scope: 'harness', harness_slug: e.scope.slice('harness:'.length) };
  }
  if (e.scope.startsWith('workspace:')) return { scope: 'workspace' };
  return e.scope === userId ? { scope: 'user' } : { scope: 'user' };
}

/**
 * The full enriched, newest-first list for one user: their personal pool
 * plus one pool per harness in the active workspace. Throws if the
 * backend is unavailable — callers that need the availability envelope
 * (the REST route) check `backend.available()` first.
 */
export async function listUserMemories(userId: string): Promise<UserMemoryRow[]> {
  const backend = getMemoryBackend();
  const ws = activeWorkspaceId();

  // User pool + one pool per harness. The per-pool fan-out is the
  // backend's concern; the deprecated workspace-shared pool was
  // drained (docs-and-memory-as-projections D-005).
  let harnessSlugs: string[] = [];
  try {
    const reg = await loadHarnessRegistry(ws);
    harnessSlugs = reg.projects.map((p) => p.slug);
  } catch { /* leave empty — section will just be empty */ }

  const entries = await backend.list({
    scope: [userId, ...harnessSlugs.map((slug) => `harness:${slug}`)],
  });

  const combined = entries.map((e) => ({
    id: e.id,
    text: e.text,
    kind: e.kind,
    metadata: e.metadata,
    ...displayScope(e, userId),
  }));

  const audit = await loadAuditEnrichment(combined.map((r) => r.id));
  const enriched: UserMemoryRow[] = combined.map((r) => {
    const e = audit.get(r.id);
    if (!e) return r;
    return {
      ...r,
      created_at: e.created_at,
      updated_at: e.updated_at,
      audit: {
        state: e.state,
        last_validated_at: e.last_validated_at,
        last_surfaced_at: e.last_surfaced_at,
        broken_anchors: e.broken_anchors,
      },
    };
  });

  // Newest first. Canonical timestamps where the store has them; the
  // legacy metadata.turn_at epoch for backends without a canonical row.
  const sortKey = (r: UserMemoryRow): number => {
    const ts = r.updated_at ?? r.created_at;
    if (ts) {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) return ms;
    }
    const turn = (r.metadata as Record<string, unknown> | undefined)?.turn_at;
    return typeof turn === 'number' ? turn : 0;
  };
  enriched.sort((a, b) => sortKey(b) - sortKey(a));
  return enriched;
}
