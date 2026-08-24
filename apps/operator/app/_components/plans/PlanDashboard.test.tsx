// @vitest-environment jsdom
//
// PlanDashboard render (plan-visibility-revamp-2026-08-23 P-003): the option-C
// app-pane surface — header (bucket/title/✎⚒ meta/progress/needs-you),
// Working-now session cards (planSessions.list ⋈ advRoster.list), the
// Recent-activity feed (planActivity.list), and the action wiring (back,
// Open full plan → ?wppop, Search transcripts → ?wppop+?ppv, Launch agent,
// Open session → ?pdsess, work-row deep link → ?wpop). Data hooks are mocked;
// nuqs is a seeded store (same seams as PlansPane.test.tsx).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

const {
  nuqs,
  setters,
  planListData,
  attentionItems,
  syncData,
  launchAgentSpy,
  toastSpies,
  cleanupFlag,
} = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  planListData: { value: null as { plans: PlanListRow[] } | null },
  attentionItems: {
    value: [] as Array<{ planSlug: string | null; tier: string }>,
  },
  // Branched by queryName — the dashboard runs FOUR sync queries; a
  // queryName-blind mock would cross-feed them (the PlansPane P-002 lesson).
  syncData: {
    value: {} as Record<string, { data: unknown[]; loading?: boolean }>,
  },
  launchAgentSpy: vi.fn(async (_a?: unknown) => ({ ok: true as const })),
  toastSpies: { success: vi.fn(), error: vi.fn() },
  cleanupFlag: { value: true },
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
/* ⚠ SPREAD THE ORIGINAL, never a from-scratch factory: operator-core's
   `lib/lazy-with-retry` RE-EXPORTS from `@papercusp/sync`, and PlansPane (which
   PlanDashboard imports for agoLabel/progressOf) reaches it through
   PlanDashboardHost's module-scope `lazy(...)` call. A partial mock makes that
   binding undefined and the whole suite fails to COLLECT with
   "lazyWithRetry is not a function" — exactly what red-flagged this file in the
   2026-08-23 P-003/P-005 affected run. */
vi.mock('@papercusp/sync', async (orig) => ({
  ...(await orig<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: syncData.value[queryName]?.data ?? [],
    loading: syncData.value[queryName]?.loading ?? false,
    error: null,
    invalidate: vi.fn(),
  }),
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => cleanupFlag.value }));
// Keep bucketOf real — only stub the data hook.
vi.mock('@/app/admin/plans/plans-api', async (orig) => ({
  ...(await orig<typeof import('@/app/admin/plans/plans-api')>()),
  usePlanList: () => ({
    data: planListData.value,
    loading: planListData.value === null,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock('../inbox/use-inbox-pending', () => ({
  effectiveTier: (i: { tier?: string }) => i.tier ?? 'activity',
  useInboxAttention: () => ({ items: attentionItems.value, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (a: unknown) => launchAgentSpy(a),
}));
vi.mock('sonner', () => ({ toast: toastSpies }));
// The session chat is a heavy modal stack — assert the prop seam only.
vi.mock('../chat/SessionChatModal', () => ({
  default: ({ sessionOwnerId }: { sessionOwnerId: string | null }) =>
    sessionOwnerId ? <div data-testid="session-chat-open">{sessionOwnerId}</div> : null,
}));

import PlanDashboard, { avatarColor, shortOwnerId } from './PlanDashboard';

function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    status: over.status ?? 'active',
    updated: over.updated ?? new Date(Date.now() - 2 * 60_000).toISOString(),
    archived: false,
    isLegacy: false,
    itemCounts: over.itemCounts,
    harness: over.harness ?? 'papercusp',
    startStatus: over.startStatus,
  } as PlanListRow;
}

const OWNER_A = 'su-76a83f00-1111-2222-3333-444455556666';
const OWNER_B = 'su-82be7d00-aaaa-bbbb-cccc-ddddeeeeffff';

function seed(opts?: {
  liveSessions?: boolean;
  activity?: boolean;
  needsYou?: boolean;
  worked?: boolean;
}) {
  planListData.value = {
    plans: [
      plan({
        slug: 'p1',
        title: 'Security posture closure',
        startStatus: 'started',
        itemCounts: { done: 3, todo: 6 },
      }),
    ],
  };
  attentionItems.value = opts?.needsYou
    ? [
        { planSlug: 'p1', tier: 'decision' },
        { planSlug: 'p1', tier: 'activity' }, // non-decision — must not count
        { planSlug: 'other', tier: 'decision' }, // other plan — must not count
      ]
    : [];
  syncData.value = {
    'planWorkActivity.list': {
      data: opts?.worked === false ? [] : [{ slug: 'p1', lastWorkAtMs: Date.now() - 41_000 }],
    },
    'planSessions.list': {
      data: opts?.liveSessions === false
        ? []
        : [
            {
              coordOwnerId: OWNER_A,
              sessionId: 's-1',
              agent: 'claude',
              role: 'su',
              label: 'lane A',
              startedAt: new Date(Date.now() - 3_600_000).toISOString(),
              endedAt: null,
              live: true,
              via: 'plan',
            },
            {
              coordOwnerId: OWNER_B,
              sessionId: 's-2',
              agent: 'codex',
              role: 'su',
              label: null,
              startedAt: new Date(Date.now() - 7_200_000).toISOString(),
              endedAt: null,
              live: true,
              via: 'claim',
            },
            {
              coordOwnerId: 'su-dead0000-0000-0000-0000-000000000000',
              sessionId: 's-3',
              agent: 'claude',
              role: 'su',
              label: null,
              startedAt: new Date(Date.now() - 9_000_000).toISOString(),
              endedAt: new Date(Date.now() - 8_000_000).toISOString(),
              live: false, // ended — must NOT render a card
              via: 'plan',
            },
          ],
    },
    'advRoster.list': {
      data: [
        {
          active: [
            {
              ownerId: OWNER_A,
              intent: 'Recording D-001 — reuse route-tier auth',
              sessionState: 'live',
              lastActiveAt: new Date(Date.now() - 41_000).toISOString(),
              agent: 'claude',
            },
            {
              ownerId: OWNER_B,
              intent: 'Holds WI-40971 open',
              sessionState: 'parked',
              lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(),
              agent: 'codex',
            },
          ],
        },
      ],
    },
    'planActivity.list': {
      data: opts?.activity === false
        ? []
        : [
            {
              kind: 'work',
              tsMs: Date.now() - 41_000,
              text: 'WI-40729 wip — serializer verified',
              who: OWNER_A,
              ref: 'WI-40729',
            },
            {
              kind: 'edit',
              tsMs: Date.now() - 120_000,
              text: 'Plan edited (rev 12)',
              who: OWNER_A,
              ref: 'rev:12',
            },
          ],
    },
  };
}

function renderDash(onBack = vi.fn()) {
  const utils = render(
    <PlanDashboard planSlug="p1" harnessSlug="papercusp" onBack={onBack} />,
  );
  return { onBack, ...utils };
}

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const setter of Object.values(setters)) setter.mockClear();
  launchAgentSpy.mockClear();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
  cleanupFlag.value = true;
  vi.unstubAllGlobals();
});

describe('PlanDashboard header', () => {
  it('renders title, bucket, ✎/⚒ meta, progress and the needs-you line', () => {
    seed({ needsYou: true });
    renderDash();
    expect(screen.getByText('Security posture closure')).toBeTruthy();
    // startStatus 'started' + active ⇒ bucketOf = running, rendered as "plan".
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByTestId('plan-dash-edit-t').textContent).toContain('edited 2m');
    // ⚒ worked 41s ago ⇒ "now" bucket, hot (< 1h).
    const workT = screen.getByTestId('plan-dash-work-t');
    expect(workT.textContent).toContain('worked now');
    expect(workT.className).toContain('plan-dash__t--hot');
    expect(screen.getByTestId('plan-dash-progress').textContent).toBe('3 of 9 items done');
    // Exactly ONE decision-tier item on THIS plan counts.
    expect(screen.getByTestId('plan-dash-needs').textContent).toBe('1 decision needs you');
  });

  it('renders the dim never-worked ⚒ and omits needs-you when zero', () => {
    seed({ worked: false, needsYou: false });
    renderDash();
    const workT = screen.getByTestId('plan-dash-work-t');
    expect(workT.textContent).toContain('worked —');
    expect(workT.className).toContain('plan-dash__t--dim');
    expect(screen.queryByTestId('plan-dash-needs')).toBeNull();
  });

  it('back clears ?pdsess and calls onBack', () => {
    seed();
    nuqs['pdsess'] = OWNER_A;
    const { onBack } = renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-back'));
    expect(setters['pdsess']).toHaveBeenCalledWith(null);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Open full plan writes the scoped ?wppop ref', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-open-full'));
    expect(setters['wppop']).toHaveBeenCalledWith('papercusp::p1');
  });

  it('Search transcripts opens the popup onto its Sessions tab', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-search-transcripts'));
    expect(setters['ppv']).toHaveBeenCalledWith('sessions');
    expect(setters['wppop']).toHaveBeenCalledWith('papercusp::p1');
  });

  it('starts a one-plan clean-up from the header and deep-links its run', async () => {
    seed();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === '/api/agent-config'
        ? {
            ok: true,
            json: async () => ({
              config: {
                resolverProfiles: {
                  'plan-cleanup': {
                    model: null,
                    effort: null,
                    account: 'default',
                    carry: 'warm',
                  },
                },
              },
            }),
          }
        : {
            ok: true,
            json: async () => ({
              ok: true,
              runId: 'cleanup-dash-1',
              launched: true,
              resolverNeeded: true,
            }),
          },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderDash();

    const start = screen.getByTestId('plan-dash-cleanup') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    await waitFor(() => expect(setters.opcln).toHaveBeenCalledWith('cleanup-dash-1'));
    const startCall = fetchMock.mock.calls.find(([url]) => url === '/api/admin/plan-cleanup')!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      op: 'start',
      planSlugs: ['p1'],
      filter: {
        scope: 'single-plan',
        entryPoint: 'plan-dashboard',
        shownCount: 1,
        planSlug: 'p1',
        harness: 'papercusp',
      },
      harness: 'papercusp',
      launch: { model: null, effort: null, account: 'default', carry: 'warm' },
    });
  });

  it('hides the header clean-up action when the plan-cleanup flag is off', () => {
    cleanupFlag.value = false;
    seed();
    renderDash();
    expect(screen.queryByTestId('plan-dash-cleanup')).toBeNull();
  });

  it('Launch agent fires the plan-bound launch', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-launch'));
    expect(launchAgentSpy).toHaveBeenCalledWith({
      slug: 'papercusp',
      planSlug: 'p1',
      label: 'plan · p1',
    });
  });
});

describe('PlanDashboard working-now cards', () => {
  it('renders one card per LIVE session, roster-enriched', () => {
    seed();
    renderDash();
    const grid = screen.getByTestId('plan-dash-sessions');
    expect(grid.querySelectorAll('.plan-dash__scard').length).toBe(2);
    // Ended session renders no card.
    expect(screen.queryByTestId('plan-dash-session-su-dead0000-0000-0000-0000-000000000000')).toBeNull();
    const a = screen.getByTestId(`plan-dash-session-${OWNER_A}`);
    expect(a.textContent).toContain('su-76a83');
    expect(a.textContent).toContain('claude');
    expect(a.textContent).toContain('live');
    expect(a.textContent).toContain('Recording D-001');
    expect(a.textContent).toContain('last active just now'); // 41s → "now" → agoPhrase
    const b = screen.getByTestId(`plan-dash-session-${OWNER_B}`);
    expect(b.textContent).toContain('parked');
    expect(b.textContent).toContain('idle 1h');
  });

  it('Open session writes ?pdsess and the chat modal mounts on it', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId(`plan-dash-open-session-${OWNER_A}`));
    expect(setters['pdsess']).toHaveBeenCalledWith(OWNER_A);
    // The modal renders from the (seeded) param.
    cleanup();
    nuqs['pdsess'] = OWNER_A;
    seed();
    renderDash();
    expect(screen.getByTestId('session-chat-open').textContent).toBe(OWNER_A);
  });

  it('renders the empty state when no live sessions', () => {
    seed({ liveSessions: false });
    renderDash();
    expect(screen.getByTestId('plan-dash-no-sessions')).toBeTruthy();
  });
});

describe('PlanDashboard activity feed', () => {
  it('renders work + edit rows; only the work row deep-links to ?wpop', () => {
    seed();
    renderDash();
    const feed = screen.getByTestId('plan-dash-feed');
    expect(feed.querySelectorAll('.plan-dash__fitem').length).toBe(2);
    const workRow = screen.getByTestId('plan-dash-feed-ref-WI-40729');
    expect(workRow.tagName).toBe('BUTTON');
    fireEvent.click(workRow);
    expect(setters['wpop']).toHaveBeenCalledWith('papercusp::WI-40729');
    // The edit row is not a button (rev refs have no popup target).
    expect(screen.getByText('Plan edited (rev 12)').closest('button')).toBeNull();
  });

  it('renders the empty state when no activity', () => {
    seed({ activity: false });
    renderDash();
    expect(screen.getByTestId('plan-dash-no-activity')).toBeTruthy();
  });
});

describe('PlanDashboard helpers', () => {
  it('shortOwnerId trims to the roster convention', () => {
    expect(shortOwnerId(OWNER_A)).toBe('su-76a83');
    expect(shortOwnerId('weird')).toBe('weird');
  });

  it('avatarColor is deterministic', () => {
    expect(avatarColor(OWNER_A)).toBe(avatarColor(OWNER_A));
  });
});
