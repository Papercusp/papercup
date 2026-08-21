/**
 * projects-entry-blueprint.test.ts — EI-665 regression: POST /api/harness/projects
 * (the CreateHarnessPicker's Entry 1 "new local directory" / Entry 3 "existing
 * local folder" paths) must write the git-canonical `.papercusp/blueprint.yaml`
 * and (for a fresh `git init`) make the initial commit — matching the contract
 * `harness:create` documents and Entry 2 (githubUrl) already honored.
 *
 * Before this fix, `create` (projects.ts) only ran `generateBlueprintForClone` /
 * `commitInitialHiveRepo` for the `cloneInfo` (Entry 2) branch, leaving a fresh
 * Entry-1 dir with only a bare `.git` (no blueprint, no commit — an unborn HEAD)
 * and an Entry-3 existing folder with no blueprint at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadHarnessRegistry = vi.fn();
const mutateHarnessRegistry = vi.fn();
const initLocalHarnessDir = vi.fn();
const scaffoldHarnessSchema = vi.fn();
const generateBlueprintForClone = vi.fn();
const commitInitialHiveRepo = vi.fn();
const migrateConfigJsonToInstance = vi.fn();

vi.mock('../../../harness-registry', async (orig) => ({
  ...(await orig<typeof import('../../../harness-registry')>()),
  loadHarnessRegistry: (...a: unknown[]) => loadHarnessRegistry(...a),
  mutateHarnessRegistry: (...a: unknown[]) => mutateHarnessRegistry(...a),
  isEphemeralForeignProject: () => false,
}));
vi.mock('../../../harness-core', () => ({
  harnessDir: (p: { path: string }) => p.path,
}));
vi.mock('../../../harness/hive-groups', () => ({ HIVE_KIND: 'hive' }));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: vi.fn(),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../harness/init-local-dir', () => ({
  initLocalHarnessDir: (...a: unknown[]) => initLocalHarnessDir(...a),
  InitLocalDirError: class InitLocalDirError extends Error {
    code: string;
    detail?: string;
    constructor(code: string, message: string, detail?: string) {
      super(message);
      this.code = code;
      this.detail = detail;
    }
  },
}));
vi.mock('../../../scaffold-harness-schema', () => ({
  scaffoldHarnessSchema: (...a: unknown[]) => scaffoldHarnessSchema(...a),
}));
vi.mock('../../../harness/generate-blueprint-for-clone', () => ({
  generateBlueprintForClone: (...a: unknown[]) => generateBlueprintForClone(...a),
}));
vi.mock('../../../harness/hive-repo-init', () => ({
  commitInitialHiveRepo: (...a: unknown[]) => commitInitialHiveRepo(...a),
}));
vi.mock('../../../deployment/instance-config', () => ({
  migrateConfigJsonToInstance: (...a: unknown[]) => migrateConfigJsonToInstance(...a),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

import routes from './projects';

const byPath = (path: string) => {
  const r = (routes as Array<{ path: string; method: string }>).find(
    (x) => x.path === path && x.method === 'POST',
  );
  if (!r) throw new Error(`no route for ${path}`);
  return r as unknown as { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> };
};

const createRoute = byPath('/harness/projects');

async function post(body: unknown) {
  const req = new Request('http://127.0.0.1/api/harness/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await createRoute.handler(req, {});
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  loadHarnessRegistry.mockReset().mockResolvedValue({ projects: [] });
  mutateHarnessRegistry.mockReset().mockImplementation(async (mutator: (cur: { projects: unknown[] }) => unknown) => {
    mutator({ projects: [] });
  });
  initLocalHarnessDir.mockReset().mockResolvedValue({ path: '/tmp/parent/e2e-imp-j1', initialized: true });
  scaffoldHarnessSchema.mockReset().mockResolvedValue(undefined);
  generateBlueprintForClone.mockReset().mockResolvedValue({ generated: true, blueprintFile: '/tmp/parent/e2e-imp-j1/.papercusp/blueprint.yaml' });
  commitInitialHiveRepo.mockReset().mockResolvedValue({ committed: true, branch: 'staging' });
  migrateConfigJsonToInstance.mockReset().mockResolvedValue({ fields: [] });
});

describe('POST /api/harness/projects — Entry 1 (fresh parentDir+folderName) gets a blueprint + initial commit (EI-665)', () => {
  it('writes the blueprint AND makes the initial commit for a fresh git-init dir', async () => {
    const { status, body } = await post({ slug: 'e2e-imp-j1', parentDir: '/tmp/parent', folderName: 'e2e-imp-j1' });
    expect(status).toBe(200);
    expect(initLocalHarnessDir).toHaveBeenCalledWith({ parentDir: '/tmp/parent', folderName: 'e2e-imp-j1' });
    expect(generateBlueprintForClone).toHaveBeenCalledWith(
      'e2e-imp-j1',
      '/tmp/parent/e2e-imp-j1',
      { runTests: false },
    );
    expect(commitInitialHiveRepo).toHaveBeenCalledWith({ path: '/tmp/parent/e2e-imp-j1', slug: 'e2e-imp-j1' });
    expect(body).toMatchObject({
      ok: true,
      blueprint: { generated: true },
      repoInit: { committed: true, branch: 'staging' },
    });
  });

  it('honors generateBlueprint:false — no blueprint write, but the commit still runs (repo-integrity is not opt-out)', async () => {
    const { body } = await post({
      slug: 'e2e-imp-j1',
      parentDir: '/tmp/parent',
      folderName: 'e2e-imp-j1',
      generateBlueprint: false,
    });
    expect(generateBlueprintForClone).not.toHaveBeenCalled();
    expect(commitInitialHiveRepo).toHaveBeenCalled();
    expect(body).not.toHaveProperty('blueprint');
  });

  it('a blueprint-generation failure is reported, never thrown — registration still succeeds', async () => {
    generateBlueprintForClone.mockResolvedValue({ generated: false, error: 'boom' });
    const { status, body } = await post({ slug: 'e2e-imp-j1', parentDir: '/tmp/parent', folderName: 'e2e-imp-j1' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, blueprint: { generated: false, error: 'boom' } });
  });
});
