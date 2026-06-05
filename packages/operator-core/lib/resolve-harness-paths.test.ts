/**
 * Unit tests for resolveHarnessPaths (resolve-harness-paths.ts).
 *
 * The function dynamically imports `./harness-registry` and calls
 * `loadHarnessRegistry()` to map a (slug, workspaceId) to on-disk paths. It is
 * deliberately FAIL-SOFT: an unregistered slug OR a registry that throws (PG
 * down) yields a `/tmp/papercusp-unresolved/<ws>/<slug>` placeholder instead of
 * throwing — callers see the obvious prefix in their errors.
 *
 * `./harness-registry` is mocked (vi.mock) so no real PG is touched. Three
 * paths covered:
 *   1. found — a matching project with a `path` → join(path) + `/.papercusp`.
 *   2. not-found — no matching slug (or matched-but-no-path) → placeholder.
 *   3. catch — loadHarnessRegistry throws → placeholder (no throw escapes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadHarnessRegistry = vi.fn();

vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: () => loadHarnessRegistry(),
}));

import { resolveHarnessPaths } from './resolve-harness-paths';

beforeEach(() => {
  loadHarnessRegistry.mockReset();
});

describe('resolveHarnessPaths — registry hit', () => {
  it('joins the project path and appends /.papercusp for the state dir', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        { slug: 'other', path: '/home/me/other' },
        { slug: 'papercup', path: '/home/me/papercup' },
      ],
    });

    const out = await resolveHarnessPaths('papercup', 'ws-1');
    expect(out).toEqual({
      projectDir: '/home/me/papercup',
      stateDir: '/home/me/papercup/.papercusp',
    });
  });

  it('selects the project by exact slug match', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [
        { slug: 'papercup', path: '/a' },
        { slug: 'papercup-extra', path: '/b' },
      ],
    });
    const out = await resolveHarnessPaths('papercup-extra', 'ws-x');
    expect(out.projectDir).toBe('/b');
    expect(out.stateDir).toBe('/b/.papercusp');
  });
});

describe('resolveHarnessPaths — not found → placeholder (fail-soft)', () => {
  it('returns the /tmp placeholder when no project matches the slug', async () => {
    loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'something-else', path: '/elsewhere' }],
    });

    const out = await resolveHarnessPaths('missing', 'ws-42');
    expect(out).toEqual({
      projectDir: '/tmp/papercusp-unresolved/ws-42/missing',
      stateDir: '/tmp/papercusp-unresolved/ws-42/missing/.papercusp',
    });
  });

  it('returns the placeholder when the registry has zero projects', async () => {
    loadHarnessRegistry.mockResolvedValue({ projects: [] });

    const out = await resolveHarnessPaths('any', 'ws-empty');
    expect(out.projectDir).toBe('/tmp/papercusp-unresolved/ws-empty/any');
    expect(out.stateDir).toBe('/tmp/papercusp-unresolved/ws-empty/any/.papercusp');
  });

  it('returns the placeholder when the matched project has no path', async () => {
    // `proj?.path` is falsy → the if-guard fails → fall through to placeholder.
    loadHarnessRegistry.mockResolvedValue({
      projects: [{ slug: 'pathless' /* no path */ }],
    });

    const out = await resolveHarnessPaths('pathless', 'ws-7');
    expect(out.projectDir).toBe('/tmp/papercusp-unresolved/ws-7/pathless');
  });

  it('embeds the workspaceId and slug verbatim in the placeholder', async () => {
    loadHarnessRegistry.mockResolvedValue({ projects: [] });
    const out = await resolveHarnessPaths('my-slug', 'workspace-abc');
    expect(out.projectDir).toBe('/tmp/papercusp-unresolved/workspace-abc/my-slug');
  });
});

describe('resolveHarnessPaths — registry throws → placeholder (no throw escapes)', () => {
  it('catches a rejected loadHarnessRegistry (PG down) and returns the placeholder', async () => {
    loadHarnessRegistry.mockRejectedValue(new Error('connection refused'));

    const out = await resolveHarnessPaths('papercup', 'ws-down');
    expect(out).toEqual({
      projectDir: '/tmp/papercusp-unresolved/ws-down/papercup',
      stateDir: '/tmp/papercusp-unresolved/ws-down/papercup/.papercusp',
    });
  });

  it('does not reject the promise even when the registry throws synchronously', async () => {
    loadHarnessRegistry.mockImplementation(() => {
      throw new Error('sync boom');
    });

    // The whole call must resolve (fail-soft), never reject.
    await expect(resolveHarnessPaths('x', 'ws-sync')).resolves.toEqual({
      projectDir: '/tmp/papercusp-unresolved/ws-sync/x',
      stateDir: '/tmp/papercusp-unresolved/ws-sync/x/.papercusp',
    });
  });

  it('catches when the resolved registry shape is malformed (projects undefined)', async () => {
    // reg.projects.find(...) throws a TypeError, which the catch swallows.
    loadHarnessRegistry.mockResolvedValue({});

    const out = await resolveHarnessPaths('y', 'ws-bad');
    expect(out.projectDir).toBe('/tmp/papercusp-unresolved/ws-bad/y');
  });
});
