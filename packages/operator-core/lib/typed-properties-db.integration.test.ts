/**
 * typed-properties-db.integration.test.ts — the typed-property DB cycle
 * against real Postgres (work-on-everything-goal-2026-08-23 P-023 / WI-41047,
 * migration 923).
 *
 * Mirrors datatype-registry.integration.test.ts: the module is
 * transport-agnostic (every fn takes the `sql` handle), so the org-fixture's
 * admin client is passed directly, scoped by explicit workspaceId args. This
 * ALSO verifies migration 923 applied on the real baseline (the
 * property_schema/properties columns + their jsonb_typeof CHECKs on BOTH
 * harness_shared.goals and harness_shared.harness_plans).
 *
 * Validates: declaration validation (unknown datatype ref, invalid default,
 * ok); the goal write cycle (ok envelope persisted, CAS stale, editable_by
 * forbidden, datatype-invalid value, unknown property, not_found); the plan
 * write cycle (same core on the harness_plans PK); and derivePropertySurface
 * (effective = stored else declaration default).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype } from './datatype-registry-store';
import {
  applyGoalPropertyWrite,
  applyPlanPropertyWrite,
  derivePropertySurface,
  validatePropertySchemaDeclaration,
} from './typed-properties-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

const WS = 'ws-typed-props';
const HARNESS = 'tp-harness';

describe('typed-properties-db (real PG, migration 923)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // A datatype WITH a payload_schema (values + defaults validate against it)…
    await upsertDatatype(db.adminSql, {
      id: 'string-list',
      workspaceId: WS,
      title: 'String list',
      description: 'A list of strings',
      tier: 'first-class',
      payloadSchema: { type: 'array', items: { type: 'string' } },
    });
    // …and one WITHOUT (constrains nothing).
    await upsertDatatype(db.adminSql, {
      id: 'freeform',
      workspaceId: WS,
      title: 'Freeform',
      description: 'Unconstrained value',
      tier: 'first-class',
    });
    // Owning rows: one goal, one plan.
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status, property_schema)
      VALUES
        ('g-tp-1', ${HARNESS}, ${WS}, 'typed props goal', 'active',
         ${JSON.stringify({
           worklist: { datatype: 'string-list', default: ['perf'], editable_by: 'both' },
           budget: { datatype: 'freeform', editable_by: 'owner' },
         })}::text::jsonb),
        ('g-tp-shrink', ${HARNESS}, ${WS}, 'typed props shrink guard', 'active',
         ${JSON.stringify({
           worklist: { datatype: 'string-list', editable_by: 'both' },
         })}::text::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, property_schema)
      VALUES (${WS}, ${HARNESS}, 'tp-plan-2026-08-23', 'typed props plan', 'draft',
              ${JSON.stringify({
                focus: { datatype: 'string-list', editable_by: 'agent' },
              })}::text::jsonb)`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('declaration validation: unknown datatype ref and invalid default are refused; a valid doc passes', async () => {
    const unknownRef = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'no-such-datatype', editable_by: 'both' },
    });
    expect(unknownRef.ok).toBe(false);
    if (!unknownRef.ok) expect(unknownRef.issues[0]).toContain("unknown datatype 'no-such-datatype'");

    const badDefault = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'string-list', default: [1, 2], editable_by: 'both' },
    });
    expect(badDefault.ok).toBe(false);
    if (!badDefault.ok) expect(badDefault.issues[0]).toContain('default does not satisfy');

    const good = await validatePropertySchemaDeclaration(db.adminSql, WS, {
      x: { datatype: 'string-list', default: ['a'], editable_by: 'both' },
      y: { datatype: 'freeform', editable_by: 'agent' },
    });
    expect(good).toEqual({ ok: true, declared: ['x', 'y'] });
  });

  it('goal write cycle: ok persists the envelope; the follow-up CAS write sees it', async () => {
    const first = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: ['docs sweeps'],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entry.version).toBe(1);
    expect(first.priorValue).toEqual(['perf']); // declaration default

    // Persisted: read the raw column back.
    const rows = await db.adminSql<Array<{ properties: unknown }>>`
      SELECT properties FROM harness_shared.goals WHERE id = 'g-tp-1' AND workspace_id = ${WS}`;
    const doc =
      typeof rows[0]!.properties === 'string'
        ? (JSON.parse(rows[0]!.properties as string) as Record<string, unknown>)
        : (rows[0]!.properties as Record<string, unknown>);
    expect((doc.worklist as { value: unknown; version: number }).value).toEqual(['docs sweeps']);
    expect((doc.worklist as { version: number }).version).toBe(1);
    expect((doc.worklist as { provenance: string }).provenance).toBe('owner-edit');

    // Stale CAS: re-claiming version 0 now refuses with the actual version.
    const stale = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: ['x'],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(stale).toMatchObject({ ok: false, code: 'stale', actualVersion: 1 });
  });

  it('goal write cycle: forbidden, invalid value, unknown property, not_found', async () => {
    const forbidden = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'budget',
      value: 5,
      expectedVersion: 0,
      provenance: 'agent-edit', // budget is owner-only
      actorId: 'su-1',
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });

    const invalid = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'worklist',
      value: [1, 2], // not strings
      expectedVersion: 1,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(invalid).toMatchObject({ ok: false, code: 'invalid_value', datatype: 'string-list' });

    const unknown = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-1',
      property: 'nope',
      value: 1,
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(unknown).toMatchObject({ ok: false, code: 'unknown_property' });

    const missing = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-absent',
      property: 'worklist',
      value: [],
      expectedVersion: 0,
      provenance: 'owner-edit',
      actorId: 'avi',
    });
    expect(missing).toEqual({ ok: false, code: 'not_found' });
  });

  it('goal write cycle: a rejected array shrink preserves the stored value; explicit confirmation writes it', async () => {
    const initial = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first', 'second', 'third'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(initial.ok).toBe(true);

    const blocked = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first'],
      expectedVersion: 1,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(blocked).toMatchObject({
      ok: false,
      code: 'shrink_blocked',
      priorLength: 3,
      proposedLength: 1,
      actualVersion: 1,
      recovery: { confirmShrink: true },
    });

    const afterBlocked = await db.adminSql<Array<{ value: unknown; version: number }>>`
      SELECT properties->'worklist'->'value' AS value,
             (properties->'worklist'->>'version')::int AS version
        FROM harness_shared.goals
       WHERE id = 'g-tp-shrink' AND workspace_id = ${WS}`;
    expect(afterBlocked[0]).toMatchObject({
      value: ['first', 'second', 'third'],
      version: 1,
    });

    const confirmed = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-shrink',
      property: 'worklist',
      value: ['first'],
      expectedVersion: 1,
      confirmShrink: true,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.value).toEqual(['first']);
    expect(confirmed.entry.version).toBe(2);
  });

  it('plan write cycle: same core on the harness_plans PK', async () => {
    const write = await applyPlanPropertyWrite(db.adminSql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'tp-plan-2026-08-23',
      property: 'focus',
      value: ['gate triage'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'su-1',
    });
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.entry.version).toBe(1);

    const rows = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'tp-plan-2026-08-23'`;
    const surface = derivePropertySurface(rows[0]!);
    expect(surface.effective.focus).toEqual(['gate triage']);

    // An owner-edit on the agent-only property refuses.
    const forbidden = await applyPlanPropertyWrite(db.adminSql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'tp-plan-2026-08-23',
      property: 'focus',
      value: [],
      expectedVersion: 1,
      provenance: 'owner-edit',
      actorId: 'admin',
    });
    expect(forbidden).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'agent' });
  });

  it('derivePropertySurface: effective falls back to the declaration default when unset', () => {
    const surface = derivePropertySurface({
      property_schema: {
        a: { datatype: 'freeform', default: 42, editable_by: 'both' },
        b: { datatype: 'freeform', editable_by: 'both' },
      },
      properties: {},
    });
    expect(surface.effective).toEqual({ a: 42, b: undefined });
  });
});
