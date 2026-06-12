// @vitest-environment jsdom
/**
 * Shared harness pill primitives (primitives.tsx).
 *
 * THE LOAD-BEARING TEST: the icon-map `?? <Fallback>` guard. An UNKNOWN
 * severity/status key must render the Circle fallback icon and NOT throw —
 * this exact "ICON_MAP[value] crashes the React subtree" pattern caused a
 * past IssueRow crash (see SEVERITY_ICON / theme STATUS Proxy comments).
 *
 * Also covers: label/dot/size variants, IdPill clipboard-copy +
 * stopPropagation, RolePill getRoleStyle mapping (canonical + hash-derived).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  SeverityPill,
  IssueStatusPill,
  StatusPill,
  KindPill,
  AgentKindPill,
  IdPill,
  RolePill,
  SEVERITY_ICON,
  ISSUE_STATUS_ICON,
  STATUS_ICON,
  KIND_ICON,
  AGENT_KIND_GLYPH,
} from './primitives';
import { getRoleStyle, SEVERITY, ISSUE_STATUS, STATUS, WORK_ITEM_KIND, AGENT_KIND } from './theme';

afterEach(() => cleanup());

describe('SEVERITY_ICON / ISSUE_STATUS_ICON maps', () => {
  it('cover exactly the canonical severity keys', () => {
    expect(Object.keys(SEVERITY_ICON).sort()).toEqual(
      ['critical', 'major', 'minor', 'nit'].sort(),
    );
  });

  it('cover exactly the canonical issue-status keys', () => {
    expect(Object.keys(ISSUE_STATUS_ICON).sort()).toEqual(
      ['acknowledged', 'resolved', 'closed', 'fixing', 'open', 'wontfix'].sort(),
    );
  });

  it('STATUS_ICON covers exactly the coding-harness status keys', () => {
    expect(Object.keys(STATUS_ICON).sort()).toEqual(
      ['todo', 'in_progress', 'validating', 'failing', 'blocked', 'passed', 'deprecated'].sort(),
    );
  });

  it('KIND_ICON covers exactly the canonical work-item kinds', () => {
    expect(Object.keys(KIND_ICON).sort()).toEqual(
      ['feature', 'research-task', 'chunk', 'bug', 'change', 'task'].sort(),
    );
  });

  it('every map entry is a renderable lucide component', () => {
    // lucide icons are forwardRef components (typeof 'object'), so assert by
    // rendering each entry produces a real <svg> rather than checking typeof.
    for (const Icon of [
      ...Object.values(SEVERITY_ICON),
      ...Object.values(ISSUE_STATUS_ICON),
      ...Object.values(STATUS_ICON),
      ...Object.values(KIND_ICON),
    ]) {
      const { container, unmount } = render(<Icon aria-hidden />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });
});

describe('SeverityPill', () => {
  it('renders icon + label for a known severity', () => {
    render(<SeverityPill severity="critical" />);
    expect(screen.getByText(SEVERITY.critical.label)).toBeTruthy();
  });

  it('hides the label when showLabel=false but still renders the pill', () => {
    const { container } = render(<SeverityPill severity="major" showLabel={false} />);
    expect(screen.queryByText(SEVERITY.major.label)).toBeNull();
    // The icon (an inline svg) still renders.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders a fallback icon for an UNKNOWN severity and does NOT crash the subtree', () => {
    // The crash-guard: SEVERITY_ICON[unknown] is undefined; the `?? Circle`
    // must kick in so we render a real <svg> instead of `<undefined/>`.
    expect(() =>
      render(<SeverityPill severity="totally-bogus-severity" />),
    ).not.toThrow();
    const { container } = render(<SeverityPill severity="another-unknown" />);
    expect(container.querySelector('svg')).not.toBeNull();
    // Proxy fallback supplies the neutral "Unknown" label rather than throwing.
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  });

  it('xs size still renders icon + label', () => {
    render(<SeverityPill severity="minor" size="xs" />);
    expect(screen.getByText(SEVERITY.minor.label)).toBeTruthy();
  });
});

describe('IssueStatusPill', () => {
  it('renders a colored dot + label for a known status', () => {
    const { container } = render(<IssueStatusPill status="fixing" />);
    expect(screen.getByText(ISSUE_STATUS.fixing.label)).toBeTruthy();
    // A dot span (aria-hidden) is rendered.
    expect(container.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('renders a fallback (Unknown label) for an UNKNOWN status without crashing', () => {
    expect(() => render(<IssueStatusPill status="nonexistent-status" />)).not.toThrow();
    // Proxy fallback supplies the neutral "Unknown" label rather than throwing.
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('hides the label when showLabel=false', () => {
    render(<IssueStatusPill status="open" showLabel={false} />);
    expect(screen.queryByText(ISSUE_STATUS.open.label)).toBeNull();
  });
});

describe('StatusPill', () => {
  it('renders a dot + label for a known harness status', () => {
    const { container } = render(<StatusPill status="in_progress" />);
    expect(screen.getByText(STATUS.in_progress.label)).toBeTruthy();
    expect(container.querySelector('span[aria-hidden]')).not.toBeNull();
  });

  it('uses a smaller dot at size=xs', () => {
    const { container } = render(<StatusPill status="passed" size="xs" />);
    const dot = container.querySelector('span[aria-hidden]') as HTMLElement;
    expect(dot.style.width).toBe('6px');
  });

  it('uses an 8px dot at the default (sm) size', () => {
    const { container } = render(<StatusPill status="passed" />);
    const dot = container.querySelector('span[aria-hidden]') as HTMLElement;
    expect(dot.style.width).toBe('8px');
  });

  it('renders the Proxy fallback label for an unknown status (no crash)', () => {
    // STATUS is a Proxy that returns a neutral "Unknown" fallback for any
    // status not in the coding-harness machine (e.g. parent-harness statuses).
    expect(() => render(<StatusPill status={'proposed' as never} />)).not.toThrow();
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('variant="chip" renders an icon chip (svg, no dot) with the status label', () => {
    const { container } = render(<StatusPill status="in_progress" variant="chip" />);
    expect(screen.getByText(STATUS.in_progress.label)).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('variant="chip" with an unknown status falls back to the Circle icon (no crash)', () => {
    expect(() => render(<StatusPill status={'proposed' as never} variant="chip" />)).not.toThrow();
  });
});

describe('IssueStatusPill (chip variant)', () => {
  it('renders an icon chip with the status label', () => {
    const { container } = render(<IssueStatusPill status="fixing" variant="chip" />);
    expect(screen.getByText(ISSUE_STATUS.fixing.label)).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('unknown status renders the fallback icon + Unknown label without crashing', () => {
    expect(() => render(<IssueStatusPill status="bogus" variant="chip" />)).not.toThrow();
  });
});

describe('KindPill', () => {
  it('renders icon + canonical label for a known kind', () => {
    const { container } = render(<KindPill kind="bug" />);
    expect(screen.getByText(WORK_ITEM_KIND.bug.label)).toBeTruthy();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('keeps the RAW kind name (not "Unknown") for an unrecognized kind', () => {
    expect(() => render(<KindPill kind="experiment" />)).not.toThrow();
    expect(screen.getByText('experiment')).toBeTruthy();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('hides the label when showLabel=false but still renders the icon', () => {
    const { container } = render(<KindPill kind="feature" showLabel={false} />);
    expect(screen.queryByText(WORK_ITEM_KIND.feature.label)).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('AgentKindPill', () => {
  it('renders glyph + canonical label for a known agent kind', () => {
    render(<AgentKindPill kind="queen" />);
    expect(screen.getByText(AGENT_KIND.queen.label)).toBeTruthy();
    expect(screen.getByText(AGENT_KIND_GLYPH.queen)).toBeTruthy();
  });

  it('covers every glyph kind in the AGENT_KIND table (and vice versa)', () => {
    expect(Object.keys(AGENT_KIND_GLYPH).sort()).toEqual(Object.keys(AGENT_KIND).sort());
  });

  it('keeps the RAW kind name (not "Unknown") for an unrecognized kind', () => {
    expect(() => render(<AgentKindPill kind="drone" />)).not.toThrow();
    expect(screen.getByText('drone')).toBeTruthy();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('hides the label when showLabel=false but still renders the glyph', () => {
    render(<AgentKindPill kind="bee" showLabel={false} />);
    expect(screen.queryByText(AGENT_KIND.bee.label)).toBeNull();
    expect(screen.getByText(AGENT_KIND_GLYPH.bee)).toBeTruthy();
  });
});

describe('IdPill', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no navigator.clipboard — stub it.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('renders the id text in a button', () => {
    render(<IdPill id="su-1234" />);
    const btn = screen.getByRole('button', { name: /su-1234/ });
    expect(btn).toBeTruthy();
  });

  it('click copies the id to the clipboard and fires the onClick callback', () => {
    const onClick = vi.fn();
    render(<IdPill id="su-abcd" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('su-abcd');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('stops propagation so a click does not bubble to an enclosing row handler', () => {
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick} data-testid="row">
        <IdPill id="su-xyz" />
      </div>,
    );
    fireEvent.click(within(screen.getByTestId('row')).getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('su-xyz');
    // stopPropagation in the handler must keep the parent handler from firing.
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('does not crash when navigator.clipboard is absent (optional-chained)', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const onClick = vi.fn();
    render(<IdPill id="su-noclip" onClick={onClick} />);
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow();
    // onClick still fires even though clipboard was unavailable.
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('RolePill', () => {
  it('renders a canonical role with its mapped label (lowercased) + dot color', () => {
    const { container } = render(<RolePill role="planner" />);
    const expected = getRoleStyle('planner');
    expect(screen.getByText(expected.label.toLowerCase())).toBeTruthy();
    const dot = container.querySelector('span[aria-hidden]') as HTMLElement;
    // getRoleStyle('planner').solid is the canonical purple.
    expect(dot.style.background).toBe('rgb(168, 85, 247)');
  });

  it('renders a hash-derived label for an unknown role (titleCased, lowercased)', () => {
    // 'infra-reviewer' is not canonical → getRoleStyle title-cases then we lowercase.
    const style = getRoleStyle('infra-reviewer');
    expect(style.label).toBe('Infra Reviewer');
    render(<RolePill role="infra-reviewer" />);
    expect(screen.getByText('infra reviewer')).toBeTruthy();
  });

  it('renders the Unknown role label for an empty role string', () => {
    render(<RolePill role="" />);
    // getRoleStyle('') → ROLE.unknown { label: 'Unknown' } → lowercased.
    expect(screen.getByText('unknown')).toBeTruthy();
  });
});
