/**
 * D4 — engineer-issues remote-row validator (`isEngineerIssueRow`).
 *
 * The projection's write path is exercised by engineer-issues.integration.test.ts,
 * but the DECODE gate that drops malformed REMOTE rows before they ever reach PG
 * had no isolated coverage. A federated peer (or a corrupt/old wire row) can carry
 * anything; `decodeValue` → `isEngineerIssueRow` is the floor that keeps a bad row
 * out of `harness_shared.engineer_issues`.
 *
 * Pure unit — uses the already-exported `isEngineerIssueRow` (+ `_testing.decodeValue`).
 */
import { describe, expect, it } from 'vitest';
import {
  isEngineerIssueRow,
  _testing,
  type EngineerIssueRow,
} from '../engineer-issues';

function row(over: Partial<Record<keyof EngineerIssueRow, unknown>> = {}): unknown {
  return {
    harness_slug: 'sheets',
    issue_id: 'WI-001',
    scope: 'harness:sheets',
    kind: 'bug',
    title: 'a bug',
    body: 'it broke',
    severity: 'high',
    source: 'agent',
    state: 'open',
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    payload: null,
    found_during: null,
    linked_feature_id: null,
    created_by: 'su-1',
    created_at: '2026-06-13T12:00:00.000Z',
    ...over,
  };
}

describe('D4 — isEngineerIssueRow accepts valid federated rows', () => {
  it('a fully-populated bug row', () => {
    expect(isEngineerIssueRow(row())).toBe(true);
    // decodeValue returns the row unchanged on accept.
    expect(_testing.decodeValue(row())).toEqual(row());
  });

  it('a task row with a jsonb payload object (payload is opaque — anything accepted)', () => {
    expect(isEngineerIssueRow(row({ kind: 'task', payload: { resume: { step: 3 } } }))).toBe(true);
    expect(isEngineerIssueRow(row({ payload: [1, 2, 3] }))).toBe(true);
    expect(isEngineerIssueRow(row({ payload: 'a-string-payload' }))).toBe(true);
    expect(isEngineerIssueRow(row({ payload: undefined }))).toBe(true); // → null on write
  });

  it('nullable string fields may be null OR a string', () => {
    expect(isEngineerIssueRow(row({ assignee: 'su-2', assigned_by: 'su-3', assigned_at: '2026-06-13T13:00:00Z' }))).toBe(true);
    expect(isEngineerIssueRow(row({ found_during: 'F-9', linked_feature_id: 'F-9', created_by: null }))).toBe(true);
  });
});

describe('D4 — isEngineerIssueRow rejects malformed federated rows', () => {
  it('non-object / null input', () => {
    expect(isEngineerIssueRow(null)).toBe(false);
    expect(isEngineerIssueRow(undefined)).toBe(false);
    expect(isEngineerIssueRow('a-string')).toBe(false);
    expect(isEngineerIssueRow(42)).toBe(false);
    expect(_testing.decodeValue(null)).toBeNull();
  });

  it('empty / missing demux harness_slug', () => {
    expect(isEngineerIssueRow(row({ harness_slug: '' }))).toBe(false);
    expect(isEngineerIssueRow(row({ harness_slug: undefined }))).toBe(false);
    expect(isEngineerIssueRow(row({ harness_slug: 123 }))).toBe(false);
  });

  it('empty / missing issue_id (the per-harness Hyperbee key)', () => {
    expect(isEngineerIssueRow(row({ issue_id: '' }))).toBe(false);
    expect(isEngineerIssueRow(row({ issue_id: undefined }))).toBe(false);
  });

  it('empty scope (the federation source-of-truth — must be present)', () => {
    expect(isEngineerIssueRow(row({ scope: '' }))).toBe(false);
    expect(isEngineerIssueRow(row({ scope: undefined }))).toBe(false);
    expect(isEngineerIssueRow(row({ scope: null }))).toBe(false);
  });

  it('non-string required content fields (kind / title / body / severity / source / state)', () => {
    expect(isEngineerIssueRow(row({ kind: 5 }))).toBe(false);
    expect(isEngineerIssueRow(row({ kind: undefined }))).toBe(false);
    expect(isEngineerIssueRow(row({ title: null }))).toBe(false);
    expect(isEngineerIssueRow(row({ body: 99 }))).toBe(false);
    expect(isEngineerIssueRow(row({ severity: false }))).toBe(false);
    expect(isEngineerIssueRow(row({ source: [] }))).toBe(false);
    expect(isEngineerIssueRow(row({ state: {} }))).toBe(false);
  });

  it('missing created_at, or a non-string created_at', () => {
    expect(isEngineerIssueRow(row({ created_at: undefined }))).toBe(false);
    expect(isEngineerIssueRow(row({ created_at: 1700000000000 }))).toBe(false); // epoch number, not ISO string
    expect(isEngineerIssueRow(row({ created_at: null }))).toBe(false);
  });

  it('a nullable string field set to a non-string, non-null value', () => {
    expect(isEngineerIssueRow(row({ assignee: 7 }))).toBe(false);
    expect(isEngineerIssueRow(row({ assigned_at: 1700000000000 }))).toBe(false);
    expect(isEngineerIssueRow(row({ linked_feature_id: {} }))).toBe(false);
    expect(isEngineerIssueRow(row({ created_by: 12 }))).toBe(false);
  });
});
