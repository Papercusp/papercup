/**
 * @vitest-environment jsdom
 *
 * AgentDossier (P-007) — the right-pane agent detail. Verifies it renders the
 * Tier-1/2 facts from the passed RosterEntry immediately, lazy-fetches the
 * Tier-3 dossier from agentDetail.byOwner, cross-marks files with the agent's
 * lock state, and renders the coord trail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent, within } from '@testing-library/react';
import AgentDossier, { type AgentDetail } from '../AgentDossier';
import type { RosterEntry } from '../SessionsRosterView';

const syncState = vi.hoisted(() => ({
  detail: null as AgentDetail | null,
  calls: [] as Array<{ queryName: string; args?: unknown }>,
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: unknown; enabled?: boolean }) => {
    syncState.calls.push(opts);
    return {
      data: opts.enabled === false || !syncState.detail ? null : [syncState.detail],
      loading: false,
      error: null,
      fetching: false,
      invalidate: vi.fn(),
    };
  },
}));

// Rail R1 P-008: the section drill-ins are nuqs-backed, so the suite needs a
// nuqs stub. Backing it with a REAL useState (rather than a frozen null) is the
// point — a stub that cannot change state would let every "expands to reveal the
// rest" assertion below pass against a component whose toggle does nothing.
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    parseAsString: null,
    useQueryState: (_key: string) => React.useState<string | null>(null),
  };
});

/** Click a capped section's drill-in. Returns false when the section has no
 *  drill-in, so a test can assert that a short section stays uncapped. */
function expandSection(container: HTMLElement, sectionId: string): boolean {
  const btn = container.querySelector<HTMLButtonElement>(`#${sectionId} .pc-dossier__drillin`);
  if (!btn) return false;
  fireEvent.click(btn);
  return true;
}

function entry(over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    ownerId: 'su-1',
    label: 'worker-188',
    source: 'claude',
    intent: 'refactoring attempt-claim split',
    currentFiles: ['apps/operator/lib/orchestrator/attempt-claim.ts', 'b.ts'],
    host: 'avi-dev',
    pid: 33417,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    liveness: 'live',
    stale: false,
    workspaceId: 'ws1',
    userId: null,
    revoked: false,
    pidAlive: null,
    hasLaunchRecord: true,
    advSessionId: 1,
    currentPlanSlug: 'dbos-retire',
    role: 'worker',
    feature: 'F-012',
    agent: 'claude',
    mode: 'console',
    windowId: 'w-1',
    ompThreadId: null,
    sessionId: null,
    nativeSession: null,
    cwd: '/repo',
    launchStartedAt: null,
    ...over,
  };
}

const DETAIL: AgentDetail = {
  ownerId: 'su-1',
  locks: {
    held: [
      {
        path: 'apps/operator/lib/orchestrator/attempt-claim.ts',
        intent: 'editing attempt-claim',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 19 * 60_000).toISOString(),
      },
    ],
    waiting: [],
    error: null,
  },
  coord: {
    lastMessage: {
      msgId: 'm-1',
      from: 'su-1',
      to: ['su-2'],
      kind: 'message',
      summary: 'pushed the fix',
      ts: new Date().toISOString(),
      direction: 'outbound',
    },
    unreadCount: 2,
    // `unread` is a REQUIRED field on the coord detail (use-agent-detail.ts) — the list the
    // "N unread" badge counts, added so the badge cannot name a number the section fails to
    // show. This fixture predates it, and an absent array crashed the render on
    // `coord.unread.length`. Kept at LENGTH 2 to match unreadCount above: the component's
    // stated invariant is that the count and the list come from the same array, so a fixture
    // where they disagree would quietly stop testing that.
    unread: [
      {
        msgId: 'u-1',
        from: 'su-2',
        to: ['su-1'],
        kind: 'message',
        summary: 'can you take WI-1',
        ts: new Date().toISOString(),
        direction: 'inbound' as const,
      },
      {
        msgId: 'u-2',
        from: 'su-3',
        to: ['su-1'],
        kind: 'message',
        summary: 'gate is red',
        ts: new Date().toISOString(),
        direction: 'inbound' as const,
      },
    ],
    openHandoffs: [
      {
        msgId: 'h-1',
        from: 'su-1',
        to: ['codex'],
        summary: 'over to codex',
        ts: new Date().toISOString(),
        planSlug: 'dbos-retire',
        nextAction: null,
        direction: 'outbound',
        accepted: false,
      },
    ],
    openEscalations: [],
    error: null,
  },
  nativeSession: null,
  codex: null,
  signals: {
    loop: { active: true, intervalSec: 60, nextFireAt: new Date(Date.now() + 5 * 60_000).toISOString(), parked: true, stalled: false },
    currentClaim: { id: 'WI-9001', title: 'Fix the thing', harness: 'papercusp' },
    contextTokens: 40_000,
    compactionLimit: 200_000,
    lastCheckpoint: { text: 'did the thing, left the other thing', updatedAtMs: Date.now() - 2 * 86_400_000 },
    unansweredDirectedCount: 2,
    lastToolCallAt: new Date(Date.now() - 30_000).toISOString(),
    unavailableSignals: [],
  },
};

describe('AgentDossier', () => {
  beforeEach(() => {
    syncState.detail = DETAIL;
    syncState.calls = [];
  });
  afterEach(() => {
    cleanup();
  });

  it('renders Tier-1/2 facts from the entry immediately', () => {
    const { getByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(getByText('worker-188')).toBeTruthy();
    expect(getByText('worker')).toBeTruthy();
    expect(getByText('F-012')).toBeTruthy();
    expect(getByText('refactoring attempt-claim split')).toBeTruthy();
    // Rail R1 P-008: host and pid share one Reference row now — the deck's
    // preview is plan / started / host · pid, and these two are among the three
    // rows that survive the cap without a drill-in.
    expect(getByText('avi-dev · 33417')).toBeTruthy(); // host · pid meta
    expect(getByText('dbos-retire')).toBeTruthy(); // plan meta
  });

  it('loads the dossier keyed by owner id', async () => {
    render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    await waitFor(() =>
      expect(syncState.calls.some((c) => c.queryName === 'agentDetail.byOwner')).toBe(true),
    );
    expect(syncState.calls.find((c) => c.queryName === 'agentDetail.byOwner')?.args).toEqual({ ownerId: 'su-1' });
  });

  it('renders Tier-3 locks + coord after the fetch resolves', async () => {
    const { findByText, getByText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
    );
    expect(await findByText('19m left')).toBeTruthy(); // held-lock expiry countdown
    expect(getByText('pushed the fix')).toBeTruthy(); // coord last message
    expect(getByText('2 unread')).toBeTruthy(); // unread badge
    expect(getByText('over to codex')).toBeTruthy(); // open handoff
  });

  it('renders a backend-neutral Claude native session handle from the roster entry', () => {
    const { getByText } = render(
      <AgentDossier
        ownerId="su-1"
        entry={entry({
          sessionId: 'claude-uuid-1',
          nativeSession: {
            backend: 'claude',
            source: 'spawned_agents',
            ownerId: 'su-1',
            sessionId: 'claude-uuid-1',
            configDir: '/home/user/.papercusp/session-claude/su-1',
            exactResumeSupported: true,
            missingReason: null,
          },
        })}
        onClose={() => {}}
      />,
    );
    expect(getByText('Native Session')).toBeTruthy();
    // EI-308: the resume command must set CLAUDE_CONFIG_DIR — a bare
    // `claude --resume <id>` looks in the default config dir and finds
    // nothing, which is exactly the "copy-pasted command fails" trap this
    // ticket exists to close.
    expect(
      getByText("CLAUDE_CONFIG_DIR='/home/user/.papercusp/session-claude/su-1' claude --resume claude-uuid-1"),
    ).toBeTruthy();
    expect(getByText('spawned_agents')).toBeTruthy();
    expect(getByText('supported')).toBeTruthy();
  });

  it('EI-308: falls back to a bare claude --resume command when configDir is unknown', () => {
    const { getByText } = render(
      <AgentDossier
        ownerId="su-1"
        entry={entry({
          sessionId: 'claude-uuid-2',
          nativeSession: {
            backend: 'claude',
            source: 'spawned_agents',
            ownerId: 'su-1',
            sessionId: 'claude-uuid-2',
            configDir: null,
            exactResumeSupported: true,
            missingReason: null,
          },
        })}
        onClose={() => {}}
      />,
    );
    expect(getByText('claude --resume claude-uuid-2')).toBeTruthy();
  });

  it('WI-5226: hides the resume command (never just the badge) when exactResumeSupported is false', () => {
    const { getByText, queryByText } = render(
      <AgentDossier
        ownerId="su-1"
        entry={entry({
          sessionId: 'claude-uuid-3',
          nativeSession: {
            backend: 'claude',
            source: 'spawned_agents',
            ownerId: 'su-1',
            sessionId: 'claude-uuid-3',
            configDir: '/home/user/.papercusp/session-claude/su-1',
            exactResumeSupported: false,
            missingReason: 'session transcript was cleaned up and could not be restored (not_archived)',
          },
        })}
        onClose={() => {}}
      />,
    );
    // the header note explains why...
    expect(getByText(/session transcript was cleaned up/)).toBeTruthy();
    expect(getByText('not ready')).toBeTruthy();
    // ...but the command itself — which would ENOENT — is never offered to copy.
    expect(queryByText(/claude --resume claude-uuid-3/)).toBeNull();
  });

  it('prefers the lazy detail native session when it has a Codex rollout id', async () => {
    syncState.detail = {
      ...DETAIL,
      nativeSession: {
        backend: 'codex',
        source: 'adv_sessions',
        ownerId: 'su-codex',
        codexHome: '/home/user/.papercusp/su-codex-homes/session-77',
        rolloutId: '019eeb2b-0742-72a0-85a4-5dc505cfe62d',
        exactResumeSupported: true,
        missingReason: null,
      },
    } satisfies AgentDetail;
    const { findByText, getByText, container } = render(
      <AgentDossier
        ownerId="su-codex"
        entry={entry({
          ownerId: 'su-codex',
          agent: 'codex',
          source: 'codex',
          nativeSession: {
            backend: 'codex',
            source: 'adv_sessions',
            ownerId: 'su-codex',
            codexHome: '/home/user/.papercusp/su-codex-homes/session-77',
            rolloutId: null,
            exactResumeSupported: false,
            missingReason: 'codex rollout id is not recorded under CODEX_HOME yet',
          },
        })}
        onClose={() => {}}
      />,
    );
    // The resume command leads the section, so it survives the R1 cap — it is
    // the only actionable row here. The rollout id is provenance, one click in.
    expect(
      await findByText(
        "CODEX_HOME='/home/user/.papercusp/su-codex-homes/session-77' codex exec resume 019eeb2b-0742-72a0-85a4-5dc505cfe62d",
      ),
    ).toBeTruthy();
    expect(expandSection(container, 'pc-dossier-native-session')).toBe(true);
    expect(getByText('019eeb2b-0742-72a0-85a4-5dc505cfe62d')).toBeTruthy();
  });

  it('renders Codex runtime diagnostics when the selected agent has a tracked CODEX_HOME', async () => {
    syncState.detail = {
      ...DETAIL,
      nativeSession: {
        backend: 'codex',
        source: 'adv_sessions',
        ownerId: 'su-codex',
        codexHome: '/home/user/.papercusp/su-codex-homes/session-77',
        rolloutId: '019eeb2b-0742-72a0-85a4-5dc505cfe62d',
        exactResumeSupported: true,
        missingReason: null,
      },
      codex: {
          codexHome: '/home/user/.papercusp/su-codex-homes/session-77',
          exists: true,
          agentsPath: '/home/user/.papercusp/su-codex-homes/session-77/AGENTS.md',
          agentsExists: true,
          configPath: '/home/user/.papercusp/su-codex-homes/session-77/config.toml',
          configExists: true,
          hooksPath: '/home/user/.papercusp/su-codex-homes/session-77/hooks.json',
          hooksExists: true,
          promptsPath: '/home/user/.papercusp/su-codex-homes/session-77/prompts',
          promptsExists: true,
          authPath: '/home/user/.papercusp/su-codex-homes/session-77/auth.json',
          authExists: true,
          diagnosticsPath: '/home/user/.papercusp/su-codex-homes/session-77/papercusp-diagnostics.json',
          diagnosticsExists: true,
          diagnostics: {
            lockEnforcement: 'hooks-configured',
            codexPreToolUseStatus: 'codex-hooks-stable-pretooluse',
            requiresExplicitPapercuspLocks: false,
            inheritedPromptsCopied: true,
          },
          latestRolloutId: '019eeb2b-0742-72a0-85a4-5dc505cfe62d',
          latestRolloutPath: '/home/user/.papercusp/su-codex-homes/session-77/sessions/rollout.jsonl',
          resumeStrategy: 'codex-resume-last-in-code-home',
          resumeCommand: "CODEX_HOME='/home/user/.papercusp/su-codex-homes/session-77' codex resume --last",
          error: null,
        },
    } satisfies AgentDetail;
    const { findByText, getByText, getAllByText, container } = render(
      <AgentDossier ownerId="su-codex" entry={entry({ ownerId: 'su-codex', agent: 'codex', source: 'codex' })} onClose={() => {}} />,
    );
    expect(await findByText('Codex Runtime')).toBeTruthy();
    // Rail R1 P-008: eleven diagnostic rows were the tallest block in the old
    // rail. Three preview; the rest are one drill-in away.
    expect(getByText("CODEX_HOME='/home/user/.papercusp/su-codex-homes/session-77' codex resume --last")).toBeTruthy();
    expect(expandSection(container, 'pc-dossier-codex')).toBe(true);
    expect(getAllByText('/home/user/.papercusp/su-codex-homes/session-77').length).toBeGreaterThan(0);
    expect(getAllByText('019eeb2b-0742-72a0-85a4-5dc505cfe62d').length).toBeGreaterThan(0);
    expect(getByText('hooks-configured')).toBeTruthy();
    expect(getByText('not required')).toBeTruthy();
  });

  it('P-005: renders the Health signals — loop, claim, context, checkpoint, unanswered, last tool call', async () => {
    const { findByText, container } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
    );
    expect(await findByText('Health')).toBeTruthy();
    // Scoped to the Health section: "today" also appears in the Coord trail's
    // own timestamp (both are freshly-timestamped in the fixture), so an
    // unscoped getByText('today') would ambiguously match both.
    const health = within(container.querySelector('#pc-dossier-signals')!);
    expect(health.getByText('armed · every 60s · next 5m left')).toBeTruthy();
    expect(health.getByText('WI-9001 — Fix the thing')).toBeTruthy();
    expect(health.getByText('40,000 / 200,000 · 20%')).toBeTruthy();
    expect(health.getByText('did the thing, left the other thing')).toBeTruthy();
    expect(health.getByText('2d ago')).toBeTruthy(); // checkpoint write time
    expect(health.getByText('2 peers waiting on a reply')).toBeTruthy();
    expect(health.getByText('today')).toBeTruthy(); // last tool call, ~30s ago
  });

  it('P-005: an inactive loop renders "not armed", not the interval/next-fire fields', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, loop: { active: false, intervalSec: null, nextFireAt: null, parked: false, stalled: false } },
    } satisfies AgentDetail;
    const { findByText, queryByText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
    );
    expect(await findByText('not armed')).toBeTruthy();
    expect(queryByText(/every \d+s/)).toBeNull();
  });

  it('P-005: a stalled loop is called out explicitly', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: {
        ...DETAIL.signals,
        loop: { active: true, intervalSec: 60, nextFireAt: null, parked: true, stalled: true },
      },
    } satisfies AgentDetail;
    const { findByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(await findByText('armed · every 60s · ⚠ stalled')).toBeTruthy();
  });

  it('P-005: holding no claim renders "none held" rather than hiding the row', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, currentClaim: null },
    } satisfies AgentDetail;
    const { findByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(await findByText('none held')).toBeTruthy();
  });

  // EI-18694403367371331: an agent demonstrably HOLDING WI-5993 rendered
  // "none held" because the underlying read threw, not because it genuinely
  // held nothing — the panel must render these two cases distinctly.
  it('EI-18694403367371331: a claim read that THREW renders "unavailable", never the same "none held" as a genuine empty claim', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, currentClaim: null, unavailableSignals: ['currentClaim'] },
    } satisfies AgentDetail;
    const { findByText, queryByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(await findByText('⚠ unavailable (read failed)')).toBeTruthy();
    expect(queryByText('none held')).toBeNull();
  });

  it('EI-18694403367371331: a loop read that THREW renders "unavailable", never the same "no loop" as a genuinely-never-armed agent', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, loop: null, unavailableSignals: ['loop'] },
    } satisfies AgentDetail;
    const { findByText, queryByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(await findByText('⚠ unavailable (read failed)')).toBeTruthy();
    expect(queryByText('no loop')).toBeNull();
  });

  it('P-005: no unanswered-directed messages hides the row (not "0 peers waiting")', async () => {
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, unansweredDirectedCount: 0 },
    } satisfies AgentDetail;
    const { findByText, queryByText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
    );
    expect(await findByText('Health')).toBeTruthy();
    expect(queryByText(/waiting on a reply/)).toBeNull();
  });

  it('P-005: a long checkpoint note is truncated for the glance row', async () => {
    const longNote = 'x'.repeat(500);
    syncState.detail = {
      ...DETAIL,
      signals: { ...DETAIL.signals, lastCheckpoint: { text: longNote, updatedAtMs: Date.now() } },
    } satisfies AgentDetail;
    const { findByText, queryByText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
    );
    expect(await findByText(`${'x'.repeat(220)}…`)).toBeTruthy();
    expect(queryByText(longNote)).toBeNull();
  });

  it('cross-marks a held file with the L lock marker', async () => {
    const { container } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelector('.pc-dossier__lockmark--held')).toBeTruthy(),
    );
  });

  it('invokes onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={onClose} />,
    );
    fireEvent.click(getByLabelText('Close detail'));
    expect(onClose).toHaveBeenCalled();
  });

  it('handles a selected agent that is no longer in the roster (null entry)', () => {
    const { getByText } = render(<AgentDossier ownerId="gone-1" entry={null} onClose={() => {}} />);
    expect(getByText('This agent is no longer in the live roster.')).toBeTruthy();
    expect(getByText('gone-1')).toBeTruthy();
  });

  // WI-6367: a never-started agent arrives here identically to an ended one
  // (entry: null). Told which it is, the rail must not use the past tense.
  // WI-6821: once the launch is OBSERVED dead, "starting up" is a lie here just
  // as much as in the banner next to it. launchFailed outranks startingUp — both
  // are set together for a failed launch, so precedence is what decides the copy.
  it('says the launch failed (not "starting up") when launchFailed is set', () => {
    const { getByText, queryByText } = render(
      <AgentDossier ownerId="su-dead-1" entry={null} onClose={() => {}} startingUp launchFailed />,
    );
    expect(getByText("This session's launch failed — it never came online.")).toBeTruthy();
    expect(queryByText("Starting up — this agent hasn't registered yet.")).toBeNull();
  });

  it('says the agent is starting up (not "no longer in the live roster") when startingUp is set', () => {
    const { getByText, queryByText } = render(
      <AgentDossier ownerId="su-new-1" entry={null} onClose={() => {}} startingUp />,
    );
    expect(getByText("Starting up — this agent hasn't registered yet.")).toBeTruthy();
    expect(queryByText('This agent is no longer in the live roster.')).toBeNull();
  });

  // A live entry always wins: startingUp is only a tiebreaker for `entry: null`,
  // so a registered agent must still show its declared intent.
  it('prefers a real roster entry over startingUp', () => {
    const { getByText, queryByText } = render(
      <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} startingUp />,
    );
    expect(queryByText("Starting up — this agent hasn't registered yet.")).toBeNull();
    expect(getByText('refactoring attempt-claim split')).toBeTruthy();
  });

  // ── Events (the agent's live subscriptions) ──
  // [owner 2026-07-28] "are the events an agent currently subscribed to listed
  // in their chat popup? If not add that."
  // Rail R1 P-008 renamed this section's heading to "Waiting on" and promoted it
  // from LAST to second. The owner's ask was that the subscriptions be LISTED
  // ([owner 2026-07-28] "are the events an agent currently subscribed to listed
  // in their chat popup? If not add that") — they still are, so the rename does
  // not touch that requirement. The scroll-target id stays `pc-dossier-events`.
  describe('Waiting on (events) section', () => {
    const SUBS = {
      count: 2,
      items: [
        {
          eventKey: 'deploy:release-cut',
          policy: 'wake',
          note: 'waiting on the release',
          once: true,
          wakes: true,
          urgent: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          expiresTs: null,
        },
        {
          eventKey: 'coord:human-message',
          policy: 'watch',
          note: null,
          once: false,
          wakes: false,
          urgent: true,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          expiresTs: null,
        },
      ],
    };

    it('lists the events the agent is subscribed to, with the count and the one-shot/standing distinction', async () => {
      syncState.detail = { ...DETAIL, subscriptions: SUBS } satisfies AgentDetail;
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      expect(await findByText('Waiting on')).toBeTruthy();
      const events = within(container.querySelector('#pc-dossier-events')!);
      expect(events.getByText('2 subscribed')).toBeTruthy();
      expect(events.getByText('deploy:release-cut')).toBeTruthy();
      expect(events.getByText('coord:human-message')).toBeTruthy();
      expect(events.getByText('· waiting on the release')).toBeTruthy();
      // A watch that records but does not wake, and an urgent one, are called out.
      expect(events.getByText('· no wake')).toBeTruthy();
      expect(events.getByText('· urgent')).toBeTruthy();
      expect(container.querySelectorAll('[data-testid="dossier-events-row"]').length).toBe(2);
      // One-shot vs standing watch is rendered, not merely implied.
      expect(events.getByTitle('one-shot await')).toBeTruthy();
      expect(events.getByTitle('standing watch')).toBeTruthy();
    });

    it('says the agent is waiting on nothing when it holds no subscriptions', async () => {
      syncState.detail = {
        ...DETAIL,
        subscriptions: { count: 0, items: [] },
      } satisfies AgentDetail;
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      expect(await findByText('Not waiting on any event.')).toBeTruthy();
      expect(container.querySelectorAll('[data-testid="dossier-events-row"]').length).toBe(0);
    });

    // A READ FAILURE MUST NOT LOOK LIKE "SUBSCRIBED TO NOTHING". Those are
    // opposite conclusions for anyone deciding whether an agent will ever wake
    // again — the same rationale as getAgentSignals' unavailableSignals.
    it('surfaces a read failure instead of rendering it as an empty subscription list', async () => {
      syncState.detail = {
        ...DETAIL,
        subscriptions: { count: 0, items: [], error: 'event_awaits unreachable' },
      } satisfies AgentDetail;
      const { findByText, queryByText } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      expect(await findByText(/Couldn’t load subscriptions: event_awaits unreachable/)).toBeTruthy();
      expect(queryByText('Not waiting on any event.')).toBeNull();
    });

    // THE WIRE CONTRACT. `subscriptions` is a NEW field and the SPA rebuilds on
    // the vite hot path while the sidecar only rebuilds on restart, so a fresh
    // bundle can genuinely be served a payload without it. Reading `.length`
    // off `undefined` there took the WHOLE hud tab down once already (the coord
    // `unread` regression) — this pins that it cannot happen again.
    it('renders normally when an older operator serves a detail payload with no subscriptions field', async () => {
      const { subscriptions: _omitted, ...withoutSubs } = { ...DETAIL, subscriptions: SUBS };
      syncState.detail = withoutSubs as AgentDetail;
      const { findByText } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      // The section still renders its empty state, and nothing throws.
      expect(await findByText('Not waiting on any event.')).toBeTruthy();
    });
  });

  // ── Rail R1 (session-chat-popup-direction-d-2026-08-02 P-008) ──
  // The rail's height must be bounded BY CONSTRUCTION: no agent's state can
  // grow a section past three rows. The deck left one open cost — "Open all 32
  // needs somewhere to go" — and the answer is expand-in-place, which only
  // works if the drill-in genuinely reveals the rest AND stays honest when the
  // operator never sent the rest.
  describe('rail R1 — capped sections', () => {
    it('caps a long section at three rows and reveals the rest on the drill-in', async () => {
      const files = Array.from({ length: 9 }, (_, i) => `apps/operator/lib/file-${i}.ts`);
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry({ currentFiles: files })} onClose={() => {}} />,
      );
      await findByText('Files');
      const rows = () => container.querySelectorAll('#pc-dossier-files .pc-dossier__file').length;
      expect(rows()).toBe(3);
      // The count in the header is the TRUE total, not the previewed count —
      // a header that said "3" would hide the problem instead of pointing at it.
      expect(within(container.querySelector('#pc-dossier-files')!).getByText('9')).toBeTruthy();
      expect(expandSection(container, 'pc-dossier-files')).toBe(true);
      expect(rows()).toBe(9);
      // …and back, so the cap is a toggle rather than a one-way door.
      expandSection(container, 'pc-dossier-files');
      expect(rows()).toBe(3);
    });

    it('leaves a section that fits under the cap alone — no drill-in at all', async () => {
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry({ currentFiles: ['a.ts', 'b.ts'] })} onClose={() => {}} />,
      );
      await findByText('Files');
      expect(container.querySelectorAll('#pc-dossier-files .pc-dossier__file').length).toBe(2);
      expect(expandSection(container, 'pc-dossier-files')).toBe(false);
    });

    // WHICH three rows survive the cap is the whole design. A file the agent is
    // BLOCKED on must never be the one the cap hides behind eight quiet ones.
    it('orders the capped Files preview so contended files survive the cap', async () => {
      const quiet = Array.from({ length: 8 }, (_, i) => `quiet-${i}.ts`);
      syncState.detail = {
        ...DETAIL,
        locks: {
          held: [
            {
              path: 'held.ts',
              intent: 'editing',
              acquiredAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
          waiting: [
            {
              ticketId: 't1',
              paths: ['contended.ts'],
              intent: 'waiting to edit',
              aheadCount: 0,
              queuedAt: new Date().toISOString(),
              waitUntil: new Date(Date.now() + 120_000).toISOString(),
              blockedBy: [],
            },
          ],
          error: null,
        },
      } satisfies AgentDetail;
      const { container } = render(
        <AgentDossier
          ownerId="su-1"
          entry={entry({ currentFiles: [...quiet, 'held.ts', 'contended.ts'] })}
          onClose={() => {}}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('#pc-dossier-files .pc-dossier__lockmark--wait')).toBeTruthy(),
      );
      const shown = Array.from(
        container.querySelectorAll('#pc-dossier-files .pc-dossier__file .pc-dossier__file-path'),
      ).map((n) => n.textContent);
      expect(shown[0]).toBe('contended.ts');
      expect(shown[1]).toBe('held.ts');
      expect(shown).toHaveLength(3);
    });

    // THE REGRESSION THIS SECTION EXISTS TO PREVENT. [owner 2026-07-28] "it says
    // in the COORD section 38 unread, but I only see 2 messages" — a count that
    // named rows the section could not show. Capping re-creates that bug exactly
    // unless expanding says what it could NOT reach, so this pins the honesty,
    // not just the expansion.
    it('does not claim to have reached unread messages the operator never sent', async () => {
      syncState.detail = {
        ...DETAIL,
        coord: {
          ...DETAIL.coord,
          // The operator counts 38 but sends a BOUNDED slice — that gap IS the
          // condition under test, so the fixture models it rather than padding
          // `unread` out to 38 and testing nothing.
          unreadCount: 38,
          unread: DETAIL.coord.unread,
        },
      } satisfies AgentDetail;
      const { container, findByText } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      await findByText('38 unread');
      const held = container.querySelectorAll('#pc-dossier-coord .pc-dossier__coord-line').length;
      expect(held).toBe(3); // capped preview
      expect(expandSection(container, 'pc-dossier-coord')).toBe(true);
      const shown = container.querySelectorAll('#pc-dossier-coord .pc-dossier__coord-line').length;
      // Expanding reveals everything we HOLD — and then says so plainly, rather
      // than letting the 38 imply it got there.
      expect(shown).toBeGreaterThan(held);
      expect(shown).toBeLessThan(38);
      const note = await findByText(/^Showing the \d+ most recent of \d+\.$/);
      expect(note.textContent).toContain(`Showing the ${shown} most recent`);
      expect(Number(/of (\d+)\./.exec(note.textContent ?? '')?.[1])).toBeGreaterThanOrEqual(38);
    });

    it('previews three reference rows and hides the rest behind one link', async () => {
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      await findByText('Reference');
      const rows = () => container.querySelectorAll('#pc-dossier-reference .pc-dossier__meta-row').length;
      expect(rows()).toBe(3);
      expect(expandSection(container, 'pc-dossier-reference')).toBe(true);
      expect(rows()).toBeGreaterThan(3);
      // cwd is one of the rows the deck says nobody reads mid-conversation —
      // present, but only after the drill-in.
      expect(within(container.querySelector('#pc-dossier-reference')!).getByText('/repo')).toBeTruthy();
    });

    it('orders the rail by operational urgency — Waiting on second, never below Coord', async () => {
      const { findByText, container } = render(
        <AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />,
      );
      await findByText('Waiting on');
      const ids = Array.from(container.querySelectorAll('section[id]')).map((n) => n.id);
      // DOM order, not CSS order — the visual sequence and the reading/tab
      // sequence have to agree (WCAG 1.3.2).
      expect(ids.indexOf('pc-dossier-events')).toBeLessThan(ids.indexOf('pc-dossier-coord'));
      expect(ids.indexOf('pc-dossier-events')).toBeLessThan(ids.indexOf('pc-dossier-locks'));
      expect(ids.indexOf('pc-dossier-signals')).toBeLessThan(ids.indexOf('pc-dossier-events'));
      // …and the reference material sinks below everything operational.
      expect(ids.indexOf('pc-dossier-coord')).toBeLessThan(ids.indexOf('pc-dossier-reference'));
    });
  });
});
