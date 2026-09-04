/**
 * identities-v1-2026-08-30 P-012 — the operator side of the stack-mutation primitive:
 * the binding DERIVED from the anchor's route (pinned to the orchestrator's posture ids),
 * the anchor carrying `stack` and stamping `stackBefore`, and the turn-start delivery
 * that turns a transition into `⟦stack⟧` payloads over the REAL su stack.
 */
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as blueprint from '@papercusp/orchestrator/blueprint';
import { SU_MODE_REFS, SU_POSTURE_REFS, renderStackTransitionContext, stackRefsForModes, stackRefsForRoute, stackRefsForSession } from './stack-binding-channel';
import { normalizeControlAnchorState, type ControlAnchorState } from './agent-tools/coordination/control-anchor';

const here = dirname(fileURLToPath(import.meta.url));
// packages/operator-core/lib → <root>/libs/papercusp/packages/harness
const harnessDir = join(here, '..', '..', '..', 'libs', 'papercusp', 'packages', 'harness');

function state(over: Partial<ControlAnchorState> = {}): ControlAnchorState {
  return {
    modes: ['auto'],
    loop: { active: true, intervalSec: 60 },
    carry: 'warm',
    route: { kind: 'self' },
    scope: { workspace: 'papercusp-workspace', harness: 'papercusp', plan: null, items: [] },
    ...over,
  };
}

describe('stackRefsForRoute (P-012)', () => {
  it('projects the fleet posture from the route and nothing else; the ids are the orchestrator posture layers', () => {
    expect(stackRefsForRoute({ kind: 'self' })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'mug' })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: null })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: 'member' })).toEqual([SU_POSTURE_REFS.member]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: 'Leader' })).toEqual([SU_POSTURE_REFS.leader]);
    // The inlined refs are PINNED to the orchestrator's own posture layers (derived-truth rung 2).
    expect(SU_POSTURE_REFS.member).toBe(blueprint.bindingRef(blueprint.suPostureLayer('member')));
    expect(SU_POSTURE_REFS.leader).toBe(blueprint.bindingRef(blueprint.suPostureLayer('leader')));
  });

  it('P-021: the active modes project one definition layer per axis; the inlined refs are pinned to the orchestrator mode identities', () => {
    expect(stackRefsForModes([])).toEqual([]);
    expect(stackRefsForModes(['goal', 'grade', 'test', 'potato'])).toEqual([]);
    expect(stackRefsForModes(['auto'])).toEqual(['autonomy:su.mode-auto']);
    expect(stackRefsForModes(['cold-auto'])).toEqual(['autonomy:su.mode-auto']);
    expect(stackRefsForModes(['IDEATE', 'auto'])).toEqual(['ideation:su.mode-ideate', 'autonomy:su.mode-auto']);
    expect(stackRefsForModes(['drain', 'auto'])).toEqual(['objective:su.mode-drain', 'autonomy:su.mode-auto']);
    for (const [mode, ref] of Object.entries(SU_MODE_REFS)) {
      expect(ref, mode).toBe(blueprint.bindingRef(blueprint.suModeLayer(mode)!));
    }
    // every orchestrator mode identity is reachable from here, and nothing else is
    const orchestrator = blueprint.SU_MODE_DOCUMENTS.flatMap((d) => d.modes.map((m) => [m, blueprint.bindingRef({ slot: d.slot, id: d.id })] as const));
    expect(Object.entries(SU_MODE_REFS).sort()).toEqual([...orchestrator].sort());
    // route + modes compose: a fleet member in AUTO carries both
    expect(stackRefsForSession({ route: { kind: 'fleet', fleet: 'alpha', role: 'member' }, modes: ['auto'] })).toEqual([
      SU_POSTURE_REFS.member,
      'autonomy:su.mode-auto',
    ]);
    expect(stackRefsForSession({ route: { kind: 'self' }, modes: ['auto', 'ideate'] })).toEqual(['autonomy:su.mode-auto', 'ideation:su.mode-ideate']);
  });

  it('normalizeControlAnchorState carries `stack` only when non-empty, sorted + deduped', () => {
    expect('stack' in normalizeControlAnchorState(state())).toBe(false);
    expect('stack' in normalizeControlAnchorState(state({ stack: [] }))).toBe(false);
    expect(normalizeControlAnchorState(state({ stack: ['practice:b', 'fleet-posture:su.fleet-leader', 'practice:b'] })).stack).toEqual([
      'fleet-posture:su.fleet-leader',
      'practice:b',
    ]);
  });
});

describe('renderStackTransitionContext (P-012)', () => {
  const opts = { harnessDir, blueprint, warn: () => {} };

  it('delivers nothing when the stack did not move, or when a full-resync has nothing bound', async () => {
    expect(await renderStackTransitionContext({ state: state(), stackBefore: [] }, opts)).toBe('');
    expect(await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.member] }), stackBefore: [SU_POSTURE_REFS.member] }, opts)).toBe('');
    expect(await renderStackTransitionContext({ state: state() }, opts)).toBe('');
  });

  it('a fleet join attaches the member posture: a ⟦stack⟧ payload carrying the real posture text, no seal', async () => {
    const out = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.member] }), stackBefore: [] }, opts);
    expect(out.startsWith(`${blueprint.STACK_INJECTION_STAMP} {"op":"attach","slot":"fleet-posture","id":"su.fleet-member"`)).toBe(true);
    expect(out).toContain('## Working as a fleet MEMBER');
    expect(out).toContain('sits ABOVE the kernel seal');
    expect(out).not.toContain(blueprint.KERNEL_SEAL_MARKER);
  });

  it('take-leadership is ONE swap payload that names the replaced member posture; leaving the fleet voids it', async () => {
    const led = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.leader] }), stackBefore: [SU_POSTURE_REFS.member] }, opts);
    expect(led.split(blueprint.STACK_INJECTION_STAMP).length).toBe(2);
    expect(led).toContain('"replaced":"su.fleet-member"');
    expect(led).toContain('It REPLACES `su.fleet-member` on the exclusive `fleet-posture` slot');
    const left = await renderStackTransitionContext({ state: state(), stackBefore: [SU_POSTURE_REFS.leader] }, opts);
    expect(left).toContain('"op":"detach"');
    expect(left).toContain('NO LONGER APPLIES');
  });

  it('a full-resync (no stackBefore) re-delivers every bound layer; a broken render degrades to an empty block, never a throw', async () => {
    const out = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.leader] }) }, opts);
    expect(out).toContain('"id":"su.fleet-leader"');
    const warnings: string[] = [];
    const broken = await renderStackTransitionContext(
      { state: state({ stack: ['practice:no-such-document'] }), stackBefore: [] },
      { ...opts, warn: (m) => warnings.push(m) },
    );
    expect(broken).toBe('');
    expect(warnings[0]).toMatch(/stack transition not delivered/);
  });
});
