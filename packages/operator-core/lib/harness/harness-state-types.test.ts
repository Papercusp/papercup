import { describe, expect, it } from 'vitest';
import {
  HARNESS_STATES,
  HARNESS_STATE_FORWARD,
  SUB_HARNESS_SLUG_SEP,
  attemptHarnessTransition,
  composeSubHarnessSlug,
  defaultStateForEntry,
  isCupboardListable,
  isLegalHarnessTransition,
  isSubHarnessSlug,
  parseSubHarnessSlug,
  requiresGithubAuth,
  requiresHyperbee,
  requiresUserBranch,
  rootSlugOf,
} from './harness-state-types';

describe('constants', () => {
  it('HARNESS_STATES has 3 values', () => {
    expect([...HARNESS_STATES]).toEqual(['private', 'shared-private', 'shared-public']);
  });

  it('SUB_HARNESS_SLUG_SEP is "/"', () => {
    expect(SUB_HARNESS_SLUG_SEP).toBe('/');
  });

  it('HARNESS_STATE_FORWARD encodes line 319-320 transitions', () => {
    expect(HARNESS_STATE_FORWARD.private.has('shared-private')).toBe(true);
    expect(HARNESS_STATE_FORWARD['shared-private'].has('shared-public')).toBe(true);
    expect(HARNESS_STATE_FORWARD['shared-public'].has('shared-private')).toBe(true);
    expect(HARNESS_STATE_FORWARD.private.has('shared-public')).toBe(false);
    expect(HARNESS_STATE_FORWARD['shared-private'].has('private')).toBe(false);
    expect(HARNESS_STATE_FORWARD['shared-public'].has('private')).toBe(false);
  });
});

describe('isLegalHarnessTransition', () => {
  it('private → shared-private', () => {
    expect(isLegalHarnessTransition('private', 'shared-private')).toBe(true);
  });

  it('shared-private ↔ shared-public', () => {
    expect(isLegalHarnessTransition('shared-private', 'shared-public')).toBe(true);
    expect(isLegalHarnessTransition('shared-public', 'shared-private')).toBe(true);
  });

  it('private cannot skip to shared-public', () => {
    expect(isLegalHarnessTransition('private', 'shared-public')).toBe(false);
  });

  it('shared-* → private NOT allowed (peer-stranding guard)', () => {
    expect(isLegalHarnessTransition('shared-private', 'private')).toBe(false);
    expect(isLegalHarnessTransition('shared-public', 'private')).toBe(false);
  });
});

describe('attemptHarnessTransition', () => {
  it('ok for same-state no-op', () => {
    expect(attemptHarnessTransition({ from: 'private', to: 'private' })).toEqual({ kind: 'ok' });
  });

  it('requires_wizard for private → shared-private', () => {
    const r = attemptHarnessTransition({ from: 'private', to: 'shared-private' });
    expect(r.kind).toBe('requires_wizard');
    if (r.kind === 'requires_wizard') {
      expect(r.from).toBe('private');
      expect(r.to).toBe('shared-private');
    }
  });

  it('ok for shared-private → shared-public', () => {
    expect(
      attemptHarnessTransition({ from: 'shared-private', to: 'shared-public' }),
    ).toEqual({ kind: 'ok' });
  });

  it('ok for shared-public → shared-private', () => {
    expect(
      attemptHarnessTransition({ from: 'shared-public', to: 'shared-private' }),
    ).toEqual({ kind: 'ok' });
  });

  it('requires_unpublish for shared-public → private', () => {
    const r = attemptHarnessTransition({ from: 'shared-public', to: 'private' });
    expect(r.kind).toBe('requires_unpublish');
    if (r.kind === 'requires_unpublish') {
      expect(r.from).toBe('shared-public');
    }
  });

  it('illegal for shared-private → private + private → shared-public skip', () => {
    expect(
      attemptHarnessTransition({ from: 'shared-private', to: 'private' }).kind,
    ).toBe('illegal');
    expect(
      attemptHarnessTransition({ from: 'private', to: 'shared-public' }).kind,
    ).toBe('illegal');
  });
});

describe('requiresHyperbee / requiresUserBranch / requiresGithubAuth', () => {
  it('false for private + true for shared-*', () => {
    expect(requiresHyperbee('private')).toBe(false);
    expect(requiresHyperbee('shared-private')).toBe(true);
    expect(requiresHyperbee('shared-public')).toBe(true);

    expect(requiresUserBranch('private')).toBe(false);
    expect(requiresUserBranch('shared-private')).toBe(true);
    expect(requiresUserBranch('shared-public')).toBe(true);

    expect(requiresGithubAuth('private')).toBe(false);
    expect(requiresGithubAuth('shared-private')).toBe(true);
    expect(requiresGithubAuth('shared-public')).toBe(true);
  });
});

describe('isCupboardListable', () => {
  it('true only for shared-public', () => {
    expect(isCupboardListable('shared-public')).toBe(true);
    expect(isCupboardListable('shared-private')).toBe(false);
    expect(isCupboardListable('private')).toBe(false);
  });
});

describe('defaultStateForEntry', () => {
  it('entry_1_init + entry_3_existing_folder → private', () => {
    expect(defaultStateForEntry('entry_1_init')).toBe('private');
    expect(defaultStateForEntry('entry_3_existing_folder')).toBe('private');
  });

  it('entry_2_github_url → shared-private (D-025)', () => {
    expect(defaultStateForEntry('entry_2_github_url')).toBe('shared-private');
  });

  it('entry_4_harness_link → null (inherits from binding)', () => {
    expect(defaultStateForEntry('entry_4_harness_link')).toBeNull();
  });
});

describe('composeSubHarnessSlug', () => {
  it('joins root + sub with /', () => {
    expect(composeSubHarnessSlug('papercup', 'libs/sync')).toBe('papercup/libs/sync');
  });

  it('strips leading + trailing slashes from sub', () => {
    expect(composeSubHarnessSlug('papercup', '/libs/sync/')).toBe('papercup/libs/sync');
  });

  it('rejects empty inputs', () => {
    expect(() => composeSubHarnessSlug('', 'sub')).toThrow(TypeError);
    expect(() => composeSubHarnessSlug('root', '')).toThrow(TypeError);
    expect(() => composeSubHarnessSlug('root', '///')).toThrow(TypeError);
  });

  it('rejects root with slash (must be flat)', () => {
    expect(() => composeSubHarnessSlug('root/with/slash', 'sub')).toThrow(TypeError);
  });
});

describe('parseSubHarnessSlug', () => {
  it('parses canonical sub-harness slug', () => {
    expect(parseSubHarnessSlug('papercup/libs/sync')).toEqual({
      rootSlug: 'papercup',
      subPath: 'libs/sync',
    });
  });

  it('parses single-level sub', () => {
    expect(parseSubHarnessSlug('papercup/libs')).toEqual({
      rootSlug: 'papercup',
      subPath: 'libs',
    });
  });

  it('returns null for plain root slug', () => {
    expect(parseSubHarnessSlug('papercup')).toBeNull();
  });

  it('returns null for malformed', () => {
    expect(parseSubHarnessSlug('/papercup/libs')).toBeNull();
    expect(parseSubHarnessSlug('papercup/')).toBeNull();
    expect(parseSubHarnessSlug('')).toBeNull();
  });

  it('round-trips with composeSubHarnessSlug', () => {
    const slug = composeSubHarnessSlug('papercup', 'libs/sync');
    expect(parseSubHarnessSlug(slug)).toEqual({
      rootSlug: 'papercup',
      subPath: 'libs/sync',
    });
  });
});

describe('isSubHarnessSlug', () => {
  it('true for slug with /', () => {
    expect(isSubHarnessSlug('papercup/libs')).toBe(true);
    expect(isSubHarnessSlug('papercup/libs/sync')).toBe(true);
  });

  it('false for plain root slug', () => {
    expect(isSubHarnessSlug('papercup')).toBe(false);
  });
});

describe('rootSlugOf', () => {
  it('returns root for sub-harness slug', () => {
    expect(rootSlugOf('papercup/libs/sync')).toBe('papercup');
  });

  it('returns identity for plain root slug', () => {
    expect(rootSlugOf('papercup')).toBe('papercup');
  });
});
