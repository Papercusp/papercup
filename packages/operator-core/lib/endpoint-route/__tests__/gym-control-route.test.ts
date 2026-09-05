/**
 * Unit tests for the /api/gym/* control-plane routes (gym-ui-handoff backend).
 * Drives each handler directly with a hand-built RouteContext, mocking the
 * workspace seam (routeWithWorkspace / activeWorkspaceId) + the control-plane
 * and run-analytics (gym/read-api) SQL helpers — so the test asserts the
 * ROUTE's own logic (param/body parsing, response envelopes, validation 400s,
 * scope threading) without a DB. The SQL is covered by
 * control-plane.integration.test.ts. summarizeGymStatus + GYM_PROMPT_KEYS are
 * kept real.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteContext } from '../define-route';
import { passingCandidateVerdict } from '../../gym/__tests__/_candidate-verdict';

/**
 * P-002 / D-004(3): accept installs a live prompt, so the route now requires the
 * proposal's verdict to show the real-anchor pool held. Tests whose subject is the
 * ROUTING carry this; the gate's own behaviour is asserted separately below.
 */
const HELD_VERDICT = passingCandidateVerdict('p1');

const getPrompts = vi.fn();
const setPrompt = vi.fn();
const listProposals = vi.fn();
const decideProposal = vi.fn();
const getAutoloop = vi.fn();
const setAutoloop = vi.fn();
// P-016: the commit→reproject accept path seams.
const resolvePhasedProject = vi.fn();
const acceptProposalViaCommit = vi.fn();
// The durable live-DB run-analytics readers (migration 650) — mocked so the route's own
// wiring (scope threading, response envelope) is asserted without a real `Sql` tag function
// behind the dummy `tx` the route-workspace mock below hands the route.
const readDurableCycleHistory = vi.fn();

vi.mock('../../harness-core', async (importActual) => ({
  ...(await importActual<typeof import('../../harness-core')>()),
  resolvePhasedProject: (...a: unknown[]) => resolvePhasedProject(...a),
}));
vi.mock('../../blueprint/commit-reproject-real', () => ({
  acceptProposalViaCommit: (...a: unknown[]) => acceptProposalViaCommit(...a),
}));

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
// routeWithWorkspace just runs the callback with a dummy tx (the control-plane fns are mocked).
vi.mock('../../route-workspace', () => ({
  routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('../../gym/control-plane', async (importActual) => ({
  ...(await importActual<typeof import('../../gym/control-plane')>()),
  getPrompts: (...a: unknown[]) => getPrompts(...a),
  setPrompt: (...a: unknown[]) => setPrompt(...a),
  listProposals: (...a: unknown[]) => listProposals(...a),
  decideProposal: (...a: unknown[]) => decideProposal(...a),
  getAutoloop: (...a: unknown[]) => getAutoloop(...a),
  setAutoloop: (...a: unknown[]) => setAutoloop(...a),
}));
vi.mock('../../gym/read-api', async (importActual) => ({
  ...(await importActual<typeof import('../../gym/read-api')>()),
  readDurableCycleHistory: (...a: unknown[]) => readDurableCycleHistory(...a),
}));

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };
const ctx = (params: Record<string, string> = {}): RouteContext => ({
  principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal,
});

async function route(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/gym/control');
  const r = (mod.default as Route[]).find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method} ${path} not registered`);
  return r;
}
function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3070/api/gym${path}`, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  getPrompts.mockResolvedValue({ judgeRubric: '# r', roles: { worker: 'w' } });
  listProposals.mockResolvedValue([]);
  getAutoloop.mockResolvedValue(null);
  setAutoloop.mockResolvedValue({ enabled: true, status: 'idle', budgetUsd: 10, spentUsd: 0 });
  decideProposal.mockResolvedValue({ ok: true, promoted: true });
  setPrompt.mockResolvedValue(undefined);
  // Default: NOT a blueprint-harness → accept falls back to the legacy promote path.
  resolvePhasedProject.mockResolvedValue(null);
});

describe('GET /gym/:slug', () => {
  it('returns harnessSlug + status + prompts + editableKeys', async () => {
    listProposals.mockResolvedValue([{ cycle: 2 }, { cycle: 1 }]);
    getAutoloop.mockResolvedValue({ enabled: true, status: 'running', budgetUsd: 5, spentUsd: 1, lastCycle: 0 });
    const r = await route('GET', '/gym/:slug');
    const res = await r.handler(req('/alpha'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.harnessSlug).toBe('alpha');
    expect(body.status.pendingCount).toBe(2);
    expect(body.status.lastCycle).toBe(2);
    expect(body.status.autoloop).toEqual({ enabled: true, status: 'running', budgetUsd: 5, spentUsd: 1 });
    expect(body.prompts.judgeRubric).toBe('# r');
    expect(Array.isArray(body.editableKeys)).toBe(true);
    expect(body.editableKeys).toContain('judge');
  });
});

describe('POST /gym/:slug/prompts', () => {
  it('sets a prompt and returns the updated prompts', async () => {
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ role: 'worker', md: 'new' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setPrompt).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', role: 'worker', md: 'new' });
  });
  it('400s without a role', async () => {
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ md: 'x' }) }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
  it('400s when setPrompt rejects an invalid key', async () => {
    setPrompt.mockRejectedValue(new Error('not an editable prompt key'));
    const r = await route('POST', '/gym/:slug/prompts');
    const res = await r.handler(req('/alpha/prompts', { method: 'POST', body: JSON.stringify({ role: 'bogus', md: 'x' }) }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /gym/:slug/proposals', () => {
  it('lists pending by default', async () => {
    listProposals.mockResolvedValue([{ id: 'p1' }]);
    const r = await route('GET', '/gym/:slug/proposals');
    const res = await r.handler(req('/alpha/proposals'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.proposals).toHaveLength(1);
    expect(listProposals).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', status: 'pending', variantId: undefined });
  });
});

describe('POST /gym/:slug/accept', () => {
  it('decides one proposal by id → promoted', async () => {
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.decided).toBe(1);
    expect(body.promoted).toBe(1);
    expect(decideProposal).toHaveBeenCalledWith(expect.anything(), { id: 'p1', workspaceId: 'ws-test', harnessSlug: 'alpha', decision: 'accepted' });
  });
  it('decides every pending proposal of a variantId', async () => {
    listProposals.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ variantId: 'v-1' }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.decided).toBe(2);
    expect(decideProposal).toHaveBeenCalledTimes(2);
  });
  it('400s without id or variantId', async () => {
    const r = await route('POST', '/gym/:slug/accept');
    const res = await r.handler(req('/alpha/accept', { method: 'POST', body: '{}' }), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });

  describe('blueprint-harness target → commit→reproject (P-016)', () => {
    let dir: string;
    beforeEach(() => {
      // A real temp dir with a .papercusp/blueprint.yaml → acceptRoute takes the commit path.
      dir = mkdtempSync(join(tmpdir(), 'gym-accept-'));
      mkdirSync(join(dir, '.papercusp'), { recursive: true });
      writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), 'id: coding\nextends: coding\n');
      resolvePhasedProject.mockResolvedValue({ slug: 'alpha', path: dir });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * P-002 / D-004(3) on THIS branch. The ruling names harness_prompt_overrides because
     * that was the only install surface when it was written; commit→reproject arrived
     * later and installs the same prompt by a different mechanism. Gating only the table
     * the ruling happened to name would have left the route real blueprint harnesses
     * actually take completely ungated — which is why these two live here and not only
     * beside decideProposal.
     */
    it('refuses to commit a challenger with no real-anchor evidence', async () => {
      listProposals.mockResolvedValue([{ id: 'p1', role: 'worker', proposedMd: 'ungated', candidateVersion: null }]);
      const r = await route('POST', '/gym/:slug/accept');
      const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1' }) }), ctx({ slug: 'alpha' }));
      const body = await res.json();

      expect(body.ok).toBe(false);
      expect(body.results[0].reason).toBe('real_anchor_unproven');
      // Nothing was committed and nothing was written — the refusal is BEFORE the install.
      expect(acceptProposalViaCommit).not.toHaveBeenCalled();
      expect(decideProposal).not.toHaveBeenCalled();
    });

    it('commits an ungated challenger when the caller supplies an explicit override reason', async () => {
      listProposals.mockResolvedValue([{ id: 'p1', role: 'worker', proposedMd: 'ungated', candidateVersion: null }]);
      acceptProposalViaCommit.mockResolvedValue({ ok: true, proposalMarked: true, committed: true, commit: 'sha9', contentHash: 'h9' });
      const r = await route('POST', '/gym/:slug/accept');
      const res = await r.handler(
        req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1', overrideRealAnchor: 'rolling back a bad champion' }) }),
        ctx({ slug: 'alpha' }),
      );
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(acceptProposalViaCommit).toHaveBeenCalled();
      // The reason rides out on the response, so the override is legible at the call
      // site and not only afterwards in the git history.
      expect(body.results[0].realAnchorOverridden).toBe('rolling back a bad champion');
    });

    it('treats a reasonless override as NO override — a bare truthy flag must not install', async () => {
      // The escape hatch exists so the ledger can later say why the live prompt is what
      // it is. `overrideRealAnchor: true` carries nothing to say, so it is not an override.
      listProposals.mockResolvedValue([{ id: 'p1', role: 'worker', proposedMd: 'ungated', candidateVersion: null }]);
      const r = await route('POST', '/gym/:slug/accept');
      const res = await r.handler(
        req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1', overrideRealAnchor: true }) }),
        ctx({ slug: 'alpha' }),
      );
      const body = await res.json();

      expect(body.ok).toBe(false);
      expect(body.results[0].reason).toBe('real_anchor_unproven');
      expect(acceptProposalViaCommit).not.toHaveBeenCalled();
    });

    it('routes accept through acceptProposalViaCommit (NOT the legacy promote)', async () => {
      listProposals.mockResolvedValue([{ id: 'p1', role: 'worker', proposedMd: 'better worker prompt', candidateVersion: HELD_VERDICT }]);
      acceptProposalViaCommit.mockResolvedValue({ ok: true, proposalMarked: true, committed: true, commit: 'sha9', contentHash: 'h9' });

      const r = await route('POST', '/gym/:slug/accept');
      const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1' }) }), ctx({ slug: 'alpha' }));
      const body = await res.json();

      expect(body.mode).toBe('commit-reproject');
      expect(body.ok).toBe(true);
      expect(body.decided).toBe(1);
      expect(acceptProposalViaCommit).toHaveBeenCalledWith(expect.anything(), {
        workspaceId: 'ws-test', harnessSlug: 'alpha', harnessDir: dir, proposalId: 'p1', role: 'worker', proposedMd: 'better worker prompt',
      });
      // the legacy promote path is NOT used for a blueprint-harness
      expect(decideProposal).not.toHaveBeenCalled();
    });

    it('a failed commit→reproject leaves the proposal undecided (ok:false)', async () => {
      listProposals.mockResolvedValue([{ id: 'p1', role: 'worker', proposedMd: 'x', candidateVersion: HELD_VERDICT }]);
      acceptProposalViaCommit.mockResolvedValue({ ok: false, proposalMarked: false, committed: false, commit: null, contentHash: null, reason: 'git commit failed' });
      const r = await route('POST', '/gym/:slug/accept');
      const res = await r.handler(req('/alpha/accept', { method: 'POST', body: JSON.stringify({ id: 'p1' }) }), ctx({ slug: 'alpha' }));
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.decided).toBe(0);
      expect(body.results[0].reason).toMatch(/git commit failed/);
    });
  });
});

describe('POST /gym/:slug/autoloop', () => {
  it('applies a partial patch', async () => {
    const r = await route('POST', '/gym/:slug/autoloop');
    const res = await r.handler(req('/alpha/autoloop', { method: 'POST', body: JSON.stringify({ enabled: true, budgetUsd: 25 }) }), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(setAutoloop).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha', enabled: true, budgetUsd: 25 });
  });
});

describe('run-analytics reads (durable live-DB, migration 650)', () => {
  // Pre-migration-650 this route read an EPHEMERAL, separately-provisioned gym PG that could
  // genuinely be absent, and degraded to `{ cycles: [], available: false }`. Migration 650 moved
  // the read to the durable `harness_gym` cache in the LIVE operator DB (the same connection
  // every other route uses) — there is no more "without a gym DB" case, so the route no longer
  // emits an `available` field (see apps/operator/app/gym/__tests__/GymDashboard.test.tsx). This
  // now just asserts the route threads the workspace/harness scope and shapes the response.
  it('GET /gym/:slug/cycles → threads scope, returns { cycles }', async () => {
    readDurableCycleHistory.mockResolvedValueOnce([
      { cycle: 0, parentId: null, candidateId: 'cand-c0', decision: 'accept' },
    ]);
    const r = await route('GET', '/gym/:slug/cycles');
    const res = await r.handler(req('/alpha/cycles'), ctx({ slug: 'alpha' }));
    const body = await res.json();
    expect(readDurableCycleHistory).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-test', harnessSlug: 'alpha' });
    expect(body.cycles).toEqual([{ cycle: 0, parentId: null, candidateId: 'cand-c0', decision: 'accept' }]);
    expect(body.available).toBeUndefined();
  });
  it('GET /gym/:slug/compare → 400 without a/b/rubricHash', async () => {
    const r = await route('GET', '/gym/:slug/compare');
    const res = await r.handler(req('/alpha/compare'), ctx({ slug: 'alpha' }));
    expect(res.status).toBe(400);
  });
});
