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
    const reads = src.match(new RegExp(`envelopeEnv\\?\\.${ENV} === '1'`, 'g')) ?? [];
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
      (src.match(new RegExp(`envelopeEnv\\?\\.${ENV} === '1'`, 'g')) ?? []).length;
    const countEmitting = (src: string) =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .filter((l) => l.includes("'--no-lsp'")).length;

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
      .filter((l) => l.includes("'--no-lsp'"));
    expect(emitting).toHaveLength(1);
    expect(emitting[0]).toContain('allowNativeLsp === true ? [] :');

    // Both omp branches must reach it through the helper.
    const viaHelper = src.match(/\.\.\.ompLspArgs\(allowNativeLsp\)/g) ?? [];
    expect(viaHelper).toHaveLength(2);
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
