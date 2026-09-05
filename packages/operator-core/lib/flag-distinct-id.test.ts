import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_HOSTNAME,
  resolveDistinctId,
  resolveHostHostname,
  systemDistinctId,
} from './flag-distinct-id';

// WI-2145237: this module is reachable from the lexicon's server wiring, which a
// client page can import by mistake. A static `node:` specifier here made that
// mistake a webpack client-compilation failure (portal build #3c). These pin the
// property a bundler sees — no static builtin import — AND that the lazy path still
// resolves the real hostname on Node, AND that it degrades instead of throwing
// where no builtin loader exists.
describe('flag-distinct-id', () => {
  it('carries no static `node:` (or bare builtin) specifier for a bundler to resolve', () => {
    const source = readFileSync(join(__dirname, 'flag-distinct-id.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/from\s+['"](?:os|fs|path|child_process)['"]/);
    expect(source).not.toMatch(/import\s*\(\s*['"]node:/);
    expect(source).not.toMatch(/require\s*\(\s*['"]node:/);
  });

  it('resolves the real machine hostname on Node, stable across calls and both entry points', () => {
    const expected = `papercusp-host-${hostname()}`;
    expect(systemDistinctId()).toBe(expected);
    expect(systemDistinctId()).toBe(expected);
    expect(resolveDistinctId(new Request('http://localhost/'))).toBe(expected);
  });

  it('degrades to the placeholder when no builtin loader is reachable (a browser graph)', () => {
    // `null` models "no loader"; an explicit `undefined` would select the runtime default.
    expect(resolveHostHostname(null)).toBe(UNKNOWN_HOSTNAME);
    expect(resolveHostHostname(() => undefined)).toBe(UNKNOWN_HOSTNAME);
    expect(resolveHostHostname(() => ({}))).toBe(UNKNOWN_HOSTNAME);
    expect(resolveHostHostname(() => ({ hostname: () => '' }))).toBe(UNKNOWN_HOSTNAME);
    expect(
      resolveHostHostname(() => {
        throw new Error('no builtins here');
      }),
    ).toBe(UNKNOWN_HOSTNAME);
  });

  it('CALIBRATION: an injected loader that yields a hostname is actually used', () => {
    expect(resolveHostHostname(() => ({ hostname: () => 'fixture-host' }))).toBe('fixture-host');
  });
});

// Pre-existing coverage (kept verbatim): the machine-stable PostHog distinctId is
// host-prefixed and request-independent for V1.
describe('resolveDistinctId', () => {
  it('returns a host-prefixed id', () => {
    expect(resolveDistinctId(new Request('http://localhost/'))).toMatch(/^papercusp-host-/);
  });
  it('is stable + independent of the request', () => {
    const a = resolveDistinctId(new Request('http://localhost/a'));
    const b = resolveDistinctId(new Request('http://localhost/b'));
    expect(a).toBe(b);
  });
});
