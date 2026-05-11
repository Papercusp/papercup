import { describe, it, expect } from 'vitest';
import { validateManifest } from './manifest-validate';

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0' });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects unknown top-level fields', () => {
    const r = validateManifest({ name: 'mytool', version: '0.1.0', wibble: true });
    expect(r.ok).toBe(false);
    const msg = r.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/unknown property "wibble"/);
  });

  it('rejects an invalid plugin id', () => {
    const r = validateManifest({ name: 'My-TOOL', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('rejects an id that is too short', () => {
    const r = validateManifest({ name: 'ab', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/name')).toBe(true);
  });

  it('accepts scoped ids', () => {
    const r = validateManifest({ name: '@papercupai/cloudflare-pages', version: '0.1.0' });
    expect(r.ok).toBe(true);
  });

  it('rejects bad semver', () => {
    const r = validateManifest({ name: 'mytool', version: 'not-a-version' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/version')).toBe(true);
  });

  it('accepts known optional fields', () => {
    const r = validateManifest({
      name: 'mytool',
      version: '0.1.0',
      description: 'hi',
      papercusp: '^0.1.0',
      protocol: '^1.0',
      capabilities: ['http:fetch:example.com'],
      kind: 'plugin',
    });
    expect(r.ok).toBe(true);
  });
});

describe('$schema meta-keyword', () => {
  it('allows $schema field for editor LSP autocomplete', () => {
    const r = validateManifest({
      $schema: 'https://papercupai.com/papercusp-plugin.schema.json',
      name: '@test/with-schema',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });
});

describe('plugin dependency + config fields', () => {
  it('accepts requires + recommends arrays', () => {
    const r = validateManifest({
      name: '@test/with-deps',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: ['@papercupai/cloudflare-pages'],
      recommends: ['@papercupai/github-repo'],
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts defaultConfig object', () => {
    const r = validateManifest({
      name: '@test/with-default-config',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      defaultConfig: { apiKey: 'placeholder', retries: 3 },
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects requires as non-array', () => {
    const r = validateManifest({
      name: '@test/bad-requires',
      version: '0.1.0',
      kind: 'plugin',
      papercusp: '^1.0',
      requires: 'not-an-array',
      capabilities: [],
      actions: [],
    });
    expect(r.ok).toBe(false);
  });
});
