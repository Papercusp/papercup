import { afterEach, describe, expect, it } from 'vitest';
import type { HiveSettingRecord } from '../../hive-settings-store';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';
import type {
  FederatedGovernanceEvent,
  GovernanceEventBody,
} from './governance-federation';
import {
  bridgeFinalizationToAdmissionCertificate,
  createPlanAdmissionCertificateSource,
} from './plan-admission-certificate-source';
import {
  appendPlanAdmissionGovernanceEvent,
  planAdmissionGovernanceEventSettingKey,
  readPlanAdmissionGovernanceSnapshot,
  type PlanAdmissionGovernanceSnapshot,
  type PlanAdmissionGovernanceStoreDeps,
} from './plan-admission-governance-store';
import {
  checkPlanAdmission,
  configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource,
  configurePlanAdmissionShadowSink,
  PLAN_ADMISSION_ENFORCEMENT_ENV,
  planAdmissionEnforcementEnabled,
  type PlanAdmissionShadowObservation,
} from './plan-admission-gate';
import { PLAN_ADMISSION_DOORS } from './plan-admission-enforcement';
import type { PlanAdmissionPolicy } from './plan-admission-policy';
import type { PlanRow } from './source';

const WORKSPACE_ID = 'workspace-1';
const HARNESS_SLUG = 'harness-1';
const POT_HOME_SLUG = 'pot-home-1';
const POT_ID = 'pot-owner-authored-id';
const PLAN_REVISION = 'sha256:plan-revision-1';
const NOW = 1_700_000_000_000;
const MEMBERS = ['member-a', 'member-b', 'member-c'] as const;

const POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: 7,
  quorumBps: 5_000,
  approvalBps: 6_667,
  ratificationWindowSec: 3_600,
  materiality: Object.freeze({ maxChangedLines: 200, maxChangedItems: 3 }),
});

const rowWith = (contentHash: string) => ({ contentHash }) as unknown as PlanRow;

function federated(
  eventId: string,
  roundId: string,
  body: GovernanceEventBody,
  occurredAtMs: number,
  over: Partial<FederatedGovernanceEvent> = {},
): FederatedGovernanceEvent {
  return {
    eventId,
    potId: POT_ID,
    roundId,
    originPeerId: 'peer-1',
    occurredAtMs,
    body,
    signature: `sig-${eventId}`,
    ...over,
  };
}

function ratifiedRound(input: {
  roundId?: string;
  planRevisionHash?: string;
  policyVersion?: number;
  createdAtMs?: number;
  finalizedAtMs?: number;
} = {}): {
  round: GovernanceRound;
  votes: readonly GovernanceVoteEvent[];
  certificate: FinalizationCertificate;
  events: readonly FederatedGovernanceEvent[];
} {
  const roundId = input.roundId ?? 'round-1';
  const createdAtMs = input.createdAtMs ?? NOW - 10_000;
  const finalizedAtMs = input.finalizedAtMs ?? NOW;
  const created = createGovernanceRound({
    roundId,
    planRevisionHash: input.planRevisionHash ?? PLAN_REVISION,
    policyVersion: input.policyVersion ?? POLICY.policyVersion,
    eligibleMemberIds: [...MEMBERS],
    createdAtMs,
  });
  if (!created.ok) throw new Error(`fixture round refused: ${created.code} ${created.detail}`);

  let votes: GovernanceVoteEvent[] = [];
  MEMBERS.forEach((memberId, index) => {
    const appended = appendGovernanceVote(created.value, votes, {
      eventId: `${roundId}-vote-${index + 1}`,
      roundId,
      memberId,
      choice: 'approve',
      sequence: index + 1,
      signature: `sig-${roundId}-vote-${index + 1}`,
    });
    if (!appended.ok) throw new Error(`fixture vote refused: ${appended.code} ${appended.detail}`);
    votes = appended.value;
  });

  const finalized = finalizeGovernanceRound({
    round: created.value,
    events: votes,
    policy: POLICY,
    nowMs: finalizedAtMs,
  });
  if (!finalized.ok) {
    throw new Error(`fixture finalization refused: ${finalized.code} ${finalized.detail}`);
  }

  return {
    round: created.value,
    votes,
    certificate: finalized.value,
    events: [
      federated(`${roundId}-open`, roundId, { kind: 'round-open', round: created.value }, createdAtMs),
      ...votes.map((vote, index) =>
        federated(
          `${roundId}-vote-event-${index + 1}`,
          roundId,
          { kind: 'vote', vote },
          createdAtMs + index + 1,
        ),
      ),
      federated(
        `${roundId}-finalize`,
        roundId,
        { kind: 'finalize', certificate: finalized.value },
        finalizedAtMs,
      ),
    ],
  };
}

function settingFor(
  event: FederatedGovernanceEvent,
  over: Partial<HiveSettingRecord> = {},
): HiveSettingRecord {
  return {
    workspaceId: WORKSPACE_ID,
    potHomeSlug: POT_ID,
    settingKey: planAdmissionGovernanceEventSettingKey(event),
    value: event,
    createdAt: event.occurredAtMs,
    updatedAt: event.occurredAtMs,
    ...over,
  };
}

async function snapshotFrom(
  events: readonly FederatedGovernanceEvent[],
  extraRows: readonly HiveSettingRecord[] = [],
): Promise<PlanAdmissionGovernanceSnapshot> {
  return readPlanAdmissionGovernanceSnapshot(
    { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG },
    undefined,
    {
      resolvePotScope: async () => POT_ID,
      listSettings: async () => [...events.map((event) => settingFor(event)), ...extraRows],
    },
  );
}

function sourceFor(snapshot: PlanAdmissionGovernanceSnapshot) {
  return createPlanAdmissionCertificateSource({
    resolvePotHomeSlug: async (workspaceId, harnessSlug) => {
      expect(workspaceId).toBe(WORKSPACE_ID);
      expect(harnessSlug).toBe(HARNESS_SLUG);
      return POT_HOME_SLUG;
    },
    readSnapshot: async (input) => {
      expect(input).toEqual({ workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG });
      return snapshot;
    },
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  configurePlanAdmissionPolicySource(null);
  configurePlanAdmissionCertificateSource(null);
  configurePlanAdmissionShadowSink(null);
});

describe('plan-admission governance event store', () => {
  it('appends content-addressed immutable events, replays idempotently, and rejects event-id mutation', async () => {
    const rows: HiveSettingRecord[] = [];
    let writes = 0;
    const deps: PlanAdmissionGovernanceStoreDeps = {
      resolvePotScope: async () => POT_ID,
      listSettings: async () => [...rows],
      setSetting: async (input) => {
        writes += 1;
        const record: HiveSettingRecord = {
          workspaceId: input.workspaceId,
          potHomeSlug: POT_ID,
          settingKey: input.settingKey,
          value: input.value,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const index = rows.findIndex((row) => row.settingKey === record.settingKey);
        if (index < 0) rows.push(record);
        else rows[index] = record;
        return record;
      },
    };
    const { events } = ratifiedRound();
    const event = events[0];

    const first = await appendPlanAdmissionGovernanceEvent(
      { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event },
      undefined,
      deps,
    );
    const replay = await appendPlanAdmissionGovernanceEvent(
      { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event },
      undefined,
      deps,
    );

    expect(first.settingKey).toBe(planAdmissionGovernanceEventSettingKey(event));
    expect(replay).toEqual(first);
    expect(rows).toHaveLength(1);
    expect(writes).toBe(1);

    const mutated = { ...event, occurredAtMs: event.occurredAtMs + 1 };
    await expect(
      appendPlanAdmissionGovernanceEvent(
        { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event: mutated },
        undefined,
        deps,
      ),
    ).rejects.toThrow(`immutable conflict for event '${event.eventId}'`);
    expect(rows).toHaveLength(1);
    expect(writes).toBe(1);
  });

  it('marks divergent event ids as conflicted and reports malformed, key-mismatched, and foreign-pot rows', async () => {
    const { events } = ratifiedRound();
    const original = events[0];
    const divergent = { ...original, occurredAtMs: original.occurredAtMs + 1 };
    const foreign = { ...events[1], eventId: 'foreign', potId: 'other-pot' };
    const malformed: HiveSettingRecord = {
      workspaceId: WORKSPACE_ID,
      potHomeSlug: POT_ID,
      settingKey: 'governanceEvent.v1.malformed',
      value: { nope: true },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const keyMismatch = settingFor(events[2], {
      settingKey: 'governanceEvent.v1.wrong-digest',
    });

    const snapshot = await snapshotFrom(
      [original, divergent, foreign],
      [malformed, keyMismatch],
    );

    expect(snapshot.events.map((event) => event.eventId)).toEqual([
      original.eventId,
      divergent.eventId,
    ]);
    expect(snapshot.conflictedRoundIds).toEqual(new Set([original.roundId]));
    expect(snapshot.integrityErrors).toHaveLength(3);
    expect(snapshot.integrityErrors.join('\n')).toContain('invalid governance event');
    expect(snapshot.integrityErrors.join('\n')).toContain('content digest does not match key');
    expect(snapshot.integrityErrors.join('\n')).toContain("event belongs to pot 'other-pot'");
  });
});

describe('production plan-admission certificate source', () => {
  it('bridges a verified finalization for the exact revision and returns controls from the same round', async () => {
    const ratified = ratifiedRound();
    const source = sourceFor(await snapshotFrom(ratified.events));

    const resolved = await source.resolve({
      slug: 'plan-1',
      door: 'start',
      planRevisionHash: PLAN_REVISION,
      policy: POLICY,
      nowMs: NOW + 1,
      opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
    });

    expect(resolved.certificate).toEqual(
      bridgeFinalizationToAdmissionCertificate(
        ratified.certificate,
        POLICY.ratificationWindowSec,
      ),
    );
    expect(resolved.governance).toEqual({
      roundId: ratified.round.roundId,
      status: 'finalized',
      quarantineReason: null,
      revokedReason: null,
    });
  });

  it('lets the newest exact round control admission instead of falling back to an older certificate', async () => {
    const older = ratifiedRound({
      roundId: 'round-older',
      createdAtMs: NOW - 20_000,
      finalizedAtMs: NOW - 15_000,
    });
    const newer = createGovernanceRound({
      roundId: 'round-newer',
      planRevisionHash: PLAN_REVISION,
      policyVersion: POLICY.policyVersion,
      eligibleMemberIds: [...MEMBERS],
      createdAtMs: NOW - 1_000,
    });
    if (!newer.ok) throw new Error(`fixture newer round refused: ${newer.code} ${newer.detail}`);
    const newerOpen = federated(
      'round-newer-open',
      newer.value.roundId,
      { kind: 'round-open', round: newer.value },
      newer.value.createdAtMs,
    );
    const source = sourceFor(await snapshotFrom([...older.events, newerOpen]));

    const resolved = await source.resolve({
      slug: 'plan-1',
      door: 'promotion',
      planRevisionHash: PLAN_REVISION,
      policy: POLICY,
      nowMs: NOW,
      opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
    });

    expect(resolved.certificate).toBeNull();
    expect(resolved.governance).toEqual({
      roundId: 'round-newer',
      status: 'open',
      quarantineReason: null,
      revokedReason: null,
    });
  });
});

describe('real governance certificates at the common seven-door gate', () => {
  it('admits every lifecycle door with the production source and refuses every door for an unratified revision', async () => {
    const ratified = ratifiedRound();
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(
      sourceFor(await snapshotFrom(ratified.events)),
    );
    const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG };

    const admitted = await Promise.all(
      PLAN_ADMISSION_DOORS.map((door) =>
        checkPlanAdmission({
          slug: 'plan-1',
          door,
          row: rowWith(PLAN_REVISION),
          nowMs: NOW + 1,
          opts,
        }),
      ),
    );
    expect(admitted).toHaveLength(PLAN_ADMISSION_DOORS.length);
    expect(admitted.every((verdict) => verdict.admitted && verdict.skipped === undefined)).toBe(true);
    expect(
      admitted.map((verdict) =>
        verdict.admitted && verdict.skipped === undefined
          ? verdict.certificate.certificateHash
          : null,
      ),
    ).toEqual(PLAN_ADMISSION_DOORS.map(() => ratified.certificate.certificateHash));

    const refused = await Promise.all(
      PLAN_ADMISSION_DOORS.map((door) =>
        checkPlanAdmission({
          slug: 'plan-1',
          door,
          row: rowWith('sha256:unratified-revision'),
          nowMs: NOW + 1,
          opts,
        }),
      ),
    );
    expect(
      refused.map((verdict) =>
        verdict.admitted
          ? null
          : { door: verdict.refusal.door, code: verdict.refusal.code },
      ),
    ).toEqual(
      PLAN_ADMISSION_DOORS.map((door) => ({
        door,
        code: 'missing-certificate',
      })),
    );
  });

  it('keeps enforcement default-on and turns the same seven typed refusals into shadow observations only when the kill switch is explicitly off', async () => {
    expect(planAdmissionEnforcementEnabled({})).toBe(true);
    expect(
      planAdmissionEnforcementEnabled({
        [PLAN_ADMISSION_ENFORCEMENT_ENV]: 'off',
      }),
    ).toBe(false);

    const previous = process.env[PLAN_ADMISSION_ENFORCEMENT_ENV];
    const observations: PlanAdmissionShadowObservation[] = [];
    try {
      process.env[PLAN_ADMISSION_ENFORCEMENT_ENV] = 'off';
      configurePlanAdmissionPolicySource(async () => POLICY);
      configurePlanAdmissionCertificateSource(
        sourceFor(await snapshotFrom([])),
      );
      configurePlanAdmissionShadowSink({
        record: (observation) => void observations.push(observation),
      });

      const verdicts = await Promise.all(
        PLAN_ADMISSION_DOORS.map((door) =>
          checkPlanAdmission({
            slug: 'plan-1',
            door,
            row: rowWith(PLAN_REVISION),
            nowMs: NOW,
            opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
          }),
        ),
      );

      expect(verdicts.every((verdict) => verdict.admitted && verdict.skipped === 'shadow-mode')).toBe(true);
      expect(observations.map(({ door, wouldAdmit, code }) => ({ door, wouldAdmit, code }))).toEqual(
        PLAN_ADMISSION_DOORS.map((door) => ({
          door,
          wouldAdmit: false,
          code: 'missing-certificate',
        })),
      );
    } finally {
      restoreEnv(PLAN_ADMISSION_ENFORCEMENT_ENV, previous);
    }
  });
});
