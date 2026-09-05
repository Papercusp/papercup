import { describe, expect, it } from 'vitest';
import {
  COUNT_EVIDENCE_COMPARISON_RULE,
  COUNT_EVIDENCE_SCHEMA_VERSION,
  compareCountContracts,
  compareCountEvidence,
  countEvidenceContractSchema,
  type CountEvidenceContract,
} from './count-evidence-contract';

const contract = (overrides: Partial<CountEvidenceContract> = {}): CountEvidenceContract => ({
  schemaVersion: COUNT_EVIDENCE_SCHEMA_VERSION,
  metric: { id: 'claimable', definition: 'rows surviving every scheduler claim floor' },
  population: {
    id: 'current-spec-work-items',
    selector: { specId: 'nonp2p', revision: 5 },
    definition: 'current issue-family rows matching the named claim spec',
  },
  cutoff: { kind: 'none' },
  status: { id: 'claimable-now', definition: 'spec match and every claim floor passes for this caller' },
  writer: { id: 'readIssueClaimability', revision: 'repeatable-read-v1' },
  unit: { id: 'work-item', definition: 'distinct canonical issue-family work-item ids' },
  exactness: { status: 'exact' },
  zeroMeaning: 'the live selector has no rows claimable for this caller at measuredAt',
  scope: { harness: 'papercusp', callerRelative: true, caller: 'su-a' },
  measuredAt: '2026-09-05T20:00:00.000Z',
  comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
  ...overrides,
});

describe('count evidence contract', () => {
  it('accepts an explicit no-cutoff contract and rejects an omitted cutoff', () => {
    expect(countEvidenceContractSchema.safeParse(contract()).success).toBe(true);
    const withoutCutoff = { ...contract() } as Record<string, unknown>;
    delete withoutCutoff.cutoff;
    expect(countEvidenceContractSchema.safeParse(withoutCutoff).success).toBe(false);
  });

  it('compares identical identities across measurement times and returns a delta', () => {
    const left = { value: 665, contract: contract() };
    const right = {
      value: 640,
      contract: contract({ measuredAt: '2026-09-05T20:10:00.000Z' }),
    };

    expect(compareCountEvidence(left, right)).toEqual({
      comparable: true,
      mismatches: [],
      comparisonRule: COUNT_EVIDENCE_COMPARISON_RULE,
      from: { value: 665, measuredAt: '2026-09-05T20:00:00.000Z' },
      to: { value: 640, measuredAt: '2026-09-05T20:10:00.000Z' },
      delta: -25,
    });
  });

  it.each([
    ['population.selector.revision', { population: { ...contract().population, selector: { specId: 'nonp2p', revision: 6 } } }],
    ['cutoff.kind', { cutoff: { kind: 'predicate', field: 'createdAt', operator: '<', value: '2026-08-30T00:00:00.000Z' } }],
    ['status.id', { status: { id: 'documented-residue', definition: 'rows retained in the audit ledger' } }],
    ['writer.id', { writer: { id: 'manual-audit-ledger' } }],
    ['unit.id', { unit: { id: 'blocker-record', definition: 'blocker evidence records' } }],
    ['scope.caller', { scope: { harness: 'papercusp', callerRelative: true, caller: 'su-b' } }],
    ['exactness.status', { exactness: { status: 'bounded', bound: 'lower', limit: 200, reason: 'source cap' } }],
  ] as const)('refuses a mismatch at %s with no numeric delta', (path, override) => {
    const result = compareCountEvidence(
      { value: 665, contract: contract() },
      { value: 234, contract: contract(override as Partial<CountEvidenceContract>) },
    );

    expect(result.comparable).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.mismatches.some((mismatch) => mismatch.path === path)).toBe(true);
    expect(result).toMatchObject({ recoverVia: expect.stringContaining('named reconciliation transform') });
  });

  it('kills the real confusion shape: fixed pre-cutoff cohort versus live no-cutoff selector', () => {
    const fixed = contract({
      metric: { id: 'documented-residue', definition: 'nonterminal rows retained by the fixed audit' },
      population: {
        id: 'fixed-audit-cohort',
        selector: { fingerprint: 'sha256:cohort', requestedIds: 234 },
        definition: 'the exact pre-2026-08-30 audit cohort',
      },
      cutoff: {
        kind: 'predicate',
        field: 'createdAt',
        operator: '<',
        value: '2026-08-30T00:00:00.000Z',
      },
      status: { id: 'documented-residue', definition: 'retained with a documented blocker' },
      writer: { id: 'work_items:burn_down/cohortAudit' },
      zeroMeaning: 'the fixed cohort has no undocumented actionable survivors',
      scope: { harness: 'papercusp', fixedCohort: true },
    });

    const result = compareCountEvidence(
      { value: 234, contract: fixed },
      { value: 665, contract: contract({ measuredAt: '2026-09-05T20:10:00.000Z' }) },
    );

    expect(result.comparable).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.mismatches.map((mismatch) => mismatch.path)).toEqual(
      expect.arrayContaining(['metric.id', 'population.id', 'cutoff.kind', 'status.id', 'writer.id']),
    );
  });

  it('fails closed on malformed contracts instead of throwing or guessing equality', () => {
    const result = compareCountContracts(contract(), { ...contract(), measuredAt: 'not-a-time' });

    expect(result.comparable).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'right.measuredAt' })]),
    );
  });
});
