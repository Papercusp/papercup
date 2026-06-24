import { describe, it, expect } from 'vitest';
import { keepUserPoolHitForWorkspace } from './workspace-scope-recall';

/** Build a user-pool hit with a given kind + workspace_id (undefined ⇒ no metadata key). */
const hit = (kind: string | undefined, ws: unknown) => ({
  kind,
  metadata: ws === undefined ? {} : ({ workspace_id: ws } as Record<string, unknown>),
});

describe('keepUserPoolHitForWorkspace (P-006 conservative workspace-scoped recall filter)', () => {
  it('KEEPS a hit with no / empty workspace_id (legacy, pre-stamping — never gut recall)', () => {
    expect(keepUserPoolHitForWorkspace(hit('project', undefined), 'ws-1')).toBe(true);
    expect(keepUserPoolHitForWorkspace({ kind: 'project', metadata: null }, 'ws-1')).toBe(true);
    expect(keepUserPoolHitForWorkspace(hit('project', ''), 'ws-1')).toBe(true);
    expect(keepUserPoolHitForWorkspace(hit('project', 42), 'ws-1')).toBe(true); // non-string → legacy-safe
  });

  it('KEEPS owner-tier kinds (user/feedback/reference) across workspaces', () => {
    for (const k of ['user', 'feedback', 'reference']) {
      expect(keepUserPoolHitForWorkspace(hit(k, 'ws-OTHER'), 'ws-1')).toBe(true);
    }
  });

  it('KEEPS a project hit that matches the active workspace', () => {
    expect(keepUserPoolHitForWorkspace(hit('project', 'ws-1'), 'ws-1')).toBe(true);
  });

  it('DROPS a project (or untyped) hit explicitly tagged with a different workspace', () => {
    expect(keepUserPoolHitForWorkspace(hit('project', 'ws-OTHER'), 'ws-1')).toBe(false);
    expect(keepUserPoolHitForWorkspace(hit(undefined, 'ws-OTHER'), 'ws-1')).toBe(false);
  });

  it('FAILS OPEN when there is no active workspace to compare against', () => {
    expect(keepUserPoolHitForWorkspace(hit('project', 'ws-OTHER'), null)).toBe(true);
    expect(keepUserPoolHitForWorkspace(hit('project', 'ws-OTHER'), undefined)).toBe(true);
    expect(keepUserPoolHitForWorkspace(hit('project', 'ws-OTHER'), '')).toBe(true);
  });
});
