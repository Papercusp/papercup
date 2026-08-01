// @vitest-environment jsdom
/**
 * WI-6560 — render-stability pins for the HUD session board.
 *
 * WHY THIS FILE EXISTS. `MemoSessionCard` (HudBoard.tsx) and `MemoEntityCard`
 * (HudEntityColumns.tsx) both carry docblocks asserting that their error
 * boundary sits INSIDE the `memo` "so an unchanged row re-renders neither
 * (WI-6560 — HUD list commits are already the expensive ones)". That saving is
 * real, but it is defeated silently by anything that hands the memo a fresh
 * prop identity every parent render — and that is exactly what HudView did:
 *
 *     onOpenSession={(ownerId) => void setOpenOwner(ownerId)}
 *
 * A new arrow per render, flowing to `onOpen` on EVERY session card, so
 * `memo`'s shallow compare missed on all of them and the entire session column
 * re-rendered on every HudView render. The entity board got it right
 * (`onOpenItemCard` / `onOpenPlanCard` are useCallback'd), which is why the
 * defect was one-sided and easy to miss on review.
 *
 * Nothing tested the claim those docblocks make, so the optimisation was inert
 * for as long as it took someone to measure it. These tests assert the claim
 * itself — that an unchanged row does NOT re-render — and, critically, the
 * third test asserts the FAILURE direction, so this file cannot silently
 * degrade into a vacuous pass if the memo is later removed.
 *
 * The render counter is the `RowBoundary` mock: it is the outermost thing
 * `MemoSessionCard` renders, so one call == one card render.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import HudBoard from './HudBoard';
import { buildHudBoard, type HudRosterEntry } from './hud-board-model';

const counters = vi.hoisted(() => ({ rowRenders: 0 }));

vi.mock('@/app/_components/RenderBoundary', () => ({
  RowBoundary: ({ children }: { children: React.ReactNode }) => {
    counters.rowRenders += 1;
    return <>{children}</>;
  },
  SectionBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/harness/Popover', () => ({
  Popover: ({
    open,
    anchor,
    children,
  }: {
    open: boolean;
    anchor: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {anchor}
      {open ? <div data-testid="popover-panel">{children}</div> : null}
    </div>
  ),
}));

beforeEach(() => {
  counters.rowRenders = 0;
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});
afterEach(cleanup);

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-aaaaaaaa-1111-2222-3333-444444444444',
    label: 'su · su-aaaaa',
    source: 'omp-hook-session',
    intent: 'greening the release gate',
    currentFiles: [],
    liveness: 'live',
    stale: false,
    lastActiveAt: iso(5_000),
    intentDeclaredAt: iso(60_000),
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    harnessSlug: null,
    agentPaneKind: 'su',
    role: 'su',
    agent: 'claude',
    advSessionId: 1,
    windowId: null,
    wakeMode: 'auto',
    pendingWakes: 0,
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  };
}

/** Three distinct sessions, so a per-row miss shows up as a multiple. */
const ROSTER: HudRosterEntry[] = [
  entry({ ownerId: 'su-1111', label: 'su · one', advSessionId: 1 }),
  entry({ ownerId: 'su-2222', label: 'su · two', advSessionId: 2 }),
  entry({ ownerId: 'su-3333', label: 'su · three', advSessionId: 3 }),
];

function boardProps(
  over: Partial<React.ComponentProps<typeof HudBoard>> = {},
): React.ComponentProps<typeof HudBoard> {
  return {
    board: buildHudBoard(ROSTER, [], { nowMs: NOW }),
    selectedFleets: [],
    onToggleFleet: vi.fn(),
    selectedPlans: [],
    onSelectPlan: vi.fn(),
    focusColumn: null,
    onFocusColumn: vi.fn(),
    suOnly: true,
    onToggleSuOnly: vi.fn(),
    onOpenSession: vi.fn(),
    loading: false,
    error: null,
    tab: 'sessions',
    onSelectTab: vi.fn(),
    headerAction: <span data-testid="launcher" />,
    ...over,
  };
}

describe('WI-6560 — session card render stability', () => {
  it('renders one boundary per session card (the counter is wired to something real)', () => {
    // Guard against a vacuous suite: if the mock never fires, every "did not
    // re-render" assertion below would pass against zero renders.
    render(<HudBoard {...boardProps()} />);
    expect(counters.rowRenders).toBe(ROSTER.length);
  });

  it('does NOT re-render any session card when the parent re-renders with unchanged props', () => {
    const props = boardProps();
    const { rerender } = render(<HudBoard {...props} />);
    const afterFirst = counters.rowRenders;
    expect(afterFirst).toBe(ROSTER.length);

    // The same board object and the same callback identity — i.e. a HudView
    // re-render driven by state the session board does not depend on (the chat
    // modal opening, work-item/plan data arriving, entity-search typing).
    rerender(<HudBoard {...props} />);

    expect(counters.rowRenders).toBe(afterFirst);
  });

  it('DOES re-render every session card when onOpenSession identity changes (the regression this pins)', () => {
    // The failure direction. Before the fix HudView passed a fresh arrow on
    // every render, so this is what production actually did — every card, every
    // time. Note this test drives HudBoard directly, so it is INSENSITIVE to
    // HudView re-inlining the arrow; the structural guards at the bottom of
    // this file are what catch that. Verified by mutation: re-inlining the
    // arrow in HudView fails those two and leaves these three green, which is
    // what localises the fault to the call site rather than the memo.
    const props = boardProps();
    const { rerender } = render(<HudBoard {...props} />);
    const afterFirst = counters.rowRenders;

    rerender(<HudBoard {...props} onOpenSession={() => {}} />);

    expect(counters.rowRenders).toBe(afterFirst + ROSTER.length);
  });
});

/**
 * The tests above prove the MECHANISM (an unchanged row skips its render, a
 * changed `onOpen` identity does not) by driving HudBoard directly. They cannot
 * catch the actual regression, which lived one level up in HudView's call site
 * — reverting HudView would leave all three of them green.
 *
 * HudView has no render harness: it pulls in useSyncQuery, useInboxAttention,
 * usePlanList, useResolvedHarnessSlug, nine nuqs params and four modal
 * components, so standing one up is its own piece of work. Until it exists,
 * this structural guard holds the call site. Source-level guards are an
 * established pattern in this repo (lint:no-retired, lint:no-raw-setinterval,
 * lint:no-unenrolled-spawn) for exactly this shape of invariant: cheap to
 * enforce, expensive to prove any other way.
 */
describe('WI-6560 — HudView hands the board a stable onOpenSession', () => {
  /* Resolved from cwd, not `import.meta.url`: under this app's Vite-based
     vitest config import.meta.url is not a file: URL, so readFileSync on it
     throws ERR_INVALID_URL_SCHEME at collection time. Both candidates are
     listed because the file router may run from the app dir or the repo root,
     and a wrong guess must fail LOUDLY rather than silently skip the guard. */
  const RELATIVE = 'app/adv/hud/HudView.tsx';
  const candidates = [
    resolve(process.cwd(), RELATIVE),
    resolve(process.cwd(), 'apps/operator', RELATIVE),
  ];
  const hudViewPath = candidates.find((p) => existsSync(p));
  if (!hudViewPath) {
    throw new Error(
      `hud-render-stability: could not locate HudView.tsx (cwd=${process.cwd()}, tried ${candidates.join(', ')})`,
    );
  }
  const src = readFileSync(hudViewPath, 'utf8');

  it('passes an identifier, never an inline arrow', () => {
    const match = src.match(/onOpenSession=\{([^}]*)\}/);
    expect(match, 'HudView no longer passes onOpenSession to HudBoard').not.toBeNull();

    const expr = match![1].trim();
    // An inline arrow is a fresh identity per render, so `memo` on every
    // session card misses and the whole column re-renders. That is the bug.
    expect(expr, 'onOpenSession must not be an inline arrow').not.toMatch(/=>/);
    expect(expr, 'onOpenSession must be a plain identifier reference').toMatch(
      /^[A-Za-z_$][\w$]*$/,
    );
  });

  it('defines that identifier with useCallback', () => {
    const expr = src.match(/onOpenSession=\{([^}]*)\}/)![1].trim();
    // A plain identifier is not enough: a function declared in the component
    // body without useCallback is also a fresh identity every render.
    expect(src).toMatch(new RegExp(`const\\s+${expr}\\s*=\\s*useCallback`));
  });
});
