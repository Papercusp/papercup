import { describe, expect, it } from 'vitest';
import {
  PR_CHECKS_STATES,
  PR_HOST_ERROR_KINDS,
  PR_HOST_KINDS,
  PR_MERGEABLE_STATES,
  PR_MERGE_METHODS,
  PR_REVIEW_DECISIONS,
  PR_REVIEW_EVENTS,
  PR_STATES,
  composePrKey,
  err,
  isAuthError,
  isGoneError,
  isRetryableError,
  ok,
  parsePrKey,
  statusToErrorKind,
  type PrHostError,
  type PrRef,
} from './types';

describe('enum tuples', () => {
  it('PR_STATES has the 4 canonical states', () => {
    expect([...PR_STATES]).toEqual(['open', 'merged', 'closed', 'gone']);
  });

  it('PR_REVIEW_DECISIONS has the 4 GitHub decisions', () => {
    expect([...PR_REVIEW_DECISIONS]).toEqual([
      'none',
      'approved',
      'changes_requested',
      'commented',
    ]);
  });

  it('PR_CHECKS_STATES has 6 states including unknown', () => {
    expect(PR_CHECKS_STATES.length).toBe(6);
    expect([...PR_CHECKS_STATES]).toContain('unknown');
    expect([...PR_CHECKS_STATES]).toContain('success');
    expect([...PR_CHECKS_STATES]).toContain('failure');
  });

  it('PR_MERGEABLE_STATES has 3 collapsed states', () => {
    expect([...PR_MERGEABLE_STATES]).toEqual(['mergeable', 'not_mergeable', 'unknown']);
  });

  it('PR_MERGE_METHODS has squash, merge, rebase with squash first (v1 default)', () => {
    expect(PR_MERGE_METHODS[0]).toBe('squash');
    expect([...PR_MERGE_METHODS]).toEqual(['squash', 'merge', 'rebase']);
  });

  it('PR_HOST_KINDS includes github + reserved slots for v2+', () => {
    expect([...PR_HOST_KINDS]).toContain('github');
    expect([...PR_HOST_KINDS]).toContain('gitlab');
    expect([...PR_HOST_KINDS]).toContain('gitea');
    expect([...PR_HOST_KINDS]).toContain('bitbucket');
  });

  it('PR_REVIEW_EVENTS has 3 events matching GitHub naming', () => {
    expect([...PR_REVIEW_EVENTS]).toEqual(['approve', 'request_changes', 'comment']);
  });

  it('PR_HOST_ERROR_KINDS enumerates the 9 audit-M variants', () => {
    expect(PR_HOST_ERROR_KINDS.length).toBe(9);
    for (const k of [
      'not_found',
      'unauthorized',
      'forbidden',
      'rate_limited',
      'conflict',
      'validation',
      'server_error',
      'network_error',
      'unsupported',
    ]) {
      expect([...PR_HOST_ERROR_KINDS]).toContain(k);
    }
  });
});

describe('ok / err helpers', () => {
  it('ok wraps data in an ok=true envelope', () => {
    const r = ok({ x: 1 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ x: 1 });
  });

  it('err wraps error in an ok=false envelope', () => {
    const e: PrHostError = { kind: 'not_found', message: 'gone' };
    const r = err(e);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toEqual(e);
  });
});

describe('isRetryableError', () => {
  it('returns true for transient errors', () => {
    expect(isRetryableError({ kind: 'rate_limited', message: 'x' })).toBe(true);
    expect(isRetryableError({ kind: 'server_error', message: 'x' })).toBe(true);
    expect(isRetryableError({ kind: 'network_error', message: 'x' })).toBe(true);
  });

  it('returns false for terminal errors', () => {
    expect(isRetryableError({ kind: 'not_found', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'unauthorized', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'forbidden', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'conflict', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'validation', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'unsupported', message: 'x' })).toBe(false);
  });
});

describe('isAuthError', () => {
  it('discriminates 401 specifically', () => {
    expect(isAuthError({ kind: 'unauthorized', message: 'x' })).toBe(true);
    expect(isAuthError({ kind: 'forbidden', message: 'x' })).toBe(false);
    expect(isAuthError({ kind: 'rate_limited', message: 'x' })).toBe(false);
  });
});

describe('isGoneError', () => {
  it('discriminates 404 for the P-042f demote-to-gone path', () => {
    expect(isGoneError({ kind: 'not_found', message: 'x' })).toBe(true);
    expect(isGoneError({ kind: 'forbidden', message: 'x' })).toBe(false);
    expect(isGoneError({ kind: 'server_error', message: 'x' })).toBe(false);
  });
});

describe('statusToErrorKind', () => {
  it('maps common HTTP statuses', () => {
    expect(statusToErrorKind(401)).toBe('unauthorized');
    expect(statusToErrorKind(403)).toBe('forbidden');
    expect(statusToErrorKind(404)).toBe('not_found');
    expect(statusToErrorKind(409)).toBe('conflict');
    expect(statusToErrorKind(422)).toBe('validation');
    expect(statusToErrorKind(429)).toBe('rate_limited');
  });

  it('maps any 5xx to server_error', () => {
    expect(statusToErrorKind(500)).toBe('server_error');
    expect(statusToErrorKind(502)).toBe('server_error');
    expect(statusToErrorKind(503)).toBe('server_error');
    expect(statusToErrorKind(599)).toBe('server_error');
  });

  it('maps unknown statuses to server_error (fail-open for retry)', () => {
    expect(statusToErrorKind(200)).toBe('server_error');
    expect(statusToErrorKind(418)).toBe('server_error');
  });
});

describe('composePrKey / parsePrKey round-trip', () => {
  const ref: PrRef = { remote: 'github.com/papercup-ai/papercup', number: 42 };

  it('round-trips a simple key', () => {
    const key = composePrKey(ref);
    expect(key).toBe('github.com/papercup-ai/papercup#42');
    expect(parsePrKey(key)).toEqual(ref);
  });

  it('handles remotes with multiple # characters in path (uses lastIndexOf)', () => {
    const oddRef: PrRef = { remote: 'ssh://git@host:22/a#b', number: 7 };
    const key = composePrKey(oddRef);
    expect(parsePrKey(key)).toEqual(oddRef);
  });

  it('rejects malformed keys', () => {
    expect(parsePrKey('no-hash')).toBeNull();
    expect(parsePrKey('#1')).toBeNull();
    expect(parsePrKey('remote#')).toBeNull();
    expect(parsePrKey('remote#abc')).toBeNull();
    expect(parsePrKey('remote#0')).toBeNull();
    expect(parsePrKey('remote#-1')).toBeNull();
    expect(parsePrKey('')).toBeNull();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error
    expect(parsePrKey(null)).toBeNull();
    // @ts-expect-error
    expect(parsePrKey(undefined)).toBeNull();
    // @ts-expect-error
    expect(parsePrKey(42)).toBeNull();
  });
});
