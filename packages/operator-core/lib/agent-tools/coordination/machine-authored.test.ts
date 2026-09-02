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
  isMachineEscalationEmitter,
  isSystemEmissionUnderAgentIdentity,
  MACHINE_EMITTER_STAMP_PATTERN,
  MACHINE_ESCALATION_EMITTER_PATTERN,
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
      'system:allpot-broadcast-sweep',
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

describe('WI-2140594 — isMachineEscalationEmitter (escalation-only, derived from sender shape)', () => {
  // The six emitters measured OUTSIDE attention/adapters.ts's hand-maintained
  // AUTOMATED_INFRA_EMITTERS set on 2026-09-01 (783-row live backlog). Each was
  // tiered as an owner decision and reaped only by the 7d dead-author sweep.
  it('classifies every emitter that the hand-maintained named set had drifted behind', () => {
    for (const s of [
      'wall-lapse-watchdog',
      'unservable-critical-watchdog',
      'goal-owner-report-watchdog',
      'intent-divergence-detector',
      'goal-liveness-watchdog',
      'embed-latency-watchdog',
    ]) {
      expect(isMachineEscalationEmitter(s), `${s} must be a machine escalation emitter`).toBe(true);
    }
  });

  it('is a SUPERSET of both earlier name-keyed signals (never a replacement)', () => {
    for (const s of [
      'system:delivery-ladder',
      'claim-discipline-watch',
      'git-sync-ref-announce',
      'green-checkpoint',
      'service-health',
    ]) {
      expect(isMachineAuthoredSender(s) || isMachineEmitterForStamping(s), `${s} precondition`).toBe(true);
      expect(isMachineEscalationEmitter(s), `${s} must remain a machine emitter here`).toBe(true);
    }
  });

  it('covers every member of the historical named set, so that set is residue rather than the source of truth', () => {
    for (const s of [
      'green-checkpoint',
      'steering-lease',
      'compaction-watchdog',
      'inference-gateway',
      'scout-outcome-refresh-sweep',
      'rubric-staleness-watchdog',
      'scorecard-emission-pulse',
    ]) {
      expect(isMachineEscalationEmitter(s), `${s} must be covered by the derived shape`).toBe(true);
    }
  });

  it('NEVER matches an agent session, the owner GUI, or a human — the agent-session test wins over any suffix', () => {
    for (const s of [
      'pc-admin-coord-ui',
      'human',
      'su-1a0a0a1a-4c71-4ce5-abcf-58897784edf1',
      's-lease', // an agent-session prefix beats the -lease suffix
      'role-fleet-watchdog', // an AGENT role name ending in -watchdog is still a correspondent
      'cup-alarm',
      '01d3ae25-c833-4270-bd07-132fa669da8a',
      'watchdog', // bare word, no `-` separator
      'gateways', // trailing s — the anchored suffix must not slip
      'my-pulsed', // does not END in -pulse
    ]) {
      expect(isMachineEscalationEmitter(s), `${s} must NOT match`).toBe(false);
    }
  });

  it('handles empty / absent senders without throwing, and is case/whitespace-insensitive', () => {
    expect(isMachineEscalationEmitter('')).toBe(false);
    expect(isMachineEscalationEmitter(null)).toBe(false);
    expect(isMachineEscalationEmitter(undefined)).toBe(false);
    expect(isMachineEscalationEmitter('  Wall-Lapse-Watchdog  ')).toBe(true);
  });

  it('exposes a pattern valid in BOTH JS and POSIX ERE, like its siblings', () => {
    expect(() => new RegExp(MACHINE_ESCALATION_EMITTER_PATTERN)).not.toThrow();
    expect(MACHINE_ESCALATION_EMITTER_PATTERN).not.toMatch(/\\[dswDSW]|\(\?/);
  });
});

describe('WI-6768 — isMachineEmitterForStamping (the THIRD, stamp-only signal)', () => {
  /**
   * The emitters below are not hypothetical: they are the measured residue after
   * P-033 (d)'s original two-signal stamp went live. Over the following 36h, 845 of
   * 2,013 coord messages (42%) still carried no `expects`, and these accounted for
   * 820 of them (97%). Each is asserted by NAME so the guard is anchored to the real
   * population rather than to a pattern that merely looks plausible.
   */
  const MEASURED_RESIDUE = [
    'git-sync-ref-announce',
    'git-sync-integrator',
    'coord-probe-canary-a',
    'supervision-reconciler',
    'intent-divergence-detector',
    'green-checkpoint',
    'release-deploy:4153546:abbd4c65-5dbb-4f40-b183-cf730b5e9c91',
    // EI-19315474516256070, measured the same way over the 24h AFTER the WI-6768 stamp
    // went live: the stamp was working perfectly on the senders it matched
    // (git-sync-ref-announce 41/41, git-sync-integrator 21/21 of post-deploy messages
    // carrying fieldProvenance.expects='system-emitter-derived'), and these were the
    // residue matching NEITHER pattern — service-health alone sent 40 messages of which
    // 38 still carried no `expects`.
    'service-health',
    'hive-owner-key-health',
  ];

  it('stamps every emitter in the measured residue', () => {
    for (const s of MEASURED_RESIDUE) {
      expect(isMachineEmitterForStamping(s), `${s} should be stamped`).toBe(true);
    }
  });

  it('is NON-VACUOUS — it adds senders the original two signals genuinely missed', () => {
    // Without this the suite would still pass if the new pattern matched nothing and
    // every hit came from the pre-existing isMachineAuthoredSender leg.
    const added = MEASURED_RESIDUE.filter((s) => !isMachineAuthoredSender(s));
    expect(added.length).toBeGreaterThanOrEqual(6);
  });

  it('still stamps everything the original signal stamped (superset, never a replacement)', () => {
    for (const s of ['system:delivery-ladder', 'system-watchdog', 'claim-discipline-watch', 'work-items']) {
      expect(isMachineAuthoredSender(s)).toBe(true);
      expect(isMachineEmitterForStamping(s)).toBe(true);
    }
  });

  it('NEVER stamps a human or agent correspondent — the direction that costs most', () => {
    for (const s of [
      'pc-admin-coord-ui', // the owner typing in the admin UI
      'human',
      'su-1a0a0a1a-4c71-4ce5-abcf-58897784edf1',
      'announcer', // no leading `-`, must not match `-announce$`
      'my-detective', // `-detective`, not `-detector`
      'integration', // not `-integrator`
      'green-checkpoints', // trailing s — the anchored prefix must not slip
      'health', // bare word, no leading `-` — must not match `-health$`
      'healthy', // does not END in `health`
      'telehealth', // ends in `health` but has no `-` separator
    ]) {
      expect(isMachineEmitterForStamping(s), `${s} must NOT be stamped`).toBe(false);
    }
  });

  it('handles empty / absent senders without throwing', () => {
    expect(isMachineEmitterForStamping('')).toBe(false);
    expect(isMachineEmitterForStamping(null)).toBe(false);
    expect(isMachineEmitterForStamping(undefined)).toBe(false);
  });

  it('is case- and whitespace-insensitive, like the pattern it supplements', () => {
    expect(isMachineEmitterForStamping('  Git-Sync-Ref-Announce  ')).toBe(true);
  });

  describe('isSystemEmissionUnderAgentIdentity (D-095) — system code under a BORROWED agent id', () => {
    it('stamps an agent-session sender that carries NO expects', () => {
      // The measured population: 36 messages in 36h that no name-based pattern
      // can reach, because `from` IS a real agent. coord:send requires
      // `expects`, so its absence is positive evidence code sent this.
      for (const s of [
        'su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d', // fleet-scope admission block
        's-1a0a0a1a-4c71-4ce5-abcf-58897784edf1',
        'cup-7f3a2b10',
        'role-integrator-3',
        '3f2a9c11-4c71-4ce5-abcf-58897784edf1', // bare uuid
      ]) {
        expect(isSystemEmissionUnderAgentIdentity(s, false), `${s} must be stamped`).toBe(true);
      }
    });

    it('NEVER stamps when expects is present — that is a real coord:send', () => {
      // The same senders, one field different. This is the whole discriminator:
      // an agent that used the tool is untouchable here.
      for (const s of ['su-de6e9643-2fa0-4a4f-86f3-2f9e9c7f2e0d', 'cup-7f3a2b10']) {
        expect(isSystemEmissionUnderAgentIdentity(s, true), `${s} used the tool`).toBe(false);
      }
    });

    it('NEVER stamps a human or the owner GUI, even with no expects', () => {
      // The false positive that would matter most, and the reason this is
      // restricted to system-minted identities rather than "anything lacking
      // expects": silently suppressing the owner's own question is precisely
      // what this module's header exists to prevent. `inbox-reply` (the owner's
      // GUI reply) is doubly safe — it passes extra.expects explicitly — but it
      // must not depend on that alone.
      for (const s of ['pc-admin-coord-ui', 'human', 'operator', 'avi']) {
        expect(isSystemEmissionUnderAgentIdentity(s, false), `${s} must NOT be stamped`).toBe(
          false,
        );
      }
    });

    it('handles empty / absent senders without throwing', () => {
      expect(isSystemEmissionUnderAgentIdentity('', false)).toBe(false);
      expect(isSystemEmissionUnderAgentIdentity(null, false)).toBe(false);
      expect(isSystemEmissionUnderAgentIdentity(undefined, false)).toBe(false);
    });
  });

  it('stays OUT of the SQL pattern — the two must never be merged', () => {
    // MACHINE_SENDER_PATTERN is embedded verbatim in four SQL sites; widening it would
    // retroactively change which historical rows count as unanswered. This asserts the
    // separation the fix depends on.
    expect(MACHINE_SENDER_PATTERN).not.toContain('announce');
    expect(MACHINE_SENDER_PATTERN).not.toContain('integrator');
    expect(MACHINE_EMITTER_STAMP_PATTERN).not.toEqual(MACHINE_SENDER_PATTERN);
    expect(() => new RegExp(MACHINE_EMITTER_STAMP_PATTERN)).not.toThrow();
  });
});
