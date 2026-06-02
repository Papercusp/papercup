import { describe, expect, it } from 'vitest';
import { normalizeViewer, isViewer } from './useViewer';

describe('normalizeViewer', () => {
  it('maps a valid /api/viewer payload', () => {
    expect(normalizeViewer({ github_user_id: 1567022, github_login: 'aviynw' })).toEqual({
      githubUserId: 1567022,
      githubLogin: 'aviynw',
    });
  });
  it('maps anonymous nulls', () => {
    expect(normalizeViewer({ github_user_id: null, github_login: null })).toEqual({
      githubUserId: null,
      githubLogin: null,
    });
  });
  it('rejects non-positive / non-number ids + empty login', () => {
    expect(normalizeViewer({ github_user_id: 0, github_login: '' })).toEqual({ githubUserId: null, githubLogin: null });
    expect(normalizeViewer({ github_user_id: '7', github_login: 7 })).toEqual({ githubUserId: null, githubLogin: null });
  });
  it('defends against garbage', () => {
    expect(normalizeViewer(null)).toEqual({ githubUserId: null, githubLogin: null });
    expect(normalizeViewer('nope')).toEqual({ githubUserId: null, githubLogin: null });
    expect(normalizeViewer(undefined)).toEqual({ githubUserId: null, githubLogin: null });
  });
});

describe('isViewer', () => {
  it('true only when the viewer id matches', () => {
    const v = { githubUserId: 42, githubLogin: 'alice' };
    expect(isViewer(v, 42)).toBe(true);
    expect(isViewer(v, 43)).toBe(false);
  });
  it('false for anonymous viewer or null target', () => {
    expect(isViewer({ githubUserId: null, githubLogin: null }, 42)).toBe(false);
    expect(isViewer(null, 42)).toBe(false);
    expect(isViewer({ githubUserId: 42, githubLogin: 'a' }, null)).toBe(false);
    expect(isViewer({ githubUserId: 42, githubLogin: 'a' }, undefined)).toBe(false);
  });
});
