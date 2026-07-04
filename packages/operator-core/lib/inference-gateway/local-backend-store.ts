/**
 * local-backend-store — durable PG registry for the LOCAL inference-backend pool
 * (local-concurrent-inference-2026-07-02 P-004, D-002). Mirrors the account-pool's
 * "DB is the source of truth, the gateway hot-reloads from it" model
 * (harness_shared.local_backends, migration 445) so a `llama-server` / `vllm` /
 * `ollama` backend registered here applies to the RUNNING gateway via
 * gateway:reload — no restart, same mechanism a Claude/Codex account uses.
 *
 * This module owns ONLY the durable registry (CRUD). Live state — health,
 * in-flight counts, least-loaded selection — is process-local gateway state
 * owned by local-backend-pool.ts, which is fed FROM this store's `list()` on
 * startup + every hot-reload tick.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

export const LOCAL_BACKEND_KINDS = ['llama-server', 'vllm', 'ollama'] as const;
export type LocalBackendKind = (typeof LOCAL_BACKEND_KINDS)[number];

export interface LocalBackendRecord {
  id: string;
  kind: LocalBackendKind;
  baseUrl: string;
  models: string[];
  maxConcurrent: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterLocalBackendInput {
  id: string;
  kind: LocalBackendKind;
  baseUrl: string;
  models: string[];
  maxConcurrent?: number;
  enabled?: boolean;
  workspaceId?: string;
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/** Validate register input. Returns an error string or null (pure — no I/O). */
export function validateLocalBackendInput(input: {
  id?: string;
  kind?: string;
  baseUrl?: string;
  models?: unknown;
  maxConcurrent?: number;
}): string | null {
  if (!input.id?.trim()) return 'id is required';
  if (!input.kind || !(LOCAL_BACKEND_KINDS as readonly string[]).includes(input.kind)) {
    return `kind must be one of ${LOCAL_BACKEND_KINDS.join('|')}`;
  }
  if (!input.baseUrl?.trim()) return 'baseUrl is required';
  try {
    const u = new URL(input.baseUrl);
    if (!/^https?:$/.test(u.protocol)) return `baseUrl must be http(s) — got '${u.protocol}'`;
  } catch {
    return `baseUrl is not a valid URL: '${input.baseUrl}'`;
  }
  if (!Array.isArray(input.models) || input.models.length === 0 || !input.models.every((m) => typeof m === 'string' && m.trim())) {
    return 'models must be a non-empty array of model id strings';
  }
  if (input.maxConcurrent !== undefined && (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent <= 0)) {
    return 'maxConcurrent must be a positive number';
  }
  return null;
}

/** Upsert a backend registration by id. */
export async function registerLocalBackend(input: RegisterLocalBackendInput, inject?: Sql): Promise<LocalBackendRecord> {
  const err = validateLocalBackendInput(input);
  if (err) throw new Error(`local-backend-store: ${err}`);
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  const id = input.id.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/$/, '');
  const models = input.models.map((m) => m.trim()).filter(Boolean);
  const maxConcurrent = input.maxConcurrent && input.maxConcurrent > 0 ? Math.floor(input.maxConcurrent) : 4;
  const enabled = input.enabled ?? true;
  const rows = await sql<LocalBackendRow[]>`
    INSERT INTO harness_shared.local_backends
      (id, workspace_id, kind, base_url, models, max_concurrent, enabled)
    VALUES
      (${id}, ${ws}, ${input.kind}, ${baseUrl}, ${JSON.stringify(models)}::text::jsonb, ${maxConcurrent}, ${enabled})
    ON CONFLICT (id) DO UPDATE SET
      workspace_id   = EXCLUDED.workspace_id,
      kind           = EXCLUDED.kind,
      base_url       = EXCLUDED.base_url,
      models         = EXCLUDED.models,
      max_concurrent = EXCLUDED.max_concurrent,
      enabled        = EXCLUDED.enabled,
      updated_at     = now()
    RETURNING id, kind, base_url, models, max_concurrent, enabled,
              created_at::text, updated_at::text`;
  return rowToRecord(rows[0]);
}

/** List backends for a workspace (default: the active workspace). Includes disabled ones —
 *  callers that need only the live/routable set should filter on `.enabled`. */
export async function listLocalBackends(opts: { workspaceId?: string } = {}, inject?: Sql): Promise<LocalBackendRecord[]> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<LocalBackendRow[]>`
    SELECT id, kind, base_url, models, max_concurrent, enabled,
           created_at::text, updated_at::text
      FROM harness_shared.local_backends
     WHERE workspace_id = ${ws}
     ORDER BY id`;
  return rows.map(rowToRecord);
}

/** Remove a backend registration by id. Returns whether a row was deleted. */
export async function removeLocalBackend(id: string, opts: { workspaceId?: string } = {}, inject?: Sql): Promise<boolean> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.local_backends
     WHERE id = ${id.trim()} AND workspace_id = ${ws}
    RETURNING id`;
  return rows.length > 0;
}

/** Enable/disable a backend without touching its other fields (a soft take-out-of-rotation,
 *  distinct from removing it — e.g. parking ollama's registry row while llama-server serves). */
export async function setLocalBackendEnabled(
  id: string,
  enabled: boolean,
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<LocalBackendRecord | null> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<LocalBackendRow[]>`
    UPDATE harness_shared.local_backends
       SET enabled = ${enabled}, updated_at = now()
     WHERE id = ${id.trim()} AND workspace_id = ${ws}
    RETURNING id, kind, base_url, models, max_concurrent, enabled,
              created_at::text, updated_at::text`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

interface LocalBackendRow {
  id: string;
  kind: LocalBackendKind;
  base_url: string;
  models: unknown;
  max_concurrent: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

function rowToRecord(r: LocalBackendRow): LocalBackendRecord {
  const models = Array.isArray(r.models) ? (r.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
  return {
    id: r.id,
    kind: r.kind,
    baseUrl: r.base_url,
    models,
    maxConcurrent: r.max_concurrent,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
