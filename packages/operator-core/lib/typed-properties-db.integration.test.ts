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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { getDatatype, upsertDatatype } from './datatype-registry-store';
import { canonicalWorklistDeclaration } from './goals/package-property-datatypes';
import setGoalProperty from './agent-tools/goals/set-property';
import { readGoalPortfolioBrief } from './goal-launch-settings';
import {
  applyGoalPropertyWrite,
  applyPlanPropertyWrite,
  derivePropertySurface,
  validatePropertySchemaDeclaration,
} from './typed-properties-db';

const { createOrgTestDb } = await import('../test/_org-test-db');

// Keep test notifications out of the live coordination log. The tool's authority
// check, typed property writer, and portfolio reader use the real fixture DB.
vi.mock('./agent-tools/coordination/plan-events', () => ({
  emitPlanEventForCaller: vi.fn().mockResolvedValue(undefined),
}));

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

  it('repairs a legacy goal worklist through the normal writer and preserves its other properties', async () => {
    const budget = {
      value: 50000,
      version: 1,
      edited_at: '2026-09-19T23:59:35.692Z',
      edited_by: 'owner',
      provenance: 'owner-edit',
    };
    const declaration = { budget: { datatype: 'freeform', editable_by: 'owner' } };
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, property_schema, properties)
      VALUES ('g-tp-legacy', ${HARNESS}, ${WS}, 'legacy goal', 'active',
              ${JSON.stringify(declaration)}::text::jsonb,
              ${JSON.stringify({ budget })}::text::jsonb)`;
    expect(await getDatatype(db.adminSql, WS, 'plan-ref-list')).toBeNull();

    const write = await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-legacy',
      property: 'worklist',
      value: ['plan:tp-harness/tp-plan-2026-08-23'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'goal-holder',
    });
    expect(write).toMatchObject({ ok: true, entry: { version: 1 } });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy' AND workspace_id = ${WS}`;
    const surface = derivePropertySurface(row!);
    expect(surface.propertySchema).toEqual({ ...declaration, worklist: canonicalWorklistDeclaration() });
    expect(surface.properties.budget).toEqual(budget);
    expect(surface.effective.worklist).toEqual(['plan:tp-harness/tp-plan-2026-08-23']);
    expect(await getDatatype(db.adminSql, WS, 'plan-ref-list')).toMatchObject({ id: 'plan-ref-list' });
  });

  it('repairs a legacy stored worklist without resetting its value or version checks', async () => {
    const worklist = {
      value: ['plan:tp-harness/tp-plan-2026-08-23', 'plan:second'],
      version: 7,
      edited_at: '2026-09-19T23:59:35.692Z',
      edited_by: 'original-holder',
      provenance: 'agent-edit',
    };
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-legacy-stored', ${HARNESS}, ${WS}, 'legacy stored worklist', 'active',
              ${JSON.stringify({ worklist })}::text::jsonb)`;
    const args = {
      workspaceId: WS,
      goalId: 'g-tp-legacy-stored',
      property: 'worklist',
      expectedVersion: 7,
      provenance: 'agent-edit' as const,
      actorId: 'successor-holder',
    };
    expect(await applyGoalPropertyWrite(db.adminSql, {
      ...args, value: worklist.value, expectedVersion: 0,
    })).toMatchObject({ ok: false, code: 'stale', actualVersion: 7 });
    expect(await applyGoalPropertyWrite(db.adminSql, { ...args, value: [] }))
      .toMatchObject({ ok: false, code: 'shrink_blocked', actualVersion: 7 });
    const [before] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-stored' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(before!).propertySchema).toEqual({});
    expect(derivePropertySurface(before!).properties.worklist).toEqual(worklist);

    const repaired = await applyGoalPropertyWrite(db.adminSql, { ...args, value: worklist.value });
    expect(repaired).toMatchObject({
      ok: true,
      priorValue: worklist.value,
      priorVersion: 7,
      entry: { value: worklist.value, version: 8, edited_by: 'successor-holder' },
    });
    const [after] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-stored' AND workspace_id = ${WS}`;
    const surface = derivePropertySurface(after!);
    expect(surface.propertySchema.worklist).toEqual(canonicalWorklistDeclaration());
    expect(surface.effective.worklist).toEqual(worklist.value);
    expect(surface.properties.worklist).toMatchObject({ value: worklist.value, version: 8 });
  });

  it('makes an existing goal worklist visible through the property tool and canonical portfolio reader', async () => {
    const value = ['plan:tp-harness/tp-plan-2026-08-23'];
    await db.adminSql`
      INSERT INTO harness_shared.goals
        (id, install_slug, workspace_id, title, status, properties)
      VALUES ('g-tp-tool', ${HARNESS}, ${WS}, 'tool worklist regression', 'active',
              ${JSON.stringify({ worklist: {
                value,
                version: 1,
                edited_at: '2026-09-19T23:59:35.692Z',
                edited_by: 'original-holder',
                provenance: 'agent-edit',
              } })}::text::jsonb)`;
    const result = await db.adminSql.begin(async (tx) => setGoalProperty.handler({
      goalId: 'g-tp-tool',
      property: 'worklist',
      value,
      expectedVersion: 1,
    } as never, {
      workspaceId: WS,
      isSuperuser: true,
      uiClientId: 'su-worklist-integration',
      tx,
    } as never)) as unknown as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: true, goalId: 'g-tp-tool', property: 'worklist', version: 2,
    });
    const portfolio = await readGoalPortfolioBrief({
      workspaceId: WS,
      goalId: 'g-tp-tool',
      sql: db.adminSql,
    });
    expect(portfolio).not.toBeNull();
    expect(portfolio!.worklist).toEqual([
      expect.objectContaining({
        ref: value[0],
        slug: 'tp-plan-2026-08-23',
        title: 'typed props plan',
      }),
    ]);
  });

  it('does not persist a legacy declaration for an invalid or stale worklist write', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status)
      VALUES ('g-tp-legacy-refused', ${HARNESS}, ${WS}, 'legacy refused goal', 'active')`;
    const args = {
      workspaceId: WS,
      goalId: 'g-tp-legacy-refused',
      property: 'worklist',
      expectedVersion: 0,
      provenance: 'agent-edit' as const,
      actorId: 'goal-holder',
    };
    expect(await applyGoalPropertyWrite(db.adminSql, { ...args, value: ['bare-plan-slug'] }))
      .toMatchObject({ ok: false, code: 'invalid_value', datatype: 'plan-ref-list' });
    expect(await applyGoalPropertyWrite(db.adminSql, {
      ...args, value: ['plan:valid'], expectedVersion: 4,
    })).toMatchObject({ ok: false, code: 'stale', actualVersion: 0 });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-legacy-refused' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(row!)).toEqual({ propertySchema: {}, properties: {}, effective: {} });
  });

  it('never replaces a custom owner-only worklist declaration with the canonical one', async () => {
    const declaration = { worklist: { datatype: 'string-list', default: ['custom'], editable_by: 'owner' } };
    await db.adminSql`
      INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status, property_schema)
      VALUES ('g-tp-custom-owner', ${HARNESS}, ${WS}, 'custom owner worklist', 'active',
              ${JSON.stringify(declaration)}::text::jsonb)`;
    expect(await applyGoalPropertyWrite(db.adminSql, {
      workspaceId: WS,
      goalId: 'g-tp-custom-owner',
      property: 'worklist',
      value: ['plan:valid'],
      expectedVersion: 0,
      provenance: 'agent-edit',
      actorId: 'goal-holder',
    })).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });
    const [row] = await db.adminSql<Array<{ property_schema: unknown; properties: unknown }>>`
      SELECT property_schema, properties FROM harness_shared.goals
       WHERE id = 'g-tp-custom-owner' AND workspace_id = ${WS}`;
    expect(derivePropertySurface(row!).propertySchema).toEqual(declaration);
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
