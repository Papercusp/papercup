/**
 * Unit tests for PUT /api/harness/:slug/prompts/:role — the P-016 swap (D-007): a
 * live prompt edit on a BLUEPRINT-harness is a commit→reproject of
 * `.papercusp/prompts/<role>.md` (replacing the ungated direct PG override write),
 * while a legacy / non-blueprint harness keeps the PG-override escape-hatch. Drives
 * the handler directly with mocked seams (no DB / git / fs writes) + a real temp dir
 * for the `.papercusp/blueprint.yaml` existence guard.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteContext } from '../define-route';

const resolvePhasedProject = vi.fn();
const setPromptOverride = vi.fn();
const commitAndReproject = vi.fn();

vi.mock('../../harness-core', async (importActual) => ({
  ...(await importActual<typeof import('../../harness-core')>()),
  resolvePhasedProject: (...a: unknown[]) => resolvePhasedProject(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../route-workspace', () => ({ routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('../../known-roles', () => ({ getKnownRoles: () => ['worker', 'validator'] }));
vi.mock('../../harness-prompt-overrides', () => ({
  getPromptOverride: vi.fn(),
  setPromptOverride: (...a: unknown[]) => setPromptOverride(...a),
  deletePromptOverride: vi.fn(),
  listPromptOverrides: vi.fn().mockResolvedValue([]),
  clearAllPromptOverrides: vi.fn(),
}));
vi.mock('../../blueprint/commit-reproject', () => ({ commitAndReproject: (...a: unknown[]) => commitAndReproject(...a) }));
vi.mock('../../blueprint/commit-reproject-real', () => ({ realCommitReprojectDeps: () => ({}) }));

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };
const ctx = (params: Record<string, string> = {}): RouteContext => ({
  principal: null, input: undefined, params, log: () => {}, signal: new AbortController().signal,
});
async function putRoute(): Promise<Route> {
  const mod = await import('../routes/harness/prompts');
  const r = (mod.default as Route[]).find((x) => x.method === 'PUT' && x.path === '/harness/:slug/prompts/:role');
  if (!r) throw new Error('PUT prompts route not registered');
  return r;
}
function putReq(content: unknown): Request {
  return new Request('http://localhost:3070/api/harness/alpha/prompts/worker', { method: 'PUT', body: JSON.stringify({ content }) });
}

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'prompts-route-'));
  resolvePhasedProject.mockResolvedValue({ slug: 'alpha', path: dir });
  setPromptOverride.mockResolvedValue(undefined);
  commitAndReproject.mockResolvedValue({ ok: true, committed: true, commit: 'sha7', contentHash: 'h7', editedPath: 'x', blueprintPath: 'y' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PUT /harness/:slug/prompts/:role', () => {
  it('blueprint-harness (has .papercusp/blueprint.yaml) → commit→reproject, NOT a PG override', async () => {
    mkdirSync(join(dir, '.papercusp'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), 'id: coding\n');

    const res = await (await putRoute()).handler(putReq('new worker prompt'), ctx({ slug: 'alpha', role: 'worker' }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.mode).toBe('commit-reproject');
    expect(body.commit).toBe('sha7');
    expect(commitAndReproject).toHaveBeenCalledWith(
      { workspaceId: 'ws-test', harnessSlug: 'alpha', harnessDir: dir, edit: { kind: 'prompt', role: 'worker', md: 'new worker prompt' } },
      expect.anything(),
    );
    expect(setPromptOverride).not.toHaveBeenCalled();
  });

  it('legacy harness (no .papercusp/blueprint.yaml) → PG override escape-hatch', async () => {
    // dir has no .papercusp/blueprint.yaml
    const res = await (await putRoute()).handler(putReq('x'), ctx({ slug: 'alpha', role: 'worker' }));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.mode).toBe('pg-override');
    expect(setPromptOverride).toHaveBeenCalledWith('ws-test', 'alpha', 'worker', 'x');
    expect(commitAndReproject).not.toHaveBeenCalled();
  });

  it('a failed commit→reproject surfaces ok:false (+ reason), proposal/edit not silently accepted', async () => {
    mkdirSync(join(dir, '.papercusp'), { recursive: true });
    writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), 'id: coding\n');
    commitAndReproject.mockResolvedValue({ ok: false, committed: false, commit: null, contentHash: null, editedPath: 'x', blueprintPath: 'y', reason: 'git commit failed' });

    const res = await (await putRoute()).handler(putReq('x'), ctx({ slug: 'alpha', role: 'worker' }));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/git commit failed/);
  });

  it('400s on an unknown role', async () => {
    const res = await (await putRoute()).handler(putReq('x'), ctx({ slug: 'alpha', role: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('400s without string content', async () => {
    const res = await (await putRoute()).handler(putReq(123), ctx({ slug: 'alpha', role: 'worker' }));
    expect(res.status).toBe(400);
  });
});
