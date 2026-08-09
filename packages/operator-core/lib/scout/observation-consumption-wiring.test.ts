/**
 * P-004 / WI-36774 (D-028) — the consumption stamp is WIRED ONTO THE REAL PATH.
 *
 * Kept as its own file rather than folded into `cycle-deps.test.ts` so the module
 * mock below cannot change what that suite exercises.
 *
 * ## Why this test exists at all
 *
 * Because a green unit suite for the stamping module proves nothing about whether
 * the stamp ever RUNS. That is not a hypothetical here — it is this plan's founding
 * observation (D-006, the one rule D-024 preserved while retracting the rest):
 * *"a fix that lands without an end-to-end assertion on the REAL call path is
 * indistinguishable from no fix at all, and both of these had green tests."* And
 * `buildScoutCycleDeps` — the very function under test — has shipped exactly that
 * defect twice already (EI-12361 / EI-12362: it silently omitted `deadlineMs` from
 * the deps it returned, with the unit tests green throughout).
 *
 * So this drives the REAL `buildScoutCycleDeps(...).readCorpus()` and asserts the
 * stamp is called with the ids the friction reader actually returned.
 *
 * Run: `cd packages/operator-core && npx vitest run lib/scout/observation-consumption-wiring`
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordObservationConsumption = vi.hoisted(() =>
  vi.fn(async () => ({ planned: 0, stamped: 0 })),
);
vi.mock('../harness/improvements/observation-consumption', () => ({ recordObservationConsumption }));

// getFlag OFF keeps the rubric-rail leg dormant (it is not what this pins).
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: async () => false,
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { SCOUT_RUBRIC_RAIL: 'scout-rubric-rail' } }));
vi.mock('./scout-plan-draft', () => ({ createScoutPlanDraft: vi.fn(async () => ({ slug: 's', created: true })) }));

// WI-5367: this is a UNIT suite and must never reach the box-canonical :5432.
// readCorpus fires several best-effort getOrgPg read legs plus a digest-snapshot
// WRITE; an unmocked pool silently resolves the LIVE DB and leaks fixture rows.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: (..._args: unknown[]) => Promise.resolve([] as unknown[]) }),
}));

import { buildScoutCycleDeps } from './cycle-deps';
import { makeFakeScoutLlm, fakeStateOfHiveReaders } from './test-support';
import type { ImprovementCandidate } from '../harness/improvements/policy';

const STUB_ARCHIVE = {
  listElites: async () => [],
  recordOutcome: async () => {},
} as unknown as Parameters<typeof buildScoutCycleDeps>[0]['archive'];

function frictionRow(id: string): ImprovementCandidate {
  return { id, kind: 'bug', scope: 'harness:papercup', title: `t-${id}` } as ImprovementCandidate;
}

function build(over: Record<string, unknown> = {}) {
  return buildScoutCycleDeps({
    harnessSlug: 'papercup',
    llmCall: makeFakeScoutLlm().call,
    createPlanDraft: async () => ({ slug: 'p', created: true }),
    archive: STUB_ARCHIVE,
    cycleId: 'cyc-consumption-1',
    stateOfHiveReaders: fakeStateOfHiveReaders({
      friction: async () => [frictionRow('EI-100'), frictionRow('EI-101')],
    }),
    digestOptions: { nowMs: 1_700_000_000_000 },
    noveltyCorpus: async () => [],
    ...over,
  } as Parameters<typeof buildScoutCycleDeps>[0]);
}

beforeEach(() => {
  recordObservationConsumption.mockClear();
});

describe('readCorpus → observation consumption stamp (real wiring)', () => {
  it('stamps the ids the friction reader ACTUALLY returned', async () => {
    const deps = build();
    await deps.readCorpus();

    expect(recordObservationConsumption).toHaveBeenCalledTimes(1);
    const arg = recordObservationConsumption.mock.calls[0]![0] as {
      readIds: string[];
      cycleId: string;
      digest: unknown;
    };
    // The ids must come from the reader that ran, not from a second query — a
    // re-read is a different recency window and would drift under load.
    expect(arg.readIds).toEqual(['EI-100', 'EI-101']);
    expect(arg.cycleId).toBe('cyc-consumption-1');
    expect(arg.digest).toBeTruthy();
  });

  it('skips stamping when the cycle has no cycleId (never invents provenance)', async () => {
    const deps = build({ cycleId: undefined });
    await deps.readCorpus();
    expect(recordObservationConsumption).not.toHaveBeenCalled();
  });

  it('returns a usable digest — the stamp leg never replaces the corpus read', async () => {
    const deps = build();
    const digest = await deps.readCorpus();
    expect(digest).toBeTruthy();
    expect(Array.isArray(digest.recurringFriction)).toBe(true);
  });
});
