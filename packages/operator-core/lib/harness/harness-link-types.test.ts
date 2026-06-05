import { describe, expect, it } from 'vitest';
import {
  HARNESS_LINK_PREFIX,
  HARNESS_LINK_VERSION,
  TOPIC_HEX_LENGTH,
  formatHarnessLink,
  formatParseError,
  isValidTopicHex,
  parseGithubSlug,
  parseHarnessLink,
  type HarnessLinkPayload,
} from './harness-link-types';

const VALID_TOPIC = '0'.repeat(63) + 'a'; // 64 hex chars, lowercase

const VALID_PAYLOAD: HarnessLinkPayload = {
  topic: VALID_TOPIC,
  github_owner: 'papercup-ai',
  github_repo: 'papercup',
  github_repository_id: 123456789,
};

describe('constants', () => {
  it('HARNESS_LINK_PREFIX is papercusp://harness', () => {
    expect(HARNESS_LINK_PREFIX).toBe('papercusp://harness');
  });

  it('HARNESS_LINK_VERSION is 1', () => {
    expect(HARNESS_LINK_VERSION).toBe(1);
  });

  it('TOPIC_HEX_LENGTH is 64 (32 bytes hex-encoded)', () => {
    expect(TOPIC_HEX_LENGTH).toBe(64);
  });
});

describe('isValidTopicHex', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(isValidTopicHex(VALID_TOPIC)).toBe(true);
    expect(isValidTopicHex('a'.repeat(64))).toBe(true);
    expect(isValidTopicHex('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidTopicHex('a'.repeat(63))).toBe(false);
    expect(isValidTopicHex('a'.repeat(65))).toBe(false);
    expect(isValidTopicHex('')).toBe(false);
  });

  it('rejects uppercase hex (case-sensitive: must be lowercase)', () => {
    expect(isValidTopicHex('A'.repeat(64))).toBe(false);
    expect(isValidTopicHex('0123456789ABCDEF'.repeat(4))).toBe(false);
  });

  it('rejects non-hex chars', () => {
    expect(isValidTopicHex('g'.repeat(64))).toBe(false);
    expect(isValidTopicHex('!@#$'.repeat(16))).toBe(false);
  });
});

describe('parseGithubSlug', () => {
  it('accepts a basic slug', () => {
    expect(parseGithubSlug('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('accepts dashes in owner', () => {
    expect(parseGithubSlug('papercup-ai/papercup')).toEqual({
      owner: 'papercup-ai',
      repo: 'papercup',
    });
  });

  it('accepts allowed punctuation in repo', () => {
    expect(parseGithubSlug('a/repo_name.json-ext')).not.toBeNull();
  });

  it('rejects underscores in owner (GitHub login rule)', () => {
    expect(parseGithubSlug('user_name/repo')).toBeNull();
  });

  it('rejects leading/trailing dashes in owner', () => {
    expect(parseGithubSlug('-user/repo')).toBeNull();
    expect(parseGithubSlug('user-/repo')).toBeNull();
  });

  it('rejects double-dash in owner', () => {
    expect(parseGithubSlug('user--name/repo')).toBeNull();
  });

  it('rejects multi-slash paths', () => {
    expect(parseGithubSlug('owner/repo/subdir')).toBeNull();
  });

  it('rejects missing-component slugs', () => {
    expect(parseGithubSlug('/repo')).toBeNull();
    expect(parseGithubSlug('owner/')).toBeNull();
    expect(parseGithubSlug('owner')).toBeNull();
    expect(parseGithubSlug('')).toBeNull();
  });

  it('rejects "." and ".." as repo (filesystem safety)', () => {
    expect(parseGithubSlug('owner/.')).toBeNull();
    expect(parseGithubSlug('owner/..')).toBeNull();
  });
});

describe('formatHarnessLink', () => {
  it('builds the canonical URL form', () => {
    const url = formatHarnessLink(VALID_PAYLOAD);
    expect(url.startsWith(HARNESS_LINK_PREFIX + '?')).toBe(true);
    expect(url).toContain('topic=' + VALID_TOPIC);
    expect(url).toContain('repo_id=123456789');
    // URLSearchParams escapes `/` in `github=owner/repo` to %2F.
    expect(url).toContain('github=papercup-ai%2Fpapercup');
  });

  it('round-trips with parseHarnessLink', () => {
    const url = formatHarnessLink(VALID_PAYLOAD);
    const parsed = parseHarnessLink(url);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.payload).toEqual(VALID_PAYLOAD);
  });

  it('rejects invalid topic at format time', () => {
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, topic: 'too-short' }),
    ).toThrow(TypeError);
  });

  it('rejects invalid GitHub slug at format time', () => {
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, github_owner: '-bad' }),
    ).toThrow(TypeError);
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, github_repo: '..' }),
    ).toThrow(TypeError);
  });

  it('rejects non-positive repo id at format time', () => {
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, github_repository_id: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, github_repository_id: -1 }),
    ).toThrow(TypeError);
    expect(() =>
      formatHarnessLink({ ...VALID_PAYLOAD, github_repository_id: 1.5 }),
    ).toThrow(TypeError);
  });
});

describe('parseHarnessLink', () => {
  it('rejects non-URLs', () => {
    expect(parseHarnessLink('not a url')).toEqual({
      ok: false,
      error: { kind: 'not_a_url' },
    });
    expect(parseHarnessLink('')).toEqual({
      ok: false,
      error: { kind: 'not_a_url' },
    });
    // @ts-expect-error
    expect(parseHarnessLink(null)).toEqual({
      ok: false,
      error: { kind: 'not_a_url' },
    });
  });

  it('rejects wrong scheme', () => {
    const r = parseHarnessLink('https://example.com/?topic=x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.kind).toBe('wrong_scheme');
  });

  it('rejects wrong host', () => {
    const r = parseHarnessLink('papercusp://other?topic=x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.kind).toBe('wrong_host');
  });

  it('rejects missing params', () => {
    const noTopic = parseHarnessLink('papercusp://harness?github=a/b&repo_id=1');
    expect(noTopic.ok === false && noTopic.error.kind).toBe('missing_topic');

    const noGithub = parseHarnessLink('papercusp://harness?topic=' + VALID_TOPIC + '&repo_id=1');
    expect(noGithub.ok === false && noGithub.error.kind).toBe('missing_github');

    const noRepoId = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=a/b',
    );
    expect(noRepoId.ok === false && noRepoId.error.kind).toBe('missing_repo_id');
  });

  it('rejects invalid topic', () => {
    const r = parseHarnessLink(
      'papercusp://harness?topic=xyz&github=a/b&repo_id=1',
    );
    expect(r.ok === false && r.error.kind).toBe('invalid_topic');
  });

  it('rejects invalid github slug', () => {
    const r = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=onlyone&repo_id=1',
    );
    expect(r.ok === false && r.error.kind).toBe('invalid_github_slug');
  });

  it('rejects invalid repo_id', () => {
    const r1 = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=a/b&repo_id=zero',
    );
    expect(r1.ok === false && r1.error.kind).toBe('invalid_repo_id');

    const r2 = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=a/b&repo_id=-1',
    );
    expect(r2.ok === false && r2.error.kind).toBe('invalid_repo_id');
  });

  it('rejects unsupported version', () => {
    const r = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=a/b&repo_id=1&v=99',
    );
    expect(r.ok === false && r.error.kind).toBe('unsupported_version');
  });

  it('accepts v=1 explicit version', () => {
    const r = parseHarnessLink(
      'papercusp://harness?topic=' + VALID_TOPIC + '&github=a/b&repo_id=1&v=1',
    );
    expect(r.ok).toBe(true);
  });
});

describe('formatParseError', () => {
  it('renders each kind to a one-line message', () => {
    expect(formatParseError({ kind: 'not_a_url' })).toContain('harness link');
    expect(formatParseError({ kind: 'wrong_scheme', got: 'https:' })).toContain('https:');
    expect(formatParseError({ kind: 'wrong_host', got: 'other' })).toContain('other');
    expect(formatParseError({ kind: 'missing_topic' })).toContain('topic');
    expect(formatParseError({ kind: 'invalid_topic', got: 'xyz' })).toContain('64-char');
    expect(formatParseError({ kind: 'missing_github' })).toContain('GitHub');
    expect(formatParseError({ kind: 'invalid_github_slug', got: 'bad' })).toContain('bad');
    expect(formatParseError({ kind: 'missing_repo_id' })).toContain('repository');
    expect(formatParseError({ kind: 'invalid_repo_id', got: 'abc' })).toContain('abc');
    expect(formatParseError({ kind: 'unsupported_version', got: '2' })).toContain('newer');
  });
});
