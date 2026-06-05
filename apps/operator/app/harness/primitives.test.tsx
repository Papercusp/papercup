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
  IdPill,
  RolePill,
  SEVERITY_ICON,
  ISSUE_STATUS_ICON,
} from './primitives';
import { getRoleStyle, SEVERITY, ISSUE_STATUS, STATUS } from './theme';

afterEach(() => cleanup());

describe('SEVERITY_ICON / ISSUE_STATUS_ICON maps', () => {
  it('cover exactly the canonical severity keys', () => {
    expect(Object.keys(SEVERITY_ICON).sort()).toEqual(
      ['critical', 'major', 'minor', 'nit'].sort(),
    );
  });

  it('cover exactly the canonical issue-status keys', () => {
    expect(Object.keys(ISSUE_STATUS_ICON).sort()).toEqual(
      ['acknowledged', 'closed', 'fixing', 'open', 'wontfix'].sort(),
    );
  });

  it('every map entry is a renderable lucide component', () => {
    // lucide icons are forwardRef components (typeof 'object'), so assert by
    // rendering each entry produces a real <svg> rather than checking typeof.
    for (const Icon of [...Object.values(SEVERITY_ICON), ...Object.values(ISSUE_STATUS_ICON)]) {
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
    expect(screen.getAllByText(SEVERITY.this_key_is_unknown.label).length).toBeGreaterThan(0);
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
    expect(screen.getByText(ISSUE_STATUS.nonexistent_status.label)).toBeTruthy();
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
