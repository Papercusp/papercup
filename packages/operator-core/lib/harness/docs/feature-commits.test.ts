import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../completion-ref-types', () => ({ isCompletionRef: vi.fn() }));

import { makeFeatureCommitLookup } from './feature-commits';
import { isCompletionRef } from '../completion-ref-types';

const mockedIsCompletionRef = vi.mocked(isCompletionRef);

describe('makeFeatureCommitLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsCompletionRef.mockReturnValue(true);
  });

  it('returns the recorded commit sha when the feature has a valid completion_ref', async () => {
    sqlMock.mockResolvedValue([{ completion_ref: { commit_sha: 'deadbeef' } }]);
    const lookup = makeFeatureCommitLookup('my-harness', 'ws-1');
    expect(await lookup('F-001')).toEqual(['deadbeef']);
  });

  it('returns [] when the feature is unknown (no rows)', async () => {
    sqlMock.mockResolvedValue([]);
    const lookup = makeFeatureCommitLookup('my-harness', 'ws-1');
    expect(await lookup('F-404')).toEqual([]);
  });

  it('returns [] when the completion_ref fails the type guard', async () => {
    sqlMock.mockResolvedValue([{ completion_ref: { not: 'a ref' } }]);
    mockedIsCompletionRef.mockReturnValue(false);
    const lookup = makeFeatureCommitLookup('h', 'ws');
    expect(await lookup('F-1')).toEqual([]);
  });

  it('returns [] when a valid completion_ref carries no commit_sha (unresolved, never a false verdict)', async () => {
    sqlMock.mockResolvedValue([{ completion_ref: { commit_sha: '' } }]);
    const lookup = makeFeatureCommitLookup('h', 'ws');
    expect(await lookup('F-1')).toEqual([]);
  });

  it('binds the query to workspace, harness, and feature ref', async () => {
    sqlMock.mockResolvedValue([]);
    const lookup = makeFeatureCommitLookup('harness-x', 'ws-9');
    await lookup('F-042');
    // tagged-template call: sql(strings, workspaceId, harnessSlug, ref)
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(['ws-9', 'harness-x', 'F-042']);
  });
});
