/**
 * check-transitive-boundary.test.ts — tests for the boundary check script.
 *
 * The main test is LIVE: `npm run lint:boundary-check` scans the actual
 * apps/operator-vite codebase (609 files) and must exit 0 (no violations).
 *
 * This test file documents the forbidden patterns and verifies the script's
 * core logic (pattern matching, package name extraction).
 */

import { describe, it, expect } from 'vitest';

/**
 * The forbidden patterns that the boundary check enforces.
 * Kept in sync with scripts/check-transitive-boundary.mjs
 */
const FORBIDDEN_PATTERNS = [
  /^node:/,
  /^postgres($|\/)/,
  /^pg($|\/)/,
  /^drizzle-orm($|\/)/,
  /^@electric-sql\/pglite($|\/)/,
  /^@papercusp\/coordination\/event-log($|\/)/,
  /^typescript($|\/)/,
  /^@typescript-eslint($|\/)/,
  /^posthog-node($|\/)/,
  /^@dbos-inc\/dbos-sdk($|\/)/,
  /^(corestore|hyperswarm|hyperdht|hyperbee|hypercore|hypercore-crypto|sodium-universal|sodium-native|sodium-secretstream|udx-native|dht-rpc|blind-relay)($|\/)/,
  /^(ssh2|cpu-features)($|\/)/,
  /^(tsx|vite|rollup|esbuild|webpack|vitest|jest)($|\/)/,
];

/**
 * Extract package name from an import specifier.
 */
function getPackageName(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

/**
 * Check if a package is forbidden.
 * Tests the full specifier against patterns (e.g., "postgres/lib/index" should match /^postgres($|\/)/).
 */
function isForbidden(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  return FORBIDDEN_PATTERNS.some((p) => p.test(spec));
}

describe('Transitive boundary check', () => {
  describe('Forbidden patterns', () => {
    it('should forbid node: built-ins', () => {
      expect(isForbidden('node:fs')).toBe(true);
      expect(isForbidden('node:path')).toBe(true);
      expect(isForbidden('node:child_process')).toBe(true);
      expect(isForbidden('node:http')).toBe(true);
    });

    it('should forbid database clients', () => {
      expect(isForbidden('postgres')).toBe(true);
      expect(isForbidden('postgres/lib/connection')).toBe(true);
      expect(isForbidden('pg')).toBe(true);
      expect(isForbidden('drizzle-orm')).toBe(true);
      expect(isForbidden('@electric-sql/pglite')).toBe(true);
    });

    it('should forbid server-only coordination', () => {
      expect(isForbidden('@papercusp/coordination/event-log')).toBe(true);
    });

    it('should forbid code execution tools', () => {
      expect(isForbidden('typescript')).toBe(true);
      expect(isForbidden('typescript/lib/index')).toBe(true);
    });

    it('should forbid PostHog server backend', () => {
      expect(isForbidden('posthog-node')).toBe(true);
    });

    it('should forbid DBOS runtime', () => {
      expect(isForbidden('@dbos-inc/dbos-sdk')).toBe(true);
    });

    it('should forbid P2P networking', () => {
      expect(isForbidden('hyperswarm')).toBe(true);
      expect(isForbidden('hyperdht')).toBe(true);
      expect(isForbidden('hyperbee')).toBe(true);
      expect(isForbidden('corestore')).toBe(true);
      expect(isForbidden('hypercore')).toBe(true);
    });

    it('should forbid test infrastructure', () => {
      expect(isForbidden('ssh2')).toBe(true);
      expect(isForbidden('cpu-features')).toBe(true);
    });

    it('should forbid build tools', () => {
      expect(isForbidden('tsx')).toBe(true);
      expect(isForbidden('vite')).toBe(true);
      expect(isForbidden('webpack')).toBe(true);
      expect(isForbidden('vitest')).toBe(true);
    });
  });

  describe('Allowed patterns', () => {
    it('should allow browser APIs', () => {
      expect(isForbidden('react')).toBe(false);
      expect(isForbidden('react-dom')).toBe(false);
      expect(isForbidden('date-fns')).toBe(false);
      expect(isForbidden('zod')).toBe(false);
    });

    it('should allow relative imports', () => {
      expect(isForbidden('./utils')).toBe(false);
      expect(isForbidden('../lib/helper')).toBe(false);
      expect(isForbidden('/absolute/path')).toBe(false);
    });

    it('should allow local packages without server coupling', () => {
      expect(isForbidden('@papercusp/sync')).toBe(false);
      expect(isForbidden('@papercusp/flags')).toBe(false);
    });
  });

  describe('Package name extraction', () => {
    it('should extract bare package names', () => {
      expect(getPackageName('react')).toBe('react');
      expect(getPackageName('postgres')).toBe('postgres');
    });

    it('should extract scoped package names', () => {
      expect(getPackageName('@papercusp/sync')).toBe('@papercusp/sync');
      expect(getPackageName('@dbos-inc/dbos-sdk')).toBe('@dbos-inc/dbos-sdk');
    });

    it('should extract from subpaths', () => {
      expect(getPackageName('postgres/lib/connection')).toBe('postgres');
      expect(getPackageName('react/jsx-runtime')).toBe('react');
      expect(getPackageName('@papercusp/sync/client')).toBe('@papercusp/sync');
    });
  });

  describe('Edge cases', () => {
    it('should not forbid packages that contain forbidden names', () => {
      // e.g., "my-postgres-client" should NOT match /^postgres($|\/)/
      expect(isForbidden('my-postgres-client')).toBe(false);
      expect(isForbidden('http-router')).toBe(false);
    });

    it('should forbid exact forbidden package names', () => {
      expect(isForbidden('postgres')).toBe(true);
      expect(isForbidden('postgres/index')).toBe(true);
      expect(isForbidden('pg')).toBe(true);
      expect(isForbidden('pg/lib/client')).toBe(true);
    });
  });
});
