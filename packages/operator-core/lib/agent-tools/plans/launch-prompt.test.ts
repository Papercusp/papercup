/**
 * launch-prompt.test.ts — pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014:
 * the routing-gate's option (C) text, folded by `remoteSeats`
 * (RemoteSeatSummary). Also guards the pre-existing named-verb discipline
 * (sessions 9870/9865 — option C must always name `fleet:launch-on-plan`).
 *
 * What a regression here breaks: a shared pot with real donated seats never
 * gets told to the owner (P-007 silently regresses to local-only text), or an
 * unshared/local workspace starts mentioning remote seats that don't exist.
 *
 * Pure — no PG, no mocks needed.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/launch-prompt.test.ts
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — untyped .mjs guard helper, imported for its pure detector.
import * as retiredGuidance from '../../../../../scripts/lib/retired-tier-guidance.mjs';
import { deriveLaunchPromptText, type RemoteSeatSummary } from './launch-prompt';

const { findRetiredGuidanceOffenders } = retiredGuidance;

const PLAN = { slug: 'p-1', harness: 'papercusp' };

const UNSHARED: RemoteSeatSummary = { potShared: false, donorCount: 0, totalSeats: 0 };
const SHARED_EMPTY: RemoteSeatSummary = { potShared: true, donorCount: 0, totalSeats: 0 };
const SHARED_WITH_OFFERS: RemoteSeatSummary = { potShared: true, donorCount: 3, totalSeats: 7 };
const SHARED_SINGULAR: RemoteSeatSummary = { potShared: true, donorCount: 1, totalSeats: 1 };

describe('deriveLaunchPromptText — routing gate option (C), AUTO-off + plan bound', () => {
  it('omitted remoteSeats ⇒ byte-identical to the pre-P-007 static text (full profile)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full');
    expect(text).toContain(
      '(C) launch a fleet of agents to parallelize it (executed in ONE call with the ' +
        '`fleet:launch-on-plan` tool — never a hand-built psu command)',
    );
    expect(text).not.toContain('remote seats');
  });

  it('omitted remoteSeats ⇒ byte-identical static text (lean profile)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'lean');
    expect(text).toContain(
      '(C) launch a fleet of agents to parallelize it (executed in ONE call with the ' +
        '`fleet:launch-on-plan` tool — never a hand-built psu command)',
    );
  });

  it('unshared pot (potShared:false) ⇒ same static text as omitted, in both profiles', () => {
    const full = deriveLaunchPromptText(null, false, PLAN, 'full', UNSHARED);
    const lean = deriveLaunchPromptText(null, false, PLAN, 'lean', UNSHARED);
    expect(full).toContain('(C) launch a fleet of agents to parallelize it');
    expect(lean).toContain('(C) launch a fleet of agents to parallelize it');
  });

  it('shared pot with open offers ⇒ names fleet:launch-on-plan + placement:remote, discloses count/donors, asks about own slots (P-013/P-014)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).toContain('`fleet:launch-on-plan`');
    expect(text).toContain("placement:'remote'");
    expect(text).toContain('I see 7 agent slots available from 3 peers in this pot');
    expect(text).toContain('add their own agent slots to this fleet too');
    expect(text).toContain('resource:delegate');
    expect(text).toContain('p2p:trace');
  });

  it('P-013: names donors by hostLabel when at least one is set, instead of the anonymous count', () => {
    const withLabels: RemoteSeatSummary = { ...SHARED_WITH_OFFERS, donorLabels: ['box-a', 'box-b'] };
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', withLabels);
    expect(text).toContain('I see 7 agent slots available from box-a, box-b)');
    expect(text).not.toContain('3 peers in this pot');
  });

  it('P-013: empty donorLabels array falls back to the anonymous count phrasing', () => {
    const emptyLabels: RemoteSeatSummary = { ...SHARED_WITH_OFFERS, donorLabels: [] };
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', emptyLabels);
    expect(text).toContain('I see 7 agent slots available from 3 peers in this pot');
  });

  it('singular counts use singular nouns ("1 agent slot", "1 peer")', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_SINGULAR);
    expect(text).toContain('I see 1 agent slot available from 1 peer in this pot');
  });

  it('shared pot with an EMPTY inventory is not a dead end — still offers to create locally and names the peer-ask (P-013)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_EMPTY);
    expect(text).toContain('`fleet:launch-on-plan`');
    expect(text).toContain('no standing remote seat offers yet');
    expect(text).toContain('resource:delegate');
    // no offers yet ⇒ no false donor-count disclosure
    expect(text).not.toContain('I see 0 agent slots');
  });

  it('lean profile also folds remoteSeats into option (C)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'lean', SHARED_WITH_OFFERS);
    expect(text).toContain("placement:'remote'");
    expect(text).toContain('I see 7 agent slots available from 3 peers in this pot');
  });

  it('AUTO-on branches are unaffected by remoteSeats (no routing-gate presentation happens there)', () => {
    const text = deriveLaunchPromptText(null, true, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).not.toContain('routing gate');
    expect(text).not.toContain('remote seats');
  });

  it('a custom note bypasses the routing-gate text entirely regardless of remoteSeats', () => {
    const text = deriveLaunchPromptText('custom kickoff', false, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).toContain('custom kickoff');
    expect(text).not.toContain('placement');
  });
});

/**
 * EI-21972876172423322 — NO routing-gate option may name a RETIRED-TIER role.
 *
 * Until 2026-08-31, option (B) read "hand it to the Mug". The Mug/Kettle/Cup tier
 * is permanently retired (MUG_KETTLE_SYSTEM deleted, `mugKettleSystemEnabled()` a
 * constant false, every spawn door and the D-017 actuators refusing), so the gate
 * was handing owners a menu whose middle option no agent could execute. It reached
 * essentially every su: plans/launch.ts, bootstrap-su.ts AND carry-respawn.ts all
 * consume this text.
 *
 * It survived the tier's retirement for one reason — NOTHING PINNED THE OPTION
 * RECIPIENTS. The suite above guards option (C)'s named VERB with byte-exact
 * assertions (sessions 9870/9865) and never looks at WHO an option points at, so
 * the whole retirement swept past this file in silence.
 *
 * This guards the CLASS rather than the one string, and deliberately reuses the
 * shared `retired-tier-guidance` detector (the same one `lint:no-ungated-mug-kettle`
 * runs) instead of a local regex — a second hand-rolled copy of "which roles are
 * retired" is exactly the drift that produced the bug. New retired role ⇒ the
 * detector learns it once and this guard tightens for free.
 *
 * ⚠ If this fails, do NOT relax it by renaming the role out of the assertion. It is
 * telling you the gate offers a route that cannot be executed — fix the ROUTE.
 */
describe('deriveLaunchPromptText — no option may name a retired-tier executor', () => {
  const PROFILES = ['full', 'lean'] as const;
  const SEATS = [undefined, UNSHARED, SHARED_EMPTY, SHARED_WITH_OFFERS, SHARED_SINGULAR];

  for (const guards of PROFILES) {
    for (const autoMode of [false, true]) {
      for (const [i, seats] of SEATS.entries()) {
        it(`${guards} profile, autoMode=${autoMode}, seats[${i}] ⇒ zero retired-tier offenders`, () => {
          const text = deriveLaunchPromptText(null, autoMode, PLAN, guards, seats);
          const offenders = findRetiredGuidanceOffenders(
            'packages/operator-core/lib/agent-tools/plans/launch-prompt.ts',
            text,
          );
          expect(
            offenders,
            `launch prompt names a retired-tier role as an executor:\n${JSON.stringify(offenders, null, 2)}\n\nGenerated text:\n${text}`,
          ).toEqual([]);
        });
      }
    }
  }

  it('is DISCRIMINATING — the pre-fix "(B) hand it to the Mug" wording still trips the detector', () => {
    // Calibration. Without this, a detector that silently stopped matching (a bad
    // regex edit, a renamed export) would make every assertion above vacuously
    // pass, and this guard would report green on the exact text it exists to catch.
    const preFix =
      'Then, BEFORE doing any work, go through your routing gate: outline the approach ' +
      'and present the execution options — (A) do it yourself, (B) hand it to the Mug, or ' +
      '(C) launch a fleet of agents to parallelize it — recommend one based on the plan ' +
      'size, and confirm with the owner which to use.';
    expect(
      findRetiredGuidanceOffenders(
        'packages/operator-core/lib/agent-tools/plans/launch-prompt.ts',
        preFix,
      ).length,
    ).toBeGreaterThan(0);
  });
});
