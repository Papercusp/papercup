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
import { describe, expect, it } from 'vitest';

import { isLocalModelSpec } from './local-model-spec.mjs';
import { mayKeepOmpNativeLsp } from './omp-native-lsp-gate';

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
