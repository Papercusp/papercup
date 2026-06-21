/**
 * resolve-bind-host.test.ts — the loopback-bind recurrence guard
 * (infra-fail-fast-build-integrity-2026-06-19 P-015 / D2; locks audit P-027).
 */
import { describe, it, expect } from 'vitest';
import { resolveBindHost } from './resolve-bind-host';

describe('resolveBindHost', () => {
  it('defaults to loopback 127.0.0.1 when nothing is set', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('honors an explicit PAPERCUSP_BIND_HOST (the off-loopback opt-in)', () => {
    expect(resolveBindHost({ PAPERCUSP_BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ PAPERCUSP_BIND_HOST: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('IGNORES HOSTNAME — the P-027 footgun (must NOT bind to the machine name)', () => {
    expect(resolveBindHost({ HOSTNAME: 'prod-box-7' })).toBe('127.0.0.1');
    // an explicit bind-host still wins over a stray HOSTNAME
    expect(resolveBindHost({ HOSTNAME: 'prod-box-7', PAPERCUSP_BIND_HOST: '127.0.0.2' })).toBe('127.0.0.2');
  });

  it('treats a blank/whitespace PAPERCUSP_BIND_HOST as unset (loopback)', () => {
    expect(resolveBindHost({ PAPERCUSP_BIND_HOST: '' })).toBe('127.0.0.1');
    expect(resolveBindHost({ PAPERCUSP_BIND_HOST: '   ' })).toBe('127.0.0.1');
  });
});
