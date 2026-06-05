import { describe, test, expect } from 'vitest';
import { parseDecision } from '@papercusp/orchestrator';
import { classifyDecision } from './orchestrator-decide';

const DEFAULT = 'F-DEFAULT';

describe('classifyDecision — terminal verbs', () => {
  test('null (unparseable) → terminal idle (stop cleanly, dispatcher rescans)', () => {
    expect(classifyDecision(null, DEFAULT)).toEqual({ kind: 'terminal', outcome: 'idle' });
  });

  test('DONE → terminal done (triggers finalization)', () => {
    expect(classifyDecision(parseDecision('DONE'), DEFAULT)).toEqual({
      kind: 'terminal',
      outcome: 'done',
    });
  });

  test('ESCALATE <reason> → terminal escalate carrying the reason', () => {
    expect(classifyDecision(parseDecision('ESCALATE stuck-after-3-attempts'), DEFAULT)).toEqual({
      kind: 'terminal',
      outcome: 'escalate',
      reason: 'stuck-after-3-attempts',
    });
  });

  test('ESCALATE with no arg → terminal escalate, empty reason', () => {
    expect(classifyDecision(parseDecision('ESCALATE'), DEFAULT)).toEqual({
      kind: 'terminal',
      outcome: 'escalate',
      reason: '',
    });
  });

  test('IDLE → terminal idle', () => {
    expect(classifyDecision(parseDecision('IDLE'), DEFAULT)).toEqual({
      kind: 'terminal',
      outcome: 'idle',
    });
  });

  test('CHECKPOINT (deprecated) → terminal escalate (legacy treats it as ESCALATE)', () => {
    const a = classifyDecision(parseDecision('CHECKPOINT'), DEFAULT);
    expect(a.kind).toBe('terminal');
    expect((a as { outcome: string }).outcome).toBe('escalate');
  });
});

describe('classifyDecision — per-feature lifecycle dispatch', () => {
  test('NEXT_WORKER F-1 → dispatch worker on F-1 with FEATURE_ID extra', () => {
    expect(classifyDecision(parseDecision('NEXT_WORKER F-1'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'worker',
      feature: 'F-1',
      extras: ['FEATURE_ID=F-1'],
    });
  });

  test('NEXT_WORKER with no arg → dispatch worker on the default feature', () => {
    expect(classifyDecision(parseDecision('NEXT_WORKER'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'worker',
      feature: DEFAULT,
      extras: [`FEATURE_ID=${DEFAULT}`],
    });
  });

  test('NEXT_VALIDATOR → dispatch validator with FEATURE_ID', () => {
    expect(classifyDecision(parseDecision('NEXT_VALIDATOR F-1'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'validator',
      feature: 'F-1',
      extras: ['FEATURE_ID=F-1'],
    });
  });

  test('NEXT_ARCHITECT → dispatch architect with FEATURE_ID', () => {
    expect(classifyDecision(parseDecision('NEXT_ARCHITECT F-1 big-and-ambiguous'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'architect',
      feature: 'F-1',
      extras: ['FEATURE_ID=F-1'],
    });
  });

  // P-013/P-014 — opt-in quality gates (recognized + classified; dormant until a
  // harness's director opts in to emitting them).
  test('NEXT_CROSSCHECK → dispatch crosscheck with FEATURE_ID', () => {
    expect(classifyDecision(parseDecision('NEXT_CROSSCHECK F-1'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'crosscheck',
      feature: 'F-1',
      extras: ['FEATURE_ID=F-1'],
    });
  });

  test('NEXT_UI_QA → dispatch ui-qa with FEATURE_ID', () => {
    expect(classifyDecision(parseDecision('NEXT_UI_QA F-1'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'ui-qa',
      feature: 'F-1',
      extras: ['FEATURE_ID=F-1'],
    });
  });

  test('NEXT_SCOPER → dispatch scoper with FEATURE_ID', () => {
    expect(classifyDecision(parseDecision('NEXT_SCOPER F-1'), DEFAULT)).toMatchObject({
      kind: 'dispatch',
      role: 'scoper',
      extras: ['FEATURE_ID=F-1'],
    });
  });
});

describe('classifyDecision — quality verbs (exact role names + extras)', () => {
  test('NEXT_TESTER VAL-7 → dispatch tester with VAL_ID extra', () => {
    expect(classifyDecision(parseDecision('NEXT_TESTER VAL-7'), DEFAULT)).toEqual({
      kind: 'dispatch',
      role: 'tester',
      feature: 'VAL-7',
      extras: ['VAL_ID=VAL-7'],
    });
  });

  test('NEXT_TESTER with no arg → tester with empty VAL_ID (matches legacy)', () => {
    expect(classifyDecision(parseDecision('NEXT_TESTER'), DEFAULT)).toMatchObject({
      kind: 'dispatch',
      role: 'tester',
      extras: ['VAL_ID='],
    });
  });

  test('NEXT_SECURITY → dispatch security-reviewer (NOT "security")', () => {
    expect(classifyDecision(parseDecision('NEXT_SECURITY'), DEFAULT)).toMatchObject({
      kind: 'dispatch',
      role: 'security-reviewer',
    });
  });

  test('GENERATE_TESTS → dispatch test-writer', () => {
    expect(classifyDecision(parseDecision('GENERATE_TESTS'), DEFAULT)).toMatchObject({
      kind: 'dispatch',
      role: 'test-writer',
    });
  });

  test('NEXT_MONITOR → dispatch monitor', () => {
    expect(classifyDecision(parseDecision('NEXT_MONITOR'), DEFAULT)).toMatchObject({
      kind: 'dispatch',
      role: 'monitor',
    });
  });
});

describe('classifyDecision — benign global verbs stop the per-feature pipeline cleanly', () => {
  test.each(['CONVERTED', 'FEATURE_FREEZE', 'READY_FOR_PROD', 'RUN_TESTS'])(
    '%s → terminal idle (global/phase concern, not this pipeline)',
    (verb) => {
      expect(classifyDecision(parseDecision(verb), DEFAULT)).toEqual({
        kind: 'terminal',
        outcome: 'idle',
      });
    },
  );
});

describe('classifyDecision — global-only verbs are explicitly unsupported (warn + stop)', () => {
  test('NEXT_HARNESS → unsupported', () => {
    expect(classifyDecision(parseDecision('NEXT_HARNESS other-slug'), DEFAULT)).toMatchObject({
      kind: 'unsupported',
    });
  });

  test('NEXT_WORKER_CEO_MODE → unsupported', () => {
    expect(classifyDecision(parseDecision('NEXT_WORKER_CEO_MODE F-1'), DEFAULT)).toMatchObject({
      kind: 'unsupported',
    });
  });

  test('parallel NEXT_WORKER F-1 N=3 → unsupported (lanes are the global orchestrator’s job)', () => {
    expect(classifyDecision(parseDecision('NEXT_WORKER F-1 N=3'), DEFAULT)).toMatchObject({
      kind: 'unsupported',
    });
  });
});
