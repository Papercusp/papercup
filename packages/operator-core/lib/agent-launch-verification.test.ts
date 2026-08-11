/**
 * agent-launch-verification.test.ts — plan
 * agent-launch-verification-and-spawn-env-2026-08-11, P-003 + P-004.
 *
 * P-003 kills the false "Launched": a clean terminal spawn is not proof an agent
 * is running. This is the 4th recurrence of that class (EI-11543, WI-4752,
 * EI-18696184925888288), and the ACCEPTANCE CASE is a real measured session —
 * adv_session 14842, which registered a row, fired its two launch statusline calls
 * at +3.6s/+3.7s, and then did nothing for the hour until the reaper closed it,
 * while the tool had already reported success.
 *
 * The suite is shaped around the finding that made the plan's original design
 * unusable (D-004): a 20s BOOLEAN would be wrong for most HEALTHY launches, since
 * the first real tool call is p50 ~31s / p90 ~417s. So the third state is not
 * hedging — it is the only honest verdict inside a bounded window, and half these
 * cases exist to stop a future edit collapsing it back to a boolean.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-launch-verification.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  FRESH_VERIFY_SILENCE_MS,
  LAUNCH_STATUSLINE_TOOLS,
  classifyAgentLaunchCommand,
  verifyFreshLaunchStarted,
  type FreshLaunchSessionProbe,
} from './agent-launch-core';

const ARGS = { workspaceId: 'ws', launcherOwnerId: 'su-caller', since: 1_000, expected: 1 };
/** No real sleeping: every case here is about the VERDICT, not about waiting. */
const FAST = { pollMs: 1, timeoutMs: 20, sleep: async () => {} };

/** A probe that returns a fixed set of sessions on every poll. */
function fixedProbe(sessions: FreshLaunchSessionProbe[]) {
  return async () => sessions;
}

const session = (over: Partial<FreshLaunchSessionProbe> = {}): FreshLaunchSessionProbe => ({
  advSessionId: 14842,
  ownerId: 'su-launched',
  realCalls: 0,
  msSinceLastSignal: null,
  hasPresence: false,
  ...over,
});

describe('verifyFreshLaunchStarted — the ACCEPTANCE CASE (adv_session 14842)', () => {
  it('returns agentStarted:FALSE for a session that booted, beat twice, then went silent', async () => {
    // 14842's exact shape: a row exists, an owner id exists, only the two
    // statusline calls were ever made (so realCalls === 0), no presence row, and
    // the last signal is long past.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ realCalls: 0, hasPresence: false, msSinceLastSignal: 60_000 })]),
    });

    expect(
      verdict.agentStarted,
      'a session that registered, emitted only the launch statusline calls and then went ' +
        'silent is the "reports Launched, never actually starts" failure — it must be reported ' +
        'as a failure, not as success and not as unverified.',
    ).toBe(false);
    expect(verdict.note).toMatch(/DID NOT START/);
    expect(verdict.note).toContain('14842');
  });

  it('reports FALSE when nothing registered at all', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, { ...FAST, probe: fixedProbe([]) });
    expect(verdict.agentStarted).toBe(false);
    expect(verdict.note).toMatch(/no session registered/);
  });
});

describe('verifyFreshLaunchStarted — must NOT cry wolf on a healthy launch (D-004)', () => {
  it('returns agentStarted:TRUE as soon as a real (non-statusline) call lands', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ realCalls: 5, msSinceLastSignal: 500 })]),
    });
    expect(verdict.agentStarted).toBe(true);
  });

  it('returns TRUE on a live presence row even with no real call yet', async () => {
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ realCalls: 0, hasPresence: true, msSinceLastSignal: 500 })]),
    });
    expect(verdict.agentStarted).toBe(true);
  });

  it('returns NULL (unverified) for a slow starter still signalling — NOT false', async () => {
    // THE CASE THAT KILLED THE ORIGINAL DESIGN. First real tool call is p50 ~31s,
    // so at any bounded timeout the majority of HEALTHY launches look like this.
    // Reporting false here would make the check a false-alarm generator — the same
    // defect it exists to prevent, with the sign flipped.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ realCalls: 0, hasPresence: false, msSinceLastSignal: 800 })]),
    });
    expect(verdict.agentStarted).toBeNull();
    expect(verdict.note).toMatch(/UNVERIFIED/);
    expect(verdict.note, 'an unverified verdict must say the wait is normal, not imply failure').toMatch(
      /NORMAL|not a failure/i,
    );
  });

  it('the silence threshold is what separates the two — either side of it flips the verdict', async () => {
    const stillBeating = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS - 1 })]),
    });
    const goneSilent = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: FRESH_VERIFY_SILENCE_MS + 1 })]),
    });
    expect(stillBeating.agentStarted).toBeNull();
    expect(goneSilent.agentStarted).toBe(false);
  });

  it('a session that never signalled at all is UNVERIFIED, not failed', async () => {
    // msSinceLastSignal === null means we have no observation, which is not the
    // same as an observation of silence. Treating "no data" as "dead" is how a
    // slow-to-report launch gets falsely condemned.
    const verdict = await verifyFreshLaunchStarted(ARGS, {
      ...FAST,
      probe: fixedProbe([session({ msSinceLastSignal: null })]),
    });
    expect(verdict.agentStarted).toBeNull();
  });

  it('does NOT condemn the batch when only SOME members are silent', async () => {
    const verdict = await verifyFreshLaunchStarted(
      { ...ARGS, expected: 2 },
      {
        ...FAST,
        probe: fixedProbe([
          session({ advSessionId: 1, msSinceLastSignal: 60_000 }),
          session({ advSessionId: 2, msSinceLastSignal: 500 }),
        ]),
      },
    );
    expect(verdict.agentStarted).toBeNull();
  });

  it('a probe fault THROWS rather than reading as "nothing registered"', async () => {
    // Returning [] from a broken probe would render a healthy launch as
    // agentStarted:false on the strength of an error in our own instrument.
    await expect(
      verifyFreshLaunchStarted(ARGS, {
        ...FAST,
        probe: async () => {
          throw new Error('pg down');
        },
      }),
    ).rejects.toThrow(/pg down/);
  });
});

describe('LAUNCH_STATUSLINE_TOOLS — the names that are NOT the agent taking a turn', () => {
  it('lists the two statusline calls a DEAD launch also emits', () => {
    // Measured: 14842 (dead) fired exactly these two and nothing else. If a future
    // edit drops one, a dead session's remaining beat counts as "real work" and
    // every dud silently reports as started.
    expect(LAUNCH_STATUSLINE_TOOLS).toContain('activity:report');
    expect(LAUNCH_STATUSLINE_TOOLS).toContain('coord:glance');
  });
});

// ── P-004: the wrong-door guard ─────────────────────────────────────────────
describe('classifyAgentLaunchCommand (P-004)', () => {
  it.each([
    ['psu --no-picker --agent=omp --harness=papercusp', 'fresh'],
    ['psu --agent=claude', 'fresh'],
    ['cd /repo && psu --agent=codex --no-plan', 'fresh'],
    ['psu --resume=abc-123', 'resume'],
    ['psu --fork=abc-123', 'resume'],
  ])('%s ⇒ an agent launch (%s)', (command, mode) => {
    const cls = classifyAgentLaunchCommand(command);
    expect(cls.isAgentLaunch).toBe(true);
    expect(cls.mode).toBe(mode);
  });

  it.each([
    // A guard that over-refuses teaches agents to route around it, which is worse
    // than no guard — so every one of these must keep working.
    ['npm run dev'],
    ['psu --help'],
    ['psu --version'],
    ['psu-sentinel --check'],
    ['echo psuedo'],
    ['./scripts/psustats.sh'],
    ['git log --oneline -5'],
  ])('%s ⇒ NOT an agent launch', (command) => {
    expect(classifyAgentLaunchCommand(command).isAgentLaunch).toBe(false);
  });

  it('tolerates an empty/absent command', () => {
    expect(classifyAgentLaunchCommand('').isAgentLaunch).toBe(false);
  });
});
