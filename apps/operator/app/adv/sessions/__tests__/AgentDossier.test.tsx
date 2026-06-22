/**
 * @vitest-environment jsdom
 *
 * AgentDossier (P-007) — the right-pane agent detail. Verifies it renders the
 * Tier-1/2 facts from the passed RosterEntry immediately, lazy-fetches the
 * Tier-3 dossier from /api/adv/roster/agent, cross-marks files with the agent's
 * lock state, and renders the coord trail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/react';
import AgentDossier, { type AgentDetail } from '../AgentDossier';
import type { RosterEntry } from '../SessionsRosterView';

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
};

describe('AgentDossier', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => DETAIL });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('renders Tier-1/2 facts from the entry immediately', () => {
    const { getByText } = render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    expect(getByText('worker-188')).toBeTruthy();
    expect(getByText('worker')).toBeTruthy();
    expect(getByText('F-012')).toBeTruthy();
    expect(getByText('refactoring attempt-claim split')).toBeTruthy();
    expect(getByText('avi-dev')).toBeTruthy(); // host meta
    expect(getByText('dbos-retire')).toBeTruthy(); // plan meta
  });

  it('lazy-fetches the dossier keyed by owner id', async () => {
    render(<AgentDossier ownerId="su-1" entry={entry()} onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/adv/roster/agent?owner=su-1');
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
            exactResumeSupported: true,
            missingReason: null,
          },
        })}
        onClose={() => {}}
      />,
    );
    expect(getByText('Native Session')).toBeTruthy();
    expect(getByText('claude --resume claude-uuid-1')).toBeTruthy();
    expect(getByText('spawned_agents')).toBeTruthy();
    expect(getByText('supported')).toBeTruthy();
  });

  it('prefers the lazy detail native session when it has a Codex rollout id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
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
      } satisfies AgentDetail),
    });
    const { findByText, getByText } = render(
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
    expect(await findByText('019eeb2b-0742-72a0-85a4-5dc505cfe62d')).toBeTruthy();
    expect(getByText("CODEX_HOME='/home/user/.papercusp/su-codex-homes/session-77' codex exec resume 019eeb2b-0742-72a0-85a4-5dc505cfe62d")).toBeTruthy();
  });

  it('renders Codex runtime diagnostics when the selected agent has a tracked CODEX_HOME', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
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
      } satisfies AgentDetail),
    });
    const { findByText, getByText, getAllByText } = render(
      <AgentDossier ownerId="su-codex" entry={entry({ ownerId: 'su-codex', agent: 'codex', source: 'codex' })} onClose={() => {}} />,
    );
    expect(await findByText('Codex Runtime')).toBeTruthy();
    expect(getAllByText('/home/user/.papercusp/su-codex-homes/session-77').length).toBeGreaterThan(0);
    expect(getByText("CODEX_HOME='/home/user/.papercusp/su-codex-homes/session-77' codex resume --last")).toBeTruthy();
    expect(getAllByText('019eeb2b-0742-72a0-85a4-5dc505cfe62d').length).toBeGreaterThan(0);
    expect(getByText('hooks-configured')).toBeTruthy();
    expect(getByText('not required')).toBeTruthy();
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
});
