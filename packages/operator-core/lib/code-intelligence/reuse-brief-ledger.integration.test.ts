import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { recordReuseBriefIssued, reuseIssuedSubjects, type ReuseIssuedRecord } from './reuse-brief-ledger';
import type { ReuseProviderObservation } from './reuse-brief-providers';

let fx: PlanPgFixture;
beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 180_000);
afterAll(async () => { await fx?.dispose(); });
const owner = 'reuse-brief-ledger-fixture';
const row = (provider: ReuseProviderObservation['provider'], status: ReuseProviderObservation['status'] = 'issued'): ReuseProviderObservation => ({
  provider, status, reason: 'complete', chars: status === 'issued' ? 100 : 0, sourceVersion: 'blob-v1', indexVersion: 'index-v2', citedPaths: ['target.ts'],
});
const input = (invocation = 'real-fixture-dispatch'): ReuseIssuedRecord => ({ context: { workspaceId: fx.workspaceId,
  owner, invocation, surface: 'claim', workItem: 'WI-fixture', plan: 'fixture-plan', planItems: ['P-009'],
  paths: ['target.ts'], sourceVersion: 'blob-v1' }, observations: [row('clones'), row('sql')],
  recover: { tool: 'work_items:get', args: { id: 'WI-fixture' } } });
describe('P009 existing issued-only PG ledger', () => {
  it('persists separate versioned sources, dedupes a retry and retains another dispatch independently', async () => {
    await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${fx.workspaceId}, ${owner}, 'actual-fixture-turn')`;
    const record = input(), signal = new AbortController().signal;
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    expect(await recordReuseBriefIssued(input('second-fixture-dispatch'), signal)).toBe(true);
    const rows = await fx.admin`SELECT owner_id, turn_id, leg, subject, cited_paths, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} ORDER BY id`;
    expect(rows).toHaveLength(4);
    expect(rows.map(r => JSON.parse(r.subject).provider)).toEqual(['clones', 'sql', 'clones', 'sql']);
    expect(rows.every(r => r.turn_id === 'actual-fixture-turn' && r.chars === 100)).toBe(true);
    expect(JSON.parse(rows[0]!.subject)).toMatchObject({ surface: 'claim', invocation: 'real-fixture-dispatch',
      workItem: 'WI-fixture', planItems: ['P-009'], sourceVersion: 'blob-v1', indexVersion: 'index-v2', outcome: 'complete' });
  });
  it('does not persist unknown/no-match/budget outcomes, invent turns or issue cancelled facts', async () => {
    const record = input('non-issued');
    record.observations = [row('coverage', 'unknown'), row('provenance', 'no-match'), row('cochange', 'budget')];
    expect(reuseIssuedSubjects(record)).toEqual([]);
    expect(await recordReuseBriefIssued(record, new AbortController().signal)).toBe(true);
    const noTurn = input('missing-turn'); noTurn.context.owner = 'no-turn-fixture';
    expect(await recordReuseBriefIssued(noTurn, new AbortController().signal)).toBe(false);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await recordReuseBriefIssued(input('cancelled'), cancelled.signal)).toBe(false);
    const rows = await fx.admin`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}`;
    expect(rows).toHaveLength(4);
    const turns = await fx.admin`SELECT owner_id FROM harness_shared.identity_hook_turns
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = 'no-turn-fixture'`;
    expect(turns).toEqual([]);
  });
});
