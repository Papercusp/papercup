import { describe, it, expect } from 'vitest';
import { createManifestValidator } from './manifest-validator';

// A synthetic, host-agnostic manifest schema — proves the engine is
// domain-free: it works against any JSON Schema, not a Papercusp-shaped one.
const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,30}$' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
} as const;

describe('createManifestValidator', () => {
  const { validate } = createManifestValidator(SCHEMA as object);

  it('accepts a minimal valid manifest', () => {
    const r = validate({ id: 'widget', version: '0.1.0' });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rewrites additionalProperties into a typo-friendly message', () => {
    const r = validate({ id: 'widget', version: '0.1.0', wibble: true });
    expect(r.ok).toBe(false);
    const msg = r.issues.map((i) => i.message).join(' ');
    expect(msg).toMatch(/unknown property "wibble"/);
  });

  it('surfaces a field path on a pattern violation', () => {
    const r = validate({ id: 'BAD-ID', version: '0.1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '/id')).toBe(true);
  });

  it('reports missing required fields', () => {
    const r = validate({ id: 'widget' });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('accepts known optional fields', () => {
    const r = validate({ id: 'widget', version: '1.2.3', description: 'hi', tags: ['a', 'b'] });
    expect(r.ok).toBe(true);
  });
});

describe('customizeMessage hook', () => {
  const { validate } = createManifestValidator(SCHEMA as object, {
    customizeMessage: (e, manifest) => {
      const path = e.instancePath || '/';
      if (e.keyword === 'pattern' && path === '/id') {
        return `id must be kebab-case (got "${(manifest as { id?: unknown }).id}")`;
      }
      return undefined;
    },
  });

  it('lets the host override a specific error message', () => {
    const r = validate({ id: 'NOPE', version: '0.1.0' });
    expect(r.ok).toBe(false);
    const idIssue = r.issues.find((i) => i.path === '/id');
    expect(idIssue?.message).toMatch(/id must be kebab-case \(got "NOPE"\)/);
  });

  it('falls back to the default message when the hook returns undefined', () => {
    // A version pattern violation isn't overridden — keeps ajv's default.
    const r = validate({ id: 'widget', version: 'nope' });
    expect(r.ok).toBe(false);
    const verIssue = r.issues.find((i) => i.path === '/version');
    expect(verIssue).toBeDefined();
    expect(verIssue?.message).not.toMatch(/kebab-case/);
  });
});

describe('assertValid', () => {
  const { assertValid } = createManifestValidator(SCHEMA as object);

  it('is a no-op for valid manifests', () => {
    expect(() => assertValid({ id: 'widget', version: '0.1.0' })).not.toThrow();
  });

  it('throws with all issues + the source label', () => {
    expect(() => assertValid({ id: 'BAD', version: 'x' }, 'my-plugin manifest')).toThrow(
      /my-plugin manifest is invalid:/,
    );
  });
});
