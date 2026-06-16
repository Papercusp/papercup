// @vitest-environment jsdom
//
// useLexicon flag-gated resolution + reactivity (the-hive-lexicon P-003).
// The hook lives at apps/operator/lib/useLexicon (reachable via @/lib from both
// operator-vite and apps/operator/app); tested here for the jsdom+RTL harness.

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { FLAGS, type FlagPayload, resolveWithDefaults } from '@papercusp/flags';
import { setFlagPayload } from '@papercusp/flags/client';

import { useLexicon, useLexiconPackId } from '@/lib/useLexicon';

function setHive(on: boolean): void {
  const payload: FlagPayload = {
    flags: resolveWithDefaults({ [FLAGS.THE_HIVE]: on }),
    evaluatedAt: 1,
    source: 'override',
  };
  act(() => setFlagPayload(payload));
}

afterEach(() => {
  cleanup();
  setHive(false); // reset the module store between tests
});

function Probe() {
  const t = useLexicon();
  const pack = useLexiconPackId();
  return (
    <div>
      <span data-testid="pack">{pack}</span>
      <span data-testid="pot">{t('pot')}</span>
      <span data-testid="pots">{t('pot', { plural: true })}</span>
      <span data-testid="cupboard">{t('cupboard')}</span>
      <span data-testid="operator-lower">{t('operator', { lower: true })}</span>
    </div>
  );
}

describe('useLexicon', () => {
  it('resolves classic labels when the-hive is off', () => {
    setHive(false);
    render(<Probe />);
    expect(screen.getByTestId('pack').textContent).toBe('classic');
    // Owner directive 2026-06-16: `pot` is canonically "Hive" in the baseline too.
    expect(screen.getByTestId('pot').textContent).toBe('Hive');
    expect(screen.getByTestId('pots').textContent).toBe('Hives');
    expect(screen.getByTestId('cupboard').textContent).toBe('Cupboard');
    expect(screen.getByTestId('operator-lower').textContent).toBe('operator');
  });

  it('resolves the bee lexicon when the-hive is on', () => {
    setHive(true);
    render(<Probe />);
    expect(screen.getByTestId('pack').textContent).toBe('the-hive');
    expect(screen.getByTestId('pot').textContent).toBe('Hive');
    expect(screen.getByTestId('pots').textContent).toBe('Hives');
    expect(screen.getByTestId('cupboard').textContent).toBe('Comb');
    // Canon (lexicon packs.ts, owner directive 2026-06-09 / hive-agent-tabs P-003):
    // the operator chat is the Sentinel (renamed from the earlier "Sentinel Bee");
    // "Queen" now names the brain.
    expect(screen.getByTestId('operator-lower').textContent).toBe('sentinel');
  });

  it('re-renders on a live flag flip (reactive, not render-time only)', () => {
    setHive(false);
    render(<Probe />);
    // `pot` resolves to "Hive" in BOTH packs now, so assert on a term that still
    // DIFFERS across packs (operator → sentinel) to prove the live reactivity.
    expect(screen.getByTestId('operator-lower').textContent).toBe('operator');
    setHive(true); // SSE-style live flip
    expect(screen.getByTestId('operator-lower').textContent).toBe('sentinel');
    expect(screen.getByTestId('pack').textContent).toBe('the-hive');
  });
});
