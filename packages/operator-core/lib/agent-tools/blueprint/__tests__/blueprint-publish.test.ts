/**
 * blueprint:publish — P-016 (domain-generic-hive-architecture-2026-06-18).
 *
 * PG-free unit (the Comb publish core + repo-coords resolver have their own
 * suites). Pins the publish tool: the not-in-repo guard, the repo-coords guard /
 * failure pass-through, the blueprint.yaml `kind` → `blueprint_kind` discriminator
 * (delta-not-copy: it reads the kind but never flattens the blueprint), and the
 * PENDING-success envelope (D-007 approval gate). Uses a real temp-dir blueprint
 * so the yaml read + kind extraction run for real; only the network boundaries
 * (coords + publish core) are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import publishTool from '../publish';
import { resolveRepoCoordsFromDir } from '../../../cupboard/resolve-repo-coords';
import { publishListingToCupboard } from '../../../cupboard/publish-listing';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../../cupboard/resolve-repo-coords', () => ({
  resolveRepoCoordsFromDir: vi.fn(),
  gitOriginUrl: vi.fn(),
  fetchGithubRepoMeta: vi.fn(),
}));
vi.mock('../../../cupboard/publish-listing', () => ({ publishListingToCupboard: vi.fn() }));

const mockCoords = vi.mocked(resolveRepoCoordsFromDir);
const mockPublish = vi.mocked(publishListingToCupboard);

function call(tool: unknown, args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (tool as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(
    args,
    ctx,
  );
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

const COORDS = {
  github_repository_id: 9,
  github_owner: 'acme',
  github_name: 'proj',
  github_url: 'https://github.com/acme/proj',
};

const dirs: string[] = [];
function repoWithBlueprint(id: string, yaml: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'bp-pub-'));
  dirs.push(repo);
  const bpDir = join(repo, '.papercusp', 'blueprints', id);
  mkdirSync(bpDir, { recursive: true });
  writeFileSync(join(bpDir, 'blueprint.yaml'), yaml);
  return repo;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('blueprint:publish tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCoords.mockResolvedValue(COORDS as unknown as Awaited<ReturnType<typeof resolveRepoCoordsFromDir>>);
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-1', review_status: 'pending' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
  });

  it('returns blueprint_not_in_repo when the blueprint dir is missing (never reaches coords/publish)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bp-pub-empty-'));
    dirs.push(repo);
    const res = body(await call(publishTool, { blueprintId: 'nope', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'blueprint_not_in_repo' });
    expect(mockCoords).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns repo_coords_unresolvable WITH the fix-it hint and never publishes (null coords)', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\nkind: harness\n');
    mockCoords.mockResolvedValue(null as never);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable' });
    expect(res.hint).toMatch(/git repo with a GitHub origin/i);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('surfaces a coords resolution error detail', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockCoords.mockResolvedValue({ error: 'no origin remote' } as never);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: false, error: 'repo_coords_unresolvable', detail: 'no origin remote' });
  });

  it('passes a publish-core failure through', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockPublish.mockResolvedValue({ ok: false, error: 'gh_token_missing', status: 401 } as unknown as Awaited<
      ReturnType<typeof publishListingToCupboard>
    >);
    expect(
      body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo })),
    ).toMatchObject({ ok: false, error: 'gh_token_missing', status: 401 });
  });

  it("publishes a kind='blueprint' listing (delta-not-copy), carries the hive blueprint_kind, reports PENDING", async () => {
    const repo = repoWithBlueprint('my-hive-bp', 'id: my-hive-bp\nextends: coding\nkind: hive\n');
    const res = body(
      await call(publishTool, { blueprintId: 'my-hive-bp', title: 'T', description: 'D', repoDir: repo }),
    );
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        listing_kind: 'blueprint',
        listing_ref: 'my-hive-bp',
        blueprint_kind: 'hive',
        project_ref: 'acme/proj',
      }),
    );
    expect(res).toMatchObject({ ok: true, listingId: 'listing-1', blueprintKind: 'hive', review_status: 'pending' });
    expect(res.hint).toMatch(/PENDING/);
  });

  it("defaults blueprint_kind to 'harness' when the blueprint.yaml declares no hive kind", async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n'); // no `kind:`
    await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo });
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({ blueprint_kind: 'harness' }));
  });

  it('suppresses the PENDING hint when the listing comes back approved', async () => {
    const repo = repoWithBlueprint('my-bp', 'id: my-bp\nextends: coding\n');
    mockPublish.mockResolvedValue({
      ok: true,
      data: { id: 'listing-2', review_status: 'approved' },
    } as unknown as Awaited<ReturnType<typeof publishListingToCupboard>>);
    const res = body(await call(publishTool, { blueprintId: 'my-bp', title: 'T', description: 'D', repoDir: repo }));
    expect(res).toMatchObject({ ok: true, listingId: 'listing-2', review_status: 'approved' });
    expect(res.hint).toBeUndefined();
  });
});
