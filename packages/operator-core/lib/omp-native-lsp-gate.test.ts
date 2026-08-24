/**
 * P-021 (D-013) — the OMP native-`lsp`-builtin gate.
 *
 * The load-bearing assertion here is the SAFETY INVARIANT: a local (weak) model
 * never keeps omp's native `lsp` builtin, no matter how the flag is set. That
 * invariant is what lets FLAGS.OMP_NATIVE_LSP_BUILTIN ship DEFAULT-ON instead of
 * as a dark flag, so if it ever stops holding, this feature's justification is
 * gone and this file is where that must surface.
 *
 * FALSIFIABILITY (per the repo's guard-test discipline): the invariant block
 * below carries a permanent WRONG-implementation control — `naiveGate`, the
 * flag-only version someone would write if they dropped the tier term. It is
 * asserted to FAIL on the same inputs the real gate passes, so a test run where
 * both agree means the control has gone stale and the suite is no longer
 * pinning anything. No production code is mutated to prove this.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isLocalModelSpec } from './local-model-spec.mjs';
import { mayKeepOmpNativeLsp } from './omp-native-lsp-gate';
import { ompModelTierAllowsNativeLsp } from './omp-native-lsp-tier.mjs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Model specs that MUST be treated as local/weak. */
const LOCAL_SPECS = [
  'ollama/llama3',
  'ollama-cc/qwen2.5-coder',
  'ornith',
  'ornith:fast',
  'ollama/ornith-35b',
  'maxwell1500/ornith-35b:IQ3_M',
  'OLLAMA/Llama3', // case-insensitive
  'ollama/llama3:high', // effort tail must not hide it
  'ornith[1m]', // window marker must not hide it
];

/** Model specs that are cloud-routed and therefore eligible. */
const CLOUD_SPECS = [
  'sonnet:medium',
  'claude-sonnet-5',
  'gpt-5.5:high',
  'o3',
  'luna',
  'fable[1m]',
];

describe('isLocalModelSpec', () => {
  it.each(LOCAL_SPECS)('treats %s as local', (spec) => {
    expect(isLocalModelSpec(spec)).toBe(true);
  });

  it.each(CLOUD_SPECS)('treats %s as NOT local', (spec) => {
    expect(isLocalModelSpec(spec)).toBe(false);
  });

  it('an absent spec is not a local spec (absence is handled by the gate, not here)', () => {
    expect(isLocalModelSpec(null)).toBe(false);
    expect(isLocalModelSpec(undefined)).toBe(false);
    expect(isLocalModelSpec('   ')).toBe(false);
  });
});

describe('mayKeepOmpNativeLsp — SAFETY INVARIANT', () => {
  /**
   * The WRONG gate: flag-only, no tier term. Kept permanently as a control so
   * the invariant assertions below cannot silently stop discriminating.
   */
  const naiveGate = ({ agent, flagEnabled }: { agent: string; flagEnabled: boolean }) =>
    agent === 'omp' && flagEnabled;

  it.each(LOCAL_SPECS)(
    'a LOCAL model (%s) NEVER keeps the builtin, even with the flag ON',
    (model) => {
      expect(
        mayKeepOmpNativeLsp({ agent: 'omp', model, flagEnabled: true }),
      ).toBe(false);

      // CONTROL: the flag-only gate WOULD have handed it the builtin. If this
      // ever passes, `naiveGate` has drifted into correctness and stopped
      // being a control — fix the control, do not delete the assertion.
      expect(naiveGate({ agent: 'omp', flagEnabled: true })).toBe(true);
    },
  );

  it('an UNKNOWN model fails CLOSED — omp falls back to its own local default', () => {
    for (const model of [null, undefined, '', '   ']) {
      expect(mayKeepOmpNativeLsp({ agent: 'omp', model, flagEnabled: true })).toBe(false);
    }
    // CONTROL: flag-only would have allowed it.
    expect(naiveGate({ agent: 'omp', flagEnabled: true })).toBe(true);
  });

  /**
   * CALIBRATION: without this, every assertion above would still pass if
   * `mayKeepOmpNativeLsp` were hard-coded to `false` — i.e. if the feature did
   * nothing at all. This is the case that proves the gate can also say YES.
   */
  it.each(CLOUD_SPECS)('a CLOUD model (%s) DOES keep the builtin when the flag is ON', (model) => {
    expect(mayKeepOmpNativeLsp({ agent: 'omp', model, flagEnabled: true })).toBe(true);
  });
});

/**
 * THE WIRING, not the logic.
 *
 * `PAPERCUSP_OMP_NATIVE_LSP` is a magic string crossing a package boundary: two
 * PRODUCERS (bootstrap-su, bootstrap-role) set it, two CONSUMERS (psu-launcher's
 * role + su callers) read it. It cannot be a shared constant because the
 * launcher is bare `node` and cannot import TypeScript — the same constraint
 * that shaped the whole design.
 *
 * That leaves one failure this suite would otherwise miss entirely: a TYPO in
 * any one of the four spellings silently disables the feature forever. Nothing
 * throws, no unit test fails (they all pass `allowNativeLsp` directly), and the
 * observable symptom is merely that omp keeps behaving exactly as it did
 * before — which is also what SUCCESS looks like when the flag is off.
 *
 * It also pins the "fix BOTH sites or the change is half-applied" property at
 * the wiring layer, where the two `--no-lsp` literals originally diverged.
 */
describe('PAPERCUSP_OMP_NATIVE_LSP wiring (producers ↔ consumers)', () => {
  const ENV = 'PAPERCUSP_OMP_NATIVE_LSP';
  const LAUNCHER = 'apps/operator/scripts/psu-launcher.mjs';
  const BOOTSTRAPS = [
    'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts',
    'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts',
  ];

  it.each(BOOTSTRAPS)('%s SETS the env when the gate allows it', (rel) => {
    const src = read(rel);
    expect(src).toContain(`${ENV}: '1'`);
    // …and reaches that decision through the shared gate, not a re-implemented
    // boolean that could omit the tier term.
    expect(src).toContain('mayKeepOmpNativeLsp');
  });

  it('the launcher READS the same env at BOTH omp call sites', () => {
    const src = read(LAUNCHER);
    // Quote-agnostic (['"]): formatting sweeps flip the launcher between quote styles
    // (single→double 2026-08-22) while both reads stay wired — pin the WIRING, not the quotes.
    const reads = src.match(new RegExp(`envelopeEnv\\?\\.${ENV} === ['"]1['"]`, 'g')) ?? [];
    // Exactly two: the roleLaunchArgs caller and the suLaunchArgs caller.
    expect(reads).toHaveLength(2);
  });

  /**
   * CONTROL for the two matchers above. A source-reading assertion is only as
   * good as its regex, and a regex that silently matches nothing passes for the
   * same reason a correct file does. Rather than mutate the real launcher to
   * prove that (the sweep can commit a mutant — see the repo's mutation-probe
   * discipline), run the SAME matchers against synthetic sources that are wrong
   * in the two ways this feature can actually break.
   */
  it('CONTROL: the wiring matchers reject a half-applied change', () => {
    const countReads = (src: string) =>
      (src.match(new RegExp(`envelopeEnv\\?\\.${ENV} === ['"]1['"]`, 'g')) ?? []).length;
    const countEmitting = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .filter((l) => /['"]--no-lsp['"]/.test(l)).length;

    // HALF-APPLIED: the helper exists and ONE omp branch was converted, but the
    // other still carries the literal — exactly how the two original sites
    // could diverge again.
    const halfApplied = [
      '  return allowNativeLsp === true ? [] : [\'--no-lsp\'];', // the helper itself
      "    allowNativeLsp: res.envelopeEnv?.PAPERCUSP_OMP_NATIVE_LSP === '1',",
      '      ...ompLspArgs(allowNativeLsp),',
      "      '--no-lsp',", // the branch someone forgot
    ].join('\n');
    expect(countReads(halfApplied)).not.toBe(2); // only one caller wired
    expect(countEmitting(halfApplied)).not.toBe(1); // two emitting lines, not one

    // TYPO: a near-miss spelling wires nothing but reads plausibly.
    const typo = "    allowNativeLsp: res.envelopeEnv?.PAPERCUSP_OMP_LSP === '1',";
    expect(countReads(typo)).toBe(0);
    expect(new Set(typo.match(/PAPERCUSP_OMP[A-Z_]*LSP[A-Z_]*/g) ?? [])).not.toEqual(
      new Set([ENV]),
    );
  });

  it('no stray spelling of the env exists anywhere in the four sites', () => {
    // A near-miss (PAPERCUSP_OMP_NATIVE_LSP_BUILTIN, _OMP_LSP, …) would satisfy
    // a `toContain` above while wiring nothing, so assert the exact token count.
    for (const rel of [LAUNCHER, ...BOOTSTRAPS]) {
      const src = read(rel);
      const loose = src.match(/PAPERCUSP_OMP[A-Z_]*LSP[A-Z_]*/g) ?? [];
      expect(new Set(loose)).toEqual(new Set([ENV]));
    }
  });

  it('the launcher no longer hard-codes --no-lsp — it goes through ompLspArgs', () => {
    const src = read(LAUNCHER);
    // Count only lines that could EMIT the flag; the rationale comments
    // legitimately quote it, and counting those made this assertion fail on
    // documentation rather than on a re-introduced literal.
    const emitting = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .filter((l) => /['"]--no-lsp['"]/.test(l));
    expect(emitting).toHaveLength(1);
    expect(emitting[0]).toContain('allowNativeLsp === true ? [] :');

    // All THREE omp branches must reach it through the helper: the two fresh
    // paths (role + su) and — since P-023 — the RESUME path.
    const viaHelper = src.match(/\.\.\.ompLspArgs\(allowNativeLsp\)/g) ?? [];
    expect(viaHelper).toHaveLength(3);
  });
});

/**
 * P-023 (D-015) — THE RESUME PATH.
 *
 * The hole this pins was invisible to every assertion above, and the reason is
 * worth stating because it generalises: P-021 converted two hard-coded
 * `'--no-lsp'` literals into `ompLspArgs` calls, and every guard was written to
 * count LITERALS and CONVERSIONS. `resumeArgsFor` had no literal to convert —
 * it simply never emitted the flag at all — so a suite watching for a
 * re-introduced literal could not see it. An omission leaves no token to count.
 *
 * Consequence before the fix: omp CLI flags do not persist into a resume, so
 * EVERY resumed omp session kept the native `lsp` builtin unconditionally —
 * including sessions on weak LOCAL models, the exact population the tier gate
 * exists to exclude. Fail-open, in the one direction that matters.
 *
 * These assertions are structural (source-read) for the same reason the wiring
 * block above is: `resumeArgsFor` is in a bare-node `.mjs` this TS suite cannot
 * import. The BEHAVIOUR of the term it applies is pinned directly, below.
 */
describe('the omp RESUME path re-applies the gate (P-023)', () => {
  const LAUNCHER = 'apps/operator/scripts/psu-launcher.mjs';

  /** The `resumeArgsFor` omp branch, sliced out of the launcher source. Quote-agnostic:
   *  formatting sweeps flip the launcher between quote styles (single→double 2026-08-22)
   *  while the branch's pinned properties hold — pin the STRUCTURE, not the quotes. */
  function ompResumeBranch(src: string): string {
    const start = src.indexOf('export function resumeArgsFor');
    expect(start).toBeGreaterThan(-1);
    const findAgentIf = (agent: string, from: number): number => {
      const re = new RegExp(`if \\(session\\.agent === ['"]${agent}['"]\\)`, 'g');
      re.lastIndex = from;
      const m = re.exec(src);
      return m ? m.index : -1;
    };
    const branch = findAgentIf('omp', start);
    expect(branch).toBeGreaterThan(-1);
    const end = findAgentIf('codex', branch);
    expect(end).toBeGreaterThan(branch);
    return src.slice(branch, end);
  }

  it('routes through ompLspArgs instead of silently emitting nothing', () => {
    const branch = ompResumeBranch(read(LAUNCHER));
    expect(branch).toContain('ompLspArgs(allowNativeLsp)');
  });

  it('applies the SHARED tier term, not a re-typed copy of it', () => {
    const src = read(LAUNCHER);
    // The whole point of omp-native-lsp-tier.mjs: a second hand-written
    // `!isLocalModelSpec(model)` here would re-create the drift the gate file
    // was written to prevent.
    expect(src).toContain('omp-native-lsp-tier.mjs');
    expect(ompResumeBranch(src)).toContain('ompModelTierAllowsNativeLsp(model)');
  });

  it('CONTROL: these matchers reject the pre-P-023 branch', () => {
    // The real branch as it stood before the fix — flags re-passed, gate absent.
    // Without this control the two assertions above would be satisfied by any
    // file that merely MENTIONS the helper somewhere else, which is exactly the
    // failure mode a source-read test has.
    const preFix = [
      "  if (session.agent === 'omp') {",
      "    const args = session.ompThreadId ? ['-r', session.ompThreadId] : ['-c'];",
      "    args.push('--approval-mode', 'yolo');",
      "    if (coordExtPath) args.push('-e', coordExtPath);",
      "    if (injectHookPath) args.push('--hook', injectHookPath);",
      "    if (model) args.push(...modelArgsFor('omp', model));",
      "    return { bin: 'omp', args };",
      '  }',
    ].join('\n');
    expect(preFix).not.toContain('ompLspArgs');
    expect(preFix).not.toContain('ompModelTierAllowsNativeLsp');
    // And the omission really is invisible to a literal-counting guard — the
    // assertion style that let this survive P-021 in the first place.
    expect(preFix.includes("'--no-lsp'")).toBe(false);
  });
});

describe('mayKeepOmpNativeLsp — the other terms', () => {
  it('the flag is a real kill-switch: OFF strips the builtin for every model', () => {
    for (const model of [...CLOUD_SPECS, ...LOCAL_SPECS]) {
      expect(mayKeepOmpNativeLsp({ agent: 'omp', model, flagEnabled: false })).toBe(false);
    }
  });

  it('non-omp backends are always false — the builtin only exists on omp', () => {
    for (const agent of ['claude', 'codex', '', null, undefined]) {
      expect(
        mayKeepOmpNativeLsp({ agent, model: 'sonnet:medium', flagEnabled: true }),
      ).toBe(false);
    }
  });

  it('a non-boolean flag value is not truthy-coerced into an allow', () => {
    expect(
      mayKeepOmpNativeLsp({
        agent: 'omp',
        model: 'sonnet:medium',
        // A resolver returning a non-boolean must not read as enabled.
        flagEnabled: 'yes' as unknown as boolean,
      }),
    ).toBe(false);
  });
});

/**
 * ompModelTierAllowsNativeLsp — the term the RESUME path applies on its own.
 *
 * This is the half of the gate that fails CLOSED, which is why it is the half
 * safe to enforce without the flag. Its behaviour is pinned here directly (the
 * resume-path tests above can only read source, since the launcher is bare-node
 * `.mjs`), and the delegation test below is what stops the two copies of this
 * rule that P-023 was created to merge from quietly separating again.
 */
describe('ompModelTierAllowsNativeLsp — the shared tier term', () => {
  it.each(LOCAL_SPECS)('a LOCAL model (%s) is never tier-eligible', (model) => {
    expect(ompModelTierAllowsNativeLsp(model)).toBe(false);
  });

  it.each(CLOUD_SPECS)('a CLOUD model (%s) is tier-eligible', (model) => {
    expect(ompModelTierAllowsNativeLsp(model)).toBe(true);
  });

  it.each([null, undefined, '', '   '])(
    'an UNKNOWN/blank spec (%p) FAILS CLOSED — omp would run its local default',
    (model) => {
      expect(ompModelTierAllowsNativeLsp(model as string | null | undefined)).toBe(false);
    },
  );

  /**
   * The delegation, asserted behaviourally rather than by reading source: for
   * every spec, the full gate with the flag ON must agree exactly with the tier
   * term. If someone re-inlines a subtly different rule into either side, these
   * diverge on the spec where they differ.
   */
  it('mayKeepOmpNativeLsp(flag ON) agrees with the tier term on EVERY spec', () => {
    for (const model of [...CLOUD_SPECS, ...LOCAL_SPECS, '', null, undefined]) {
      expect(mayKeepOmpNativeLsp({ agent: 'omp', model, flagEnabled: true })).toBe(
        ompModelTierAllowsNativeLsp(model),
      );
    }
  });

  /**
   * FALSIFIABILITY CONTROL, matching this file's convention: the wrong
   * implementation someone would write if they read "not local" as
   * tier-eligible. It must DISAGREE with the real term on the unknown-model
   * case — the case that carries the whole safety argument. If these ever
   * agree, the control has gone stale and the block above pins nothing.
   */
  it('CONTROL: a naive !isLocalModelSpec term differs on the unknown model', () => {
    const naiveTier = (model: string | null | undefined) => !isLocalModelSpec(model);
    expect(naiveTier(null)).toBe(true); // the bug: absence read as "safe"
    expect(ompModelTierAllowsNativeLsp(null)).toBe(false); // the fix
    expect(naiveTier(null)).not.toBe(ompModelTierAllowsNativeLsp(null));
    // …and they must still AGREE wherever a spec is actually present, or the
    // control is not isolating the unknown-model case at all.
    for (const model of [...CLOUD_SPECS, ...LOCAL_SPECS]) {
      expect(naiveTier(model)).toBe(ompModelTierAllowsNativeLsp(model));
    }
  });
});
