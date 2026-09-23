import { describe, expect, it } from 'vitest';
import { classifyAcceptanceGradingSweep } from './acceptance-grading-sweep-state';

// EI-24032136322947460: the grader recruiter's refusal must say whether the
// acceptance-grading-sweep can recover a stalled grading. This is the pure half of
// that read — the DB half is a single indexed row lookup.
describe('classifyAcceptanceGradingSweep', () => {
  it('reports an owner hold as paused, carrying who, why and when', () => {
    const pausedAtMs = Date.parse('2026-09-15T16:04:03.666Z');
    expect(
      classifyAcceptanceGradingSweep({
        active: false,
        pause: {
          reason: "[owner 2026-09-15] owner directed: pause ALL background LLM-spending loops. Re-arm only on the owner's word.",
          pausedBy: 'su-17b535f4',
          pausedAtMs,
        },
      }),
    ).toEqual({
      status: 'paused',
      reason: "[owner 2026-09-15] owner directed: pause ALL background LLM-spending loops. Re-arm only on the owner's word.",
      pausedBy: 'su-17b535f4',
      pausedAt: '2026-09-15T16:04:03.666Z',
      autoResumesAt: null,
    });
  });

  it('carries a finite auto-resume instant when the pause recorded one', () => {
    const state = classifyAcceptanceGradingSweep({
      active: false,
      pause: { reason: 'maintenance', pausedAtMs: 1_000, expiresAtMs: Date.parse('2026-09-23T12:00:00.000Z') },
    });
    expect(state).toMatchObject({ status: 'paused', autoResumesAt: '2026-09-23T12:00:00.000Z' });
  });

  it('distinguishes inactive-with-no-pause-record from a deliberate hold', () => {
    expect(classifyAcceptanceGradingSweep({ active: false, pause: null })).toEqual({ status: 'inactive' });
  });

  it('treats an ACTIVE row as running even if a stale pause record lingers', () => {
    // Recovery exists whenever the sweep fires; a leftover record must not make the
    // refusal claim a pause the sweep is not under.
    expect(classifyAcceptanceGradingSweep({ active: true, pause: { reason: 'old' } })).toEqual({ status: 'running' });
    expect(classifyAcceptanceGradingSweep({ active: null, pause: null })).toEqual({ status: 'running' });
  });

  it('reports a missing row as unknown rather than asserting either state', () => {
    expect(classifyAcceptanceGradingSweep(undefined)).toEqual({ status: 'unknown', detail: 'routine row not found' });
  });
});
