import { describe, expect, it } from 'vitest';
import routes, { isValidLogin } from '../by-login';

describe('by-login route shape', () => {
  it('exports one GET route at /users/by-login/:login', () => {
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('GET');
    expect(routes[0].path).toBe('/users/by-login/:login');
    expect(routes[0].auth).toBe('public');
  });
});

describe('isValidLogin', () => {
  it('accepts plain alphanumeric usernames', () => {
    expect(isValidLogin('alice')).toBe(true);
    expect(isValidLogin('Bob')).toBe(true);
    expect(isValidLogin('user42')).toBe(true);
  });

  it('accepts hyphens', () => {
    expect(isValidLogin('alice-bob')).toBe(true);
    expect(isValidLogin('a-b-c')).toBe(true);
  });

  it('rejects empty / oversized', () => {
    expect(isValidLogin('')).toBe(false);
    expect(isValidLogin('a'.repeat(101))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidLogin(null)).toBe(false);
    expect(isValidLogin(42)).toBe(false);
    expect(isValidLogin(undefined)).toBe(false);
    expect(isValidLogin({})).toBe(false);
  });

  it('rejects path-traversal characters', () => {
    expect(isValidLogin('../etc')).toBe(false);
    expect(isValidLogin('foo/bar')).toBe(false);
    expect(isValidLogin('foo.bar')).toBe(false);
    expect(isValidLogin('foo bar')).toBe(false);
    expect(isValidLogin('foo_bar')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(isValidLogin('-alice')).toBe(false);
  });

  it('accepts up to 100 chars (forward-compat over GitHub 39-char limit)', () => {
    expect(isValidLogin('a'.repeat(100))).toBe(true);
  });
});
