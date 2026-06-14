import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockDomainForProjectDir,
  lockCoordinationDomain,
  __resetLockCoordinationDomain,
} from './coordination-domain';

const SAVED = process.env.PAPERCUSP_LOCK_DOMAIN;
beforeEach(() => {
  delete process.env.PAPERCUSP_LOCK_DOMAIN;
  __resetLockCoordinationDomain();
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.PAPERCUSP_LOCK_DOMAIN;
  else process.env.PAPERCUSP_LOCK_DOMAIN = SAVED;
  __resetLockCoordinationDomain();
});

describe('lockDomainForProjectDir', () => {
  it('honors the PAPERCUSP_LOCK_DOMAIN override (trimmed)', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '  /custom/domain  ';
    expect(lockDomainForProjectDir('/anywhere')).toBe('/custom/domain');
  });

  it('resolves to the realpath of the nearest .git ancestor (so two workspaces over one checkout serialize)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockdom-'));
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(lockDomainForProjectDir(sub)).toBe(realpathSync(root));
  });

  it('falls back to the start dir when no .git ancestor exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'));
    expect(lockDomainForProjectDir(dir)).toBe(realpathSync(dir));
  });
});

describe('lockCoordinationDomain', () => {
  it('honors the override and caches it until reset', () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d1';
    expect(lockCoordinationDomain()).toBe('/d1');
    process.env.PAPERCUSP_LOCK_DOMAIN = '/d2';
    expect(lockCoordinationDomain()).toBe('/d1'); // cached — env change not re-read
    __resetLockCoordinationDomain();
    expect(lockCoordinationDomain()).toBe('/d2'); // re-read after reset
  });
});
