// @vitest-environment jsdom
/**
 * FleetPeersRail (chat-popup-fleet-peers-rail-2026-08-09 P-002).
 *
 * What these tests are actually defending:
 *  1. The CLICK CONTRACT. The owner's ask #3 is that clicking a peer swings the
 *     popup to that peer, so the callback firing with the right ownerId is the
 *     feature — not an implementation detail. A rail that renders beautifully
 *     and calls back with the wrong id sends the reader to another agent.
 *  2. The two rows that must NOT be clickable, for opposite reasons: the agent
 *     you are already viewing (a no-op that reads as broken), and every row when
 *     the host passed no handler (an affordance that lies). Both are asserted on
 *     the TAG, because "looks like a button" is the whole failure.
 *  3. That a broken fleet SAYS SO — a missing leader is a real fault (nobody
 *     reclaims a stalled claim), and rendering no Leader section would read as
 *     "not applicable" rather than "broken".
 *
 * The model is built by hand rather than through `deriveFleetPeers`, so a
 * derivation bug cannot make a rendering test pass; the derivation has its own
 * suite in fleet-peers.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FleetPeersRail from './FleetPeersRail';
import type { FleetPeer, FleetPeersModel } from './fleet-peers';
import type { LeaderBriefAlertsModel, MemberAlert } from './leader-brief-alerts';

afterEach(cleanup);

function peer(over: Partial<FleetPeer> = {}): FleetPeer {
  return {
    ownerId: 'su-e8a25005-9a96-4d09-baf7-89fc7c103965',
    handle: 'su-e8a25005',
    label: 'su · su-e8a25',
    intent: 'draining the non-p2p bug backlog',
    column: 'working',
    reason: 'draining the non-p2p bug backlog',
    sinceSec: 40,
    isLeader: false,
    contextPct: 41,
    agent: 'claude',
    agentPaneKind: 'su',
    isCurrent: false,
    ...over,
  };
}

function model(over: Partial<FleetPeersModel> = {}): FleetPeersModel {
  return {
    fleetSlug: 'nonp2p-bug-drain',
    fleetColor: '#c4b5fd',
    leader: peer({ ownerId: 'su-b8422496', handle: 'su-b8422496', isLeader: true }),
    members: [peer()],
    total: 2,
    warning: null,
    ...over,
  };
}

const noop = () => {};

describe('FleetPeersRail — the click contract (owner ask #3)', () => {
  it('calls back with the peer’s ownerId when a row is pressed', () => {
    const onSelectPeer = vi.fn();
    render(
      <FleetPeersRail
        model={model({ members: [peer({ ownerId: 'su-d9a64165', handle: 'su-d9a64165' })] })}
        onSelectPeer={onSelectPeer}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Open su-d9a64165's conversation/ }));
    expect(onSelectPeer).toHaveBeenCalledTimes(1);
    expect(onSelectPeer).toHaveBeenCalledWith('su-d9a64165');
  });

  it('lets you jump to the LEADER, not only to members', () => {
    const onSelectPeer = vi.fn();
    render(<FleetPeersRail model={model()} onSelectPeer={onSelectPeer} onClose={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /Open su-b8422496's conversation/ }));
    expect(onSelectPeer).toHaveBeenCalledWith('su-b8422496');
  });

  it('renders the agent you are ALREADY viewing as a non-button, marked current', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ members: [peer({ isCurrent: true })], leader: null })}
        onSelectPeer={vi.fn()}
        onClose={noop}
      />,
    );
    const current = container.querySelector('[data-current="true"]')!;
    expect(current).not.toBeNull();
    // The point of the test: not merely styled differently — not a button at all.
    expect(current.tagName).toBe('LI');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('viewing')).toBeTruthy();
  });

  it('renders READ-ONLY rows when the host cannot re-target the popup', () => {
    // No onSelectPeer. Every row must be inert AND look it — an affordance that
    // does nothing is worse than no affordance.
    render(<FleetPeersRail model={model()} onClose={noop} />);
    expect(screen.queryAllByRole('button', { name: /conversation/ })).toHaveLength(0);
    // …but the rail still renders its peers; degraded, not empty.
    expect(screen.getAllByTestId('fleet-peer-row')).toHaveLength(2);
  });
});

describe('FleetPeersRail — what it reports', () => {
  it('names the fleet and its headcount', () => {
    render(<FleetPeersRail model={model()} onClose={noop} />);
    expect(screen.getByText('nonp2p-bug-drain')).toBeTruthy();
    expect(screen.getByText('2 agents')).toBeTruthy();
  });

  it('says "1 agent", not "1 agents", for a fleet of one', () => {
    render(<FleetPeersRail model={model({ leader: null, members: [peer()], total: 1 })} onClose={noop} />);
    expect(screen.getByText('1 agent')).toBeTruthy();
  });

  it('shows the health note only when something needs a human', () => {
    const { queryByTestId } = render(<FleetPeersRail model={model()} onClose={noop} />);
    // An all-clear fleet stays quiet — the ABSENCE of this bar is information.
    expect(queryByTestId('fleet-peers-warning')).toBeNull();

    cleanup();
    render(<FleetPeersRail model={model({ warning: '2 stalled, 1 needs you' })} onClose={noop} />);
    expect(screen.getByTestId('fleet-peers-warning').textContent).toContain('2 stalled');
  });

  it('says plainly that a fleet has no leader rather than hiding the section', () => {
    render(<FleetPeersRail model={model({ leader: null })} onClose={noop} />);
    expect(screen.getByTestId('fleet-peers-no-leader').textContent).toContain('No leader');
  });

  it('marks a cup peer as a cup', () => {
    render(
      <FleetPeersRail
        model={model({
          members: [peer({ ownerId: 's-1786238596028', handle: 's-1786238596028', agentPaneKind: 'cup' })],
        })}
        onClose={noop}
      />,
    );
    expect(screen.getByText('cup')).toBeTruthy();
  });

  it('shows a context percentage, and shows NOTHING when it was never sampled', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ leader: null, members: [peer({ contextPct: null })] })}
        onClose={noop}
      />,
    );
    // Not "0%" — an unmeasured context rendered as 0 reads as "plenty of room".
    expect(container.textContent).not.toContain('0%');
  });

  it('carries the state word AND the dot, so colour is never the only signal', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ leader: null, members: [peer({ column: 'stalled', sinceSec: 47 * 60 })] })}
        onClose={noop}
      />,
    );
    expect(container.textContent).toContain('stalled');
    expect(container.querySelector('.pc-peer__dot[data-col="stalled"]')).not.toBeNull();
  });

  it('closes on the zone title’s ✕', () => {
    const onClose = vi.fn();
    render(<FleetPeersRail model={model()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide fleet peers' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * The leader-brief overlay (popup-agent-state-coverage-2026-08-18 P-003/P-004).
 *
 * Two structural properties are what these defend, and neither is cosmetic:
 *  1. NO NEW ROWS. D-003's fixed-height constraint was paid for after one
 *     agent's 32 locks made this rail ~2,000px tall. An overlay that adds rows
 *     spends it again, so the row count is asserted directly.
 *  2. The alert sentences REACH a keyboard/touch user. Each glyph carries a
 *     native `title`, which is unreachable by both — so the same sentences must
 *     also be in the row's Tooltip label and its aria-label, or the whole
 *     overlay is sighted-mouse-only.
 */
describe('FleetPeersRail — the leader-brief overlay', () => {
  const alertsFor = (ownerId: string, ...alerts: MemberAlert[]): LeaderBriefAlertsModel => ({
    byMember: { [ownerId]: alerts },
    fleet: null,
    briefed: true,
  });

  const dormant: MemberAlert = {
    key: 'dormant',
    glyph: 'D',
    severity: 'bad',
    title: 'Dormant — no self-wake at all.',
  };
  const deaf: MemberAlert = {
    key: 'coord-deaf',
    glyph: '✉',
    severity: 'warn',
    title: 'Coord-deaf — a coord:send will not be seen.',
  };

  it('renders a glyph per alert ON the existing row, adding no rows', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ leader: null, members: [peer({ ownerId: 'su-x', handle: 'su-x' })] })}
        alerts={alertsFor('su-x', dormant, deaf)}
        onClose={noop}
      />,
    );
    expect(container.querySelectorAll('[data-testid="fleet-peer-row"]')).toHaveLength(1);
    const glyphs = container.querySelectorAll('.pc-peer__alert');
    expect([...glyphs].map((g) => g.textContent)).toEqual(['D', '✉']);
    expect(glyphs[0].getAttribute('data-sev')).toBe('bad');
    expect(glyphs[1].getAttribute('data-sev')).toBe('warn');
  });

  it('puts the alert sentences on the row’s aria-label, not only in a hover title', () => {
    render(
      <FleetPeersRail
        model={model({ leader: null, members: [peer({ ownerId: 'su-x', handle: 'su-x' })] })}
        alerts={alertsFor('su-x', dormant)}
        onSelectPeer={vi.fn()}
        onClose={noop}
      />,
    );
    const row = screen.getByTestId('fleet-peer-row');
    // The board's own reason survives — the overlay is additive. Both halves
    // are needed: the column says how the row scored, the alert says what that
    // score cannot see.
    expect(row.getAttribute('aria-label')).toContain('draining the non-p2p bug backlog');
    expect(row.getAttribute('aria-label')).toContain('no self-wake');
  });

  it('reaches a NON-clickable row too (the current agent, or no handler)', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ leader: null, members: [peer({ ownerId: 'su-x', isCurrent: true })] })}
        alerts={alertsFor('su-x', dormant)}
        onSelectPeer={vi.fn()}
        onClose={noop}
      />,
    );
    const row = container.querySelector('[data-testid="fleet-peer-row"]')!;
    expect(row.tagName).toBe('LI');
    expect(row.getAttribute('title')).toContain('no self-wake');
  });

  it('applies alerts to the LEADER row as well as members', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({ leader: peer({ ownerId: 'su-lead', handle: 'su-lead', isLeader: true }) })}
        alerts={alertsFor('su-lead', dormant)}
        onClose={noop}
      />,
    );
    expect(container.querySelectorAll('.pc-peer__alert')).toHaveLength(1);
  });

  it('renders nothing extra when there is no overlay at all', () => {
    const { container } = render(<FleetPeersRail model={model()} onClose={noop} />);
    expect(container.querySelector('.pc-peer__alert')).toBeNull();
    expect(container.querySelector('[data-testid="fleet-alert-block"]')).toBeNull();
  });

  it('leaves an un-alerted peer unmarked while its neighbour is flagged', () => {
    const { container } = render(
      <FleetPeersRail
        model={model({
          leader: null,
          members: [peer({ ownerId: 'su-a', handle: 'su-a' }), peer({ ownerId: 'su-b', handle: 'su-b' })],
        })}
        alerts={alertsFor('su-a', dormant)}
        onClose={noop}
      />,
    );
    const rows = [...container.querySelectorAll('[data-testid="fleet-peer-row"]')];
    expect(rows[0].querySelectorAll('.pc-peer__alert')).toHaveLength(1);
    expect(rows[1].querySelectorAll('.pc-peer__alert')).toHaveLength(0);
  });
});

describe('FleetPeersRail — the fleet-level alert block (P-004)', () => {
  const withFleet = (fleet: LeaderBriefAlertsModel['fleet']): LeaderBriefAlertsModel => ({
    byMember: {},
    fleet,
    briefed: true,
  });

  it('renders each alert with its reason available on hover', () => {
    render(
      <FleetPeersRail
        model={model()}
        alerts={withFleet({
          fleetSlug: 'p2p-release',
          alerts: [
            { key: 'spec-starved', severity: 'bad', text: 'spec starved', detail: '0 rows match, pool has 14' },
            { key: 'paused', severity: 'warn', text: 'fleet paused', detail: null },
          ],
          capacity: 'degraded · q 7',
          invariantsNote: '4 invariants · all satisfied',
        })}
        onClose={noop}
      />,
    );
    const block = screen.getByTestId('fleet-alert-block');
    expect(block.textContent).toContain('spec starved');
    expect(block.querySelector('[data-alert="spec-starved"]')!.getAttribute('title')).toBe(
      '0 rows match, pool has 14',
    );
    // A detail-less alert must not render an empty tooltip that reads as "no
    // reason exists" — it simply carries none.
    expect(block.querySelector('[data-alert="paused"]')!.getAttribute('title')).toBeNull();
    expect(screen.getByTestId('fleet-alert-capacity').textContent).toContain('degraded · q 7');
    expect(screen.getByTestId('fleet-alert-invariants-ok').textContent).toContain('all satisfied');
  });

  it('renders NO block on a clean fleet, so its absence is the all-clear (D-003)', () => {
    render(
      <FleetPeersRail model={model()} alerts={{ byMember: {}, fleet: null, briefed: true }} onClose={noop} />,
    );
    expect(screen.queryByTestId('fleet-alert-block')).toBeNull();
  });

  it('sits ABOVE the roster — several alerts are why the rows below look calm', () => {
    const { container } = render(
      <FleetPeersRail
        model={model()}
        alerts={withFleet({
          fleetSlug: 'f',
          alerts: [{ key: 'paused', severity: 'warn', text: 'fleet paused', detail: null }],
          capacity: null,
          invariantsNote: null,
        })}
        onClose={noop}
      />,
    );
    const block = container.querySelector('[data-testid="fleet-alert-block"]')!;
    const list = container.querySelector('.pc-peers__list')!;
    expect(block.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the capacity and invariant rows rather than rendering empty ones', () => {
    render(
      <FleetPeersRail
        model={model()}
        alerts={withFleet({
          fleetSlug: 'f',
          alerts: [{ key: 'paused', severity: 'warn', text: 'fleet paused', detail: null }],
          capacity: null,
          invariantsNote: null,
        })}
        onClose={noop}
      />,
    );
    expect(screen.queryByTestId('fleet-alert-capacity')).toBeNull();
    expect(screen.queryByTestId('fleet-alert-invariants-ok')).toBeNull();
  });
});
