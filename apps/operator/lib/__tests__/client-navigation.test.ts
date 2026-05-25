import { describe, expect, it } from 'vitest';
import { resolveClientNavigation, shouldSoftNavigate } from '../client-navigation';

describe('client navigation', () => {
  it('soft-navigates same-origin absolute and relative app routes', () => {
    expect(shouldSoftNavigate('/support', 'http://localhost:3070/harness?ws=default')).toBe(true);
    expect(shouldSoftNavigate('http://localhost:3070/settings/operator', 'http://localhost:3070/harness')).toBe(true);
    expect(shouldSoftNavigate('http://127.0.0.1:3070/settings/operator', 'http://127.0.0.1:3070/harness')).toBe(true);
  });

  it('does not soft-navigate cross-origin targets', () => {
    expect(shouldSoftNavigate('https://example.com', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldSoftNavigate('http://localhost:3055/harness', 'http://localhost:3070/harness')).toBe(false);
  });
  it('soft-navigates same-origin support and settings routes used by static desktop chrome', () => {
    expect(shouldSoftNavigate('/support', 'http://localhost:3070/harness?ws=default')).toBe(true);
    expect(shouldSoftNavigate('/settings/operator', 'http://localhost:3070/harness?ws=default')).toBe(true);
  });

  it('fails closed on unsafe schemes', () => {
    expect(shouldSoftNavigate('javascript:alert(1)', 'http://localhost:3070/harness')).toBe(false);
    expect(shouldSoftNavigate('data:text/plain,hi', 'http://localhost:3070/harness')).toBe(false);
  });
  it('resolves soft navigation to canonical path/search/hash payloads', () => {
    expect(resolveClientNavigation('/support?ws=default#faq', 'http://localhost:3070/harness?ws=default')).toEqual({
      mode: 'soft',
      href: '/support?ws=default#faq',
      replace: false,
    });
    expect(resolveClientNavigation('http://localhost:3070/settings/operator#voice', 'http://localhost:3070/harness', { replace: true })).toEqual({
      mode: 'soft',
      href: '/settings/operator#voice',
      replace: true,
    });
  });

  it('resolves cross-origin targets to hard navigation payloads', () => {
    expect(resolveClientNavigation('https://example.com', 'http://localhost:3070/harness')).toEqual({
      mode: 'hard',
      href: 'https://example.com',
      replace: false,
    });
  });

  it('fails closed for malformed or unsafe hard-navigation targets', () => {
    expect(resolveClientNavigation('javascript:alert(1)', 'http://localhost:3070/harness')).toEqual({
      mode: 'none',
      href: null,
      replace: false,
    });
    expect(resolveClientNavigation('data:text/plain,hi', 'http://localhost:3070/harness')).toEqual({
      mode: 'none',
      href: null,
      replace: false,
    });
    expect(resolveClientNavigation('http://[::1', 'http://localhost:3070/harness')).toEqual({
      mode: 'none',
      href: null,
      replace: false,
    });
  });
});
