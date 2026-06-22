/**
 * workspace-for-harness.test.ts — resolveWorkspaceForHarness (the WI-148-aware
 * derive-or-throw shared by docs/* + plan-attribution). Unit: the underlying
 * fill_workspace_id_from_projects is stubbed so the wrapper's contract (honor an
 * explicit ws, derive otherwise, THROW on unresolvable — never a silent 'default')
 * is exercised without a live registry / PG.
 *
 * Rule: workspace-data-isolation-leaks-2026-06-17 P-002 / P-005 / D-003.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fill = vi.fn();
vi.mock('../agent-tools/plans/source', () => ({
  fill_workspace_id_from_projects: (slug: string | undefined) => fill(slug),
}));

import { resolveWorkspaceForHarness } from './workspace-for-harness';

describe('resolveWorkspaceForHarness', () => {
  afterEach(() => {
    fill.mockReset();
  });

  it('honors an explicit workspaceId verbatim — no registry lookup', async () => {
    expect(await resolveWorkspaceForHarness('any-harness', 'ws-explicit')).toBe('ws-explicit');
    expect(fill).not.toHaveBeenCalled();
  });

  it('trims an explicit workspaceId', async () => {
    expect(await resolveWorkspaceForHarness('h', '  ws-x  ')).toBe('ws-x');
    expect(fill).not.toHaveBeenCalled();
  });

  it('derives the workspace from the harness when none is passed', async () => {
    fill.mockResolvedValue('papercusp-workspace');
    expect(await resolveWorkspaceForHarness('papercusp')).toBe('papercusp-workspace');
    expect(fill).toHaveBeenCalledWith('papercusp');
  });

  it('falls back to derive when the explicit workspaceId is blank', async () => {
    fill.mockResolvedValue('derived-ws');
    expect(await resolveWorkspaceForHarness('h', '   ')).toBe('derived-ws');
    expect(fill).toHaveBeenCalledWith('h');
  });

  it('THROWS (never silently defaults) when the harness resolves to no workspace', async () => {
    fill.mockResolvedValue(null);
    await expect(resolveWorkspaceForHarness('ghost-harness')).rejects.toThrow(
      /not registered|cannot be resolved|Refusing to silently default/i,
    );
  });
});
