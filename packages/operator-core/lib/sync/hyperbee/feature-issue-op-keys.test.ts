/**
 * feature-issue-op-keys.test.ts — Stage 2 of the feature-content federation plan
 * (papercusp-feature-content-federation-2026-06-01).
 *
 * Pure unit tests for the row→op mappers that turn a `substrate_outbox` row
 * (captured by the Stage-1 trigger as `to_jsonb` of the full consolidated row)
 * into a `LocalWriteOp` the existing `harness-features` / `issues` read-side
 * projections consume verbatim.
 *
 * The two load-bearing correctness facts these tests pin:
 *
 *  (1) `LocalWriteOp.table` must equal the projection's REGISTERED tableTag —
 *      `'features-by-id'` for features, `'issues'` for issues (see
 *      `projections/harness-features.ts` + `issues.ts`). NOT the raw
 *      `harness_*_consolidated` table_name. If this drifts, `applyOpVia`'s
 *      `lookup(op.table)` returns null and the op is silently dropped on peers.
 *
 *  (2) `to_jsonb` of a row renders TIMESTAMPTZ columns as ISO strings, but the
 *      projection's row validators (`isHarnessFeatureRow` / `isHarnessIssueRow`)
 *      require those fields to be epoch-ms NUMBERS (`taken_at`/`expires_at` on
 *      features, `found_at` on issues). The mapper MUST convert them, else the
 *      projection's `decodeValue` rejects the op and federation silently breaks.
 *
 * These tests assert the produced `value` field-for-field AND prove it passes
 * the real projection validators, so a future projection-shape change that the
 * mapper doesn't track fails here.
 */
import { describe, it, expect } from 'vitest';
import {
  composeFeatureKey,
  composeIssueKey,
  outboxRowToLocalWriteOp,
  UnknownOutboxTableError,
  type OutboxRow,
} from './feature-issue-op-keys';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { isHarnessFeatureRow, type HarnessFeatureRow } from './projections/harness-features';
import { isHarnessIssueRow, type HarnessIssueRow } from './projections/issues';
import { isContributorUsageEventRow, type ContributorUsageEventRow } from './projections/usage';
import { isEngineerIssueRow, type EngineerIssueRow } from './projections/engineer-issues';

describe('composeFeatureKey / composeIssueKey', () => {
  it('composeFeatureKey is the feature_id itself (matches projection composeKey)', () => {
    expect(composeFeatureKey('F-001')).toBe('F-001');
    expect(composeFeatureKey('F-FIX-42')).toBe('F-FIX-42');
  });

  it('composeIssueKey is the issue_id itself (matches projection composeKey)', () => {
    expect(composeIssueKey('I-001')).toBe('I-001');
    expect(composeIssueKey('I-007')).toBe('I-007');
  });

  it('is deterministic — same id → same key', () => {
    expect(composeFeatureKey('F-001')).toBe(composeFeatureKey('F-001'));
    expect(composeIssueKey('I-001')).toBe(composeIssueKey('I-001'));
  });
});

describe('outboxRowToLocalWriteOp — features', () => {
  // A `to_jsonb` rendering of a features_consolidated row. Note:
  //  - BIGINT columns (ts/created_ts/updated_ts/attempts/expected_cost_cents)
  //    arrive as numbers (the prod-faithful client parses BIGINT→number).
  //  - TIMESTAMPTZ columns (taken_at/expires_at) arrive as ISO strings.
  const featureOutboxRow: OutboxRow = {
    table_name: 'harness_features_consolidated',
    op: 'put',
    key: 'F-001',
    ts: 1717000000000,
    row: {
      workspace_id: 'ws_demo',
      harness_slug: 'demo',
      feature_id: 'F-001',
      title: 'Build the thing',
      summary: 'a summary',
      status: 'in_progress',
      attempts: 2,
      claims: null,
      notes: 'some notes',
      metadata: { foo: 'bar' },
      kind: 'task',
      project_id: 'P-9',
      expected_cost_cents: 1500,
      tags: ['a', 'b'],
      needs_human_review: false,
      ts: 1717000000000,
      created_ts: 1716000000000,
      updated_ts: 1717000000000,
      parent_id: null,
      goal_id: 'G-1',
      taken_by: 'alice',
      taken_at: '2024-05-29T12:00:00.000Z',
      expires_at: '2024-05-29T13:00:00.000Z',
      author_pubkey: 'deadbeef',
      origin: 'local',
    },
  };

  it('maps a put to LocalWriteOp with table="features-by-id", hbKey=feature_id', () => {
    const op = outboxRowToLocalWriteOp(featureOutboxRow);
    expect(op).not.toBeNull();
    expect(op!.type).toBe('put');
    expect(op!.table).toBe('features-by-id');
    expect(op!.hbKey).toBe('F-001');
    expect(op!.ts).toBe(1717000000000);
    expect(op!.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('produces a value that is field-for-field a valid HarnessFeatureRow', () => {
    const op = outboxRowToLocalWriteOp(featureOutboxRow)!;
    const value = op.value as HarnessFeatureRow;
    // The projection's own validator must accept it — the real gate on peers.
    expect(isHarnessFeatureRow(value)).toBe(true);
    expect(value).toEqual({
      harness_slug: 'demo',
      feature_id: 'F-001',
      title: 'Build the thing',
      summary: 'a summary',
      status: 'in_progress',
      attempts: 2,
      claims: null,
      notes: 'some notes',
      metadata: { foo: 'bar' },
      kind: 'task',
      project_id: 'P-9',
      expected_cost_cents: 1500,
      tags: ['a', 'b'],
      needs_human_review: false,
      ts: 1717000000000,
      created_ts: 1716000000000,
      updated_ts: 1717000000000,
      parent_id: null,
      goal_id: 'G-1',
      taken_by: 'alice',
      // TIMESTAMPTZ ISO strings converted back to epoch ms.
      taken_at: Date.parse('2024-05-29T12:00:00.000Z'),
      expires_at: Date.parse('2024-05-29T13:00:00.000Z'),
    });
  });

  it('converts null TIMESTAMPTZ fields to null (not NaN)', () => {
    const op = outboxRowToLocalWriteOp({
      ...featureOutboxRow,
      row: { ...featureOutboxRow.row, taken_at: null, expires_at: null },
    })!;
    const value = op.value as HarnessFeatureRow;
    expect(value.taken_at).toBeNull();
    expect(value.expires_at).toBeNull();
    expect(isHarnessFeatureRow(value)).toBe(true);
  });

  it('maps a del to a LocalWriteOp with no value (just the key)', () => {
    const op = outboxRowToLocalWriteOp({
      ...featureOutboxRow,
      op: 'del',
      row: null,
    })!;
    expect(op.type).toBe('del');
    expect(op.table).toBe('features-by-id');
    expect(op.hbKey).toBe('F-001');
    expect(op.value).toBeUndefined();
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('outboxRowToLocalWriteOp — issues', () => {
  const issueOutboxRow: OutboxRow = {
    table_name: 'harness_issues_consolidated',
    op: 'put',
    key: 'I-001',
    ts: 1717000000000,
    row: {
      workspace_id: 'ws_demo',
      harness_slug: 'demo',
      issue_id: 'I-001',
      title: 'Crash on save',
      severity: 'high',
      source: 'manual',
      status: 'open',
      found_at: '2024-05-29T12:00:00.000Z',
      found_during: 'F-001',
      repro: 'click save',
      evidence: 'stacktrace',
      suggested_fix: null,
      code_pointer: 'foo.ts:10',
      linked_feature_id: 'F-FIX-1',
      attempts: 0,
      notes: [{ ts: 1, text: 'hi' }],
      created_ts: 1716000000000,
      updated_ts: 1717000000000,
      author_pubkey: 'deadbeef',
      origin: 'local',
    },
  };

  it('maps a put to LocalWriteOp with table="issues", hbKey=issue_id', () => {
    const op = outboxRowToLocalWriteOp(issueOutboxRow)!;
    expect(op.type).toBe('put');
    expect(op.table).toBe('issues');
    expect(op.hbKey).toBe('I-001');
    expect(op.ts).toBe(1717000000000);
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('produces a value that is field-for-field a valid HarnessIssueRow', () => {
    const op = outboxRowToLocalWriteOp(issueOutboxRow)!;
    const value = op.value as HarnessIssueRow;
    expect(isHarnessIssueRow(value)).toBe(true);
    expect(value).toEqual({
      harness_slug: 'demo',
      issue_id: 'I-001',
      title: 'Crash on save',
      severity: 'high',
      source: 'manual',
      status: 'open',
      // TIMESTAMPTZ ISO string converted to epoch ms.
      found_at: Date.parse('2024-05-29T12:00:00.000Z'),
      found_during: 'F-001',
      repro: 'click save',
      evidence: 'stacktrace',
      suggested_fix: null,
      code_pointer: 'foo.ts:10',
      linked_feature_id: 'F-FIX-1',
      attempts: 0,
      notes: [{ ts: 1, text: 'hi' }],
      created_ts: 1716000000000,
      updated_ts: 1717000000000,
    });
  });

  it('maps a del to a LocalWriteOp with no value (just the key)', () => {
    const op = outboxRowToLocalWriteOp({
      ...issueOutboxRow,
      op: 'del',
      row: null,
    })!;
    expect(op.type).toBe('del');
    expect(op.table).toBe('issues');
    expect(op.hbKey).toBe('I-001');
    expect(op.value).toBeUndefined();
  });
});

describe('outboxRowToLocalWriteOp — contributor usage events (P-070 federation)', () => {
  // `to_jsonb` of a contributor_usage_events row: the append-only ledger. `ts`
  // is TIMESTAMPTZ → ISO string; github_user_id/schema_version are BIGINT.
  const usageOutboxRow: OutboxRow = {
    table_name: 'contributor_usage_events',
    op: 'put',
    key: '01HXEVENTID0000000000000AB',
    ts: 1717000000000,
    row: {
      harness_slug: 'demo',
      event_id: '01HXEVENTID0000000000000AB',
      github_user_id: 42,
      device_pubkey: 'PK==',
      kind: 'feature_authored',
      ref_id: 'F-1',
      payload: { title: 'x' },
      ts: '2024-05-29T12:00:00.000Z',
      schema_version: 1,
      origin: 'local',
    },
  };

  it('maps a put to LocalWriteOp with table="usage", hbKey=event_id', () => {
    const op = outboxRowToLocalWriteOp(usageOutboxRow)!;
    expect(op.type).toBe('put');
    expect(op.table).toBe('usage');
    expect(op.hbKey).toBe('01HXEVENTID0000000000000AB');
    expect(op.ts).toBe(1717000000000);
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('produces a value that is a valid ContributorUsageEventRow (ts ISO → epoch ms)', () => {
    const op = outboxRowToLocalWriteOp(usageOutboxRow)!;
    const value = op.value as ContributorUsageEventRow;
    expect(isContributorUsageEventRow(value)).toBe(true);
    expect(value).toEqual({
      harness_slug: 'demo',
      event_id: '01HXEVENTID0000000000000AB',
      github_user_id: 42,
      device_pubkey: 'PK==',
      kind: 'feature_authored',
      ref_id: 'F-1',
      payload: { title: 'x' },
      ts: Date.parse('2024-05-29T12:00:00.000Z'),
      schema_version: 1,
    });
  });

  it('accepts ts already as an epoch-ms number (idempotent) + null ref_id', () => {
    const op = outboxRowToLocalWriteOp({
      ...usageOutboxRow,
      row: { ...usageOutboxRow.row, ts: 1717000000000, ref_id: null },
    })!;
    const value = op.value as ContributorUsageEventRow;
    expect(value.ts).toBe(1717000000000);
    expect(value.ref_id).toBeNull();
    expect(isContributorUsageEventRow(value)).toBe(true);
  });

  it('maps a del to a LocalWriteOp with no value (append-only → still keyed)', () => {
    const op = outboxRowToLocalWriteOp({ ...usageOutboxRow, op: 'del', row: null })!;
    expect(op.type).toBe('del');
    expect(op.table).toBe('usage');
    expect(op.hbKey).toBe('01HXEVENTID0000000000000AB');
    expect(op.value).toBeUndefined();
  });
});

describe('outboxRowToLocalWriteOp — engineer_issues (B5 work-queue federation)', () => {
  // A to_jsonb rendering of an engineer_issues row, WITH the capture-stamped
  // harness_slug (mig 197 derives it from `scope` and adds it to the row jsonb).
  // assigned_at/created_at are TIMESTAMPTZ → ISO strings under to_jsonb.
  const engineerIssueOutboxRow: OutboxRow = {
    table_name: 'engineer_issues',
    op: 'put',
    key: 'EI-10',
    ts: 1717000000000,
    row: {
      harness_slug: 'papercup', // stamped by the capture trigger
      issue_id: 'EI-10',
      scope: 'harness:papercup',
      kind: 'task',
      title: 'delegated work',
      body: 'do the thing',
      severity: 'minor',
      source: 'engineer',
      state: 'open',
      assignee: 'su-abc',
      assigned_by: 'operator',
      assigned_at: '2026-06-08T12:00:00.000Z',
      payload: { agentSessionId: 'sess-1', backend: 'claude-code' },
      found_during: null,
      linked_feature_id: null,
      created_by: 'queen',
      created_at: '2026-06-08T11:59:00.000Z',
      origin: 'local',
    },
  };

  it('maps to the engineer-issues tableTag (NOT the raw table_name)', () => {
    const op = outboxRowToLocalWriteOp(engineerIssueOutboxRow);
    expect(op.table).toBe('engineer-issues');
    expect(op.hbKey).toBe('EI-10');
  });

  it('produces a value that passes isEngineerIssueRow, preserving scope/kind/payload + the stamped harness_slug', () => {
    const op = outboxRowToLocalWriteOp(engineerIssueOutboxRow)!;
    const v = op.type === 'put' ? (op.value as EngineerIssueRow) : (null as never);
    expect(isEngineerIssueRow(v)).toBe(true);
    expect(v.harness_slug).toBe('papercup');
    expect(v.scope).toBe('harness:papercup');
    expect(v.kind).toBe('task');
    expect(v.assigned_at).toBe('2026-06-08T12:00:00.000Z'); // ISO preserved (PG casts on insert)
    expect(v.created_at).toBe('2026-06-08T11:59:00.000Z');
    expect(v.payload).toEqual({ agentSessionId: 'sess-1', backend: 'claude-code' });
  });

  it('maps a del to a keyed LocalWriteOp with no value', () => {
    const op = outboxRowToLocalWriteOp({ ...engineerIssueOutboxRow, op: 'del', row: null });
    expect(op.type).toBe('del');
    expect(op.table).toBe('engineer-issues');
    expect(op.hbKey).toBe('EI-10');
    expect(op.value).toBeUndefined();
  });
});

describe('outboxRowToLocalWriteOp — error handling', () => {
  it('throws UnknownOutboxTableError on an unknown table_name (the drain skips this class — forward-compat)', () => {
    let caught: unknown;
    try {
      outboxRowToLocalWriteOp({
        table_name: 'harness_unknown_consolidated',
        op: 'put',
        key: 'X-1',
        ts: 1,
        row: { harness_slug: 'demo', feature_id: 'X-1' },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownOutboxTableError);
    expect((caught as UnknownOutboxTableError).tableName).toBe('harness_unknown_consolidated');
    expect((caught as Error).message).toMatch(/unknown.*table/i);
  });

  it('a put accepts found_at/taken_at already given as epoch-ms numbers (idempotent)', () => {
    // Defensive: if a future client parses TIMESTAMPTZ → epoch ms directly, the
    // mapper must not double-convert. A number passes through unchanged.
    const op = outboxRowToLocalWriteOp({
      table_name: 'harness_issues_consolidated',
      op: 'put',
      key: 'I-NUM',
      ts: 5,
      row: {
        harness_slug: 'demo',
        issue_id: 'I-NUM',
        title: 'x',
        severity: 'low',
        source: 'manual',
        status: 'open',
        found_at: 1717000000000,
        attempts: 0,
        notes: [],
        created_ts: 1,
        updated_ts: 1,
        origin: 'local',
      },
    })!;
    const value = op.value as HarnessIssueRow;
    expect(value.found_at).toBe(1717000000000);
    expect(isHarnessIssueRow(value)).toBe(true);
  });
});
