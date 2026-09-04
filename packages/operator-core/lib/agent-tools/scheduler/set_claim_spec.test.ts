/**
 * Unit tests for the inert-spec advisory (set_claim_spec.ts).
 *
 * su-loop-capability-parity-2026-07-03 P-003(b): the advisory used to warn 'INERT spec'
 * for ANY spawned role that wasn't in {bee, queen} — a FALSE-POSITIVE on every SU fleet
 * member (which, post-P-001, self-pulls via scheduler:get_next). The fix inverts the check
 * to an allowlist of the coding-FACTORY push-pipeline roles, so ONLY a genuine factory
 * push-role trips it. These assertions pin that role-awareness.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import setClaimSpecTool, {
  claimSpecInertWarning,
  claimSpecWakeabilityWarning,
  previewClaimSpecAdmission,
  resolveClaimSpecPotSlug,
  wakeClaimableAwaitersAfterSpecChange,
} from './set_claim_spec';
import type { ClaimSpec } from '../../scheduler/claim-spec';

const wakeClaimableAwaitersForSubscribers = vi.hoisted(() => vi.fn());
const listFleetMembers = vi.hoisted(() => vi.fn());

// The helper is dynamically imported by the tool so its wake-plane dependency can
// fail soft after the durable spec write. Keep this test focused on the target
// resolution and forwarding contract without opening a real await/event store.
vi.mock('../../events/await/engine', () => ({
  wakeClaimableAwaitersForSubscribers: (...args: unknown[]) => wakeClaimableAwaitersForSubscribers(...args),
}));
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: {
    listFleetMembers: (...args: unknown[]) => listFleetMembers(...args),
  },
}));

describe('wakeClaimableAwaitersAfterSpecChange — EI-20079462322478221', () => {
  it('forwards a direct member target and spec revision to the event engine', async () => {
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(1);

    await expect(
      wakeClaimableAwaitersAfterSpecChange({ cupId: 'su-target', specId: 'bugs-lane', revision: 7 }),
    ).resolves.toEqual({ woken: 1 });
    expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({
      subscriberIds: ['su-target'],
      specId: 'bugs-lane',
      revision: 7,
    });
  });

  it('turns an event-plane failure into an actionable warning without throwing', async () => {
    wakeClaimableAwaitersForSubscribers.mockRejectedValueOnce(new Error('await store unavailable'));

    await expect(
      wakeClaimableAwaitersAfterSpecChange({ cupId: 'su-target', specId: 'bugs-lane', revision: 8 }),
    ).resolves.toEqual({
      woken: 0,
      warning: 'claim-spec revision stored, but parked claimable awaiters could not be woken: await store unavailable',
    });
  });

  it('resolves a fleet target to its current live members before waking', async () => {
    listFleetMembers.mockResolvedValueOnce(['su-member-a', 'su-member-b']);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(2);

    await expect(
      wakeClaimableAwaitersAfterSpecChange({
        cupId: 'fleet:nonp2p-bug-drain',
        fleet: 'nonp2p-bug-drain',
        specId: 'bugs-lane',
        revision: 9,
      }),
    ).resolves.toEqual({ woken: 2 });
    expect(listFleetMembers).toHaveBeenCalledWith('nonp2p-bug-drain');
    expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({
      subscriberIds: ['su-member-a', 'su-member-b'],
      specId: 'bugs-lane',
      revision: 9,
    });
  });
});

describe('published claim-spec guidance — WI-37997 severity ordering', () => {
  it('advertises the safe ordinal severity_rank term and a critical-first issue example', () => {
    const json = z.toJSONSchema(setClaimSpecTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    };
    const description = json.properties?.spec?.description ?? '';
    expect(description).toContain('severity_rank');
    expect(description).toContain('dependency_unlock_score');
    expect(description).toContain('dependencyUnlockScore');
    expect(description).toContain('cluster_priority');
    expect(description).toContain('payload.clusterPriority');
    expect(description).toContain('never computes clustering at assignment time');
    expect(description).toContain('critical-first');
    expect(description).toContain('{ expr:"severity_rank", dir:"desc" }');
    expect(description).not.toContain('Filter on them instead');
  });
});

describe('published claim-spec args — EI-21170624598321316', () => {
  const baseSpec = {
    specVersion: '1.0',
    specId: 'schema-test',
    view: { filter: { field: 'kind', op: '=', value: 'bug' } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it('advertises revision as required instead of deferring the failure to the handler', () => {
    const missingRevision = setClaimSpecTool.args.safeParse({
      fleet: 'fleet-a',
      spec: baseSpec,
    });
    expect(missingRevision.success).toBe(false);
    if (!missingRevision.success) {
      expect(missingRevision.error.issues.some((issue) => issue.path.join('.') === 'spec.revision')).toBe(true);
    }

    const complete = setClaimSpecTool.args.safeParse({
      fleet: 'fleet-a',
      spec: { ...baseSpec, revision: 1 },
    });
    expect(complete.success).toBe(true);
  });
});

describe('claimSpecInertWarning — inert-spec advisory role-awareness', () => {
  it('WARNS for coding-FACTORY push-pipeline roles (spec is genuinely inert)', () => {
    for (const role of [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'documenter',
      'curator',
      'director',
    ]) {
      const w = claimSpecInertWarning('bee-x', role);
      expect(w, `expected a warning for factory role "${role}"`).toBeTruthy();
      expect(w).toContain(role);
      expect(w).toContain('INERT');
    }
  });

  it('does NOT warn for self-pulling hive roles (bee / queen)', () => {
    expect(claimSpecInertWarning('bee-1', 'cup')).toBeNull();
    expect(claimSpecInertWarning('queen-1', 'mug')).toBeNull();
  });

  it('does NOT warn for an su fleet member — the P-003 false-positive class', () => {
    // A fleet member launched via launch-on-plan runs as a bare su collaborator; the
    // nursery records no distinctive self-pulling role (often null or a bare role string),
    // yet post-P-001 it self-pulls via get_next. None of these may trip the advisory.
    expect(claimSpecInertWarning('su-member', null)).toBeNull();
    expect(claimSpecInertWarning('su-member', '(missing)')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'su')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'operator')).toBeNull();
  });

  it('does NOT warn when the spawned role is unknown/null (best-effort, never cries wolf)', () => {
    expect(claimSpecInertWarning('x', null)).toBeNull();
    expect(claimSpecInertWarning('x', '')).toBeNull();
    expect(claimSpecInertWarning('x', 'some-future-role')).toBeNull();
  });

  it('names the cupId in the warning so the operator can act on it', () => {
    const w = claimSpecInertWarning('bee-abc123', 'scoper');
    expect(w).toContain('bee-abc123');
  });
});

describe('claimSpecWakeabilityWarning — EI-6079 warm-inject-miss advisory', () => {
  it('WARNS when the bee is NOT wakeable (no live coord:inbox-wake await)', () => {
    const w = claimSpecWakeabilityWarning('bee-x', false);
    expect(w).toBeTruthy();
    expect(w).toContain('bee-x');
    expect(w).toContain('woken:0');
  });

  it('does NOT warn when the bee IS wakeable (the common/healthy case)', () => {
    expect(claimSpecWakeabilityWarning('bee-x', true)).toBeNull();
  });

  it('does NOT warn on an unknown result (a lookup failure) — never cry wolf', () => {
    expect(claimSpecWakeabilityWarning('bee-x', null)).toBeNull();
  });

  it('names the cupId so the operator can act on it', () => {
    const w = claimSpecWakeabilityWarning('bee-abc123', false);
    expect(w).toContain('bee-abc123');
  });
});

describe('resolveClaimSpecPotSlug — EI-20240600109414261 direct/tools:invoke parity', () => {
  it('uses an explicit harness for both direct and tools:invoke-style unscoped calls', () => {
    const direct = resolveClaimSpecPotSlug('papercusp', 'papercusp');
    const viaInvoke = resolveClaimSpecPotSlug('papercusp', '*');

    expect(direct).toBe('papercusp');
    expect(viaInvoke).toBe(direct);
  });

  it('falls back to a concrete ambient harness when no explicit override is supplied', () => {
    expect(resolveClaimSpecPotSlug(undefined, 'papercusp')).toBe('papercusp');
    expect(resolveClaimSpecPotSlug(undefined, '*')).toBeUndefined();
  });

  it('does not treat the wildcard sentinel as a hive scope', () => {
    expect(resolveClaimSpecPotSlug('*', 'papercusp')).toBe('papercusp');
  });
});

const fixedSpec = (ids: string[], states?: string[]): ClaimSpec => ({
  specVersion: '1.0',
  specId: 'fixed-live-wave',
  revision: 1,
  view: {
    filter: {
      all: [{ field: 'id', op: 'in', value: ids }, { not: { field: 'title', op: 'glob', value: '*p2p*' } }],
    },
  },
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  ...(states ? { states } : {}),
});

describe('previewClaimSpecAdmission — WI-4429 write-time dead-cohort prevention', () => {
  it('rejects a 0-admissible issue cohort and threads spec-carried states into the shared evaluator', async () => {
    const explain = async (_harness: string, ids: readonly string[], opts?: { states?: readonly string[] }) =>
      ids.map((id) => ({
        id,
        admissible: false,
        refusedBy: 'not-claimable-status',
        detail: `states=${opts?.states?.join(',')}`,
      }));
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-1', 'EI-2'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      explain,
      resolveFamily: async () => 'issue',
    });
    expect(result.errors[0]).toContain('0 are claim-path admissible');
    expect(result.preview).toMatchObject({
      checked: true,
      cohortIds: ['WI-1', 'EI-2'],
      effectiveStates: ['open'],
      admissibleIds: [],
    });
    expect(result.preview.floored).toHaveLength(2);
  });

  it('accepts a partially-admissible cohort but returns every floored id as a warning', async () => {
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-good', 'WI-held'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      explain: async () => [
        { id: 'WI-good', admissible: true, refusedBy: null, detail: null },
        { id: 'WI-held', admissible: false, refusedBy: 'claim-hold', detail: 'held' },
      ],
      resolveFamily: async () => 'issue',
    });
    expect(result.errors).toEqual([]);
    expect(result.warning).toContain('1/2');
    expect(result.warning).toContain('WI-held:claim-hold');
    expect(result.preview.admissibleIds).toEqual(['WI-good']);
  });

  it('does not misclassify a WI-prefixed feature as an issue-family not-found and false-reject it', async () => {
    const explained: string[][] = [];
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-feature', 'WI-issue'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      resolveFamily: async (id) => (id === 'WI-feature' ? 'feature' : 'issue'),
      explain: async (_harness, ids) => {
        explained.push([...ids]);
        return [{ id: 'WI-issue', admissible: false, refusedBy: 'claim-hold', detail: 'held' }];
      },
    });
    expect(explained).toEqual([['WI-issue']]);
    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({
      checked: false,
      checkedIssueIds: ['WI-issue'],
      uncheckedFeatureIds: ['WI-feature'],
      unknownIds: [],
    });
    expect(result.warning).toContain('WI-feature');
    expect(result.warning).toContain('pull time');
  });

  it('refuses to skip a named issue preview when no harness can be resolved', async () => {
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-1']),
      assignee: 'su-leader',
      explain: async () => [],
    });
    expect(result.errors[0]).toMatch(/harness is required/);
    expect(result.preview).toMatchObject({ checked: false, mode: 'fixed-cohort' });
  });

  it('leaves dynamic/property specs to live pull-time evaluation without a false reject', async () => {
    const spec: ClaimSpec = {
      ...fixedSpec([]),
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
    };
    const result = await previewClaimSpecAdmission({ spec, assignee: 'su-leader' });
    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({ mode: 'dynamic', checked: false });
  });
});
