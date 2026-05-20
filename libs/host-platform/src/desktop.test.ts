import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetDesktopHostPlatformCacheForTests,
  desktopHostPlatform,
} from './desktop';

describe('desktopHostPlatform', () => {
  let tmp: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'host-platform-desktop-'));
    envSnapshot.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
    envSnapshot.DATABASE_URL = process.env.DATABASE_URL;
    envSnapshot.PAPERCUSP_PG_URL = process.env.PAPERCUSP_PG_URL;
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCUSP_PG_URL;
    _resetDesktopHostPlatformCacheForTests();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDesktopHostPlatformCacheForTests();
  });

  describe('readTextFileSync', () => {
    it('returns file contents when present', () => {
      const p = join(tmp, 'hello.txt');
      writeFileSync(p, 'hello world', 'utf8');
      expect(desktopHostPlatform.readTextFileSync(p)).toBe('hello world');
    });

    it('returns null when the file is missing (does not throw)', () => {
      expect(desktopHostPlatform.readTextFileSync(join(tmp, 'nope.txt'))).toBeNull();
    });

    it('returns null when path is a directory (read failure)', () => {
      mkdirSync(join(tmp, 'dir'));
      expect(desktopHostPlatform.readTextFileSync(join(tmp, 'dir'))).toBeNull();
    });
  });

  describe('fileExistsSync', () => {
    it('true for an existing file', () => {
      const p = join(tmp, 'a.txt');
      writeFileSync(p, '', 'utf8');
      expect(desktopHostPlatform.fileExistsSync(p)).toBe(true);
    });

    it('false for a missing file', () => {
      expect(desktopHostPlatform.fileExistsSync(join(tmp, 'nope'))).toBe(false);
    });

    it('false for a directory (matches "is a file?")', () => {
      mkdirSync(join(tmp, 'd'));
      expect(desktopHostPlatform.fileExistsSync(join(tmp, 'd'))).toBe(false);
    });
  });

  describe('homedir', () => {
    it('returns a non-empty string', () => {
      const h = desktopHostPlatform.homedir();
      expect(typeof h).toBe('string');
      expect(h.length).toBeGreaterThan(0);
    });
  });

  describe('getHarnessAdminUrl', () => {
    it('prefers HARNESS_ADMIN_DATABASE_URL when set', () => {
      process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://primary/x';
      process.env.DATABASE_URL = 'postgresql://secondary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://primary/x');
    });

    it('falls back to DATABASE_URL when primary is absent', () => {
      process.env.DATABASE_URL = 'postgresql://secondary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://secondary/x');
    });

    it('falls back to PAPERCUSP_PG_URL when both primary and DATABASE_URL absent', () => {
      process.env.PAPERCUSP_PG_URL = 'postgresql://tertiary/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://tertiary/x');
    });

    it('returns the native fallback when no env + no discovery file', () => {
      const url = desktopHostPlatform.getHarnessAdminUrl();
      expect(url).toContain('harness_admin');
      expect(url).toContain('localhost:5432');
    });

    it('caches the resolved URL', () => {
      process.env.PAPERCUSP_PG_URL = 'postgresql://a/x';
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://a/x');
      process.env.PAPERCUSP_PG_URL = 'postgresql://b/x';
      // Still the cached value, even though env changed.
      expect(desktopHostPlatform.getHarnessAdminUrl()).toBe('postgresql://a/x');
    });
  });
});
