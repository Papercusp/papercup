/**
 * machine-authored.test.ts — WI-4537.
 *
 * The classifier decides whether a directed message can PREEMPT an agent's work. Both error
 * directions are asserted, but they are NOT symmetric in cost:
 *   - a false NEGATIVE (a robot line still counted) = one extra number in a health read;
 *   - a false POSITIVE (a real correspondent silenced) = a peer's — or the OWNER'S — question
 *     silently suppressed. That is the direction these tests guard hardest.
 */
import { describe, expect, it } from 'vitest';
import {
  isMachineAuthoredSender,
  isMachineEmitterForStamping,
  MACHINE_EMITTER_STAMP_PATTERN,
  MACHINE_SENDER_PATTERN,
} from './machine-authored';

describe('WI-4537 — isMachineAuthoredSender', () => {
  it('classifies the machine senders that were actually polluting the live counter', () => {
    // Every one of these was observed generating "unanswered directed mail" in production.
    for (const from of [
      'claim-discipline-watch', // 390 unanswered rows — the single biggest source
      'plan-clobber-watch', // 47
      'system:delivery-ladder', // 29 — the sweep that nags you about unread directed mail…
      'system:claim-integrity-monitor', // 10
      'system:improvement-human-digest',
      'system:allhive-broadcast-sweep',
      'system:coord-invariant-monitor',
      'system-watchdog',
      'system-backup-alert',
      'work-items', // the [event] work-item:done:… emitter
      'stale-claim-sweep',
      'hold-open-sweep', // the sweep WI-4531 just added — flagged for free by the pattern
    ]) {
      expect(isMachineAuthoredSender(from), from).toBe(true);
    }
  });

  it('NEVER classifies a real correspondent as a machine (the costly direction)', () => {
    for (const from of [
      'pc-admin-coord-ui', // ⚠ the HUMAN OWNER typing in the admin coord UI — the single most
      // important sender in the system. Suppressing this would hide exactly
      // the message that most deserves to preempt an agent.
      'human',
      'su-00a9161f-6a7d-4caa-abec-4b24bcd94d1f',
      's-1783902599856-f9b49e4c',
      'role-02abebf5-ce9b-4417-9d74-84a9a051d413',
      '57984409-c542-41c3-8149-aeb71c4bf19a',
      'queen',
      'mug',
    ]) {
      expect(isMachineAuthoredSender(from), from).toBe(false);
    }
  });

  it('is not fooled by a machine-ish word merely APPEARING in an agent id', () => {
    // The suffix rule anchors on `-<word>$`; a substring must not trip it, or an agent whose
    // label happens to contain "watch"/"sweep" would be silenced.
    expect(isMachineAuthoredSender('su-watchdog-is-my-hobby')).toBe(false);
    expect(isMachineAuthoredSender('su-sweeper')).toBe(false);
    expect(isMachineAuthoredSender('watchmaker')).toBe(false);
    expect(isMachineAuthoredSender('systemic-agent')).toBe(false); // NOT `system:` / `system-`
  });

  it('handles empty / absent senders without throwing', () => {
    expect(isMachineAuthoredSender('')).toBe(false);
    expect(isMachineAuthoredSender(null)).toBe(false);
    expect(isMachineAuthoredSender(undefined)).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isMachineAuthoredSender('  System:Delivery-Ladder  ')).toBe(true);
  });

  it('does NOT treat the stamp-only emitters as machine-authored (they must stay out of the SQL pattern)', () => {
    // WI-6768. These six are stamped at the sendMessage seam but must NOT widen the
    // shared pattern, because that string is embedded verbatim in four SQL sites and
    // widening it retroactively changes which historical rows count as unanswered.
    for (const s of [
      'git-sync-ref-announce',
      'git-sync-integrator',
      'supervision-reconciler',
      'intent-divergence-detector',
      'green-checkpoint',
      'coord-probe-canary-a',
    ]) {
      expect(isMachineAuthoredSender(s)).toBe(false);
    }
  });

  it('exposes a pattern that is valid in BOTH JS and POSIX ERE (it is embedded verbatim in SQL)', () => {
    // The same string is compiled by JS (sendMessage's write-time stamp) and by Postgres
    // (unanswered-directed's `~` backstop). A construct only one engine understands — a lookahead,
    // a \b, a non-greedy quantifier — would make the two call sites silently disagree.
    expect(() => new RegExp(MACHINE_SENDER_PATTERN)).not.toThrow();
    expect(MACHINE_SENDER_PATTERN).not.toMatch(/\(\?[=!:<]/); // no lookaround / non-capturing groups
    expect(MACHINE_SENDER_PATTERN).not.toMatch(/\\[bBdDwWsS]/); // no JS-only character classes
  });
});
