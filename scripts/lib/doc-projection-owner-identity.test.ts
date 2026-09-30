/**
 * WI-10004366: the doc-projection scrub must hunt the owner's ASSERTED identity
 * (release-identity.env), not only `git config user.name`. On an automated box the git
 * identity is the git-sync bot, so a git-only scrub let the owner's name through into
 * the generated plans and insights indexes, which ship in the desktop sidecar.
 *
 * Fixtures use invented names; never put a real owner literal in a test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitOwnerValues, scrubBuildIdentity } from './doc-projection';

const KEYS = [
  'PAPERCUSP_RELEASE_IDENTITY_ENV',
  'PAPERCUSP_RELEASE_OWNER_NAME',
  'PAPERCUSP_RELEASE_OWNER_EMAIL',
] as const;

describe('scrubBuildIdentity: owner identity from release-identity.env', () => {
  let dir = '';
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-projection-owner-'));
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const useIdentityFile = (body: string) => {
    const f = join(dir, 'release-identity.env');
    writeFileSync(f, body);
    process.env.PAPERCUSP_RELEASE_IDENTITY_ENV = f;
  };

  it('scrubs every listed owner name and email, not just the first', () => {
    useIdentityFile(
      'PAPERCUSP_RELEASE_OWNER_NAME="Zed, Quintessa Marlowe"\n' +
        'PAPERCUSP_RELEASE_OWNER_EMAIL="zed@example.test;qm@example.test"\n',
    );
    const out = scrubBuildIdentity(
      'OWNER (Zed): approve. Quintessa Marlowe signed. Mail zed@example.test or qm@example.test.',
    );
    expect(out).not.toMatch(/\bZed\b|Quintessa Marlowe|zed@example\.test|qm@example\.test/);
    expect(out).toContain('OWNER (the owner)');
    expect(out.match(/<owner-email>/g)).toHaveLength(2);
  });

  it('matches a short name as a case-sensitive whole word only', () => {
    useIdentityFile('PAPERCUSP_RELEASE_OWNER_NAME="Zed"\n');
    expect(scrubBuildIdentity('Zedd and zed and Zedlike, but Zed.')).toBe(
      'Zedd and zed and Zedlike, but the owner.',
    );
  });

  it('matches a LONG owner name case-insensitively, as the release gate does (plan slugs are lower-cased)', () => {
    useIdentityFile('PAPERCUSP_RELEASE_OWNER_NAME="Zed, Marlowe"\n');
    expect(scrubBuildIdentity('Marlowe images; slug `marlowe-central-server`; MARLOWE; zed stays')).toBe(
      'the owner images; slug `the owner-central-server`; the owner; zed stays',
    );
  });

  it('an exported variable wins over the file', () => {
    useIdentityFile('PAPERCUSP_RELEASE_OWNER_NAME="Zed"\n');
    process.env.PAPERCUSP_RELEASE_OWNER_NAME = 'Ivo';
    expect(scrubBuildIdentity('Ivo and Zed')).toBe('the owner and Zed');
  });

  it('a missing identity file is not an error and scrubs no invented name', () => {
    process.env.PAPERCUSP_RELEASE_IDENTITY_ENV = join(dir, 'absent.env');
    expect(scrubBuildIdentity('Zed and Quintessa Marlowe')).toBe('Zed and Quintessa Marlowe');
  });
});

describe('explicitOwnerValues', () => {
  it('splits on comma/semicolon only (never whitespace), trims and de-dups in order', () => {
    expect(explicitOwnerValues(' Jane Doe ; Zed,Zed ,, ')).toEqual(['Jane Doe', 'Zed']);
    expect(explicitOwnerValues(undefined)).toEqual([]);
    expect(explicitOwnerValues('')).toEqual([]);
  });
});
