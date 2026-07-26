/**
 * matrix-scenario-terminal-order-guard — the live-federation matrix's terminal-band
 * ordering invariant (WI-5064).
 *
 * THE BUG THIS EXISTS TO PREVENT. The scenario order convention said "90+ =
 * terminal/destructive, runs LAST". Two scenarios each dutifully declared themselves
 * terminal-and-last:
 *   revocation_kcut               (90) — BANS member B. Revocation is sticky/monotone
 *                                        (hive-membership-store.ts), so from that moment
 *                                        B can neither receive NOR send for the rest of
 *                                        the run.
 *   attestation_unattested_device (91) — needs B to still SEND: B writes a p2p_receipt
 *                                        that must federate b→a so A applies-and-refuses
 *                                        it with identity_unresolved.
 * 91 > 90, so the ban always ran first and the probe was blocked at A's admission. The leg
 * reported `identity_unresolved 0→0` — indistinguishable from the FEATURE being broken —
 * and red-pinned the standing release gate 3/3, blocking first-green for hours.
 *
 * Proven by controlled experiment (2026-07-26), one variable, churn legs absent from both:
 *   --only=attestation_membership,attestation_unattested_device                 → LEG4 PASS
 *   --only=attestation_membership,revocation_kcut,attestation_unattested_device → LEG4 FAIL
 *
 * THE INVARIANT: the member-ban leg must hold the STRICT MAXIMUM registered order. Anything
 * registered after it runs against a member that can no longer participate.
 *
 * This guard is STATIC (parses the shell sources) so it costs nothing and cannot be skipped
 * by a rig being unavailable — the failure it catches is a one-line registration change.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENARIO_DIR = join(__dirname, '../../../papercusp-desktop/bin/lib/scenarios');

/** The leg whose effect is "this member can no longer participate at all". */
const MEMBER_DISABLING_SCENARIO = 'revocation_kcut';

export interface RegisteredScenario {
  id: string;
  order: number;
  file: string;
}

/**
 * Parse `matrix_register <id> <order> "<desc>" <fn>` out of scenario shell sources.
 * Deliberately a pure function over text so the self-proof test below can feed it the
 * historical broken configuration.
 */
export function parseRegistrations(sources: Array<{ file: string; text: string }>): RegisteredScenario[] {
  const out: RegisteredScenario[] = [];
  for (const { file, text } of sources) {
    for (const line of text.split('\n')) {
      // Only real registrations, never a commented-out or quoted mention.
      const m = /^\s*matrix_register\s+([A-Za-z0-9_]+)\s+(\d+)\b/.exec(line);
      if (m) out.push({ id: m[1], order: Number(m[2]), file });
    }
  }
  return out;
}

/**
 * The detector. Returns the violating scenarios — those registered at or after the
 * member-disabling leg. Empty ⇒ the invariant holds.
 */
export function findTerminalOrderViolations(
  scenarios: RegisteredScenario[],
  banScenarioId = MEMBER_DISABLING_SCENARIO,
): { banOrder: number | null; violations: RegisteredScenario[] } {
  const ban = scenarios.find((s) => s.id === banScenarioId);
  if (!ban) return { banOrder: null, violations: [] };
  const violations = scenarios.filter((s) => s.id !== ban.id && s.order >= ban.order);
  return { banOrder: ban.order, violations };
}

/**
 * The SECOND ordering ceiling (2026-07-26). `attestation_unattested_device` holds an
 * ANTI-MONOTONE precondition: it empties one member's `device_attestations` and needs that
 * emptiness to survive its own ~155s window. Both writers of that column put an announced
 * device straight back —
 *   · the projection (sync/hyperbee/projections/hive-members.ts) REPLACES the column from a
 *     remote op, and
 *   · the admission path (hive-membership-store.ts `upsertHiveMember`) UNION-merges it with
 *     NO clock guard at all (WI-1585, merge-never-replace),
 * — and a swarm reconnect is what makes a member re-announce. So running this leg after the
 * churn band (restart / reconnect / replication-soak, 80-89) had its precondition undone
 * mid-flight, and the leg reported PRECONDITION UNHOLDABLE on a product that was fine.
 * No timeout can fix an undone precondition; only ordering can — hence a static guard.
 */
export const ANTI_MONOTONE_PRECONDITION_SCENARIOS = ['attestation_unattested_device'] as const;
export const CHURN_SCENARIOS = [
  'restart_durability',
  'restart_settle_barrier',
  'reconnect_catchup',
  'replication_soak',
] as const;

/**
 * Returns anti-monotone legs registered at/after the FIRST churn leg. Empty ⇒ invariant holds.
 * A churn leg that is not registered at all is simply skipped, so this never fails on a rig
 * that drops a scenario.
 */
export function findChurnOrderViolations(
  scenarios: RegisteredScenario[],
  antiMonotoneIds: readonly string[] = ANTI_MONOTONE_PRECONDITION_SCENARIOS,
  churnIds: readonly string[] = CHURN_SCENARIOS,
): { firstChurnOrder: number | null; violations: RegisteredScenario[] } {
  const churnOrders = scenarios.filter((s) => churnIds.includes(s.id)).map((s) => s.order);
  if (churnOrders.length === 0) return { firstChurnOrder: null, violations: [] };
  const firstChurnOrder = Math.min(...churnOrders);
  const violations = scenarios.filter(
    (s) => antiMonotoneIds.includes(s.id) && s.order >= firstChurnOrder,
  );
  return { firstChurnOrder, violations };
}

function loadScenarioSources(): Array<{ file: string; text: string }> {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => ({ file: f, text: readFileSync(join(SCENARIO_DIR, f), 'utf8') }));
}

describe('live-federation matrix — terminal-band ordering invariant (WI-5064)', () => {
  it('parses the real scenario registrations', () => {
    const scenarios = parseRegistrations(loadScenarioSources());
    // Sanity: the parser must actually be finding registrations. Without this, a parser
    // that silently matched nothing would make every assertion below vacuously pass.
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(scenarios.map((s) => s.id)).toContain(MEMBER_DISABLING_SCENARIO);
    expect(scenarios.map((s) => s.id)).toContain('attestation_unattested_device');
  });

  it('registers NOTHING at or after the member-ban leg', () => {
    const scenarios = parseRegistrations(loadScenarioSources());
    const { banOrder, violations } = findTerminalOrderViolations(scenarios);
    expect(banOrder).not.toBeNull();
    expect(
      violations,
      `Scenario(s) are registered at/after ${MEMBER_DISABLING_SCENARIO}(${banOrder}). That leg BANS the ` +
        `member and revocation is sticky/monotone, so anything after it runs against a member that can ` +
        `neither send nor receive — its assertions become meaningless and read as product defects. ` +
        `Move these strictly below ${banOrder}: ` +
        violations.map((v) => `${v.id}(${v.order}) in ${v.file}`).join(', '),
    ).toEqual([]);
  });

  it('keeps attestation_unattested_device before the ban — it needs the member able to SEND', () => {
    const scenarios = parseRegistrations(loadScenarioSources());
    const leg = scenarios.find((s) => s.id === 'attestation_unattested_device');
    const ban = scenarios.find((s) => s.id === MEMBER_DISABLING_SCENARIO);
    expect(leg, 'attestation_unattested_device is no longer registered').toBeDefined();
    expect(ban).toBeDefined();
    expect(
      leg!.order,
      `attestation_unattested_device(${leg!.order}) must run BEFORE ${MEMBER_DISABLING_SCENARIO}(${ban!.order}): ` +
        `its probe requires B to federate a receipt b→a, and the ban blocks B at A's admission. ` +
        `Regressing this reproduces the WI-5064 gate red (identity_unresolved 0→0).`,
    ).toBeLessThan(ban!.order);
  });

  // SELF-PROOF — the guard must FAIL on the historical broken configuration. Without this a
  // detector that quietly stopped detecting (a parser regex that no longer matches, a renamed
  // ban leg) would go permanently green and stop protecting the gate, which is the exact
  // failure mode that let the original bug survive.
  it('DETECTS the historical broken configuration (attestation at 91, after the ban at 90)', () => {
    const historical = parseRegistrations([
      {
        file: 'b3-revocation.sh',
        text: 'matrix_register revocation_kcut 90 "revocation + epoch K-cut" scn_revocation_kcut',
      },
      {
        file: 'b9-attestation.sh',
        text: 'matrix_register attestation_unattested_device 91 "unattested-device refused-op witness" scn_attestation_unattested_device',
      },
    ]);
    const { violations } = findTerminalOrderViolations(historical);
    expect(violations.map((v) => v.id)).toEqual(['attestation_unattested_device']);
  });

  it('does not flag a correctly-ordered configuration', () => {
    const fixed = parseRegistrations([
      {
        file: 'b3-revocation.sh',
        text: 'matrix_register revocation_kcut 90 "revocation + epoch K-cut" scn_revocation_kcut',
      },
      {
        file: 'b9-attestation.sh',
        text: 'matrix_register attestation_unattested_device 89 "unattested-device refused-op witness" scn_attestation_unattested_device',
      },
    ]);
    expect(findTerminalOrderViolations(fixed).violations).toEqual([]);
  });
});

describe('live-federation matrix — anti-monotone legs run BEFORE the churn band', () => {
  it('registers every anti-monotone-precondition leg below the first churn leg', () => {
    const scenarios = parseRegistrations(loadScenarioSources());
    const { firstChurnOrder, violations } = findChurnOrderViolations(scenarios);
    expect(firstChurnOrder, 'no churn scenario parsed — the guard would be vacuous').not.toBeNull();
    expect(
      violations,
      `Anti-monotone leg(s) are registered at/after the first churn leg (order ${firstChurnOrder}). ` +
        `Those legs remove a value locally and need it to STAY removed; the churn legs reconnect the ` +
        `swarm, every reconnect makes the member re-announce, and an announce restores the value via ` +
        `either writer (projection REPLACE from a newer op, or the admission path's UNION merge with ` +
        `no clock guard). The leg then fails PRECONDITION UNHOLDABLE and reads as a product defect. ` +
        `Move these strictly below ${firstChurnOrder}: ` +
        violations.map((v) => `${v.id}(${v.order}) in ${v.file}`).join(', '),
    ).toEqual([]);
  });

  // SELF-PROOF — the configuration that actually failed the gate must be DETECTED.
  it('DETECTS the historical configuration (attestation at 89, after replication_soak at 87)', () => {
    const historical = parseRegistrations([
      {
        file: 'b8-replication-soak.sh',
        text: 'matrix_register replication_soak 87 "replication soak" scn_replication_soak',
      },
      {
        file: 'b9-attestation.sh',
        text: 'matrix_register attestation_unattested_device 89 "unattested-device refused-op witness" scn_attestation_unattested_device',
      },
    ]);
    expect(findChurnOrderViolations(historical).violations.map((v) => v.id)).toEqual([
      'attestation_unattested_device',
    ]);
  });

  it('does not flag the fixed configuration (attestation at 79, churn from 80)', () => {
    const fixed = parseRegistrations([
      {
        file: 'b5-restart.sh',
        text: 'matrix_register restart_durability 80 "restart durability" scn_restart_durability',
      },
      {
        file: 'b9-attestation.sh',
        text: 'matrix_register attestation_unattested_device 79 "unattested-device refused-op witness" scn_attestation_unattested_device',
      },
    ]);
    expect(findChurnOrderViolations(fixed).violations).toEqual([]);
  });
});
