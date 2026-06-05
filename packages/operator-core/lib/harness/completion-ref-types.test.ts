import { describe, expect, it } from 'vitest';
import {
  COMPLETION_REF_SCHEMA_VERSION,
  buildCompletionRef,
  composeCompletionRefKey,
  isCompletionRef,
  isDirectMainPush,
  isSameCompletion,
  isValidCommitSha,
  isValidPrUrl,
  type CompletionRef,
} from './completion-ref-types';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function makeRef(over: Partial<CompletionRef> = {}): CompletionRef {
  return {
    remote: 'git@github.com:x/y.git',
    branch: 'user/12345',
    commit_sha: SHA1,
    pr_url: 'https://github.com/x/y/pull/42',
    schema_version: 1,
    ...over,
  };
}

describe('COMPLETION_REF_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(COMPLETION_REF_SCHEMA_VERSION).toBe(1);
  });
});

describe('isValidCommitSha', () => {
  it('accepts 40-char lowercase hex (SHA-1)', () => {
    expect(isValidCommitSha(SHA1)).toBe(true);
    expect(isValidCommitSha('0123456789abcdef'.repeat(2) + '01234567')).toBe(true);
  });

  it('accepts 64-char lowercase hex (SHA-256)', () => {
    expect(isValidCommitSha(SHA256)).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidCommitSha('a'.repeat(39))).toBe(false);
    expect(isValidCommitSha('a'.repeat(41))).toBe(false);
    expect(isValidCommitSha('a'.repeat(63))).toBe(false);
    expect(isValidCommitSha('a'.repeat(65))).toBe(false);
    expect(isValidCommitSha('')).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(isValidCommitSha('A'.repeat(40))).toBe(false);
  });

  it('rejects non-hex chars', () => {
    expect(isValidCommitSha('g'.repeat(40))).toBe(false);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error
    expect(isValidCommitSha(null)).toBe(false);
    // @ts-expect-error
    expect(isValidCommitSha(42)).toBe(false);
  });
});

describe('isValidPrUrl', () => {
  it('accepts empty (direct-to-main push)', () => {
    expect(isValidPrUrl('')).toBe(true);
  });

  it('accepts http(s) URLs', () => {
    expect(isValidPrUrl('https://github.com/x/y/pull/1')).toBe(true);
    expect(isValidPrUrl('http://localhost:3000/p/1')).toBe(true);
  });

  it('rejects non-http schemes', () => {
    expect(isValidPrUrl('ftp://example.com')).toBe(false);
    expect(isValidPrUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isValidPrUrl('not a url')).toBe(false);
    expect(isValidPrUrl('//missing-scheme')).toBe(false);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error
    expect(isValidPrUrl(null)).toBe(false);
    // @ts-expect-error
    expect(isValidPrUrl(42)).toBe(false);
  });
});

describe('isCompletionRef', () => {
  it('accepts well-formed refs', () => {
    expect(isCompletionRef(makeRef())).toBe(true);
    expect(isCompletionRef(makeRef({ commit_sha: SHA256 }))).toBe(true);
    expect(isCompletionRef(makeRef({ pr_url: '' }))).toBe(true);
  });

  it('rejects empty required strings', () => {
    expect(isCompletionRef(makeRef({ remote: '' }))).toBe(false);
    expect(isCompletionRef(makeRef({ branch: '' }))).toBe(false);
  });

  it('rejects bad commit_sha', () => {
    expect(isCompletionRef(makeRef({ commit_sha: 'short' }))).toBe(false);
    expect(isCompletionRef(makeRef({ commit_sha: 'A'.repeat(40) }))).toBe(false);
  });

  it('rejects bad pr_url', () => {
    expect(isCompletionRef(makeRef({ pr_url: 'not a url' }))).toBe(false);
    expect(isCompletionRef(makeRef({ pr_url: 'ftp://x.y' }))).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isCompletionRef({ ...makeRef(), schema_version: 2 })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isCompletionRef(null)).toBe(false);
    expect(isCompletionRef('x')).toBe(false);
    expect(isCompletionRef(42)).toBe(false);
  });
});

describe('isDirectMainPush', () => {
  it('true when pr_url is empty', () => {
    expect(isDirectMainPush(makeRef({ pr_url: '' }))).toBe(true);
  });

  it('false when pr_url is set', () => {
    expect(isDirectMainPush(makeRef({ pr_url: 'https://github.com/x/y/pull/1' }))).toBe(false);
  });
});

describe('pr_number (optional)', () => {
  it('accepts ref with pr_number', () => {
    expect(isCompletionRef(makeRef({ pr_number: 42 } as unknown as Partial<CompletionRef>))).toBe(true);
  });

  it('rejects non-positive pr_number when present', () => {
    expect(isCompletionRef({ ...makeRef(), pr_number: 0 })).toBe(false);
    expect(isCompletionRef({ ...makeRef(), pr_number: -1 })).toBe(false);
    expect(isCompletionRef({ ...makeRef(), pr_number: 1.5 })).toBe(false);
  });

  it('accepts ref without pr_number (v5 line 451 omits)', () => {
    const r: CompletionRef = makeRef();
    delete (r as Partial<CompletionRef>).pr_number;
    expect(isCompletionRef(r)).toBe(true);
  });
});

describe('buildCompletionRef', () => {
  it('builds with required fields + default empty pr_url', () => {
    const ref = buildCompletionRef({
      remote: 'git@github.com:x/y.git',
      branch: 'feature/x',
      commit_sha: SHA1,
    });
    expect(ref.pr_url).toBe('');
    expect(ref.schema_version).toBe(1);
  });

  it('builds with explicit pr_url', () => {
    const ref = buildCompletionRef({
      remote: 'r',
      branch: 'b',
      commit_sha: SHA1,
      pr_url: 'https://github.com/x/y/pull/1',
    });
    expect(ref.pr_url).toBe('https://github.com/x/y/pull/1');
  });

  it('builds with pr_number when supplied', () => {
    const ref = buildCompletionRef({
      remote: 'r',
      branch: 'b',
      commit_sha: SHA1,
      pr_url: 'https://github.com/x/y/pull/42',
      pr_number: 42,
    });
    expect(ref.pr_number).toBe(42);
  });

  it('omits pr_number when not supplied', () => {
    const ref = buildCompletionRef({
      remote: 'r',
      branch: 'b',
      commit_sha: SHA1,
    });
    expect(ref.pr_number).toBeUndefined();
  });

  it('rejects bad pr_number', () => {
    expect(() =>
      buildCompletionRef({ remote: 'r', branch: 'b', commit_sha: SHA1, pr_number: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      buildCompletionRef({ remote: 'r', branch: 'b', commit_sha: SHA1, pr_number: 1.5 }),
    ).toThrow(TypeError);
  });

  it('rejects bad inputs', () => {
    expect(() =>
      buildCompletionRef({ remote: '', branch: 'b', commit_sha: SHA1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildCompletionRef({ remote: 'r', branch: '', commit_sha: SHA1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildCompletionRef({ remote: 'r', branch: 'b', commit_sha: 'short' }),
    ).toThrow(TypeError);
    expect(() =>
      buildCompletionRef({ remote: 'r', branch: 'b', commit_sha: SHA1, pr_url: 'not a url' }),
    ).toThrow(TypeError);
  });

  it('round-trips through isCompletionRef', () => {
    const ref = buildCompletionRef({ remote: 'r', branch: 'b', commit_sha: SHA1 });
    expect(isCompletionRef(ref)).toBe(true);
  });
});

describe('composeCompletionRefKey', () => {
  it('combines branch + commit_sha first 7 chars', () => {
    const ref = makeRef({ branch: 'user/12345', commit_sha: 'abcdef0123456789' + 'a'.repeat(24) });
    expect(composeCompletionRefKey(ref)).toBe('user/12345@abcdef0');
  });
});

describe('isSameCompletion', () => {
  it('compares on (remote, branch, commit_sha)', () => {
    const a = makeRef();
    const b = makeRef();
    expect(isSameCompletion(a, b)).toBe(true);
  });

  it('returns false when remote differs', () => {
    expect(isSameCompletion(makeRef({ remote: 'a' }), makeRef({ remote: 'b' }))).toBe(false);
  });

  it('returns false when branch differs', () => {
    expect(isSameCompletion(makeRef({ branch: 'a' }), makeRef({ branch: 'b' }))).toBe(false);
  });

  it('returns false when commit_sha differs', () => {
    expect(isSameCompletion(makeRef({ commit_sha: SHA1 }), makeRef({ commit_sha: SHA256 }))).toBe(false);
  });

  it('ignores pr_url (it is descriptive metadata)', () => {
    expect(
      isSameCompletion(
        makeRef({ pr_url: 'https://x/1' }),
        makeRef({ pr_url: 'https://x/2' }),
      ),
    ).toBe(true);
  });
});
