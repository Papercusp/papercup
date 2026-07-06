import { describe, expect, it } from 'vitest';
import {
  allowedFrameworks,
  frameworkInstalled,
  frameworkSignedIn,
  requiredSetupComplete,
  resolveStage,
  type OnboardingSnapshot,
} from './stage-resolver';

function snap(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    claudeInstalled: false,
    codexInstalled: false,
    ompInstalled: false,
    claudeSignedIn: false,
    codexSignedIn: false,
    ompSignedIn: false,
    embeddingsKeyPresent: false,
    setupFinished: false,
    ...overrides,
  };
}

describe('allowedFrameworks', () => {
  it('offers claude + codex + omp on every OS (meridian decommissioned; omp now installable cross-platform)', () => {
    expect(allowedFrameworks('win32')).toEqual(['claude', 'codex', 'omp']);
    expect(allowedFrameworks('linux')).toEqual(['claude', 'codex', 'omp']);
    expect(allowedFrameworks('darwin')).toEqual(['claude', 'codex', 'omp']);
  });
});

describe('frameworkInstalled / frameworkSignedIn', () => {
  it('maps per-framework installed flags', () => {
    expect(frameworkInstalled('claude', snap({ claudeInstalled: true }))).toBe(true);
    expect(frameworkInstalled('codex', snap({ claudeInstalled: true }))).toBe(false);
    expect(frameworkInstalled('codex', snap({ codexInstalled: true }))).toBe(true);
    expect(frameworkInstalled('omp', snap({ ompInstalled: true }))).toBe(true);
    expect(frameworkInstalled('omp', snap({ codexInstalled: true }))).toBe(false);
  });
  it('maps per-framework sign-in flags', () => {
    expect(frameworkSignedIn('claude', snap({ claudeSignedIn: true }))).toBe(true);
    expect(frameworkSignedIn('codex', snap({ claudeSignedIn: true }))).toBe(false);
    expect(frameworkSignedIn('codex', snap({ codexSignedIn: true }))).toBe(true);
    expect(frameworkSignedIn('omp', snap({ ompSignedIn: true }))).toBe(true);
  });
});

describe('requiredSetupComplete', () => {
  it('needs a ready backend AND the embeddings key', () => {
    expect(requiredSetupComplete(snap())).toBe(false);
    // ready backend but no key → still incomplete (mem0 is required)
    expect(
      requiredSetupComplete(snap({ claudeInstalled: true, claudeSignedIn: true })),
    ).toBe(false);
    // key but no ready backend → incomplete
    expect(requiredSetupComplete(snap({ embeddingsKeyPresent: true }))).toBe(false);
    // both → complete (omp counts as a ready backend)
    expect(
      requiredSetupComplete(
        snap({ ompInstalled: true, ompSignedIn: true, embeddingsKeyPresent: true }),
      ),
    ).toBe(true);
  });
});

describe('resolveStage', () => {
  it('done requires BOTH graduation AND the embeddings key', () => {
    // graduated but no key → NOT done (mem0 required); falls through to pick here
    expect(resolveStage(snap({ setupFinished: true }))).toMatchObject({ stage: 'pick' });
    expect(resolveStage(snap({ setupFinished: true, embeddingsKeyPresent: true }))).toEqual({
      stage: 'done',
    });
  });

  it('graduated + ready backend but key skipped → re-offers embeddings (nag), not done', () => {
    const s = snap({ setupFinished: true, claudeInstalled: true, claudeSignedIn: true });
    expect(resolveStage(s)).toEqual({ stage: 'embeddings', framework: 'claude' });
  });

  it('tutorial re-entry: a FINISHED machine resolves to handoff, not done (P-014)', () => {
    const s = snap({ setupFinished: true, claudeInstalled: true, claudeSignedIn: true });
    expect(resolveStage(s, { tutorial: true })).toEqual({ stage: 'handoff', framework: 'claude' });
  });

  it('tutorial re-entry never re-nags for the embeddings key', () => {
    const s = snap({
      setupFinished: true,
      claudeInstalled: true,
      claudeSignedIn: true,
      embeddingsKeyPresent: false, // user skipped it during first-run
    });
    expect(resolveStage(s, { tutorial: true })).toEqual({ stage: 'handoff', framework: 'claude' });
  });

  it('tutorial re-entry on a finished machine whose backend VANISHED walks setup again', () => {
    // e.g. the CLI was uninstalled since graduation — the tutorial still needs an agent.
    const s = snap({ setupFinished: true });
    expect(resolveStage(s, { tutorial: true })).toMatchObject({ stage: 'pick' });
    expect(
      resolveStage(snap({ setupFinished: true, claudeInstalled: true }), {
        tutorial: true,
        chosen: 'claude',
      }),
    ).toEqual({ stage: 'login', framework: 'claude' });
  });

  it('pick when nothing installed and nothing chosen', () => {
    expect(resolveStage(snap())).toEqual({
      stage: 'pick',
      frameworks: ['claude', 'codex', 'omp'],
      detected: [],
    });
  });

  it('omp is a first-class framework: install → login → embeddings → handoff', () => {
    expect(resolveStage(snap(), { chosen: 'omp' })).toEqual({ stage: 'install', framework: 'omp' });
    expect(resolveStage(snap({ ompInstalled: true }), { chosen: 'omp' })).toEqual({
      stage: 'login',
      framework: 'omp',
    });
    expect(resolveStage(snap({ ompInstalled: true, ompSignedIn: true }), { chosen: 'omp' })).toEqual({
      stage: 'embeddings',
      framework: 'omp',
    });
    expect(
      resolveStage(
        snap({ ompInstalled: true, ompSignedIn: true, embeddingsKeyPresent: true }),
        { chosen: 'omp' },
      ),
    ).toEqual({ stage: 'handoff', framework: 'omp' });
  });

  it('pick lists partially-detected frameworks (installed but not signed in)', () => {
    const s = snap({ codexInstalled: true });
    expect(resolveStage(s)).toMatchObject({ stage: 'pick', detected: ['codex'] });
  });

  it('pre-detection skips picker for an installed + signed-in framework', () => {
    const s = snap({ claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: true });
    expect(resolveStage(s)).toEqual({ stage: 'handoff', framework: 'claude' });
  });

  it('pre-detection lands on embeddings when the key is missing', () => {
    const s = snap({ claudeInstalled: true, claudeSignedIn: true });
    expect(resolveStage(s)).toEqual({ stage: 'embeddings', framework: 'claude' });
  });

  it('pre-detection prefers claude > codex when both are ready', () => {
    const s = snap({
      claudeInstalled: true,
      claudeSignedIn: true,
      codexInstalled: true,
      codexSignedIn: true,
      embeddingsKeyPresent: true,
    });
    expect(resolveStage(s)).toEqual({ stage: 'handoff', framework: 'claude' });
  });

  it('forcePick overrides the pre-detection auto-skip', () => {
    const s = snap({ claudeInstalled: true, claudeSignedIn: true, embeddingsKeyPresent: true });
    expect(resolveStage(s, { forcePick: true })).toMatchObject({
      stage: 'pick',
      detected: ['claude'],
    });
  });

  it('chosen but not installed → install', () => {
    expect(resolveStage(snap(), { chosen: 'codex' })).toEqual({
      stage: 'install',
      framework: 'codex',
    });
  });

  it('installed but not signed in → login', () => {
    const s = snap({ claudeInstalled: true });
    expect(resolveStage(s, { chosen: 'claude' })).toEqual({
      stage: 'login',
      framework: 'claude',
    });
  });

  it('signed in without embeddings key → embeddings (skippable)', () => {
    const s = snap({ claudeInstalled: true, claudeSignedIn: true });
    expect(resolveStage(s, { chosen: 'claude' })).toEqual({
      stage: 'embeddings',
      framework: 'claude',
    });
  });

  it('embeddingsSkipped short-circuits straight to handoff', () => {
    const s = snap({ claudeInstalled: true, claudeSignedIn: true });
    expect(resolveStage(s, { chosen: 'claude', embeddingsSkipped: true })).toEqual({
      stage: 'handoff',
      framework: 'claude',
    });
  });

  it('embeddings key present → handoff', () => {
    const s = snap({ codexInstalled: true, codexSignedIn: true, embeddingsKeyPresent: true });
    expect(resolveStage(s, { chosen: 'codex' })).toEqual({
      stage: 'handoff',
      framework: 'codex',
    });
  });

  it('resume-for-free: identical snapshot + opts always resolves the same stage', () => {
    const s = snap({ claudeInstalled: true });
    const a = resolveStage(s, { chosen: 'claude' });
    const b = resolveStage(s, { chosen: 'claude' });
    expect(a).toEqual(b);
  });
});
