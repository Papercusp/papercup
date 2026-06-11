/**
 * /api/gym/* — the gym CONTROL-PLANE routes the generalized harness-gym UI consumes
 * (gym-ui-handoff-2026-06-02, D-020). Thin HTTP wrappers over lib/gym/control-plane.ts
 * (persistent state in the live operator DB) + lib/gym/read-api.ts (the ephemeral gym
 * run DB, when one is configured).
 *
 *   GET  /api/gym/harnesses                  → per-harness gym summaries
 *   GET  /api/gym/:slug                       → status + prompts for one harness
 *   GET  /api/gym/:slug/prompts               → { judgeRubric, roles }
 *   POST /api/gym/:slug/prompts   {role, md}  → set a prompt → updated prompts
 *   GET  /api/gym/:slug/proposals?status=     → proposer suggestions (default pending)
 *   POST /api/gym/:slug/accept    {id|variantId} → promote → harness_prompt_overrides
 *   POST /api/gym/:slug/reject    {id|variantId} → discard
 *   GET  /api/gym/:slug/autoloop               → autoloop config (defaults if unset)
 *   POST /api/gym/:slug/autoloop  {enabled?,budgetUsd?,status?} → upsert → config
 *   GET  /api/gym/:slug/cycles | /variants | /compare | /frontier → run analytics
 *        (wrap read-api against the gym run DB; available:false until one is wired)
 *
 * Public + loopback-only, consistent with the sibling /adv + /harness UI routes.
 * State is workspace-scoped via routeWithWorkspace (RLS GUC = active workspace).
 */
import postgres from 'postgres';
import { defineTool } from '@papercusp/agent-mcp';
import { routeWithWorkspace } from '../../../route-workspace';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  getPrompts,
  setPrompt,
  listProposals,
  decideProposal,
  getAutoloop,
  setAutoloop,
  summarizeGymStatus,
  GYM_PROMPT_KEYS,
} from '../../../gym/control-plane';
import { readCycleHistory, frontierView } from '../../../gym/read-api';
import { compareVariants as compareVariantsRead } from '../../../gym/store';
// P-016 (D-007/D-021): accept = commit→reproject for blueprint-harness targets.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePhasedProject } from '../../../harness-core';
import { acceptProposalViaCommit } from '../../../blueprint/commit-reproject-real';

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the ephemeral gym run DB for analytics reads — SERVER-CONTROLLED only.
 * Deliberately NOT a request parameter: accepting a client-supplied connection
 * string would let a caller make the operator open a postgres() connection to an
 * arbitrary host (SSRF / arbitrary-DB), even on a loopback service. Per-harness
 * gym-DB selection, if ever needed, must be looked up server-side from a registry.
 */
function gymDbUrl(): string | null {
  return process.env.PAPERCUSP_GYM_DATABASE_URL || null;
}
async function withGymSql<T>(
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<{ available: true; data: T } | { available: false; reason: string }> {
  const url = gymDbUrl();
  if (!url) {
    return {
      available: false,
      reason: 'no gym run database configured (set PAPERCUSP_GYM_DATABASE_URL server-side). Run analytics populate once a gym run is registered.',
    };
  }
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  try {
    return { available: true, data: await fn(sql) };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const harnesses = defineTool({
  method: 'GET',
  path: '/gym/harnesses',
  auth: 'public',
  async handler() {
    const ws = activeWorkspaceId();
    const summaries = await routeWithWorkspace(async (tx) => {
      // Harnesses that have any gym state (a pending/decided proposal OR autoloop config).
      const slugs = (await tx`
        SELECT harness_slug FROM harness_shared.gym_proposals
        UNION
        SELECT harness_slug FROM harness_shared.gym_autoloop_config`) as { harness_slug: string }[];
      const out = [];
      for (const { harness_slug } of slugs) {
        const [pending, autoloop] = await Promise.all([
          listProposals(tx, { workspaceId: ws, harnessSlug: harness_slug, status: 'pending' }),
          getAutoloop(tx, { workspaceId: ws, harnessSlug: harness_slug }),
        ]);
        out.push({ harnessSlug: harness_slug, ...summarizeGymStatus(pending, autoloop) });
      }
      return out;
    });
    return Response.json({ harnesses: summaries });
  },
});

const get = defineTool({
  method: 'GET',
  path: '/gym/:slug',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const payload = await routeWithWorkspace(async (tx) => {
      const [pending, autoloop, prompts] = await Promise.all([
        listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending' }),
        getAutoloop(tx, { workspaceId: ws, harnessSlug: slug }),
        getPrompts(tx, { workspaceId: ws, harnessSlug: slug }),
      ]);
      return { harnessSlug: slug, status: summarizeGymStatus(pending, autoloop), prompts, editableKeys: GYM_PROMPT_KEYS };
    });
    return Response.json(payload);
  },
});

const promptsGet = defineTool({
  method: 'GET',
  path: '/gym/:slug/prompts',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const prompts = await routeWithWorkspace((tx) => getPrompts(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({ ...prompts, editableKeys: GYM_PROMPT_KEYS });
  },
});

const promptSet = defineTool({
  method: 'POST',
  path: '/gym/:slug/prompts',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const body = await readJson(req);
    const role = typeof body.role === 'string' ? body.role : '';
    const md = typeof body.md === 'string' ? body.md : '';
    if (!role) return Response.json({ error: 'role_required' }, { status: 400 });
    try {
      const prompts = await routeWithWorkspace(async (tx) => {
        await setPrompt(tx, { workspaceId: ws, harnessSlug: slug, role, md });
        return getPrompts(tx, { workspaceId: ws, harnessSlug: slug });
      });
      return Response.json({ ok: true, ...prompts });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  },
});

const proposals = defineTool({
  method: 'GET',
  path: '/gym/:slug/proposals',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const url = new URL(req.url);
    const status = url.searchParams.get('status') ?? 'pending';
    const variantId = url.searchParams.get('variantId') ?? undefined;
    const rows = await routeWithWorkspace((tx) =>
      listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: status === 'all' ? undefined : status, variantId }),
    );
    return Response.json({ proposals: rows });
  },
});

/** A proposal selection — one `id`, or every pending proposal of a candidate `variantId`. */
interface ProposalSelection {
  id: string | null;
  variantId: string | null;
}

function readSelection(body: Record<string, unknown>): ProposalSelection {
  return {
    id: typeof body.id === 'string' ? body.id : null,
    variantId: typeof body.variantId === 'string' ? body.variantId : null,
  };
}

/** Shared decide path: promote-to-PG (legacy accept) / mark-rejected (reject), by the
    parsed selection. Takes parsed params (NOT the Request) so a caller that already
    read the body — e.g. acceptRoute's fallback — never double-reads the request body. */
async function decideRoute(slug: string, decision: 'accepted' | 'rejected', sel: ProposalSelection): Promise<Response> {
  const ws = activeWorkspaceId();
  if (!sel.id && !sel.variantId) return Response.json({ error: 'id_or_variantId_required' }, { status: 400 });

  const result = await routeWithWorkspace(async (tx) => {
    const ids = sel.id
      ? [sel.id]
      : (await listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending', variantId: sel.variantId! })).map((p) => p.id);
    const results = [];
    for (const pid of ids) {
      results.push(await decideProposal(tx, { id: pid, workspaceId: ws, harnessSlug: slug, decision }));
    }
    return results;
  });
  const decided = result.filter((r) => r.ok).length;
  const promoted = result.filter((r) => r.promoted).length;
  return Response.json({ ok: decided > 0, decided, promoted, results: result });
}

/**
 * Accept = live-edit via commit → reproject (P-016 / D-007 / D-021). For a
 * blueprint-harness target (one with a git-canonical `.papercusp/blueprint.yaml`),
 * an accepted proposal commits its prompt edit to the TARGET's own git tree and
 * re-projects the blueprint to PG — replacing the ungated `harness_prompt_overrides`
 * write. A legacy target with no `.papercusp/blueprint.yaml` falls back to the old
 * promote-to-PG path (decideRoute), so accept never breaks for un-migrated harnesses.
 */
async function acceptRoute(req: Request, slug: string): Promise<Response> {
  const ws = activeWorkspaceId();
  const sel = readSelection(await readJson(req));
  if (!sel.id && !sel.variantId) return Response.json({ error: 'id_or_variantId_required' }, { status: 400 });

  // Is the target a blueprint-harness? (git-canonical `.papercusp/blueprint.yaml` at the repo root.)
  const project = await resolvePhasedProject(slug, undefined);
  const blueprintPath = project ? join(project.path, '.papercusp', 'blueprint.yaml') : null;
  if (!project || !blueprintPath || !existsSync(blueprintPath)) {
    // Legacy / un-migrated target: keep the original promote-to-PG accept (no re-read of req).
    return decideRoute(slug, 'accepted', sel);
  }

  // Resolve the pending proposals to accept (by id, or every pending of a variant).
  const proposals = await routeWithWorkspace(async (tx) => {
    const pending = await listProposals(tx, { workspaceId: ws, harnessSlug: slug, status: 'pending', variantId: sel.variantId ?? undefined });
    return sel.id ? pending.filter((p) => p.id === sel.id) : pending;
  });

  // commit→reproject each. A failure leaves THAT proposal pending (D-007 discipline):
  // the git commit is the source of truth, the PG reproject is an idempotent cache, and
  // the proposal is marked accepted only after both succeed. Per-proposal isolation so
  // one failure doesn't abort the rest; a retry is idempotent (no-op commit + re-project).
  const results: Array<Record<string, unknown>> = [];
  for (const p of proposals) {
    try {
      const res = await routeWithWorkspace((tx) =>
        acceptProposalViaCommit(tx, {
          workspaceId: ws,
          harnessSlug: slug,
          harnessDir: project.path,
          proposalId: p.id,
          role: p.role,
          proposedMd: p.proposedMd,
        }),
      );
      results.push({ ok: res.ok && res.proposalMarked, id: p.id, role: p.role, committed: res.committed, commit: res.commit, contentHash: res.contentHash, reason: res.reason });
    } catch (e) {
      results.push({ ok: false, id: p.id, role: p.role, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const decided = results.filter((r) => r.ok).length;
  return Response.json({ ok: decided > 0, decided, promoted: decided, mode: 'commit-reproject', results });
}

const accept = defineTool({
  method: 'POST',
  path: '/gym/:slug/accept',
  auth: 'loopback',
  async handler(req, ctx) {
    return acceptRoute(req, ctx.params.slug as string);
  },
});

const reject = defineTool({
  method: 'POST',
  path: '/gym/:slug/reject',
  auth: 'loopback',
  async handler(req, ctx) {
    return decideRoute(ctx.params.slug as string, 'rejected', readSelection(await readJson(req)));
  },
});

const autoloopGet = defineTool({
  method: 'GET',
  path: '/gym/:slug/autoloop',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const cfg = await routeWithWorkspace((tx) => getAutoloop(tx, { workspaceId: ws, harnessSlug: slug }));
    return Response.json({
      autoloop: cfg ?? { workspaceId: ws, harnessSlug: slug, enabled: false, budgetUsd: null, spentUsd: 0, status: 'idle', lastCycle: null, lastCycleAt: null, updatedAt: 0 },
      configured: cfg !== null,
    });
  },
});

const autoloopSet = defineTool({
  method: 'POST',
  path: '/gym/:slug/autoloop',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const ws = activeWorkspaceId();
    const body = await readJson(req);
    const patch: { enabled?: boolean; budgetUsd?: number | null; status?: string } = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.budgetUsd === null || typeof body.budgetUsd === 'number') patch.budgetUsd = body.budgetUsd as number | null;
    if (typeof body.status === 'string') patch.status = body.status;
    const cfg = await routeWithWorkspace((tx) => setAutoloop(tx, { workspaceId: ws, harnessSlug: slug, ...patch }));
    return Response.json({ ok: true, autoloop: cfg });
  },
});

// --- run-analytics wrappers (read the ephemeral gym run DB when one is configured) ---

const cycles = defineTool({
  method: 'GET',
  path: '/gym/:slug/cycles',
  auth: 'public',
  async handler() {
    const res = await withGymSql((sql) => readCycleHistory(sql));
    return res.available ? Response.json({ cycles: res.data }) : Response.json({ cycles: [], ...res });
  },
});

const variants = defineTool({
  method: 'GET',
  path: '/gym/:slug/variants',
  auth: 'public',
  async handler() {
    const res = await withGymSql(async (sql) => {
      const rows = (await sql`
        SELECT variant_id, parent_id, label, status, diff_from_parent, proposer_rationale
          FROM harness_gym.gym_variants ORDER BY variant_id`) as Record<string, unknown>[];
      return rows.map((r) => ({
        variantId: String(r.variant_id),
        parentId: r.parent_id == null ? null : String(r.parent_id),
        label: String(r.label),
        status: String(r.status),
        diffFromParent: r.diff_from_parent == null ? null : String(r.diff_from_parent),
        rationale: r.proposer_rationale == null ? null : String(r.proposer_rationale),
      }));
    });
    return res.available ? Response.json({ variants: res.data }) : Response.json({ variants: [], ...res });
  },
});

const compare = defineTool({
  method: 'GET',
  path: '/gym/:slug/compare',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const a = url.searchParams.get('a') ?? '';
    const b = url.searchParams.get('b') ?? '';
    const rubricHash = url.searchParams.get('rubricHash') ?? '';
    if (!a || !b || !rubricHash) return Response.json({ error: 'a_b_rubricHash_required', rows: [] }, { status: 400 });
    const res = await withGymSql((sql) => compareVariantsRead(sql, a, b, rubricHash));
    return res.available ? Response.json({ rows: res.data }) : Response.json({ rows: [], ...res });
  },
});

const frontier = defineTool({
  method: 'GET',
  path: '/gym/:slug/frontier',
  auth: 'public',
  async handler(req) {
    const rubricHash = new URL(req.url).searchParams.get('rubricHash') ?? '';
    if (!rubricHash) return Response.json({ error: 'rubricHash_required', frontier: [] }, { status: 400 });
    const res = await withGymSql((sql) => frontierView(sql, rubricHash));
    return res.available ? Response.json({ frontier: res.data }) : Response.json({ frontier: [], ...res });
  },
});

export default [
  harnesses,
  get,
  promptsGet,
  promptSet,
  proposals,
  accept,
  reject,
  autoloopGet,
  autoloopSet,
  cycles,
  variants,
  compare,
  frontier,
];
