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
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
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
  /** F0-2 (federated-scout-gym): OPT-IN federation egress — only shareable
   *  facts ever leave the hive. Default false (privacy default, D-001/D-005). */
  shareable?: boolean;
  /**
   * F1-1 federation identity (mig 461 `harness_slug` — "the Hive home slug;
   * NULL = un-hived local fact"). REQUIRED for a shareable fact to actually
   * federate: the capture routes the outbox row by it AND the peer-side wire
   * validator (`isAgentFactWireRow`) rejects a null harness_slug, so a
   * shareable assert without it is captured-then-dropped. Resolve via
   * {@link resolveFactFederationSlug} (member harness → its hive home).
   */
  hiveHomeSlug?: string | null;
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

/**
 * F1-4 / WI-1564: resolve the workspace partition a FEDERATED (shareable)
 * fact/elite write must land in. The coordination partition
 * (`DEFAULT_COORD_WORKSPACE` = 'default') and the `'*'` wildcard NEVER federate
 * — a shareable write there is captured by the mig-461/462 triggers then
 * stranded (never routed to a peer, the WI-1564 137-stranded-row class, the
 * writer-side twin of the harness_slug drop D-007 fixed). Returns the workspace
 * when it federates, else `undefined` so the writer refuses LOUDLY instead of
 * silently stranding. Shared by the fact writer ({@link assertFact}) and the
 * gym-elite writer so both strand-or-federate identically — the WI-1564
 * "resolver shared by writer + reader" invariant (mirrors
 * p2p/grant-store.ts `resolveP2pGrantWorkspace`).
 */
export function resolveFederationWorkspace(ws: string | null | undefined): string | undefined {
  const w = ws?.trim();
  return w && w !== '*' && w !== DEFAULT_COORD_WORKSPACE ? w : undefined;
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
  // F1-4 / WI-1564: a SHAREABLE fact MUST land in a real federating partition.
  // If the resolved workspace is the non-federating coordination/'*' partition,
  // the capture triggers fire but route nowhere, so the fact is captured then
  // stranded (dropped on every peer). Refuse LOUDLY rather than silently strand
  // — a hive-PRIVATE fact (shareable !== true) is unaffected (it never rides the
  // wire, so any partition is fine).
  if (input.shareable === true && !resolveFederationWorkspace(ws)) {
    throw new Error(
      `facts:assert — a shareable fact cannot use the '${ws}' workspace partition ` +
        `(WI-1564): the coordination/'*' partition never federates, so the fact would ` +
        `be captured then stranded on every peer. Assert from a hive-scoped workspace.`,
    );
  }
  const ref = input.scope === 'workspace' ? null : (input.scopeRef ?? '').trim();
  const ttl = input.ttlSec && input.ttlSec > 0 ? input.ttlSec : FACT_DEFAULT_TTL_SEC;
  // The arbiter is mig 461's 5-column identity (per-source partitioning, H6):
  // a LOCAL assert always writes the source_hive-NULL ('') partition, so the
  // coalesce(source_hive,'') dimension must be IN the inference spec — the old
  // 4-column spec matched no unique index after 461 and errored EVERY assert
  // at plan time (found 2026-07-03: zero fact writes since 461 applied).
  const rows = await sql<AgentFactRow[]>`
    INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref, created_by, expires_at, shareable)
    VALUES
      (${ws}, ${input.hiveHomeSlug ?? null}, ${input.scope}, ${ref}, ${key}, ${body},
       ${input.sourceRef ?? null}, ${input.createdBy},
       now() + make_interval(secs => ${ttl}), ${input.shareable === true})
    ON CONFLICT (workspace_id, scope, coalesce(scope_ref, ''), key, coalesce(source_hive, ''))
    DO UPDATE SET body = EXCLUDED.body,
                  source_ref = EXCLUDED.source_ref,
                  -- keep an already-stamped federation identity when a later
                  -- assert omits it (never NULL it back out)
                  harness_slug = COALESCE(EXCLUDED.harness_slug, harness_shared.agent_facts.harness_slug),
                  updated_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  retracted_at = NULL,
                  shareable = EXCLUDED.shareable
    RETURNING scope, scope_ref, key, body, source_ref, created_by,
              updated_at::text, expires_at::text`;
  // Cap enforcement — evict oldest-updated live facts past the cap for this
  // (scope, ref). LOCAL partition only (H6): the local writer's cap must never
  // evict foreign-source observations (those are bounded per-source by the
  // substrate rate caps + each sender's own cap).
  await sql`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE source_hive IS NULL
       AND (workspace_id, scope, coalesce(scope_ref,''), key) IN (
       SELECT workspace_id, scope, coalesce(scope_ref,''), key
         FROM harness_shared.agent_facts
        WHERE workspace_id = ${ws} AND scope = ${input.scope}
          AND coalesce(scope_ref,'') = ${ref ?? ''}
          AND source_hive IS NULL
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
  // LOCAL partition only (H6): retracting YOUR fact must not retract another
  // source's independent observation of the same identity. Your retraction
  // federates to peers' copies of YOUR partition via the mig-461/462 update
  // capture; foreign partitions retract via the projection's deleteFromPg.
  const rows = await sql<{ key: string }[]>`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE workspace_id = ${ws} AND scope = ${args.scope}
       AND coalesce(scope_ref,'') = ${ref} AND key = ${args.key.trim()}
       AND source_hive IS NULL
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

/** F0-2 (federated-scout-gym): the ELITE eligibility rule — sender-side gate on
 *  what may federate. Outcome-verified or strongly-graded only; everything else
 *  is spam-by-design on an open network (D-005 H3: receiver-side signed-outcome
 *  verification + reputation weighting still apply on top of this). */
export function federatableElite(e: { outcome?: string | null; grade?: number | null }): boolean {
  return e.outcome === 'won' || (e.grade ?? 0) >= 4;
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

/**
 * Resolve the FEDERATION identity slug a shareable fact should carry
 * (`agent_facts.harness_slug`, mig 461): a Hive MEMBER harness resolves to its
 * hive HOME slug (the registry `hive_slug` pointer — the slug the peer-side
 * projection is bound to, register-all A-003); a hive home / standalone
 * harness is itself. Returns null for an unresolvable / wildcard slug — the
 * fact then stays un-hived (local-only), matching mig 461's NULL semantics.
 * Fail-soft: a registry read error yields null, never throws (an assert must
 * not fail on federation-identity resolution).
 */
export async function resolveFactFederationSlug(
  harnessSlug: string | null | undefined,
): Promise<string | null> {
  const slug = harnessSlug?.trim();
  if (!slug || slug === '*') return null;
  try {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const reg = await loadHarnessRegistry();
    const entry = reg.projects.find((p) => p.slug === slug);
    return entry?.hive_slug ?? slug;
  } catch {
    return null;
  }
}
