// @vitest-environment jsdom
//
// PlanSessionsTab (owner-plans-single-pane-2026-07-17 P-005/P-006/P-007): the
// per-plan session list renders live/claimed sessions and opens SessionChatModal
// on click; the search box hits the plan-SCOPED transcript route and its hits
// open the modal too. Data hooks + fetch + the modal + launchAgent are mocked.
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { nuqs, setters, sessionRows, openedOwner, launchAgent } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  sessionRows: { value: [] as unknown[] },
  openedOwner: { value: null as string | null },
  launchAgent: vi.fn(async (_o?: unknown) => ({ ok: true as const })),
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d, mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: sessionRows.value, loading: false, error: null, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({ launchAgent: (o: unknown) => launchAgent(o) }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
// Identity debounce so a search query takes effect synchronously.
vi.mock('@/app/harness/picker-kit', () => ({ useDebouncedValue: (v: unknown) => v }));
vi.mock('../chat/SessionChatModal', () => ({
  default: ({ sessionOwnerId }: { sessionOwnerId: string | null }) => {
    openedOwner.value = sessionOwnerId;
    return sessionOwnerId ? <div data-testid="chat-modal">{sessionOwnerId}</div> : null;
  },
}));

import PlanSessionsTab from './PlanSessionsTab';

function sess(over: Record<string, unknown>) {
  return {
    coordOwnerId: 'su-x', sessionId: 's1', ompThreadId: null, agent: 'claude', mode: 'console',
    role: null, label: null, startedAt: '2026-07-17T00:00:00Z', endedAt: null, live: true, via: 'plan',
    ...over,
  };
}

beforeEach(() => {
  openedOwner.value = null;
  sessionRows.value = [];
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('PlanSessionsTab', () => {
  it('renders plan sessions with a live flag and a claimed tag', () => {
    sessionRows.value = [
      sess({ coordOwnerId: 'su-live', label: 'Leader', live: true, via: 'plan' }),
      sess({ coordOwnerId: 'su-claim', label: 'Worker', live: false, endedAt: '2026-07-17T01:00:00Z', via: 'claim' }),
    ];
    render(<PlanSessionsTab planSlug="p1" harnessSlug="papercusp" />);
    expect(screen.getByText('Leader')).toBeTruthy();
    expect(screen.getByText('Worker')).toBeTruthy();
    expect(screen.getByText('claimed')).toBeTruthy();
  });

  it('opens SessionChatModal for the clicked session owner', () => {
    sessionRows.value = [sess({ coordOwnerId: 'su-abc', label: 'Agent A' })];
    render(<PlanSessionsTab planSlug="p1" harnessSlug="papercusp" />);
    fireEvent.click(screen.getByTestId('plan-sessions-row-su-abc'));
    expect(screen.getByTestId('chat-modal').textContent).toBe('su-abc');
  });

  it('launches an agent bound to the plan', () => {
    render(<PlanSessionsTab planSlug="p-launch" harnessSlug="papercusp" />);
    fireEvent.click(screen.getByTestId('plan-sessions-launch'));
    expect(launchAgent).toHaveBeenCalledWith(expect.objectContaining({ slug: 'papercusp', planSlug: 'p-launch' }));
  });

  it('searches the PLAN-SCOPED transcript route and opens a hit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          plan: 'p1',
          sessions: [
            { sourceKind: 'claude', sessionId: 's9', topScore: 1, hits: [{ turnIdx: 3, excerpt: 'hello', highlight: 'hel<mark>lo</mark>', score: 1 }], active: { ownerId: 'su-hit', label: 'Hit agent' }, session: null },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    nuqs.ppq = 'hello';
    render(<PlanSessionsTab planSlug="p1" harnessSlug="papercusp" />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // the request carried the plan scope
    expect(String(fetchSpy.mock.calls[0][0])).toContain('plan=p1');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('q=hello');
    const hit = await screen.findByTestId('plan-sessions-hit');
    fireEvent.click(hit);
    expect(screen.getByTestId('chat-modal').textContent).toBe('su-hit');
  });
});
