/**
 * EI-19313376980892266 item C — the RECURRENCE GUARD for "every alert carries its
 * falsifier".
 *
 * Modelled on `cell-falsifier-reality.test.ts`, which exists because a falsifier
 * whose `field` names a path no resolver produces is WORSE than no falsifier: it
 * wears the contract's badge while being unrunnable. The same failure is available
 * here in three flavours, and every one of them looks fine in review:
 *
 *   1. a falsifier naming a tool that does not exist (or was renamed);
 *   2. a falsifier whose "check" MUTATES — the trap that motivated the whole family,
 *      since the obvious way to ask "would the scheduler admit this member" is
 *      `scheduler:get_next`, which has no dry-run and atomically CLAIMS;
 *   3. a NEW alert added to the family with a `reason` and no falsifier at all,
 *      quietly returning the surface to prose-that-gets-believed.
 *
 * (3) is the one a fixture-only test cannot catch, so this file also censuses the
 * SOURCE — an alert that ships a reason without a falsifier reds the build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computeStrandedFleetAlert,
  computeSpecStarvedFleetAlert,
  computeSpecAuthorshipAlert,
  computeDeclaredPlanSpecDivergenceAlert,
  computeIdleWithClaimableAlert,
  computeFloorStarvedFleetAlert,
  renderFalsifierCall,
  FALSIFIER_FORBIDDEN_TOOLS,
  type AlertFalsifier,
} from './leader-brief';
import { buildFullToolNameCatalog } from '../../static-tool-catalog';

const __dirname_ = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname_, '../../../../../');
const SOURCE = join(__dirname_, 'leader-brief.ts');

/** Each alert under a MINIMAL input that makes it fire. */
const FIRING: { name: string; fired: { reason: string; falsifier: AlertFalsifier } | undefined }[] = [
  {
    name: 'strandedFleet',
    fired: computeStrandedFleetAlert({
      totalLoad: 0,
      parkedCount: 2,
      unownedCriticalCount: 3,
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'specStarved',
    fired: computeSpecStarvedFleetAlert({
      totalLoad: 0,
      specMatched: 0,
      poolSize: 40,
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    // P-005: the only alert in the family that is not about SUPPLY — it fires on the spec
    // row's AUTHORSHIP, so its falsifier has to reach a different table than the one it
    // read, which is exactly what this fixture set exists to police.
    name: 'specAuthorship',
    fired: computeSpecAuthorshipAlert({
      readerId: 'su-b8422496',
      updatedBy: 's-1786236383559',
      revision: 4,
      updatedAt: '2026-08-09T01:12:00.000Z',
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'declaredPlanSpecDivergence',
    fired: computeDeclaredPlanSpecDivergenceAlert({
      members: [
        { agentId: 'su-divergent', alive: true, declaredPlanSlug: 'other-plan' },
      ],
      specFilter: { field: 'plan', op: '=', value: 'intended-plan' },
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    name: 'idleWithClaimable',
    fired: computeIdleWithClaimableAlert({
      claimableCount: 12,
      idleMemberCount: 2,
      harness: 'papercusp',
      idleMemberIds: ['su-abc123', 'su-def456'],
    }),
  },
  {
    name: 'floorStarved',
    fired: computeFloorStarvedFleetAlert({
      claimable: 0,
      matchedByFilter: 108,
      idleMemberCount: 5,
      excluded: { taken: 8, claimHold: 38 },
      harness: 'papercusp',
      fleet: 'my-fleet',
    }),
  },
  {
    // WI-37161: the pool-congested variant of idleWithClaimable — a DIFFERENT falsifier
    // (fleet:capacity, not work_items:list) than the sibling fixture above, so it needs its
    // own row rather than relying on the un-parameterized one to cover it.
    name: 'idleWithClaimablePoolCongested',
    fired: computeIdleWithClaimableAlert({
      claimableCount: 12,
      idleMemberCount: 2,
      harness: 'papercusp',
      idleMemberIds: ['su-abc123', 'su-def456'],
      poolCapacity: { poolExhausted: false, degraded: true, factor: 0, queueDepth: 28, usableAccounts: 1, availableAccounts: 2 },
    }),
  },
];

describe('alert falsifier reality (EI-19313376980892266 item C)', () => {
  it('every alert in the family FIRES under its documented trigger', () => {
    // Guards the fixtures themselves: an input that stopped triggering would make
    // every assertion below vacuously pass on `undefined`.
    for (const { name, fired } of FIRING) {
      expect(fired, `${name} did not fire under its trigger input`).toBeDefined();
    }
  });

  it('every fired alert ships a falsifier with all four fields populated', () => {
    for (const { name, fired } of FIRING) {
      const f = fired!.falsifier;
      expect(f, `${name} has no falsifier`).toBeDefined();
      for (const key of ['tool', 'check', 'measurement', 'kills'] as const) {
        expect(typeof f[key], `${name}.falsifier.${key} must be a string`).toBe('string');
        expect(f[key].length, `${name}.falsifier.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every falsifier names a tool that ACTUALLY EXISTS', () => {
    // The cell-falsifier failure with the serial numbers filed off: a check citing a
    // renamed tool reads as verifiable and cannot be run.
    const catalog = buildFullToolNameCatalog(REPO);
    expect(catalog.size, 'tool catalog scan returned nothing — the test is not measuring').
      toBeGreaterThan(50);
    for (const { name, fired } of FIRING) {
      expect(catalog.has(fired!.falsifier.tool), `${name} cites unknown tool ${fired!.falsifier.tool}`).
        toBe(true);
    }
  });

  it('no falsifier calls a MUTATING tool — a check that changes state is not a check', () => {
    // The concrete trap: `scheduler:get_next` is the intuitive way to ask "would this
    // member be admitted" and it CLAIMS the item. A leader verifying an idle-member
    // alert that way takes the work themselves — exactly how this item's author
    // accumulated 5 claims against a cap of 1 while diagnosing the fleet as idle.
    for (const { name, fired } of FIRING) {
      expect(
        FALSIFIER_FORBIDDEN_TOOLS,
        `${name} falsifier calls the mutating tool ${fired!.falsifier.tool}`,
      ).not.toContain(fired!.falsifier.tool);
    }
  });

  it('every check is a runnable one-liner naming its own tool', () => {
    for (const { name, fired } of FIRING) {
      const { tool, check } = fired!.falsifier;
      expect(check.startsWith(tool), `${name} check does not begin with its tool: ${check}`).toBe(true);
      expect(check, `${name} check has no argument block`).toContain('{');
      // A rendered arg must never leak a JS-side null/undefined into a pasted call.
      expect(check, `${name} check leaked a null arg`).not.toContain('null');
      expect(check, `${name} check leaked an undefined arg`).not.toContain('undefined');
    }
  });

  it('the idle-with-claimable falsifier names a REAL accused member, not a placeholder', () => {
    // The alert accuses specific members; a falsifier that cannot name one sends the
    // leader back to guessing, which is where the original incident started.
    const f = FIRING.find((x) => x.name === 'idleWithClaimable')!.fired!.falsifier;
    expect(f.check).toContain('su-abc123');
  });

  it('a falsifier degrades to a still-runnable call when fleet/harness are unresolved', () => {
    // Fail-soft, matching every other best-effort read in the brief: an unresolved
    // context must not produce `harness: null` in a call a leader pastes.
    const fired = computeStrandedFleetAlert({
      totalLoad: 0,
      parkedCount: 1,
      unownedCriticalCount: 1,
      harness: null,
      fleet: null,
    });
    expect(fired!.falsifier.check).not.toContain('null');
    expect(fired!.falsifier.check).toContain('work_items:claimable');
  });

  it('renderFalsifierCall quotes strings, leaves scalars bare, and drops empties', () => {
    expect(renderFalsifierCall('a:b', { s: 'x', n: 3, t: true, skip: null, gone: undefined })).toBe(
      "a:b { s: 'x', n: 3, t: true }",
    );
    expect(renderFalsifierCall('a:b', {})).toBe('a:b {}');
  });

  it('CENSUS: no alert in the family ships a reason WITHOUT a falsifier', () => {
    // The ratchet. A future alert added with `{ reason: ... }` and no falsifier is
    // exactly the regression this item exists to prevent, and no fixture-based test
    // can see it because the fixture would never be written.
    const violations = auditAlertReturnTypes(readFileSync(SOURCE, 'utf8'));
    expect(violations.scanned, 'found no alert return types — the census regex has rotted').
      toBeGreaterThanOrEqual(4);
    expect(
      violations.bare,
      'an alert returns a bare { reason } with no falsifier — every alert must ship the ' +
        'query that would disprove it (EI-19313376980892266 item C)',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: the census actually CATCHES a bare-reason alert', () => {
    // Without this, a census that silently matched NOTHING would pass forever and the
    // ratchet would be decorative. Proven against a synthetic source rather than by
    // mutating leader-brief.ts, because git-sync sweeps this shared tree every few
    // minutes and would commit the broken intermediate.
    const good = 'export function computeXAlert(input: {\n  a: number;\n}): { reason: string; falsifier: AlertFalsifier } | undefined {';
    const bad = 'export function computeYAlert(input: {\n  a: number;\n}): { reason: string } | undefined {';

    expect(auditAlertReturnTypes(good).bare).toEqual([]);
    const caught = auditAlertReturnTypes(bad);
    expect(caught.scanned).toBe(1);
    expect(caught.bare).toHaveLength(1);
    expect(caught.bare[0]).toContain('reason: string');

    // And it must see BOTH in a mixed source — a single compliant sibling must never
    // mask a bare one.
    const mixed = auditAlertReturnTypes(`${good}\n${bad}`);
    expect(mixed.scanned).toBe(2);
    expect(mixed.bare).toHaveLength(1);
  });
});

/**
 * Census over leader-brief source: every `compute*Alert` return type shaped
 * `{ reason: string ... } | undefined` must also declare a `falsifier`. PURE, so the
 * guard itself can be proven to fail on the regression (see the negative control).
 */
export function auditAlertReturnTypes(src: string): { scanned: number; bare: string[] } {
  const matches = [...src.matchAll(/\}\): \{ reason: string([^}]*)\} \| undefined \{/g)];
  return {
    scanned: matches.length,
    bare: matches.filter((m) => !m[1].includes('falsifier')).map((m) => m[0]),
  };
}
