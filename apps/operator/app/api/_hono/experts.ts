/**
 * /api/harness/:slug/experts — instanced "expert" agents.
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
import type { Hono } from 'hono';
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
const FEEDBACK_ID_RE = /^FB-\d{3,}$/;
const PERSONA_RE = /^[a-z][a-z'-]*$/i;

const VALID_STATUSES = new Set([
  'drafting',
  'gathering_feedback',
  'awaiting_user',
  'final',
  'max_rounds',
  'error',
  'cancelled',
  'superseded',
]);

const VALID_FEATURE_SIZES = new Set(['small', 'standard', 'large']);

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
    const { sql } = (await import('@restart/db-org')).getOrgPg();
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

async function writeIdentity(projectDir: string, identity: Identity): Promise<void> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return;
  identity.updatedAt = new Date().toISOString();
  const ws = activeWorkspaceId();
  const createdAtMs = identity.createdAt ? Date.parse(identity.createdAt) : Date.now();
  const updatedAtMs = Date.parse(identity.updatedAt);
  const { db } = (await import('@restart/db-org')).getOrgPg();
  const { generated } = await import('@restart/db-org');
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
    const { sql } = (await import('@restart/db-org')).getOrgPg();
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

async function nextExpertId(projectDir: string): Promise<string> {
  const ids = await listExpertIds(projectDir);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id.slice(4), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `EXP-${String(max + 1).padStart(3, '0')}`;
}

async function nextFeedbackId(projectDir: string, expertId: string): Promise<string> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return 'FB-001';
  const { sql } = (await import('@restart/db-org')).getOrgPg();
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
  const { sql } = (await import('@restart/db-org')).getOrgPg();
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
async function evaluateConvergence(projectDir: string, expertId: string): Promise<'final' | null> {
  const slug = await projectDirToSlug(projectDir);
  if (!slug) return null;
  const { sql } = (await import('@restart/db-org')).getOrgPg();
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
  const { sql } = (await import('@restart/db-org')).getOrgPg();
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

function readExpertCaps(projectDir: string, identity: Pick<Identity, 'featureSize'>): ExpertCaps {
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
      const { sql } = (await import('@restart/db-org')).getOrgPg();
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

export function registerExperts(harness: Hono): void {
  // ── List experts ─────────────────────────────────────────────────────
  harness.get('/:slug/experts', async (c) => {
    const { listExperts } = await import('@/lib/experts-data');
    const result = await listExperts(c.req.param('slug'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Create expert ────────────────────────────────────────────────────
  harness.post('/:slug/experts', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      title?: string; highLevelSpec?: string; budgetCents?: number;
      featureSize?: string; forkedFrom?: string;
    };
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return c.json({ error: 'title required' }, 400);
    }
    if (typeof body.highLevelSpec !== 'string' || !body.highLevelSpec.trim()) {
      return c.json({ error: 'highLevelSpec required' }, 400);
    }
    if (typeof body.budgetCents !== 'number' || body.budgetCents <= 0) {
      return c.json({ error: 'budgetCents required (positive integer)' }, 400);
    }
    const featureSize = body.featureSize ?? 'standard';
    if (!VALID_FEATURE_SIZES.has(featureSize)) {
      return c.json({ error: `featureSize must be one of: ${[...VALID_FEATURE_SIZES].join(', ')}` }, 400);
    }

    const id = await nextExpertId(projectDir);
    const now = new Date().toISOString();
    const identity: Identity = {
      id,
      title: body.title.trim(),
      slug,
      status: 'drafting',
      budgetCents: body.budgetCents,
      featureSize: featureSize as Identity['featureSize'],
      highLevelSpec: body.highLevelSpec,
      agentCount: 0,
      roundCount: 0,
      personasUsed: [],
      userEngaged: false,
      forkedFrom: body.forkedFrom,
      createdAt: now,
      updatedAt: now,
    };

    const dir = expertDir(projectDir, id);
    // feedback/ + rounds/ subdirs still hold persona.txt + turn-NNN-*.md
    // Persona/turn/verdict now live in harness_expert_feedback +
    // harness_expert_turns. The rounds/ dir holds write-only SPEC audit
    // snapshots (never read back); created lazily on first verdict end.
    await writeIdentity(projectDir, identity);

    return c.json(identity, 201);
  });

  // ── List registered cross-cutting roles ───────────────────────────────
  // Used by scoper-replan (and any future caller) to discover which
  // experts are available without hardcoding their names. Source of
  // truth: prompts/<role>.role.json sidecar files.
  harness.get('/:slug/expert-roles', async (c) => {
    const { listExpertRoles } = await import('@/lib/experts-data');
    const result = await listExpertRoles(c.req.param('slug'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Dispatch autonomous expert ────────────────────────────────────────
  // Used by scoper (and future callers) to spawn a cross-cutting expert
  // role that writes features directly. Distinct from the manual chat-
  // driven expert flow above; this path runs the agent autonomously and
  // surfaces in OperatorActionLog rather than ExpertsPanel.
  // See lib/expert-dispatcher.ts + /docs/experts/authoring.
  harness.post('/:slug/experts/dispatch', async (c) => {
    const slug = c.req.param('slug');
    const reg = await (await import('@/lib/harness-registry')).loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === slug);
    if (!project) return c.json({ error: 'unknown harness' }, 404);
    const body = await c.req.json().catch(() => ({})) as {
      role?: string;
      reason?: string;
      context?: Record<string, unknown>;
    };
    if (!body.role || typeof body.role !== 'string') {
      return c.json({ error: 'role required' }, 400);
    }
    const { getRole } = await import('@/lib/role-registry');
    if (!getRole(body.role, slug)) {
      return c.json({ error: `unknown role: ${body.role}` }, 404);
    }
    const { dispatchExpert } = await import('@/lib/expert-dispatcher');
    try {
      const result = await dispatchExpert(
        { slug, path: project.path },
        body.role,
        { reason: body.reason, context: body.context },
      );
      if (!result.ok) {
        // Lock-held — caller can decide whether to retry/skip.
        return c.json(result, 409);
      }
      return c.json(result, 200);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
  });

  // ── Get expert ───────────────────────────────────────────────────────
  harness.get('/:slug/experts/:expertId', async (c) => {
    const { getExpert } = await import('@/lib/experts-data');
    const result = await getExpert(c.req.param('slug'), c.req.param('expertId'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Patch expert (status, userEngaged, terminationReason, agentCount, roundCount) ──
  harness.patch('/:slug/experts/:expertId', async (c) => {
    const projectDir = await lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);
    const body = await c.req.json().catch(() => ({})) as Partial<Identity>;

    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) {
        return c.json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` }, 400);
      }
      ident.status = body.status;
    }
    if (body.terminationReason !== undefined) ident.terminationReason = String(body.terminationReason);
    if (body.userEngaged !== undefined) ident.userEngaged = !!body.userEngaged;
    if (body.title !== undefined && typeof body.title === 'string') ident.title = body.title;
    if (body.highLevelSpec !== undefined && typeof body.highLevelSpec === 'string') ident.highLevelSpec = body.highLevelSpec;

    await writeIdentity(projectDir, ident);
    return c.json(ident);
  });

  // ── Open feedback conversation ───────────────────────────────────────
  harness.post('/:slug/experts/:expertId/feedback', async (c) => {
    const projectDir = await lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { persona?: string };
    if (!body.persona || typeof body.persona !== 'string' || !PERSONA_RE.test(body.persona)) {
      return c.json({ error: 'persona required (alpha + apostrophe/hyphen)' }, 400);
    }

    const fbId = await nextFeedbackId(projectDir, expertId);
    {
      const slug = await projectDirToSlug(projectDir);
      if (!slug) return c.json({ error: 'unknown harness' }, 404);
      const { db } = (await import('@restart/db-org')).getOrgPg();
      const { generated } = await import('@restart/db-org');
      const ws = activeWorkspaceId();
      await db.insert(generated.harnessExpertFeedbackInHarnessShared).values({
        workspaceId: ws,
        harnessSlug: slug,
        expertId: expertId,
        feedbackId: fbId,
        persona: body.persona,
        createdAt: Date.now(),
      });
    }

    ident.agentCount += 1;
    if (!ident.personasUsed.includes(body.persona)) ident.personasUsed.push(body.persona);
    if (ident.status === 'drafting') ident.status = 'gathering_feedback';
    await writeIdentity(projectDir, ident);

    const caps = readExpertCaps(projectDir, ident);
    if (ident.agentCount >= caps.maxAgents) {
      ident.status = 'max_rounds';
      ident.terminationReason = `agentCount >= maxAgents (${caps.maxAgents})`;
      await writeIdentity(projectDir, ident);
    }

    return c.json({ feedbackId: fbId, persona: body.persona, expertId, expert: ident }, 201);
  });

  // ── Append turn ──────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/feedback/:fbId/turn', async (c) => {
    const projectDir = await lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    const fbId = c.req.param('fbId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    if (!FEEDBACK_ID_RE.test(fbId)) return c.json({ error: 'invalid feedback id' }, 400);

    const slug = await projectDirToSlug(projectDir);
    if (!slug) return c.json({ error: 'unknown harness' }, 404);
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { and, eq, sql: dsql } = await import('drizzle-orm');
    const hef = generated.harnessExpertFeedbackInHarnessShared;
    const het = generated.harnessExpertTurnsInHarnessShared;
    const ws = activeWorkspaceId();
    const fbExists = await db
      .select({ ok: dsql<number>`1` })
      .from(hef)
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)))
      .limit(1);
    if (fbExists.length === 0) return c.json({ error: 'feedback conversation not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { from?: string; body?: string };
    if (body.from !== 'expert' && body.from !== 'feedback') {
      return c.json({ error: 'from must be "expert" or "feedback"' }, 400);
    }
    if (typeof body.body !== 'string' || !body.body) {
      return c.json({ error: 'body required' }, 400);
    }

    const { count } = await import('drizzle-orm');
    const countRows = await db
      .select({ n: count() })
      .from(het)
      .where(and(eq(het.workspaceId, ws), eq(het.harnessSlug, slug), eq(het.expertId, expertId), eq(het.feedbackId, fbId)));
    const nextIdx = Number(countRows[0]?.n ?? 0) + 1;
    await db.insert(het).values({
      workspaceId: ws,
      harnessSlug: slug,
      expertId: expertId,
      feedbackId: fbId,
      turnIdx: nextIdx,
      speaker: body.from,
      body: body.body,
      createdAt: Date.now(),
    });
    const fname = `turn-${String(nextIdx).padStart(3, '0')}-${body.from}.md`;
    return c.json({ ok: true, turn: fname });
  });

  // ── End feedback conversation (records verdict, evaluates convergence) ──
  harness.post('/:slug/experts/:expertId/feedback/:fbId/end', async (c) => {
    const projectDir = await lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    const fbId = c.req.param('fbId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    if (!FEEDBACK_ID_RE.test(fbId)) return c.json({ error: 'invalid feedback id' }, 400);

    const slug = await projectDirToSlug(projectDir);
    if (!slug) return c.json({ error: 'unknown harness' }, 404);
    const { db } = (await import('@restart/db-org')).getOrgPg();
    const { generated } = await import('@restart/db-org');
    const { and, eq, sql: dsql } = await import('drizzle-orm');
    const hef = generated.harnessExpertFeedbackInHarnessShared;
    const he = generated.harnessExpertsInHarnessShared;
    const ws = activeWorkspaceId();
    const fbExists = await db
      .select({ ok: dsql<number>`1` })
      .from(hef)
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)))
      .limit(1);
    if (fbExists.length === 0) return c.json({ error: 'feedback conversation not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as {
      verdict?: { newIssues?: Array<{ summary?: string; severity?: string; specLines?: string }>; coversPriorIssues?: string[] };
    };
    if (!body.verdict || typeof body.verdict !== 'object') {
      return c.json({ error: 'verdict required' }, 400);
    }
    const newIssues = Array.isArray(body.verdict.newIssues) ? body.verdict.newIssues : [];
    const coversPriorIssues = Array.isArray(body.verdict.coversPriorIssues) ? body.verdict.coversPriorIssues : [];
    const verdict = { newIssues, coversPriorIssues };
    await db
      .update(hef)
      .set({ verdict: verdict as any, endedAt: Date.now() })
      .where(and(eq(hef.workspaceId, ws), eq(hef.harnessSlug, slug), eq(hef.expertId, expertId), eq(hef.feedbackId, fbId)));

    // Audit snapshot of SPEC content after this agent ended (write-only log
    // of round history; never read back, so kept on disk).
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);
    {
      const specRows = await db
        .select({ spec_content: he.specContent })
        .from(he)
        .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, expertId)))
        .limit(1);
      const specBody = specRows[0]?.spec_content ?? '';
      if (specBody) {
        ident.roundCount += 1;
        const dst = join(expertDir(projectDir, expertId), 'rounds', `round-${String(ident.roundCount).padStart(3, '0')}.md`);
        try {
          await mkdir(join(expertDir(projectDir, expertId), 'rounds'), { recursive: true });
          await writeFile(dst, specBody, 'utf8');
        } catch {}
      }
    }

    // Server-side termination checks (in order). Promote only if not already
    // in a terminal state.
    const terminal = new Set(['final', 'max_rounds', 'cancelled', 'superseded', 'error']);
    if (!terminal.has(ident.status)) {
      // 1. Budget exhaustion takes precedence over convergence — if we've
      //    blown the envelope, stop even mid-loop.
      const spentCents = await aggregateExpertSpendCents(projectDir, expertId);
      if (ident.budgetCents > 0 && spentCents >= ident.budgetCents) {
        ident.status = 'final';
        ident.terminationReason = `budget: ${spentCents}¢ spent of ${ident.budgetCents}¢ envelope`;
      } else {
        const caps = readExpertCaps(projectDir, ident);
        // 2. Round-count cap (per featureSize; see FEATURE_SIZE_CAPS).
        if (ident.roundCount >= caps.maxRounds) {
          ident.status = 'max_rounds';
          ident.terminationReason = `roundCount >= maxRounds (${caps.maxRounds})`;
        } else {
          // 3. Convergence: 2 consecutive non-substantive verdicts.
          const converged = await evaluateConvergence(projectDir, expertId);
          if (converged === 'final') {
            ident.status = 'final';
            ident.terminationReason = 'convergence: 2 consecutive non-substantive verdicts';
          }
        }
      }
    }
    await writeIdentity(projectDir, ident);

    return c.json({ ok: true, verdict, expert: ident });
  });

  // ── Fork expert ──────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/fork', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const oldId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(oldId)) return c.json({ error: 'invalid expert id' }, 400);
    const oldIdent = await readIdentity(projectDir, oldId);
    if (!oldIdent) return c.json({ error: 'expert not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { title?: string; budgetCents?: number };

    const newId = await nextExpertId(projectDir);
    const now = new Date().toISOString();
    const fresh: Identity = {
      ...oldIdent,
      id: newId,
      title: body.title ?? oldIdent.title,
      status: 'drafting',
      terminationReason: undefined,
      budgetCents: body.budgetCents ?? oldIdent.budgetCents,
      agentCount: 0,
      roundCount: 0,
      personasUsed: [],
      userEngaged: false,
      forkedFrom: oldId,
      createdAt: now,
      updatedAt: now,
    };
    await writeIdentity(projectDir, fresh);
    // Copy spec_content from old expert to new in PG. rounds/ + feedback/
    // history NOT copied.
    {
      const slug = await projectDirToSlug(projectDir);
      if (slug) {
        const { db } = (await import('@restart/db-org')).getOrgPg();
        const { generated } = await import('@restart/db-org');
        const { and, eq } = await import('drizzle-orm');
        const he = generated.harnessExpertsInHarnessShared;
        const ws = activeWorkspaceId();
        // Two-step: read src.spec_content, then UPDATE dst. Drizzle's
        // update doesn't support a FROM clause; correlated copy lifted
        // into TS keeps the operation atomic-enough (worst case is a
        // racing writer to src in the millisecond between).
        const srcRows = await db
          .select({ spec_content: he.specContent })
          .from(he)
          .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, oldId)))
          .limit(1);
        if (srcRows.length > 0) {
          await db
            .update(he)
            .set({ specContent: srcRows[0].spec_content })
            .where(and(eq(he.workspaceId, ws), eq(he.harnessSlug, slug), eq(he.expertId, newId)));
        }
      }
    }

    // Old expert → superseded.
    oldIdent.status = 'superseded';
    oldIdent.terminationReason = `forked into ${newId}`;
    await writeIdentity(projectDir, oldIdent);

    return c.json(fresh, 201);
  });

  // ── Cancel expert ────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/cancel', async (c) => {
    const projectDir = await lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);
    ident.status = 'cancelled';
    ident.terminationReason = 'user cancelled';
    await writeIdentity(projectDir, ident);
    return c.json(ident);
  });

  // ── Read SPEC.md ─────────────────────────────────────────────────────
  harness.get('/:slug/experts/:expertId/spec', async (c) => {
    const { getExpertSpec } = await import('@/lib/experts-data');
    const result = await getExpertSpec(c.req.param('slug'), c.req.param('expertId'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Write SPEC.md (expert-only writer in normal flow; user can override) ──
  harness.put('/:slug/experts/:expertId/spec', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { content?: string };
    if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const updated = await sql<{ updated: boolean }[]>`
      UPDATE harness_shared.harness_experts
         SET spec_content = ${body.content},
             updated_at   = ${Date.now()}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug}
         AND expert_id    = ${expertId}
      RETURNING TRUE AS updated
    `;
    if (updated.length === 0) return c.json({ error: 'expert not found' }, 404);
    void notifySyncInvalidate('harnessIdentity').catch(() => {});
    return c.json({ ok: true });
  });

  // ── Read assertions.md ───────────────────────────────────────────────
  harness.get('/:slug/experts/:expertId/assertions', async (c) => {
    const { getExpertAssertions } = await import('@/lib/experts-data');
    const result = await getExpertAssertions(c.req.param('slug'), c.req.param('expertId'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Write assertions.md (expert finalization output) ─────────────────
  // Phase-2 scoper merges these into .harness/validation-contract.md
  // verbatim instead of re-deriving assertions from SPEC.md prose.
  harness.put('/:slug/experts/:expertId/assertions', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = await lookupProjectDir(slug);
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { content?: string };
    if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
    const { sql } = (await import('@restart/db-org')).getOrgPg();
    const ws = activeWorkspaceId();
    const updated = await sql<{ updated: boolean }[]>`
      UPDATE harness_shared.harness_experts
         SET assertions_content = ${body.content},
             updated_at          = ${Date.now()}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug}
         AND expert_id    = ${expertId}
      RETURNING TRUE AS updated
    `;
    if (updated.length === 0) return c.json({ error: 'expert not found' }, 404);
    void notifySyncInvalidate('harnessIdentity').catch(() => {});
    return c.json({ ok: true });
  });

  // ── List feedback conversations ──────────────────────────────────────
  harness.get('/:slug/experts/:expertId/feedback', async (c) => {
    const { listExpertFeedback } = await import('@/lib/experts-data');
    const result = await listExpertFeedback(c.req.param('slug'), c.req.param('expertId'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Generalized chat-agent registry (sidebar) ────────────────────────
  // The legacy `/:slug/agents` endpoint returns autonomous run logs; this
  // is a separate path that lists *chatable* agents (static roles +
  // instanced experts). Filters out non-chat roles (e.g. `feedback`).
  // Returns: [{role:"orchestrator"}, ..., {role:"expert", instanceId:"EXP-001", title:"..."}, ...]
  harness.get('/:slug/chat-agents', async (c) => {
    const { listChatAgents } = await import('@/lib/experts-data');
    const result = await listChatAgents(c.req.param('slug'));
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });
}
