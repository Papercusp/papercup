import { describe, expect, it } from 'vitest';
import {
  BINDING_CACHE_TTL_MS,
  BindingServiceErrorThrowable,
  parseGithubRepoUrl,
} from './binding-service';

describe('BINDING_CACHE_TTL_MS', () => {
  it('is 24h per memo', () => {
    expect(BINDING_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('parseGithubRepoUrl', () => {
  it('parses canonical https URL', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses .git suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses trailing slash', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses ssh URL', () => {
    expect(parseGithubRepoUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('parses http (not just https)', () => {
    expect(parseGithubRepoUrl('http://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('rejects non-github URLs', () => {
    expect(parseGithubRepoUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubRepoUrl('https://example.com/x')).toBeNull();
  });

  it('rejects malformed inputs', () => {
    expect(parseGithubRepoUrl('not a url')).toBeNull();
    expect(parseGithubRepoUrl('')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/onlyone')).toBeNull();
  });

  it('rejects non-string', () => {
    // @ts-expect-error
    expect(parseGithubRepoUrl(null)).toBeNull();
    // @ts-expect-error
    expect(parseGithubRepoUrl(42)).toBeNull();
  });
});

describe('BindingServiceErrorThrowable', () => {
  it('carries the typed error', () => {
    const err = new BindingServiceErrorThrowable({
      code: 'BINDING_NOT_FOUND',
    });
    expect(err.error.code).toBe('BINDING_NOT_FOUND');
    expect(err.name).toBe('BindingServiceErrorThrowable');
    expect(err.message).toBe('BINDING_NOT_FOUND');
  });

  it('preserves discriminated extras', () => {
    const err = new BindingServiceErrorThrowable({
      code: 'CLAIM_PERMISSION_DENIED',
      actual: 'write',
      required: 'maintain or admin',
    });
    expect(err.error.code).toBe('CLAIM_PERMISSION_DENIED');
    if (err.error.code === 'CLAIM_PERMISSION_DENIED') {
      expect(err.error.actual).toBe('write');
      expect(err.error.required).toBe('maintain or admin');
    }
  });

  it('is a real Error subclass (instanceof works)', () => {
    const err = new BindingServiceErrorThrowable({ code: 'BINDING_NOT_FOUND' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BindingServiceErrorThrowable);
  });
});
