/**
 * migrate-config-json.integration.test.ts — migrateConfigJsonToInstance
 * (deprecate-harness-config-json-2026-06-06), the entry-seam lift that runs on
 * EVERY harness registration behind a silent catch{} (projects.ts:360) + the
 * deploy backfill. It reads a real `.papercusp/config.json` off disk (tmp dir)
 * and mutates the workspace-PG registry entry; the registry is backed here by an
 * in-memory mock-PG harness (the harness-registry.test.ts shape).
 *
 * Gap 11: pins
 *   - a config.json with phase/dept + a harness_token lifts phase/dept into the
 *     registry entry but NEVER the token (contract artifact stays in the file);
 *   - a SECOND run is idempotent (migrated:false — already has instance config);
 *   - an absent file returns {migrated:false} without throwing;
 *   - a config.json holding ONLY contract artifacts is a no-op (nothing to lift).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry } from '../harness-registry';

// In-memory mock-PG registry store (the harness-registry.test.ts harness):
// one committed value mutated through read/write, no real PG.
type RegistryPayload = { projects: ProjectEntry[] } & Record<string, unknown>;
let state: RegistryPayload | null = null;

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => state,
  writeOperatorState: async (_table: string, payload: RegistryPayload) => {
    state = payload;
  },
  updateOperatorState: async (
    _table: string,
    defaultValue: RegistryPayload,
    mutator: (cur: RegistryPayload) => RegistryPayload,
  ) => {
    const next = mutator(state ?? defaultValue);
    state = next;
    return next;
  },
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
// Audit-log writer reaches for the org pool — stub it so the save's best-effort
// audit doesn't try to open a real connection.
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: Object.assign(async () => [], { unsafe: async () => {} }) }),
}));
// saveHarnessRegistry fires a fire-and-forget sync invalidate (notifyRegistryChanged
// → sync-sse) that would otherwise resolve after the test env tears down. Stub the
// invalidate seam so the migration write stays self-contained.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: async () => {} }));
vi.mock('../harness/projects-lite', () => ({ bustProjectsLiteCache: () => {} }));

import { migrateConfigJsonToInstance } from './instance-config';

let tmp: string;
const WS = 'default';

/** Seed the in-memory registry with one entry whose path is a fresh tmp dir. */
function seedEntry(slug: string): string {
  const dir = mkdtempSync(join(tmp, `${slug}-`));
  state = { projects: [{ slug, path: dir }] };
  return dir;
}

/** Write a `.papercusp/config.json` under the harness dir. */
function writeConfig(harnessDir: string, cfg: Record<string, unknown>): void {
  const cfgDir = join(harnessDir, '.papercusp');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(cfg), 'utf8');
}

const entryFor = (slug: string) => state!.projects.find((p) => p.slug === slug)!;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mig-cfg-'));
  state = null;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateConfigJsonToInstance (Gap 11)', () => {
  it('lifts phase/dept into the registry entry but NOT the harness_token (contract artifact)', async () => {
    const dir = seedEntry('alpha');
    writeConfig(dir, {
      phase: 'staging',
      dept: 'eng',
      harness_token: 'secret-token',
      maxCostUsd: 12, // a knob override → configOverrides
    });

    const r = await migrateConfigJsonToInstance('alpha', WS);

    expect(r.migrated).toBe(true);
    expect(r.fields.sort()).toEqual(['configOverrides', 'dept', 'phase']);

    const e = entryFor('alpha') as ProjectEntry & Record<string, unknown>;
    expect(e.phase).toBe('staging');
    expect(e.dept).toBe('eng');
    expect(e.configOverrides).toEqual({ maxCostUsd: 12 });
    // The contract artifact never lands on the registry entry.
    expect(e).not.toHaveProperty('harness_token');
    expect(JSON.stringify(e)).not.toContain('secret-token');
  });

  it('is idempotent — a second run reports migrated:false (already has instance config)', async () => {
    const dir = seedEntry('beta');
    writeConfig(dir, { phase: 'prod', dept: 'ops' });

    const first = await migrateConfigJsonToInstance('beta', WS);
    expect(first.migrated).toBe(true);

    const second = await migrateConfigJsonToInstance('beta', WS);
    expect(second).toEqual({ migrated: false, fields: [] });
    // The entry is unchanged by the re-run.
    expect(entryFor('beta').phase).toBe('prod');
  });

  it('returns {migrated:false} without throwing when the config.json is absent', async () => {
    seedEntry('gamma'); // no config.json written
    const r = await migrateConfigJsonToInstance('gamma', WS);
    expect(r).toEqual({ migrated: false, fields: [] });
    expect(entryFor('gamma')).not.toHaveProperty('phase');
  });

  it('is a no-op when config.json holds ONLY contract artifacts (nothing instance-shaped)', async () => {
    const dir = seedEntry('delta');
    writeConfig(dir, { harness_token: 'tok', parent_slug: 'root', slug: 'delta' });
    const r = await migrateConfigJsonToInstance('delta', WS);
    expect(r).toEqual({ migrated: false, fields: [] });
    const e = entryFor('delta') as ProjectEntry & Record<string, unknown>;
    expect(e).not.toHaveProperty('configOverrides');
    expect(e).not.toHaveProperty('phase');
  });

  it('returns {migrated:false} for an unknown slug (no entry to lift onto)', async () => {
    seedEntry('epsilon');
    const r = await migrateConfigJsonToInstance('not-registered', WS);
    expect(r).toEqual({ migrated: false, fields: [] });
  });
});
