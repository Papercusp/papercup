/**
 * @vitest-environment jsdom
 *
 * TwoPaneShell — the shared flush 2-pane frame (plan: unified-2-pane-shell).
 * Verifies both slots render their content, the per-view className appends, and
 * the frame is keyed stably (data-testid) so a parent can prove it is reused
 * across view switches rather than remounted.
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import TwoPaneShell from './TwoPaneShell';

afterEach(() => cleanup());

describe('TwoPaneShell', () => {
  it('renders the list and detail nodes in their respective slots', () => {
    const { container } = render(
      <TwoPaneShell list={<div>LIST_CONTENT</div>} detail={<div>DETAIL_CONTENT</div>} />,
    );
    expect(container.querySelector('.pc-twopane__list')?.textContent).toBe('LIST_CONTENT');
    expect(container.querySelector('.pc-twopane__detail')?.textContent).toBe('DETAIL_CONTENT');
  });

  it('appends a per-view className to the frame', () => {
    const { container } = render(
      <TwoPaneShell className="pc-twopane--sessions" list={null} detail={null} />,
    );
    const frame = container.querySelector('.pc-twopane');
    expect(frame?.classList.contains('pc-twopane--sessions')).toBe(true);
  });

  it('keeps a stable frame node when only the slot content changes (swap, not remount)', () => {
    const { container, rerender } = render(
      <TwoPaneShell list={<div>LIST_A</div>} detail={<div>DETAIL_A</div>} />,
    );
    const frameBefore = container.querySelector('[data-testid="pc-twopane"]');
    rerender(<TwoPaneShell list={<div>LIST_B</div>} detail={<div>DETAIL_B</div>} />);
    const frameAfter = container.querySelector('[data-testid="pc-twopane"]');
    // Same DOM node instance — the frame was reused, only the content swapped.
    expect(frameAfter).toBe(frameBefore);
    expect(container.querySelector('.pc-twopane__list')?.textContent).toBe('LIST_B');
  });

  // The behaviour PlansClient relies on: switching `?view=` between
  // plans → inbox → sessions is a CONTENT swap, not a frame remount. We model
  // PlansClient's structure (the element at the shell's position is ALWAYS
  // <TwoPaneShell>; only its list/detail/className props change per view) and
  // assert that a mount-counter sentinel placed in the frame fires exactly once
  // across all three "views" — i.e. React never tore the frame down.
  it('does not remount the frame across a 3-view flip (mount-counter sentinel)', () => {
    let mountCount = 0;
    function MountSentinel() {
      useEffect(() => {
        mountCount += 1;
      }, []);
      return <span data-testid="papercup" />;
    }
    function Harness({ view }: { view: 'plans' | 'queue' | 'sessions' }) {
      return (
        <TwoPaneShell
          className={view === 'sessions' ? 'pc-twopane--sessions' : undefined}
          list={<div>{`LIST_${view}`}</div>}
          detail={<MountSentinel />}
        />
      );
    }
    const { container, rerender } = render(<Harness view="plans" />);
    const frameBefore = container.querySelector('[data-testid="pc-twopane"]');
    rerender(<Harness view="queue" />);
    rerender(<Harness view="sessions" />);
    const frameAfter = container.querySelector('[data-testid="pc-twopane"]');

    // Frame DOM node reused across all three views…
    expect(frameAfter).toBe(frameBefore);
    // …the sentinel inside the frame mounted ONCE (no remount on view change)…
    expect(mountCount).toBe(1);
    // …yet the list content and per-view className reflect the latest view.
    expect(container.querySelector('.pc-twopane__list')?.textContent).toBe('LIST_sessions');
    expect(frameAfter?.classList.contains('pc-twopane--sessions')).toBe(true);
  });
});
