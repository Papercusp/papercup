/**
 * session:end — WI-6638. The verb that lets a finished agent session close its own
 * terminal window, instead of idling in an open tab holding a real `claude` process
 * forever (measured: 52 such trees, oldest 14 days, 14.4 GB).
 *
 * The SAFETY property is enforced host-side (`shutdownRefusalReason` in
 * psu-pty-host.mjs, tested in apps/operator/lib/psu-pty-host.test.ts) because only
 * the host can see its own launch env and its own stdin. What is tested here is the
 * caller-facing contract: every host verdict must arrive as a DISTINCT, self-
 * explaining outcome — a refusal is a correct answer about an owner-attended window,
 * and must never be indistinguishable from a transport miss the caller should retry.
 */
import { describe, it, expect } from 'vitest';
import endTool, { shutdownNote } from './end';

it('opts out of the ambient workspace transaction for bounded shutdown', () => {
  // session:end never reads ctx.tx and must remain callable by a privileged
  // session even when every org-app pool slot is held by another call.
  expect((endTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

describe('shutdownNote (WI-6638)', () => {
  const RESULTS = [
    'sent',
    'no-host',
    'no-cap',
    'send-failed',
    'loop-armed',
    'refused-not-agent-launched',
    'refused-human-attended',
    'refused-agent-busy',
  ] as const;

  it('gives every host verdict its own distinct explanation', () => {
    const notes = RESULTS.map((r) => shutdownNote(r));
    expect(new Set(notes).size).toBe(RESULTS.length);
    for (const n of notes) expect(n.length).toBeGreaterThan(20);
  });

  it('tells a REFUSAL apart from a failure in the words themselves', () => {
    // The agent reading this must not "fix" a refusal by retrying: an owner-attended
    // window refusing to close is the system working, not an error.
    for (const r of ['refused-not-agent-launched', 'refused-human-attended'] as const) {
      expect(shutdownNote(r)).toMatch(/REFUSED/);
    }
    // agent-busy is the one refusal that IS retryable — it says so.
    expect(shutdownNote('refused-agent-busy')).toMatch(/retry/i);
    expect(shutdownNote('refused-human-attended')).toMatch(/not an error to retry around/i);
    // loop-armed is the operator-side precondition (the host has no DB to see it):
    // it must name the exact unblocking action, or the agent has no way forward.
    expect(shutdownNote('loop-armed')).toMatch(/REFUSED/);
    expect(shutdownNote('loop-armed')).toMatch(/loop:end/);
  });

  it('does not promise a closed window when nothing was closed', () => {
    expect(shutdownNote('sent')).toMatch(/will close/);
    for (const r of [
      'no-host',
      'no-cap',
      'send-failed',
      'loop-armed',
      'refused-human-attended',
    ] as const) {
      expect(shutdownNote(r)).not.toMatch(/will close/);
    }
  });

  it('falls back to a transport-miss note for an unknown verdict, never to silence', () => {
    const note = shutdownNote('something-new-from-a-future-host');
    expect(note).toMatch(/did not reach the host/);
    // The reassurance that matters when the outcome is unknown: nothing was killed.
    expect(note).toMatch(/nothing was killed/);
  });
});
