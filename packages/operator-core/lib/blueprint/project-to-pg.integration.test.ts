/**
 * P-006 (`autoloop-pot-operator-rebuild-2026-06-05` D-005) — the dispatch-policy
 * read path the orchestrator tick uses, against REAL PG (throwaway DB):
 *
 *   1. `getEffectiveBlueprint` lazily projects a git-canonical
 *      `.papercusp/blueprint.yaml` into the `harness_shared.blueprints` cache on
 *      a miss and returns the resolved blueprint (the `dispatch:` section
 *      surviving the write → read → `BlueprintSchema.parse` round trip);
 *   2. a second resolve is a pure CACHE HIT (the file is not re-read);
 *   3. the resolved policy composes through `resolveDispatchPolicy` to the cap
 *      the tick enforces (coding-style `concurrency: 4`).
 *
 * Table DDL mirrors migration 133 (PK + resolved jsonb — RLS/grants are
 * irrelevant on the throwaway admin connection).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { getEffectiveBlueprint, readBlueprintFromPg } from './project-to-pg';
import { resolveDispatchPolicy } from '../dbos/orchestrator-loop';
import type { HarnessConfig } from '@papercusp/orchestrator';

let db: FreshPgDb;
let dir: string;
let blueprintPath: string;

/** A standalone (no-extends) blueprint declaring a coding-style dispatch policy. */
const YAML = `
id: dispatch-demo
version: 0.1.0
workItem:
  kind: feature
  idPrefix: F
spine:
  decider: director
  edges:
    DONE: { to: done }
dispatch:
  concurrency: 4
  priority: plan-order
`;

beforeAll(async () => {
  db = await createFreshPgDb('p006-dispatch-cache');
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.blueprints (
      workspace_id  text NOT NULL,
      harness_slug  text NOT NULL,
      blueprint_id  text NOT NULL,
      version       text NOT NULL DEFAULT '0.1.0',
      resolved      jsonb NOT NULL,
      content_hash  text NOT NULL,
      source_path   text,
      source_commit text,
      projected_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug)
    );
  `);
  dir = mkdtempSync(join(tmpdir(), 'p006-bp-'));
  mkdirSync(join(dir, '.papercusp'), { recursive: true });
  blueprintPath = join(dir, '.papercusp', 'blueprint.yaml');
  writeFileSync(blueprintPath, YAML, 'utf8');
}, 90_000);

afterAll(async () => {
  await db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe('getEffectiveBlueprint — the dispatch-policy read path of the orchestrator tick', () => {
  it('cache miss → lazily projects the file and returns the dispatch policy', async () => {
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'demo',
      blueprintPath,
    });
    expect(bp).not.toBeNull();
    expect(bp!.dispatch).toEqual({
      concurrency: 4,
      priority: 'plan-order',
      // the schema default — the legacy needs-work set (byte-equivalence anchor)
      readiness: ['todo', 'failing', 'pending', 'failed'],
    });
    // …and the projection row landed in the PG cache.
    const cached = await readBlueprintFromPg(db.sql as never, 'default', 'demo');
    expect(cached?.dispatch?.concurrency).toBe(4);
  });

  it('second resolve is a cache HIT — the (now deleted) file is not re-read', async () => {
    rmSync(blueprintPath);
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'demo',
      blueprintPath,
    });
    expect(bp?.dispatch?.concurrency).toBe(4);
  });

  it('no cache row + no file → null (the tick falls back to the legacy config-only gate)', async () => {
    const bp = await getEffectiveBlueprint(db.sql as never, {
      workspaceId: 'default',
      harnessSlug: 'no-such-harness',
      blueprintPath: join(dir, '.papercusp', 'missing.yaml'),
    });
    expect(bp).toBeNull();
  });

  it('the cached policy composes through resolveDispatchPolicy to the tick cap', async () => {
    const bp = await readBlueprintFromPg(db.sql as never, 'default', 'demo');
    const r = resolveDispatchPolicy({ dispatch: bp?.dispatch ?? null, cfg: {} as HarnessConfig });
    expect(r.cap).toBe(4); // the blueprint fills the silent per-install config
    // per-install config still wins (instance refines shape)
    const tightened = resolveDispatchPolicy({
      dispatch: bp?.dispatch ?? null,
      cfg: { parallelWorkers: { max: 2 } } as HarnessConfig,
    });
    expect(tightened.cap).toBe(2);
  });
});
