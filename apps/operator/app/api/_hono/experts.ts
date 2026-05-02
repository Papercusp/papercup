/**
 * /api/harness/:slug/experts — instanced "expert" agents.
 *
 * Each expert is one detailed-spec authoring agent for a single
 * high-level feature area. The scoper spawns one per area in phase 1,
 * each expert iterates with feedback agents, and the scoper resumes in
 * phase 2 once experts finalize.
 *
 * Storage (per harness):
 *   .harness/experts/<expert-id>/
 *     identity.json
 *     SPEC.md
 *     rounds/round-NNN.md      (audit snapshots after each agent ends)
 *     feedback/FB-NNN/
 *       persona.txt
 *       turn-NNN-expert.md
 *       turn-NNN-feedback.md
 *       verdict.json           (set on END)
 *     feedback/decision-log.md
 *     chat/                    (existing chat-transcript shape)
 *
 * Snapshots include `.harness/experts/**` (per-mission state).
 * Templates DO NOT ship `experts/` (template `.gitignore` excludes it).
 */
import type { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getKnownRoles } from '@/lib/known-roles';

function lookupProjectDir(slug: string): string | null {
  const { loadHarnessRegistry } = require('@/lib/harness-registry') as typeof import('@/lib/harness-registry');
  return loadHarnessRegistry().projects.find((p) => p.slug === slug)?.path ?? null;
}

function expertsRoot(projectDir: string): string {
  return join(projectDir, '.harness', 'experts');
}

function expertDir(projectDir: string, expertId: string): string {
  return join(expertsRoot(projectDir), expertId);
}

const EXPERT_ID_RE = /^EXP-\d{3,}$/;
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

type Identity = {
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

async function readIdentity(projectDir: string, expertId: string): Promise<Identity | null> {
  const p = join(expertDir(projectDir, expertId), 'identity.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as Identity;
  } catch {
    return null;
  }
}

async function writeIdentity(projectDir: string, identity: Identity): Promise<void> {
  identity.updatedAt = new Date().toISOString();
  const dir = expertDir(projectDir, identity.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'identity.json'), JSON.stringify(identity, null, 2), 'utf8');
}

function listExpertIds(projectDir: string): string[] {
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

function nextExpertId(projectDir: string): string {
  const ids = listExpertIds(projectDir);
  let max = 0;
  for (const id of ids) {
    const n = parseInt(id.slice(4), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `EXP-${String(max + 1).padStart(3, '0')}`;
}

function nextFeedbackId(projectDir: string, expertId: string): string {
  const fbDir = join(expertDir(projectDir, expertId), 'feedback');
  if (!existsSync(fbDir)) return 'FB-001';
  try {
    const ids = readdirSync(fbDir)
      .filter((name) => FEEDBACK_ID_RE.test(name))
      .filter((name) => statSync(join(fbDir, name)).isDirectory());
    let max = 0;
    for (const id of ids) {
      const n = parseInt(id.slice(3), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `FB-${String(max + 1).padStart(3, '0')}`;
  } catch {
    return 'FB-001';
  }
}

async function readVerdict(projectDir: string, expertId: string, fbId: string): Promise<unknown | null> {
  const p = join(expertDir(projectDir, expertId), 'feedback', fbId, 'verdict.json');
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Server-enforced convergence check. Two consecutive most-recent verdicts
 * with no critical/major/minor newIssues → final. Trivial-only counts as
 * empty for convergence purposes.
 *
 * Returns the proposed terminal status, or null if the loop should continue.
 */
async function evaluateConvergence(projectDir: string, expertId: string): Promise<'final' | null> {
  const fbDir = join(expertDir(projectDir, expertId), 'feedback');
  if (!existsSync(fbDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(fbDir)
      .filter((name) => FEEDBACK_ID_RE.test(name))
      .sort();
  } catch {
    return null;
  }
  if (entries.length < 2) return null;
  const lastTwo = entries.slice(-2);
  for (const fbId of lastTwo) {
    const v = (await readVerdict(projectDir, expertId, fbId)) as
      | { newIssues?: Array<{ severity?: string }> }
      | null;
    if (!v) return null; // verdict not yet written → not converged
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
function computeNextAction(projectDir: string, expertId: string): string {
  const ident = (() => {
    try {
      return JSON.parse(readFileSync(join(expertDir(projectDir, expertId), 'identity.json'), 'utf8'));
    } catch { return null; }
  })();
  if (!ident) return 'done';
  // Terminal status takes precedence over userEngaged — a cancelled or
  // final expert that happens to still have userEngaged=true is `done`,
  // not `wait`.
  const terminal = ['final', 'max_rounds', 'cancelled', 'superseded', 'error'];
  if (terminal.includes(ident.status)) return 'done';
  if (ident.userEngaged) return 'wait';
  if (ident.status === 'drafting') return 'dispatch_expert';

  // Inspect each in-flight conversation.
  const fbDir = join(expertDir(projectDir, expertId), 'feedback');
  if (!existsSync(fbDir)) return 'dispatch_expert';
  let fbIds: string[] = [];
  try {
    fbIds = readdirSync(fbDir).filter((n) => FEEDBACK_ID_RE.test(n)).sort();
  } catch { return 'dispatch_expert'; }

  let pendingExpert = false;
  for (const fbId of fbIds) {
    const dir = join(fbDir, fbId);
    let verdictExists = false;
    try { verdictExists = existsSync(join(dir, 'verdict.json')); } catch {}
    if (verdictExists) continue; // ended
    let turns: string[] = [];
    try {
      turns = readdirSync(dir).filter((n) => /^turn-\d{3}-(expert|feedback)\.md$/.test(n)).sort();
    } catch {}
    if (turns.length === 0) continue;
    const latest = turns[turns.length - 1];
    if (latest.endsWith('-expert.md')) {
      // Conversation is waiting for the feedback agent to reply.
      return `dispatch_feedback:${fbId}`;
    }
    if (latest.endsWith('-feedback.md')) {
      // Conversation is waiting for the expert to respond or end.
      pendingExpert = true;
    }
  }
  if (pendingExpert) return 'dispatch_expert';
  // No in-flight conversation needing immediate action → expert spawns next
  // persona.
  return 'dispatch_expert';
}

function readMaxAgents(projectDir: string): number {
  try {
    const cfg = JSON.parse(readFileSync(join(projectDir, '.harness', 'config.json'), 'utf8'));
    const v = cfg?.expert?.maxAgents;
    if (typeof v === 'number' && v > 0) return v;
  } catch {}
  return 12;
}

/**
 * Aggregate cost (USD cents) attributed to a specific expert or feedback id
 * by scanning .harness/logs/*.jsonl whose run_id contains the id token.
 * Returns whole cents. Best-effort — invocation logs that didn't tag the id
 * (e.g. legacy sessions) won't roll up.
 */
function aggregateExpertSpendCents(projectDir: string, expertId: string): number {
  const logDir = join(projectDir, '.harness', 'logs');
  if (!existsSync(logDir)) return 0;
  let total = 0;
  let logs: string[];
  try { logs = readdirSync(logDir); } catch { return 0; }
  // Match run_id suffix: <ts>-<role>-<EXP-NNN> or any FB-NNN whose run is
  // tagged with the same expert via the parent prompt's runtime extras —
  // for our regex, the simplest heuristic is "filename includes expertId
  // or any FB-NNN that lives under this expert's feedback/ dir."
  const fbDir = join(projectDir, '.harness', 'experts', expertId, 'feedback');
  let fbIds: string[] = [];
  try {
    if (existsSync(fbDir)) {
      fbIds = readdirSync(fbDir).filter((n) => FEEDBACK_ID_RE.test(n));
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
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const ids = listExpertIds(projectDir);
    const out: Array<
      Pick<Identity, 'id' | 'title' | 'status' | 'featureSize' | 'agentCount' | 'roundCount' | 'userEngaged' | 'forkedFrom' | 'createdAt' | 'updatedAt'>
      & { nextAction: string }
    > = [];
    for (const id of ids) {
      const ident = await readIdentity(projectDir, id);
      if (!ident) continue;
      out.push({
        id: ident.id,
        title: ident.title,
        status: ident.status,
        featureSize: ident.featureSize,
        agentCount: ident.agentCount,
        roundCount: ident.roundCount,
        userEngaged: ident.userEngaged,
        forkedFrom: ident.forkedFrom,
        createdAt: ident.createdAt,
        updatedAt: ident.updatedAt,
        nextAction: computeNextAction(projectDir, ident.id),
      });
    }
    return c.json({ experts: out });
  });

  // ── Create expert ────────────────────────────────────────────────────
  harness.post('/:slug/experts', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = lookupProjectDir(slug);
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

    const id = nextExpertId(projectDir);
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
    await mkdir(join(dir, 'feedback'), { recursive: true });
    await mkdir(join(dir, 'rounds'), { recursive: true });
    await writeIdentity(projectDir, identity);
    // SPEC.md starts empty; expert writes it.
    await writeFile(join(dir, 'SPEC.md'), '', 'utf8');

    return c.json(identity, 201);
  });

  // ── Get expert ───────────────────────────────────────────────────────
  harness.get('/:slug/experts/:expertId', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);
    const dir = expertDir(projectDir, expertId);
    const specPath = join(dir, 'SPEC.md');
    let spec = '';
    try { spec = await readFile(specPath, 'utf8'); } catch {}
    const spentCents = aggregateExpertSpendCents(projectDir, expertId);
    const nextAction = computeNextAction(projectDir, expertId);
    return c.json({ ...ident, specPath, spec, spentCents, nextAction });
  });

  // ── Patch expert (status, userEngaged, terminationReason, agentCount, roundCount) ──
  harness.patch('/:slug/experts/:expertId', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
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
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { persona?: string };
    if (!body.persona || typeof body.persona !== 'string' || !PERSONA_RE.test(body.persona)) {
      return c.json({ error: 'persona required (alpha + apostrophe/hyphen)' }, 400);
    }

    const fbId = nextFeedbackId(projectDir, expertId);
    const fbDir = join(expertDir(projectDir, expertId), 'feedback', fbId);
    await mkdir(fbDir, { recursive: true });
    await writeFile(join(fbDir, 'persona.txt'), body.persona, 'utf8');

    ident.agentCount += 1;
    if (!ident.personasUsed.includes(body.persona)) ident.personasUsed.push(body.persona);
    if (ident.status === 'drafting') ident.status = 'gathering_feedback';
    await writeIdentity(projectDir, ident);

    const max = readMaxAgents(projectDir);
    if (ident.agentCount >= max) {
      ident.status = 'max_rounds';
      ident.terminationReason = `agentCount >= maxAgents (${max})`;
      await writeIdentity(projectDir, ident);
    }

    return c.json({ feedbackId: fbId, persona: body.persona, expertId, expert: ident }, 201);
  });

  // ── Append turn ──────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/feedback/:fbId/turn', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    const fbId = c.req.param('fbId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    if (!FEEDBACK_ID_RE.test(fbId)) return c.json({ error: 'invalid feedback id' }, 400);

    const fbDir = join(expertDir(projectDir, expertId), 'feedback', fbId);
    if (!existsSync(fbDir)) return c.json({ error: 'feedback conversation not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { from?: string; body?: string };
    if (body.from !== 'expert' && body.from !== 'feedback') {
      return c.json({ error: 'from must be "expert" or "feedback"' }, 400);
    }
    if (typeof body.body !== 'string' || !body.body) {
      return c.json({ error: 'body required' }, 400);
    }

    // Count existing turn-*.md files for the next index.
    let nextIdx = 1;
    try {
      const turns = readdirSync(fbDir).filter((f) => /^turn-\d{3}-(expert|feedback)\.md$/.test(f));
      nextIdx = turns.length + 1;
    } catch {}
    const fname = `turn-${String(nextIdx).padStart(3, '0')}-${body.from}.md`;
    await writeFile(join(fbDir, fname), body.body, 'utf8');

    return c.json({ ok: true, turn: fname });
  });

  // ── End feedback conversation (records verdict, evaluates convergence) ──
  harness.post('/:slug/experts/:expertId/feedback/:fbId/end', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    const fbId = c.req.param('fbId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    if (!FEEDBACK_ID_RE.test(fbId)) return c.json({ error: 'invalid feedback id' }, 400);

    const fbDir = join(expertDir(projectDir, expertId), 'feedback', fbId);
    if (!existsSync(fbDir)) return c.json({ error: 'feedback conversation not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as {
      verdict?: { newIssues?: Array<{ summary?: string; severity?: string; specLines?: string }>; coversPriorIssues?: string[] };
    };
    if (!body.verdict || typeof body.verdict !== 'object') {
      return c.json({ error: 'verdict required' }, 400);
    }
    const newIssues = Array.isArray(body.verdict.newIssues) ? body.verdict.newIssues : [];
    const coversPriorIssues = Array.isArray(body.verdict.coversPriorIssues) ? body.verdict.coversPriorIssues : [];
    const verdict = { newIssues, coversPriorIssues };
    await writeFile(join(fbDir, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8');

    // Audit snapshot of current SPEC.md after this agent ended.
    const ident = await readIdentity(projectDir, expertId);
    if (!ident) return c.json({ error: 'expert not found' }, 404);
    const specSrc = join(expertDir(projectDir, expertId), 'SPEC.md');
    if (existsSync(specSrc)) {
      ident.roundCount += 1;
      const dst = join(expertDir(projectDir, expertId), 'rounds', `round-${String(ident.roundCount).padStart(3, '0')}.md`);
      try { await copyFile(specSrc, dst); } catch {}
    }

    // Server-side termination checks (in order). Promote only if not already
    // in a terminal state.
    const terminal = new Set(['final', 'max_rounds', 'cancelled', 'superseded', 'error']);
    if (!terminal.has(ident.status)) {
      // 1. Budget exhaustion takes precedence over convergence — if we've
      //    blown the envelope, stop even mid-loop.
      const spentCents = aggregateExpertSpendCents(projectDir, expertId);
      if (ident.budgetCents > 0 && spentCents >= ident.budgetCents) {
        ident.status = 'final';
        ident.terminationReason = `budget: ${spentCents}¢ spent of ${ident.budgetCents}¢ envelope`;
      } else {
        // 2. Convergence: 2 consecutive non-substantive verdicts.
        const converged = await evaluateConvergence(projectDir, expertId);
        if (converged === 'final') {
          ident.status = 'final';
          ident.terminationReason = 'convergence: 2 consecutive non-substantive verdicts';
        }
      }
    }
    await writeIdentity(projectDir, ident);

    return c.json({ ok: true, verdict, expert: ident });
  });

  // ── Fork expert ──────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/fork', async (c) => {
    const slug = c.req.param('slug');
    const projectDir = lookupProjectDir(slug);
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const oldId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(oldId)) return c.json({ error: 'invalid expert id' }, 400);
    const oldIdent = await readIdentity(projectDir, oldId);
    if (!oldIdent) return c.json({ error: 'expert not found' }, 404);

    const body = await c.req.json().catch(() => ({})) as { title?: string; budgetCents?: number };

    const newId = nextExpertId(projectDir);
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
    const newDir = expertDir(projectDir, newId);
    await mkdir(join(newDir, 'feedback'), { recursive: true });
    await mkdir(join(newDir, 'rounds'), { recursive: true });
    await writeIdentity(projectDir, fresh);
    // Copy SPEC.md as starting point; rounds/ + feedback/ history NOT copied.
    const oldSpec = join(expertDir(projectDir, oldId), 'SPEC.md');
    const newSpec = join(newDir, 'SPEC.md');
    try { await copyFile(oldSpec, newSpec); } catch { await writeFile(newSpec, '', 'utf8'); }

    // Old expert → superseded.
    oldIdent.status = 'superseded';
    oldIdent.terminationReason = `forked into ${newId}`;
    await writeIdentity(projectDir, oldIdent);

    return c.json(fresh, 201);
  });

  // ── Cancel expert ────────────────────────────────────────────────────
  harness.post('/:slug/experts/:expertId/cancel', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
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
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const p = join(expertDir(projectDir, expertId), 'SPEC.md');
    try {
      const content = await readFile(p, 'utf8');
      return c.json({ content, path: p });
    } catch {
      return c.json({ error: 'SPEC.md not found' }, 404);
    }
  });

  // ── Write SPEC.md (expert-only writer in normal flow; user can override) ──
  harness.put('/:slug/experts/:expertId/spec', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const body = await c.req.json().catch(() => ({})) as { content?: string };
    if (typeof body.content !== 'string') return c.json({ error: 'content required' }, 400);
    const dir = expertDir(projectDir, expertId);
    if (!existsSync(dir)) return c.json({ error: 'expert not found' }, 404);
    await writeFile(join(dir, 'SPEC.md'), body.content, 'utf8');
    const ident = await readIdentity(projectDir, expertId);
    if (ident) await writeIdentity(projectDir, ident); // bumps updatedAt
    return c.json({ ok: true });
  });

  // ── List feedback conversations ──────────────────────────────────────
  harness.get('/:slug/experts/:expertId/feedback', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);
    const expertId = c.req.param('expertId');
    if (!EXPERT_ID_RE.test(expertId)) return c.json({ error: 'invalid expert id' }, 400);
    const fbRoot = join(expertDir(projectDir, expertId), 'feedback');
    if (!existsSync(fbRoot)) return c.json({ feedback: [] });
    let entries: string[];
    try {
      entries = readdirSync(fbRoot).filter((n) => FEEDBACK_ID_RE.test(n)).sort();
    } catch {
      return c.json({ feedback: [] });
    }
    const out: Array<{ id: string; persona: string; ended: boolean; verdict: unknown | null }> = [];
    for (const id of entries) {
      let persona = '';
      try { persona = readFileSync(join(fbRoot, id, 'persona.txt'), 'utf8'); } catch {}
      const verdict = await readVerdict(projectDir, expertId, id);
      out.push({ id, persona, ended: verdict !== null, verdict });
    }
    return c.json({ feedback: out });
  });

  // ── Generalized chat-agent registry (sidebar) ────────────────────────
  // The legacy `/:slug/agents` endpoint returns autonomous run logs; this
  // is a separate path that lists *chatable* agents (static roles +
  // instanced experts). Filters out non-chat roles (e.g. `feedback`).
  // Returns: [{role:"orchestrator"}, ..., {role:"expert", instanceId:"EXP-001", title:"..."}, ...]
  harness.get('/:slug/chat-agents', async (c) => {
    const projectDir = lookupProjectDir(c.req.param('slug'));
    if (!projectDir) return c.json({ error: 'unknown harness' }, 404);

    // Roles come from the shared on-disk source via getKnownRoles().
    // We exclude `feedback` (ephemeral, no chat) and `expert` (handled
    // separately as instanced agents below) to match agent-chats's chat
    // surface.
    const staticRoles = getKnownRoles().filter((r) => r !== 'feedback' && r !== 'expert');
    const agents: Array<{ role: string; instanceId?: string; title?: string; status?: string }> = [];
    for (const role of staticRoles) agents.push({ role });

    // Instanced experts — one entry per non-cancelled/superseded expert.
    for (const id of listExpertIds(projectDir)) {
      const ident = await readIdentity(projectDir, id);
      if (!ident) continue;
      if (ident.status === 'cancelled' || ident.status === 'superseded') continue;
      agents.push({ role: 'expert', instanceId: ident.id, title: ident.title, status: ident.status });
    }

    return c.json({ agents });
  });
}
