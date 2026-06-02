/**
 * Contributor-usage route — pure query-param validator tests. The handler wraps
 * `rollupForContributor` (covered in usage-events.test.ts) + getOrgPg; here we
 * test `parseGithubUserIdParam`, the piece most likely to regress.
 */
import { describe, expect, it } from 'vitest';
import { parseGithubUserIdParam } from '../contributor-usage';

describe('parseGithubUserIdParam', () => {
  it('accepts a positive integer', () => {
    expect(parseGithubUserIdParam('42')).toEqual({ ok: true, github_user_id: 42 });
  });

  it('rejects a missing param', () => {
    expect(parseGithubUserIdParam(null).ok).toBe(false);
    expect(parseGithubUserIdParam('').ok).toBe(false);
  });

  it('rejects a non-numeric param', () => {
    expect(parseGithubUserIdParam('octocat').ok).toBe(false);
  });

  it('rejects zero and negatives', () => {
    expect(parseGithubUserIdParam('0').ok).toBe(false);
    expect(parseGithubUserIdParam('-5').ok).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(parseGithubUserIdParam('4.2').ok).toBe(false);
  });
});
