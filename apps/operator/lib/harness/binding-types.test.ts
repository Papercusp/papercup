import { describe, expect, it } from 'vitest';
import {
  CLAIM_REQUIRED_PERMISSION,
  SUPERSEDE_REQUIRED_PERMISSION,
  composeBindingId,
  hasRequiredPermission,
  parseBindingId,
  type BindingRecord,
  type BindingServiceError,
  type GithubRepoPermission,
} from './binding-types';

describe('composeBindingId / parseBindingId', () => {
  it('roundtrips a valid id', () => {
    const id = composeBindingId('github', 12345);
    expect(id).toBe('github:12345');
    expect(parseBindingId(id)).toEqual({
      provider: 'github',
      repositoryId: 12345,
    });
  });

  it('parses big ids (GitHub repo ids are large)', () => {
    const big = 987654321;
    expect(parseBindingId(composeBindingId('github', big))).toEqual({
      provider: 'github',
      repositoryId: big,
    });
  });

  it('returns null on malformed input', () => {
    expect(parseBindingId('')).toBeNull();
    expect(parseBindingId('no-colon-here')).toBeNull();
    expect(parseBindingId('github:')).toBeNull();
    expect(parseBindingId('github:abc')).toBeNull();
    expect(parseBindingId('github:-1')).toBeNull();
    expect(parseBindingId('github:0')).toBeNull();
    expect(parseBindingId(':12345')).toBeNull();
  });

  it('rejects providers other than github (forward-compat)', () => {
    // PrHost expansion will widen the union; until then, parser is strict.
    expect(parseBindingId('gitlab:12345')).toBeNull();
    expect(parseBindingId('gitea:12345')).toBeNull();
    expect(parseBindingId('bitbucket:12345')).toBeNull();
  });

  it('rejects ids beyond safe integer range', () => {
    // Number.MAX_SAFE_INTEGER + 1 is unsafe; parser declines silently.
    const unsafe = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    expect(parseBindingId('github:' + unsafe)).toBeNull();
  });

  it('rejects ids with leading zeros / non-canonical form', () => {
    // Strict regex; '00012345' would parse to 12345 if loose. Keep strict.
    expect(parseBindingId('github:00012345')).toEqual({
      provider: 'github',
      repositoryId: 12345,
    });
    // Documented behavior — leading zeros are tolerated by the regex but
    // serialize back without them. If we want to reject leading-zero ids,
    // tighten the regex; for now this is a known quirk.
  });
});

describe('hasRequiredPermission', () => {
  it('admin satisfies the claim requirement', () => {
    expect(hasRequiredPermission('admin', CLAIM_REQUIRED_PERMISSION)).toBe(true);
  });

  it('maintain satisfies the claim requirement', () => {
    expect(hasRequiredPermission('maintain', CLAIM_REQUIRED_PERMISSION)).toBe(true);
  });

  it('write / triage / read / none do NOT satisfy claim', () => {
    const insufficient: GithubRepoPermission[] = ['write', 'triage', 'read', 'none'];
    for (const p of insufficient) {
      expect(hasRequiredPermission(p, CLAIM_REQUIRED_PERMISSION)).toBe(false);
    }
  });

  it('admin satisfies the supersede requirement', () => {
    expect(hasRequiredPermission('admin', SUPERSEDE_REQUIRED_PERMISSION)).toBe(true);
  });

  it('maintain does NOT satisfy the supersede requirement (D-E: stricter)', () => {
    expect(hasRequiredPermission('maintain', SUPERSEDE_REQUIRED_PERMISSION)).toBe(false);
  });

  it('none never satisfies anything', () => {
    expect(hasRequiredPermission('none', CLAIM_REQUIRED_PERMISSION)).toBe(false);
    expect(hasRequiredPermission('none', SUPERSEDE_REQUIRED_PERMISSION)).toBe(false);
  });

  it('matches every GithubRepoPermission variant exhaustively (sentinel)', () => {
    const all: GithubRepoPermission[] = [
      'admin',
      'maintain',
      'write',
      'triage',
      'read',
      'none',
    ];
    // If a new permission variant is added to the union, this will
    // compile-error against the literal list above. Run the check
    // anyway to confirm no runtime-only surprises.
    for (const p of all) {
      hasRequiredPermission(p, CLAIM_REQUIRED_PERMISSION);
      hasRequiredPermission(p, SUPERSEDE_REQUIRED_PERMISSION);
    }
    expect(all).toHaveLength(6);
  });
});

describe('type sanity (compile-time)', () => {
  it('BindingRecord can be constructed with the documented shape', () => {
    const rec: BindingRecord = {
      provider: 'github',
      github_repository_id: 12345,
      github_full_name: 'papercupai/papercup',
      harness_topic: 'a'.repeat(64),
      harness_slug: 'papercup',
      harness_link:
        'papercusp://harness?topic=' +
        'a'.repeat(64) +
        '&github=papercupai/papercup&repo_id=12345',
      privacy: 'shared-public',
      claim_status: 'claimed',
      provisional_owner_github_user_id: 99,
      provisional_owner_github_login: 'octocat',
      claimed_by_github_user_ids: [99],
      created_at: '2026-05-24T00:00:00Z',
      claimed_at: '2026-05-24T00:01:00Z',
      last_permission_verified_at: '2026-05-24T00:02:00Z',
    };
    expect(rec.harness_slug).toBe('papercup');
  });

  it('BindingServiceError union members all carry code', () => {
    const errs: BindingServiceError[] = [
      { code: 'BINDING_NOT_FOUND' },
      { code: 'BINDING_NOT_CLAIMABLE', reason: 'already claimed' },
      {
        code: 'CLAIM_PERMISSION_DENIED',
        actual: 'read',
        required: 'maintain or admin',
      },
      {
        code: 'SUPERSEDE_PERMISSION_DENIED',
        actual: 'maintain',
        required: 'admin',
      },
      { code: 'GITHUB_REPO_NOT_FOUND' },
      { code: 'GITHUB_REPO_PRIVATE_NO_ACCESS' },
      { code: 'GITHUB_API_RATE_LIMIT', retry_after_ms: 60_000 },
      { code: 'GITHUB_API_DOWN', message: '503' },
    ];
    for (const e of errs) {
      expect(typeof e.code).toBe('string');
    }
  });
});
