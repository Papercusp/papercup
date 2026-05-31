/**
 * Expert-agent core — identity read/write, convergence, cost rollup.
 *
 * Phase A2 (endpoint-hono-elimination-2026-05-21): the helper half of
 * the former `_hono/experts.ts`. The HTTP routes moved to
 * `lib/endpoint-route/routes/experts/index.ts`; these helpers stayed as
 * a shared library — `lib/experts-data.ts` and the route handlers both
 * consume them.
 *
 * Each expert is one detailed-spec authoring agent for a single
 * high-level feature area. The scoper spawns one per area in phase 1,
 * each expert iterates with feedback agents, and the scoper resumes in
 * phase 2 once experts finalize.
 *
 * Storage:
 *   harness_shared.harness_experts          — identity + SPEC content
 *   harness_shared.harness_expert_feedback  — feedback conversations + verdict
 *   harness_shared.harness_expert_turns     — feedback conversation turns
 *   .harness/experts/<expert-id>/rounds/    — write-only SPEC audit snapshots
 *   .harness/experts/<expert-id>/chat/      — existing chat-transcript shape
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getKnownRoles } from '@/lib/known-roles';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export async function lookupProjectDir(slug: string): Promise<string | null> {
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

function expertsRoot(projectDir: string): string {
  return join(projectDir, '.harness', 'experts');
}

export function expertDir(projectDir: string, expertId: string): string {
  return join(expertsRoot(projectDir), expertId);
}

export const EXPERT_ID_RE = /^EXP-\d{3,}$/;
export const FEEDBACK_ID_RE = /^FB-\d{3,}$/;
export const PERSONA_RE = /^[a-z][a-z'-]*$/i;

export const VALID_STATUSES = new Set([
  'drafting',
  'gathering_feedback',
  'awaiting_user',
  'final',
  'max_rounds',
  'error',
  'cancelled',
  'superseded',
]);

export const VALID_FEATURE_SIZES = new Set(['small', 'standard', 'large']);

export type Identity = {
  id: string;
  title: string;
  slug: string;
  status: string;
  terminationReason?: string;
  budgetCents: number;
  featureSize: 'small' | 'standard' | 'large';
  highLevelSpec: string;
  agentCount: number;
  roundCount: number;
  personasUsed: string[];
  userEngaged: boolean;
  forkedFrom?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Map the project dir back to a harness slug via the registry. Used by
 * the readIdentity/writeIdentity helpers below to scope PG queries.
 */
export async function projectDirToSlug(projectDir: string): Promise<string | null> {
  const { loadHarnessRegistry } = await import('@/lib/harness-registry');
  const reg = await loadHarnessRegistry();
  return reg.projects.find((p) => p.path === projectDir)?.slug ?? null;
}

interface ExpertRow {
  expert_id: string;
  title: string;
  status: string;
  budget_cents: number | bigint;
  feature_size: string | null;
  high_level_spec: string;
  agent_count: number;
  round_count: number;
  personas_used: string[] | null;
  user_engaged: boolean;
  created_at: number | bigint;
  updated_at: number | bigint;
  termination_reason: string | null;
}

function rowToIdentity(r: ExpertRow): Identity {
  return {
    id: r.expert_id,
    title: r.title ?? '',
    slug: r.expert_id, // historic: identity.slug == expert_id
    status: r.status,
    terminationReason: r.termination_reason ?? undefined,
    budgetCents: typeof r.budget_cents === 'bigint' ? Number(r.budget_cents) : r.budget_cents,
    featureSize: ((r.feature_size as Identity['featureSize']) ?? 'standard'),
    highLevelSpec: r.high_level_spec ?? '',
    agentCount: r.agent_count,
    roundCount: r.round_count,
    personasUsed: Array.isArray(r.personas_used) ? r.personas_used : [],
    userEngaged: r.user_engaged === true,
    createdAt: new Date(typeof r.created_at === 'bigint' ? Number(r.created_at) : r.created_at).toISOString(),
    updatedAt: new Date(typeof r.updated_at === 'bigint' ? Number(r.updated_at) : r.updated_at).toISOString(),
    // forkedFrom not persisted in harness_experts — historic tracking only;
    // matches existing watcher behavior which also drops this field on mirror.
  };
}

export async function readIdentity(projectDir: string, expertId: string): Promise<Identity | null> {
  const slug = await projectDirToSlug(projectDir);
  if (slug) {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const rows = await sql<ExpertRow[]>`
      SELECT expert_id, title, status, budget_cents, feature_size,
             high_level_spec, agent_count, round_count, personas_used,
             user_engaged, created_at, updated_at, termination_reason
        FROM harness_shared.harness_experts
       WHERE workspace_id = ${ws} AND harness_slug = ${slug}
         AND expert_id    = ${expertId}
       LIMIT 1
    `;
    if (rows.length > 0) return rowToIdentity(rows[0]);
  }
  // PG miss → legacy disk entry. Fall back to the on-disk identity.json
  // (pre-PG-canonical layout). Surfaces these in the UI so legacy experts
  // remain selectable; the next mutating write will populate PG.
  const file = join(expertDir(projectDir, expertId), 'identity.json');
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Identity>;
      if (j && typeof j === 'object' && j.id === expertId) {
        return {
          id: expertId,
          title: typeof j.title === 'string' ? j.title : '',
          slug: typeof j.slug === 'string' ? j.slug : (slug ?? ''),
          status: (j.status as Identity['status']) ?? 'drafting',
          budgetCents: typeof j.budgetCents === 'number' ? j.budgetCents : 0,
          featureSize: (j.featureSize as Identity['featureSize']) ?? 'standard',
          highLevelSpec: typeof j.highLevelSpec === 'string' ? j.highLevelSpec : '',
          agentCount: typeof j.agentCount === 'number' ? j.agentCount : 0,
          roundCount: typeof j.roundCount === 'number' ? j.roundCount : 0,
          personasUsed: Array.isArray(j.personasUsed) ? j.personasUsed as string[] : [],
          userEngaged: j.userEngaged === true,
          forkedFrom: typeof j.forkedFrom === 'string' ? j.forkedFrom : undefined,
          createdAt: typeof j.createdAt === 'string' ? j.createdAt : new Date().toISOString(),
          updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : new Date().toISOString(),
          terminationReason: typeof j.terminationReason === 'string' ? j.terminationReason : undefined,
        };
      }
    } catch { /* fall through */ }
  }
  return null;
}

export async function writeIdentity(projectDir: string, identity: Identity): Promise<void> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return;
  identity.updatedAt = new Date().toISOString();
  const ws = activeWorkspaceId();
  const createdAtMs = identity.createdAt ? Date.parse(identity.createdAt) : Date.now();
  const updatedAtMs = Date.parse(identity.updatedAt);
  const { db } = (await import('@papercusp/db-org')).getOrgPg();
  const { generated } = await import('@papercusp/db-org');
  const { sql: dsql } = await import('drizzle-orm');
  const he = generated.harnessExpertsInHarnessShared;
  await db
    .insert(he)
    .values({
      workspaceId: ws,
      harnessSlug: slug,
      expertId: identity.id,
      title: identity.title ?? '',
      status: identity.status,
      budgetCents: identity.budgetCents ?? 0,
      featureSize: identity.featureSize ?? null,
      highLevelSpec: identity.highLevelSpec ?? '',
      agentCount: identity.agentCount ?? 0,
      roundCount: identity.roundCount ?? 0,
      personasUsed: identity.personasUsed ?? [],
      userEngaged: identity.userEngaged === true,
      createdAt: createdAtMs,
      updatedAt: updatedAtMs,
      terminationReason: identity.terminationReason ?? null,
    })
    .onConflictDoUpdate({
      target: [he.workspaceId, he.harnessSlug, he.expertId],
      set: {
        title: dsql`EXCLUDED.title`,
        status: dsql`EXCLUDED.status`,
        budgetCents: dsql`EXCLUDED.budget_cents`,
        featureSize: dsql`EXCLUDED.feature_size`,
        highLevelSpec: dsql`EXCLUDED.high_level_spec`,
        agentCount: dsql`EXCLUDED.agent_count`,
        roundCount: dsql`EXCLUDED.round_count`,
        personasUsed: dsql`EXCLUDED.personas_used`,
        userEngaged: dsql`EXCLUDED.user_engaged`,
        updatedAt: dsql`EXCLUDED.updated_at`,
        terminationReason: dsql`EXCLUDED.termination_reason`,
      },
    });
  // File mirror: keep <expertDir>/identity.json in sync. The legacy on-
  // disk layout is what listExpertIdsOnDisk + readIdentity-fallback walk;
  // mirroring here means newly-spawned experts surface in the panel even
  // if the PG read path is degraded.
  try {
    const dir = expertDir(projectDir, identity.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(identity, null, 2), 'utf8');
  } catch { /* best-effort */ }
  void notifySyncInvalidate('harnessIdentity').catch(() => {});
}

function listExpertIdsOnDisk(projectDir: string): string[] {
  const root = expertsRoot(projectDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => EXPERT_ID_RE.test(name))
      .filter((name) => statSync(join(root, name)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

export async function listExpertIdsInPg(projectDir: string): Promise<string[]> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return [];
  try {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const rows = await sql<{ expertId: string }[]>`
      SELECT expert_id FROM harness_shared.harness_experts
       WHERE workspace_id = ${ws} AND harness_slug = ${slug}
    `;
    return rows.map((r) => r.expertId).filter((id) => EXPERT_ID_RE.test(id));
  } catch {
    return [];
  }
}

/**
 * Union of disk dirs and PG rows. Disk-only entries are legacy experts
 * created before the PG-canonical migration; PG-only entries are new
 * spawns where the disk mirror is being lazily created. Either case
 * needs to surface so the left panel renders something.
 */
export async function listExpertIds(projectDir: string): Promise<string[]> {
  const [diskIds, pgIds] = await Promise.all([
    Promise.resolve(listExpertIdsOnDisk(projectDir)),
    listExpertIdsInPg(projectDir),
  ]);
  return Array.from(new Set([...diskIds, ...pgIds])).sort();
}

export async function nextExpertId(projectDir: string): Promise<string> {
  const ids = await listExpertIds(projectDir);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id.slice(4), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `EXP-${String(max + 1).padStart(3, '0')}`;
}

export async function nextFeedbackId(projectDir: string, expertId: string): Promise<string> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return 'FB-001';
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ feedback_id: string }[]>`
    SELECT feedback_id FROM harness_shared.harness_expert_feedback
     WHERE workspace_id = ${ws} AND harness_slug = ${slug}
       AND expert_id    = ${expertId}
  `;
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.feedback_id.slice(3), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `FB-${String(max + 1).padStart(3, '0')}`;
}

async function readVerdict(projectDir: string, expertId: string, fbId: string): Promise<unknown | null> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return null;
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ verdict: unknown }[]>`
    SELECT verdict FROM harness_shared.harness_expert_feedback
     WHERE workspace_id = ${ws} AND harness_slug = ${slug}
       AND expert_id    = ${expertId} AND feedback_id = ${fbId}
     LIMIT 1
  `;
  return rows.length === 0 ? null : (rows[0].verdict ?? null);
}

/**
 * Server-enforced convergence check. Two consecutive most-recent verdicts
 * with no critical/major/minor newIssues → final. Trivial-only counts as
 * empty for convergence purposes.
 *
 * Returns the proposed terminal status, or null if the loop should continue.
 */
export async function evaluateConvergence(projectDir: string, expertId: string): Promise<'final' | null> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return null;
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await sql<{ verdict: unknown }[]>`
    SELECT verdict FROM harness_shared.harness_expert_feedback
     WHERE workspace_id = ${ws} AND harness_slug = ${slug}
       AND expert_id    = ${expertId}
     ORDER BY feedback_id DESC
     LIMIT 2
  `;
  if (rows.length < 2) return null;
  for (const r of rows) {
    const v = r.verdict as { newIssues?: Array<{ severity?: string }> } | null;
    if (!v) return null;
    const issues = Array.isArray(v.newIssues) ? v.newIssues : [];
    const substantive = issues.some((i) => i?.severity && i.severity !== 'trivial');
    if (substantive) return null;
  }
  return 'final';
}

/**
 * Compute the orchestrator's next action for an expert. Returns a
 * structured hint so the orchestrator prompt doesn't have to walk
 * directory listings via shell pipelines (brittle in practice).
 *
 *   "dispatch_expert"           — invoke NEXT_EXPERT (drafting OR has feedback
 *                                 turn waiting for the expert's response OR
 *                                 needs to spawn the next persona)
 *   "dispatch_feedback:<FB-id>" — invoke NEXT_FEEDBACK (latest turn is from
 *                                 the expert; conversation waits on agent)
 *   "wait"                      — engaged in chat, do nothing
 *   "done"                      — terminal status; scoper-phase-2 candidate
 */
export async function computeNextAction(projectDir: string, expertId: string, ident: Identity | null): Promise<string> {
  if (!ident) return 'done';
  const terminal = ['final', 'max_rounds', 'cancelled', 'superseded', 'error'];
  if (terminal.includes(ident.status)) return 'done';
  if (ident.userEngaged) return 'wait';
  if (ident.status === 'drafting') return 'dispatch_expert';

  const slug = await projectDirToSlug(projectDir);
  if (!slug) return 'dispatch_expert';
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const ws = activeWorkspaceId();
  const fbs = await sql<{ feedback_id: string; verdict: unknown | null }[]>`
    SELECT feedback_id, verdict FROM harness_shared.harness_expert_feedback
     WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND expert_id = ${expertId}
     ORDER BY feedback_id ASC
  `;
  if (fbs.length === 0) return 'dispatch_expert';

  let pendingExpert = false;
  for (const fb of fbs) {
    if (fb.verdict !== null) continue; // ended
    const turns = await sql<{ speaker: string }[]>`
      SELECT speaker FROM harness_shared.harness_expert_turns
       WHERE workspace_id = ${ws} AND harness_slug = ${slug}
         AND expert_id    = ${expertId} AND feedback_id = ${fb.feedback_id}
       ORDER BY turn_idx DESC
       LIMIT 1
    `;
    if (turns.length === 0) continue;
    if (turns[0].speaker === 'expert') return `dispatch_feedback:${fb.feedback_id}`;
    if (turns[0].speaker === 'feedback') pendingExpert = true;
  }
  if (pendingExpert) return 'dispatch_expert';
  return 'dispatch_expert';
}

interface ExpertCaps { maxAgents: number; maxRounds: number }

/** Default agent + round caps per featureSize. Matches the labels on the
 *  Spawn-modal Size dropdown. config.json#expert.{maxAgents,maxRounds}
 *  override these on a per-harness basis. */
const FEATURE_SIZE_CAPS: Record<Identity['featureSize'], ExpertCaps> = {
  small:    { maxAgents: 2,  maxRounds: 1 },
  standard: { maxAgents: 4,  maxRounds: 3 },
  large:    { maxAgents: 10, maxRounds: 5 },
};

export function readExpertCaps(projectDir: string, identity: Pick<Identity, 'featureSize'>): ExpertCaps {
  const defaults = FEATURE_SIZE_CAPS[identity.featureSize ?? 'standard'] ?? FEATURE_SIZE_CAPS.standard;
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir, '.harness', 'config.json'), 'utf8'));
    const a = cfg?.expert?.maxAgents;
    const r = cfg?.expert?.maxRounds;
    return {
      maxAgents: typeof a === 'number' && a > 0 ? a : defaults.maxAgents,
      maxRounds: typeof r === 'number' && r > 0 ? r : defaults.maxRounds,
    };
  } catch {
    return defaults;
  }
}

/**
 * Aggregate cost (USD cents) attributed to a specific expert or feedback id
 * by scanning .harness/logs/*.jsonl whose run_id contains the id token.
 * Returns whole cents. Best-effort — invocation logs that didn't tag the id
 * (e.g. legacy sessions) won't roll up.
 */
export async function aggregateExpertSpendCents(projectDir: string, expertId: string): Promise<number> {
  const logDir = join(projectDir, '.harness', 'logs');
  if (!existsSync(logDir)) return 0;
  let total = 0;
  let logs: string[];
  try { logs = readdirSync(logDir); } catch { return 0; }
  // Discover FB-IDs from PG (formerly walked feedback/ dir); fall back to
  // expertId-only on lookup failure (cost reporting is best-effort).
  let fbIds: string[] = [];
  try {
    const slug = await projectDirToSlug(projectDir);
    if (slug) {
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      const ws = activeWorkspaceId();
      const rows = await sql<{ feedback_id: string }[]>`
        SELECT feedback_id FROM harness_shared.harness_expert_feedback
         WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND expert_id = ${expertId}
      `;
      fbIds = rows.map((r) => r.feedback_id);
    }
  } catch {}
  const idTokens = new Set<string>([expertId, ...fbIds]);
  for (const f of logs) {
    if (!f.endsWith('.jsonl')) continue;
    let matched = false;
    for (const tok of idTokens) {
      if (f.includes(`-${tok}.`)) { matched = true; break; }
    }
    if (!matched) continue;
    // Tail the last ~8KB and extract the result line's total_cost_usd.
    try {
      const raw = readFileSync(join(logDir, f), 'utf8');
      const tail = raw.length > 8192 ? raw.slice(-8192) : raw;
      const lines = tail.split('\n').reverse();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.type === 'result') {
            const usd = Number(obj.total_cost_usd ?? 0);
            if (Number.isFinite(usd)) total += Math.round(usd * 100);
            break;
          }
        } catch {}
      }
    } catch {}
  }
  return total;
}

