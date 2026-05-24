import { describe, it, expect } from 'vitest';
import { parseHarnessLink, formatHarnessLink } from '../url-scheme';

const VALID_TOPIC = 'a'.repeat(64);
const VALID_GITHUB = 'myorg/myrepo';
const VALID_REPO_ID = '12345';
const VALID_URL = `papercusp://harness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}&repo_id=${VALID_REPO_ID}`;

describe('parseHarnessLink', () => {
  it('parses a valid link', () => {
    const result = parseHarnessLink(VALID_URL);
    expect(result).toEqual({
      topic: VALID_TOPIC,
      github: VALID_GITHUB,
      repoOwner: 'myorg',
      repoName: 'myrepo',
      repoId: 12345,
    });
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error intentional
    expect(parseHarnessLink(null)).toBeNull();
    // @ts-expect-error intentional
    expect(parseHarnessLink(42)).toBeNull();
  });

  it('returns null when protocol is wrong', () => {
    expect(parseHarnessLink(VALID_URL.replace('papercusp://', 'https://'))).toBeNull();
    expect(parseHarnessLink(VALID_URL.replace('papercusp://', 'http://'))).toBeNull();
  });

  it('returns null when host is wrong', () => {
    expect(
      parseHarnessLink(`papercusp://notharness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
  });

  it('returns null when there are extra params', () => {
    expect(parseHarnessLink(VALID_URL + '&extra=foo')).toBeNull();
  });

  it('returns null when topic is too short', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=abc123&github=${VALID_GITHUB}&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
  });

  it('returns null when topic contains uppercase hex', () => {
    const upperTopic = 'A'.repeat(64);
    expect(
      parseHarnessLink(`papercusp://harness?topic=${upperTopic}&github=${VALID_GITHUB}&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
  });

  it('returns null when github param is missing slash', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=noslash&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
  });

  it('returns null when github param has extra slash', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=org/repo/extra&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
  });

  it('returns null when repo_id is not numeric', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}&repo_id=abc`),
    ).toBeNull();
  });

  it('returns null when repo_id is zero', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}&repo_id=0`),
    ).toBeNull();
  });

  it('returns null when repo_id is negative', () => {
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}&repo_id=-5`),
    ).toBeNull();
  });

  it('returns null when a required param is missing', () => {
    expect(
      parseHarnessLink(`papercusp://harness?github=${VALID_GITHUB}&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&repo_id=${VALID_REPO_ID}`),
    ).toBeNull();
    expect(
      parseHarnessLink(`papercusp://harness?topic=${VALID_TOPIC}&github=${VALID_GITHUB}`),
    ).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseHarnessLink('')).toBeNull();
  });

  it('accepts hyphens and underscores in owner/repo', () => {
    const url = `papercusp://harness?topic=${VALID_TOPIC}&github=my-org/my_repo&repo_id=${VALID_REPO_ID}`;
    const result = parseHarnessLink(url);
    expect(result).not.toBeNull();
    expect(result?.repoOwner).toBe('my-org');
    expect(result?.repoName).toBe('my_repo');
  });
});

describe('formatHarnessLink', () => {
  it('round-trips through parseHarnessLink', () => {
    const link = {
      topic: VALID_TOPIC,
      github: VALID_GITHUB,
      repoOwner: 'myorg',
      repoName: 'myrepo',
      repoId: 12345,
    };
    const url = formatHarnessLink(link);
    expect(parseHarnessLink(url)).toEqual(link);
  });
});
