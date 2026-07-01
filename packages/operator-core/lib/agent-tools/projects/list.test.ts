/**
 * list.test.ts — the projects:list MCP tool handler's own guard logic (no PG;
 * the data read forwards to listProjectsForHarness, which is mocked).
 *
 * The distinctive invariant: a single CONCRETE harness is required. The handler
 * routes args/ctx through the fail-loud resolveConcreteHarnessSlug
 * (workspace-data-isolation-leaks P-004), so the operator/superuser `'*'`
 * workspace-wildcard, an explicit `all`, AND a missing slug all return a
 * `harness_required` isError — without ever calling listProjectsForHarness on a
 * non-harness scope (which sets search_path to a nonexistent `harness_*` schema,
 * making PG throw `relation "harness_features" does not exist`). A real slug
 * forwards to the data read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const listProjectsForHarness = vi.fn(async (_slug: string) => [{ slug: 'p1' }, { slug: 'p2' }]);
vi.mock('../../projects-data', () => ({ listProjectsForHarness: (slug: string) => listProjectsForHarness(slug) }));

const projectsListTool = (await import('./list')).default;
const call = (harnessSlug?: string, ctx: Record<string, unknown> = {}) =>
  projectsListTool.handler({ harnessSlug } as never, ctx as never) as Promise<{ isError?: boolean; content: { text: string }[] }>;

const errorOf = (res: { content: { text: string }[] }) => JSON.parse(res.content[0]!.text).error as string;

beforeEach(() => listProjectsForHarness.mockClear());

describe('projects:list handler guard', () => {
  it("treats the '*' workspace-wildcard as a missing slug (harness_required, no data read)", async () => {
    const res = await call('*');
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toBe('harness_required');
    expect(listProjectsForHarness).not.toHaveBeenCalled(); // never hits the harness_* search_path crash path
  });

  it("rejects an explicit 'all' arg — cross-harness scope is not a single harness (harness_required, no data read)", async () => {
    // Regression (P-004): the old hand-rolled `if (slug === '*')` check let an
    // explicit `all` slip through to listProjectsForHarness('all') — a nonexistent
    // `harness_all` schema — a silent wrong-scope read instead of a clear error.
    const res = await call('all', { harnessSlug: '*' });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toBe('harness_required');
    expect(listProjectsForHarness).not.toHaveBeenCalled();
  });

  it('errors when no slug is given (neither arg nor ctx)', async () => {
    const res = await call(undefined, {});
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toBe('harness_required');
    expect(listProjectsForHarness).not.toHaveBeenCalled();
  });

  it('forwards a concrete slug to listProjectsForHarness and returns the projects', async () => {
    const res = await call('web');
    expect(res.isError).toBeUndefined();
    expect(listProjectsForHarness).toHaveBeenCalledWith('web');
    expect(JSON.parse(res.content[0]!.text)).toEqual({ harnessSlug: 'web', projects: [{ slug: 'p1' }, { slug: 'p2' }] });
  });

  it('falls back to ctx.harnessSlug when no arg is given', async () => {
    const res = await call(undefined, { harnessSlug: 'api' });
    expect(res.isError).toBeUndefined();
    expect(listProjectsForHarness).toHaveBeenCalledWith('api');
  });
});
