import { describe, expect, it } from 'vitest';
import {
  allowedFrameworks,
  frameworkInstalled,
  frameworkSignedIn,
  resolveStage,
  type OnboardingSnapshot,
} from './stage-resolver';

function snap(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    claudeInstalled: false,
    codexInstalled: false,
    ompInstalled: false,
    meridianInstalled: false,
    claudeSignedIn: false,
    codexSignedIn: false,
    ompSignedIn: false,
    embeddingsKeyPresent: false,
    setupFinished: false,
    ...overrides,
  };
}

describe('allowedFrameworks', () => {
  it('excludes omp-meridian on win32 (D-006: no omp on Windows v1)', () => {
    expect(allowedFrameworks('win32')).toEqual(['claude', 'codex']);
  });
  it('offers all three elsewhere', () => {
    expect(allowedFrameworks('linux')).toEqual(['claude', 'codex', 'omp-meridian']);
    expect(allowedFrameworks('darwin')).toEqual(['claude', 'codex', 'omp-meridian']);
  });
});

describe('frameworkInstalled / frameworkSignedIn', () => {
  it('omp-meridian needs BOTH halves installed', () => {
    expect(frameworkInstalled('omp-meridian', snap({ ompInstalled: true }))).toBe(false);
    expect(frameworkInstalled('omp-meridian', snap({ meridianInstalled: true }))).toBe(false);
    expect(
      frameworkInstalled('omp-meridian', snap({ ompInstalled: true, meridianInstalled: true })),
    ).toBe(true);
  });
  it('maps per-framework sign-in flags', () => {
    expect(frameworkSignedIn('claude', snap({ claudeSignedIn: true }))).toBe(true);
    expect(frameworkSignedIn('codex', snap({ claudeSignedIn: true }))).toBe(false);
    expect(frameworkSignedIn('omp-meridian', snap({ ompSignedIn: true }))).toBe(true);
  });
});

describe('resolveStage', () => {
  it('done when setup already graduated (finished_at set)', () => {
    expect(resolveStage(snap({ setupFinished: true }))).toEqual({ stage: 'done' });
  });

  it('pick when nothing installed and nothing chosen', () => {
    expect(resolveStage(snap())).toEqual({
      stage: 'pick',
      frameworks: ['claude', 'codex', 'omp-meridian'],
      detected: [],
    });
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

  it('omp-meridian with only one half installed → install', () => {
    const s = snap({ ompInstalled: true });
    expect(resolveStage(s, { chosen: 'omp-meridian' })).toEqual({
      stage: 'install',
      framework: 'omp-meridian',
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

  it('a chosen framework the OS does not allow falls back to pick (win32 + omp-meridian)', () => {
    const s = snap({ ompInstalled: true, meridianInstalled: true, ompSignedIn: true });
    expect(resolveStage(s, { chosen: 'omp-meridian', os: 'win32', forcePick: true })).toMatchObject(
      { stage: 'pick', frameworks: ['claude', 'codex'] },
    );
  });

  it('resume-for-free: identical snapshot + opts always resolves the same stage', () => {
    const s = snap({ claudeInstalled: true });
    const a = resolveStage(s, { chosen: 'claude' });
    const b = resolveStage(s, { chosen: 'claude' });
    expect(a).toEqual(b);
  });
});
