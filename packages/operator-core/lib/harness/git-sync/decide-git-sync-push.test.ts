import { describe, it, expect } from 'vitest';
import { decideGitSyncPush, type PushDecisionInput } from './decide-git-sync-push';

/** Creator-side, upstream-bearing baseline; tests override one axis at a time. */
const base: PushDecisionInput = { joinerSide: false, hasUpstreamRemote: true };

describe('decideGitSyncPush — the five rules', () => {
  it('rule 1: no upstream remote → push false (P-011, fetch-less repo is quiet only with push off)', () => {
    const d = decideGitSyncPush({ ...base, hasUpstreamRemote: false });
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/^no_upstream_remote/);
  });

  it('rule 2: joiner-side clone → push false (read-only; fork-PR contributes)', () => {
    const d = decideGitSyncPush({ ...base, joinerSide: true });
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/^joiner_side/);
  });

  it('rule 3: permissions.push === false → push false', () => {
    const d = decideGitSyncPush({ ...base, permissionsPush: false });
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/^github_permissions_push_false/);
  });

  it('rule 4: permissions.push === true → push true', () => {
    const d = decideGitSyncPush({ ...base, permissionsPush: true });
    expect(d.push).toBe(true);
    expect(d.reason).toMatch(/^github_permissions_push_true/);
  });

  it('rule 5: unknown permissions (null) → optimistic push true (D-002 escalation catches a wrong guess)', () => {
    const d = decideGitSyncPush({ ...base, permissionsPush: null });
    expect(d.push).toBe(true);
    expect(d.reason).toMatch(/^permissions_unknown_optimistic/);
  });

  it('rule 5: unknown permissions (undefined / omitted) → optimistic push true', () => {
    for (const i of [{ ...base, permissionsPush: undefined }, { ...base }]) {
      const d = decideGitSyncPush(i);
      expect(d.push).toBe(true);
      expect(d.reason).toMatch(/^permissions_unknown_optimistic/);
    }
  });
});

describe('decideGitSyncPush — precedence order', () => {
  it('rule 1 beats everything: no upstream wins over creator-side + permissions.push true', () => {
    const d = decideGitSyncPush({ joinerSide: false, hasUpstreamRemote: false, permissionsPush: true });
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/^no_upstream_remote/);
  });

  it('rule 1 beats rule 2: no upstream wins over joiner-side (reason names the remote, not the side)', () => {
    const d = decideGitSyncPush({ joinerSide: true, hasUpstreamRemote: false, permissionsPush: false });
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/^no_upstream_remote/);
  });

  it('rule 2 beats rules 3-5: a joiner stays read-only even when GitHub grants push', () => {
    for (const permissionsPush of [true, false, null, undefined]) {
      const d = decideGitSyncPush({ joinerSide: true, hasUpstreamRemote: true, permissionsPush });
      expect(d.push).toBe(false);
      expect(d.reason).toMatch(/^joiner_side/);
    }
  });

  it('rule 3 beats rule 5 framing: an explicit false is a deny, never "unknown"', () => {
    const d = decideGitSyncPush({ ...base, permissionsPush: false });
    expect(d.reason).not.toMatch(/unknown/);
  });
});

describe('decideGitSyncPush — contract shape', () => {
  it('always returns a non-empty reason with a stable snake_case leading token', () => {
    const inputs: PushDecisionInput[] = [
      { joinerSide: false, hasUpstreamRemote: false },
      { joinerSide: true, hasUpstreamRemote: true },
      { ...base, permissionsPush: false },
      { ...base, permissionsPush: true },
      { ...base, permissionsPush: null },
    ];
    for (const i of inputs) {
      const d = decideGitSyncPush(i);
      expect(typeof d.push).toBe('boolean');
      expect(d.reason).toMatch(/^[a-z_]+ — /);
    }
  });

  it('is pure: same input twice → identical decision', () => {
    const i: PushDecisionInput = { ...base, permissionsPush: null };
    expect(decideGitSyncPush(i)).toEqual(decideGitSyncPush(i));
  });
});
