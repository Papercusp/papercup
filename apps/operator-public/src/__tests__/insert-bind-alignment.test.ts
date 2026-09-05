/**
 * insert-bind-alignment.test.ts — the alignment guard between db.ts's
 * `insertHarness()` and the fake-d1 test double.
 *
 * WHY THIS EXISTS
 * ---------------
 * `insertHarness()` writes the `harnesses` row with a POSITIONAL prepared
 * statement: an explicit column list, a `VALUES (?, ?, …)` row, and a `.bind(…)`
 * argument list that must line up with both. From migration 004 to 017 the fake
 * D1 used by the route tests re-implemented that write by DESTRUCTURING the same
 * bind array positionally — two separate source files with no compiler-visible
 * link, so a column added mid-list in one and not the other shifted every later
 * field by one.
 *
 * That is not hypothetical. On 2026-08-21 migration 015 added `requires_rubrics`
 * after `requires_events` in db.ts, the fake was not updated, and every field
 * from position 20 on shifted: `hive_pubkey` took requires_rubrics' null,
 * `blueprint_kind` took hive_title, and `review_status` took blueprint_kind and
 * fell back to its 'approved' default — silently disabling the publish REVIEW
 * GATE in every test that exercised it. Twelve assertions went red pointing at
 * blueprint/hive/review work that was entirely innocent.
 *
 * WHAT CHANGED (shared-pot-dao-cupboard-v1-2026-09-04 P-008)
 * ----------------------------------------------------------
 * The original guard here compared ARITY: it asserted the two lists were the
 * same length, so a mid-list insertion failed HERE naming the real cause. That
 * was a policing measure, and it had two holes it could not close — a same-arity
 * RENAME or REORDER passed it, and it only ever fired after someone had already
 * written the shifted code.
 *
 * Migration 018 added thirteen more columns, which was the second time this trap
 * was armed. Rather than re-arm it, fake-d1 now maps binds BY NAME: it reads the
 * column list out of the statement it is handed (`mapInsertBindsByName`) and
 * pairs each column with its own value, so db.ts can add, reorder, or rename a
 * column and the fake follows automatically. The coupling is gone rather than
 * guarded — the follow-up this file's own header filed in 2026-08-21.
 *
 * So this file no longer counts anything. It asserts the two properties that
 * REPLACED the count, either of which failing would bring the shift class back:
 *
 *   1. fake-d1 does not positionally destructure the bind array (a regression to
 *      `const [ … ] = binds` would silently reintroduce the whole class).
 *   2. Every column insertHarness writes ARRIVES UNDER ITS OWN NAME carrying its
 *      own value — checked end-to-end through the real statement, with distinct
 *      sentinel values so a swapped pair cannot pass. This is strictly stronger
 *      than arity: it catches the rename and the reorder that arity could not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertHarness } from '../db.ts';
import { mapInsertBindsByName } from './fake-d1.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Subject path is overridable so falsifiability can be PROVEN against a copy
// (repo mutation-probe tier 2) instead of by mutating this shared checkout:
//   PROBE_FAKE_D1=/tmp/fake-d1-BROKEN.ts npm run test:file -- <this file>
const FAKE_D1_TS = process.env.PROBE_FAKE_D1 || join(__dirname, './fake-d1.ts');

/** Capture the exact SQL + binds insertHarness() emits, without a database. */
function captureInsert(): Promise<{ sql: string; binds: unknown[] }> {
  return new Promise((resolve) => {
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async run() {
                resolve({ sql, binds });
                return { success: true as const };
              },
            };
          },
        };
      },
    };
    void insertHarness(db as unknown as D1Database, {
      id: 'v-id',
      listing_kind: 'plugin',
      project_ref: 'v-project_ref',
      listing_ref: 'v-listing_ref',
      github_repository_id: 101,
      github_owner: 'v-github_owner',
      github_name: 'v-github_name',
      github_url: 'v-github_url',
      title: 'v-title',
      description: 'v-description',
      topic_hex: 'v-topic_hex',
      publisher_github_user_id: 102,
      publisher_github_login: 'v-publisher_github_login',
      publisher_permission: 'v-publisher_permission',
      publisher_device_pubkey: 'v-publisher_device_pubkey',
      publisher_attestation_gist_id: 'v-publisher_attestation_gist_id',
      provides_tools: 'v-provides_tools',
      provides_events: 'v-provides_events',
      requires_events: 'v-requires_events',
      requires_rubrics: 'v-requires_rubrics',
      hive_pubkey: 'v-hive_pubkey',
      hive_title: 'v-hive_title',
      blueprint_kind: 'v-blueprint_kind',
      review_status: 'pending',
      delivery_type: 'bundle',
      latest_json_url: 'v-latest_json_url',
      release_repo: 'v-release_repo',
      icon_url: 'v-icon_url',
      platforms: 'v-platforms',
      visibility: 'private',
      tenant_id: 'v-tenant_id',
      sku_ref: 'v-sku_ref',
      pricing_model: 'per-use',
      price_amount_micros: 103,
      price_currency: 'v-price_currency',
      compatibility_json: 'v-compatibility_json',
      required_permissions: 'v-required_permissions',
      release_version: 'v-release_version',
      release_content_hash: 'v-release_content_hash',
      release_manifest_digest: 'v-release_manifest_digest',
      release_signature: 'v-release_signature',
      release_published_at: 104,
      created_at: 105,
    });
  });
}

describe('insertHarness ↔ fake-d1 bind alignment', () => {
  it('fake-d1 maps binds BY NAME, not by position', () => {
    const fakeSource = readFileSync(FAKE_D1_TS, 'utf8');
    const branchAt = fakeSource.indexOf("startsWith('INSERT INTO HARNESSES')");
    expect(branchAt, 'could not locate the INSERT branch in fake-d1.ts').toBeGreaterThan(-1);
    // Bound the slice at the branch's OWN `return 1;`. A fixed character window
    // would run past it into the next branch — whose legitimate positional
    // destructure would then trip this assertion and report a defect that is not
    // there, in the file whose whole point is telling a real shift from a false
    // alarm.
    const branchEnd = fakeSource.indexOf('return 1;', branchAt);
    expect(branchEnd, 'could not bound the INSERT branch').toBeGreaterThan(branchAt);
    const branch = fakeSource.slice(branchAt, branchEnd);
    expect(
      /const\s*\[[\s\S]*?\]\s*=\s*binds/.test(branch),
      'fake-d1.ts has gone back to destructuring the harnesses INSERT binds positionally. ' +
        'That reintroduces the silent field-shift class migration 015 hit: a column added, ' +
        'renamed, or reordered in db.ts then lands in the WRONG column while every test keeps ' +
        'passing. Map binds by name via mapInsertBindsByName(sql, binds) instead.',
    ).toBe(false);
    expect(
      branch.includes('mapInsertBindsByName'),
      'fake-d1.ts no longer calls mapInsertBindsByName in its harnesses INSERT branch.',
    ).toBe(true);
  });

  it('every column insertHarness writes arrives under its own name', async () => {
    const { sql, binds } = await captureInsert();

    // Guards a vacuous pass: a statement that lost its columns, or an extractor
    // that silently returned {}, would let the per-column loop below assert
    // nothing at all.
    const columns = /INSERT\s+INTO\s+harnesses\s*\(([^)]*)\)/i.exec(sql)?.[1];
    expect(columns, 'could not locate the harnesses INSERT column list').toBeTruthy();
    const columnNames = (columns as string).split(',').map((c) => c.trim()).filter(Boolean);
    expect(columnNames.length).toBeGreaterThan(30);
    expect(binds.length).toBeGreaterThan(30);

    const row = mapInsertBindsByName(sql, binds);
    expect(Object.keys(row).sort()).toEqual([...columnNames].sort());

    // Every sentinel is DISTINCT, so a swapped pair of same-typed columns fails
    // here — the failure mode a length comparison is blind to by construction.
    expect(row).toMatchObject({
      id: 'v-id',
      listing_kind: 'plugin',
      project_ref: 'v-project_ref',
      listing_ref: 'v-listing_ref',
      github_repository_id: 101,
      github_owner: 'v-github_owner',
      github_name: 'v-github_name',
      github_url: 'v-github_url',
      title: 'v-title',
      description: 'v-description',
      topic_hex: 'v-topic_hex',
      publisher_github_user_id: 102,
      publisher_github_login: 'v-publisher_github_login',
      publisher_permission: 'v-publisher_permission',
      publisher_device_pubkey: 'v-publisher_device_pubkey',
      publisher_attestation_gist_id: 'v-publisher_attestation_gist_id',
      provides_tools: 'v-provides_tools',
      provides_events: 'v-provides_events',
      requires_events: 'v-requires_events',
      requires_rubrics: 'v-requires_rubrics',
      hive_pubkey: 'v-hive_pubkey',
      hive_title: 'v-hive_title',
      blueprint_kind: 'v-blueprint_kind',
      review_status: 'pending',
      delivery_type: 'bundle',
      latest_json_url: 'v-latest_json_url',
      release_repo: 'v-release_repo',
      icon_url: 'v-icon_url',
      platforms: 'v-platforms',
      // migration 018 catalog axes
      visibility: 'private',
      tenant_id: 'v-tenant_id',
      sku_ref: 'v-sku_ref',
      pricing_model: 'per-use',
      price_amount_micros: 103,
      price_currency: 'v-price_currency',
      compatibility_json: 'v-compatibility_json',
      required_permissions: 'v-required_permissions',
      release_version: 'v-release_version',
      release_content_hash: 'v-release_content_hash',
      release_manifest_digest: 'v-release_manifest_digest',
      release_signature: 'v-release_signature',
      release_published_at: 104,
      // written as a SQL literal, not a bind — the reason a naive
      // `columns[i] = binds[i]` zip would be off by one from here on.
      claim_status: 'unclaimed',
      created_at: 105,
      updated_at: 105,
    });
  });

  it('mapInsertBindsByName refuses a statement whose placeholders and binds disagree', () => {
    // The extractor must FAIL LOUD rather than silently drop or invent a column
    // — a quiet mismatch here would be the very defect this file exists to stop.
    const sql = 'INSERT INTO harnesses (a, b, c) VALUES (?, ?, ?)';
    expect(() => mapInsertBindsByName(sql, [1, 2])).toThrow(/more binds/);
    expect(() => mapInsertBindsByName(sql, [1, 2, 3, 4])).toThrow(/consumed 3 of 4/);
    expect(() => mapInsertBindsByName('SELECT 1', [])).toThrow(/unparseable/);
  });
});
