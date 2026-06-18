/**
 * list.test.ts — the projects:list MCP tool handler's own guard logic (no PG;
 * the data read forwards to listProjectsForHarness, which is mocked).
 *
 * The distinctive invariant: the `*` superuser workspace-wildcard is treated the
 * same as a MISSING slug — without that guard, listProjectsForHarness('*') sets
 * search_path to a non-existent `harness_*` schema and PG throws
 * `relation "harness_features" does not exist` (the documented footgun). A
 * missing/`*` slug returns an isError asking for a concrete harness; a real slug
 * forwards to the data read.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const listProjectsForHarness = vi.fn(async (_slug: string) => [{ slug: 'p1' }, { slug: 'p2' }]);
vi.mock('../../projects-data', () => ({ listProjectsForHarness: (slug: string) => listProjectsForHarness(slug) }));

const projectsListTool = (await import('./list')).default;
const call = (harnessSlug?: string, ctx: Record<string, unknown> = {}) =>
  projectsListTool.handler({ harnessSlug } as never, ctx as never) as Promise<{ isError?: boolean; content: { text: string }[] }>;

beforeEach(() => listProjectsForHarness.mockClear());

describe('projects:list handler guard', () => {
  it("treats the '*' workspace-wildcard as a missing slug (isError, no data read)", async () => {
    const res = await call('*');
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('harness_slug_required');
    expect(listProjectsForHarness).not.toHaveBeenCalled(); // never hits the harness_* search_path crash path
  });

  it('errors when no slug is given (neither arg nor ctx)', async () => {
    const res = await call(undefined, {});
    expect(res.isError).toBe(true);
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
