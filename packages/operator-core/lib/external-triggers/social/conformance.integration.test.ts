import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  SOCIAL_POST_DATATYPE_ID,
  SOCIAL_POST_SCHEMA_FIXTURE,
} from './social-post-schema.fixture';

/**
 * The drift guard for `social-post-schema.fixture.ts`.
 *
 * The unit conformance runs validate emitted payloads against a LOCAL copy of
 * the canonical schema, because `validateDatatypePayload` fails open on a null
 * schema and a check that cannot fail is not a check. That local copy is a
 * second copy of a truth owned by `harness_shared.datatype_registry`, so it can
 * drift — the day someone widens the canonical social-post shape, every unit run
 * would keep validating against yesterday's schema and keep passing.
 *
 * This test is what makes that impossible to miss: it reads the row from a real
 * database and fails if the fixture no longer matches.
 */
let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});

afterAll(async () => {
  await org?.cleanup();
});

describe('social-post schema fixture', () => {
  it('matches the canonical datatype_registry row', async () => {
    const rows = await sql<Array<{ payload_schema: unknown; status: string; published: boolean }>>`
      SELECT payload_schema, status, published
        FROM harness_shared.datatype_registry
       WHERE id = ${SOCIAL_POST_DATATYPE_ID}
       LIMIT 1`;

    // A zero-row result must NOT read as "nothing to check". If the canonical
    // datatype is absent, the fixture is validating against a shape the platform
    // does not actually register, which is worse than a mismatch.
    expect(rows.length, `datatype ${SOCIAL_POST_DATATYPE_ID} is not registered — the fixture has nothing to mirror`).toBe(1);

    const row = rows[0];
    expect(row.payload_schema, 'canonical social-post row carries no payload_schema').toBeTruthy();
    expect(row.payload_schema).toEqual(SOCIAL_POST_SCHEMA_FIXTURE);
  });

  it('mirrors a datatype that is still active and published', async () => {
    // The fixture is only meaningful while the canonical datatype is the live
    // contract. A retired or unpublished datatype means the social lane is
    // validating against something the platform no longer stands behind.
    const rows = await sql<Array<{ status: string; published: boolean }>>`
      SELECT status, published
        FROM harness_shared.datatype_registry
       WHERE id = ${SOCIAL_POST_DATATYPE_ID}
       LIMIT 1`;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].published).toBe(true);
  });
});
