import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DIRECTED_IMPLEMENTER_DENY_TOOLS,
  assertConfinementCoversIndirectDispatch,
  directedImplementerConfinement,
  evaluateSessionConfinement,
  toDenyMatchKey,
  type SessionToolConfinement,
} from './session-confinement';

const CONFINEMENT: SessionToolConfinement = directedImplementerConfinement({
  directorSid: 'su-director-1',
  workItemId: 'WI-1234',
});

const evaluate = (toolName: string) =>
  evaluateSessionConfinement({ toolName, confinement: CONFINEMENT });

describe('session confinement — basic gate', () => {
  it('is inert for an unconfined session, and says so via applied:false', () => {
    const d = evaluateSessionConfinement({ toolName: 'work_items:complete' });
    expect(d.allowed).toBe(true);
    expect(d.applied).toBe(false);
  });

  it('treats an empty denyTools list as unconfined rather than as deny-all', () => {
    const d = evaluateSessionConfinement({
      toolName: 'work_items:complete',
      confinement: { denyTools: [], reason: 'r', imposedBy: 'x' },
    });
    expect(d.allowed).toBe(true);
    expect(d.applied).toBe(false);
  });

  it('refuses each tool in the D-004 minimum set', () => {
    for (const tool of ['work_items:complete', 'scheduler:get_next', 'loop:arm']) {
      expect(evaluate(tool).allowed, `${tool} must be denied`).toBe(false);
    }
  });

  it('names the imposer, the reason and the matched glob in the refusal', () => {
    const d = evaluate('work_items:complete');
    expect(d.allowed).toBe(false);
    expect(d.matchedGlob).toBe('work_items:complete');
    expect(d.reason).toContain('su-director-1');
    expect(d.reason).toContain('WI-1234');
  });

  it('matches globs, so the self-lift surface cannot be reached by a sibling verb', () => {
    expect(evaluate('capability_envelope:set_protected').allowed).toBe(false);
    expect(evaluate('meta:define-tool').allowed).toBe(false);
    expect(evaluate('meta:define-datatype').allowed).toBe(false);
  });
});

describe('session confinement — the collateral the capability grain got wrong', () => {
  // This is the regression that motivated a tool-grain gate at all (D-015 ¶4):
  // work_items:complete and scheduler:get_next both declare capability
  // 'work_items:write', which is shared by 43 tools. A capability-grain deny would
  // take the implementer's own progress-recording down with the target.
  it.each([
    'work_items:checkpoint',
    'work_items:comment',
    'work_items:claim',
    'work_items:create',
    'work_items:set_state',
    'coord:send',
    'testing:run',
    'capability:bash',
  ])('leaves %s reachable — the implementer still has to do its job', (tool) => {
    expect(evaluate(tool).allowed).toBe(true);
  });

  it('denies claim_next but not claim — self-acquisition is the target, not claiming', () => {
    expect(evaluate('work_items:claim_next').allowed).toBe(false);
    expect(evaluate('work_items:claim').allowed).toBe(true);
  });
});

describe('session confinement — client name mangling cannot bypass it', () => {
  it('folds both spellings onto one match key', () => {
    expect(toDenyMatchKey('mcp__papercusp-su__work_items_complete')).toBe(
      'work_items_complete',
    );
    expect(toDenyMatchKey('work_items:complete')).toBe('work_items_complete');
    // The underscore-bearing verb that makes reconstructing the colon unsound.
    expect(toDenyMatchKey('mcp__papercusp-su__scheduler_get_next')).toBe(
      toDenyMatchKey('scheduler:get_next'),
    );
  });

  it('denies the mangled spelling too — a denial that catches one spelling is not a denial', () => {
    expect(evaluate('mcp__papercusp-su__work_items_complete').allowed).toBe(false);
    expect(evaluate('mcp__papercusp-su__scheduler_get_next').allowed).toBe(false);
  });

  it('agrees between the two spellings for every tool in the deny set', () => {
    for (const glob of DIRECTED_IMPLEMENTER_DENY_TOOLS) {
      if (glob.includes('*')) continue; // globs have no single mangled spelling
      const mangled = `mcp__papercusp-su__${glob.replace(':', '_')}`;
      expect(evaluate(glob).allowed, glob).toBe(false);
      expect(evaluate(mangled).allowed, mangled).toBe(false);
    }
  });
});

describe('session confinement — the wiring invariant is itself falsifiable', () => {
  it('passes for a gate that actually consults the confinement', () => {
    expect(() => assertConfinementCoversIndirectDispatch(evaluate)).not.toThrow();
  });

  // Falsifiability control: a gate wired ONLY at the outer boundary looks exactly like
  // this from the dispatch seat — it allows everything it is asked about. If this
  // assertion ever stops throwing, the invariant has become decorative.
  it('throws for a gate that is not consulted at the dispatch seat', () => {
    const notWired = () => ({ allowed: true, applied: false });
    expect(() => assertConfinementCoversIndirectDispatch(notWired)).toThrow(
      /not consulted at the dispatch seat/,
    );
  });
});

describe('session confinement — structural guarantees, pinned to the source', () => {
  // Subject path is overridable so this guard can be falsifiability-probed against a
  // COPY outside the tree (scripts/mutation-probe.sh tier 2) instead of by mutating the
  // shared checkout, which git-sync would happily commit mid-probe.
  const SUBJECT = process.env.PROBE_SESSION_CONFINEMENT_SRC ?? join(__dirname, 'session-confinement.ts');
  const SOURCE = readFileSync(SUBJECT, 'utf8');
  // Strip the header/JSDoc prose: the comments legitimately DISCUSS isSuperuser and
  // allowTools, and a guard that cannot tell prose from code would be unfixable.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // Calibration — proves the stripped-code corpus is real and non-empty, so the two
  // absence assertions below cannot pass merely because CODE came out blank.
  it('calibration: the stripped source still contains the gate itself', () => {
    expect(CODE).toContain('evaluateSessionConfinement');
    expect(CODE).toContain('denyTools');
    expect(CODE.length).toBeGreaterThan(500);
  });

  // Guarantee (A): it cannot be bypassed by privilege because it never receives it.
  it('never references privilege — there is no privilege check to get wrong', () => {
    expect(CODE).not.toMatch(/isSuperuser|isPowerUser/);
    expect(CODE).not.toMatch(/UnifiedToolContext/);
  });

  // Guarantee (B): it cannot widen because it has no allow vocabulary.
  it('has no allow dimension — the worst a bad confinement can do is deny more', () => {
    expect(CODE).not.toMatch(/allowTools|allowCapabilities/);
  });

  it('the deny set is documented — every entry sits under an explaining comment', () => {
    // The deny list is the part a future reader is most tempted to trim; the comments
    // are what make trimming a decision rather than a cleanup.
    const block = SOURCE.slice(SOURCE.indexOf('DIRECTED_IMPLEMENTER_DENY_TOOLS'));
    expect(block).toContain('D-004 minimum set');
    expect(block).toContain('Self-lift');
  });
});
