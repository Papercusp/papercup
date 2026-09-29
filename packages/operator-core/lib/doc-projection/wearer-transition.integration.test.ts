/**
 * portable-identity-packages-2026-09-26 P-003 (EI-24345639608517597) — ONE wearer-changed
 * path, proven against real Postgres and a REAL mid-session take-leadership.
 *
 * The defect: a Project-guide part addressed to `blueprint:su.fleet-leader` reached an
 * agent LAUNCHED as leader, but never an agent that BECAME leader mid-session — the stack
 * transition delivered only the changed layer text. The fix routes both through the same
 * wearer mapping and read (addressed-project-guide.ts), and this test drives the whole
 * mid-session path with no stand-in for any of its stages:
 *
 *   takeFleetLeadership (registry + presence + leader control: AUTO, loop, watches)
 *     → buildAndPersistControlAnchor (route + modes → stack)
 *     → preparePendingControlTransition (stackBefore → state.stack)
 *     → guideTargetFromLaunchSpec(readGateSelectedLaunchSpec)   (the turn-start target)
 *     → renderStackTransitionContextResult(transition, { guide })
 *
 * and compares what it delivered with what the LAUNCH composer — the one buildLaunchSpec
 * hands renderSuPlaybook — composes for a member and for a leader over the same rows:
 * launch-as-member − detached + attached == launch-as-leader, and every attached part
 * reaches the session byte-identical to the leader launch's rendering of it.
 *
 * Only launch leaves unrelated to the guide are stubbed (signing, token, cwd, the playbook
 * renderer — whose composeProjectGuide argument is captured and run for real).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const renderSuPlaybookMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ text: 'SU PLAYBOOK BODY', baseSource: '/p/su.md', overlaySource: '/p/o.md' })),
);
vi.mock('../desktop-install/papercusp-files', () => ({ renderSuPlaybook: (...a: unknown[]) => renderSuPlaybookMock(...a) }));
vi.mock('../superuser-token', () => ({ readSuperuserToken: vi.fn(() => 'TESTTOKEN') }));
vi.mock('../spawn-signing', () => ({
  signSpawnParams: vi.fn(async (params: URLSearchParams) => {
    params.set('exp', '9999999999');
    params.set('sig', 'TESTSIG');
    return { exp: 9999999999, sig: 'TESTSIG' };
  }),
}));
vi.mock('../spawn-config', () => ({ resolveProjectDir: vi.fn(async (slug: string) => `/registry/${slug}`) }));
vi.mock('../papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../papercusp-root')>()),
  papercuspPathForWorkspace: vi.fn((ws: string) => `/ws-root/${ws}`),
}));

import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { createFleetIfAbsent, getFleet } from '../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../agent-tools/coordination/presence';
import {
  acknowledgeControlTransition,
  buildAndPersistControlAnchor,
  preparePendingControlTransition,
  readGateSelectedLaunchSpec,
} from '../agent-tools/coordination/control-anchor';
import { takeFleetLeadership } from '../agent-tools/fleet_registry/take-leadership-core';
import { setMode } from '../modes/store';
import { DEFAULT_CLAIM_SPEC } from '../scheduler/claim-spec';
import { setClaimSpec } from '../scheduler/claim-spec-store';
import { buildLaunchSpec } from '../role-launch-spec';
import { renderStackTransitionContextResult, SU_POSTURE_REFS } from '../stack-binding-channel';
import { guideTargetFromLaunchSpec } from './addressed-project-guide';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
/** A harness unique to this run: the engineer guide's parts are read from PAPERCUSP_HARNESS_SLUG. */
const HARNESS = `zzz-p003-guide-${RUN}`;
const FLEET = `p003-fleet-${RUN}`;
const LEADER = `su-p003-leader-${RUN}`;
const MEMBER = `su-p003-member-${RUN}`;
const OWNERS = [LEADER, MEMBER];
const DEFAULT_GUIDE = '# DEFAULT GUIDE\n\nUnaddressed default text.\n';

/** Addressed rows: [part_key, stack_scope, client_scope, target_section, body]. */
const PARTS: Array<[string, string[], string[], string, string]> = [
  ['lead', ['blueprint:su.fleet-leader'], ['all'], 'Fleet leadership', 'LEADER-ONLY RULE: bench stalled lanes.'],
  ['auto', ['blueprint:su.mode-auto'], ['claude'], 'Autonomy', 'AUTO-ONLY RULE: disclose, do not ask.'],
  ['member', ['blueprint:su.fleet-member'], ['all'], 'Fleet membership', 'MEMBER-ONLY RULE: claim before editing.'],
  ['posture', ['slot:fleet-posture'], ['all'], 'Fleet', 'ANY-POSTURE RULE: stay in your fleet.'],
  ['codex-lead', ['blueprint:su.fleet-leader'], ['codex'], 'Fleet leadership', 'CODEX-ONLY LEADER RULE.'],
];
const UNADDRESSED_BODY = 'UNADDRESSED RULE: rides the default file only.';

let fx: BaselineCoordFixture;
let prevHarnessEnv: string | undefined;

async function launchGuide(fleetRole: 'member' | 'leader', modes: string[]) {
  renderSuPlaybookMock.mockClear();
  await buildLaunchSpec({
    kind: 'su', agent: 'claude', workspaceId: WS, operatorBaseUrl: 'http://localhost:3070', harnessSlug: HARNESS, fleetRole, modes,
  });
  const call = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as {
    composeProjectGuide?: (r: { text: string; source: string }) => Promise<{ text: string; addressed: { partKeys: string[] } | null }>;
  };
  expect(typeof call?.composeProjectGuide, 'buildLaunchSpec handed renderSuPlaybook no guide composer').toBe('function');
  return call.composeProjectGuide!({ text: DEFAULT_GUIDE, source: '/repo/CLAUDE.md' });
}

beforeEach(() => {
  // take-leadership publishes the fleet directory best-effort; with no p2p peer in this fixture
  // that leaf logs a warn. Not part of the guide path — the channel's own warnings are asserted
  // through its `warn` seam below. (Per test: the fail-on-console guard re-patches console each test.)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  prevHarnessEnv = process.env.PAPERCUSP_HARNESS_SLUG;
  process.env.PAPERCUSP_HARNESS_SLUG = HARNESS;
  for (const [i, [key, stackScope, clientScope, section, body]] of PARTS.entries()) {
    await fx.admin`
      INSERT INTO harness_shared.harness_doc_parts
        (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, client_scope, target_section, stack_scope)
      VALUES (${WS}, ${HARNESS}, 'claude-md', ${key}, 'invariant', ${body}, ${10 + i}, ${clientScope}, ${section}, ${stackScope})`;
  }
  await fx.admin`
    INSERT INTO harness_shared.harness_doc_parts
      (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, client_scope, target_section, stack_scope)
    VALUES (${WS}, ${HARNESS}, 'claude-md', 'unaddressed', 'invariant', ${UNADDRESSED_BODY}, 1, ${['all']}, 'General', ${[] as string[]})`;
  // The member's gate-selected launch record: an engineer claude launch (what turn-start reads).
  await fx.admin`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, launch_spec)
    VALUES (${WS}, 'console', ${MEMBER}, ${fx.admin.json({ profile: 'engineer', agent: 'claude', workspaceId: WS })})`;
  for (const ownerId of OWNERS) {
    await heartbeatPresence({ ownerId, ownerLabel: ownerId, source: 'omp-hook-session', workspaceId: WS, userId: null });
  }
  expect((await createFleetIfAbsent({ workspaceId: WS, fleetSlug: FLEET, leaderOwnerId: LEADER, title: 'P-003 fleet' }, fx.admin)).created).toBe(true);
  await setPresenceFleet(WS, LEADER, FLEET, 'leader', fx.admin);
  await setPresenceFleet(WS, MEMBER, FLEET, 'member', fx.admin);
  // take-leadership refuses a fleet without a concrete harness-bound claim spec.
  expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER, potSlug: HARNESS, spec: DEFAULT_CLAIM_SPEC }, fx.admin)).ok).toBe(true);
}, 150_000);

afterAll(async () => {
  if (prevHarnessEnv === undefined) delete process.env.PAPERCUSP_HARNESS_SLUG;
  else process.env.PAPERCUSP_HARNESS_SLUG = prevHarnessEnv;
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.harness_doc_parts WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS} AND coord_owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${`fleet:${FLEET}`}`;
  await fx.admin`DELETE FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
  for (const table of ['coord_presence', 'fleet_membership_events', 'session_briefs', 'agent_modes', 'agent_mode_changes']) {
    await fx.admin.unsafe(`DELETE FROM harness_shared.${table} WHERE workspace_id = $1 AND owner_id = ANY($2::text[])`, [WS, OWNERS]).catch(() => {});
  }
  await fx.dispose();
});

describe('P-003 — a real mid-session take-leadership delivers exactly what a leader launch delivers', () => {
  it('member → leader through the control transition carries the leader-addressed guide parts', async () => {
    // 1. The member's delivered baseline: its anchor as a MEMBER, acknowledged (delivery cursor at that generation).
    const asMember = await buildAndPersistControlAnchor(MEMBER, WS, { sql: fx.admin });
    const baseline = await preparePendingControlTransition(MEMBER, WS, fx.admin);
    expect(baseline, 'the member anchor produced no pending generation').not.toBeNull();
    expect(baseline!.state.stack).toContain(SU_POSTURE_REFS.member);
    expect(await acknowledgeControlTransition(MEMBER, WS, baseline!.generation, fx.admin)).toBe(true);
    const memberModes = [...(baseline!.state.modes ?? [])];
    expect(asMember.generation).toBe(baseline!.generation);

    // 2. A REAL take-leadership: registry, presence, prior-leader demotion, leader control.
    const fleet = await getFleet(WS, FLEET, fx.admin);
    expect(fleet?.leaderOwnerId).toBe(LEADER);
    const identity = { ownerId: MEMBER, ownerLabel: MEMBER, source: 'omp-hook-session', workspaceId: WS, userId: null } as const;
    const outcome = await takeFleetLeadership(WS, fleet!, identity as never, MEMBER, { harnessSlug: HARNESS });
    expect(outcome.leader).toBe(MEMBER);
    expect(outcome.demotedPriorLeader).toBe(LEADER);
    expect((await getFleet(WS, FLEET, fx.admin))?.leaderOwnerId).toBe(MEMBER);

    // 3. The control anchor re-derives the stack. Take-leadership moves several anchor facts
    //    (posture, AUTO, the loop), so the next delivery may be an exact next-generation
    //    transition (stackBefore = member) OR a full-resync (no stackBefore) — both are real.
    await buildAndPersistControlAnchor(MEMBER, WS, { sql: fx.admin });
    const transition = await preparePendingControlTransition(MEMBER, WS, fx.admin);
    expect(transition, 'take-leadership produced no pending control transition').not.toBeNull();
    expect(transition!.generation).toBeGreaterThan(baseline!.generation);
    expect(transition!.state.stack).toContain(SU_POSTURE_REFS.leader);
    if (transition!.kind === 'transition') expect(transition!.stackBefore).toContain(SU_POSTURE_REFS.member);
    else expect(transition!.stackBefore).toBeUndefined();
    const leaderModes = [...(transition!.state.modes ?? [])];

    // 4. The turn-start guide target: the gate-selected launch record of THIS session.
    const guide = guideTargetFromLaunchSpec(await readGateSelectedLaunchSpec(fx.admin, MEMBER, WS), { workspaceId: WS, client: null });
    expect(guide).toEqual({ workspaceId: WS, harnessSlug: HARNESS, client: 'claude' });

    // 5. Deliver: layer payloads (unchanged by the guide) + the addressed guide half.
    const warnings: string[] = [];
    const layersOnly = await renderStackTransitionContextResult(transition, { warn: (m) => warnings.push(m) });
    const delivered = await renderStackTransitionContextResult(transition, { guide, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
    expect(layersOnly.text.length).toBeGreaterThan(0);
    expect(delivered.rendered).toBe(layersOnly.rendered);
    expect(delivered.requiresFreshContext).toBe(layersOnly.requiresFreshContext);
    expect(delivered.text.startsWith(layersOnly.text)).toBe(true);
    const guideHalf = delivered.text.slice(layersOnly.text.length);

    // 6. What the LAUNCH composes for each posture, over the same rows, through buildLaunchSpec's own composer.
    const memberLaunch = await launchGuide('member', memberModes);
    const leaderLaunch = await launchGuide('leader', leaderModes);
    const memberKeys = memberLaunch.addressed?.partKeys ?? [];
    const leaderKeys = leaderLaunch.addressed?.partKeys ?? [];
    expect(memberKeys).toContain('member');
    expect(leaderKeys).toContain('lead');
    expect(leaderKeys).not.toContain('codex-lead');

    // EXACTLY what the leader launch delivers, checked for EVERY seeded part:
    //  - an exact next-generation transition carries the difference (member launch − detached + attached);
    //  - a full-resync carries the leader launch's complete addressed set and says it replaces the old one.
    const attached = leaderKeys.filter((k) => !memberKeys.includes(k));
    const detached = memberKeys.filter((k) => !leaderKeys.includes(k));
    expect(attached).toContain('lead');
    expect(detached).toContain('member');
    const expectedBodies = new Set(transition!.kind === 'transition' ? attached : leaderKeys);
    expectExactlyDelivered(guideHalf, expectedBodies);
    for (const k of expectedBodies) expect(leaderLaunch.text).toContain(bodyOf(k));
    if (transition!.kind === 'transition') {
      for (const k of detached) expect(guideHalf).toContain(`\`${k}\``);
    } else {
      expect(guideHalf).toContain('## Addressed guidance — the complete set for this session’s stack');
      expect(guideHalf).toContain('REPLACE any addressed guidance delivered to you earlier');
    }
    // AUTO arrived with leadership (leader control) — its addressed part rides the same transition.
    if (leaderModes.includes('auto') && !memberModes.includes('auto')) expect(expectedBodies.has('auto')).toBe(true);

    // 7. The delivery cursor is the anchor's, untouched by the guide: acknowledging advances it, and nothing is pending after.
    expect(await acknowledgeControlTransition(MEMBER, WS, transition!.generation, fx.admin)).toBe(true);
    expect(await preparePendingControlTransition(MEMBER, WS, fx.admin)).toBeNull();
    leaderModesAfterTakeover = leaderModes;
  }, 120_000);

  it('the new leader leaving AUTO: the next transition names the AUTO-addressed part as no longer applying, and re-sends nothing', async () => {
    expect(leaderModesAfterTakeover, 'depends on the take-leadership case above').toContain('auto');
    const off = await setMode({ workspaceId: WS, ownerId: MEMBER, modeId: 'auto', enabled: false, reason: 'P-003 exit AUTO', setBy: MEMBER, sql: fx.admin });
    expect(off.ok).toBe(true);
    await buildAndPersistControlAnchor(MEMBER, WS, { sql: fx.admin });
    const transition = await preparePendingControlTransition(MEMBER, WS, fx.admin);
    expect(transition).not.toBeNull();
    expect(transition!.state.stack).not.toContain('autonomy:su.mode-auto');
    const guide = guideTargetFromLaunchSpec(await readGateSelectedLaunchSpec(fx.admin, MEMBER, WS), { workspaceId: WS });
    const layersOnly = await renderStackTransitionContextResult(transition, {});
    const delivered = await renderStackTransitionContextResult(transition, { guide });
    const guideHalf = delivered.text.slice(layersOnly.text.length);
    const leaderNoAuto = await launchGuide('leader', [...(transition!.state.modes ?? [])]);
    const keys = leaderNoAuto.addressed?.partKeys ?? [];
    expect(keys).not.toContain('auto');
    if (transition!.kind === 'transition') {
      expectExactlyDelivered(guideHalf, new Set());
      expect(guideHalf).toContain('## Addressed guidance — no longer applies');
      expect(guideHalf).toContain('`auto`');
    } else {
      expectExactlyDelivered(guideHalf, new Set(keys));
    }
    expect(await acknowledgeControlTransition(MEMBER, WS, transition!.generation, fx.admin)).toBe(true);
    leaderLeftAuto = true;
  }, 120_000);

  it('the leader re-entering AUTO: an exact next-generation transition attaches ONLY the AUTO-addressed part', async () => {
    // The ATTACH half of the exact-transition diff. The take-leadership case may reach its
    // delivery through a full resync, and the AUTO-exit case only detaches. This case pins a
    // non-null stackBefore that newly GAINS an addressed token. It asserts the diff delivers
    // exactly that part and re-sends nothing the session already holds.
    expect(leaderLeftAuto, 'depends on the leave-AUTO case above').toBe(true);
    const on = await setMode({ workspaceId: WS, ownerId: MEMBER, modeId: 'auto', enabled: true, reason: 'P-003 re-enter AUTO', setBy: MEMBER, sql: fx.admin });
    expect(on.ok).toBe(true);
    await buildAndPersistControlAnchor(MEMBER, WS, { sql: fx.admin });
    const transition = await preparePendingControlTransition(MEMBER, WS, fx.admin);
    expect(transition).not.toBeNull();
    expect(transition!.kind, 'an acknowledged anchor one generation back must yield an exact transition').toBe('transition');
    expect(transition!.stackBefore).toBeDefined();
    expect(transition!.stackBefore).not.toContain('autonomy:su.mode-auto');
    expect(transition!.state.stack).toContain('autonomy:su.mode-auto');
    expect(transition!.state.stack).toContain(SU_POSTURE_REFS.leader);
    const guide = guideTargetFromLaunchSpec(await readGateSelectedLaunchSpec(fx.admin, MEMBER, WS), { workspaceId: WS });
    const layersOnly = await renderStackTransitionContextResult(transition, {});
    const delivered = await renderStackTransitionContextResult(transition, { guide });
    expect(delivered.text.startsWith(layersOnly.text)).toBe(true);
    const guideHalf = delivered.text.slice(layersOnly.text.length);
    const leaderAuto = await launchGuide('leader', [...(transition!.state.modes ?? [])]);
    expect(leaderAuto.addressed?.partKeys ?? []).toContain('auto');
    expectExactlyDelivered(guideHalf, new Set(['auto']));
    expect(leaderAuto.text).toContain(bodyOf('auto'));
    expect(guideHalf).not.toContain('## Addressed guidance — no longer applies');
    expect(guideHalf).not.toContain('REPLACE any addressed guidance delivered to you earlier');
    expect(await acknowledgeControlTransition(MEMBER, WS, transition!.generation, fx.admin)).toBe(true);
  }, 120_000);
});

let leaderModesAfterTakeover: string[] = [];
let leaderLeftAuto = false;
const bodyOf = (k: string) => PARTS.find(([key]) => key === k)![4];
/** Every seeded body appears in the delivered guide half iff its key is expected — and nothing unaddressed or default leaks. */
function expectExactlyDelivered(guideHalf: string, expected: ReadonlySet<string>) {
  for (const [key, , , , body] of PARTS) {
    if (expected.has(key)) expect(guideHalf, `expected ${key} delivered`).toContain(body);
    else expect(guideHalf, `expected ${key} NOT delivered`).not.toContain(body);
  }
  expect(guideHalf).not.toContain(UNADDRESSED_BODY);
  expect(guideHalf).not.toContain(DEFAULT_GUIDE.trim());
}
