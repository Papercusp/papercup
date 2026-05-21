/**
 * Integration-ish tests for the experts module: spin up a Hono app, point
 * it at a temp project dir via a stub registry, and exercise the full
 * lifecycle (create / list / patch / fork / cancel / multi-turn feedback /
 * convergence gate / budget enforcement).
 *
 * No DB, no real harness — just the filesystem state machine and the HTTP
 * shape. The chat-open hook (which lives in agent-chats.ts) is covered by
 * its own standalone manual test, since this module has no DB dependency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Route-stack telemetry writes to PG; this is a no-DB filesystem test.
vi.mock('../telemetry', () => ({ recordRouteInvocation: () => {} }));

import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import expertsRoutes from '../routes/experts/index';

let TMP: string;
let PROJECT_DIR: string;
let ORIG_HOME: string | undefined;
let app: Hono;

const SLUG = 'test-harness';

function jsonReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  TMP = mkdtempSync(join(tmpdir(), 'experts-test-'));
  PROJECT_DIR = join(TMP, 'project');
  mkdirSync(join(PROJECT_DIR, '.harness'), { recursive: true });

  // Stub the registry so lookupProjectDir resolves SLUG → PROJECT_DIR.
  // The registry path moved from `~/.restart-harness-projects.json` to
  // `~/.papercusp-workspaces/<ws>/.papercusp/registry.json`. Use
  // PAPERCUSP_HOME (not HOME) — papercusp-root caches against it +
  // bypasses homedir() resolution.
  ORIG_HOME = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = join(TMP, '.papercusp');
  const { _resetPapercuspRootForTests } = await import('@/lib/papercusp-root');
  _resetPapercuspRootForTests();
  mkdirSync(process.env.PAPERCUSP_HOME!, { recursive: true });
  writeFileSync(
    join(process.env.PAPERCUSP_HOME!, 'registry.json'),
    JSON.stringify({ projects: [{ slug: SLUG, path: PROJECT_DIR }] }),
    'utf8',
  );

  app = new Hono().basePath('/api');
  for (const def of expertsRoutes as RouteDefinition<undefined>[]) registerRoute(app, def);
});

afterEach(() => {
  if (ORIG_HOME !== undefined) process.env.PAPERCUSP_HOME = ORIG_HOME;
  else delete process.env.PAPERCUSP_HOME;
  rmSync(TMP, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  // Routes moved to /api/harness/:slug/... (defineRoute) — the test-body
  // `url`s are still `/experts...`, so prefix the harness path here.
  const res = await app.fetch(jsonReq(method, `/api/harness/${SLUG}${url}`, body));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe('experts API', () => {
  it('starts empty', async () => {
    const { status, data } = await call('GET', '/experts');
    expect(status).toBe(200);
    expect(data).toEqual({ experts: [] });
  });

  it('rejects bad input on POST /experts', async () => {
    expect((await call('POST', '/experts', {})).status).toBe(400);
    expect((await call('POST', '/experts', { title: 'x' })).status).toBe(400);
    expect((await call('POST', '/experts', { title: 'x', highLevelSpec: 'y' })).status).toBe(400);
    expect(
      (await call('POST', '/experts', { title: 'x', highLevelSpec: 'y', budgetCents: 100, featureSize: 'huge' })).status,
    ).toBe(400);
  });

  it('creates an expert with sequential ids', async () => {
    const a = await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'small' });
    const b = await call('POST', '/experts', { title: 'B', highLevelSpec: 'b', budgetCents: 100, featureSize: 'standard' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.data.id).toBe('EXP-001');
    expect(b.data.id).toBe('EXP-002');
    expect(a.data.status).toBe('drafting');
  });

  it('returns the spec content on GET /:id', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'small' });
    writeFileSync(join(PROJECT_DIR, '.harness', 'experts', 'EXP-001', 'SPEC.md'), '# hello', 'utf8');
    const { data } = await call('GET', '/experts/EXP-001');
    expect(data.spec).toBe('# hello');
    expect(data.specPath).toMatch(/EXP-001\/SPEC\.md$/);
    expect(data.spentCents).toBe(0); // no logs yet
  });

  it('rejects invalid expert ids', async () => {
    expect((await call('GET', '/experts/not-an-id')).status).toBe(400);
    expect((await call('GET', '/experts/exp-001')).status).toBe(400); // lowercase
  });

  it('opens a feedback conversation and bumps agentCount', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'standard' });
    const fb = await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    expect(fb.status).toBe(201);
    expect(fb.data.feedbackId).toBe('FB-001');
    expect(fb.data.expert.agentCount).toBe(1);
    expect(fb.data.expert.status).toBe('gathering_feedback');
    expect(fb.data.expert.personasUsed).toEqual(['security']);
  });

  it('appends turns and ends with a verdict', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'standard' });
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    const t1 = await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'expert', body: 'opening' });
    expect(t1.data.turn).toBe('turn-001-expert.md');
    const t2 = await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'feedback', body: 'reply' });
    expect(t2.data.turn).toBe('turn-002-feedback.md');
    const end = await call('POST', '/experts/EXP-001/feedback/FB-001/end', {
      verdict: { newIssues: [{ summary: 'x', severity: 'major' }], coversPriorIssues: [] },
    });
    expect(end.status).toBe(200);
    expect(end.data.verdict.newIssues).toHaveLength(1);
    expect(end.data.expert.roundCount).toBe(1);
  });

  it('convergence gate: 2 consecutive non-substantive verdicts → final', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 999_999, featureSize: 'standard' });
    // Round 1: major issue → not converged
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    let r = await call('POST', '/experts/EXP-001/feedback/FB-001/end', {
      verdict: { newIssues: [{ summary: 'x', severity: 'major' }], coversPriorIssues: [] },
    });
    expect(r.data.expert.status).toBe('gathering_feedback');
    // Round 2: empty → still need 2 in a row
    await call('POST', '/experts/EXP-001/feedback', { persona: 'UX' });
    r = await call('POST', '/experts/EXP-001/feedback/FB-002/end', {
      verdict: { newIssues: [], coversPriorIssues: [] },
    });
    expect(r.data.expert.status).toBe('gathering_feedback');
    // Round 3: empty → server flips to final
    await call('POST', '/experts/EXP-001/feedback', { persona: 'perf' });
    r = await call('POST', '/experts/EXP-001/feedback/FB-003/end', {
      verdict: { newIssues: [], coversPriorIssues: [] },
    });
    expect(r.data.expert.status).toBe('final');
    expect(r.data.expert.terminationReason).toMatch(/convergence/);
  });

  it('trivial-only severities count as empty for convergence', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 999_999, featureSize: 'standard' });
    for (const fb of ['FB-001', 'FB-002']) {
      await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
      await call('POST', `/experts/EXP-001/feedback/${fb}/end`, {
        verdict: { newIssues: [{ summary: 'taste', severity: 'trivial' }], coversPriorIssues: [] },
      });
    }
    const { data } = await call('GET', '/experts/EXP-001');
    expect(data.status).toBe('final');
  });

  it('budget enforcement: spentCents >= budgetCents → final on next end', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 50, featureSize: 'small' });
    // Drop a fake jsonl log file with a result line totalling more than the budget.
    const logDir = join(PROJECT_DIR, '.harness', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, '12345-expert-EXP-001.jsonl'),
      '{"type":"result","total_cost_usd":0.75}\n',
      'utf8',
    );
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    const r = await call('POST', '/experts/EXP-001/feedback/FB-001/end', {
      verdict: { newIssues: [{ summary: 'x', severity: 'major' }], coversPriorIssues: [] },
    });
    expect(r.data.expert.status).toBe('final');
    expect(r.data.expert.terminationReason).toMatch(/budget/);
  });

  it('GET /:id surfaces spentCents from logs', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 999_999, featureSize: 'small' });
    const logDir = join(PROJECT_DIR, '.harness', 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, '12345-expert-EXP-001.jsonl'),
      '{"type":"result","total_cost_usd":0.0123}\n',
      'utf8',
    );
    const { data } = await call('GET', '/experts/EXP-001');
    expect(data.spentCents).toBe(1); // round(1.23) cents
  });

  it('agentCount cap → max_rounds', async () => {
    // Set maxAgents to 2 via config.json
    writeFileSync(
      join(PROJECT_DIR, '.harness', 'config.json'),
      JSON.stringify({ expert: { maxAgents: 2 } }),
      'utf8',
    );
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 999_999, featureSize: 'standard' });
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    const r = await call('POST', '/experts/EXP-001/feedback', { persona: 'UX' });
    expect(r.data.expert.status).toBe('max_rounds');
    expect(r.data.expert.terminationReason).toMatch(/maxAgents/);
  });

  it('fork: new id, SPEC copied, old → superseded with forkedFrom', async () => {
    await call('POST', '/experts', { title: 'Original', highLevelSpec: 'a', budgetCents: 100, featureSize: 'standard' });
    writeFileSync(join(PROJECT_DIR, '.harness', 'experts', 'EXP-001', 'SPEC.md'), '# original', 'utf8');
    const fork = await call('POST', '/experts/EXP-001/fork', { title: 'Forked' });
    expect(fork.status).toBe(201);
    expect(fork.data.id).toBe('EXP-002');
    expect(fork.data.forkedFrom).toBe('EXP-001');
    expect(fork.data.title).toBe('Forked');
    expect(fork.data.status).toBe('drafting');
    expect(readFileSync(join(PROJECT_DIR, '.harness', 'experts', 'EXP-002', 'SPEC.md'), 'utf8')).toBe('# original');
    const { data: orig } = await call('GET', '/experts/EXP-001');
    expect(orig.status).toBe('superseded');
    expect(orig.terminationReason).toBe('forked into EXP-002');
  });

  it('cancel: marks cancelled', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'small' });
    const r = await call('POST', '/experts/EXP-001/cancel');
    expect(r.data.status).toBe('cancelled');
  });

  it('PUT /spec writes the file', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'small' });
    const r = await call('PUT', '/experts/EXP-001/spec', { content: '# hello\n\n- list' });
    expect(r.data.ok).toBe(true);
    const { data } = await call('GET', '/experts/EXP-001/spec');
    expect(data.content).toBe('# hello\n\n- list');
  });

  it('nextAction surfaces the right hint at each lifecycle stage', async () => {
    await call('POST', '/experts', { title: 't', highLevelSpec: 'x', budgetCents: 999_999, featureSize: 'standard' });
    // Drafting
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('dispatch_expert');
    // Open conversation, write expert turn → waits for feedback agent
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'expert', body: 'opening' });
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('dispatch_feedback:FB-001');
    // Feedback replies → waits for expert
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'feedback', body: 'critique' });
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('dispatch_expert');
    // End conversation with substantive verdict → expert spawns next persona
    await call('POST', '/experts/EXP-001/feedback/FB-001/end', {
      verdict: { newIssues: [{ summary: 'x', severity: 'major' }], coversPriorIssues: [] },
    });
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('dispatch_expert');
    // Engage user → wait
    await call('PATCH', '/experts/EXP-001', { userEngaged: true });
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('wait');
    // Cancel → done
    await call('POST', '/experts/EXP-001/cancel');
    expect((await call('GET', '/experts/EXP-001')).data.nextAction).toBe('done');
  });

  it('full choreography: orchestrator decision rules drive the multi-turn back-and-forth correctly', async () => {
    // This is the regression test for the structural bug end-to-end testing
    // exposed: the orchestrator drives the loop by inspecting which turn-NNN-*.md
    // file is most recent in each in-flight conversation. Expert and feedback
    // both call APIs and exit; neither emits a decision verb.
    //
    // Simulate the orchestrator's decision rule against the same state shapes
    // the real orchestrator inspects.
    const decide = async (): Promise<string> => {
      const exps = (await call('GET', '/experts')).data.experts as any[];
      // Rule 1: feedback waiting on the agent's reply.
      for (const e of exps) {
        if (e.status !== 'gathering_feedback') continue;
        const fb = (await call('GET', `/experts/${e.id}/feedback`)).data.feedback as any[];
        for (const f of fb) {
          if (f.ended) continue;
          const dir = join(PROJECT_DIR, '.harness', 'experts', e.id, 'feedback', f.id);
          const turns = readdirSync(dir).filter((n) => /^turn-\d{3}-(expert|feedback)\.md$/.test(n)).sort();
          if (turns.length && turns[turns.length - 1].endsWith('-expert.md')) {
            return `NEXT_FEEDBACK ${e.id}.${f.id}`;
          }
        }
      }
      // Rule 2: any expert that needs to act?
      for (const e of [...exps].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
        if (['cancelled', 'superseded', 'final', 'max_rounds', 'error', 'awaiting_user'].includes(e.status)) continue;
        if (e.userEngaged) continue;
        const fb = (await call('GET', `/experts/${e.id}/feedback`)).data.feedback as any[];
        const inFlight = fb.filter((f) => !f.ended);
        if (e.status === 'drafting' || inFlight.length === 0) return `NEXT_EXPERT ${e.id}`;
        for (const f of inFlight) {
          const dir = join(PROJECT_DIR, '.harness', 'experts', e.id, 'feedback', f.id);
          const turns = readdirSync(dir).filter((n) => /^turn-\d{3}-(expert|feedback)\.md$/.test(n)).sort();
          if (turns.length && turns[turns.length - 1].endsWith('-feedback.md')) {
            return `NEXT_EXPERT ${e.id}`;
          }
        }
      }
      // Rule 3: terminal experts → scoper phase 2.
      for (const e of exps) {
        if (['final', 'max_rounds'].includes(e.status)) return 'NEXT_SCOPER phase2';
      }
      return 'IDLE';
    };

    // Empty → next is to dispatch a (not-yet-existing) expert. Skip; create one.
    await call('POST', '/experts', { title: 'choreo', highLevelSpec: 'x', budgetCents: 999_999, featureSize: 'standard' });
    expect(await decide()).toBe('NEXT_EXPERT EXP-001'); // drafting
    // Expert opens FB-001 + writes opening turn.
    await call('POST', '/experts/EXP-001/feedback', { persona: 'security' });
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'expert', body: 'opening' });
    expect(await decide()).toBe('NEXT_FEEDBACK EXP-001.FB-001');
    // Feedback replies.
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'feedback', body: 'critique' });
    expect(await decide()).toBe('NEXT_EXPERT EXP-001');
    // Expert pushes back.
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'expert', body: 'follow up' });
    expect(await decide()).toBe('NEXT_FEEDBACK EXP-001.FB-001');
    // Feedback replies again.
    await call('POST', '/experts/EXP-001/feedback/FB-001/turn', { from: 'feedback', body: 'final critique' });
    expect(await decide()).toBe('NEXT_EXPERT EXP-001');
    // Expert ends FB-001 (substantive → not converged).
    await call('POST', '/experts/EXP-001/feedback/FB-001/end', {
      verdict: { newIssues: [{ summary: 'x', severity: 'major' }], coversPriorIssues: [] },
    });
    expect(await decide()).toBe('NEXT_EXPERT EXP-001'); // spawn next persona
    // Two empty rounds → convergence.
    await call('POST', '/experts/EXP-001/feedback', { persona: 'UX' });
    await call('POST', '/experts/EXP-001/feedback/FB-002/end', { verdict: { newIssues: [], coversPriorIssues: [] } });
    await call('POST', '/experts/EXP-001/feedback', { persona: 'perf' });
    const r = await call('POST', '/experts/EXP-001/feedback/FB-003/end', { verdict: { newIssues: [], coversPriorIssues: [] } });
    expect(r.data.expert.status).toBe('final');
    // Final → scoper phase 2.
    expect(await decide()).toBe('NEXT_SCOPER phase2');
  });

  it('chat-agents excludes cancelled and superseded experts but lists static roles', async () => {
    await call('POST', '/experts', { title: 'A', highLevelSpec: 'a', budgetCents: 100, featureSize: 'small' });
    await call('POST', '/experts', { title: 'B', highLevelSpec: 'b', budgetCents: 100, featureSize: 'small' });
    await call('POST', '/experts/EXP-002/cancel');
    const { data } = await call('GET', '/chat-agents');
    const experts = data.agents.filter((a: any) => a.role === 'expert');
    expect(experts.map((e: any) => e.instanceId)).toEqual(['EXP-001']);
    // Static roles should always be present.
    const roles = new Set(data.agents.map((a: any) => a.role));
    expect(roles.has('orchestrator')).toBe(true);
    expect(roles.has('scoper')).toBe(true);
    expect(roles.has('feedback')).toBe(false); // ephemeral, never in chat list
  });
});
