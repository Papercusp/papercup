/**
 * clone-url.test.ts — pure clone-URL builder + token redaction.
 *
 * Part of non-collaborator-join-fork-pr sub-project B4 (authed clone for
 * private upstreams): a joiner with read access clones via a token-embedded
 * HTTPS URL; the token must never leak into error messages or the cloned
 * repo's persisted `.git/config` remote.
 */

import { describe, it, expect } from 'vitest';
import { buildCloneUrl, cleanCloneUrl, redactToken } from './clone-url';

describe('buildCloneUrl', () => {
  it('embeds the token for authenticated (private-repo read) clone', () => {
    expect(buildCloneUrl('owner/repo', 'ghs_secret')).toBe(
      'https://x-access-token:ghs_secret@github.com/owner/repo.git',
    );
  });

  it('returns an anonymous URL when no token is given', () => {
    expect(buildCloneUrl('owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('normalizes a trailing .git in the input full name', () => {
    expect(buildCloneUrl('owner/repo.git', 'tok')).toBe(
      'https://x-access-token:tok@github.com/owner/repo.git',
    );
    expect(buildCloneUrl('owner/repo.git')).toBe('https://github.com/owner/repo');
  });
});

describe('cleanCloneUrl', () => {
  it('is the token-free URL that should be persisted as origin', () => {
    expect(cleanCloneUrl('owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(cleanCloneUrl('owner/repo.git')).toBe('https://github.com/owner/repo.git');
  });
});

describe('redactToken', () => {
  it('masks an embedded x-access-token in an error message', () => {
    const msg =
      "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/owner/repo.git/'";
    const out = redactToken(msg);
    expect(out).not.toContain('ghs_secret');
    expect(out).toContain('x-access-token:***@');
  });

  it('leaves token-free text unchanged', () => {
    expect(redactToken('fatal: repository not found')).toBe('fatal: repository not found');
  });
});
