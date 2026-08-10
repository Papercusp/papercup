// @vitest-environment jsdom
/**
 * GoalDetailPanel render coverage (goal-mode-2026-08-07 P-021).
 *
 * The arithmetic is covered exhaustively in goal-detail-model.test.ts. What
 * only a DOM can prove — and what this suite therefore pins — are the four
 * claims the surface makes that a passing model test would not catch:
 *
 *   1. A KILLED project is still on the page. This is the one the item calls
 *      out: dropping it is a one-word change (`.filter(p => !p.removed)`) that
 *      every model test still passes, and the page then only ever shows growth.
 *   2. An unmeasured tripwire does not render as a filled bar.
 *   3. The panel asks for the workspace it was GIVEN — a `'default'` fallback
 *      here renders a healthy-looking page pointed at the wrong tenant.
 *   4. A free-text criterion with no tripwires renders prose and no chart
 *      furniture — the normal case, and the one most likely to regress into an
 *      empty-state placeholder that implies something is missing.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GoalDetailInput } from './goal-detail-model';

const syncCalls: Array<{ queryName: string; args?: Record<string, unknown>; enabled?: boolean }> = [];
let syncResult: { data: unknown[] | null; loading: boolean; error: unknown } = {
  data: null,
  loading: false,
  error: null,
};

/* P-018 put the rail's open-state in the URL (`hudgoalrail`), which is the
   repo's rule for anything user-meaningful — so the panel now needs nuqs. Same
   local stand-in the other component suites use (OperatorChatSidebar,
   PlansPane): a real adapter would drag the router in for a param whose only
   job here is to flip a boolean. */
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    parseAsBoolean: {
      withDefault(defaultValue: boolean) {
        return { defaultValue };
      },
    },
    useQueryState(_key: string, parser?: { defaultValue?: boolean }) {
      const [value, setValue] = React.useState(parser?.defaultValue ?? null);
      const set = React.useCallback((next: unknown) => {
        setValue(typeof next === 'function' ? (next as (p: unknown) => boolean)(value) : (next as boolean));
        return Promise.resolve(new URLSearchParams());
      }, [value]);
      return [value, set];
    },
  };
});

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    syncCalls.push(opts);
    return { ...syncResult, fetching: false, invalidate: vi.fn() };
  },
}));

/* D-011: the popup now EMBEDS the agent conversation. These two mocks stand in
   for its network half and its renderer, so the assertions below are about what
   this panel is responsible for — mounting the right thing, with the right
   props, in each state — rather than about SSE.

   ⚠ Mocking the hook is what makes these tests DISCRIMINATING. Without it, the
   unmocked `fetch` in jsdom means the session never resolves, so "no composer
   renders" is true no matter what this component does — which is exactly how
   the retracted D-011's `offers no composer` assertion kept passing after the
   composer was added. A test that cannot fail is not evidence. */
let chatState: Record<string, unknown> = {};
const chatSends: string[] = [];
vi.mock('@/app/_components/chat/use-owner-session-chat', () => ({
  useOwnerSessionChat: (ownerId: string | null) => ({
    streamUrl: null,
    resolved: null,
    resolving: false,
    resolveError: null,
    send: (t: string) => chatSends.push(t),
    sending: false,
    sendError: null,
    sentOk: null,
    // The per-test override wins, but only when there IS an agent — passing a
    // null ownerId must stay inert regardless of what a test asked for.
    ...(ownerId ? chatState : {}),
  }),
}));
vi.mock('@/app/_components/chat/SessionChatModal', () => ({
  LiveSessionChat: (p: { streamUrl: string; sessionOwnerId: string; onSend: (t: string) => void }) => (
    <div data-testid="live-chat" data-owner={p.sessionOwnerId} data-stream={p.streamUrl}>
      <textarea aria-label="Message" />
      <button type="button" onClick={() => p.onSend('hello')}>
        Send
      </button>
    </div>
  ),
}));

// The Radix dialog renders into a portal; the assertions below read
// document.body, so no shim is needed — but jsdom lacks the pointer-capture
// APIs Radix probes on mount.
beforeEach(() => {
  syncCalls.length = 0;
  syncResult = { data: null, loading: false, error: null };
  // Default: no session resolved, so a test that does not opt in gets the
  // inert-chat baseline rather than another test's leftover state.
  chatState = {};
  chatSends.length = 0;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
});
afterEach(cleanup);

// eslint-disable-next-line import/first
import GoalDetailPanel from './GoalDetailPanel';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function detail(over: Partial<GoalDetailInput> = {}): GoalDetailInput {
  return {
    goal: {
      id: 'goal-1',
      title: 'Ship a paid app',
      status: 'active',
      killCriterion: 'Stop if no paying user by day 30.',
      spendUsd: 310,
      budgetCents: 50_000,
      ...over.goal,
    },
    projects: [],
    waitingOnYou: [],
    activity: [],
    spendByDay: [],
    spendLabel: 'fleet spend',
    spendNote: 'Goal spend figures do not sum.',
    ...over,
  };
}

function renderPanel(data: GoalDetailInput | null, props: Record<string, unknown> = {}) {
  syncResult = { data: data ? [data] : null, loading: false, error: null };
  return render(
    <GoalDetailPanel
      goalId="goal-1"
      workspaceId="ws-real"
      nowMs={NOW}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('GoalDetailPanel', () => {
  it('renders nothing and fires no query while closed', () => {
    render(<GoalDetailPanel goalId={null} workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).not.toContain('This goal ends when');
    expect(syncCalls[0]?.enabled).toBe(false);
  });

  it('asks goals.detail for the workspace it was GIVEN, never a default', () => {
    // A silent 'default' here returns a real-looking empty page for the wrong
    // tenant — the failure mode that is hardest to see, because "no goals yet"
    // is a state this surface legitimately shows (the WI-5125 shape).
    renderPanel(detail());
    const call = syncCalls.find((c) => c.queryName === 'goals.detail');
    expect(call).toBeTruthy();
    expect(call?.args).toMatchObject({ workspaceId: 'ws-real', goalId: 'goal-1' });
    expect(call?.enabled).toBe(true);
  });

  it('leads with the kill criterion, verbatim', () => {
    renderPanel(detail());
    expect(screen.getByTestId('goal-kill-criterion').textContent).toBe(
      'Stop if no paying user by day 30.',
    );
  });

  it('shouts when NO kill criterion is set', () => {
    renderPanel(detail({ goal: { id: 'goal-1', title: 'g', status: 'active', killCriterion: null } }));
    const el = screen.getByTestId('goal-kill-criterion');
    expect(el.textContent).toMatch(/nothing can stop this goal/i);
    expect(el.className).toContain('hud-goal__criterion--missing');
  });

  it('renders a free-text criterion with NO tripwire furniture', () => {
    // Tripwires are optional; the no-bars case must look finished, not empty.
    renderPanel(detail());
    expect(screen.queryByTestId('goal-tripwires')).toBeNull();
    expect(screen.getByTestId('goal-kill-criterion')).toBeTruthy();
  });

  it('renders tripwire bars, and does NOT fill an unmeasured one', () => {
    renderPanel(
      detail({
        goal: {
          id: 'goal-1',
          title: 'g',
          status: 'active',
          killCriterion: 'stop at 30 days or $500',
          tripwires: [
            { metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 12, unit: 'days' },
            { metric: 'spend', label: 'Spend', threshold: 500, current: 310, unit: 'usd' },
            { metric: 'builds', label: 'Shipped builds', threshold: 1 },
          ],
        },
      }),
    );
    const bars = screen.getByTestId('goal-tripwires');
    expect(bars.textContent).toContain('day 12 of 30');
    expect(bars.textContent).toContain('$310 of $500');
    expect(bars.textContent).toContain('not measured yet');

    // Three bars, but only TWO fills: the unread one must be visually distinct
    // from a real zero rather than a zero-width fill nobody can tell apart.
    expect(bars.querySelectorAll('.hud-goal__bar-fill')).toHaveLength(2);
    expect(bars.querySelectorAll('.hud-goal__bar-unread')).toHaveLength(1);
  });

  it('KEEPS a closed project on the page, with its reason', () => {
    // The invariant the item singles out. A `.filter(p => !p.removed)` in the
    // component would leave every model test green and delete the only
    // evidence that the agent closes things.
    renderPanel(
      detail({
        projects: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 1 },
          {
            harnessSlug: 'beta',
            role: 'contributing',
            killCriterion: 'ship by day 14',
            servesGoals: 1,
            removedAt: '2026-08-05T00:00:00Z',
            note: 'no traction after two weeks',
          },
        ],
      }),
    );
    expect(screen.getByTestId('goal-projects').textContent).toContain('alpha');

    const closed = screen.getByTestId('goal-projects-closed');
    expect(closed.textContent).toContain('beta');
    expect(closed.textContent).toContain('no traction after two weeks');
    expect(closed.querySelector('.hud-goal__proj--removed')).toBeTruthy();
  });

  it('shows each project its OWN kill criterion and the shared badge', () => {
    renderPanel(
      detail({
        projects: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 3 },
          { harnessSlug: 'gamma', role: 'contributing', servesGoals: 1 },
        ],
      }),
    );
    const grid = screen.getByTestId('goal-projects');
    expect(grid.textContent).toContain('ship by day 14');
    expect(grid.textContent).toContain('shared with 2 other goals');
    // Clause 4 requires one per project — its absence is surfaced, not hidden.
    expect(grid.textContent).toContain('No kill criterion for this project');
  });

  it('lists waiting-on-you above activity and opens an item', () => {
    const onOpenWorkItem = vi.fn();
    renderPanel(
      detail({
        waitingOnYou: [
          { id: 'WI-1', title: 'Approve the pricing page', harnessSlug: 'alpha', updatedAt: '2026-08-09T08:00:00Z' },
        ],
        activity: [
          { id: 'WI-2', title: 'Built the checkout', harnessSlug: 'alpha', closedAt: '2026-08-09T09:00:00Z' },
        ],
      }),
      { onOpenWorkItem },
    );
    const body = document.body.textContent ?? '';
    expect(body.indexOf('Waiting on you')).toBeLessThan(body.indexOf('Activity'));

    fireEvent.click(screen.getByRole('button', { name: 'Approve the pricing page' }));
    expect(onOpenWorkItem).toHaveBeenCalledWith('WI-1');
  });

  it('carries the do-not-sum caveat next to the spend chart', () => {
    // D-021: a shared project counts in full against every goal it serves, so
    // these figures do not add up. This is the section most likely to be
    // screenshotted, so the caveat travels with it.
    renderPanel(
      detail({
        spendByDay: [
          { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 3 },
          { day: '2026-08-02', harnessSlug: 'alpha', costUsd: 8 },
        ],
      }),
    );
    expect(screen.getByTestId('goal-spend-chart').querySelectorAll('.hud-goal__col')).toHaveLength(2);
    expect(document.body.textContent).toContain('Goal spend figures do not sum.');
  });

  it('says a goal is gone rather than rendering an empty shell', () => {
    syncResult = { data: [{ goal: null }], loading: false, error: null };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('no longer exists');
  });

  it('surfaces a load error instead of an empty page', () => {
    syncResult = { data: null, loading: false, error: new Error('boom') };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('Could not load this goal');
  });

  /* ── P-018: the SessionChatModal frame ──────────────────────────────────
     What only a DOM can prove here is STRUCTURE, not content: the vitals band
     and the rail have to sit OUTSIDE the scrolling body, or they scroll away
     with it and the "glance" the band exists to provide is gone exactly when
     the reader has scrolled down to look for detail. */
  it('puts the vitals band OUTSIDE the scrolling body, not inside it', () => {
    renderPanel(detail());
    const vitals = screen.getByTestId('goal-vitals');
    const body = screen.getByTestId('goal-detail');
    expect(vitals).toBeTruthy();
    // The bug this pins is a one-line nesting slip that looks identical on a
    // short goal and breaks completely on a long one.
    expect(body.contains(vitals)).toBe(false);
    expect(screen.getByTestId('goal-detail-modal').contains(vitals)).toBe(true);
  });

  it('leads the band with status, the stopping condition and spend-vs-ceiling', () => {
    renderPanel(detail());
    const vitals = screen.getByTestId('goal-vitals');
    expect(vitals.textContent).toContain('active');
    expect(vitals.textContent).toContain('Stop if no paying user by day 30.');
    expect(vitals.textContent).toContain('$310');
  });

  it('renders the status ONCE — the band owns it, the header no longer repeats it', () => {
    renderPanel(detail({ goal: { status: 'paused' } as never }));
    // Two copies of one status is how a stale one goes unnoticed. Asserted as
    // "the band has it, the title row does not" rather than by counting DOM
    // nodes, which is what the status word is actually claimed to be.
    expect(screen.getByTestId('goal-vitals').textContent).toContain('paused');
    const titleRow = document.body.querySelector('.hud-goal__title-row') as HTMLElement;
    expect(titleRow).toBeTruthy();
    expect(titleRow.textContent).not.toContain('paused');
  });

  /* ── D-011 (the RETRACTION): the popup EMBEDS the conversation ─────────────
     These replace an `offers no composer` test that encoded the retracted
     ruling. Note it kept PASSING after the composer was added, because jsdom
     never resolved a session — so it was asserting an absence produced by the
     test environment rather than by the design. */

  it('EMBEDS the live conversation for the goal’s agent, reusing LiveSessionChat', () => {
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/api/adv/session/thinking?x=1' };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    const chat = screen.getByTestId('live-chat');
    // Wired to THIS goal's agent and THIS stream — not merely present.
    expect(chat.getAttribute('data-owner')).toBe('su-abc');
    expect(chat.getAttribute('data-stream')).toBe('/api/adv/session/thinking?x=1');
    // The composer the owner reported missing.
    expect(document.body.querySelector('textarea')).not.toBeNull();
  });

  it('sends through the SHARED wiring rather than a second send path', () => {
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/s' };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    fireEvent.click(screen.getByText('Send'));
    expect(chatSends).toEqual(['hello']);
  });

  it('renders a plain statement and NO composer when no agent runs the goal', () => {
    // D-011: "a composer that looks live and can reach nobody is worse than
    // none." Unlike the test this replaced, the absence here is caused by the
    // component's own branch — the hook is mocked as resolvable.
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/s' };
    renderPanel(detail({ agents: [] }), { onOpenAgent: () => {} });
    expect(screen.getByTestId('goal-chat-no-agent')).toBeTruthy();
    expect(screen.queryByTestId('live-chat')).toBeNull();
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('says so, without a composer, when the agent has no recent session', () => {
    chatState = { resolved: null, streamUrl: null };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    expect(screen.getByTestId('goal-chat-no-session')).toBeTruthy();
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('surfaces a resolve FAILURE instead of an empty chat that looks idle', () => {
    chatState = { resolveError: 'sessions:list → 500', resolved: null, streamUrl: null };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    expect(screen.getByTestId('goal-chat-error').textContent).toContain('sessions:list → 500');
  });

  it('routes to the goal’s agent when there IS one, and renders no dead button when there is not', () => {
    const seen: string[] = [];
    const { unmount } = renderPanel(
      detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }),
      { onOpenAgent: (id: string) => seen.push(id) },
    );
    fireEvent.click(screen.getByTestId('goal-open-agent'));
    expect(seen).toEqual(['su-abc']);
    unmount();
    cleanup();

    // No agent stamped on the goal ⇒ the control is ABSENT, not present-and-inert.
    renderPanel(detail({ agents: [] }), { onOpenAgent: () => {} });
    expect(screen.queryByTestId('goal-open-agent')).toBeNull();
    cleanup();

    // Host cannot route ⇒ also absent. WI-6742's dead-button shape.
    renderPanel(detail({ agents: [{ ownerId: 'su-abc' }] }));
    expect(screen.queryByTestId('goal-open-agent')).toBeNull();
  });

  /* ── P-019: the work rail ──────────────────────────────────────────────── */
  it('seats the rail as a SIBLING of the body so it does not scroll away', () => {
    renderPanel(detail());
    const rail = screen.getByTestId('goal-work-rail');
    expect(screen.getByTestId('goal-detail').contains(rail)).toBe(false);
    expect(screen.getByTestId('goal-detail-modal').contains(rail)).toBe(true);
  });

  it('lists the goal’s plans and work items, showing an overlapping item ONCE', () => {
    renderPanel(
      detail({
        plans: [
          { planSlug: 'ship-it', harnessSlug: 'papercusp', title: 'Ship it', items: 4, openItems: 2 },
        ],
        waitingOnYou: [{ id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp' }],
        activity: [
          { id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp', status: 'open' },
          { id: 'WI-2', title: 'In flight', harnessSlug: 'papercusp', status: 'wip' },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    expect(rail.textContent).toContain('Ship it');
    // The dedupe, asserted where the reader actually sees it: WI-1 arrives in
    // BOTH waitingOnYou and activity, and must render exactly one row.
    const rows = Array.from(rail.querySelectorAll('[data-testid="goal-rail-item"]'));
    expect(rows.filter((r) => r.getAttribute('data-id') === 'WI-1')).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('rail rows reuse the panel’s EXISTING work-item route, not a second one', () => {
    const opened: string[] = [];
    renderPanel(detail({ activity: [{ id: 'WI-7', title: 'Openable', status: 'wip' }] }), {
      onOpenWorkItem: (id: string) => opened.push(id),
    });
    const row = screen
      .getByTestId('goal-work-rail')
      .querySelector('[data-testid="goal-rail-item"][data-id="WI-7"]') as HTMLElement;
    fireEvent.click(row);
    expect(opened).toEqual(['WI-7']);
  });

  it('says WHY the rail is empty instead of rendering bare headings', () => {
    // D-010: this is the LIVE state of every goal in this workspace today, so
    // it is the state most likely to be seen — not an edge case.
    renderPanel(detail());
    const rail = screen.getByTestId('goal-work-rail');
    expect(screen.getByTestId('goal-rail-empty')).toBeTruthy();
    // Three empty section headings read as a panel that failed to load.
    expect(rail.querySelectorAll('.pc-peers__cap')).toHaveLength(0);
    expect(rail.textContent).toContain('Nothing is under this goal yet');
  });

  it('the toggle actually hides the rail', () => {
    renderPanel(detail());
    expect(screen.queryByTestId('goal-work-rail')).toBeTruthy();
    fireEvent.click(screen.getByTestId('goal-rail-toggle'));
    expect(screen.queryByTestId('goal-work-rail')).toBeNull();
  });

  it('does not total the plan rows into a goal-wide figure (D-002/D-021)', () => {
    renderPanel(
      detail({
        plans: [
          { planSlug: 'a', harnessSlug: 'h', title: 'A', items: 3, openItems: 2 },
          { planSlug: 'b', harnessSlug: 'h', title: 'B', items: 4, openItems: 3 },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    // 2+3=5 and 3+4=7 must appear nowhere: these figures deliberately do not
    // sum, and a parent/child layout is the one that most tempts a reader to
    // add them. The per-row counts themselves stay visible.
    expect(rail.textContent).toContain('2 open of 3 on this goal');
    expect(rail.textContent).toContain('3 open of 4 on this goal');
    expect(rail.textContent).not.toMatch(/\b5 open\b/);
    expect(rail.textContent).not.toMatch(/\b7 (open|total)\b/);
  });

  it('closing clears the selection', () => {
    const onClose = vi.fn();
    renderPanel(detail(), { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
