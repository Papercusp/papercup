/**
 * agent-facts store — the generalized STANDING-FACTS ledger
 * (queen-memory-hybrid-2026-07-02 L1b; owner-approved 2026-07-02).
 *
 * A fact is a deterministic, scoped, TTL'd CONCLUSION an agent asserts so it is
 * folded VERBATIM into future briefs/dossiers/orients. It fills the gap none of
 * the other memory surfaces cover:
 *   • mem0 (`memory:*`)        — fuzzy semantic recall; may or may not surface.
 *   • agent-insights docs      — long-form how-it-works runbooks.
 *   • work-item checkpoints    — task-scoped in-flight progress.
 *   • queen carry-journal      — per-wake reasoning trajectory.
 * A fact WILL appear in every relevant fold until it expires or is retracted —
 * "WI-1439 is owner-residue, exclude it" must never depend on embedding
 * similarity (the Queen re-derived exactly that ~6 consecutive wakes,
 * 2026-07-02, before this existed).
 *
 * Scoping (owner amendment D-001: harness/work_item OPTIONAL):
 *   workspace (ref NULL) | role | owner | harness | work_item.
 * Upsert identity: (workspace, scope, coalesce(ref,''), key). Soft-retract.
 * Hygiene: mandatory TTL (default 7d), per-scope cap (LRU-ish: oldest-updated
 * evicted on overflow), expiry sweep on the routines tick.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

export const FACT_SCOPES = ['workspace', 'role', 'owner', 'harness', 'work_item'] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

export const FACT_BODY_MAX_CHARS = 500;
export const FACT_DEFAULT_TTL_SEC = 7 * 24 * 3600;
/** Per-(scope,ref) live-fact cap — oldest-updated evicted past this. */
export const FACTS_PER_SCOPE_CAP = 50;
/** Fold budget: max facts per scope-selector in one fold read. */
export const FACTS_FOLD_LIMIT = 12;

export interface AgentFact {
  scope: FactScope;
  scopeRef: string | null;
  key: string;
  body: string;
  sourceRef: string | null;
  createdBy: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AssertFactInput {
  scope: FactScope;
  /** Required for every scope except 'workspace' (D-001). */
  scopeRef?: string | null;
  /** Stable slug — the upsert/retract target. */
  key: string;
  body: string;
  sourceRef?: string | null;
  createdBy: string;
  ttlSec?: number;
  workspaceId?: string;
}

/** Validate scope/ref pairing per D-001. Returns an error string or null. */
export function validateFactScope(scope: string, scopeRef?: string | null): string | null {
  if (!(FACT_SCOPES as readonly string[]).includes(scope)) {
    return `unknown scope '${scope}' — one of ${FACT_SCOPES.join('|')}`;
  }
  const ref = (scopeRef ?? '').trim();
  if (scope === 'workspace' && ref) return "scope 'workspace' carries no scope_ref";
  if (scope !== 'workspace' && !ref) return `scope '${scope}' requires scope_ref`;
  return null;
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/** Upsert a fact by identity; refreshes body/TTL/source on re-assert. Enforces
 *  the per-scope cap by evicting the oldest-updated live facts past the cap. */
export async function assertFact(input: AssertFactInput, inject?: Sql): Promise<AgentFact> {
  const err = validateFactScope(input.scope, input.scopeRef);
  if (err) throw new Error(`facts:assert — ${err}`);
  const key = input.key.trim();
  if (!key) throw new Error('facts:assert — key required (stable slug)');
  const body = input.body.trim();
  if (!body) throw new Error('facts:assert — body required');
  if (body.length > FACT_BODY_MAX_CHARS) {
    throw new Error(`facts:assert — body over ${FACT_BODY_MAX_CHARS} chars (facts are conclusions, not documents)`);
  }
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  const ttl = input.ttlSec && input.ttlSec > 0 ? input.ttlSec : FACT_DEFAULT_TTL_SEC;
  const rows = await sql<AgentFactRow[]>`
    INSERT INTO harness_shared.agent_facts
      (workspace_id, scope, scope_ref, key, body, source_ref, created_by, expires_at)
    VALUES
      (${ws}, ${input.scope}, ${ref}, ${key}, ${body}, ${input.sourceRef ?? null}, ${input.createdBy},
       now() + make_interval(secs => ${ttl}))
    ON CONFLICT (workspace_id, scope, coalesce(scope_ref, ''), key)
    DO UPDATE SET body = EXCLUDED.body,
                  source_ref = EXCLUDED.source_ref,
                  updated_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  retracted_at = NULL
    RETURNING scope, scope_ref, key, body, source_ref, created_by,
              updated_at::text, expires_at::text`;
  // Cap enforcement — evict oldest-updated live facts past the cap for this (scope, ref).
  await sql`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE (workspace_id, scope, coalesce(scope_ref,''), key) IN (
       SELECT workspace_id, scope, coalesce(scope_ref,''), key
         FROM harness_shared.agent_facts
        WHERE workspace_id = ${ws} AND scope = ${input.scope}
          AND coalesce(scope_ref,'') = ${ref ?? ''}
          AND retracted_at IS NULL AND expires_at > now()
        ORDER BY updated_at DESC
       OFFSET ${FACTS_PER_SCOPE_CAP})`;
  return rowToFact(rows[0]);
}

/** Soft-retract by identity. Returns whether a live fact was retracted. */
export async function retractFact(
  args: { scope: FactScope; scopeRef?: string | null; key: string; workspaceId?: string },
  inject?: Sql,
): Promise<boolean> {
  const err = validateFactScope(args.scope, args.scopeRef);
  if (err) throw new Error(`facts:retract — ${err}`);
  const sql = sqlOf(inject);
  const ws = args.workspaceId ?? activeWorkspaceId();
  const ref = args.scope === 'workspace' ? '' : (args.scopeRef ?? '').trim();
  const rows = await sql<{ key: string }[]>`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND retracted_at IS NULL
    RETURNING key`;
  return rows.length > 0;
}

/** One fold selector: a (scope, ref) pair to include. */
export interface FactSelector {
  scope: FactScope;
  scopeRef?: string | null;
}

/**
 * The FOLD read — live (unexpired, unretracted) facts for a set of selectors,
 * newest-updated first, bounded per selector. This is what brief/dossier/orient
 * renderers call. Deterministic: no similarity, no ranking model.
 */
export async function foldFacts(
  selectors: readonly FactSelector[],
  opts: { workspaceId?: string; limitPerSelector?: number } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  if (selectors.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const limit = opts.limitPerSelector ?? FACTS_FOLD_LIMIT;
  const out: AgentFact[] = [];
  for (const sel of selectors) {
    const ref = sel.scope === 'workspace' ? '' : (sel.scopeRef ?? '').trim();
    if (sel.scope !== 'workspace' && !ref) continue; // an unset optional dimension folds nothing
    const rows = await sql<AgentFactRow[]>`
      SELECT scope, scope_ref, key, body, source_ref, created_by,
             updated_at::text, expires_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${ws} AND scope = ${sel.scope}
         AND coalesce(scope_ref,'') = ${ref}
         AND retracted_at IS NULL AND expires_at > now()
       ORDER BY updated_at DESC
       LIMIT ${limit}`;
    out.push(...rows.map(rowToFact));
  }
  return out;
}

/** List facts for one selector (the facts:list tool read; includes near-expiry). */
export async function listFacts(
  sel: FactSelector,
  opts: { workspaceId?: string; limit?: number } = {},
  inject?: Sql,
): Promise<AgentFact[]> {
  return foldFacts([sel], { workspaceId: opts.workspaceId, limitPerSelector: opts.limit ?? 50 }, inject);
}

/** Expiry sweep (routines-tick reaper pattern): hard-delete rows expired or
 *  retracted > 30d ago — keeps the audit trail bounded. Fail-soft at call site. */
export async function sweepExpiredFacts(inject?: Sql): Promise<number> {
  const sql = sqlOf(inject);
  const rows = await sql<{ key: string }[]>`
    DELETE FROM harness_shared.agent_facts
     WHERE expires_at < now() - interval '30 days'
        OR retracted_at < now() - interval '30 days'
    RETURNING key`;
  return rows.length;
}

/** Render facts as the compact fold block briefs embed. Deterministic layout:
 *  one line per fact — `[scope:ref] body (src, expires in Nd)`. */
export function renderFactsFold(facts: readonly AgentFact[], now: number = Date.now()): string {
  if (facts.length === 0) return '';
  const lines = facts.map((f) => {
    const scope = f.scopeRef ? `${f.scope}:${f.scopeRef}` : f.scope;
    const days = Math.max(0, Math.round((Date.parse(f.expiresAt) - now) / 86_400_000));
    const src = f.sourceRef ? `, src ${f.sourceRef}` : '';
    return `• [${scope}] ${f.body} (expires ~${days}d${src})`;
  });
  return `### Standing facts (deterministic — assert via facts:assert, retract when stale)\n${lines.join('\n')}`;
}

interface AgentFactRow {
  scope: FactScope;
  scope_ref: string | null;
  key: string;
  body: string;
  source_ref: string | null;
  created_by: string;
  updated_at: string;
  expires_at: string;
}

function rowToFact(r: AgentFactRow): AgentFact {
  return {
    scope: r.scope,
    scopeRef: r.scope_ref,
    key: r.key,
    body: r.body,
    sourceRef: r.source_ref,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  };
}
