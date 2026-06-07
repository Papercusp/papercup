import { describe, expect, it } from 'vitest';
import {
  SHARE_WIZARD_FIRST_STEP,
  SHARE_WIZARD_LAST_STEP,
  SHARE_WIZARD_STEPS,
  SHARE_WIZARD_STEP_COUNT,
  SHARE_WIZARD_STEP_INDEX,
  emptyShareWizardState,
  getStepPosition,
  getStepProgressPercent,
  isStateCompleteForFinalize,
  nextStep,
  previousStep,
  shouldOfferPrivateShare,
  flipToPrivateShare,
  type ShareWizardState,
} from './share-wizard-step-types';

const VALID_TOPIC = '0'.repeat(64);

describe('constants', () => {
  it('SHARE_WIZARD_STEPS has 9 entries per v5 §5', () => {
    expect(SHARE_WIZARD_STEPS.length).toBe(9);
    expect(SHARE_WIZARD_STEP_COUNT).toBe(9);
  });

  it('SHARE_WIZARD_FIRST_STEP is confirm-remote', () => {
    expect(SHARE_WIZARD_FIRST_STEP).toBe('confirm-remote');
  });

  it('SHARE_WIZARD_LAST_STEP is write-shared-json', () => {
    expect(SHARE_WIZARD_LAST_STEP).toBe('write-shared-json');
  });

  it('SHARE_WIZARD_STEP_INDEX is 1-9 contiguously', () => {
    const positions = SHARE_WIZARD_STEPS.map((s) => SHARE_WIZARD_STEP_INDEX[s]);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('nextStep — happy path forward', () => {
  it('confirm-remote → lookup-binding when remote present', () => {
    expect(nextStep('confirm-remote', { github_remote: 'git@x' })).toEqual({
      kind: 'next',
      step: 'lookup-binding',
    });
  });

  it('lookup-binding → create-binding when no existing binding', () => {
    expect(
      nextStep('lookup-binding', {
        github_remote: 'git@x',
        github_repository_id: 1,
        existing_binding_found: false,
      }),
    ).toEqual({ kind: 'next', step: 'create-binding' });
  });

  it('create-binding → generate-topic', () => {
    expect(nextStep('create-binding', {})).toEqual({ kind: 'next', step: 'generate-topic' });
  });

  it('generate-topic → choose-discord when topic set', () => {
    expect(nextStep('generate-topic', { topic: VALID_TOPIC })).toEqual({
      kind: 'next',
      step: 'choose-discord',
    });
  });

  it('choose-discord → choose-privacy (optional step, always advances)', () => {
    expect(nextStep('choose-discord', {})).toEqual({
      kind: 'next',
      step: 'choose-privacy',
    });
    expect(nextStep('choose-discord', { discord_channel: '#x' })).toEqual({
      kind: 'next',
      step: 'choose-privacy',
    });
  });

  it('choose-privacy → privacy-confirm when privacy chosen', () => {
    expect(nextStep('choose-privacy', { privacy: 'shared-private' })).toEqual({
      kind: 'next',
      step: 'privacy-confirm',
    });
  });

  it('privacy-confirm → backfill when confirmed', () => {
    expect(
      nextStep('privacy-confirm', { privacy: 'shared-private', privacy_confirmed: true }),
    ).toEqual({ kind: 'next', step: 'backfill' });
  });

  it('backfill → write-shared-json when complete', () => {
    expect(nextStep('backfill', { backfill_completed_ts: 1 })).toEqual({
      kind: 'next',
      step: 'write-shared-json',
    });
  });

  it('write-shared-json → complete', () => {
    expect(nextStep('write-shared-json', {})).toEqual({ kind: 'complete' });
  });
});

describe('private-repo × shared-public gate (early detection, not at finalize)', () => {
  it('blocks shared-public on a PRIVATE repo at the privacy step', () => {
    expect(nextStep('choose-privacy', { privacy: 'shared-public', repo_private: true })).toEqual({
      kind: 'block',
      reason: 'shared_public_requires_public_repo',
    });
  });
  it('allows shared-private on a private repo', () => {
    expect(nextStep('choose-privacy', { privacy: 'shared-private', repo_private: true })).toEqual({
      kind: 'next',
      step: 'privacy-confirm',
    });
  });
  it('allows shared-public on a PUBLIC repo', () => {
    expect(nextStep('choose-privacy', { privacy: 'shared-public', repo_private: false })).toEqual({
      kind: 'next',
      step: 'privacy-confirm',
    });
  });
  it('allows shared-public when visibility is unknown (undefined) — backend still guards', () => {
    expect(nextStep('choose-privacy', { privacy: 'shared-public' })).toEqual({
      kind: 'next',
      step: 'privacy-confirm',
    });
  });
  it('isStateCompleteForFinalize is false for shared-public on a private repo', () => {
    const base = {
      github_remote: 'g',
      github_repository_id: 1,
      topic: 't',
      privacy_confirmed: true,
      backfill_completed_ts: 1,
    };
    expect(isStateCompleteForFinalize({ ...base, privacy: 'shared-public', repo_private: true })).toBe(false);
    expect(isStateCompleteForFinalize({ ...base, privacy: 'shared-public', repo_private: false })).toBe(true);
    expect(isStateCompleteForFinalize({ ...base, privacy: 'shared-private', repo_private: true })).toBe(true);
  });
});

describe('nextStep — blocks', () => {
  it('blocks confirm-remote when no remote', () => {
    expect(nextStep('confirm-remote', {})).toEqual({
      kind: 'block',
      reason: 'no_github_remote',
    });
  });

  it('blocks lookup-binding when lookup pending', () => {
    expect(nextStep('lookup-binding', {})).toEqual({
      kind: 'block',
      reason: 'binding_lookup_pending',
    });
  });

  it('blocks lookup-binding on a non-positive repo id (0/negative — swarm keys on it)', () => {
    expect(nextStep('lookup-binding', { github_repository_id: 0 })).toEqual({
      kind: 'block',
      reason: 'binding_lookup_pending',
    });
    expect(nextStep('lookup-binding', { github_repository_id: -7 })).toEqual({
      kind: 'block',
      reason: 'binding_lookup_pending',
    });
  });

  it('blocks lookup-binding on a non-integer repo id (NaN / fractional)', () => {
    expect(nextStep('lookup-binding', { github_repository_id: Number.NaN })).toEqual({
      kind: 'block',
      reason: 'binding_lookup_pending',
    });
    expect(nextStep('lookup-binding', { github_repository_id: 1.5 })).toEqual({
      kind: 'block',
      reason: 'binding_lookup_pending',
    });
  });

  it('blocks lookup-binding with binding_exists_should_join when binding found (P-029b)', () => {
    expect(
      nextStep('lookup-binding', {
        github_repository_id: 1,
        existing_binding_found: true,
      }),
    ).toEqual({ kind: 'block', reason: 'binding_exists_should_join' });
  });

  it('blocks generate-topic when topic not set', () => {
    expect(nextStep('generate-topic', {})).toEqual({
      kind: 'block',
      reason: 'topic_not_generated',
    });
  });

  it('blocks choose-privacy when privacy not chosen', () => {
    expect(nextStep('choose-privacy', {})).toEqual({
      kind: 'block',
      reason: 'privacy_not_chosen',
    });
  });

  it('blocks privacy-confirm when not confirmed', () => {
    expect(nextStep('privacy-confirm', { privacy: 'shared-private' })).toEqual({
      kind: 'block',
      reason: 'privacy_not_confirmed',
    });
  });

  it('blocks backfill when backfill_completed_ts not set', () => {
    expect(nextStep('backfill', {})).toEqual({
      kind: 'block',
      reason: 'backfill_not_completed',
    });
  });
});

describe('previousStep', () => {
  it('walks backward through steps', () => {
    expect(previousStep('write-shared-json')).toBe('backfill');
    expect(previousStep('backfill')).toBe('privacy-confirm');
    expect(previousStep('privacy-confirm')).toBe('choose-privacy');
    expect(previousStep('choose-privacy')).toBe('choose-discord');
    expect(previousStep('choose-discord')).toBe('generate-topic');
    expect(previousStep('generate-topic')).toBe('create-binding');
    expect(previousStep('create-binding')).toBe('lookup-binding');
    expect(previousStep('lookup-binding')).toBe('confirm-remote');
  });

  it('returns null on step 1', () => {
    expect(previousStep('confirm-remote')).toBeNull();
  });
});

describe('isStateCompleteForFinalize', () => {
  function completeState(): ShareWizardState {
    return {
      github_remote: 'git@x',
      github_repository_id: 1,
      topic: VALID_TOPIC,
      privacy: 'shared-private',
      privacy_confirmed: true,
      backfill_completed_ts: 1716_000_000_000,
    };
  }

  it('true when all required fields set', () => {
    expect(isStateCompleteForFinalize(completeState())).toBe(true);
  });

  it('false when any required field missing', () => {
    expect(isStateCompleteForFinalize({ ...completeState(), github_remote: undefined })).toBe(false);
    expect(isStateCompleteForFinalize({ ...completeState(), topic: undefined })).toBe(false);
    expect(isStateCompleteForFinalize({ ...completeState(), privacy: undefined })).toBe(false);
    expect(isStateCompleteForFinalize({ ...completeState(), privacy_confirmed: false })).toBe(false);
    expect(isStateCompleteForFinalize({ ...completeState(), backfill_completed_ts: undefined })).toBe(false);
  });

  it('false on empty state', () => {
    expect(isStateCompleteForFinalize({})).toBe(false);
  });

  it('false on invalid privacy', () => {
    expect(
      isStateCompleteForFinalize({
        ...completeState(),
        privacy: 'public' as never,
      }),
    ).toBe(false);
  });
});

describe('emptyShareWizardState', () => {
  it('returns an empty object', () => {
    expect(emptyShareWizardState()).toEqual({});
  });
});

describe('getStepPosition / getStepProgressPercent', () => {
  it('step 1 → position 1, 11% progress', () => {
    expect(getStepPosition('confirm-remote')).toEqual({ current: 1, total: 9 });
    expect(getStepProgressPercent('confirm-remote')).toBe(11);
  });

  it('step 9 → position 9, 100% progress', () => {
    expect(getStepPosition('write-shared-json')).toEqual({ current: 9, total: 9 });
    expect(getStepProgressPercent('write-shared-json')).toBe(100);
  });

  it('step 5 → ~56% progress', () => {
    expect(getStepProgressPercent('choose-discord')).toBe(56);
  });
});

describe('shouldOfferPrivateShare — step-2 private-repo offer', () => {
  it('true when the resolved repo is private', () => {
    expect(shouldOfferPrivateShare({ repo_private: true })).toBe(true);
  });

  it('false when the repo is public', () => {
    expect(shouldOfferPrivateShare({ repo_private: false })).toBe(false);
  });

  it('false when visibility is unknown (do not gate on undefined)', () => {
    expect(shouldOfferPrivateShare({})).toBe(false);
  });
});

describe('flipToPrivateShare — the "Share as a private harness" action', () => {
  it('pre-selects shared-private so the rest of the flow is the private workflow', () => {
    const flipped = flipToPrivateShare({ github_repository_id: 1, repo_private: true });
    expect(flipped.privacy).toBe('shared-private');
  });

  it('preserves all other accumulated state (pure, non-mutating)', () => {
    const before: ShareWizardState = {
      github_remote: 'https://github.com/o/r.git',
      github_repository_id: 42,
      repo_private: true,
      topic: VALID_TOPIC,
    };
    const after = flipToPrivateShare(before);
    expect(after).toEqual({ ...before, privacy: 'shared-private' });
    expect(before.privacy).toBeUndefined(); // original untouched
  });

  it('the flipped state then passes the choose-privacy gate (no shared-public block)', () => {
    const flipped = flipToPrivateShare({ repo_private: true });
    expect(nextStep('choose-privacy', flipped)).toEqual({
      kind: 'next',
      step: 'privacy-confirm',
    });
  });
});
