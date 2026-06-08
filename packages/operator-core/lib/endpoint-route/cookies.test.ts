/**
 * Tests for the Set-Cookie / Cookie helpers used by defineTool handlers.
 * Run with: cd packages/operator-core && npx vitest run lib/endpoint-route/cookies.test.ts
 */
import { describe, expect, it } from 'vitest';
import { serializeSetCookie, serializeDeleteCookie, readCookie } from './cookies';

describe('serializeSetCookie', () => {
  it('emits a bare name=value with no options', () => {
    expect(serializeSetCookie('sid', 'abc')).toBe('sid=abc');
  });

  it('URL-encodes the value', () => {
    expect(serializeSetCookie('t', 'a b/c=d')).toBe('t=a%20b%2Fc%3Dd');
  });

  it('serializes all attributes in a stable order', () => {
    const out = serializeSetCookie('sid', 'v', {
      path: '/',
      domain: 'example.com',
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    expect(out).toBe('sid=v; Path=/; Domain=example.com; Max-Age=3600; HttpOnly; Secure; SameSite=Lax');
  });

  it('floors a fractional Max-Age', () => {
    expect(serializeSetCookie('x', 'y', { maxAge: 12.9 })).toBe('x=y; Max-Age=12');
  });

  it('includes Max-Age=0 (not omitted as falsy)', () => {
    expect(serializeSetCookie('x', 'y', { maxAge: 0 })).toBe('x=y; Max-Age=0');
  });

  it('formats Expires as a UTC string', () => {
    const out = serializeSetCookie('x', 'y', { expires: new Date(0) });
    expect(out).toBe('x=y; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('omits HttpOnly/Secure when false', () => {
    expect(serializeSetCookie('x', 'y', { httpOnly: false, secure: false })).toBe('x=y');
  });

  it('supports SameSite=None', () => {
    expect(serializeSetCookie('x', 'y', { sameSite: 'None' })).toBe('x=y; SameSite=None');
  });
});

describe('serializeDeleteCookie', () => {
  it('emits an expired, empty cookie with the default path', () => {
    expect(serializeDeleteCookie('sid')).toBe('sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0');
  });

  it('honors a custom path', () => {
    expect(serializeDeleteCookie('sid', '/admin')).toBe('sid=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0');
  });
});

describe('readCookie', () => {
  const reqWith = (cookie?: string): Request =>
    new Request('http://localhost/', cookie === undefined ? {} : { headers: { cookie } });

  it('returns undefined when there is no Cookie header', () => {
    expect(readCookie(reqWith(), 'sid')).toBeUndefined();
  });

  it('reads a single cookie', () => {
    expect(readCookie(reqWith('sid=abc'), 'sid')).toBe('abc');
  });

  it('reads one cookie out of several (whitespace-tolerant)', () => {
    expect(readCookie(reqWith('a=1; sid=abc; b=2'), 'sid')).toBe('abc');
  });

  it('URL-decodes the value (round-trips serializeSetCookie)', () => {
    const header = serializeSetCookie('t', 'a b/c=d').split(';')[0];
    expect(readCookie(reqWith(header), 't')).toBe('a b/c=d');
  });

  it('returns undefined for an absent name', () => {
    expect(readCookie(reqWith('a=1; b=2'), 'sid')).toBeUndefined();
  });

  it('skips malformed segments without an =', () => {
    expect(readCookie(reqWith('garbage; sid=ok'), 'sid')).toBe('ok');
  });

  it('does not prefix-match cookie names', () => {
    expect(readCookie(reqWith('session=x'), 'sess')).toBeUndefined();
  });
});
