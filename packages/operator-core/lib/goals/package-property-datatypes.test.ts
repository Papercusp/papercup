/**
 * package-property-datatypes.test.ts — the P-025 first-party datatype seam:
 * the D-004 ref grammar, the payload schema as the registry's ajv seam would
 * enforce it, and the insert-if-absent ensure (never overwrite — P-024 display
 * specs ride the same registry rows) (work-on-everything-goal-2026-08-23).
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import {
  PLAN_REF_LIST_DATATYPE,
  PLAN_REF_STRING_PATTERN,
  planRefListPayloadSchema,
  ensurePlanRefListDatatype,
  type EnsurePlanRefListDeps,
} from './package-property-datatypes';

const SQL = {} as unknown as postgres.Sql;

describe('PLAN_REF_STRING_PATTERN — the D-004 ref grammar', () => {
  const re = new RegExp(PLAN_REF_STRING_PATTERN);

  it.each([
    'plan:woe-2026',
    'plan:papercusp/work-on-everything-goal-2026-08-23',
    'plan:a',
    'plan:a.b_c-d/x.y_z-w',
  ])('accepts %s', (ref) => {
    expect(re.test(ref)).toBe(true);
  });

  it.each([
    // a bare slug is indistinguishable from a goal id by shape — D-004 makes
    // the prefix mandatory
    'work-on-everything-goal-2026-08-23',
    'goal:woe',
    'plan:',
    'plan:UPPER',
    'plan:a/b/c',
    'plan:/leading-slash',
    'plan:-leading-separator',
    ' plan:padded',
  ])('rejects %s', (ref) => {
    expect(re.test(ref)).toBe(false);
  });
});

describe('planRefListPayloadSchema — what the registry will enforce on values', () => {
  it.each([[[]], [['plan:x']], [['plan:papercusp/woe', 'plan:second']]])(
    'accepts %j (an ordered list of D-004 refs)',
    (value) => {
      expect(checkAgainstJsonSchema(planRefListPayloadSchema(), value).ok).toBe(true);
    },
  );

  it.each([[[1]], [['bare-slug']], ['plan:x'], [{}]])(
    'rejects %j (non-ref entries and non-arrays never pass)',
    (value) => {
      expect(checkAgainstJsonSchema(planRefListPayloadSchema(), value).ok).toBe(false);
    },
  );
});

describe('ensurePlanRefListDatatype — insert-if-absent, never overwrite', () => {
  it('absent → upserts the datatype with the canonical id + payload schema', async () => {
    const get = vi.fn(async () => null);
    const upsert = vi.fn(async () => undefined);
    const deps = { get, upsert } as unknown as EnsurePlanRefListDeps;
    const res = await ensurePlanRefListDatatype(SQL, 'ws-1', deps);
    expect(res).toEqual({ created: true });
    expect(get).toHaveBeenCalledWith(SQL, 'ws-1', PLAN_REF_LIST_DATATYPE);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      SQL,
      expect.objectContaining({
        id: PLAN_REF_LIST_DATATYPE,
        workspaceId: 'ws-1',
        payloadSchema: planRefListPayloadSchema(),
      }),
    );
  });

  it('present → touches nothing (a P-024 display spec on the row survives every seed)', async () => {
    const get = vi.fn(async () => ({ id: PLAN_REF_LIST_DATATYPE }));
    const upsert = vi.fn(async () => undefined);
    const deps = { get, upsert } as unknown as EnsurePlanRefListDeps;
    const res = await ensurePlanRefListDatatype(SQL, 'ws-1', deps);
    expect(res).toEqual({ created: false });
    expect(upsert).not.toHaveBeenCalled();
  });
});
