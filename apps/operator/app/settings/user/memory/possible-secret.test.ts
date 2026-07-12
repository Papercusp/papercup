/**
 * possible-secret.test.ts — EI-10371 stage 1: the stamp → chip mapping for
 * Settings → Memory. Load-bearing cases: only an explicit `true` flags (no
 * truthy coercion on untrusted metadata), and malformed classes degrade to a
 * generic title instead of crashing the row render.
 *
 * Run: cd apps/operator && npx vitest run app/settings/user/memory/possible-secret.test.ts
 */
import { describe, it, expect } from 'vitest';
import { possibleSecretClasses, possibleSecretTitle } from './possible-secret';

describe('possibleSecretClasses (EI-10371)', () => {
  it('returns the classes for a flagged row', () => {
    expect(
      possibleSecretClasses({
        metadata: { possible_secret: true, possible_secret_classes: ['url-with-password'] },
      }),
    ).toEqual(['url-with-password']);
  });

  it('returns null for unflagged, explicitly-cleared, and metadata-less rows', () => {
    expect(possibleSecretClasses({ metadata: {} })).toBeNull();
    expect(possibleSecretClasses({ metadata: { possible_secret: false } })).toBeNull();
    expect(possibleSecretClasses({})).toBeNull();
  });

  it('only an explicit boolean true flags — no truthy coercion on metadata', () => {
    expect(possibleSecretClasses({ metadata: { possible_secret: 'true' } })).toBeNull();
    expect(possibleSecretClasses({ metadata: { possible_secret: 1 } })).toBeNull();
  });

  it('malformed classes degrade to an empty list, never a crash', () => {
    expect(
      possibleSecretClasses({ metadata: { possible_secret: true, possible_secret_classes: 'jwt' } }),
    ).toEqual([]);
    expect(
      possibleSecretClasses({ metadata: { possible_secret: true, possible_secret_classes: [1, 'jwt'] } }),
    ).toEqual(['jwt']);
  });
});

describe('possibleSecretTitle', () => {
  it('names the classes and the remediation', () => {
    const t = possibleSecretTitle(['url-with-password', 'jwt']);
    expect(t).toContain('url-with-password, jwt');
    expect(t).toMatch(/rotate/i);
    expect(t).toContain('stored unchanged');
  });

  it('falls back to a generic phrase when classes are empty', () => {
    expect(possibleSecretTitle([])).toContain('credential-shaped content');
  });
});
